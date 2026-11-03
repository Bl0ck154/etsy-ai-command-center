import { expect, test } from '@playwright/test';
import { postJson } from '../public/utils/json-post-client.js';

test('postJson preserves method, JSON content type and serialized body', async () => {
  const calls = [];
  const body = { type: 'audit', value: 7 };
  const result = await postJson('/api/example', body, {
    fetchImpl: async (...args) => {
      calls.push(args);
      return { json: async () => ({ ok: true }) };
    },
  });

  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe('/api/example');
  expect(calls[0][1]).toEqual({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(result).toEqual({ ok: true });
});

test('postJson intentionally preserves parsed error payloads without checking response.ok', async () => {
  const result = await postJson('/api/example', {}, {
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'server error' }),
    }),
  });
  expect(result).toEqual({ error: 'server error' });
});
