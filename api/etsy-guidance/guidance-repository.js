export const ETSY_GUIDANCE_STATE_SCHEMA_VERSION = 1;
export const ETSY_GUIDANCE_STATE_RECORD_TYPE = 'etsy_guidance_state';

const MISSING_VALUE = '__etsy_guidance_missing__';
const LEGACY_KEYS = Object.freeze({
  active: 'etsy_guidance:active',
  candidate: 'etsy_guidance:candidate',
  monitor: 'etsy_guidance:monitor',
  history: 'etsy_guidance:history',
});
const CAS_AND_MIRROR_SCRIPT = `#!lua flags=allow-key-locking
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '${MISSING_VALUE}' then
  if current then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[4], ARGV[5])
redis.call('SET', KEYS[5], ARGV[6])
return 1
`;

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validNullableObject(value) {
  return value === null || plainObject(value);
}

function validState(value) {
  return plainObject(value)
    && validNullableObject(value.active)
    && validNullableObject(value.candidate)
    && validNullableObject(value.monitor)
    && Array.isArray(value.history);
}

function normalizeState(value = {}) {
  return {
    active: plainObject(value.active) ? clone(value.active) : null,
    candidate: plainObject(value.candidate) ? clone(value.candidate) : null,
    monitor: plainObject(value.monitor) ? clone(value.monitor) : null,
    history: Array.isArray(value.history) ? clone(value.history.slice(0, 20)) : [],
  };
}

function decodeJson(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.parse(decodeURIComponent(String(raw)));
  } catch {
    return null;
  }
}

function encodeJson(value) {
  return encodeURIComponent(JSON.stringify(value));
}

function decodeAggregate(raw) {
  if (raw === null || raw === undefined) return null;
  const parsed = decodeJson(raw);
  if (!plainObject(parsed)
    || parsed.schema_version !== ETSY_GUIDANCE_STATE_SCHEMA_VERSION
    || parsed.record_type !== ETSY_GUIDANCE_STATE_RECORD_TYPE
    || !Number.isInteger(parsed.revision)
    || parsed.revision < 1
    || !validState(parsed.state)) {
    const error = new Error('Stored Etsy guidance state has an unsupported schema');
    error.code = 'ETSY_GUIDANCE_STATE_UNSUPPORTED';
    throw error;
  }
  return {
    state: normalizeState(parsed.state),
    revision: parsed.revision,
  };
}

function encodeAggregate(state, revision) {
  return encodeJson({
    schema_version: ETSY_GUIDANCE_STATE_SCHEMA_VERSION,
    record_type: ETSY_GUIDANCE_STATE_RECORD_TYPE,
    revision,
    state: normalizeState(state),
  });
}

export function createEtsyGuidanceRepository({
  callKv,
  shopId = 'default',
  maxAttempts = 20,
} = {}) {
  if (typeof callKv !== 'function') throw new TypeError('callKv dependency is required');
  const shop = String(shopId || 'default').trim() || 'default';
  const key = `${shop}:etsy_guidance:state`;
  const legacyStorageKeys = Object.fromEntries(
    Object.entries(LEGACY_KEYS).map(([name, legacyKey]) => [name, `${shop}:${legacyKey}`]),
  );
  const attempts = Math.max(1, Math.min(100, Number(maxAttempts) || 20));

  async function readLegacyState() {
    const entries = await Promise.all(Object.entries(legacyStorageKeys).map(async ([name, storageKey]) => {
      const raw = await callKv('GET', encodeURIComponent(storageKey));
      return [name, decodeJson(raw)];
    }));
    return normalizeState(Object.fromEntries(entries));
  }

  async function commit(expectedRaw, state, revision) {
    const aggregateRaw = encodeAggregate(state, revision);
    const expected = expectedRaw === null || expectedRaw === undefined
      ? MISSING_VALUE
      : String(expectedRaw);
    return Number(await callKv(
      'EVAL',
      encodeURIComponent(CAS_AND_MIRROR_SCRIPT),
      '5',
      encodeURIComponent(key),
      encodeURIComponent(legacyStorageKeys.active),
      encodeURIComponent(legacyStorageKeys.candidate),
      encodeURIComponent(legacyStorageKeys.monitor),
      encodeURIComponent(legacyStorageKeys.history),
      encodeURIComponent(expected),
      encodeURIComponent(aggregateRaw),
      encodeURIComponent(encodeJson(state.active)),
      encodeURIComponent(encodeJson(state.candidate)),
      encodeURIComponent(encodeJson(state.monitor)),
      encodeURIComponent(encodeJson(state.history)),
    )) === 1;
  }

  async function transact(mutate) {
    if (typeof mutate !== 'function') throw new TypeError('mutate callback is required');
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const raw = await callKv('GET', encodeURIComponent(key));
      const aggregate = decodeAggregate(raw);
      const state = aggregate ? aggregate.state : await readLegacyState();
      const revision = aggregate?.revision || 0;
      const next = await mutate(clone(state), {
        revision,
        missing: !aggregate,
      });
      const changed = next !== undefined;
      if (!changed && aggregate) {
        return { state: clone(state), revision, changed: false, migrated: false };
      }
      const nextState = normalizeState(changed ? next : state);
      if (!validState(nextState)) {
        const error = new Error('Etsy guidance mutation returned invalid state');
        error.code = 'ETSY_GUIDANCE_STATE_INVALID';
        throw error;
      }
      const nextRevision = revision + 1;
      if (await commit(raw, nextState, nextRevision)) {
        return {
          state: clone(nextState),
          revision: nextRevision,
          changed,
          migrated: !aggregate,
        };
      }
    }
    const error = new Error(`Etsy guidance state changed during ${attempts} consecutive commit attempts`);
    error.code = 'ETSY_GUIDANCE_STATE_CONCURRENT_UPDATE';
    throw error;
  }

  async function readSnapshot() {
    return transact(() => undefined);
  }

  async function read() {
    return (await readSnapshot()).state;
  }

  async function update(mutate) {
    return transact(async (state, metadata) => {
      const next = await mutate(clone(state), metadata);
      return next === undefined ? undefined : normalizeState(next);
    });
  }

  return {
    key,
    legacyStorageKeys,
    read,
    readSnapshot,
    update,
    transact,
    readLegacyState,
  };
}
