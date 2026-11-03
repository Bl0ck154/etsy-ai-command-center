import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GPT_IDEMPOTENCY_SCHEMA_VERSION = 1;
const GPT_IDEMPOTENCY_RECORD_TYPE = 'gpt_idempotency_store';
const RECORD_KEY_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const RECORD_STATUSES = new Set(['running', 'completed', 'failed']);

function defaultFile() {
  return process.env.GPT_IDEMPOTENCY_STORE_FILE || path.join(process.cwd(), 'data', 'gpt-idempotency.json');
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

function emptyStore() {
  return { records: {} };
}

function envelope(store) {
  return {
    schema_version: GPT_IDEMPOTENCY_SCHEMA_VERSION,
    record_type: GPT_IDEMPOTENCY_RECORD_TYPE,
    records: store.records,
  };
}

function validRecord(record) {
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || typeof record.operation_id !== 'string'
    || !record.operation_id
    || typeof record.user_id !== 'string'
    || !record.user_id
    || !FINGERPRINT_PATTERN.test(String(record.fingerprint || ''))
    || typeof record.consequential !== 'boolean'
    || !RECORD_STATUSES.has(record.status)
    || typeof record.created_at !== 'number'
    || !Number.isFinite(record.created_at)
    || typeof record.expires_at !== 'number'
    || !Number.isFinite(record.expires_at)
  ) return false;
  if (record.claim_token !== undefined && (typeof record.claim_token !== 'string' || !record.claim_token)) return false;
  if (record.status === 'completed' && (
    typeof record.completed_at !== 'number'
    || !Number.isFinite(record.completed_at)
  )) return false;
  if (record.status === 'failed' && (
    typeof record.failed_at !== 'number'
    || !Number.isFinite(record.failed_at)
    || typeof record.error_code !== 'string'
    || !record.error_code
  )) return false;
  return true;
}

function validateRecords(records, file) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) {
    throw repositoryError(`GPT idempotency records are invalid: ${file}`, 'GPT_IDEMPOTENCY_SCHEMA_INVALID');
  }
  for (const [key, record] of Object.entries(records)) {
    if (!RECORD_KEY_PATTERN.test(key) || !validRecord(record)) {
      throw repositoryError(`GPT idempotency record is invalid: ${file}`, 'GPT_IDEMPOTENCY_SCHEMA_INVALID');
    }
  }
}

function decodeStore(parsed, file) {
  if (Object.prototype.hasOwnProperty.call(parsed || {}, 'schema_version')) {
    if (parsed.schema_version !== GPT_IDEMPOTENCY_SCHEMA_VERSION) {
      throw repositoryError(
        `Unsupported GPT idempotency schema version in ${file}: ${parsed.schema_version}`,
        'GPT_IDEMPOTENCY_SCHEMA_UNSUPPORTED',
      );
    }
    if (parsed.record_type !== GPT_IDEMPOTENCY_RECORD_TYPE) {
      throw repositoryError(`Invalid GPT idempotency schema envelope: ${file}`, 'GPT_IDEMPOTENCY_SCHEMA_INVALID');
    }
    validateRecords(parsed.records, file);
    return { store: { records: parsed.records }, needsMigration: false };
  }
  if (parsed?.version === 1) {
    validateRecords(parsed.records, file);
    return { store: { records: parsed.records }, needsMigration: true };
  }
  throw repositoryError(`Invalid legacy GPT idempotency store: ${file}`, 'GPT_IDEMPOTENCY_SCHEMA_INVALID');
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function createGptIdempotencyRepository({
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
    throw repositoryError(`Timed out waiting for GPT idempotency lock: ${lockFile}`, 'GPT_IDEMPOTENCY_LOCK_TIMEOUT', 503);
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
      if (error?.code === 'ENOENT') return { store: emptyStore(), needsMigration: false };
      if (error instanceof SyntaxError) {
        throw repositoryError(`GPT idempotency store contains invalid JSON: ${target}`, 'GPT_IDEMPOTENCY_STORE_CORRUPT');
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
    validateRecords(store.records, target);
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
        throw repositoryError(`GPT idempotency lock ownership was lost: ${lock.file}`, 'GPT_IDEMPOTENCY_LOCK_LOST', 503);
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

  function transact(operation) {
    const target = resolvedFile();
    const lock = acquireLock(target);
    try {
      recoverTemporaryFiles(target);
      const current = readStore(target);
      const store = clone(current.store);
      const result = operation(store, current.needsMigration);
      if (result.write || current.needsMigration) writeStore(target, store, lock);
      return result.value;
    } finally {
      releaseLock(lock);
    }
  }

  function validate() {
    return transact(() => ({ write: false, value: true }));
  }

  return { transact, validate };
}

export {
  GPT_IDEMPOTENCY_RECORD_TYPE,
  GPT_IDEMPOTENCY_SCHEMA_VERSION,
};
