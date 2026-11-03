import { createRevisionedJsonRepository } from '../../../platform/persistence/revisioned-json-repository.js';

export const ETSY_REVISIONED_STATE_SCHEMA_VERSION = 1;
export const ETSY_REVISIONED_STATE_RECORD_TYPE = 'etsy_revisioned_state_store';

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function createEtsyRevisionedStateRepository({
  callKv,
  key,
  maxAttempts = 20,
} = {}) {
  const storageKey = String(key || '').trim();
  if (!storageKey) throw new TypeError('key is required');
  return createRevisionedJsonRepository({
    callKv,
    key: storageKey,
    recordType: ETSY_REVISIONED_STATE_RECORD_TYPE,
    schemaVersion: ETSY_REVISIONED_STATE_SCHEMA_VERSION,
    maxAttempts,
    validateState: plainObject,
  });
}
