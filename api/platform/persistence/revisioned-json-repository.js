const MISSING_VALUE = '__revisioned_json_missing__';
const CAS_REPLACE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '${MISSING_VALUE}' then
  if current then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

function repositoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createRevisionedJsonRepository({
  callKv,
  key,
  recordType,
  schemaVersion = 1,
  maxAttempts = 20,
  validateState = plainObject,
} = {}) {
  if (typeof callKv !== 'function') throw new TypeError('callKv dependency is required');
  const storageKey = String(key || '').trim();
  const type = String(recordType || '').trim();
  const version = Number(schemaVersion);
  if (!storageKey) throw new TypeError('key is required');
  if (!type) throw new TypeError('recordType is required');
  if (!Number.isInteger(version) || version < 1) throw new TypeError('schemaVersion must be a positive integer');
  if (typeof validateState !== 'function') throw new TypeError('validateState dependency is required');
  const attempts = Math.max(1, Math.min(100, Number(maxAttempts) || 20));

  const decode = raw => {
    if (raw === null || raw === undefined) {
      return { state: {}, revision: 0, legacy: false, missing: true };
    }
    let parsed;
    try {
      parsed = JSON.parse(decodeURIComponent(String(raw)));
    } catch {
      throw repositoryError('REVISIONED_JSON_INVALID', `Stored ${type} value is not valid JSON`);
    }

    if (plainObject(parsed) && !Object.prototype.hasOwnProperty.call(parsed, 'schema_version')) {
      if (!validateState(parsed)) {
        throw repositoryError('REVISIONED_JSON_STATE_INVALID', `Legacy ${type} state is invalid`);
      }
      return { state: clone(parsed), revision: 0, legacy: true, missing: false };
    }

    if (!plainObject(parsed)
      || parsed.schema_version !== version
      || parsed.record_type !== type
      || !Number.isInteger(parsed.revision)
      || parsed.revision < 1
      || !validateState(parsed.state)) {
      throw repositoryError('REVISIONED_JSON_UNSUPPORTED', `Stored ${type} value has an unsupported schema`);
    }

    return {
      state: clone(parsed.state),
      revision: parsed.revision,
      legacy: false,
      missing: false,
    };
  };

  const encode = (state, revision) => encodeURIComponent(JSON.stringify({
    schema_version: version,
    record_type: type,
    revision,
    state,
  }));

  const commit = async (expectedRaw, state, revision) => Number(await callKv(
    'EVAL',
    encodeURIComponent(CAS_REPLACE_SCRIPT),
    '1',
    encodeURIComponent(storageKey),
    encodeURIComponent(expectedRaw === null || expectedRaw === undefined ? MISSING_VALUE : String(expectedRaw)),
    encodeURIComponent(encode(state, revision)),
  )) === 1;

  const transact = async (mutate, { migrateLegacy = true } = {}) => {
    if (typeof mutate !== 'function') throw new TypeError('mutate callback is required');
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const raw = await callKv('GET', encodeURIComponent(storageKey));
      const current = decode(raw);
      const mutation = await mutate(clone(current.state), {
        revision: current.revision,
        legacy: current.legacy,
        missing: current.missing,
      });
      const nextState = mutation?.state === undefined ? current.state : mutation.state;
      if (!validateState(nextState)) {
        throw repositoryError('REVISIONED_JSON_MUTATION_INVALID', `${type} mutation returned invalid state`);
      }
      const changed = mutation?.changed === true;
      const needsWrite = changed || (migrateLegacy && current.legacy);
      if (!needsWrite) {
        return {
          state: clone(current.state),
          revision: current.revision,
          changed: false,
          migrated: false,
        };
      }
      const nextRevision = current.revision + 1;
      if (await commit(raw, nextState, nextRevision)) {
        return {
          state: clone(nextState),
          revision: nextRevision,
          changed,
          migrated: current.legacy,
        };
      }
    }
    throw repositoryError(
      'REVISIONED_JSON_CONCURRENT_UPDATE',
      `${type} changed during ${attempts} consecutive commit attempts`,
    );
  };

  const readSnapshot = async ({ migrateLegacy = true } = {}) => transact(
    state => ({ state, changed: false }),
    { migrateLegacy },
  );

  const read = async options => (await readSnapshot(options)).state;

  const update = async mutate => transact(async (state, metadata) => {
    const nextState = await mutate(clone(state), metadata);
    if (nextState === undefined) return { state, changed: false };
    if (!validateState(nextState)) {
      throw repositoryError('REVISIONED_JSON_MUTATION_INVALID', `${type} update returned invalid state`);
    }
    return { state: nextState, changed: true };
  });

  const compareAndReplace = async (expectedRevision, nextState) => {
    const expected = Number(expectedRevision);
    if (!Number.isInteger(expected) || expected < 0 || !validateState(nextState)) {
      throw repositoryError('REVISIONED_JSON_REPLACE_INVALID', `${type} compare-and-replace input is invalid`);
    }
    return transact((state, metadata) => {
      if (metadata.revision !== expected) {
        throw repositoryError(
          'REVISIONED_JSON_REVISION_CONFLICT',
          `${type} revision changed from ${expected} to ${metadata.revision}`,
        );
      }
      return { state: clone(nextState), changed: true };
    }, { migrateLegacy: false });
  };

  return {
    key: storageKey,
    recordType: type,
    schemaVersion: version,
    read,
    readSnapshot,
    transact,
    update,
    compareAndReplace,
  };
}
