import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GPT_OAUTH_SCHEMA_VERSION = 1;
const GPT_OAUTH_RECORD_TYPE = 'gpt_oauth_store';
const HASH_KEY_PATTERN = /^[a-f0-9]{64}$/;

function defaultFile() {
  return process.env.GPT_OAUTH_STORE_FILE || path.join(process.cwd(), 'data', 'gpt-oauth.json');
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function repositoryError(message, code, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.oauthCode = 'server_error';
  error.status = status;
  return error;
}

function emptyStore() {
  return { codes: {}, access_tokens: {}, refresh_tokens: {}, families: {} };
}

function envelope(store) {
  return {
    schema_version: GPT_OAUTH_SCHEMA_VERSION,
    record_type: GPT_OAUTH_RECORD_TYPE,
    codes: store.codes,
    access_tokens: store.access_tokens,
    refresh_tokens: store.refresh_tokens,
    families: store.families,
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validIdentity(record) {
  return typeof record.client_id === 'string'
    && record.client_id.length > 0
    && typeof record.user_id === 'string'
    && record.user_id.length > 0
    && typeof record.user_name === 'string'
    && typeof record.role === 'string'
    && Array.isArray(record.scopes)
    && record.scopes.length > 0
    && record.scopes.every(scope => typeof scope === 'string' && scope.length > 0)
    && isTimestamp(record.created_at)
    && isTimestamp(record.expires_at);
}

function validCode(record) {
  return isObject(record)
    && validIdentity(record)
    && typeof record.redirect_uri === 'string'
    && record.redirect_uri.length > 0
    && typeof record.code_challenge === 'string'
    && typeof record.code_challenge_method === 'string'
    && (record.used_at === undefined || isTimestamp(record.used_at));
}

function validToken(record) {
  return isObject(record)
    && validIdentity(record)
    && typeof record.family_id === 'string'
    && record.family_id.length > 0
    && (record.used_at === undefined || isTimestamp(record.used_at));
}

function validFamily(record) {
  return isObject(record)
    && isTimestamp(record.created_at)
    && isTimestamp(record.expires_at)
    && (record.revoked_at === undefined || isTimestamp(record.revoked_at))
    && (record.revoke_reason === undefined || typeof record.revoke_reason === 'string');
}

function validateMap(records, validator, label, file) {
  if (!isObject(records)) {
    throw repositoryError(`GPT OAuth ${label} are invalid: ${file}`, 'GPT_OAUTH_SCHEMA_INVALID');
  }
  for (const [key, record] of Object.entries(records)) {
    if (!HASH_KEY_PATTERN.test(key) || !validator(record)) {
      throw repositoryError(`GPT OAuth ${label} record is invalid: ${file}`, 'GPT_OAUTH_SCHEMA_INVALID');
    }
  }
}

function validateStore(store, file) {
  if (!isObject(store)) {
    throw repositoryError(`GPT OAuth store is invalid: ${file}`, 'GPT_OAUTH_SCHEMA_INVALID');
  }
  validateMap(store.codes, validCode, 'authorization code', file);
  validateMap(store.access_tokens, validToken, 'access token', file);
  validateMap(store.refresh_tokens, validToken, 'refresh token', file);
  if (!isObject(store.families)) {
    throw repositoryError(`GPT OAuth families are invalid: ${file}`, 'GPT_OAUTH_SCHEMA_INVALID');
  }
  for (const record of Object.values(store.families)) {
    if (!validFamily(record)) {
      throw repositoryError(`GPT OAuth family record is invalid: ${file}`, 'GPT_OAUTH_SCHEMA_INVALID');
    }
  }
}

function decodeStore(parsed, file) {
  if (Object.prototype.hasOwnProperty.call(parsed || {}, 'schema_version')) {
    if (parsed.schema_version !== GPT_OAUTH_SCHEMA_VERSION) {
      throw repositoryError(
        `Unsupported GPT OAuth schema version in ${file}: ${parsed.schema_version}`,
        'GPT_OAUTH_SCHEMA_UNSUPPORTED',
      );
    }
    if (parsed.record_type !== GPT_OAUTH_RECORD_TYPE) {
      throw repositoryError(`Invalid GPT OAuth schema envelope: ${file}`, 'GPT_OAUTH_SCHEMA_INVALID');
    }
    const store = {
      codes: parsed.codes,
      access_tokens: parsed.access_tokens,
      refresh_tokens: parsed.refresh_tokens,
      families: parsed.families,
    };
    validateStore(store, file);
    return { store, needsMigration: false };
  }
  if (parsed?.version === 1) {
    const store = {
      codes: parsed.codes,
      access_tokens: parsed.access_tokens,
      refresh_tokens: parsed.refresh_tokens,
      families: parsed.families,
    };
    validateStore(store, file);
    return { store, needsMigration: true };
  }
  throw repositoryError(`Invalid legacy GPT OAuth store: ${file}`, 'GPT_OAUTH_SCHEMA_INVALID');
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function createGptOAuthRepository({
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
    throw repositoryError(`Timed out waiting for GPT OAuth lock: ${lockFile}`, 'GPT_OAUTH_LOCK_TIMEOUT', 503);
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
        throw repositoryError(`GPT OAuth store contains invalid JSON: ${target}`, 'GPT_OAUTH_STORE_CORRUPT');
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
    validateStore(store, target);
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
        throw repositoryError(`GPT OAuth lock ownership was lost: ${lock.file}`, 'GPT_OAUTH_LOCK_LOST', 503);
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

  function resetForTests() {
    const target = resolvedFile();
    const lock = acquireLock(target);
    try {
      try { filesystem.rmSync(target, { force: true }); } catch {}
      recoverTemporaryFiles(target);
    } finally {
      releaseLock(lock);
    }
  }

  return { transact, validate, resetForTests };
}

export {
  GPT_OAUTH_RECORD_TYPE,
  GPT_OAUTH_SCHEMA_VERSION,
};
