import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const AGENT_AUDIT_SCHEMA_VERSION = 1;
const AGENT_AUDIT_RECORD_TYPE = 'agent_turn_audit_event';
const AGENT_AUDIT_LOCK_SCHEMA_VERSION = 1;
const AGENT_AUDIT_FILE_PATTERN = /^agent-turns-\d{4}-\d{2}-\d{2}\.jsonl$/i;

function defaultAgentAuditDirectory() {
  return process.env.AGENT_AUDIT_DIR || path.join(process.cwd(), 'data', 'agent-audit');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function repositoryError(message, code, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizedTimestamp(value) {
  const candidate = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(candidate.getTime())) {
    throw repositoryError('Agent audit timestamp is invalid', 'AGENT_AUDIT_TIMESTAMP_INVALID', 400);
  }
  return candidate;
}

function envelope(record) {
  return {
    ...record,
    schema_version: AGENT_AUDIT_SCHEMA_VERSION,
    record_type: AGENT_AUDIT_RECORD_TYPE,
  };
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

export function createAgentAuditRepository({
  directory = defaultAgentAuditDirectory,
  filesystem = fs,
  now = Date.now,
  lockTtlMs = 30_000,
  lockWaitMs = 10_000,
  lockRetryMs = 20,
  randomToken = () => crypto.randomUUID(),
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  const mutationQueues = new Map();

  function resolvedDirectory() {
    const value = typeof directory === 'function' ? directory() : directory;
    return path.resolve(String(value || defaultAgentAuditDirectory()));
  }

  function fileForTimestamp(timestamp) {
    const day = normalizedTimestamp(timestamp).toISOString().slice(0, 10);
    return path.join(resolvedDirectory(), `agent-turns-${day}.jsonl`);
  }

  function queueKey(file) {
    return path.normalize(file).toLowerCase();
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
      if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) return false;
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
          schema_version: AGENT_AUDIT_LOCK_SCHEMA_VERSION,
          token,
          pid: process.pid,
          hostname: os.hostname(),
          acquired_at: new Date(acquiredAt).toISOString(),
          expires_at: new Date(acquiredAt + lockTtlMs).toISOString(),
        })}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        return { file: lockFile, token };
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error?.code !== 'EEXIST') throw error;
        if (await reclaimExpiredLock(lockFile)) continue;
        await delay(lockRetryMs);
      }
    }
    throw repositoryError(
      `Timed out waiting for the Agent audit append lock: ${lockFile}`,
      'AGENT_AUDIT_LOCK_TIMEOUT',
      503,
    );
  }

  async function ownsLock(lock) {
    try {
      const parsed = JSON.parse(await filesystem.readFile(lock.file, 'utf8'));
      return parsed?.token === lock.token;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false;
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

  async function runLocked(file, operation) {
    const lock = await acquireLock(file);
    try {
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

  function append(record, timestamp = now()) {
    if (!validRecord(record)) {
      return Promise.reject(repositoryError(
        'Agent audit record requires non-empty at and event fields',
        'AGENT_AUDIT_RECORD_INVALID',
        400,
      ));
    }
    const file = fileForTimestamp(timestamp);
    const persisted = envelope(clone(record));
    return enqueue(file, () => runLocked(file, async lock => {
      await filesystem.mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
      if (!await ownsLock(lock)) {
        throw repositoryError(
          `Agent audit append lock ownership was lost: ${lock.file}`,
          'AGENT_AUDIT_LOCK_LOST',
          503,
        );
      }
      const handle = await filesystem.open(file, 'a', 0o640);
      try {
        await handle.writeFile(`${JSON.stringify(persisted)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return clone(persisted);
    }));
  }

  async function cleanup(cutoff) {
    const cutoffMs = Number(cutoff instanceof Date ? cutoff.getTime() : cutoff);
    if (!Number.isFinite(cutoffMs)) {
      throw repositoryError('Agent audit cleanup cutoff is invalid', 'AGENT_AUDIT_CUTOFF_INVALID', 400);
    }
    let entries;
    try {
      entries = await filesystem.readdir(resolvedDirectory(), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: 0 };
      throw error;
    }

    let removed = 0;
    await Promise.all(entries.map(async entry => {
      if (!entry.isFile() || !AGENT_AUDIT_FILE_PATTERN.test(entry.name)) return;
      const file = path.join(resolvedDirectory(), entry.name);
      await enqueue(file, () => runLocked(file, async lock => {
        const stat = await filesystem.stat(file).catch(error => {
          if (error?.code === 'ENOENT') return null;
          throw error;
        });
        if (!stat || stat.mtimeMs >= cutoffMs) return;
        if (!await ownsLock(lock)) {
          throw repositoryError(
            `Agent audit cleanup lock ownership was lost: ${lock.file}`,
            'AGENT_AUDIT_LOCK_LOST',
            503,
          );
        }
        await filesystem.unlink(file).catch(error => {
          if (error?.code !== 'ENOENT') throw error;
        });
        removed += 1;
      }));
    }));
    return { removed };
  }

  return {
    append,
    cleanup,
    fileForTimestamp,
  };
}

const defaultAgentAuditRepository = createAgentAuditRepository();

export function appendAgentAuditRecord(record, timestamp) {
  return defaultAgentAuditRepository.append(record, timestamp);
}

export function cleanupAgentAuditFiles(cutoff) {
  return defaultAgentAuditRepository.cleanup(cutoff);
}
