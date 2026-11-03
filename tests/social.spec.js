// Social Hub tests — listing selection, post generation (no actual publish)
import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

let socialRequestBodies = [];

test.beforeEach(async ({ page }) => {
  socialRequestBodies = [];
  const listing = {
    listing_id: '101',
    title: 'AI-ready test listing',
    description: 'A factual listing description for deterministic Social Hub browser tests.',
    price: { amount: 1200, divisor: 100, currency_code: 'USD' },
    views: 42,
    num_favorers: 7,
    images: [{ url_570xN: 'https://img.example.test/listing-101.jpg' }],
  };
  await page.route('**/api/etsy**', async route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const data = action === 'getAvailableShops'
      ? [{ id: 'test-shop', name: 'Test shop' }]
      : action === 'getListings'
        ? { count: 1, results: [listing] }
        : { results: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  await page.route('**/api/kv**', async route => {
    const body = route.request().postDataJSON?.() || {};
    const action = body.action || new URL(route.request().url()).searchParams.get('action');
    const data = action === 'getScheduledPosts'
      ? [
        { id: 'owner-review-1', platform: 'instagram', listing_id: '101', listing_title: 'AI-ready test listing', status: 'draft', created_at: new Date().toISOString(), approved_for_publish: false, metadata: { owner_review_required: true } },
        { id: 'owner-review-2', platform: 'facebook', listing_id: '101', listing_title: 'AI-ready test listing', status: 'draft', created_at: new Date().toISOString(), approved_for_publish: false, metadata: { owner_review_required: true } },
      ]
      : action === 'getPosts' ? [] : action === 'getSocialConfigs' ? {} : null;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  await page.route('**/api/social**', async route => {
    const body = route.request().postDataJSON?.() || {};
    socialRequestBodies.push(body);
    if (body.action === 'adminAutopilotContext') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            generated_at: new Date().toISOString(),
            listings: [{
              ...listing,
              image_url: 'https://img.example.test/listing-101.jpg',
              image_urls: ['https://img.example.test/listing-101.jpg'],
              media_items: [{ url: 'https://img.example.test/listing-101.jpg', type: 'image' }],
              recent_orders: 2,
              recent_units: 2,
              recent_revenue_usd: 24,
              last_order_at: new Date(Date.now() - 86400000).toISOString(),
            }],
            reviews: [{ review_id: 'review-1', listing_id: '101', rating: 5, text: 'Looks great.' }],
            stats: { active_listings: 1, recent_orders: 2, recent_revenue_usd: 24 },
            factual_changes: { sales_delta: 1 },
            discounts: [],
            collection_diagnostics: {},
            errors: [],
          },
        }),
      });
      return;
    }
    if (body.action === 'adminGenerateMedia') {
      const frame = String(body.prompt || '').includes('first frame') ? 'first' : 'second';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            images: [{
              url: `/api/social?action=mediaAsset&id=${frame}`,
              permanent: true,
              source: 'generated_image',
              checksum_sha256: frame.repeat(16).slice(0, 64),
            }],
          },
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.action === 'checkConfig' ? {} : { success: true }) });
  });
  await page.route('**/api/ai**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: {
        pinterest: 'A Pinterest caption for the test listing. https://www.etsy.com/listing/101',
        instagram: 'A specific Instagram caption for the test listing. #EtsyShop',
        facebook: 'A conversational Facebook caption. https://www.etsy.com/listing/101',
        tiktok: 'A short TikTok draft. #Etsy',
      } }),
    });
  });
  await page.goto('/#social');
  await expect(page.locator('.sidebar-brand')).toBeVisible();
  // Wait for listing selector to load listings
  await expect(page.locator('#listing-select')).toBeVisible({ timeout: 15_000 });
  // Wait for clickable listing rows to render
  await expect(page.locator('#listing-select [data-lid]').first()).toBeVisible({ timeout: 20_000 });
});

test('listing selector loads with options', async ({ page }) => {
  const listingRows = page.locator('#listing-select [data-lid]');
  await expect(listingRows.first()).toBeVisible();
  const rowCount = await listingRows.count();
  expect(rowCount).toBeGreaterThan(0);
});

test('owner-review drafts are visible in paginated Social Hub history', async ({ page }) => {
  const history = page.locator('#post-history');
  await expect(history).toContainText('Needs review: 2');
  await page.locator('#history-status-filter').selectOption('owner_review');
  await expect(history.getByRole('link', { name: 'Review in Schedule' })).toHaveCount(2);
  await expect(history.locator('a[href="/schedule?preview_id=owner-review-1"]')).toBeVisible();
  await expect(history.locator('a[href="/schedule?preview_id=owner-review-2"]')).toBeVisible();
});

test('legacy Social Hub generation and direct-publish controls are retired', async ({ page }) => {
  await expect(page.locator('#autopilot-card')).toHaveCount(0);
  await expect(page.locator('#gen-social-btn')).toHaveCount(0);

  await page.locator('#listing-select [data-lid]').first().click();
  await expect(page.locator('.platform-card')).toHaveCount(4);
  await expect(page.locator('[data-gen-btn]')).toHaveCount(0);
  await expect(page.locator('[id^="pub-btn-"]')).toHaveCount(0);
  await expect(page.locator('[id^="xpost-toggle-"]')).toHaveCount(0);
  await expect(page.locator('[id^="vid-text-btn-"]')).toHaveCount(0);
  await expect(page.locator('[onclick="window.publishAll()"]')).toHaveCount(0);
});

test('retired Social Hub entry points fail closed without calling legacy AI or publish routes', async ({ page }) => {
  await page.locator('#listing-select [data-lid]').first().click();
  await page.evaluate(async () => {
    await window.generateAllPosts?.();
    await window.runContentAutopilot?.();
    await window.publishToPlatform?.('instagram');
    await window.sendToCrosspost?.('make');
  });
  expect(socialRequestBodies.filter(body => ['adminGenerateMedia', 'postMake', 'postInstagram', 'postFacebook'].includes(body.action))).toHaveLength(0);
});
