import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH_SESSION_SCHEMA_VERSION = 1;
const AUTH_SESSION_RECORD_TYPE = 'auth_session_store';
const SESSION_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LEGACY_SESSION_CLOCK_DRIFT_MS = 1_000;

function defaultFile() {
  return process.env.AUTH_SESSIONS_FILE || path.join(process.cwd(), 'data', 'auth-sessions.json');
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function repositoryError(message, code, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validSession(record, maxAgeMs = MAX_SESSION_AGE_MS) {
  return isObject(record)
    && typeof record.userId === 'string'
    && record.userId.length > 0
    && typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt)
    && typeof record.expiresAt === 'number'
    && Number.isFinite(record.expiresAt)
    && record.expiresAt > record.createdAt
    && record.expiresAt - record.createdAt <= maxAgeMs;
}

function validateSessions(sessions, file, maxAgeMs = MAX_SESSION_AGE_MS) {
  if (!isObject(sessions)) {
    throw repositoryError(`Auth sessions are invalid: ${file}`, 'AUTH_SESSION_SCHEMA_INVALID');
  }
  for (const [hash, record] of Object.entries(sessions)) {
    if (!SESSION_HASH_PATTERN.test(hash) || !validSession(record, maxAgeMs)) {
      throw repositoryError(`Auth session record is invalid: ${file}`, 'AUTH_SESSION_SCHEMA_INVALID');
    }
  }
}

function envelope(store) {
  return {
    schema_version: AUTH_SESSION_SCHEMA_VERSION,
    record_type: AUTH_SESSION_RECORD_TYPE,
    sessions: store.sessions,
  };
}

function decodeStore(parsed, file) {
  if (Object.prototype.hasOwnProperty.call(parsed || {}, 'schema_version')) {
    if (parsed.schema_version !== AUTH_SESSION_SCHEMA_VERSION) {
      throw repositoryError(
        `Unsupported auth session schema version in ${file}: ${parsed.schema_version}`,
        'AUTH_SESSION_SCHEMA_UNSUPPORTED',
      );
    }
    if (parsed.record_type !== AUTH_SESSION_RECORD_TYPE) {
      throw repositoryError(`Invalid auth session schema envelope: ${file}`, 'AUTH_SESSION_SCHEMA_INVALID');
    }
    validateSessions(parsed.sessions, file);
    return { store: { sessions: parsed.sessions }, needsMigration: false };
  }
  if (parsed?.version === 1) {
    validateSessions(parsed.sessions, file, MAX_SESSION_AGE_MS + LEGACY_SESSION_CLOCK_DRIFT_MS);
    const sessions = Object.fromEntries(Object.entries(parsed.sessions).map(([hash, record]) => [hash, {
      ...record,
      expiresAt: Math.min(record.expiresAt, record.createdAt + MAX_SESSION_AGE_MS),
    }]));
    return { store: { sessions }, needsMigration: true };
  }
  throw repositoryError(`Invalid legacy auth session store: ${file}`, 'AUTH_SESSION_SCHEMA_INVALID');
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function createAuthSessionRepository({
  file = defaultFile,
  filesystem = fs,
  now = Date.now,
  hostname = os.hostname,
  processId = process.pid,
  randomToken = () => crypto.randomUUID(),
  lockTtlMs = 30_000,
  lockWaitMs = 10_000,
  lockRetryMs = 10,
  replaceRetryMs = 5,
  beforeAtomicReplace = () => {},
} = {}) {
  function resolvedFile() {
    const value = typeof file === 'function' ? file() : file;
    return path.resolve(String(value || defaultFile()));
  }

  function ownsLock(lock) {
    try {
      return JSON.parse(filesystem.readFileSync(lock.file, 'utf8'))?.token === lock.token;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false;
      throw error;
    }
  }

  function ownerProcessAlive(owner) {
    const ownerHostname = String(owner?.hostname || '').trim();
    const ownerPid = Number(owner?.pid);
    if (ownerHostname && ownerHostname !== hostname()) return null;
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
    try {
      process.kill(ownerPid, 0);
      return true;
    } catch (error) {
      if (['ESRCH', 'EINVAL'].includes(error?.code)) return false;
      return true;
    }
  }

  function lockExpired(lockFile, observedAt) {
    try {
      const owner = JSON.parse(filesystem.readFileSync(lockFile, 'utf8'));
      if (ownerProcessAlive(owner) === true) return false;
      const expiresAt = Date.parse(owner?.expires_at || '');
      if (Number.isFinite(expiresAt)) return expiresAt <= observedAt;
      return filesystem.statSync(lockFile).mtimeMs + lockTtlMs <= observedAt;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      if (error instanceof SyntaxError) return filesystem.statSync(lockFile).mtimeMs + lockTtlMs <= observedAt;
      throw error;
    }
  }

  function reclaimExpiredLock(lockFile) {
    if (!lockExpired(lockFile, Number(now()))) return false;
    const quarantine = `${lockFile}.stale.${processId}.${randomToken()}`;
    try {
      filesystem.renameSync(lockFile, quarantine);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) return false;
      throw error;
    }
    try { filesystem.rmSync(quarantine, { force: true }); } catch {}
    return true;
  }

  function acquireLock(target) {
    const lockFile = `${target}.lock`;
    filesystem.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
    const deadline = Number(now()) + lockWaitMs;
    while (Number(now()) <= deadline) {
      const token = randomToken();
      let handle;
      try {
        handle = filesystem.openSync(lockFile, 'wx', 0o600);
        const acquiredAt = Number(now());
        filesystem.writeFileSync(handle, `${JSON.stringify({
          schema_version: 1,
          token,
          pid: processId,
          hostname: hostname(),
          acquired_at: new Date(acquiredAt).toISOString(),
          expires_at: new Date(acquiredAt + lockTtlMs).toISOString(),
        })}\n`, 'utf8');
        filesystem.fsyncSync(handle);
        filesystem.closeSync(handle);
        handle = null;
        return { file: lockFile, token };
      } catch (error) {
        if (handle !== undefined) {
          try { filesystem.closeSync(handle); } catch {}
        }
        if (error?.code !== 'EEXIST') throw error;
        if (reclaimExpiredLock(lockFile)) continue;
        sleepSync(lockRetryMs);
      }
    }
    throw repositoryError(`Timed out waiting for auth session lock: ${lockFile}`, 'AUTH_SESSION_LOCK_TIMEOUT', 503);
  }

  function releaseLock(lock) {
    if (!ownsLock(lock)) return false;
    const released = `${lock.file}.released.${processId}.${lock.token}`;
    try {
      filesystem.renameSync(lock.file, released);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    try { filesystem.rmSync(released, { force: true }); } catch {}
    return true;
  }

  function recoverTemporaryFiles(target) {
    const prefix = `${path.basename(target)}.`;
    let entries;
    try {
      entries = filesystem.readdirSync(path.dirname(target), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
      try { filesystem.rmSync(path.join(path.dirname(target), entry.name), { force: true }); } catch {}
    }
  }

  function readStore(target) {
    let parsed;
    try {
      parsed = JSON.parse(filesystem.readFileSync(target, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { store: { sessions: {} }, needsMigration: false };
      if (error instanceof SyntaxError) {
        throw repositoryError(`Auth session store contains invalid JSON: ${target}`, 'AUTH_SESSION_STORE_CORRUPT');
      }
      throw error;
    }
    return decodeStore(parsed, target);
  }

  function replaceFile(temporary, target) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        filesystem.renameSync(temporary, target);
        return;
      } catch (error) {
        if (attempt >= 49 || !['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
        sleepSync(replaceRetryMs);
      }
    }
  }

  function writeStore(target, store, lock) {
    validateSessions(store.sessions, target);
    const temporary = `${target}.${processId}.${randomToken()}.tmp`;
    let handle;
    try {
      handle = filesystem.openSync(temporary, 'wx', 0o600);
      filesystem.writeFileSync(handle, `${JSON.stringify(envelope(store))}\n`, 'utf8');
      filesystem.fsyncSync(handle);
      filesystem.closeSync(handle);
      handle = null;
      beforeAtomicReplace({ file: target, temporary, store: clone(store) });
      if (!ownsLock(lock)) {
        throw repositoryError(`Auth session lock ownership was lost: ${lock.file}`, 'AUTH_SESSION_LOCK_LOST', 503);
      }
      replaceFile(temporary, target);
      filesystem.chmodSync(target, 0o600);
    } finally {
      if (handle !== undefined && handle !== null) {
        try { filesystem.closeSync(handle); } catch {}
      }
      try { filesystem.rmSync(temporary, { force: true }); } catch {}
    }
  }

  function cleanup(store, observedAt = Number(now())) {
    let changed = false;
    for (const [hash, record] of Object.entries(store.sessions)) {
      if (record.expiresAt <= observedAt) {
        delete store.sessions[hash];
        changed = true;
      }
    }
    return changed;
  }

  function transact(operation) {
    const target = resolvedFile();
    const lock = acquireLock(target);
    try {
      recoverTemporaryFiles(target);
      const current = readStore(target);
      const store = clone(current.store);
      const cleaned = cleanup(store);
      const result = operation(store);
      if (result.write || cleaned || current.needsMigration) writeStore(target, store, lock);
      return result.value;
    } finally {
      releaseLock(lock);
    }
  }

  function find(hash) {
    const target = resolvedFile();
    const current = readStore(target);
    const record = current.store.sessions[hash] || null;
    const expiredRecords = Object.values(current.store.sessions).some(
      session => session.expiresAt <= Number(now()),
    );
    if (current.needsMigration || expiredRecords) {
      return transact(store => ({ write: false, value: clone(store.sessions[hash] || null) }));
    }
    return clone(record);
  }

  function create(hash, session) {
    if (!SESSION_HASH_PATTERN.test(hash) || !validSession(session)) {
      throw repositoryError('Cannot persist an invalid auth session', 'AUTH_SESSION_SCHEMA_INVALID');
    }
    return transact(store => {
      store.sessions[hash] = clone(session);
      return { write: true, value: clone(session) };
    });
  }

  function revoke(hash) {
    return transact(store => {
      const existed = Object.prototype.hasOwnProperty.call(store.sessions, hash);
      delete store.sessions[hash];
      return { write: existed, value: existed };
    });
  }

  function validate() {
    return transact(() => ({ write: false, value: true }));
  }

  return { create, find, revoke, transact, validate };
}

export {
  AUTH_SESSION_RECORD_TYPE,
  AUTH_SESSION_SCHEMA_VERSION,
  MAX_SESSION_AGE_MS,
};
