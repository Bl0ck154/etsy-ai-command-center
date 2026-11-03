import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const JOB_SCHEMA_VERSION = 1;
const JOB_RECORD_TYPE = 'background_job';
const JOB_LOCK_SCHEMA_VERSION = 1;
const JOB_FILE_PATTERN = /^job_[a-z0-9_]+\.json$/i;
const JOB_TEMP_FILE_PATTERN = /^(job_[a-z0-9_]+)\.json\.\d+\.[a-f0-9-]+\.tmp$/i;

function defaultJobsDirectory() {
  return process.env.JOBS_DIR || path.join(process.cwd(), 'data', 'jobs');
}

function validJobId(id) {
  const normalized = String(id || '');
  return /^job_[a-z0-9_]+$/i.test(normalized) ? normalized : '';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function envelope(job) {
  return {
    schema_version: JOB_SCHEMA_VERSION,
    record_type: JOB_RECORD_TYPE,
    job,
  };
}

function unwrap(parsed, expectedId) {
  const versionedJob = (
    parsed?.schema_version === JOB_SCHEMA_VERSION
    && parsed?.record_type === JOB_RECORD_TYPE
    && parsed?.job
    && typeof parsed.job === 'object'
  ) ? parsed.job : null;
  const legacyJob = parsed?.id ? parsed : null;
  const job = versionedJob || legacyJob;
  return job?.id === expectedId ? job : null;
}

function lockTimeoutError(file) {
  const error = new Error(`Timed out waiting for the background job mutation lock: ${file}`);
  error.code = 'BACKGROUND_JOB_LOCK_TIMEOUT';
  error.status = 503;
  return error;
}

function lockLostError(file) {
  const error = new Error(`Background job mutation lock ownership was lost: ${file}`);
  error.code = 'BACKGROUND_JOB_LOCK_LOST';
  error.status = 503;
  return error;
}

export function createBackgroundJobRepository({
  directory = defaultJobsDirectory,
  filesystem = fs,
  now = Date.now,
  beforeAtomicReplace = async () => {},
  lockTtlMs = 30_000,
  lockWaitMs = 10_000,
  lockRetryMs = 20,
  replaceRetryMs = 5,
  randomToken = () => crypto.randomUUID(),
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  const mutationQueues = new Map();

  function resolvedDirectory() {
    const value = typeof directory === 'function' ? directory() : directory;
    return path.resolve(String(value || defaultJobsDirectory()));
  }

  function resolvedJobFile(id) {
    const normalized = validJobId(id);
    return normalized ? path.join(resolvedDirectory(), `${normalized}.json`) : '';
  }

  function queueKey(file) {
    return path.normalize(file).toLowerCase();
  }

  async function replaceFile(temporary, file) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await filesystem.rename(temporary, file);
        return;
      } catch (error) {
        if (
          attempt >= 49
          || !['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)
        ) throw error;
        await delay(replaceRetryMs);
      }
    }
  }

  async function lockExpired(file, observedAt) {
    try {
      const [metadata, stat] = await Promise.all([
        filesystem.readFile(file, 'utf8')
          .then(JSON.parse)
          .catch(() => null),
        filesystem.stat(file),
      ]);
      const ownerHostname = String(metadata?.hostname || '').trim();
      const ownerPid = Number(metadata?.pid);
      if (
        (!ownerHostname || ownerHostname === os.hostname())
        && Number.isInteger(ownerPid)
        && ownerPid > 0
      ) {
        try {
          process.kill(ownerPid, 0);
          return false;
        } catch (error) {
          if (!['ESRCH', 'EINVAL'].includes(error?.code)) return false;
        }
      }
      const expiresAt = Date.parse(metadata?.expires_at || '');
      if (Number.isFinite(expiresAt)) return expiresAt <= observedAt;
      return stat.mtimeMs + lockTtlMs <= observedAt;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function reclaimExpiredLock(file) {
    if (!await lockExpired(file, Number(now()))) return false;
    const quarantine = `${file}.stale.${process.pid}.${randomToken()}`;
    try {
      await filesystem.rename(file, quarantine);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'EPERM'].includes(error?.code)) return false;
      throw error;
    }
    await filesystem.rm(quarantine, { force: true }).catch(() => {});
    return true;
  }

  async function acquireLock(file) {
    const lockFile = `${file}.lock`;
    await filesystem.mkdir(path.dirname(lockFile), { recursive: true, mode: 0o750 });
    const deadline = Number(now()) + lockWaitMs;
    while (Number(now()) <= deadline) {
      let handle;
      const token = randomToken();
      try {
        handle = await filesystem.open(lockFile, 'wx', 0o600);
        const acquiredAt = Number(now());
        await handle.writeFile(`${JSON.stringify({
          schema_version: JOB_LOCK_SCHEMA_VERSION,
          token,
          pid: process.pid,
          hostname: os.hostname(),
          acquired_at: new Date(acquiredAt).toISOString(),
          expires_at: new Date(acquiredAt + lockTtlMs).toISOString(),
        })}\n`, 'utf8');
        await handle.close();
        return { file: lockFile, token };
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error?.code !== 'EEXIST') throw error;
        if (await reclaimExpiredLock(lockFile)) continue;
        await delay(lockRetryMs);
      }
    }
    throw lockTimeoutError(lockFile);
  }

  async function ownsLock(lock) {
    try {
      const parsed = JSON.parse(await filesystem.readFile(lock.file, 'utf8'));
      return parsed?.token === lock.token;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function releaseLock(lock) {
    if (!await ownsLock(lock)) return false;
    const released = `${lock.file}.released.${process.pid}.${lock.token}`;
    try {
      await filesystem.rename(lock.file, released);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    await filesystem.rm(released, { force: true }).catch(() => {});
    return true;
  }

  async function recoverAtomicTemps(file, cutoff = null) {
    const directoryName = path.dirname(file);
    const prefix = `${path.basename(file)}.`;
    let entries;
    try {
      entries = await filesystem.readdir(directoryName, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
      const target = path.join(directoryName, entry.name);
      if (Number.isFinite(cutoff)) {
        const stat = await filesystem.stat(target).catch(() => null);
        if (!stat || stat.mtimeMs >= cutoff) continue;
      }
      const didRemove = await filesystem.rm(target, { force: true })
        .then(() => true)
        .catch(() => false);
      if (didRemove) removed += 1;
    }
    return removed;
  }

  async function readStoredJob(file, id) {
    let parsed;
    try {
      parsed = JSON.parse(await filesystem.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
    const stored = unwrap(parsed, id);
    return stored ? clone(stored) : null;
  }

  async function writeSnapshot(file, snapshot, lock) {
    await filesystem.mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
    const temporary = `${file}.${process.pid}.${randomToken()}.tmp`;
    try {
      await filesystem.writeFile(
        temporary,
        `${JSON.stringify(envelope(snapshot), null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      await beforeAtomicReplace({ file, temporary, job: clone(snapshot) });
      if (!await ownsLock(lock)) throw lockLostError(lock.file);
      await replaceFile(temporary, file);
    } finally {
      await filesystem.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function runLocked(file, operation, { recoverTemps = true } = {}) {
    const lock = await acquireLock(file);
    try {
      if (recoverTemps) await recoverAtomicTemps(file);
      return await operation(lock);
    } finally {
      await releaseLock(lock);
    }
  }

  function enqueue(file, operation) {
    const key = queueKey(file);
    const previous = mutationQueues.get(key) || Promise.resolve();
    let tracked;
    const next = previous.catch(() => {}).then(operation);
    tracked = next.finally(() => {
      if (mutationQueues.get(key) === tracked) mutationQueues.delete(key);
    });
    mutationQueues.set(key, tracked);
    return tracked;
  }

  function write(job) {
    const id = validJobId(job?.id);
    if (!id) {
      const error = new Error('A valid background job id is required');
      error.code = 'BACKGROUND_JOB_ID_INVALID';
      return Promise.reject(error);
    }
    const file = resolvedJobFile(id);
    const snapshot = clone(job);
    return enqueue(file, () => runLocked(file, lock => writeSnapshot(file, snapshot, lock)));
  }

  async function read(id, { restoreInterrupted = true } = {}) {
    const normalized = validJobId(id);
    if (!normalized) return null;
    const file = resolvedJobFile(normalized);
    return enqueue(file, () => runLocked(file, async lock => {
      const job = await readStoredJob(file, normalized);
      if (!job) return null;
      if (
        restoreInterrupted
        && (job.status === 'queued' || job.status === 'running')
      ) {
        job.status = 'error';
        job.progress = 100;
        job.message = 'The server restarted before this job completed';
        job.error = 'The background job was interrupted by a server restart. Retry the action.';
        job.updated_at = Number(now());
        await writeSnapshot(file, job, lock);
      }
      return clone(job);
    }));
  }

  async function cleanup(cutoff) {
    const targetDirectory = resolvedDirectory();
    let entries;
    try {
      entries = await filesystem.readdir(targetDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: 0 };
      throw error;
    }

    const ids = new Set();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (JOB_FILE_PATTERN.test(entry.name)) {
        ids.add(entry.name.slice(0, -'.json'.length));
        continue;
      }
      const tempMatch = entry.name.match(JOB_TEMP_FILE_PATTERN);
      if (tempMatch) ids.add(tempMatch[1]);
    }

    let removed = 0;
    for (const id of ids) {
      const file = resolvedJobFile(id);
      const result = await enqueue(file, async () => {
        try {
          return await runLocked(file, async lock => {
            let localRemoved = await recoverAtomicTemps(file, cutoff);
            const stat = await filesystem.stat(file).catch(error => {
              if (error?.code === 'ENOENT') return null;
              throw error;
            });
            if (!stat || stat.mtimeMs >= cutoff) return localRemoved;
            if (!await ownsLock(lock)) throw lockLostError(lock.file);
            const deleted = `${file}.deleted.${process.pid}.${randomToken()}`;
            try {
              await filesystem.rename(file, deleted);
            } catch (error) {
              if (error?.code === 'ENOENT') return localRemoved;
              throw error;
            }
            await filesystem.rm(deleted, { force: true }).catch(() => {});
            localRemoved += 1;
            return localRemoved;
          }, { recoverTemps: false });
        } catch (error) {
          if (error?.code === 'BACKGROUND_JOB_LOCK_TIMEOUT') return 0;
          throw error;
        }
      });
      removed += result;
    }
    return { removed };
  }

  return { cleanup, read, write };
}

const defaultRepository = createBackgroundJobRepository();

export const cleanupBackgroundJobFiles = cutoff => defaultRepository.cleanup(cutoff);

export const readBackgroundJob = id => defaultRepository.read(id);

export const writeBackgroundJob = job => defaultRepository.write(job);
