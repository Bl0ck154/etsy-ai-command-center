import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashAuthPassword } from '../api/_auth.js';
import gptRouter from '../api/gpt/router.js';
import { createAuthorizationCode, exchangeAuthorizationCode } from '../api/gpt/oauth-store.js';

function recorder() {
  return {
    statusCode: 200, body: null, headers: {},
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    type(value) { this.headers['content-type'] = value; return this; },
    send(value) { this.body = typeof value === 'string' ? JSON.parse(value) : value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

function routerEnv(role = 'owner', scopes = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-router-'));
  const keys = ['NODE_ENV', 'AUTH_USERS_B64', 'SESSION_SECRET', 'GPT_OAUTH_CLIENT_ID', 'GPT_OAUTH_CLIENT_SECRET', 'GPT_OAUTH_REDIRECT_URIS', 'GPT_OAUTH_STORE_FILE', 'GPT_OAUTH_TOKEN_HASH_SECRET', 'SECURITY_AUDIT_DIR'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const user = { id: 'tester', name: 'Tester', role, scopes, passwordHash: hashAuthPassword('a-very-long-test-password') };
  Object.assign(process.env, {
    NODE_ENV: 'production', AUTH_USERS_B64: Buffer.from(JSON.stringify([user])).toString('base64url'),
    SESSION_SECRET: 'router-session-secret-at-least-32-characters', GPT_OAUTH_CLIENT_ID: 'router-client',
    GPT_OAUTH_CLIENT_SECRET: 'router-client-secret-at-least-32-characters',
    GPT_OAUTH_REDIRECT_URIS: 'https://chatgpt.com/aip/g-router/oauth/callback',
    GPT_OAUTH_STORE_FILE: path.join(dir, 'oauth.json'), GPT_OAUTH_TOKEN_HASH_SECRET: 'router-hash-secret-at-least-32-characters',
    SECURITY_AUDIT_DIR: path.join(dir, 'audit'),
  });
  const code = createAuthorizationCode({ clientId: 'router-client', redirectUri: process.env.GPT_OAUTH_REDIRECT_URIS, user, scopes: role === 'owner' ? ['gpt:read', 'listings:publish'] : ['gpt:read'] });
  const token = exchangeAuthorizationCode({ code, clientId: 'router-client', redirectUri: process.env.GPT_OAUTH_REDIRECT_URIS }).access_token;
  return {
    token,
    restore() {
      for (const key of keys) delete process.env[key];
      for (const [key, value] of Object.entries(previous)) if (value !== undefined) process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function req(pathValue, { method = 'GET', token = '', body = {} } = {}) {
  return { method, path: pathValue, url: pathValue, query: {}, body, headers: token ? { authorization: `Bearer ${token}` } : {}, ip: '127.0.0.1' };
}

test('GPT status is public and discloses readiness flags only', async () => {
  const res = recorder();
  await gptRouter(req('/api/gpt/status'), res);
  expect(res.statusCode).toBe(200);
  expect(res.body.data).toMatchObject({ ok: true, service: 'etsy-manager-pro', integration: 'gpt-actions' });
  expect(JSON.stringify(res.body)).not.toMatch(/client_secret|access_token|refresh_token|api_key/i);
});

test('consequential routes require literal confirmation before Etsy is called', async () => {
  const env = routerEnv('owner');
  try {
    const res = recorder();
    await gptRouter(req('/api/gpt/listings/123/publish', { method: 'POST', token: env.token }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'CONFIRMATION_REQUIRED' });
  } finally {
    env.restore();
  }
});

test('RBAC rejects a read-only token before a consequential route can execute', async () => {
  const env = routerEnv('viewer');
  try {
    const res = recorder();
    await gptRouter(req('/api/gpt/listings/123/publish', { method: 'POST', token: env.token, body: { confirmation: true } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'insufficient_scope' });
  } finally {
    env.restore();
  }
});
