import { expect, test } from '@playwright/test';

import socialHandler, {
  buildSocialHermesSnapshotFacts as snapshotFactsFromFacade,
  mergeSocialHermesSourceSnapshots as mergeSnapshotsFromFacade,
  safeSocialHermesContextPayload as safeContextFromFacade,
} from '../api/social.js';
import {
  buildSocialHermesSnapshotFacts,
  collectSocialHermesEtsyPages,
  createSocialContextService,
  createSocialContextSources,
  mergeSocialHermesSourceSnapshots,
  safeSocialHermesContextPayload,
  SOCIAL_HERMES_ACTION_NAMES,
  SOCIAL_HERMES_CONTEXT_CACHE_TTL_SECONDS,
  summarizeSocialHermesReview,
} from '../api/modules/social/index.js';
import { suggestSocialContentOpportunities } from '../api/_social-creative-planner.js';

const FIXED_NOW = new Date('2026-08-09T12:00:00.000Z');

function completeProvenance(source, observedAt = FIXED_NOW.toISOString()) {
  return {
    source,
    status: 'complete',
    current_fetch_complete: true,
    truncated: false,
    data_complete: true,
    data_truncated: false,
    data_available: true,
    used_last_known_good: false,
    fetched_at: observedAt,
    data_observed_at: observedAt,
  };
}

function failedProvenance(source) {
  return {
    source,
    status: 'failed',
    current_fetch_complete: false,
    truncated: null,
    data_complete: false,
    data_truncated: null,
    data_available: false,
    used_last_known_good: false,
    fetched_at: FIXED_NOW.toISOString(),
    data_observed_at: null,
    error: `${source} unavailable`,
  };
}

function completeSocialHermesSourceProvenance(observedAt) {
  return Object.fromEntries(['listings', 'receipts', 'reviews'].map(source => [source, completeProvenance(source, observedAt)]));
}

function mockResponse() {
  const captured = { statusCode: 200, payload: null };
  return {
    captured,
    res: {
      status(code) { captured.statusCode = code; return this; },
      json(payload) { captured.payload = payload; return payload; },
      end(payload) { captured.payload = payload ?? captured.payload; return payload; },
      setHeader() {},
    },
  };
}

test('public context contracts preserve facade behavior and one canonical action trust list', () => {
  const scheduledPosts = [{ id: 'draft-1', status: 'draft', platform: 'instagram' }];
  const input = { scheduledPosts, ownerTelegramUserId: 'owner-1' };
  const modulePayload = safeSocialHermesContextPayload(input);

  expect(safeContextFromFacade(input)).toEqual(modulePayload);
  expect(modulePayload.bridge.safe_actions).toEqual(SOCIAL_HERMES_ACTION_NAMES);
  expect(new Set(modulePayload.bridge.safe_actions).size).toBe(SOCIAL_HERMES_ACTION_NAMES.length);
  expect(modulePayload.bridge.safe_actions).toContain('context');
  expect(modulePayload.bridge.safe_actions).toContain('refreshShopContext');

  const current = {
    generated_at: FIXED_NOW.toISOString(),
    listings: [],
    receipt_signals: [],
    reviews: [],
    source_provenance: Object.fromEntries(['listings', 'receipts', 'reviews'].map(source => [source, completeProvenance(source)])),
  };
  expect(mergeSnapshotsFromFacade(null, current)).toEqual(mergeSocialHermesSourceSnapshots(null, current));
  expect(snapshotFactsFromFacade(null, current)).toEqual(buildSocialHermesSnapshotFacts(null, current));
});

test('Etsy context source adapter collects current listing, paid-order, review and discount facts only', async () => {
  const requests = [];
  const sources = createSocialContextSources({
    shopId: () => 'shop-1',
    env: {},
    clock: () => FIXED_NOW,
    fetchEtsy: async path => {
      requests.push(path);
      if (path.includes('/receipts?')) return {
        count: 1,
        results: [{
          receipt_id: 1,
          is_paid: true,
          create_timestamp: 1_754_740_800,
          transactions: [{ listing_id: 101, quantity: 2, title: 'Portrait', price: { amount: 2500, divisor: 100 } }],
        }],
      };
      if (path.includes('/listings?state=active')) return {
        count: 1,
        results: [{
          listing_id: 101,
          title: 'Custom Portrait',
          description: 'Factual listing description',
          state: 'active',
          views: 40,
          num_favorers: 5,
          images: [{ listing_image_id: 7, url_fullxfull: 'https://img.example.test/portrait.jpg', rank: 1 }],
        }],
      };
      if (path.includes('/reviews?')) return {
        count: 1,
        results: [{ listing_id: 101, rating: 5, review: 'Looks exactly like our family.', buyer_email: 'private@example.test' }],
      };
      if (path.includes('/discounts?')) return { results: [{ discount_id: 9, discount_name: 'Summer', discount_value: 10, seller_active: true }] };
      throw new Error(`Unexpected Etsy path: ${path}`);
    },
  });

  const context = await sources.collect();

  expect(context.source_provenance).toMatchObject({
    listings: { status: 'complete', current_fetch_complete: true },
    receipts: { status: 'complete', current_fetch_complete: true },
    reviews: { status: 'complete', current_fetch_complete: true },
  });
  expect(context.listings[0]).toMatchObject({
    listing_id: '101',
    recent_orders: 1,
    recent_units: 2,
    recent_revenue_usd: 50,
    image_url: 'https://img.example.test/portrait.jpg',
  });
  expect(context.reviews[0]).toMatchObject({ listing_id: '101', rating: 5, text: 'Looks exactly like our family.' });
  expect(context.reviews[0]).not.toHaveProperty('buyer_email');
  expect(context.discounts).toEqual([expect.objectContaining({ discount_id: 9, name: 'Summer' })]);
  expect(requests).toHaveLength(4);
});

test('context service retains verified last-known-good evidence, records TTL and fails closed without false deltas', async () => {
  const previous = {
    generated_at: '2026-08-08T12:00:00.000Z',
    listings: [{ listing_id: '101', title: 'Known listing', views: 20, num_favorers: 3, recent_orders: 2, recent_units: 2, recent_revenue_usd: 50 }],
    receipt_signals: [{ listing_id: '101', recent_orders: 2, recent_units: 2, recent_revenue_usd: 50 }],
    stats: { paid_receipts_scanned: 2 },
    reviews: [{ review_id: 'review-1', listing_id: '101', rating: 5, text: 'Known review' }],
    source_provenance: Object.fromEntries(['listings', 'receipts', 'reviews'].map(source => [source, completeProvenance(source, '2026-08-08T12:00:00.000Z')])),
  };
  const fetched = {
    generated_at: FIXED_NOW.toISOString(),
    listings: [],
    receipt_signals: [],
    stats: null,
    reviews: [],
    discounts: [],
    errors: [],
    source_provenance: Object.fromEntries(['listings', 'receipts', 'reviews'].map(source => [source, failedProvenance(source)])),
  };
  const saves = [];
  let exposeCachedValue = true;
  const service = createSocialContextService({
    collectFactualContext: async () => fetched,
    getScheduledPosts: async () => [],
    loadValue: async key => {
      if (key === 'social_autonomous_context') return exposeCachedValue ? previous : null;
      if (key === 'shop_operating_context') return { api_token: 'must-redact' };
      return null;
    },
    saveValue: async (...args) => { saves.push(args); throw new Error('cache unavailable'); },
    getPublishGovernance: () => ({ mode: 'approved-schedule', autopublish_enabled: false }),
    logger: { warn() {} },
  });

  const refreshed = await service.refreshShopContext();
  expect(refreshed.listings).toHaveLength(1);
  expect(refreshed.source_provenance.listings).toMatchObject({ status: 'failed', used_last_known_good: true, data_complete: true });
  expect(refreshed.factual_changes).toMatchObject({
    status: 'comparison_unavailable',
    comparison_provenance: { listings: false, receipts: false, reviews: false },
    new_listings: [],
    new_reviews: [],
  });
  expect(refreshed.factual_changes.totals_delta.views).toBeNull();
  expect(saves).toEqual([['social_autonomous_context', refreshed, SOCIAL_HERMES_CONTEXT_CACHE_TTL_SECONDS]]);

  exposeCachedValue = false;
  const safe = await service.getSafeContext('owner-1');
  expect(safe.autonomous_context).toEqual(refreshed);
  expect(safe.shop_context.api_token).toBe('[redacted]');
});

test('HTTP context and refreshShopContext actions preserve wrapper payloads and fail closed on unavailable Etsy sources', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    SOCIAL_HERMES_API_TOKEN: process.env.SOCIAL_HERMES_API_TOKEN,
    SOCIAL_HERMES_OWNER_TELEGRAM_ID: process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  };
  process.env.SOCIAL_HERMES_API_TOKEN = 'context-bridge-token';
  process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID = 'owner-1';
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  const values = new Map([
    ['default:shop_operating_context', encodeURIComponent(JSON.stringify({ shop_name: 'Current shop', access_token: 'hide-me' }))],
  ]);
  global.fetch = async url => {
    const parsed = new URL(String(url));
    if (parsed.hostname !== 'kv.example.test') throw new Error('Etsy unavailable in fail-closed characterization');
    const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    if (command === 'GET') return new Response(JSON.stringify({ result: values.get(key) ?? null }), { status: 200 });
    if (command === 'LRANGE') return new Response(JSON.stringify({ result: [] }), { status: 200 });
    if (command === 'SET') { values.set(key, parts[2] || ''); return new Response(JSON.stringify({ result: 'OK' }), { status: 200 }); }
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  };

  try {
    const contextResponse = mockResponse();
    await socialHandler({ method: 'POST', headers: { authorization: 'Bearer context-bridge-token' }, query: {}, body: { action: 'context' } }, contextResponse.res);
    expect(contextResponse.captured.statusCode).toBe(200);
    expect(contextResponse.captured.payload).toMatchObject({
      success: true,
      action: 'context',
      data: {
        owner: { telegram_user_id: 'owner-1' },
        shop_context: { shop_name: 'Current shop', access_token: '[redacted]' },
      },
    });

    const refreshResponse = mockResponse();
    await socialHandler({ method: 'POST', headers: { authorization: 'Bearer context-bridge-token' }, query: {}, body: { action: 'refreshShopContext' } }, refreshResponse.res);
    expect(refreshResponse.captured.statusCode).toBe(200);
    expect(refreshResponse.captured.payload).toMatchObject({
      success: true,
      action: 'refreshShopContext',
      published: false,
      data: {
        factual_changes: { status: 'baseline_incomplete' },
        source_provenance: {
          listings: { status: 'failed', data_available: false },
          receipts: { status: 'failed', data_available: false },
          reviews: { status: 'failed', data_available: false },
        },
      },
    });
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test.describe('Social Hermes factual shop context', () => {
  test('Etsy pagination collects listings beyond the first 100 with bounded diagnostics', async () => {
    const calls = [];
    const rows = Array.from({ length: 205 }, (_, index) => ({ listing_id: String(index + 1) }));
    const result = await collectSocialHermesEtsyPages(
      '/shops/unit/listings?state=active',
      { pageSize: 100, maxPages: 5, maxItems: 500 },
      async path => {
        calls.push(path);
        const params = new URL(`https://example.test${path}`).searchParams;
        const offset = Number(params.get('offset') || 0);
        const limit = Number(params.get('limit') || 100);
        return { count: rows.length, results: rows.slice(offset, offset + limit) };
      },
    );

    expect(result.results).toHaveLength(205);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('offset=100');
    expect(calls[2]).toContain('offset=200');
    expect(result.diagnostics).toMatchObject({
      pages_fetched: 3,
      items_collected: 205,
      total_reported: 205,
      truncated: false,
    });
  });

  test('Etsy pagination reports a hard-cap truncation instead of pretending context is complete', async () => {
    const result = await collectSocialHermesEtsyPages(
      '/shops/unit/reviews',
      { pageSize: 100, maxPages: 1, maxItems: 100 },
      async () => ({ count: 240, results: Array.from({ length: 100 }, (_, index) => ({ review_id: index + 1 })) }),
    );

    expect(result.results).toHaveLength(100);
    expect(result.diagnostics).toMatchObject({ total_reported: 240, truncated: true, max_pages: 1, max_items: 100 });
  });

  test('review facts retain exact bounded evidence and image without buyer or transaction PII', () => {
    const review = summarizeSocialHermesReview({
      listing_id: 123,
      transaction_id: 987654,
      buyer_user_id: 555,
      buyer_name: 'Private Buyer',
      buyer_avatar_url: 'https://private.example.test/avatar.jpg',
      rating: 5,
      review: 'The restored family photo looked natural and arrived exactly as described.',
      language: 'en',
      create_timestamp: 1_782_000_000,
      image_url_fullxfull: 'https://img.example.test/review-photo.jpg',
    });

    expect(review).toMatchObject({
      listing_id: '123',
      rating: 5,
      text: 'The restored family photo looked natural and arrived exactly as described.',
      has_photo: true,
      review_image_url: 'https://img.example.test/review-photo.jpg',
      transaction_link_available: true,
    });
    expect(review.review_id).toMatch(/^review_[a-f0-9]{20}$/);
    expect(JSON.stringify(review)).not.toContain('Private Buyer');
    expect(JSON.stringify(review)).not.toContain('987654');
    expect(review).not.toHaveProperty('buyer_user_id');
    expect(review).not.toHaveProperty('transaction_id');
  });

  test('snapshot comparison exposes facts and deltas without deciding whether to post them', () => {
    const previous = {
      generated_at: '2026-07-09T08:00:00.000Z',
      source_provenance: completeSocialHermesSourceProvenance('2026-07-09T08:00:00.000Z'),
      listings: [{ listing_id: '1', title: 'Existing', updated_at: '2026-07-01T00:00:00.000Z', views: 10, num_favorers: 2, recent_orders: 1, recent_units: 1, recent_revenue_usd: 12 }],
      reviews: [{ review_id: 'review-old', rating: 5 }],
    };
    const current = {
      generated_at: '2026-07-10T08:00:00.000Z',
      source_provenance: completeSocialHermesSourceProvenance('2026-07-10T08:00:00.000Z'),
      listings: [
        { listing_id: '1', title: 'Existing', updated_at: '2026-07-10T00:00:00.000Z', views: 25, num_favorers: 4, recent_orders: 2, recent_units: 3, recent_revenue_usd: 30 },
        { listing_id: '2', title: 'New listing', created_at: '2026-07-10T07:00:00.000Z', updated_at: '2026-07-10T07:00:00.000Z' },
      ],
      reviews: [
        { review_id: 'review-old', rating: 5 },
        { review_id: 'review-new', listing_id: '1', rating: 5, text: 'Great work' },
      ],
    };

    const facts = buildSocialHermesSnapshotFacts(previous, current);

    expect(facts.status).toBe('compared');
    expect(facts.new_listings).toEqual([expect.objectContaining({ listing_id: '2', title: 'New listing' })]);
    expect(facts.updated_listings).toEqual([expect.objectContaining({ listing_id: '1' })]);
    expect(facts.listing_performance_changes[0]).toMatchObject({
      listing_id: '1',
      delta: { views: 15, favorites: 2, recent_orders_90d: 1, recent_units_90d: 2, recent_revenue_usd_90d: 18 },
    });
    expect(facts.new_reviews).toEqual([expect.objectContaining({ review_id: 'review-new' })]);
    expect(facts.note).toContain('AI decides');
  });

  test('failed or truncated Etsy sources retain last-known-good facts without emitting false deltas', () => {
    const previousAt = '2026-07-10T08:00:00.000Z';
    const currentAt = '2026-07-11T08:00:00.000Z';
    const previous = {
      generated_at: previousAt,
      source_provenance: completeSocialHermesSourceProvenance(previousAt),
      listings: [{
        listing_id: '1',
        title: 'Family portrait service',
        views: 120,
        num_favorers: 14,
        recent_orders: 4,
        recent_units: 5,
        recent_revenue_usd: 80,
        last_order_at: '2026-07-09T12:00:00.000Z',
      }],
      receipt_signals: [{
        listing_id: '1',
        recent_orders: 4,
        recent_units: 5,
        recent_revenue_usd: 80,
        last_order_at: '2026-07-09T12:00:00.000Z',
      }],
      stats: { paid_receipts_scanned: 4, recent_units: 5, recent_revenue_usd: 80 },
      reviews: [{ review_id: 'review-1', listing_id: '1', rating: 5, text: 'Beautiful result' }],
    };
    const current = {
      generated_at: currentAt,
      listings: [],
      receipt_signals: [],
      stats: { paid_receipts_scanned: 0, recent_units: 0, recent_revenue_usd: 0 },
      reviews: [],
      source_provenance: {
        listings: { source: 'listings', status: 'failed', current_fetch_complete: false, truncated: null, data_complete: false, data_truncated: null },
        receipts: { source: 'receipts', status: 'truncated', current_fetch_complete: false, truncated: true, data_complete: false, data_truncated: true },
        reviews: { source: 'reviews', status: 'failed', current_fetch_complete: false, truncated: null, data_complete: false, data_truncated: null },
      },
    };

    const merged = mergeSocialHermesSourceSnapshots(previous, current);
    const facts = buildSocialHermesSnapshotFacts(previous, merged);
    expect(merged.listings[0]).toMatchObject({
      listing_id: '1',
      recent_orders: 4,
      recent_units: 5,
      recent_revenue_usd: 80,
    });
    expect(merged.stats).toEqual(previous.stats);
    expect(merged.reviews).toEqual(previous.reviews);
    expect(merged.source_provenance.listings).toMatchObject({ status: 'failed', used_last_known_good: true, data_complete: true });
    expect(merged.source_provenance.receipts).toMatchObject({ status: 'truncated', used_last_known_good: true, data_complete: true });
    expect(merged.source_provenance.reviews).toMatchObject({ status: 'failed', used_last_known_good: true, data_complete: true });
    expect(facts).toMatchObject({
      status: 'comparison_unavailable',
      new_listings: [],
      updated_listings: [],
      listing_performance_changes: [],
      new_reviews: [],
      comparison_provenance: { listings: false, receipts: false, reviews: false },
    });
    expect(Object.values(facts.totals_delta)).toEqual(expect.arrayContaining([null]));
    expect(Object.values(facts.totals_delta).every(value => value === null)).toBe(true);
  });

  test('fresh listings can advance while stale receipt facts remain explicit and never invent zero sales', () => {
    const previousAt = '2026-07-10T08:00:00.000Z';
    const currentAt = '2026-07-11T08:00:00.000Z';
    const previous = {
      generated_at: previousAt,
      source_provenance: completeSocialHermesSourceProvenance(previousAt),
      listings: [{ listing_id: '1', title: 'Existing service', views: 20, recent_orders: 3, recent_units: 3, recent_revenue_usd: 60 }],
      receipt_signals: [{ listing_id: '1', recent_orders: 3, recent_units: 3, recent_revenue_usd: 60 }],
      stats: { paid_receipts_scanned: 3, recent_units: 3, recent_revenue_usd: 60 },
      reviews: [],
    };
    const current = {
      generated_at: currentAt,
      listings: [
        { listing_id: '1', title: 'Existing service', views: 24 },
        { listing_id: '2', title: 'New service', views: 1 },
      ],
      receipt_signals: [],
      stats: null,
      reviews: [],
      source_provenance: {
        ...completeSocialHermesSourceProvenance(currentAt),
        receipts: { source: 'receipts', status: 'failed', current_fetch_complete: false, truncated: null, data_complete: false, data_truncated: null },
      },
    };

    const merged = mergeSocialHermesSourceSnapshots(previous, current);
    const facts = buildSocialHermesSnapshotFacts(previous, merged);
    const suggestions = suggestSocialContentOpportunities({
      autonomousContext: { ...merged, factual_changes: facts },
      platforms: ['instagram'],
      now: currentAt,
    });

    expect(merged.listings.find(item => item.listing_id === '1')).toMatchObject({ recent_orders: 3, recent_revenue_usd: 60 });
    expect(merged.listings.find(item => item.listing_id === '2')).toMatchObject({ recent_orders: null, recent_units: null, recent_revenue_usd: null });
    expect(suggestions.source_provenance.receipts).toMatchObject({
      status: 'failed',
      current_fetch_complete: false,
      used_last_known_good: true,
    });
    expect(suggestions.opportunities[0].listing_candidates.find(item => item.listing_id === '2')).toMatchObject({
      recent_orders: null,
      recent_units: null,
      recent_revenue_usd: null,
      performance_signals: {
        recent_orders_90d: null,
        recent_units_90d: null,
        recent_revenue_usd_90d: null,
        receipts_current_fetch_complete: false,
      },
    });
    expect(merged.source_provenance.receipts).toMatchObject({ used_last_known_good: true, current_fetch_complete: false });
    expect(facts.status).toBe('partial_comparison');
    expect(facts.new_listings).toEqual([expect.objectContaining({ listing_id: '2' })]);
    expect(facts.listing_performance_changes).toEqual([
      expect.objectContaining({ listing_id: '1', delta: { views: 4, favorites: 0 } }),
    ]);
    expect(facts.totals_delta.recent_orders_90d).toBeNull();
    expect(facts.comparison_provenance).toMatchObject({ listings: true, receipts: false, reviews: true });
  });
});
