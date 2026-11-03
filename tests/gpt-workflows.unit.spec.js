import { test, expect } from '@playwright/test';

import { bulkCreateDrafts, createCompleteDraft } from '../api/gpt/workflows.js';
import { resetEtsyTokenCacheForTests } from '../api/auth.js';

function json(data, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: status === 204 ? {} : { 'Content-Type': 'application/json' },
  });
}

test('createCompleteDraft forces draft state and returns a staged result', async () => {
  const previousFetch = global.fetch;
  const previous = { access: process.env.ETSY_ACCESS_TOKEN, refresh: process.env.ETSY_REFRESH_TOKEN, shop: process.env.ETSY_SHOP_ID };
  const calls = [];
  process.env.ETSY_ACCESS_TOKEN = 'test-access-token';
  process.env.ETSY_SHOP_ID = '123';
  resetEtsyTokenCacheForTests({ accessToken: 'test-access-token' });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return json({ listing_id: 456, state: 'draft' });
  };
  try {
    const result = await createCompleteDraft({
      shopId: 123,
      listing: { title: 'Draft', description: 'Description', price: 10, quantity: 1, taxonomy_id: 1, listing_type: 'download' },
      verify: false,
    });
    expect(result).toMatchObject({ success: true, listing_id: 456, state: 'draft' });
    const sent = JSON.parse(calls[0].options.body);
    expect(sent.state).toBe('draft');
  } finally {
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries({ ETSY_ACCESS_TOKEN: previous.access, ETSY_REFRESH_TOKEN: previous.refresh, ETSY_SHOP_ID: previous.shop })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('createCompleteDraft compensates by deleting a newly created draft after a stage failure', async () => {
  const previousFetch = global.fetch;
  const previous = { access: process.env.ETSY_ACCESS_TOKEN, shop: process.env.ETSY_SHOP_ID };
  const calls = [];
  process.env.ETSY_ACCESS_TOKEN = 'test-access-token';
  process.env.ETSY_SHOP_ID = '123';
  resetEtsyTokenCacheForTests({ accessToken: 'test-access-token' });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/shops/123/listings?legacy=false')) return json({ listing_id: 789 });
    if (String(url).includes('/listings/789/inventory')) return json({ error: 'bad inventory' }, 400);
    if (String(url).endsWith('/listings/789') && options.method === 'DELETE') return json(null, 204);
    return json({});
  };
  try {
    await expect(createCompleteDraft({
      shopId: 123,
      listing: { title: 'Draft', description: 'Description', price: 10, quantity: 1, taxonomy_id: 1, listing_type: 'download' },
      inventory: { products: [{ sku: '', property_values: [], offerings: [{ price: 10, quantity: 1, is_enabled: true }] }] },
      verify: false,
    })).rejects.toMatchObject({ code: 'COMPLETE_DRAFT_ROLLED_BACK' });
    expect(calls.some(call => call.method === 'DELETE' && call.url.endsWith('/listings/789'))).toBe(true);
  } finally {
    global.fetch = previousFetch;
    if (previous.access === undefined) delete process.env.ETSY_ACCESS_TOKEN; else process.env.ETSY_ACCESS_TOKEN = previous.access;
    if (previous.shop === undefined) delete process.env.ETSY_SHOP_ID; else process.env.ETSY_SHOP_ID = previous.shop;
  }
});

test('atomic complete draft deletes a newly created draft after an image upload stage failure', async () => {
  const previousFetch = global.fetch;
  const previous = { access: process.env.ETSY_ACCESS_TOKEN, shop: process.env.ETSY_SHOP_ID };
  const calls = [];
  process.env.ETSY_ACCESS_TOKEN = 'test-access-token';
  process.env.ETSY_SHOP_ID = '123';
  resetEtsyTokenCacheForTests({ accessToken: 'test-access-token' });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/shops/123/listings?legacy=false')) return json({ listing_id: 790 });
    if (String(url).endsWith('/listings/790') && options.method === 'DELETE') return json(null, 204);
    return json({});
  };
  try {
    await expect(createCompleteDraft({
      shopId: 123,
      listing: { title: 'Draft', description: 'Description', price: 10, quantity: 1, taxonomy_id: 1, listing_type: 'physical' },
      preparedFiles: [{ target: 'listing_image', buffer: Buffer.from('tiny-image'), mimeType: 'image/png', rank: 1 }],
      atomic: true,
      verify: false,
      uploadPreparedListingImageImpl: async () => { throw Object.assign(new Error('simulated image upload failure'), { status: 502 }); },
    })).rejects.toMatchObject({
      code: 'COMPLETE_DRAFT_ROLLED_BACK',
      workflow_result: { listing_id: 790, rollback: { attempted: true, succeeded: true } },
    });
    expect(calls.some(call => call.method === 'DELETE' && call.url.endsWith('/listings/790'))).toBe(true);
  } finally {
    global.fetch = previousFetch;
    if (previous.access === undefined) delete process.env.ETSY_ACCESS_TOKEN; else process.env.ETSY_ACCESS_TOKEN = previous.access;
    if (previous.shop === undefined) delete process.env.ETSY_SHOP_ID; else process.env.ETSY_SHOP_ID = previous.shop;
  }
});

test('bulk draft workflows are bounded before any Etsy write', async () => {
  await expect(bulkCreateDrafts({ shopId: 123, items: Array.from({ length: 11 }, () => ({ listing: {} })) })).rejects.toMatchObject({ code: 'WORKFLOW_LIMIT_EXCEEDED' });
});
