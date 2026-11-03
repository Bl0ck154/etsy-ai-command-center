import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STATE_SCHEMA_VERSION = 1;
const WORKER_STATUS_SCHEMA_VERSION = 1;

function positiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(parsed, max))
    : fallback;
}

function defaultStateFile() {
  return process.env.MESSAGE_TRIGGER_STATE_FILE
    || path.join(process.cwd(), 'data', 'message-trigger-state.json');
}

function defaultLockFile(stateFile) {
  return process.env.MESSAGE_TRIGGER_STATE_LOCK_FILE || `${stateFile}.lock`;
}

function defaultWorkerStatusFile(stateFile) {
  return process.env.MESSAGE_TRIGGER_WORKER_STATUS_FILE
    || path.join(path.dirname(stateFile), 'message-trigger-worker-status.json');
}

function emptyState() {
  return { version: STATE_SCHEMA_VERSION, events: {}, candidates: {} };
}

function resolvePath(value, fallback) {
  const resolved = typeof value === 'function' ? value() : value;
  return String(resolved || fallback()).trim();
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode,
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function lockTimeoutError(file) {
  const error = new Error(`Timed out waiting for the message trigger state lock: ${file}`);
  error.code = 'MESSAGE_TRIGGER_STATE_LOCK_TIMEOUT';
  error.status = 503;
  return error;
}

function lockLostError(file) {
  const error = new Error(`Message trigger state lock ownership was lost: ${file}`);
  error.code = 'MESSAGE_TRIGGER_STATE_LOCK_LOST';
  error.status = 503;
  return error;
}

export function createMessageTriggerStateRepository({
  stateFile = defaultStateFile,
  lockFile,
  workerStatusFile,
  lockTtlMs = positiveInteger(
    process.env.MESSAGE_TRIGGER_STATE_LOCK_TTL_MS,
    30_000,
    1_000,
    120_000,
  ),
  lockWaitMs = positiveInteger(
    process.env.MESSAGE_TRIGGER_STATE_LOCK_WAIT_MS,
    10_000,
    100,
    60_000,
  ),
  lockRetryMs = positiveInteger(
    process.env.MESSAGE_TRIGGER_STATE_LOCK_RETRY_MS,
    20,
    5,
    1_000,
  ),
  now = Date.now,
  randomToken = () => crypto.randomUUID(),
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  const resolvedStateFile = () => resolvePath(stateFile, defaultStateFile);
  const resolvedLockFile = () => resolvePath(
    lockFile,
    () => defaultLockFile(resolvedStateFile()),
  );
  const resolvedWorkerStatusFile = () => resolvePath(
    workerStatusFile,
    () => defaultWorkerStatusFile(resolvedStateFile()),
  );

  async function readState() {
    try {
      const parsed = await readJsonFile(resolvedStateFile());
      if (
        parsed?.version === STATE_SCHEMA_VERSION
        && parsed.events
        && typeof parsed.events === 'object'
        && parsed.candidates
        && typeof parsed.candidates === 'object'
      ) return parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return emptyState();
  }

  async function writeState(state) {
    const record = {
      ...state,
      version: STATE_SCHEMA_VERSION,
      events: state?.events && typeof state.events === 'object' ? state.events : {},
      candidates: state?.candidates && typeof state.candidates === 'object'
        ? state.candidates
        : {},
    };
    await writeJsonAtomic(resolvedStateFile(), record);
  }

  async function lockExpired(file, observedAt) {
    try {
      const [metadata, stat] = await Promise.all([
        readJsonFile(file).catch(() => null),
        fs.stat(file),
      ]);
      const ownerPid = Number(metadata?.pid);
      const ownerHostname = String(metadata?.hostname || '').trim();
      const ownerIsOnThisHost = !ownerHostname || ownerHostname === os.hostname();
      if (ownerIsOnThisHost && Number.isInteger(ownerPid) && ownerPid > 0) {
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
      await fs.rename(file, quarantine);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'EPERM'].includes(error?.code)) return false;
      throw error;
    }
    await fs.rm(quarantine, { force: true }).catch(() => {});
    return true;
  }

  async function acquireLock() {
    const file = resolvedLockFile();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
    const deadline = Number(now()) + lockWaitMs;
    while (Number(now()) <= deadline) {
      const token = randomToken();
      let handle;
      try {
        handle = await fs.open(file, 'wx', 0o600);
        const acquiredAt = Number(now());
        await handle.writeFile(`${JSON.stringify({
          version: 1,
          token,
          pid: process.pid,
          hostname: os.hostname(),
          acquired_at: new Date(acquiredAt).toISOString(),
          expires_at: new Date(acquiredAt + lockTtlMs).toISOString(),
        })}\n`, 'utf8');
        await handle.close();
        return { file, token };
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error?.code !== 'EEXIST') throw error;
        if (await reclaimExpiredLock(file)) continue;
        await delay(lockRetryMs);
      }
    }
    throw lockTimeoutError(file);
  }

  async function releaseLock(lock) {
    if (!lock?.file || !lock?.token) return false;
    let metadata;
    try {
      metadata = await readJsonFile(lock.file);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (metadata?.token !== lock.token) return false;
    const released = `${lock.file}.released.${process.pid}.${lock.token}`;
    try {
      await fs.rename(lock.file, released);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    await fs.rm(released, { force: true }).catch(() => {});
    return true;
  }

  async function ownsLock(lock) {
    if (!lock?.file || !lock?.token) return false;
    try {
      const metadata = await readJsonFile(lock.file);
      return metadata?.token === lock.token;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function mutateState(operation) {
    const lock = await acquireLock();
    try {
      const state = await readState();
      const result = await operation(state);
      if (!await ownsLock(lock)) throw lockLostError(lock.file);
      await writeState(state);
      return result;
    } finally {
      await releaseLock(lock);
    }
  }

  async function readWorkerStatus() {
    try {
      const parsed = await readJsonFile(resolvedWorkerStatusFile());
      return parsed?.version === WORKER_STATUS_SCHEMA_VERSION ? parsed : null;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writeWorkerStatus(status = {}) {
    const persistedAt = new Date(Number(now())).toISOString();
    const record = {
      version: WORKER_STATUS_SCHEMA_VERSION,
      ...JSON.parse(JSON.stringify(status || {})),
      persisted_at: persistedAt,
      pid: process.pid,
    };
    await writeJsonAtomic(resolvedWorkerStatusFile(), record);
    return record;
  }

  return {
    acquireLock,
    mutateState,
    ownsLock,
    readState,
    readWorkerStatus,
    releaseLock,
    writeWorkerStatus,
  };
}

const defaultRepository = createMessageTriggerStateRepository();

export const mutateMessageTriggerState = operation => (
  defaultRepository.mutateState(operation)
);

export const readMessageTriggerState = () => defaultRepository.readState();

export const readMessageTriggerWorkerStatus = () => (
  defaultRepository.readWorkerStatus()
);

export const writeMessageTriggerWorkerStatus = status => (
  defaultRepository.writeWorkerStatus(status)
);
