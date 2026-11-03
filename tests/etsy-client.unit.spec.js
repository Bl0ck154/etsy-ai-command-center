import { expect, test } from '@playwright/test';

import { createEtsyApiClient } from '../api/etsy/client.js';

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: name => normalized[String(name).toLowerCase()] ?? null };
}

function response({ status = 200, body = '{}', headerValues = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(headerValues),
    text: async () => body,
  };
}

test('Etsy client retries one 401 after refreshing the token', async () => {
  const requests = [];
  let tokenCalls = 0;
  let refreshCalls = 0;
  const responses = [
    response({ status: 401, body: JSON.stringify({ error: 'expired' }) }),
    response({ status: 200, body: JSON.stringify({ listing_id: 123 }) }),
  ];
  const client = createEtsyApiClient({
    getToken: async () => `token-${++tokenCalls}`,
    refreshToken: async () => { refreshCalls += 1; },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return responses.shift();
    },
    setTimer: () => 1,
    clearTimer: () => {},
  });

  await expect(client.request('/listings/123')).resolves.toEqual({ listing_id: 123 });
  expect(refreshCalls).toBe(1);
  expect(tokenCalls).toBe(2);
  expect(requests).toHaveLength(2);
  expect(requests[0].url).toBe('https://openapi.etsy.com/v3/application/listings/123');
  expect(requests[0].options.headers.Authorization).toBe('Bearer token-1');
  expect(requests[1].options.headers.Authorization).toBe('Bearer token-2');
});

test('Etsy client retries 429 with the historical bounded backoff', async () => {
  const delays = [];
  let calls = 0;
  const client = createEtsyApiClient({
    getToken: async () => 'token',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return response({ status: 429, body: '{}', headerValues: { 'retry-after': '5' } });
      }
      return response({ status: 200, body: JSON.stringify({ ok: true }) });
    },
    sleep: async delay => { delays.push(delay); },
    setTimer: () => 1,
    clearTimer: () => {},
  });

  await expect(client.request('/shops/1')).resolves.toEqual({ ok: true });
  expect(delays).toEqual([1000]);
  expect(calls).toBe(2);
});

test('Etsy client preserves 204 success and provider error metadata', async () => {
  const noContent = createEtsyApiClient({
    getToken: async () => 'token',
    fetchImpl: async () => response({ status: 204, body: '' }),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await expect(noContent.request('/resource', { method: 'DELETE' })).resolves.toEqual({ success: true });

  const badRequest = createEtsyApiClient({
    getToken: async () => 'token',
    fetchImpl: async () => response({
      status: 400,
      body: JSON.stringify({ error_description: 'invalid listing', field: 'title' }),
    }),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await expect(badRequest.request('/resource')).rejects.toMatchObject({
    status: 400,
    message: 'invalid listing',
    data: { error_description: 'invalid listing', field: 'title' },
  });
});

test('Etsy client preserves timeout error text', async () => {
  const client = createEtsyApiClient({
    getToken: async () => 'token',
    fetchImpl: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; },
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await expect(client.request('/slow')).rejects.toThrow('Etsy API timeout after 20s');
});

test('Etsy POST diagnostics redact body contents while retaining byte count', async () => {
  const logs = [];
  const client = createEtsyApiClient({
    getToken: async () => 'token',
    fetchImpl: async () => response({ status: 200, body: '{}' }),
    logger: { log: (...args) => logs.push(args) },
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await client.request('/resource', { method: 'POST', body: '{"secret":"do-not-log"}' });
  expect(logs).toHaveLength(1);
  expect(logs[0].join(' ')).toContain('body redacted');
  expect(logs[0].join(' ')).not.toContain('do-not-log');
});
