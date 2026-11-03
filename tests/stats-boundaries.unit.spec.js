import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../api/stats.js', import.meta.url), 'utf8');
const application = fs.readFileSync(new URL('../api/stats/application.js', import.meta.url), 'utf8');
const analytics = fs.readFileSync(new URL('../api/stats/analytics.js', import.meta.url), 'utf8');

test('stats route delegates analytics instead of calculating receipt/listing totals', () => {
  expect(route).toContain("from './stats/application.js'");
  expect(route).toContain('statsApplication.getRevenue');
  expect(route).toContain('statsApplication.getListingStats');
  expect(route).toContain('statsApplication.getOrderStats');
  expect(route).not.toContain('grandtotal?.amount');
  expect(route).not.toContain('transactions || []');
  expect(route).not.toContain('totalRevenue +=');
});

test('application owns Etsy paths while analytics stays provider-independent', () => {
  expect(application).toContain('/shops/${currentShopId}/receipts');
  expect(application).toContain('/shops/${currentShopId}/listings');
  expect(analytics).not.toContain('etsyFetch');
  expect(analytics).not.toContain('/shops/');
});
