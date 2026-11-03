import { test, expect } from '@playwright/test';

import { createShopContextApi } from '../public/utils/shop-context-api.js';

test('source adapter preserves Etsy request parameters', async () => {
  const calls = [];
  const api = createShopContextApi({
    etsyClient: {
      getListings: async params => {
        calls.push(['listings', params]);
        return { results: [{ listing_id: 1 }] };
      },
      getShopSections: async () => {
        calls.push(['sections']);
        return { results: [{ title: 'A' }] };
      },
    },
    getKv: async () => null,
    postKv: async () => null,
  });

  expect(await api.fetchSource()).toEqual({
    listings: [{ listing_id: 1 }],
    sections: [{ title: 'A' }],
  });
  expect(calls).toEqual([
    ['listings', { limit: 100, state: 'active' }],
    ['sections'],
  ]);
});

test('source adapter preserves partial success', async () => {
  const api = createShopContextApi({
    etsyClient: {
      getListings: async () => { throw new Error('x'); },
      getShopSections: async () => ({ results: [{ title: 'B' }] }),
    },
    getKv: async () => null,
    postKv: async () => null,
  });

  expect(await api.fetchSource()).toEqual({
    listings: [],
    sections: [{ title: 'B' }],
  });
});

test('cache adapter preserves KV action names', async () => {
  const calls = [];
  const api = createShopContextApi({
    etsyClient: { getListings: async () => ({}), getShopSections: async () => ({}) },
    getKv: async (...args) => {
      calls.push(['get', ...args]);
      return { timestamp: 1 };
    },
    postKv: async (...args) => {
      calls.push(['post', ...args]);
      return true;
    },
  });

  expect(await api.getCached()).toEqual({ timestamp: 1 });
  await api.setCached({ timestamp: 2 });
  await api.clearCached();

  expect(calls).toEqual([
    ['get', 'getContext'],
    ['post', 'setContext', { timestamp: 2 }],
    ['post', 'del', null, { key: 'shop_context' }],
  ]);
});
