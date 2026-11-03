import { test, expect } from '@playwright/test';

import { createScheduleApi } from '../public/utils/schedule-api.js';

test('schedule transport preserves KV arguments', async () => {
  const calls = [];
  const api = createScheduleApi({
    postKv: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
    fetchImpl: async () => { throw new Error('not used'); },
  });

  expect(await api.kv('a', { id: 1 })).toEqual({ ok: true });
  expect(await api.kv('b', null, { key: 'x' })).toEqual({ ok: true });
  expect(calls).toEqual([
    ['a', { id: 1 }],
    ['b', null, { key: 'x' }],
  ]);
});

test('schedule transport preserves Social request and data response', async () => {
  const calls = [];
  const api = createScheduleApi({
    postKv: async () => null,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return {
        ok: true,
        json: async () => ({ data: { id: 'p1' } }),
      };
    },
  });

  expect(await api.social('sampleAction', { id: 'p1' })).toEqual({ id: 'p1' });
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe('/api/social');
  expect(calls[0][1].method).toBe('POST');
  expect(JSON.parse(calls[0][1].body)).toEqual({ action: 'sampleAction', id: 'p1' });
});

test('schedule transport surfaces server error text', async () => {
  const api = createScheduleApi({
    postKv: async () => null,
    fetchImpl: async () => ({
      ok: false,
      json: async () => ({ error: 'example error' }),
    }),
  });

  await expect(api.social('sampleAction')).rejects.toThrow('example error');
});
