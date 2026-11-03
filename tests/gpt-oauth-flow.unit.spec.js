import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashAuthPassword, setSessionCookie } from '../api/_auth.js';
import { oauthAuthorizeHandler, oauthTokenHandler, oauthRevokeHandler } from '../api/gpt/oauth-handler.js';
import { authenticateGptBearer, requireGptScope } from '../api/gpt/oauth-middleware.js';

function recorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    redirectUrl: '',
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    type(value) { this.headers['content-type'] = value; return this; },
    send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; },
    redirect(status, value) { this.statusCode = status; this.redirectUrl = value; return this; },
    end() { this.ended = true; return this; },
  };
}

function request({ method = 'GET', query = {}, body = {}, headers = {} } = {}) {
  return {
    method,
    query,
    body,
    headers,
    ip: '127.0.0.1',
    get(name) { return this.headers[String(name).toLowerCase()] || ''; },
  };
}

function flowEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-flow-'));
  const keys = [
    'NODE_ENV', 'HOST', 'AUTH_USERS_B64', 'AUTH_SESSIONS_FILE', 'SESSION_SECRET', 'SITE_PASSWORD',
    'GPT_OAUTH_CLIENT_ID', 'GPT_OAUTH_CLIENT_SECRET', 'GPT_OAUTH_REDIRECT_URIS', 'GPT_OAUTH_ISSUER',
    'GPT_OAUTH_STORE_FILE', 'GPT_OAUTH_TOKEN_HASH_SECRET', 'GPT_OAUTH_ALLOWED_SCOPES', 'SECURITY_AUDIT_DIR',
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const user = { id: 'illia', name: 'Illia', role: 'owner', passwordHash: hashAuthPassword('a-very-long-owner-password') };
  Object.assign(process.env, {
    NODE_ENV: 'production', HOST: '127.0.0.1',
    AUTH_USERS_B64: Buffer.from(JSON.stringify([user])).toString('base64url'),
    AUTH_SESSIONS_FILE: path.join(dir, 'sessions.json'),
    SESSION_SECRET: 'session-secret-that-is-at-least-32-characters',
    GPT_OAUTH_CLIENT_ID: 'etsy-manager-chatgpt',
    GPT_OAUTH_CLIENT_SECRET: 'client-secret-that-is-at-least-32-characters',
    GPT_OAUTH_REDIRECT_URIS: 'https://chatgpt.com/aip/g-test/oauth/callback',
    GPT_OAUTH_ISSUER: 'https://dashboard.example.test',
    GPT_OAUTH_STORE_FILE: path.join(dir, 'oauth.json'),
    GPT_OAUTH_TOKEN_HASH_SECRET: 'oauth-hash-secret-that-is-at-least-32-characters',
    SECURITY_AUDIT_DIR: path.join(dir, 'audit'),
  });
  return {
    restore() {
      for (const key of keys) delete process.env[key];
      for (const [key, value] of Object.entries(previous)) if (value !== undefined) process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('OAuth authorization code flow preserves state and issues a scoped bearer token', () => {
  const env = flowEnv();
  try {
    const sessionRes = recorder();
    setSessionCookie(sessionRes, { id: 'illia', name: 'Illia' });
    const cookie = sessionRes.headers['set-cookie'].split(';')[0];
    const authorizeQuery = {
      response_type: 'code',
      client_id: process.env.GPT_OAUTH_CLIENT_ID,
      redirect_uri: 'https://chatgpt.com/aip/g-test/oauth/callback',
      state: 'state-from-chatgpt',
      scope: 'gpt:read listings:write',
    };
    const consentRes = recorder();
    oauthAuthorizeHandler(request({ query: authorizeQuery, headers: { cookie } }), consentRes);
    expect(consentRes.statusCode).toBe(200);
    const transaction = String(consentRes.body).match(/name="transaction" value="([^"]+)"/)?.[1];
    expect(transaction).toBeTruthy();

    const approveRes = recorder();
    oauthAuthorizeHandler(request({
      method: 'POST',
      body: { action: 'approve', transaction },
      headers: { cookie, origin: 'https://dashboard.example.test' },
    }), approveRes);
    expect(approveRes.statusCode).toBe(303);
    const callback = new URL(approveRes.redirectUrl);
    expect(callback.searchParams.get('state')).toBe('state-from-chatgpt');
    expect(callback.searchParams.get('code')).toMatch(/^gptc_/);

    const tokenRes = recorder();
    oauthTokenHandler(request({ method: 'POST', body: {
      grant_type: 'authorization_code',
      client_id: process.env.GPT_OAUTH_CLIENT_ID,
      client_secret: process.env.GPT_OAUTH_CLIENT_SECRET,
      redirect_uri: authorizeQuery.redirect_uri,
      code: callback.searchParams.get('code'),
    } }), tokenRes);
    expect(tokenRes.statusCode).toBe(200);
    expect(tokenRes.body).toMatchObject({ token_type: 'Bearer', scope: 'gpt:read listings:write' });

    const bearerReq = request({ headers: { authorization: `Bearer ${tokenRes.body.access_token}` } });
    const bearerRes = recorder();
    expect(authenticateGptBearer(bearerReq, bearerRes)).toBe(true);
    expect(bearerReq.auth).toMatchObject({ kind: 'gpt_oauth', user: { id: 'illia', role: 'owner' } });

    const downgraded = { id: 'illia', name: 'Illia', role: 'viewer', passwordHash: hashAuthPassword('a-very-long-owner-password') };
    process.env.AUTH_USERS_B64 = Buffer.from(JSON.stringify([downgraded])).toString('base64url');
    const downgradedReq = request({ headers: { authorization: `Bearer ${tokenRes.body.access_token}` } });
    const downgradedRes = recorder();
    expect(requireGptScope(downgradedReq, downgradedRes, 'listings:write')).toBe(false);
    expect(downgradedRes.statusCode).toBe(403);

    const revokeRes = recorder();
    oauthRevokeHandler(request({ method: 'POST', body: {
      client_id: process.env.GPT_OAUTH_CLIENT_ID,
      client_secret: process.env.GPT_OAUTH_CLIENT_SECRET,
      token: tokenRes.body.refresh_token,
    } }), revokeRes);
    expect(revokeRes.statusCode).toBe(200);
    expect(authenticateGptBearer(request({ headers: { authorization: `Bearer ${tokenRes.body.access_token}` } }), recorder())).toBe(false);
  } finally {
    env.restore();
  }
});

test('OAuth rejects redirect substitution without redirecting to the attacker', () => {
  const env = flowEnv();
  try {
    const res = recorder();
    oauthAuthorizeHandler(request({ query: {
      response_type: 'code', client_id: process.env.GPT_OAUTH_CLIENT_ID,
      redirect_uri: 'https://chatgpt.com.evil.test/aip/g-test/oauth/callback', state: 'state', scope: 'gpt:read',
    } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.redirectUrl).toBe('');
    expect(String(res.body)).toContain('not allowlisted');
  } finally {
    env.restore();
  }
});
