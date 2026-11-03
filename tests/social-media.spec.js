import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const LIVE_ID = `shmedia_${'a'.repeat(24)}`;
const DEAD_ID = `shmedia_${'b'.repeat(24)}`;
const OLD_HOST = 'https://legacy-media.example.test';

function mediaUrl(id) {
  return `${OLD_HOST}/api/social?action=mediaAsset&id=${id}`;
}

async function fulfillMediaRequest(route, requestedUrls) {
  const url = new URL(route.request().url());
  requestedUrls.push(url.toString());
  const recovered = url.searchParams.has('_ui_media_retry');
  if (url.searchParams.get('id') === LIVE_ID && recovered) {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#d45a25"/></svg>',
    });
    return;
  }
  await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) });
}

test('Schedule recovers live cached media but keeps a dead carousel URL visibly broken', async ({ page }) => {
  const requestedUrls = [];
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const posts = [
    {
      id: 'media-cache-recovery-live',
      caption: 'Live media cache recovery',
      platform: 'instagram',
      status: 'scheduled',
      scheduled_at: future,
      media_items: [{ url: mediaUrl(LIVE_ID), type: 'image' }],
    },
    {
      id: 'media-cache-recovery-dead',
      caption: 'Dead media remains diagnostic',
      platform: 'instagram',
      status: 'scheduled',
      scheduled_at: future,
      media_items: [
        { url: mediaUrl(DEAD_ID), type: 'image' },
        { url: mediaUrl(LIVE_ID), type: 'image' },
      ],
    },
  ];

  await page.route('**/api/kv', async route => {
    const body = route.request().postDataJSON?.() || {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: body.action === 'getScheduledPosts' ? posts : null }),
    });
  });
  await page.route('**/api/social**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.searchParams.get('action') === 'mediaAsset') {
      await fulfillMediaRequest(route, requestedUrls);
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, due: 0, scheduled: posts.length, published: 0, failed: 0 }),
    });
  });

  await page.goto('/#schedule');

  const liveTile = page.locator('[data-sched-post-card="media-cache-recovery-live"] [data-media-candidates]').first();
  await expect(liveTile).toHaveAttribute('data-media-loaded', '1');
  await expect(liveTile.locator('[data-broken-badge]')).toBeHidden();
  await expect(liveTile.locator('img')).toHaveJSProperty('naturalWidth', 32);

  const deadTile = page.locator('[data-sched-post-card="media-cache-recovery-dead"] [data-media-candidates]').first();
  await expect(deadTile).toHaveAttribute('data-media-broken', '1');
  await expect(deadTile).toHaveAttribute('data-media-attempts', '2');
  await expect(deadTile.locator('[data-broken-badge]')).toBeVisible();
  await expect(deadTile).toHaveAttribute('data-media-failed-url', new RegExp(DEAD_ID));
  expect(requestedUrls.some(value => value.includes(LIVE_ID) && value.includes('_ui_media_retry='))).toBe(true);
  expect(requestedUrls.filter(value => value.includes(DEAD_ID))).toHaveLength(2);
  expect(requestedUrls.some(value => value.startsWith(OLD_HOST))).toBe(false);
});

test('Social Hub retries a cached media error and reports a truly dead URL after bounded attempts', async ({ page }) => {
  const requestedUrls = [];
  const plan = {
    id: 'media-ui-regression-plan',
    summary: 'Media UI regression plan',
    notes: [],
    warnings: [],
    posts: [
      { platform: 'instagram', caption: 'Recovered media', scheduled_at: null, media_items: [{ url: mediaUrl(LIVE_ID), type: 'image' }] },
      { platform: 'facebook', caption: 'Dead media', scheduled_at: null, media_items: [{ url: mediaUrl(DEAD_ID), type: 'image' }] },
    ],
  };
  await page.addInitScript(cachedPlan => {
    localStorage.setItem('etsy_mgr_autopilot_plan_v1', JSON.stringify({ savedAt: Date.now(), plan: cachedPlan }));
  }, plan);
  await page.route('**/api/etsy**', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { count: 0, results: [] } }) });
  });
  await page.route('**/api/kv', async route => {
    const body = route.request().postDataJSON?.() || {};
    const data = body.action === 'getScheduledPosts' || body.action === 'getPosts' ? [] : {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  await page.route('**/api/social**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.searchParams.get('action') === 'mediaAsset') {
      await fulfillMediaRequest(route, requestedUrls);
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });

  await page.goto('/#social');

  const output = page.locator('#autopilot-output');
  await expect(output).toContainText('Media UI regression plan');
  const tiles = output.locator('[data-media-candidates]');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0)).toHaveAttribute('data-media-loaded', '1');
  await expect(tiles.nth(0).locator('img')).toHaveJSProperty('naturalWidth', 32);
  await expect(tiles.nth(1)).toHaveAttribute('data-media-broken', '1');
  await expect(tiles.nth(1)).toHaveAttribute('data-media-attempts', '3');
  await expect(tiles.nth(1)).toContainText('Media unavailable');
  expect(requestedUrls.filter(value => value.includes(DEAD_ID))).toHaveLength(3);
});
