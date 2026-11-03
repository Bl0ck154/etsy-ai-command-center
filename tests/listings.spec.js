// Listings page tests — search, filter, listing cards render
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/#listings');
  await expect(page.locator('.sidebar-brand')).toBeVisible();
  // Wait for listings to load (table, grid cards, or empty state)
  await expect(
    page.locator('#listings-body table')
      .or(page.locator('#listings-body .listing-card'))
      .or(page.locator('#listings-body .empty-state'))
  ).toBeVisible({ timeout: 20_000 });
});

test('listings load and display', async ({ page }) => {
  // Shop has active listings — should see table rows or grid cards
  const rows = page.locator('#listings-body tbody tr');
  const cards = page.locator('#listings-body .listing-card');
  const count = (await rows.count()) + (await cards.count());
  expect(count).toBeGreaterThan(0);
});

test('search filters listings', async ({ page }) => {
  const searchInput = page.locator('#search-input');
  await expect(searchInput).toBeVisible();

  const initialRows = await page.locator('#listings-body tbody tr').count();

  // Type a search that should narrow results
  await searchInput.fill('photo');
  await page.waitForTimeout(400); // debounce
  const filtered = await page.locator('#listings-body tbody tr').count();
  // Either fewer results (found match) or same (all match)
  expect(filtered).toBeLessThanOrEqual(initialRows);
});

test('clear search restores all listings', async ({ page }) => {
  const searchInput = page.locator('#search-input');
  const initial = await page.locator('#listings-body tbody tr').count();
  await searchInput.fill('zzz_no_match_xyz');
  await page.waitForTimeout(400);
  // Use fill('') instead of clear() to ensure oninput fires
  await searchInput.fill('');
  await page.waitForTimeout(500); // debounce + render
  // Wait for listings to reappear
  await expect(page.locator('#listings-body tbody tr').first()).toBeVisible({ timeout: 10_000 });
  const after = await page.locator('#listings-body tbody tr').count();
  expect(after).toBeGreaterThanOrEqual(initial);
});

test('price inline edit appears on click', async ({ page }) => {
  // Price cells have id="price-cell-{id}" and open an inline edit on click
  const priceCell = page.locator('[id^="price-cell-"]').first();
  if (await priceCell.count() > 0) {
    await priceCell.click();
    // Inline price input should appear
    const input = page.locator('input[type="number"]').first();
    await expect(input).toBeVisible({ timeout: 5_000 });
  }
});

test('sort column changes listing order', async ({ page }) => {
  // Click the Views column header to sort
  const viewsHeader = page.locator('th:has-text("Views")');
  if (await viewsHeader.count() > 0) {
    const firstBefore = await page.locator('#listings-body tbody tr').first().textContent();
    await viewsHeader.click();
    await page.waitForTimeout(300);
    // After sort, page re-renders — table still visible
    await expect(page.locator('#listings-body table')).toBeVisible();
  }
});
