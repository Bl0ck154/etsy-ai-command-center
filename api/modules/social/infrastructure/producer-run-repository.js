import crypto from 'node:crypto';

export const SOCIAL_PRODUCER_LEASE_SCHEMA_VERSION = 1;
export const SOCIAL_PRODUCER_LEASE_RECORD_TYPE = 'social_owner_review_producer_lease';
export const SOCIAL_PRODUCER_STATUS_SCHEMA_VERSION = 1;
export const SOCIAL_PRODUCER_STATUS_RECORD_TYPE = 'social_owner_review_producer_status';

const DEFAULT_COMMAND_TIMEOUT_MS = 1_500;
const MAX_COMMAND_TIMEOUT_MS = 5_000;
const MIN_HEARTBEAT_INTERVAL_MS = 250;
const MAX_HEARTBEAT_INTERVAL_MS = 30_000;
const PRODUCER_STATUSES = new Set(['acquired', 'running', 'completed', 'failed', 'aborted', 'stale']);
const TERMINAL_PRODUCER_STATUSES = new Set(['completed', 'failed', 'aborted', 'stale']);

const ACQUIRE_SCRIPT = `
-- social-producer-acquire-v1
if redis.call('GET', KEYS[1]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
return 1
`.trim();

const RENEW_SCRIPT = `
-- social-producer-renew-v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`.trim();

const ASSERT_OWNED_SCRIPT = `
-- social-producer-assert-owned-v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`.trim();

const RELEASE_SCRIPT = `
-- social-producer-release-v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
`.trim();

const WRITE_STATUS_SCRIPT = `
-- social-producer-write-status-v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
local current_raw = redis.call('GET', KEYS[2])
if current_raw then
  local decoded_ok, current = pcall(cjson.decode, current_raw)
  if not decoded_ok then
    return -2
  end
  local current_status = current['status'] or {}
  local current_sequence = tonumber(current_status['sequence']) or 0
  if tonumber(ARGV[3]) <= current_sequence then
    return -1
  end
  local current_value = tostring(current_status['status'] or '')
  if current_value == 'completed' or current_value == 'failed' or current_value == 'aborted' or current_value == 'stale' then
    return -1
  end
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`.trim();

const MARK_STALE_STATUS_SCRIPT = `
-- social-producer-mark-stale-v1
if redis.call('GET', KEYS[1]) then
  return 0
end
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`.trim();

function repositoryError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.status = 500;
  error.retryable = false;
  return error;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function validInstant(value, field) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) {
    throw repositoryError(
      'SOCIAL_PRODUCER_PERSISTENCE_INPUT_INVALID',
      `Social producer ${field} must be a valid ISO timestamp.`,
    );
  }
  return timestamp;
}

function requiredText(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw repositoryError(
      'SOCIAL_PRODUCER_PERSISTENCE_INPUT_INVALID',
      `Social producer ${field} is required.`,
    );
  }
  return normalized;
}

function encodeValue(value) {
  return encodeURIComponent(JSON.stringify(value));
}

function decodeValue(raw, code, label) {
  try {
    return JSON.parse(decodeURIComponent(String(raw)));
  } catch (cause) {
    throw repositoryError(code, `${label} is corrupt.`, cause);
  }
}

function statusEnvelope(status) {
  return {
    schema_version: SOCIAL_PRODUCER_STATUS_SCHEMA_VERSION,
    record_type: SOCIAL_PRODUCER_STATUS_RECORD_TYPE,
    status,
  };
}

function validateStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw repositoryError(
      'SOCIAL_PRODUCER_STATUS_INVALID',
      'Social producer status must be an object.',
    );
  }
  const sequence = status.sequence === undefined ? 0 : Number(status.sequence);
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw repositoryError(
      'SOCIAL_PRODUCER_STATUS_INVALID',
      'Social producer status sequence must be a non-negative integer.',
    );
  }
  const normalized = {
    ...status,
    component: requiredText(status.component, 'status component'),
    run_id: requiredText(status.run_id, 'status run_id'),
    stage: requiredText(status.stage, 'status stage'),
    status: requiredText(status.status, 'status value'),
    sequence,
  };
  validInstant(normalized.started_at, 'status started_at');
  validInstant(normalized.deadline_at, 'status deadline_at');
  validInstant(normalized.updated_at, 'status updated_at');
  if (normalized.published !== false) {
    throw repositoryError(
      'SOCIAL_PRODUCER_STATUS_INVALID',
      'Owner-review producer status must truthfully report published=false.',
    );
  }
  if (!PRODUCER_STATUSES.has(normalized.status)) {
    throw repositoryError(
      'SOCIAL_PRODUCER_STATUS_INVALID',
      `Unsupported Social producer status value: ${normalized.status}.`,
    );
  }
  if (TERMINAL_PRODUCER_STATUSES.has(normalized.status) && normalized.finished_at) {
    validInstant(normalized.finished_at, 'status finished_at');
  }
  return normalized;
}

function decodeStatusEnvelope(raw) {
  const parsed = decodeValue(
    raw,
    'SOCIAL_PRODUCER_STATUS_CORRUPT',
    'Social producer status record',
  );
  if (parsed?.schema_version !== SOCIAL_PRODUCER_STATUS_SCHEMA_VERSION) {
    throw repositoryError(
      'SOCIAL_PRODUCER_STATUS_SCHEMA_UNSUPPORTED',
      `Unsupported Social producer status schema version: ${parsed?.schema_version}.`,
    );
  }
  if (parsed.record_type !== SOCIAL_PRODUCER_STATUS_RECORD_TYPE) {
    throw repositoryError(
      'SOCIAL_PRODUCER_STATUS_SCHEMA_INVALID',
      'Social producer status record_type is invalid.',
    );
  }
  return validateStatus(parsed.status);
}

function decodeLeaseEnvelope(raw) {
  const parsed = decodeValue(
    raw,
    'SOCIAL_PRODUCER_LEASE_CORRUPT',
    'Social producer lease record',
  );
  if (
    parsed?.schema_version !== SOCIAL_PRODUCER_LEASE_SCHEMA_VERSION
    || parsed?.record_type !== SOCIAL_PRODUCER_LEASE_RECORD_TYPE
    || !parsed.lease
  ) {
    throw repositoryError(
      'SOCIAL_PRODUCER_LEASE_SCHEMA_INVALID',
      'Social producer lease schema is invalid.',
    );
  }
  return parsed.lease;
}

async function callProducerRedis(command, ...args) {
  const url = String(process.env.KV_REST_API_URL || '').replace(/^['"]|['"]$/g, '');
  const token = String(process.env.KV_REST_API_TOKEN || '').replace(/^['"]|['"]$/g, '');
  if (!url || !token) {
    throw repositoryError(
      'SOCIAL_PRODUCER_PERSISTENCE_UNAVAILABLE',
      'KV_REST_API_URL or KV_REST_API_TOKEN is not configured for Social producer persistence.',
    );
  }
  const response = await fetch(`${url}/${[command, ...args].join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json();
  if (!response.ok || payload?.error) {
    throw repositoryError(
      'SOCIAL_PRODUCER_PERSISTENCE_UNAVAILABLE',
      `Social producer Redis command failed: ${payload?.error || response.status}.`,
    );
  }
  return payload.result;
}

export function createSocialProducerRunRepository({
  callKv = callProducerRedis,
  shopId = process.env.ETSY_SHOP_ID || 'default',
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  clock = () => new Date(),
  createToken = () => `${process.pid}:${crypto.randomUUID()}`,
} = {}) {
  if (typeof callKv !== 'function') throw new TypeError('callKv is required');
  const leaseKey = `${shopId}:social:producer:lease`;
  const statusKey = `${shopId}:social:producer:status`;
  const boundedCommandTimeoutMs = positiveInteger(
    commandTimeoutMs,
    DEFAULT_COMMAND_TIMEOUT_MS,
    MAX_COMMAND_TIMEOUT_MS,
  );

  const boundedCall = async (...args) => {
    let timer;
    try {
      return await Promise.race([
        callKv(...args),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(repositoryError(
            'SOCIAL_PRODUCER_PERSISTENCE_TIMEOUT',
            'Social producer persistence command timed out.',
          )), boundedCommandTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (cause) {
      if (cause?.code === 'SOCIAL_PRODUCER_PERSISTENCE_TIMEOUT') throw cause;
      throw repositoryError(
        'SOCIAL_PRODUCER_PERSISTENCE_UNAVAILABLE',
        `Social producer persistence is unavailable: ${cause?.message || cause}`,
        cause,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const markLeaseLost = lease => {
    if (!lease) return;
    lease.lost = true;
    if (lease.heartbeat) clearInterval(lease.heartbeat);
    lease.heartbeat = null;
  };

  const renew = async lease => {
    if (!lease?.acquired || lease.released || lease.lost) return false;
    const renewed = await boundedCall(
      'EVAL',
      encodeURIComponent(RENEW_SCRIPT),
      '1',
      encodeURIComponent(leaseKey),
      lease.fence_value,
      String(lease.ttl_seconds),
    );
    if (Number(renewed) !== 1) {
      markLeaseLost(lease);
      return false;
    }
    return true;
  };

  const assertOwned = async lease => {
    if (!lease?.acquired || lease.released || lease.lost) {
      throw repositoryError(
        'SOCIAL_PRODUCER_LEASE_LOST',
        'Social producer ownership assertion rejected because exact lease ownership is missing.',
      );
    }
    const owned = await boundedCall(
      'EVAL',
      encodeURIComponent(ASSERT_OWNED_SCRIPT),
      '1',
      encodeURIComponent(leaseKey),
      lease.fence_value,
      String(lease.ttl_seconds),
    );
    if (Number(owned) !== 1) {
      markLeaseLost(lease);
      throw repositoryError(
        'SOCIAL_PRODUCER_LEASE_LOST',
        'Social producer ownership assertion rejected after lease ownership was lost.',
      );
    }
    return true;
  };

  const acquire = async ({ run_id, started_at, deadline_at, ttl_seconds } = {}) => {
    const runId = requiredText(run_id, 'run_id');
    const startedAtMs = validInstant(started_at, 'started_at');
    const deadlineAtMs = validInstant(deadline_at, 'deadline_at');
    const ttlSeconds = positiveInteger(ttl_seconds, 0, 24 * 60 * 60);
    if (!ttlSeconds || deadlineAtMs <= startedAtMs || ttlSeconds * 1000 <= deadlineAtMs - startedAtMs) {
      throw repositoryError(
        'SOCIAL_PRODUCER_LEASE_TTL_INVALID',
        'Social producer lease TTL must be longer than the bounded run budget.',
      );
    }
    const token = requiredText(createToken(), 'lease token');
    const acquiredAt = clock();
    const acquiredAtIso = acquiredAt instanceof Date
      ? acquiredAt.toISOString()
      : new Date(acquiredAt).toISOString();
    const leaseRecord = {
      schema_version: SOCIAL_PRODUCER_LEASE_SCHEMA_VERSION,
      record_type: SOCIAL_PRODUCER_LEASE_RECORD_TYPE,
      lease: {
        token,
        run_id: runId,
        owner_pid: process.pid,
        acquired_at: acquiredAtIso,
        started_at: new Date(startedAtMs).toISOString(),
        deadline_at: new Date(deadlineAtMs).toISOString(),
        ttl_seconds: ttlSeconds,
      },
    };
    const fenceValue = encodeValue(leaseRecord);
    const initialStatus = validateStatus({
      component: 'social-owner-review-producer',
      run_id: runId,
      started_at: new Date(startedAtMs).toISOString(),
      deadline_at: new Date(deadlineAtMs).toISOString(),
      updated_at: acquiredAtIso,
      stage: 'lease-acquired',
      status: 'acquired',
      created_count: 0,
      blocked_count: 0,
      published: false,
      sequence: 0,
    });
    const result = await boundedCall(
      'EVAL',
      encodeURIComponent(ACQUIRE_SCRIPT),
      '2',
      encodeURIComponent(leaseKey),
      encodeURIComponent(statusKey),
      fenceValue,
      String(ttlSeconds),
      encodeValue(statusEnvelope(initialStatus)),
    );
    if (Number(result) !== 1) return { acquired: false };

    const lease = {
      acquired: true,
      key: leaseKey,
      token,
      run_id: runId,
      ttl_seconds: ttlSeconds,
      fence_value: fenceValue,
      released: false,
      lost: false,
      heartbeat: null,
    };
    const heartbeatIntervalMs = Math.min(
      MAX_HEARTBEAT_INTERVAL_MS,
      Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(ttlSeconds * 1000 / 3)),
    );
    lease.heartbeat = setInterval(() => {
      renew(lease).catch(() => {
        markLeaseLost(lease);
      });
    }, heartbeatIntervalMs);
    lease.heartbeat.unref?.();
    return lease;
  };

  const release = async lease => {
    if (!lease?.acquired || lease.released) return false;
    if (lease.heartbeat) clearInterval(lease.heartbeat);
    lease.heartbeat = null;
    const released = await boundedCall(
      'EVAL',
      encodeURIComponent(RELEASE_SCRIPT),
      '1',
      encodeURIComponent(leaseKey),
      lease.fence_value,
    );
    lease.released = Number(released) === 1;
    if (!lease.released) markLeaseLost(lease);
    return lease.released;
  };

  const writeStatus = async (value, lease) => {
    const status = validateStatus(value);
    if (!lease?.acquired || lease.released || lease.lost || status.run_id !== lease.run_id) {
      throw repositoryError(
        'SOCIAL_PRODUCER_LEASE_LOST',
        'Social producer status write rejected because exact lease ownership is missing.',
      );
    }
    const committed = await boundedCall(
      'EVAL',
      encodeURIComponent(WRITE_STATUS_SCRIPT),
      '2',
      encodeURIComponent(leaseKey),
      encodeURIComponent(statusKey),
      lease.fence_value,
      encodeValue(statusEnvelope(status)),
      String(status.sequence),
    );
    if (Number(committed) === -2) {
      throw repositoryError(
        'SOCIAL_PRODUCER_STATUS_CORRUPT',
        'Social producer status record is corrupt.',
      );
    }
    if (Number(committed) === -1) {
      throw repositoryError(
        'SOCIAL_PRODUCER_STATUS_TRANSITION_REJECTED',
        'Social producer status write rejected because it was stale or followed a terminal status.',
      );
    }
    if (Number(committed) !== 1) {
      markLeaseLost(lease);
      throw repositoryError(
        'SOCIAL_PRODUCER_LEASE_LOST',
        'Social producer status write rejected after lease ownership was lost.',
      );
    }
    return status;
  };

  const readStatus = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rawStatus = await boundedCall('GET', statusKey);
      if (!rawStatus) return null;
      const status = decodeStatusEnvelope(rawStatus);
      if (!['acquired', 'running'].includes(status.status)) return status;

      const rawLease = await boundedCall('GET', leaseKey);
      if (rawLease) {
        const lease = decodeLeaseEnvelope(rawLease);
        if (lease.run_id === status.run_id) return status;
        continue;
      }

      const now = clock();
      const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
      const staleStatus = validateStatus({
        ...status,
        stage: 'lease-expired',
        status: 'stale',
        updated_at: nowIso,
        finished_at: nowIso,
        error: {
          code: 'SOCIAL_PRODUCER_LEASE_EXPIRED',
          message: 'Producer process exited or lost its lease before terminal status was persisted.',
        },
        sequence: status.sequence + 1,
      });
      const marked = await boundedCall(
        'EVAL',
        encodeURIComponent(MARK_STALE_STATUS_SCRIPT),
        '2',
        encodeURIComponent(leaseKey),
        encodeURIComponent(statusKey),
        encodeURIComponent(String(rawStatus)),
        encodeValue(statusEnvelope(staleStatus)),
      );
      if (Number(marked) === 1) return staleStatus;
    }
    return decodeStatusEnvelope(await boundedCall('GET', statusKey));
  };

  return {
    lease: { acquire, renew, assertOwned, release },
    status: { write: writeStatus, read: readStatus },
    keys: { lease: leaseKey, status: statusKey },
  };
}
