import { expect, test } from '@playwright/test';
import { fetchAvailableShops } from '../public/components/shop-switcher-api.js';

test('fetchAvailableShops preserves the existing Etsy action URL and unwraps data', async () => {
  const calls = [];
  const shops = [{ id: '1', name: 'One' }];
  const result = await fetchAvailableShops({
    fetchImpl: async (...args) => {
      calls.push(args);
      return { json: async () => ({ data: shops }) };
    },
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(['/api/etsy?action=getAvailableShops']);
  expect(result).toEqual(shops);
});

test('fetchAvailableShops preserves direct-array responses', async () => {
  const shops = [{ id: '2', name: 'Two' }];
  const result = await fetchAvailableShops({
    fetchImpl: async () => ({ json: async () => shops }),
  });
  expect(result).toEqual(shops);
});

test('fetchAvailableShops preserves the empty fallback', async () => {
  const result = await fetchAvailableShops({
    fetchImpl: async () => ({ json: async () => null }),
  });
  expect(result).toEqual([]);
});
