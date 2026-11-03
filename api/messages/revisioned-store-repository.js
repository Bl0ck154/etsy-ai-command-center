import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MESSAGE_REVISIONED_STORE_SCHEMA_VERSION = 1;

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

function validateShops(shops, file, validateRecord) {
  if (!isObject(shops)) {
    throw repositoryError(`Message store shops are invalid: ${file}`, 'MESSAGE_STORE_SCHEMA_INVALID');
  }
  for (const [shopId, record] of Object.entries(shops)) {
    if (!/^\d+$/.test(shopId) || !isObject(record) || !validateRecord(record)) {
      throw repositoryError(`Message store record is invalid: ${file}`, 'MESSAGE_STORE_SCHEMA_INVALID');
    }
  }
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function createMessageRevisionedStoreRepository({
  file,
  recordType,
  validateRecord,
  migrateRecord = record => record,
  filesystem = fs,
  now = Date.now,
  hostname = os.hostname,
  processId = process.pid,
  randomToken = () => crypto.randomUUID(),
  lockTtlMs = 30_000,
  lockWaitMs = 10_000,
  lockRetryMs = 10,
  replaceRetryMs = 5,
  beforeAtomicReplace = async () => {},
} = {}) {
  if (typeof file !== 'function') throw new TypeError('Message repository file resolver is required');
  if (!recordType) throw new TypeError('Message repository record type is required');
  if (typeof validateRecord !== 'function') throw new TypeError('Message repository record validator is required');

  function resolvedFile() {
    return path.resolve(String(file()));
  }

  function envelope(store) {
    return {
      // Keep the pre-repository reader contract during rollback. Older Hub
      // revisions accept only `{ version: 1, shops }`; current readers use the
      // explicit schema_version/record_type pair below.
      version: 1,
      schema_version: MESSAGE_REVISIONED_STORE_SCHEMA_VERSION,
      record_type: recordType,
      shops: store.shops,
    };
  }

  function decodeStore(parsed, target) {
    if (Object.prototype.hasOwnProperty.call(parsed || {}, 'schema_version')) {
      if (parsed.schema_version !== MESSAGE_REVISIONED_STORE_SCHEMA_VERSION) {
        throw repositoryError(
          `Unsupported ${recordType} schema version in ${target}: ${parsed.schema_version}`,
          'MESSAGE_STORE_SCHEMA_UNSUPPORTED',
        );
      }
      if (parsed.record_type !== recordType) {
        throw repositoryError(`Invalid ${recordType} schema envelope: ${target}`, 'MESSAGE_STORE_SCHEMA_INVALID');
      }
      validateShops(parsed.shops, target, validateRecord);
      return { store: { shops: parsed.shops }, needsMigration: false };
    }
    if (parsed?.version === 1) {
      if (!isObject(parsed.shops)) {
        throw repositoryError(`Message store shops are invalid: ${target}`, 'MESSAGE_STORE_SCHEMA_INVALID');
      }
      const shops = Object.fromEntries(Object.entries(parsed.shops).map(
        ([shopId, record]) => [shopId, migrateRecord(clone(record))],
      ));
      validateShops(shops, target, validateRecord);
      return { store: { shops }, needsMigration: true };
    }
    throw repositoryError(`Invalid legacy ${recordType} store: ${target}`, 'MESSAGE_STORE_SCHEMA_INVALID');
  }

  async function ownsLock(lock) {
    try {
      return JSON.parse(await filesystem.readFile(lock.file, 'utf8'))?.token === lock.token;
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

  async function lockExpired(lockFile, observedAt) {
    try {
      const owner = JSON.parse(await filesystem.readFile(lockFile, 'utf8'));
      if (ownerProcessAlive(owner) === true) return false;
      const expiresAt = Date.parse(owner?.expires_at || '');
      if (Number.isFinite(expiresAt)) return expiresAt <= observedAt;
      return (await filesystem.stat(lockFile)).mtimeMs + lockTtlMs <= observedAt;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      if (error instanceof SyntaxError) return (await filesystem.stat(lockFile)).mtimeMs + lockTtlMs <= observedAt;
      throw error;
    }
  }

  async function reclaimExpiredLock(lockFile) {
    if (!await lockExpired(lockFile, Number(now()))) return false;
    const quarantine = `${lockFile}.stale.${processId}.${randomToken()}`;
    try {
      await filesystem.rename(lockFile, quarantine);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) return false;
      throw error;
    }
    try { await filesystem.rm(quarantine, { force: true }); } catch {}
    return true;
  }

  async function acquireLock(target) {
    const lockFile = `${target}.lock`;
    await filesystem.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    const deadline = Number(now()) + lockWaitMs;
    while (Number(now()) <= deadline) {
      const token = randomToken();
      let handle;
      try {
        handle = await filesystem.open(lockFile, 'wx', 0o600);
        const acquiredAt = Number(now());
        await handle.writeFile(`${JSON.stringify({
          schema_version: 1,
          token,
          pid: processId,
          hostname: hostname(),
          acquired_at: new Date(acquiredAt).toISOString(),
          expires_at: new Date(acquiredAt + lockTtlMs).toISOString(),
        })}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        return { file: lockFile, token };
      } catch (error) {
        if (handle) {
          try { await handle.close(); } catch {}
        }
        if (error?.code !== 'EEXIST') throw error;
        if (await reclaimExpiredLock(lockFile)) continue;
        await sleep(lockRetryMs);
      }
    }
    throw repositoryError(`Timed out waiting for ${recordType} lock: ${lockFile}`, 'MESSAGE_STORE_LOCK_TIMEOUT', 503);
  }

  async function releaseLock(lock) {
    if (!await ownsLock(lock)) return false;
    const released = `${lock.file}.released.${processId}.${lock.token}`;
    try {
      await filesystem.rename(lock.file, released);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    try { await filesystem.rm(released, { force: true }); } catch {}
    return true;
  }

  async function recoverTemporaryFiles(target) {
    const prefix = `${path.basename(target)}.`;
    let entries;
    try {
      entries = await filesystem.readdir(path.dirname(target), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(entries.map(async entry => {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) return;
      try { await filesystem.rm(path.join(path.dirname(target), entry.name), { force: true }); } catch {}
    }));
  }

  async function readStore(target) {
    let parsed;
    try {
      parsed = JSON.parse(await filesystem.readFile(target, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { store: { shops: {} }, needsMigration: false };
      if (error instanceof SyntaxError) {
        throw repositoryError(`${recordType} store contains invalid JSON: ${target}`, 'MESSAGE_STORE_CORRUPT');
      }
      throw error;
    }
    return decodeStore(parsed, target);
  }

  async function replaceFile(temporary, target) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await filesystem.rename(temporary, target);
        return;
      } catch (error) {
        if (attempt >= 49 || !['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
        await sleep(replaceRetryMs);
      }
    }
  }

  async function writeStore(target, store, lock) {
    validateShops(store.shops, target, validateRecord);
    const temporary = `${target}.${processId}.${randomToken()}.tmp`;
    let handle;
    try {
      handle = await filesystem.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(envelope(store), null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await beforeAtomicReplace({ file: target, temporary, store: clone(store) });
      if (!await ownsLock(lock)) {
        throw repositoryError(`${recordType} lock ownership was lost: ${lock.file}`, 'MESSAGE_STORE_LOCK_LOST', 503);
      }
      await replaceFile(temporary, target);
      await filesystem.chmod(target, 0o600);
    } finally {
      if (handle) {
        try { await handle.close(); } catch {}
      }
      try { await filesystem.rm(temporary, { force: true }); } catch {}
    }
  }

  async function transact(operation, { migrate = true } = {}) {
    const target = resolvedFile();
    const lock = await acquireLock(target);
    try {
      await recoverTemporaryFiles(target);
      const current = await readStore(target);
      const store = clone(current.store);
      const result = await operation(store, current.needsMigration);
      if (result.write || (migrate && current.needsMigration)) await writeStore(target, store, lock);
      return result.value;
    } finally {
      await releaseLock(lock);
    }
  }

  async function load(shopId) {
    const current = await readStore(resolvedFile());
    return clone(current.store.shops[shopId] || null);
  }

  async function save(shopId, { expectedRevision, buildRecord, conflictError }) {
    return transact(store => {
      const current = store.shops[shopId] || null;
      const currentRevision = Number(current?.revision) || 0;
      if (expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
        throw conflictError(currentRevision);
      }
      const next = buildRecord(clone(current), currentRevision);
      store.shops[shopId] = next;
      return { write: true, value: clone(next) };
    });
  }

  async function validate() {
    return transact(() => ({ write: false, value: true }));
  }

  return { load, save, transact, validate };
}

export { MESSAGE_REVISIONED_STORE_SCHEMA_VERSION };
