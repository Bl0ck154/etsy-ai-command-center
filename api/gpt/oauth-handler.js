import {
  authenticateUser,
  authenticatedUser,
  setSessionCookie,
} from '../_auth.js';
import { writeSecurityAudit } from '../_security-audit.js';
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  resolveAccessToken,
  revokeOAuthToken,
  rotateRefreshToken,
} from './oauth-store.js';
import {
  authenticateOAuthClient,
  createConsentTransaction,
  getOAuthConfig,
  isSameOriginAuthorizationPost,
  oauthError,
  validateAuthorizationRequest,
  verifyConsentTransaction,
} from './oauth-config.js';

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function safeAuditText(value, limit = 120) {
  return String(value || '').replace(/[^a-zA-Z0-9_.:/@-]+/g, '_').slice(0, limit);
}

function audit(req, event, details = {}) {
  writeSecurityAudit(req, event, Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, safeAuditText(value)]),
  ));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Etsy AI Command Center</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#f7f5f2; color:#25211d; }
    * { box-sizing:border-box; }
    body { min-height:100vh; margin:0; display:grid; place-items:center; padding:24px; }
    main { width:min(440px,100%); background:white; border:1px solid #ded8d0; border-radius:16px; padding:32px; box-shadow:0 16px 50px #3d2c1a14; }
    .brand { width:44px; height:44px; display:grid; place-items:center; border-radius:11px; background:#f1641e; color:white; font-size:22px; font-weight:800; }
    h1 { margin:18px 0 8px; font-size:24px; }
    p { color:#625c55; line-height:1.5; }
    label { display:block; margin:16px 0 6px; font-size:13px; font-weight:700; }
    input { width:100%; padding:11px 12px; border:1px solid #cfc7bd; border-radius:9px; font:inherit; }
    .error { padding:10px 12px; background:#fff0ed; color:#9f2e1e; border-radius:9px; }
    .scopes { margin:18px 0; padding:0; list-style:none; }
    .scopes li { margin:8px 0; padding:10px 12px; background:#f7f5f2; border-radius:9px; font-size:14px; }
    .actions { display:flex; gap:10px; margin-top:22px; }
    button { flex:1; border:0; border-radius:9px; padding:11px 14px; font:inherit; font-weight:700; cursor:pointer; }
    .primary { background:#f1641e; color:white; }
    .secondary { background:#eeeae5; color:#39332d; }
    small { display:block; margin-top:18px; color:#7b746c; line-height:1.45; }
  </style>
</head>
<body><main><div class="brand">E</div>${content}</main></body>
</html>`;
}

function hidden(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function sendHtml(res, status, title, content) {
  noStore(res);
  res.status(status).type('html').send(page(title, content));
}

function loginHtml(transaction, errorMessage = '') {
  return `<h1>Sign in to authorize ChatGPT</h1>
    <p>Use your existing Etsy AI Command Center account.</p>
    ${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ''}
    <form method="post" action="/oauth/authorize">
      ${hidden('action', 'login')}${hidden('transaction', transaction)}
      <label for="username">Username</label><input id="username" name="username" autocomplete="username" required>
      <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
      <div class="actions"><button class="primary" type="submit">Sign in</button></div>
    </form>
    <small>Your Etsy API credentials and Etsy tokens are never shared with ChatGPT.</small>`;
}

function consentHtml(transaction, user, scopes) {
  const items = scopes.map(scope => `<li>${escapeHtml(scope)}</li>`).join('');
  return `<h1>Allow ChatGPT access?</h1>
    <p>Signed in as <strong>${escapeHtml(user.name || user.id)}</strong>. ChatGPT is requesting:</p>
    <ul class="scopes">${items}</ul>
    <form method="post" action="/oauth/authorize">
      ${hidden('transaction', transaction)}
      <div class="actions">
        <button class="secondary" name="action" value="deny" type="submit">Cancel</button>
        <button class="primary" name="action" value="approve" type="submit">Allow</button>
      </div>
    </form>
    <small>You can revoke this connection later. Consequential Etsy changes require separate confirmation.</small>`;
}

function authorizationRedirect(redirectUri, values) {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) target.searchParams.set(key, String(value));
  return target.toString();
}

function authorizeErrorResponse(res, err) {
  const status = Number(err?.status) || 400;
  return sendHtml(res, status, 'Authorization error', `<h1>Authorization failed</h1><div class="error">${escapeHtml(err?.message || 'Invalid authorization request')}</div>`);
}

function requestFromTransaction(payload) {
  return validateAuthorizationRequest(payload.request);
}

export function oauthAuthorizeHandler(req, res) {
  noStore(res);
  try {
    if (req.method === 'GET') {
      const request = validateAuthorizationRequest(req.query || {});
      const user = authenticatedUser(req);
      if (!user) {
        const transaction = createConsentTransaction(request);
        return sendHtml(res, 200, 'Sign in', loginHtml(transaction));
      }
      const authorized = validateAuthorizationRequest(req.query || {}, user);
      const transaction = createConsentTransaction(authorized, user.id);
      req.auth = { user };
      audit(req, 'gpt.oauth.consent.shown', { client_id: authorized.clientId, scopes: authorized.scopes.join(' ') });
      return sendHtml(res, 200, 'Authorize ChatGPT', consentHtml(transaction, user, authorized.scopes));
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return authorizeErrorResponse(res, oauthError('Method not allowed', 'invalid_request', 405));
    }
    if (!isSameOriginAuthorizationPost(req)) {
      audit(req, 'gpt.oauth.consent.cross_origin_blocked');
      return authorizeErrorResponse(res, oauthError('Cross-origin authorization request blocked', 'access_denied', 403));
    }

    const payload = verifyConsentTransaction(req.body?.transaction);
    const request = requestFromTransaction(payload);
    const action = String(req.body?.action || '');

    if (action === 'login') {
      if (payload.user_id) throw oauthError('Authorization transaction is not valid for login');
      const user = authenticateUser(req.body?.username, req.body?.password);
      if (!user) {
        audit(req, 'gpt.oauth.login.failed', { username: String(req.body?.username || '').toLowerCase() });
        return sendHtml(res, 401, 'Sign in', loginHtml(req.body.transaction, 'Incorrect username or password'));
      }
      setSessionCookie(res, user);
      req.auth = { user };
      audit(req, 'gpt.oauth.login.succeeded', { client_id: request.clientId });
      const config = getOAuthConfig();
      return res.redirect(303, `${config.issuer}/oauth/authorize?${new URLSearchParams(payload.request).toString()}`);
    }

    const user = authenticatedUser(req);
    if (!user || !payload.user_id || payload.user_id !== user.id) {
      throw oauthError('Your authorization session expired; sign in again', 'access_denied', 401);
    }
    req.auth = { user };
    const authorized = validateAuthorizationRequest(payload.request, user);
    if (action === 'deny') {
      audit(req, 'gpt.oauth.consent.denied', { client_id: authorized.clientId });
      return res.redirect(303, authorizationRedirect(authorized.redirectUri, {
        error: 'access_denied',
        error_description: 'The user denied the authorization request',
        state: authorized.state,
      }));
    }
    if (action !== 'approve') throw oauthError('Unknown authorization action');

    const code = createAuthorizationCode({
      clientId: authorized.clientId,
      redirectUri: authorized.redirectUri,
      user,
      scopes: authorized.scopes,
      codeChallenge: authorized.codeChallenge,
      codeChallengeMethod: authorized.codeChallengeMethod,
    });
    audit(req, 'gpt.oauth.code.issued', { client_id: authorized.clientId, scopes: authorized.scopes.join(' ') });
    return res.redirect(303, authorizationRedirect(authorized.redirectUri, { code, state: authorized.state }));
  } catch (err) {
    audit(req, 'gpt.oauth.authorize.failed', { error: err?.oauthCode || 'server_error' });
    return authorizeErrorResponse(res, err);
  }
}

function tokenErrorResponse(req, res, err) {
  noStore(res);
  const status = Number(err?.status) || 400;
  const code = err?.oauthCode || 'server_error';
  if (code === 'invalid_client') res.setHeader('WWW-Authenticate', 'Basic realm="GPT OAuth token endpoint"');
  audit(req, 'gpt.oauth.token.failed', { error: code });
  return res.status(status).json({ error: code, error_description: err?.message || 'OAuth request failed' });
}

export function oauthTokenHandler(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return tokenErrorResponse(req, res, oauthError('POST required', 'invalid_request', 405));
  }
  try {
    const { clientId } = authenticateOAuthClient(req);
    const grantType = String(req.body?.grant_type || '');
    let tokens;
    if (grantType === 'authorization_code') {
      if (!req.body?.code || !req.body?.redirect_uri) throw oauthError('code and redirect_uri are required');
      tokens = exchangeAuthorizationCode({
        code: String(req.body.code),
        clientId,
        redirectUri: String(req.body.redirect_uri),
        codeVerifier: String(req.body.code_verifier || ''),
      });
      audit(req, 'gpt.oauth.token.issued', { client_id: clientId, grant_type: grantType, scopes: tokens.scope });
    } else if (grantType === 'refresh_token') {
      if (!req.body?.refresh_token) throw oauthError('refresh_token is required');
      tokens = rotateRefreshToken({ refreshToken: String(req.body.refresh_token), clientId });
      const resolved = resolveAccessToken(tokens.access_token);
      if (resolved?.user) req.auth = { user: resolved.user };
      audit(req, 'gpt.oauth.refresh.rotated', { client_id: clientId, grant_type: grantType, scopes: tokens.scope });
    } else {
      throw oauthError('Unsupported grant_type', 'unsupported_grant_type');
    }
    return res.status(200).json(tokens);
  } catch (err) {
    return tokenErrorResponse(req, res, err);
  }
}

export function oauthRevokeHandler(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return tokenErrorResponse(req, res, oauthError('POST required', 'invalid_request', 405));
  }
  try {
    const { clientId } = authenticateOAuthClient(req);
    if (!req.body?.token) throw oauthError('token is required');
    revokeOAuthToken({ token: String(req.body.token), clientId });
    audit(req, 'gpt.oauth.token.revoked', { client_id: clientId, token_type_hint: req.body?.token_type_hint || '' });
    return res.status(200).end();
  } catch (err) {
    return tokenErrorResponse(req, res, err);
  }
}

export default function oauthHandler(req, res) {
  const path = String(req.path || req.url || '').split('?')[0];
  if (path.endsWith('/authorize')) return oauthAuthorizeHandler(req, res);
  if (path.endsWith('/token')) return oauthTokenHandler(req, res);
  if (path.endsWith('/revoke')) return oauthRevokeHandler(req, res);
  return res.status(404).json({ error: 'not_found' });
}
