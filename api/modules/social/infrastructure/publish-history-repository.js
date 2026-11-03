const SOCIAL_PUBLISH_HISTORY_SCHEMA_VERSION = 1;
const SOCIAL_PUBLISH_HISTORY_RECORD_TYPE = 'social_publish_history';

const MIGRATE_PUBLISH_HISTORY_SCRIPT = `
local values = redis.call('LRANGE', KEYS[1], 0, -1)
local changed = 0
for index, value in ipairs(values) do
  for argument = 1, #ARGV, 2 do
    if value == ARGV[argument] then
      redis.call('LSET', KEYS[1], index - 1, ARGV[argument + 1])
      changed = changed + 1
      break
    end
  end
end
return changed
`.trim();

function publishHistorySchemaError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 500;
  error.retryable = false;
  return error;
}

function serializeSocialPublishHistoryRecord(record) {
  return JSON.stringify({
    schema_version: SOCIAL_PUBLISH_HISTORY_SCHEMA_VERSION,
    record_type: SOCIAL_PUBLISH_HISTORY_RECORD_TYPE,
    record,
  });
}

export function encodeSocialPublishHistoryRecord(record) {
  return encodeURIComponent(serializeSocialPublishHistoryRecord(record));
}

export function decodeSocialPublishHistoryRecord(raw) {
  let parsed;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return { record: null, legacy: false };
  }

  if (Object.prototype.hasOwnProperty.call(parsed || {}, 'schema_version')) {
    if (parsed.schema_version !== SOCIAL_PUBLISH_HISTORY_SCHEMA_VERSION) {
      throw publishHistorySchemaError(
        `Unsupported Social publish history schema version: ${parsed.schema_version}`,
        'SOCIAL_PUBLISH_HISTORY_SCHEMA_UNSUPPORTED',
      );
    }
    if (
      parsed.record_type !== SOCIAL_PUBLISH_HISTORY_RECORD_TYPE
      || !parsed.record
      || typeof parsed.record !== 'object'
      || Array.isArray(parsed.record)
    ) {
      throw publishHistorySchemaError(
        'Invalid Social publish history schema envelope.',
        'SOCIAL_PUBLISH_HISTORY_SCHEMA_INVALID',
      );
    }
    return { record: parsed.record, legacy: false };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { record: null, legacy: false };
  }
  return { record: parsed, legacy: true };
}

export function createSocialPublishHistoryRepository({ callKv, shopId = 'default' } = {}) {
  if (typeof callKv !== 'function') throw new TypeError('callKv is required');
  const key = `${shopId}:posts:history`;

  return {
    async append(record) {
      await callKv('LPUSH', key, encodeSocialPublishHistoryRecord(record));
      await callKv('LTRIM', key, '0', '499');
    },

    async list() {
      const rawRecords = await callKv('LRANGE', key, '0', '-1');
      const decoded = (rawRecords || []).map(raw => ({
        raw,
        ...decodeSocialPublishHistoryRecord(raw),
      }));
      const migrations = decoded
        .filter(item => item.legacy && item.record)
        .flatMap(item => [
          encodeURIComponent(item.raw),
          encodeURIComponent(serializeSocialPublishHistoryRecord(item.record)),
        ]);
      if (migrations.length) {
        await callKv(
          'EVAL',
          encodeURIComponent(MIGRATE_PUBLISH_HISTORY_SCRIPT),
          '1',
          encodeURIComponent(key),
          ...migrations,
        );
      }
      return decoded.map(item => item.record).filter(Boolean);
    },
  };
}

export {
  SOCIAL_PUBLISH_HISTORY_RECORD_TYPE,
  SOCIAL_PUBLISH_HISTORY_SCHEMA_VERSION,
};
