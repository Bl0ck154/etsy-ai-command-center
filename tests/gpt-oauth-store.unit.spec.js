import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  normalizeRequestedScopes,
  resolveAccessToken,
  revokeOAuthToken,
  rotateRefreshToken,
  scopesForUser,
} from '../api/gpt/oauth-store.js';

function oauthEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-'));
  const previous = Object.fromEntries([
    'SESSION_SECRET',
    'GPT_OAUTH_TOKEN_HASH_SECRET',
    'GPT_OAUTH_STORE_FILE',
    'GPT_OAUTH_ACCESS_TTL_SECONDS',
    'GPT_OAUTH_REFRESH_TTL_SECONDS',
    'GPT_OAUTH_CODE_TTL_SECONDS',
  ].map(key => [key, process.env[key]]));
  process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough';
  process.env.GPT_OAUTH_TOKEN_HASH_SECRET = 'test-oauth-hash-secret-that-is-long-enough';
  process.env.GPT_OAUTH_STORE_FILE = path.join(dir, 'oauth.json');
  return {
    file: process.env.GPT_OAUTH_STORE_FILE,
    restore() {
      for (const key of Object.keys(previous)) delete process.env[key];
      for (const [key, value] of Object.entries(previous)) if (value !== undefined) process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const owner = { id: 'owner', name: 'Owner', role: 'owner', scopes: [] };
const clientId = 'chatgpt-etsy-manager';
const redirectUri = 'https://chatgpt.com/aip/g-example/oauth/callback';

test('authorization codes are one-time, bound, and persisted only as hashes', () => {
  const env = oauthEnv();
  try {
    const code = createAuthorizationCode({ clientId, redirectUri, user: owner, scopes: ['gpt:read'] });
    const before = fs.readFileSync(env.file, 'utf8');
    expect(before).not.toContain(code);
    expect(before).not.toContain('gpta_');
    expect(before).not.toContain('gptr_');

    const pair = exchangeAuthorizationCode({ code, clientId, redirectUri });
    expect(pair).toMatchObject({ token_type: 'Bearer', scope: 'gpt:read' });
    expect(resolveAccessToken(pair.access_token)?.user.id).toBe('owner');

    const persisted = fs.readFileSync(env.file, 'utf8');
    expect(persisted).not.toContain(code);
    expect(persisted).not.toContain(pair.access_token);
    expect(persisted).not.toContain(pair.refresh_token);
    expect(() => exchangeAuthorizationCode({ code, clientId, redirectUri })).toThrow(/invalid or expired/i);
  } finally {
    env.restore();
  }
});

test('a redirect binding mismatch consumes the authorization code', () => {
  const env = oauthEnv();
  try {
    const code = createAuthorizationCode({ clientId, redirectUri, user: owner, scopes: ['gpt:read'] });
    expect(() => exchangeAuthorizationCode({ code, clientId, redirectUri: `${redirectUri}/evil` })).toThrow(/binding mismatch/i);
    expect(() => exchangeAuthorizationCode({ code, clientId, redirectUri })).toThrow(/invalid or expired/i);
  } finally {
    env.restore();
  }
});

test('refresh tokens rotate and replay revokes the full token family', () => {
  const env = oauthEnv();
  try {
    const code = createAuthorizationCode({ clientId, redirectUri, user: owner, scopes: ['gpt:read', 'listings:write'] });
    const first = exchangeAuthorizationCode({ code, clientId, redirectUri });
    const second = rotateRefreshToken({ refreshToken: first.refresh_token, clientId });
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(resolveAccessToken(second.access_token)).not.toBeNull();

    expect(() => rotateRefreshToken({ refreshToken: first.refresh_token, clientId })).toThrow(/reuse detected/i);
    expect(resolveAccessToken(first.access_token)).toBeNull();
    expect(resolveAccessToken(second.access_token)).toBeNull();
  } finally {
    env.restore();
  }
});

test('replay after the original family expiry still revokes a multiply rotated family', () => {
  const env = oauthEnv();
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  process.env.GPT_OAUTH_REFRESH_TTL_SECONDS = '3600';
  try {
    const code = createAuthorizationCode({ clientId, redirectUri, user: owner, scopes: ['gpt:read'] });
    const first = exchangeAuthorizationCode({ code, clientId, redirectUri });

    now += 40 * 60 * 1000;
    const second = rotateRefreshToken({ refreshToken: first.refresh_token, clientId });
    now += 10 * 60 * 1000;
    const third = rotateRefreshToken({ refreshToken: second.refresh_token, clientId });

    // The first family expiry was at +60 minutes. The used second token is
    // still a live replay tombstone at +70 minutes and must revoke token three.
    now += 20 * 60 * 1000;
    expect(() => rotateRefreshToken({ refreshToken: second.refresh_token, clientId })).toThrow(/reuse detected/i);
    expect(resolveAccessToken(first.access_token)).toBeNull();
    expect(resolveAccessToken(second.access_token)).toBeNull();
    expect(resolveAccessToken(third.access_token)).toBeNull();
  } finally {
    Date.now = originalNow;
    env.restore();
  }
});

test('revoking a refresh token revokes its access token family', () => {
  const env = oauthEnv();
  try {
    const code = createAuthorizationCode({ clientId, redirectUri, user: owner, scopes: ['gpt:read'] });
    const pair = exchangeAuthorizationCode({ code, clientId, redirectUri });
    revokeOAuthToken({ token: pair.refresh_token, clientId });
    expect(resolveAccessToken(pair.access_token)).toBeNull();
  } finally {
    env.restore();
  }
});

test('expired authorization codes and access tokens fail closed', () => {
  const env = oauthEnv();
  try {
    const expiredCode = createAuthorizationCode({ clientId, redirectUri, user: owner, scopes: ['gpt:read'] });
    const codeStore = JSON.parse(fs.readFileSync(env.file, 'utf8'));
    Object.values(codeStore.codes)[0].expires_at = Date.now() - 1;
    fs.writeFileSync(env.file, JSON.stringify(codeStore));
    expect(() => exchangeAuthorizationCode({ code: expiredCode, clientId, redirectUri })).toThrow(/invalid or expired/i);

    const code = createAuthorizationCode({ clientId, redirectUri, user: owner, scopes: ['gpt:read'] });
    const pair = exchangeAuthorizationCode({ code, clientId, redirectUri });
    const tokenStore = JSON.parse(fs.readFileSync(env.file, 'utf8'));
    Object.values(tokenStore.access_tokens)[0].expires_at = Date.now() - 1;
    fs.writeFileSync(env.file, JSON.stringify(tokenStore));
    expect(resolveAccessToken(pair.access_token)).toBeNull();
  } finally {
    env.restore();
  }
});

test('role ceilings and explicit partner scopes are enforced', () => {
  expect(scopesForUser(owner)).toContain('listings:delete');
  expect(scopesForUser({ role: 'editor', scopes: [] })).toEqual(['gpt:read', 'listings:write', 'files:write']);
  expect(scopesForUser({ role: 'viewer', scopes: ['gpt:read', 'orders:write'] })).toEqual(['gpt:read', 'orders:write']);
  expect(normalizeRequestedScopes('gpt:read listings:write', { role: 'viewer', scopes: [] })).toEqual(['gpt:read']);
  expect(() => normalizeRequestedScopes('arbitrary:proxy', owner)).toThrow(/unknown scope/i);
});
