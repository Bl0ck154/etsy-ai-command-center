import { test, expect } from '@playwright/test';

import { createStatsApplication } from '../api/stats/application.js';

const NOW = 1_800_000_000_000;
const isCurrent = receipt => receipt.current !== false;

function createApp(handler) {
  const calls = [];
  const app = createStatsApplication({
    shopId: '123',
    now: () => NOW,
    isCurrentPaidReceipt: isCurrent,
    etsyFetch: async path => {
      calls.push(path);
      return handler?.(path) || { results: [] };
    },
  });
  return { app, calls };
}

test('shop stats preserves granularity and days URL contract', async () => {
  const { app, calls } = createApp(() => ({ count: 1 }));
  expect(await app.getShopStats({ days: '14', granularity: 'week' })).toEqual({ count: 1 });
  expect(calls).toEqual(['/shops/123/stats?unit=week&limit=14']);
});

test('revenue preserves paid receipts endpoint and deterministic min_created calculation', async () => {
  const { app, calls } = createApp(() => ({ results: [] }));
  await app.getRevenue({ days: '30' });
  const expectedMin = Math.floor((NOW - 30 * 86400000) / 1000);
  expect(calls).toEqual([
    `/shops/123/receipts?limit=100&min_created=${expectedMin}&was_paid=true&includes=transactions`,
  ]);
});

test('listing stats preserves active listing endpoint', async () => {
  const { app, calls } = createApp(() => ({ results: [{ listing_id: 1, views: 3 }] }));
  const result = await app.getListingStats();
  expect(calls).toEqual([
    '/shops/123/listings?state=active&limit=100&sort_on=updated&sort_order=desc',
  ]);
  expect(result.total_views).toBe(3);
});

test('order stats preserves endpoint and current-receipt filter', async () => {
  const { app, calls } = createApp(() => ({
    results: [
      { current: true, create_timestamp: 1_700_000_000, grandtotal: { amount: 1000, divisor: 100 } },
      { current: false, create_timestamp: 1_700_000_000, grandtotal: { amount: 9000, divisor: 100 } },
    ],
  }));
  const result = await app.getOrderStats({ days: '7' });
  const expectedMin = Math.floor((NOW - 7 * 86400000) / 1000);
  expect(calls).toEqual([
    `/shops/123/receipts?limit=100&sort_on=created&sort_order=desc&min_created=${expectedMin}`,
  ]);
  expect(result).toMatchObject({ total_orders: 1, total_revenue: 10, avg_order_value: 10 });
});
