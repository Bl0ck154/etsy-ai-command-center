export const ETSY_REVIEW_RESPONSE_SCHEMA_VERSION = 1;
export const ETSY_REVIEW_RESPONSE_RECORD_TYPE = 'etsy_review_response_store';

const MISSING_VALUE = '__etsy_review_response_missing__';
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

function decodeValue(raw) {
  if (raw === null || raw === undefined) {
    return { ids: [], legacy: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(decodeURIComponent(String(raw)));
  } catch {
    throw repositoryError('REVIEW_RESPONSE_STORE_INVALID', 'Responded-review state is not valid JSON');
  }

  if (Array.isArray(parsed)) return { ids: parsed, legacy: true };
  if (!parsed || typeof parsed !== 'object'
    || parsed.schema_version !== ETSY_REVIEW_RESPONSE_SCHEMA_VERSION
    || parsed.record_type !== ETSY_REVIEW_RESPONSE_RECORD_TYPE
    || !Array.isArray(parsed.responded_transaction_ids)) {
    throw repositoryError('REVIEW_RESPONSE_STORE_UNSUPPORTED', 'Responded-review state has an unsupported schema');
  }
  return { ids: parsed.responded_transaction_ids, legacy: false };
}

function encodeEnvelope(ids) {
  return encodeURIComponent(JSON.stringify({
    schema_version: ETSY_REVIEW_RESPONSE_SCHEMA_VERSION,
    record_type: ETSY_REVIEW_RESPONSE_RECORD_TYPE,
    responded_transaction_ids: ids,
  }));
}

export function createEtsyReviewResponseRepository({
  callKv,
  shopId = 'default',
  maxAttempts = 20,
} = {}) {
  if (typeof callKv !== 'function') throw new TypeError('callKv dependency is required');
  const key = `${String(shopId || 'default')}:reviews:responded`;
  const attempts = Math.max(1, Math.min(100, Number(maxAttempts) || 20));

  const commit = async (expectedRaw, ids) => Number(await callKv(
    'EVAL',
    encodeURIComponent(CAS_REPLACE_SCRIPT),
    '1',
    encodeURIComponent(key),
    encodeURIComponent(expectedRaw === null || expectedRaw === undefined ? MISSING_VALUE : String(expectedRaw)),
    encodeURIComponent(encodeEnvelope(ids)),
  )) === 1;

  const transact = async (mutate, { migrateLegacy = true } = {}) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const raw = await callKv('GET', encodeURIComponent(key));
      const current = decodeValue(raw);
      const mutation = mutate([...current.ids]);
      const nextIds = Array.isArray(mutation?.ids) ? mutation.ids : current.ids;
      const needsWrite = mutation?.changed === true || (migrateLegacy && current.legacy);
      if (!needsWrite) return { ids: [...current.ids], changed: false, migrated: false };
      if (await commit(raw, nextIds)) {
        return {
          ids: [...nextIds],
          changed: mutation?.changed === true,
          migrated: current.legacy,
        };
      }
    }
    throw repositoryError(
      'REVIEW_RESPONSE_CONCURRENT_UPDATE',
      `Responded-review state changed during ${attempts} consecutive commit attempts`,
    );
  };

  const read = async () => {
    const result = await transact(ids => ({ ids, changed: false }));
    return result.ids;
  };

  const markResponded = transactionId => transact(ids => {
    if (ids.includes(transactionId)) return { ids, changed: false };
    return { ids: [...ids, transactionId], changed: true };
  });

  const unmarkResponded = transactionId => transact(ids => {
    const next = ids.filter(id => id !== transactionId);
    return { ids: next, changed: next.length !== ids.length };
  });

  return {
    key,
    read,
    markResponded,
    unmarkResponded,
  };
}
