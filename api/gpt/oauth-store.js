import crypto from 'node:crypto';

import { createGptOAuthRepository } from '../modules/gpt/infrastructure/oauth-repository.js';

export const GPT_SCOPES = Object.freeze([
  'gpt:read',
  'financial:read',
  'shop:write',
  'listings:write',
  'listings:publish',
  'listings:delete',
  'files:write',
  'orders:write',
  'discounts:write',
]);

const DEFAULT_ACCESS_TTL = 60 * 60;
const DEFAULT_REFRESH_TTL = 60 * 60 * 24 * 30;
const DEFAULT_CODE_TTL = 5 * 60;

function oauthError(message, code = 'invalid_grant', status = 400) {
  const err = new Error(message);
  err.oauthCode = code;
  err.status = status;
  return err;
}

function boundedSeconds(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : fallback;
}

function hashSecret() {
  const value = String(process.env.GPT_OAUTH_TOKEN_HASH_SECRET || process.env.SESSION_SECRET || '');
  if (!value) throw oauthError('GPT OAuth token hashing is not configured', 'server_error', 503);
  return value;
}

export function hashOAuthSecret(value) {
  return crypto.createHmac('sha256', hashSecret()).update(String(value || '')).digest('hex');
}

const oauthRepository = createGptOAuthRepository();

function cleanup(store, now = Date.now()) {
  let changed = false;
  for (const [key, record] of Object.entries(store.codes)) {
    if (Number(record.expires_at) <= now || record.used_at) {
      delete store.codes[key];
      changed = true;
    }
  }
  for (const [key, record] of Object.entries(store.access_tokens)) {
    if (Number(record.expires_at) <= now) {
      delete store.access_tokens[key];
      changed = true;
    }
  }
  // Used refresh-token tombstones remain until their natural expiry so replay
  // can revoke the entire rotation family.
  for (const [key, record] of Object.entries(store.refresh_tokens)) {
    if (Number(record.expires_at) <= now) {
      delete store.refresh_tokens[key];
      changed = true;
    }
  }
  for (const [familyId, family] of Object.entries(store.families)) {
    if (Number(family.expires_at) <= now) {
      delete store.families[familyId];
      changed = true;
    }
  }
  return changed;
}

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

export function scopesForUser(user) {
  if (user?.role === 'owner') return [...GPT_SCOPES];
  const configured = Array.isArray(user?.scopes) ? user.scopes.filter(scope => GPT_SCOPES.includes(scope)) : [];
  if (configured.length) return [...new Set(configured)];
  if (user?.role === 'editor') return ['gpt:read', 'listings:write', 'files:write'];
  return ['gpt:read'];
}

export function normalizeRequestedScopes(scopeValue, user) {
  const requested = [...new Set(String(scopeValue || 'gpt:read').split(/\s+/).map(value => value.trim()).filter(Boolean))];
  const unknown = requested.filter(scope => !GPT_SCOPES.includes(scope));
  if (unknown.length) throw oauthError(`Unknown scope: ${unknown[0]}`, 'invalid_scope');
  const allowed = new Set(scopesForUser(user));
  const granted = requested.filter(scope => allowed.has(scope));
  if (!granted.length) throw oauthError('The user is not allowed any requested scope', 'access_denied', 403);
  return granted;
}

export function createAuthorizationCode({ clientId, redirectUri, user, scopes, codeChallenge = '', codeChallengeMethod = '' }) {
  const code = randomToken('gptc');
  oauthRepository.transact(store => {
    cleanup(store);
    const now = Date.now();
    store.codes[hashOAuthSecret(code)] = {
      client_id: clientId,
      redirect_uri: redirectUri,
      user_id: user.id,
      user_name: user.name,
      role: user.role,
      scopes,
      code_challenge: codeChallenge || '',
      code_challenge_method: codeChallengeMethod || '',
      created_at: now,
      expires_at: now + boundedSeconds('GPT_OAUTH_CODE_TTL_SECONDS', DEFAULT_CODE_TTL, 60, 600) * 1000,
    };
    return { write: true, value: null };
  });
  return code;
}

function verifyPkce(record, verifier) {
  if (!record.code_challenge) return;
  if (!verifier) throw oauthError('code_verifier is required');
  const method = record.code_challenge_method || 'plain';
  const actual = method === 'S256'
    ? crypto.createHash('sha256').update(String(verifier)).digest('base64url')
    : String(verifier);
  const left = Buffer.from(actual);
  const right = Buffer.from(String(record.code_challenge));
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw oauthError('Invalid code_verifier');
  }
}

function issueTokenPair(store, record, familyId = crypto.randomUUID()) {
  const accessToken = randomToken('gpta');
  const refreshToken = randomToken('gptr');
  const accessTtl = boundedSeconds('GPT_OAUTH_ACCESS_TTL_SECONDS', DEFAULT_ACCESS_TTL, 300, 86400);
  const refreshTtl = boundedSeconds('GPT_OAUTH_REFRESH_TTL_SECONDS', DEFAULT_REFRESH_TTL, 3600, 60 * 60 * 24 * 180);
  const now = Date.now();
  const refreshExpiresAt = now + refreshTtl * 1000;
  const common = {
    client_id: record.client_id,
    user_id: record.user_id,
    user_name: record.user_name,
    role: record.role,
    scopes: record.scopes,
    family_id: familyId,
    created_at: now,
  };
  const currentFamily = store.families[familyId];
  store.families[familyId] = {
    ...(currentFamily || {}),
    created_at: Number.isFinite(Number(currentFamily?.created_at))
      ? Number(currentFamily.created_at)
      : now,
    expires_at: Math.max(
      Number.isFinite(Number(currentFamily?.expires_at)) ? Number(currentFamily.expires_at) : 0,
      refreshExpiresAt,
    ),
  };
  store.access_tokens[hashOAuthSecret(accessToken)] = { ...common, expires_at: now + accessTtl * 1000 };
  store.refresh_tokens[hashOAuthSecret(refreshToken)] = { ...common, expires_at: refreshExpiresAt };
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: accessTtl,
    refresh_token: refreshToken,
    scope: record.scopes.join(' '),
  };
}

export function exchangeAuthorizationCode({ code, clientId, redirectUri, codeVerifier = '' }) {
  const outcome = oauthRepository.transact(store => {
    const cleaned = cleanup(store);
    const key = hashOAuthSecret(code);
    const record = store.codes[key];
    if (!record || record.used_at) {
      return { write: cleaned, value: { error: oauthError('Authorization code is invalid or expired') } };
    }
    // Consume before validating the binding. A stolen code cannot probe redirect
    // URIs or PKCE verifiers repeatedly, even when another process races it.
    record.used_at = Date.now();
    if (record.client_id !== clientId || record.redirect_uri !== redirectUri) {
      return { write: true, value: { error: oauthError('Authorization code binding mismatch') } };
    }
    try {
      verifyPkce(record, codeVerifier);
    } catch (error) {
      return { write: true, value: { error } };
    }
    return { write: true, value: { pair: issueTokenPair(store, record) } };
  });
  if (outcome.error) throw outcome.error;
  return outcome.pair;
}

function revokeFamily(store, familyId, reason) {
  if (!familyId) return;
  const now = Date.now();
  const current = store.families[familyId];
  const relatedRefreshExpiries = Object.values(store.refresh_tokens)
    .filter(record => record.family_id === familyId)
    .map(record => Number(record.expires_at))
    .filter(Number.isFinite);
  store.families[familyId] = {
    ...(current || {}),
    created_at: Number.isFinite(Number(current?.created_at))
      ? Number(current.created_at)
      : now,
    expires_at: Math.max(
      Number.isFinite(Number(current?.expires_at)) ? Number(current.expires_at) : 0,
      ...relatedRefreshExpiries,
      now,
    ),
    revoked_at: now,
    revoke_reason: reason,
  };
  for (const [key, record] of Object.entries(store.access_tokens)) {
    if (record.family_id === familyId) delete store.access_tokens[key];
  }
}

export function rotateRefreshToken({ refreshToken, clientId }) {
  const outcome = oauthRepository.transact(store => {
    const cleaned = cleanup(store);
    const record = store.refresh_tokens[hashOAuthSecret(refreshToken)];
    if (!record || record.client_id !== clientId) {
      return { write: cleaned, value: { error: oauthError('Refresh token is invalid or expired') } };
    }
    if (record.used_at || store.families[record.family_id]?.revoked_at) {
      revokeFamily(store, record.family_id, 'refresh_token_replay');
      return { write: true, value: { error: oauthError('Refresh token reuse detected') } };
    }
    record.used_at = Date.now();
    return { write: true, value: { pair: issueTokenPair(store, record, record.family_id) } };
  });
  if (outcome.error) throw outcome.error;
  return outcome.pair;
}

export function resolveAccessToken(accessToken) {
  if (!accessToken) return null;
  return oauthRepository.transact(store => {
    const cleaned = cleanup(store);
    const record = store.access_tokens[hashOAuthSecret(accessToken)];
    const value = !record || store.families[record.family_id]?.revoked_at ? null : {
      clientId: record.client_id,
      user: { id: record.user_id, name: record.user_name, role: record.role, scopes: record.scopes },
      scopes: record.scopes,
      expiresAt: record.expires_at,
    };
    return { write: cleaned, value };
  });
}

export function revokeOAuthToken({ token, clientId }) {
  oauthRepository.transact(store => {
    cleanup(store);
    const key = hashOAuthSecret(token);
    const refresh = store.refresh_tokens[key];
    if (refresh?.client_id === clientId) revokeFamily(store, refresh.family_id, 'client_revocation');
    const access = store.access_tokens[key];
    if (access?.client_id === clientId) delete store.access_tokens[key];
    return { write: true, value: null };
  });
}

export function resetOAuthStoreForTests() {
  oauthRepository.resetForTests();
}

export function validateOAuthStore() {
  return oauthRepository.validate();
}
