import { configuredAuthUsers } from '../_auth.js';
import { writeSecurityAudit } from '../_security-audit.js';
import { getOAuthConfig } from './oauth-config.js';
import { resolveAccessToken, scopesForUser } from './oauth-store.js';

function bearerValue(req) {
  const header = String(req?.headers?.authorization || req?.headers?.Authorization || '');
  const match = /^Bearer\s+([A-Za-z0-9._~-]+)$/i.exec(header);
  return match ? match[1] : '';
}

function safeAuditText(value, limit = 120) {
  return String(value || '').replace(/[^a-zA-Z0-9_.:@/-]+/g, '_').slice(0, limit);
}

function audit(req, event, details = {}) {
  writeSecurityAudit(req, event, Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, safeAuditText(value)]),
  ));
}

function currentUser(userId) {
  const configured = configuredAuthUsers();
  if (configured.length) {
    const user = configured.find(candidate => candidate.id === userId && !candidate.disabled);
    return user ? { id: user.id, name: user.name, role: user.role, scopes: user.scopes } : null;
  }
  if (userId === 'owner' && process.env.SITE_PASSWORD) {
    return { id: 'owner', name: 'Owner', role: 'owner', scopes: [] };
  }
  if (userId === 'local-dev' && process.env.NODE_ENV !== 'production') {
    return { id: 'local-dev', name: 'Local development', role: 'owner', scopes: [] };
  }
  return null;
}

function sendBearerError(req, res, status, code, description, requiredScope = '') {
  const challenge = [
    'Bearer realm="Etsy AI Command Center GPT Actions"',
    `error="${code}"`,
    `error_description="${String(description).replace(/["\\]/g, '')}"`,
    ...(requiredScope ? [`scope="${String(requiredScope).replace(/["\\]/g, '')}"`] : []),
  ].join(', ');
  res.setHeader('WWW-Authenticate', challenge);
  res.setHeader('Cache-Control', 'no-store');
  audit(req, code === 'insufficient_scope' ? 'gpt.oauth.scope.denied' : 'gpt.oauth.bearer.denied', {
    error: code,
    required_scope: requiredScope,
  });
  res.status(status).json({ error: code, error_description: description });
  return false;
}

export function authenticateGptBearer(req, res) {
  const token = bearerValue(req);
  if (!token) return sendBearerError(req, res, 401, 'invalid_token', 'A valid Bearer access token is required');

  let record;
  let config;
  try {
    record = resolveAccessToken(token);
    config = getOAuthConfig();
  } catch (err) {
    const status = Number(err?.status) || 503;
    res.setHeader('Cache-Control', 'no-store');
    audit(req, 'gpt.oauth.bearer.unavailable', { error: err?.oauthCode || 'server_error' });
    res.status(status).json({ error: 'temporarily_unavailable', error_description: 'GPT OAuth validation is unavailable' });
    return false;
  }
  if (!record || record.clientId !== config.clientId) {
    return sendBearerError(req, res, 401, 'invalid_token', 'The access token is invalid, expired, or revoked');
  }

  const user = currentUser(record.user?.id);
  if (!user) return sendBearerError(req, res, 401, 'invalid_token', 'The token owner is disabled or no longer exists');

  // Re-evaluate authorization on every request. Existing tokens immediately lose
  // permissions removed from AUTH_USERS_B64 or the OAuth client configuration.
  const currentAllowed = new Set(scopesForUser(user));
  const clientAllowed = new Set(config.allowedScopes);
  const scopes = record.scopes.filter(scope => currentAllowed.has(scope) && clientAllowed.has(scope));
  if (!scopes.length) return sendBearerError(req, res, 401, 'invalid_token', 'The access token no longer grants an active scope');

  req.auth = {
    kind: 'gpt_oauth',
    user,
    clientId: record.clientId,
    scopes,
    oauth: {
      client_id: record.clientId,
      scopes,
      expires_at: record.expiresAt,
    },
  };
  return true;
}

export function requireGptAuth(req, res) {
  return authenticateGptBearer(req, res);
}

export function requireGptScope(req, res, ...requiredScopes) {
  if (!req.auth || req.auth.kind !== 'gpt_oauth') {
    if (!authenticateGptBearer(req, res)) return false;
  }
  const required = requiredScopes.flat().map(scope => String(scope || '')).filter(Boolean);
  const granted = new Set(req.auth.scopes || []);
  const missing = required.filter(scope => !granted.has(scope));
  if (missing.length) {
    return sendBearerError(req, res, 403, 'insufficient_scope', `Missing required scope: ${missing[0]}`, missing.join(' '));
  }
  return true;
}

export function requireGptOAuth(req, res, next) {
  if (authenticateGptBearer(req, res)) next();
}

export function requireGptScopes(...requiredScopes) {
  return (req, res, next) => {
    if (requireGptScope(req, res, requiredScopes)) next();
  };
}
