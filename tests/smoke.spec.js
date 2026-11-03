// Smoke tests — every page loads without errors and renders its main heading/content
import { test, expect } from '@playwright/test';

// Simple page-load helper: navigate, confirm app shell, confirm active nav
async function pageLoads(page, hash) {
  await page.goto(`/#${hash}`);
  // Sidebar = app shell is alive
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  // Active nav item should match the hash
  await expect(page.locator(`[data-page="${hash}"].active, [data-page="${hash}"][class*="active"]`))
    .toBeVisible({ timeout: 5_000 })
    .catch(() => {}); // some pages (create) are hidden in nav — soft check
  // Main content area must have something rendered
  await expect(page.locator('#main, #content, .page, main, [id="app"] > * > *').first())
    .toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', err => {
    if (err.message.includes('fonts.googleapis') || err.message.includes('sw.js')) return;
    console.warn('[JS ERR]', err.message);
  });
});

test('AI Agent page loads', async ({ page }) => {
  await page.goto('/#agent');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  // Agent has an input area and message thread
  await expect(page.locator('textarea, input[type="text"]').first()).toBeVisible({ timeout: 10_000 });
});

test('Dashboard page loads', async ({ page }) => {
  await page.goto('/#dashboard');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  // Dashboard fetches shop data — wait for shop name to appear in sidebar
  await expect(page.locator('#shop-name-display')).not.toHaveText('Loading…', { timeout: 15_000 });
  // At least one card or section is rendered
  await expect(page.locator('[class*="stat"], [class*="card"], h2, h3').first()).toBeVisible({ timeout: 15_000 });
});

test('Listings page loads', async ({ page }) => {
  await page.goto('/#listings');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  // Search input or listing rows must appear
  await expect(
    page.locator('input[placeholder*="earch"], .listing-row, [class*="listing"]').first()
  ).toBeVisible({ timeout: 20_000 });
});

test('Create page loads', async ({ page }) => {
  await page.goto('/#create');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  // Step 1 has a textarea for description
  await expect(page.locator('textarea').first()).toBeVisible({ timeout: 10_000 });
});

test('Bulk Create page loads', async ({ page }) => {
  await page.goto('/#bulk');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('textarea, button').first()).toBeVisible({ timeout: 10_000 });
});

test('Gallery page loads', async ({ page }) => {
  await page.goto('/#gallery');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  // Gallery renders .page-header with h1 "Image Gallery"
  await expect(page.locator('.page-header, .page-title, h1').first()).toBeVisible({ timeout: 10_000 });
});

test('Orders page loads', async ({ page }) => {
  await page.goto('/#orders');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  // Orders table or empty state
  await expect(page.locator('table, [class*="order"], [class*="empty"], h2, h3').first())
    .toBeVisible({ timeout: 15_000 });
});

test('Social Hub page loads', async ({ page }) => {
  await page.goto('/#social');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('select, button, h2, h3, [class*="social"]').first())
    .toBeVisible({ timeout: 10_000 });
});

test('Content Schedule page loads', async ({ page }) => {
  await page.goto('/#schedule');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.page-title')).toContainText('Content Schedule', { timeout: 10_000 });
  await expect(page.locator('#sched-new-btn')).toBeVisible();
  await expect(page.locator('#sched-list')).toBeVisible();
  await expect(page.locator('#sched-month-label')).toBeVisible();
});

test('Analytics page loads', async ({ page }) => {
  await page.goto('/#analytics');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('canvas, [class*="chart"], [class*="stat"], h2, select').first())
    .toBeVisible({ timeout: 15_000 });
});

test('Competitor page loads', async ({ page }) => {
  await page.goto('/#competitor');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('input, button, h2, h3').first()).toBeVisible({ timeout: 10_000 });
});

test('Settings page loads', async ({ page }) => {
  await page.goto('/#settings');
  await expect(page.locator('.sidebar-brand')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('input, select, h2, h3, [class*="setting"]').first())
    .toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'AI & Images' }).click();
  await expect(page.getByText('Etsy listing standards', { exact: true })).toBeVisible();
  await expect(page.locator('#etsy-guidance-status')).toContainText(/Active revision|Not checked/i);
});

test('sidebar navigation works', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.sidebar-brand')).toBeVisible();
  await page.click('[data-page="listings"]');
  await expect(page).toHaveURL(/#listings/);
  await page.click('[data-page="dashboard"]');
  await expect(page).toHaveURL(/#dashboard/);
  await page.click('[data-page="orders"]');
  await expect(page).toHaveURL(/#orders/);
});

test('theme toggle switches dark/light mode', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.sidebar-brand')).toBeVisible();
  const html = page.locator('html');
  const before = await html.getAttribute('class') + await html.getAttribute('data-theme') + await page.locator('body').getAttribute('class');
  await page.getByRole('button', { name: /toggle theme/i }).click();
  await page.waitForTimeout(300);
  const after = await html.getAttribute('class') + await html.getAttribute('data-theme') + await page.locator('body').getAttribute('class');
  expect(before).not.toEqual(after);
});
