import { test, expect } from '@playwright/test';

import {
  projectListingStats,
  summarizeOrders,
  summarizeRevenue,
  transactionRevenue,
} from '../api/stats/analytics.js';

const isCurrent = receipt => receipt.current === true;

test('transaction revenue preserves divisor and quantity semantics', () => {
  expect(transactionRevenue({ price: { amount: 1250, divisor: 100 }, quantity: 2 })).toBe(25);
  expect(transactionRevenue({ price: { amount: 500 }, quantity: 0 })).toBe(5);
});

test('revenue summary excludes non-current paid receipts and groups transaction totals by day', () => {
  const receipts = [
    {
      current: true,
      create_timestamp: 1_700_000_000,
      transactions: [
        { id: 'a', price: { amount: 1000, divisor: 100 }, quantity: 2 },
        { id: 'b', price: { amount: 500, divisor: 100 }, quantity: 1 },
      ],
    },
    {
      current: false,
      create_timestamp: 1_700_000_000,
      transactions: [{ id: 'cancelled', price: { amount: 9999, divisor: 100 }, quantity: 1 }],
    },
  ];
  const result = summarizeRevenue(receipts, isCurrent);
  expect(result.total).toBe(25);
  expect(Object.values(result.by_day)).toEqual([25]);
  expect(result.transactions.map(tx => tx.id)).toEqual(['a', 'b']);
});

test('listing projection preserves public shape and totals views', () => {
  const result = projectListingStats([
    { listing_id: 1, title: 'A', views: 4, num_favorers: 2, price: { amount: 100 }, state: 'active' },
    { listing_id: 2, title: 'B', views: 0, num_favorers: 0, price: { amount: 200 }, state: 'active' },
  ]);
  expect(result.total_views).toBe(4);
  expect(result.listings[0]).toEqual({
    listing_id: 1,
    title: 'A',
    views: 4,
    num_favorers: 2,
    price: { amount: 100 },
    listing_type: undefined,
    state: 'active',
    daily_views: null,
  });
});

test('order summary computes current order count, revenue and average once', () => {
  const receipts = [
    { current: true, create_timestamp: 1_700_000_000, grandtotal: { amount: 1200, divisor: 100 } },
    { current: true, create_timestamp: 1_700_000_000, grandtotal: { amount: 800, divisor: 100 } },
    { current: false, create_timestamp: 1_700_000_000, grandtotal: { amount: 9900, divisor: 100 } },
  ];
  const result = summarizeOrders(receipts, isCurrent);
  expect(result).toMatchObject({ total_orders: 2, total_revenue: 20, avg_order_value: 10 });
  expect(Object.values(result.revenue_by_day)).toEqual([20]);
});
