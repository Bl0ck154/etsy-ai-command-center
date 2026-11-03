import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECURITY_AUDIT_SCHEMA_VERSION = 1;
const SECURITY_AUDIT_RECORD_TYPE = 'security_audit_event';
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function defaultDirectory() {
  return process.env.SECURITY_AUDIT_DIR || path.join(process.cwd(), 'data', 'security-audit');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function envelope(record) {
  return {
    schema_version: SECURITY_AUDIT_SCHEMA_VERSION,
    record_type: SECURITY_AUDIT_RECORD_TYPE,
    record,
  };
}

function storeError(message, code, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function validRecord(record) {
  return Boolean(
    record
    && typeof record === 'object'
    && !Array.isArray(record)
    && typeof record.at === 'string'
    && record.at
    && typeof record.event === 'string'
    && record.event
  );
}

function decodeLine(line, file) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw storeError(`Security audit file contains invalid NDJSON: ${file}`, 'SECURITY_AUDIT_CORRUPT');
  }

  if (Object.prototype.hasOwnProperty.call(parsed || {}, 'schema_version')) {
    if (parsed.schema_version !== SECURITY_AUDIT_SCHEMA_VERSION) {
      throw storeError(
        `Unsupported security audit schema version in ${file}: ${parsed.schema_version}`,
        'SECURITY_AUDIT_SCHEMA_UNSUPPORTED',
      );
    }
    if (parsed.record_type !== SECURITY_AUDIT_RECORD_TYPE || !validRecord(parsed.record)) {
      throw storeError(`Invalid security audit schema envelope in ${file}`, 'SECURITY_AUDIT_SCHEMA_INVALID');
    }
    return { record: parsed.record, legacy: false };
  }

  if (!validRecord(parsed)) {
    throw storeError(`Invalid legacy security audit record in ${file}`, 'SECURITY_AUDIT_SCHEMA_INVALID');
  }
  return { record: parsed, legacy: true };
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export function createSecurityAuditStore({
  directory = defaultDirectory,
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
  function resolvedDirectory() {
    const value = typeof directory === 'function' ? directory() : directory;
    return path.resolve(String(value || defaultDirectory()));
  }

  function monthFile(month) {
    if (!MONTH_PATTERN.test(String(month || ''))) {
      throw storeError('A valid YYYY-MM security audit month is required', 'SECURITY_AUDIT_MONTH_INVALID', 400);
    }
    return path.join(resolvedDirectory(), `${month}.ndjson`);
  }

  function ownsLock(lock) {
    try {
      const owner = JSON.parse(filesystem.readFileSync(lock.file, 'utf8'));
      return owner?.token === lock.token;
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

  function lockExpired(file, observedAt) {
    try {
      const owner = JSON.parse(filesystem.readFileSync(file, 'utf8'));
      if (ownerProcessAlive(owner) === true) return false;
      const expiresAt = Date.parse(owner?.expires_at || '');
      if (Number.isFinite(expiresAt)) return expiresAt <= observedAt;
      return filesystem.statSync(file).mtimeMs + lockTtlMs <= observedAt;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      if (error instanceof SyntaxError) {
        return filesystem.statSync(file).mtimeMs + lockTtlMs <= observedAt;
      }
      throw error;
    }
  }

  function reclaimExpiredLock(file) {
    if (!lockExpired(file, Number(now()))) return false;
    const quarantine = `${file}.stale.${processId}.${randomToken()}`;
    try {
      filesystem.renameSync(file, quarantine);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) return false;
      throw error;
    }
    try {
      filesystem.rmSync(quarantine, { force: true });
    } catch {}
    return true;
  }

  function acquireLock(file) {
    const lockFile = `${file}.lock`;
    filesystem.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
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
    throw storeError(`Timed out waiting for security audit lock: ${lockFile}`, 'SECURITY_AUDIT_LOCK_TIMEOUT', 503);
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

  function recoverTemporaryFiles(file) {
    const prefix = `${path.basename(file)}.`;
    let entries;
    try {
      entries = filesystem.readdirSync(path.dirname(file), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
      try { filesystem.rmSync(path.join(path.dirname(file), entry.name), { force: true }); } catch {}
    }
  }

  function readFile(file) {
    let text;
    try {
      text = filesystem.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { records: [], needsMigration: false };
      throw error;
    }
    const decoded = text.split(/\r?\n/).filter(Boolean).map(line => decodeLine(line, file));
    return {
      records: decoded.map(item => item.record),
      needsMigration: decoded.some(item => item.legacy),
    };
  }

  function replaceFile(temporary, file) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        filesystem.renameSync(temporary, file);
        return;
      } catch (error) {
        if (attempt >= 49 || !['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
        sleepSync(replaceRetryMs);
      }
    }
  }

  function writeFile(file, records, lock) {
    const temporary = `${file}.${processId}.${randomToken()}.tmp`;
    const serialized = records.map(record => JSON.stringify(envelope(record))).join('\n');
    let handle;
    try {
      handle = filesystem.openSync(temporary, 'wx', 0o640);
      filesystem.writeFileSync(handle, serialized ? `${serialized}\n` : '', 'utf8');
      filesystem.fsyncSync(handle);
      filesystem.closeSync(handle);
      handle = null;
      beforeAtomicReplace({ file, temporary, records: clone(records) });
      if (!ownsLock(lock)) {
        throw storeError(`Security audit lock ownership was lost: ${lock.file}`, 'SECURITY_AUDIT_LOCK_LOST', 503);
      }
      replaceFile(temporary, file);
      filesystem.chmodSync(file, 0o640);
    } finally {
      if (handle !== undefined && handle !== null) {
        try { filesystem.closeSync(handle); } catch {}
      }
      try { filesystem.rmSync(temporary, { force: true }); } catch {}
    }
  }

  function transact(month, mutate) {
    const file = monthFile(month);
    const lock = acquireLock(file);
    try {
      recoverTemporaryFiles(file);
      const current = readFile(file);
      const records = current.records.map(clone);
      const result = mutate(records, current.needsMigration);
      if (result.write) writeFile(file, records, lock);
      return result.value;
    } finally {
      releaseLock(lock);
    }
  }

  function append(record, timestamp = new Date(Number(now()))) {
    if (!validRecord(record)) {
      throw storeError('A valid security audit record is required', 'SECURITY_AUDIT_RECORD_INVALID', 400);
    }
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
      throw storeError('A valid security audit timestamp is required', 'SECURITY_AUDIT_TIMESTAMP_INVALID', 400);
    }
    return transact(date.toISOString().slice(0, 7), records => {
      records.push(clone(record));
      return { write: true, value: clone(record) };
    });
  }

  function readMonth(month, { migrate = true } = {}) {
    return transact(month, (records, needsMigration) => ({
      write: Boolean(migrate && needsMigration),
      value: records.map(clone),
    }));
  }

  return { append, readMonth };
}

const defaultSecurityAuditStore = createSecurityAuditStore();

export const appendSecurityAuditRecord = (record, timestamp) => (
  defaultSecurityAuditStore.append(record, timestamp)
);

export const readSecurityAuditMonth = (month, options) => (
  defaultSecurityAuditStore.readMonth(month, options)
);

export {
  SECURITY_AUDIT_RECORD_TYPE,
  SECURITY_AUDIT_SCHEMA_VERSION,
};
