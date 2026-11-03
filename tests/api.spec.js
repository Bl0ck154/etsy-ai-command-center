// API health tests — verify backend endpoints return valid responses
import { test, expect } from '@playwright/test';

test('GET /api/auth returns valid token status', async ({ request }) => {
  const res = await request.get('/api/auth');
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data).toHaveProperty('valid');
  expect(data.valid).toBe(true);
});

test('GET /api/etsy?action=getShop returns shop data', async ({ request }) => {
  const res = await request.get('/api/etsy?action=getShop');
  expect(res.status()).toBe(200);
  const body = await res.json();
  // Response is wrapped: { success, data: { shop_id, ... } }
  const shop = body.data ?? body;
  expect(shop).toHaveProperty('shop_id');
  expect(shop.shop_id).toBeTruthy();
  expect(shop).toHaveProperty('shop_name');
});

test('GET /api/etsy?action=getListings returns listings array', async ({ request }) => {
  const res = await request.get('/api/etsy?action=getListings&limit=5');
  expect(res.status()).toBe(200);
  const body = await res.json();
  const payload = body.data ?? body;
  expect(payload).toHaveProperty('results');
  expect(Array.isArray(payload.results)).toBe(true);
  expect(payload.results.length).toBeGreaterThan(0);
  // Each listing has required fields
  const listing = payload.results[0];
  expect(listing).toHaveProperty('listing_id');
  expect(listing).toHaveProperty('title');
  expect(listing).toHaveProperty('state');
});

test('GET /api/etsy?action=getShippingProfiles returns profiles', async ({ request }) => {
  const res = await request.get('/api/etsy?action=getShippingProfiles');
  expect(res.status()).toBe(200);
  const body = await res.json();
  const payload = body.data ?? body;
  expect(payload).toHaveProperty('results');
  expect(Array.isArray(payload.results)).toBe(true);
});

test('GET /api/etsy?action=getShopSections returns sections', async ({ request }) => {
  const res = await request.get('/api/etsy?action=getShopSections');
  expect(res.status()).toBe(200);
  const body = await res.json();
  const payload = body.data ?? body;
  expect(payload).toHaveProperty('results');
  expect(Array.isArray(payload.results)).toBe(true);
});

test('GET /api/etsy?action=getReviews returns reviews page URL and results', async ({ request }) => {
  const res = await request.get('/api/etsy?action=getReviews&limit=5&offset=0');
  expect(res.status()).toBe(200);
  const body = await res.json();
  const payload = body.data ?? body;
  expect(payload).toHaveProperty('results');
  expect(Array.isArray(payload.results)).toBe(true);
  expect(payload.reviews_page_url).toMatch(/^https:\/\/www\.etsy\.com\/shop\/.+\/reviews$/);
  expect(payload.response_status_source).toBe('not_available_in_etsy_open_api');
  expect(payload.review_media_source).toBe('etsy_open_api');
});

test('POST /api/ai returns AI listing object', async ({ request }) => {
  const res = await request.post('/api/ai', {
    timeout: 60_000,
    data: {
      type: 'listing',
      provider: 'gemini',
      productType: 'digital',
      description: 'Watercolour floral clipart set, PNG, instant download',
      price: '4.99',
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  const listing = body.data;
  expect(listing).toHaveProperty('title');
  expect(listing).toHaveProperty('description');
  expect(listing).toHaveProperty('tags');
  expect(Array.isArray(listing.tags)).toBe(true);
  expect(listing.tags.length).toBe(13);
  expect(listing.title.length).toBeLessThanOrEqual(140);
});

test('POST /api/ai social post generation works', async ({ request }) => {
  const res = await request.post('/api/ai', {
    timeout: 60_000,
    data: {
      type: 'social',
      provider: 'gemini',
      _thinkingLevel: 'NONE',   // disable Gemini thinking to keep this API smoke within its timeout
      title: 'Watercolour Floral Clipart Bundle',
      description: 'Beautiful hand-painted florals, instant download',
      price: '4.99',
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  const posts = body.data;
  // data can be parsed object or raw string (if Gemini returned non-parseable JSON)
  if (typeof posts === 'object') {
    const hasPost = ['pinterest', 'instagram', 'facebook', 'tiktok'].some(p => posts[p]);
    expect(hasPost).toBe(true);
  } else {
    // At minimum it returned some text
    expect(typeof posts).toBe('string');
    expect(posts.length).toBeGreaterThan(20);
  }
});
