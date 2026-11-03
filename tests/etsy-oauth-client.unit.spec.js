import { expect, test } from '@playwright/test';

import { createEtsyOAuthClient } from '../api/etsy-auth/oauth-client.js';

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

test('refresh transport preserves Etsy token endpoint headers and form fields', async () => {
  let request = null;
  const client = createEtsyOAuthClient({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    },
  });

  const result = await client.refreshToken({
    refreshToken: 'refresh-1',
    apiKey: 'api-key',
    clientSecret: 'client-secret',
  });

  expect(request.url).toBe('https://api.etsy.com/v3/public/oauth/token');
  expect(request.options.method).toBe('POST');
  expect(request.options.headers).toEqual({
    'Content-Type': 'application/x-www-form-urlencoded',
    'x-api-key': 'api-key:client-secret',
  });
  expect(Object.fromEntries(request.options.body.entries())).toEqual({
    grant_type: 'refresh_token',
    client_id: 'api-key',
    client_secret: 'client-secret',
    refresh_token: 'refresh-1',
  });
  expect(result).toMatchObject({ ok: true, status: 200 });
});

test('PKCE exchange preserves code verifier and caller-provided redirect/config', async () => {
  let request = null;
  const client = createEtsyOAuthClient({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ access_token: 'access', refresh_token: 'refresh', expires_in: 7200 });
    },
  });

  const result = await client.exchangeCode({
    code: 'oauth-code',
    verifier: 'pkce-verifier',
    apiKey: 'setup-key',
    clientSecret: 'setup-secret',
    redirectUri: 'https://example.test/callback',
  });

  expect(request.url).toBe('https://api.etsy.com/v3/public/oauth/token');
  expect(Object.fromEntries(request.options.body.entries())).toEqual({
    grant_type: 'authorization_code',
    client_id: 'setup-key',
    client_secret: 'setup-secret',
    redirect_uri: 'https://example.test/callback',
    code: 'oauth-code',
    code_verifier: 'pkce-verifier',
  });
  expect(result.apiKeyFull).toBe('setup-key:setup-secret');
});

test('shop lookup preserves users/me then user shops sequence', async () => {
  const requests = [];
  const client = createEtsyOAuthClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/users/me')) return jsonResponse({ user_id: 77 });
      return jsonResponse({ results: [{ shop_id: 12345 }] });
    },
  });

  await expect(client.resolveShopId('access-token', 'api-key:secret')).resolves.toBe('12345');
  expect(requests.map(item => item.url)).toEqual([
    'https://openapi.etsy.com/v3/application/users/me',
    'https://openapi.etsy.com/v3/application/users/77/shops',
  ]);
  expect(requests[0].options.headers.Authorization).toBe('Bearer access-token');
  expect(requests[1].options.headers['x-api-key']).toBe('api-key:secret');
});

test('shop lookup remains fail-soft when profile lookup fails', async () => {
  const client = createEtsyOAuthClient({
    fetchImpl: async () => { throw new Error('network'); },
  });
  await expect(client.resolveShopId('access-token', 'key')).resolves.toBe('');
});
