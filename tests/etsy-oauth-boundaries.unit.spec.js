import fs from 'node:fs';
import { expect, test } from '@playwright/test';

import { isUsableRefreshToken } from '../api/etsy-auth/token-runtime.js';

const route = fs.readFileSync(new URL('../api/auth.js', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('../api/etsy-auth/token-runtime.js', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../api/etsy-auth/oauth-client.js', import.meta.url), 'utf8');

test('Etsy OAuth HTTP facade preserves compatibility exports while allowing Hub token ownership', () => {
  expect(route).toContain('export async function getValidToken()');
  expect(route).toContain('export async function refreshAccessToken()');
  expect(route).toContain('export { resetEtsyTokenCacheForTests };');
  expect(route).toContain("from './etsy-auth/token-runtime.js'");
  expect(route).toContain("import { pathToFileURL } from 'node:url';");
  expect(route).toContain('export async function hubEtsyRequest');
  expect(route).toContain('etsyApiHubEnabled() ? hubGetValidToken() : getLegacyValidToken()');
  expect(route).toContain('etsyApiHubEnabled() ? hubRefreshAccessToken() : refreshLegacyAccessToken()');
  expect(route).not.toContain('etsyTokenStateRepository');
  expect(route).not.toContain('invalid_refresh_token');
  expect(route).not.toContain('https://api.etsy.com/v3/public/oauth/token');
  expect(route).not.toContain('URLSearchParams');
  expect(route.split('\n').length).toBeLessThan(260);
});

test('token runtime owns revision fencing and refresh deduplication', () => {
  expect(runtime).toContain('etsyTokenStateRepository.readSnapshot()');
  expect(runtime).toContain('etsyTokenStateRepository.compareAndReplace(expectedRevision, tokenCache)');
  expect(runtime).toContain('refreshPromise = refreshAccessToken().finally');
  expect(runtime).toContain("tokenStateChangedError('OAuth exchange')");
  expect(runtime).toContain("tokenStateChangedError('refresh')");
});

test('OAuth client owns Etsy token/profile/shop network endpoints', () => {
  expect(client).toContain("const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token'");
  expect(client).toContain("const OPENAPI_BASE = 'https://openapi.etsy.com/v3/application'");
  expect(client).toContain("grant_type: 'authorization_code'");
  expect(client).toContain("grant_type: 'refresh_token'");
});

test('refresh-token usability keeps placeholder rejection contract', () => {
  expect(Boolean(isUsableRefreshToken('valid-refresh-token'))).toBe(true);
  expect(Boolean(isUsableRefreshToken('your_refresh_token'))).toBe(false);
  expect(Boolean(isUsableRefreshToken('your-refresh-token'))).toBe(false);
  expect(Boolean(isUsableRefreshToken('undefined'))).toBe(false);
  expect(Boolean(isUsableRefreshToken('null'))).toBe(false);
  expect(Boolean(isUsableRefreshToken(''))).toBe(false);
});
