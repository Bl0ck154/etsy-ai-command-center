// Dashboard tests — stats load, top listings table renders
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/#dashboard');
  await expect(page.locator('.sidebar-brand')).toBeVisible();
});

test('stats cards render', async ({ page }) => {
  // At least one stat card must appear
  const cards = page.locator('.stat-card, .stats-grid > div, [class*="stat"]');
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
});

test('top listings table loads', async ({ page }) => {
  // top-listings-wrap shows either a table (has listings) or .empty-state
  await expect(
    page.locator('#top-listings-wrap table').or(page.locator('#top-listings-wrap .empty-state'))
  ).toBeVisible({ timeout: 20_000 });
});

test('shop name appears in sidebar', async ({ page }) => {
  const shopName = page.locator('#shop-name-display');
  await expect(shopName).toBeVisible();
  // Should not still say "Loading…" after data is ready
  await expect(shopName).not.toHaveText('Loading…', { timeout: 15_000 });
});

test('recent orders section renders', async ({ page }) => {
  // recent-orders-wrap shows either a table (has orders) or .empty-state
  await expect(
    page.locator('#recent-orders-wrap table').or(page.locator('#recent-orders-wrap .empty-state'))
  ).toBeVisible({ timeout: 20_000 });
});
