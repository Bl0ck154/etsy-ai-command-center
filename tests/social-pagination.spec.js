import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

function listing(index) {
  return {
    listing_id: String(index),
    title: `Listing ${String(index).padStart(3, '0')}`,
    price: { amount: 1200 + index, divisor: 100, currency_code: 'USD' },
    views: index * 2,
    num_favorers: index,
    images: [],
  };
}

test('Social Hub paginates the complete listing catalog and post history', async ({ page }) => {
  const listings = Array.from({ length: 205 }, (_, index) => listing(index + 1));
  const history = Array.from({ length: 35 }, (_, index) => ({
    _id: `history-${index + 1}`,
    postedAt: Date.now() - index * 60_000,
    listing_id: index + 1,
    listing_title: `History listing ${index + 1}`,
    platform: index % 2 ? 'facebook' : 'instagram',
    service: 'direct',
    status: index % 3 ? 'published' : 'queued_external',
  }));
  const listingOffsets = [];

  await page.route('**/api/etsy**', async route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    if (action === 'getListings') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 100);
      listingOffsets.push(offset);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { count: listings.length, results: listings.slice(offset, offset + limit) } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { results: [] } }) });
  });

  await page.route('**/api/kv**', async route => {
    const request = route.request();
    const action = request.method() === 'POST'
      ? String((request.postDataJSON?.() || {}).action || '')
      : new URL(request.url()).searchParams.get('action');
    const data = action === 'getPosts' ? history : action === 'getSocialConfigs' ? {} : null;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });

  await page.route('**/api/social**', async route => {
    const body = route.request().postDataJSON?.() || {};
    const data = body.action === 'checkConfig' ? {} : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });

  await page.goto('/#social');

  const listingPanel = page.locator('#listing-select');
  await expect.poll(() => listingOffsets.length).toBe(3);
  await expect(listingPanel.locator('[data-lid]')).toHaveCount(20);
  await expect(page.locator('#listing-pagination')).toContainText('1-20 of 205');
  expect(listingOffsets).toEqual([0, 100, 200]);

  await page.locator('#listing-pagination').getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('#listing-pagination')).toContainText('21-40 of 205');
  await expect(listingPanel.locator('[data-lid="21"]')).toBeVisible();

  await page.evaluate(() => window.__socialListingPage(11));
  await expect(listingPanel.locator('[data-lid]')).toHaveCount(5);
  await expect(page.locator('#listing-pagination')).toContainText('201-205 of 205');

  await page.locator('#listing-search').fill('Listing 205');
  await expect(listingPanel.locator('[data-lid]')).toHaveCount(1);
  await expect(listingPanel.locator('[data-lid="205"]')).toBeVisible();

  const historyPanel = page.locator('#post-history');
  await expect(historyPanel.locator('[data-social-history-item]')).toHaveCount(10);
  await expect(historyPanel).toContainText('1-10 of 35');
  await historyPanel.getByRole('button', { name: 'Next page' }).click();
  await expect(historyPanel).toContainText('11-20 of 35');
  await expect(historyPanel.locator('[data-social-history-item]')).toHaveCount(10);
});
