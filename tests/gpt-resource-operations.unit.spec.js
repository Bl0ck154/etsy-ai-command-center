import { test, expect } from '@playwright/test';

import { resetEtsyTokenCacheForTests } from '../api/auth.js';
import {
  deleteListingMediaResource,
  manageAdvancedListingResource,
  manageListingMedia,
  manageShopResource,
  readEtsyResource,
  readFinancialResource,
} from '../api/gpt/resource-operations.js';

function ok(data = { ok: true }) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function capture(run) {
  const previousFetch = global.fetch;
  const calls = [];
  resetEtsyTokenCacheForTests({ accessToken: 'gpt-resource-test-token' });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return ok();
  };
  try {
    await run(calls);
  } finally {
    global.fetch = previousFetch;
    resetEtsyTokenCacheForTests();
  }
}

test('readEtsyResource routes only enumerated production-partner and product reads', async () => {
  await capture(async calls => {
    await readEtsyResource({ shopId: 123, body: { action: 'production_partners' } });
    await readEtsyResource({ shopId: 123, body: { action: 'listing_product', listing_id: 456, product_id: 789 } });
    expect(new URL(calls[0].url).pathname).toBe('/v3/application/shops/123/production-partners');
    expect(new URL(calls[1].url).pathname).toBe('/v3/application/listings/456/inventory/products/789');
    await expect(readEtsyResource({ shopId: 123, body: { action: 'arbitrary_proxy', url: 'http://127.0.0.1' } })).rejects.toThrow(/unsupported read action/i);
  });
});

test('manageShopResource sends strict form bodies to allowlisted shipping and return endpoints', async () => {
  await capture(async calls => {
    await manageShopResource({
      shopId: 123,
      body: {
        action: 'create_shipping_profile',
        data: { title: 'Domestic', origin_country_iso: 'UA', destination_country_iso: 'US', primary_cost: 5, secondary_cost: 2, min_delivery_days: 2, max_delivery_days: 5 },
      },
    });
    const shipping = calls[0];
    expect(new URL(shipping.url).pathname).toBe('/v3/application/shops/123/shipping-profiles');
    expect(shipping.options.method).toBe('POST');
    expect(shipping.options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(shipping.options.body).get('title')).toBe('Domestic');

    await manageShopResource({
      shopId: 123,
      body: { action: 'consolidate_return_policies', source_return_policy_id: 11, destination_return_policy_id: 22 },
    });
    expect(new URL(calls[1].url).pathname).toBe('/v3/application/shops/123/policies/return/consolidate');

    await manageShopResource({ shopId: 123, body: { action: 'create_section', data: { title: 'Portraits' } } });
    expect(new URL(calls[2].url).pathname).toBe('/v3/application/shops/123/sections');
    expect(calls[2].options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(calls[2].options.body).get('title')).toBe('Portraits');
  });
});

test('advanced listing and media groups enforce draft checks and exact resource paths', async () => {
  await capture(async calls => {
    const drafts = [];
    const ensureDraft = async listingId => drafts.push(Number(listingId));
    await manageAdvancedListingResource({
      shopId: 123,
      ensureDraft,
      body: { action: 'update_translation', listing_id: 456, language: 'de', data: { title: 'Titel', description: 'Beschreibung' } },
    });
    await deleteListingMediaResource({
      shopId: 123,
      ensureDraft,
      body: { action: 'delete_image', listing_id: 456, image_id: 77 },
    });
    expect(drafts).toEqual([456, 456]);
    expect(new URL(calls[0].url).pathname).toBe('/v3/application/shops/123/listings/456/translations/de');
    expect(calls[0].options.method).toBe('PUT');
    expect(new URL(calls[1].url).pathname).toBe('/v3/application/shops/123/listings/456/images/77');
    expect(calls[1].options.method).toBe('DELETE');
  });
});

test('translation and property contracts fail closed and singular properties use the supported collection', async () => {
  await capture(async calls => {
    const ensureDraft = async () => {};
    await expect(manageAdvancedListingResource({
      shopId: 123,
      ensureDraft,
      body: { action: 'update_translation', listing_id: 456, language: 'de', data: { title: 'Titel' } },
    })).rejects.toThrow(/description is required/i);
    await expect(manageAdvancedListingResource({
      shopId: 123,
      ensureDraft,
      body: { action: 'upsert_property', listing_id: 456, property_id: 10, data: { value_ids: [20] } },
    })).rejects.toThrow(/values is required/i);

    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return ok({ count: 2, results: [{ property_id: 9 }, { property_id: 10, values: ['Blue'] }] });
    };
    const property = await readEtsyResource({
      shopId: 123,
      body: { action: 'listing_property', listing_id: 456, property_id: 10 },
    });
    expect(property).toMatchObject({ property_id: 10, values: ['Blue'] });
    expect(new URL(calls.at(-1).url).pathname).toBe('/v3/application/shops/123/listings/456/properties');
  });
});

test('readFinancialResource uses documented ledger endpoints and required time bounds', async () => {
  await capture(async calls => {
    await readFinancialResource({
      shopId: 123,
      body: { action: 'ledger_entries', min_created: 1_700_000_000, max_created: 1_700_086_400, limit: 10 },
    });
    const upstream = new URL(calls[0].url);
    expect(upstream.pathname).toBe('/v3/application/shops/123/payment-account/ledger-entries');
    expect(upstream.searchParams.get('min_created')).toBe('1700000000');
    expect(upstream.searchParams.get('max_created')).toBe('1700086400');
    expect(upstream.searchParams.get('limit')).toBe('10');
  });
});
