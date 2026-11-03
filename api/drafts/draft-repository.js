import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DRAFT_SCHEMA_VERSION = 1;
const DRAFT_RECORD_TYPE = 'create_draft';
const MAX_DRAFT_BYTES = 23 * 1024 * 1024;
const ALLOWED_KEYS = new Set(['create_draft']);

function defaultDraftsDirectory() {
  return process.env.DRAFTS_DIR || path.join(process.cwd(), 'data', 'drafts');
}

export function safeDraftSegment(value, fallback = 'default') {
  const safe = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
  return safe || fallback;
}

export function draftStorageFilename({ shopId, userId, key = 'create_draft' } = {}) {
  const normalizedKey = safeDraftSegment(key);
  if (!ALLOWED_KEYS.has(normalizedKey)) return '';
  return `${safeDraftSegment(shopId, 'default_shop')}-${safeDraftSegment(userId, 'anonymous')}-${normalizedKey}.json`;
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function envelope(record) {
  return {
    schema_version: DRAFT_SCHEMA_VERSION,
    record_type: DRAFT_RECORD_TYPE,
    record,
  };
}

function unwrap(parsed) {
  if (
    parsed?.schema_version === DRAFT_SCHEMA_VERSION
    && parsed?.record_type === DRAFT_RECORD_TYPE
    && parsed?.record
    && typeof parsed.record === 'object'
  ) return { record: parsed.record, needsMigration: false };
  if (parsed && typeof parsed === 'object' && 'value' in parsed) {
    return { record: parsed, needsMigration: true };
  }
  return { record: null, needsMigration: false };
}

function lockTimeoutError(file) {
  const error = new Error(`Timed out waiting for the draft mutation lock: ${file}`);
  error.code = 'DRAFT_LOCK_TIMEOUT';
  error.status = 503;
  return error;
}

function lockLostError(file) {
  const error = new Error(`Draft mutation lock ownership was lost: ${file}`);
  error.code = 'DRAFT_LOCK_LOST';
  error.status = 503;
  return error;
}

export function createDraftRepository({
  directory = defaultDraftsDirectory,
  filesystem = fs,
  now = Date.now,
  lockTtlMs = 30_000,
  lockWaitMs = 10_000,
  lockRetryMs = 20,
  replaceRetryMs = 5,
  randomToken = () => crypto.randomUUID(),
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  beforeAtomicReplace = async () => {},
} = {}) {
  const mutationQueues = new Map();

  function resolvedDirectory() {
    const value = typeof directory === 'function' ? directory() : directory;
    return path.resolve(String(value || defaultDraftsDirectory()));
  }

  function resolveIdentity(identity = {}) {
    const key = safeDraftSegment(identity.key);
    const filename = draftStorageFilename({ ...identity, key });
    if (!filename) return null;
    const targetDirectory = resolvedDirectory();
    const shopId = safeDraftSegment(identity.shopId, 'default_shop');
    return {
      file: path.join(targetDirectory, filename),
      legacyFile: path.join(targetDirectory, `${shopId}-${key}.json`),
    };
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

  async function writeRecord(file, record, lock) {
    const legacySerialized = JSON.stringify(record, null, 2);
    if (Buffer.byteLength(legacySerialized, 'utf8') > MAX_DRAFT_BYTES) {
      const error = new Error('Draft is too large to store on the server');
      error.status = 413;
      throw error;
    }
    await filesystem.mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
    const temporary = `${file}.${process.pid}.${randomToken()}.tmp`;
    try {
      await filesystem.writeFile(
        temporary,
        `${JSON.stringify(envelope(record), null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      await beforeAtomicReplace({ file, temporary, record: clone(record) });
      if (!await ownsLock(lock)) throw lockLostError(lock.file);
      await replaceFile(temporary, file);
    } finally {
      await filesystem.rm(temporary, { force: true }).catch(() => {});
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
          schema_version: 1,
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

  async function recoverAtomicTemps(file) {
    const directoryName = path.dirname(file);
    const prefix = `${path.basename(file)}.`;
    let entries;
    try {
      entries = await filesystem.readdir(directoryName, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(entries.map(async entry => {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) return;
      await filesystem.rm(path.join(directoryName, entry.name), { force: true }).catch(() => {});
    }));
  }

  async function readStoredRecord(paths, lock) {
    let sourceFile = paths.file;
    let parsed;
    try {
      parsed = JSON.parse(await filesystem.readFile(sourceFile, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        await filesystem.rename(paths.legacyFile, paths.file);
      } catch (renameError) {
        if (!['ENOENT', 'EEXIST'].includes(renameError?.code)) throw renameError;
      }
      try {
        parsed = JSON.parse(await filesystem.readFile(paths.file, 'utf8'));
      } catch (retryError) {
        if (retryError?.code === 'ENOENT') return null;
        throw retryError;
      }
    }
    const { record, needsMigration } = unwrap(parsed);
    if (record && needsMigration) await writeRecord(paths.file, record, lock);
    return clone(record);
  }

  async function runMutation(paths, operation) {
    const lock = await acquireLock(paths.file);
    try {
      await recoverAtomicTemps(paths.file);
      let current = await readStoredRecord(paths, lock);
      const context = {
        get record() { return clone(current); },
        get value() { return clone(current?.value ?? null); },
        async write(record) {
          await writeRecord(paths.file, record, lock);
          current = clone(record);
          return clone(current);
        },
        async remove() {
          if (!await ownsLock(lock)) throw lockLostError(lock.file);
          const removed = `${paths.file}.deleted.${process.pid}.${randomToken()}`;
          try {
            await filesystem.rename(paths.file, removed);
          } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
          }
          await filesystem.rm(removed, { force: true }).catch(() => {});
          current = null;
          return true;
        },
      };
      return await operation(context);
    } finally {
      await releaseLock(lock);
    }
  }

  function mutate(identity, operation) {
    const paths = resolveIdentity(identity);
    if (!paths || typeof operation !== 'function') {
      const error = new Error('A valid draft identity and mutation are required');
      error.code = 'DRAFT_IDENTITY_INVALID';
      return Promise.reject(error);
    }
    const key = queueKey(paths.file);
    const previous = mutationQueues.get(key) || Promise.resolve();
    let tracked;
    const next = previous.catch(() => {}).then(() => runMutation(paths, operation));
    tracked = next.finally(() => {
      if (mutationQueues.get(key) === tracked) mutationQueues.delete(key);
    });
    mutationQueues.set(key, tracked);
    return tracked;
  }

  const read = identity => mutate(identity, context => context.record);

  return { mutate, read };
}

const defaultRepository = createDraftRepository();

export const mutateDraftRecord = (identity, operation) => (
  defaultRepository.mutate(identity, operation)
);

export const readDraftRecord = identity => defaultRepository.read(identity);
