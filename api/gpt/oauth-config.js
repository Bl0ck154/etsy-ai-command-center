import crypto from 'node:crypto';

import { GPT_SCOPES, scopesForUser } from './oauth-store.js';

const DEFAULT_ISSUER = 'https://dashboard.example.test';
const CONSENT_TTL_MS = 10 * 60 * 1000;

function configError(message) {
  const err = new Error(message);
  err.status = 503;
  err.oauthCode = 'server_error';
  return err;
}

export function oauthError(message, oauthCode = 'invalid_request', status = 400) {
  const err = new Error(message);
  err.status = status;
  err.oauthCode = oauthCode;
  return err;
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''), 'utf8');
  const right = Buffer.from(String(rightValue || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function exactHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw configError(`${label} must be an absolute URL`);
  }
  const localHttp = process.env.NODE_ENV !== 'production'
    && parsed.protocol === 'http:'
    && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) throw configError(`${label} must use HTTPS`);
  if (parsed.username || parsed.password || parsed.hash) throw configError(`${label} must not contain credentials or a fragment`);
  return parsed.toString();
}

function parseAllowedScopes(raw) {
  const values = String(raw || GPT_SCOPES.join(' '))
    .split(/[\s,]+/)
    .map(value => value.trim())
    .filter(Boolean);
  const unknown = values.filter(scope => !GPT_SCOPES.includes(scope));
  if (unknown.length) throw configError(`Unknown GPT OAuth scope in configuration: ${unknown[0]}`);
  return [...new Set(values)];
}

export function getOAuthConfig() {
  const clientId = String(process.env.GPT_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GPT_OAUTH_CLIENT_SECRET || '');
  if (!clientId || !clientSecret) throw configError('GPT OAuth client credentials are not configured');
  if (clientSecret.length < 24) throw configError('GPT OAuth client secret must contain at least 24 characters');

  const redirectUris = String(process.env.GPT_OAUTH_REDIRECT_URIS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => exactHttpsUrl(value, 'GPT OAuth redirect URI'));
  if (!redirectUris.length) throw configError('GPT OAuth redirect URI allowlist is not configured');

  const issuerUrl = new URL(exactHttpsUrl(process.env.GPT_OAUTH_ISSUER || DEFAULT_ISSUER, 'GPT OAuth issuer'));
  if (issuerUrl.pathname !== '/' || issuerUrl.search) throw configError('GPT OAuth issuer must be an origin without a path or query');
  const issuer = issuerUrl.origin;
  return {
    clientId,
    clientSecret,
    redirectUris,
    issuer,
    allowedScopes: parseAllowedScopes(process.env.GPT_OAUTH_ALLOWED_SCOPES),
  };
}

function authorizationValues(input = {}) {
  return {
    responseType: String(input.response_type || ''),
    clientId: String(input.client_id || ''),
    redirectUri: String(input.redirect_uri || ''),
    state: String(input.state || ''),
    scope: String(input.scope || 'gpt:read'),
    codeChallenge: String(input.code_challenge || ''),
    codeChallengeMethod: String(input.code_challenge_method || ''),
  };
}

export function validateAuthorizationRequest(input, user = null) {
  const request = authorizationValues(input);
  const config = getOAuthConfig();
  if (request.responseType !== 'code') throw oauthError('response_type must be code', 'unsupported_response_type');
  if (!safeEqual(request.clientId, config.clientId)) throw oauthError('Unknown OAuth client', 'unauthorized_client');
  if (!config.redirectUris.includes(request.redirectUri)) throw oauthError('redirect_uri is not allowlisted');
  if (!request.state || request.state.length > 1024) throw oauthError('A valid state value is required');
  if (request.codeChallengeMethod && request.codeChallengeMethod !== 'S256') {
    throw oauthError('Only PKCE S256 is supported');
  }
  if (request.codeChallenge && request.codeChallengeMethod !== 'S256') {
    throw oauthError('code_challenge_method=S256 is required when PKCE is used');
  }
  if (!request.codeChallenge && request.codeChallengeMethod) throw oauthError('code_challenge is required');
  if (request.codeChallenge && !/^[A-Za-z0-9_-]{43,128}$/.test(request.codeChallenge)) {
    throw oauthError('Invalid PKCE code_challenge');
  }

  const requestedScopes = [...new Set(request.scope.split(/\s+/).filter(Boolean))];
  if (!requestedScopes.length) requestedScopes.push('gpt:read');
  const unknown = requestedScopes.filter(scope => !GPT_SCOPES.includes(scope));
  if (unknown.length) throw oauthError(`Unknown scope: ${unknown[0]}`, 'invalid_scope');
  const clientAllowed = new Set(config.allowedScopes);
  if (requestedScopes.some(scope => !clientAllowed.has(scope))) {
    throw oauthError('The client is not allowed one or more requested scopes', 'invalid_scope');
  }
  if (user) {
    const userAllowed = new Set(scopesForUser(user));
    if (requestedScopes.some(scope => !userAllowed.has(scope))) {
      throw oauthError('The user is not allowed one or more requested scopes', 'access_denied', 403);
    }
  }
  return { ...request, scopes: requestedScopes };
}

function parseBasicAuthorization(headerValue) {
  const match = /^Basic\s+([^\s]+)$/i.exec(String(headerValue || ''));
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return { clientId: '', clientSecret: '' };
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return { clientId: '', clientSecret: '' };
  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };
}

export function authenticateOAuthClient(req) {
  const config = getOAuthConfig();
  const authorization = req?.headers?.authorization || req?.headers?.Authorization || '';
  const basic = parseBasicAuthorization(authorization);
  if (authorization && !basic) throw oauthError('Unsupported OAuth client authentication method', 'invalid_client', 401);
  const formPresent = req?.body?.client_id !== undefined || req?.body?.client_secret !== undefined;
  const form = formPresent ? {
    clientId: String(req.body.client_id || ''),
    clientSecret: String(req.body.client_secret || ''),
  } : null;
  if (basic && form && (!safeEqual(basic.clientId, form.clientId) || !safeEqual(basic.clientSecret, form.clientSecret))) {
    throw oauthError('Conflicting OAuth client credentials', 'invalid_client', 401);
  }
  const supplied = basic || form;
  if (!supplied
    || !safeEqual(supplied.clientId, config.clientId)
    || !safeEqual(supplied.clientSecret, config.clientSecret)) {
    throw oauthError('Invalid OAuth client credentials', 'invalid_client', 401);
  }
  return { clientId: config.clientId };
}

function consentSecret() {
  const value = String(process.env.GPT_OAUTH_CONSENT_SECRET || process.env.SESSION_SECRET || '');
  if (!value) throw configError('GPT OAuth consent signing is not configured');
  return value;
}

function signConsentPayload(encoded) {
  return crypto.createHmac('sha256', consentSecret()).update(encoded).digest('base64url');
}

export function createConsentTransaction(request, userId = '') {
  const payload = {
    v: 1,
    exp: Date.now() + CONSENT_TTL_MS,
    nonce: crypto.randomBytes(16).toString('base64url'),
    user_id: String(userId || ''),
    request: {
      response_type: request.responseType,
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      state: request.state,
      scope: request.scopes.join(' '),
      code_challenge: request.codeChallenge,
      code_challenge_method: request.codeChallengeMethod,
    },
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signConsentPayload(encoded)}`;
}

export function verifyConsentTransaction(transaction) {
  const [encoded, signature, extra] = String(transaction || '').split('.');
  if (!encoded || !signature || extra !== undefined || !safeEqual(signature, signConsentPayload(encoded))) {
    throw oauthError('Authorization transaction is invalid or expired');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw oauthError('Authorization transaction is invalid or expired');
  }
  if (payload?.v !== 1 || Number(payload?.exp) <= Date.now() || !payload?.nonce || !payload?.request) {
    throw oauthError('Authorization transaction is invalid or expired');
  }
  return payload;
}

export function isSameOriginAuthorizationPost(req) {
  const expected = getOAuthConfig().issuer;
  const origin = String(req?.get?.('origin') || req?.headers?.origin || '').replace(/\/$/, '');
  if (origin) return safeEqual(origin, expected);
  const referer = String(req?.get?.('referer') || req?.headers?.referer || '');
  try {
    return safeEqual(new URL(referer).origin, expected);
  } catch {
    return false;
  }
}
