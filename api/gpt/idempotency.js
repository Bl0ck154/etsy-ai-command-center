import crypto from 'node:crypto';

import { createGptIdempotencyRepository } from '../modules/gpt/infrastructure/idempotency-repository.js';

const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

function storeFile() {
  return process.env.GPT_IDEMPOTENCY_STORE_FILE;
}

function secret() {
  return String(process.env.GPT_OAUTH_TOKEN_HASH_SECRET || process.env.SESSION_SECRET || 'gpt-idempotency-local');
}

function digest(value) {
  return crypto.createHmac('sha256', secret()).update(String(value)).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function fingerprint(req) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical({
    method: req.method,
    path: req.path,
    query: req.query || {},
    body: req.body || {},
  }))).digest('hex');
}

function idempotencyError(message, code) {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

const repository = createGptIdempotencyRepository({
  file: () => storeFile(),
});

export function validateIdempotencyStore() {
  return repository.validate();
}

export function claimIdempotency(req, operationId, consequential) {
  const key = String(req.body?.idempotency_key || '').trim();
  if (!key) return null;
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    const error = new Error('idempotency_key must contain 8 to 128 safe characters');
    error.status = 400;
    error.code = 'INVALID_IDEMPOTENCY_KEY';
    throw error;
  }
  const now = Date.now();
  const recordKey = digest(`${req.auth?.user?.id || 'anonymous'}\n${operationId}\n${key}`);
  const requestFingerprint = fingerprint(req);
  return repository.transact(store => {
    for (const [storedKey, record] of Object.entries(store.records)) {
      if (Number(record.expires_at) <= now) delete store.records[storedKey];
    }
    const existing = store.records[recordKey];
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw idempotencyError('idempotency_key was already used for a different request', 'IDEMPOTENCY_CONFLICT');
      }
      if (existing.status === 'completed') {
        return {
          write: false,
          value: { recordKey, fingerprint: requestFingerprint, cached: true, data: existing.data },
        };
      }
      throw idempotencyError(
        existing.consequential
          ? 'A previous consequential request with this key has an unresolved or failed outcome; inspect the resource before retrying'
          : 'A request with this idempotency_key is already in progress',
        existing.consequential ? 'IDEMPOTENCY_OUTCOME_UNKNOWN' : 'IDEMPOTENCY_IN_PROGRESS',
      );
    }
    const claimToken = crypto.randomUUID();
    store.records[recordKey] = {
      operation_id: operationId,
      user_id: req.auth?.user?.id || 'anonymous',
      fingerprint: requestFingerprint,
      claim_token: claimToken,
      consequential: consequential === true,
      status: 'running',
      created_at: now,
      expires_at: now + RECORD_TTL_MS,
    };
    return {
      write: true,
      value: { recordKey, fingerprint: requestFingerprint, claimToken, cached: false },
    };
  });
}

export function completeIdempotency(claim, data) {
  if (!claim || claim.cached) return;
  repository.transact(store => {
    const record = store.records[claim.recordKey];
    if (
      !record
      || record.fingerprint !== claim.fingerprint
      || record.claim_token !== claim.claimToken
    ) return { write: false, value: undefined };
    store.records[claim.recordKey] = {
      ...record,
      status: 'completed',
      completed_at: Date.now(),
      data,
    };
    return { write: true, value: undefined };
  });
}

export function failIdempotency(claim, error, consequential) {
  if (!claim || claim.cached) return;
  repository.transact(store => {
    const record = store.records[claim.recordKey];
    if (
      !record
      || record.fingerprint !== claim.fingerprint
      || record.claim_token !== claim.claimToken
    ) return { write: false, value: undefined };
    if (consequential) {
      store.records[claim.recordKey] = {
        ...record,
        status: 'failed',
        failed_at: Date.now(),
        error_code: String(error?.code || 'OPERATION_FAILED').slice(0, 80),
      };
    } else {
      delete store.records[claim.recordKey];
    }
    return { write: true, value: undefined };
  });
}
