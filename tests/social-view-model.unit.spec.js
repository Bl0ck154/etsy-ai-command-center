import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  applySocialSort,
  buildAutopilotUsageIndex,
  compactListingForAutopilot,
  filterAndSortHistory,
  historyStatusBadge,
  historyStatusLabel,
  listingImageUrl,
  listingImageUrls,
  mergeAutopilotListingFacts,
  normalizePublishHistoryStatus,
  parseAutopilotStreamJson,
  selectListingsForAutopilot,
  socialHubScheduleStatus,
  usageSummaryForPost,
} from '../public/utils/social-view-model.js';

test('listing sorting is deterministic and does not mutate API order', () => {
  const listings = [
    { listing_id: 1, title: 'Zulu', price: { amount: 999, divisor: 100 }, views: 3 },
    { listing_id: 2, title: 'Alpha', price: { amount: 5, divisor: 1 }, views: 30 },
    { listing_id: 3, title: 'Middle', price: { amount: 1250, divisor: 100 }, views: 10 },
  ];

  expect(applySocialSort(listings, 'created').map(item => item.listing_id)).toEqual([1, 2, 3]);
  expect(applySocialSort(listings, 'title').map(item => item.listing_id)).toEqual([2, 3, 1]);
  expect(applySocialSort(listings, 'price_asc').map(item => item.listing_id)).toEqual([2, 1, 3]);
  expect(applySocialSort(listings, 'price_desc').map(item => item.listing_id)).toEqual([3, 1, 2]);
  expect(applySocialSort(listings, 'views').map(item => item.listing_id)).toEqual([2, 3, 1]);
  expect(listings.map(item => item.listing_id)).toEqual([1, 2, 3]);
});

test('listing media normalization preserves precedence, deduplicates, and stays bounded', () => {
  const listing = {
    MainImage: { url_570xN: 'https://img.test/main.jpg', url_75x75: 'https://img.test/thumb.jpg' },
    images: [
      { url_570xN: 'https://img.test/main.jpg' },
      ...Array.from({ length: 12 }, (_, index) => ({ url_fullxfull: `https://img.test/${index + 2}.jpg` })),
    ],
    media_items: [{ url: 'https://img.test/media.jpg' }],
    image_urls: ['https://img.test/list.jpg'],
    image_url: 'https://img.test/fallback.jpg',
  };

  expect(listingImageUrl(listing)).toBe('https://img.test/main.jpg');
  expect(listingImageUrls(listing)).toHaveLength(10);
  expect(listingImageUrls(listing).slice(0, 3)).toEqual([
    'https://img.test/main.jpg',
    'https://img.test/2.jpg',
    'https://img.test/3.jpg',
  ]);
  expect(listingImageUrl({ image_urls: ['https://img.test/array.jpg'] }))
    .toBe('https://img.test/array.jpg');
  expect(listingImageUrls(null)).toEqual([]);
});

test('compact and merged listing facts contain factual Etsy evidence only', () => {
  const listing = {
    listing_id: '123',
    title: 'A factual listing',
    description: 'Original Etsy description',
    price: { amount: 2599, divisor: 100 },
    images: [{ url_570xN: 'https://img.test/listing.jpg' }],
    num_favorers: 7,
    views: 42,
    tags: Array.from({ length: 15 }, (_, index) => `tag-${index + 1}`),
  };
  const context = {
    listing_id: 123,
    description: 'Server-refreshed description',
    image_url: 'https://img.test/context.jpg',
    media_items: [{ url: 'https://img.test/context.jpg', type: 'image' }],
    recent_orders: 4,
    recent_units: 5,
    recent_revenue_usd: 129.95,
    last_order_at: '2026-08-01T10:00:00.000Z',
  };

  const compact = compactListingForAutopilot(listing);
  expect(compact).toMatchObject({
    listing_id: 123,
    title: 'A factual listing',
    description: 'Original Etsy description',
    price: '25.99',
    url: 'https://www.etsy.com/listing/123',
    image_url: 'https://img.test/listing.jpg',
    num_favorers: 7,
    views: 42,
    recent_orders: 0,
  });
  expect(compact.tags).toHaveLength(13);
  expect(selectListingsForAutopilot([listing])).toEqual([compact]);

  expect(mergeAutopilotListingFacts(listing, context)).toMatchObject({
    listing_id: '123',
    description: 'Server-refreshed description',
    image_url: 'https://img.test/context.jpg',
    media_items: [{ url: 'https://img.test/context.jpg', type: 'image' }],
    recent_orders: 4,
    recent_units: 5,
    recent_revenue_usd: 129.95,
    last_order_at: '2026-08-01T10:00:00.000Z',
  });
});

test('usage index combines calendar and history facts in newest-first order', () => {
  const usage = buildAutopilotUsageIndex([
    { listing_id: 123, platform: 'instagram', scheduled_at: '2026-08-03T10:00:00.000Z' },
    { listing_id: null, platform: 'facebook', scheduled_at: '2026-08-04T10:00:00.000Z' },
  ], [
    { listing_id: 123, platform: 'pinterest', postedAt: Date.parse('2026-08-01T10:00:00.000Z') },
  ]);

  expect([...usage.keys()]).toEqual(['123']);
  expect(usage.get('123')).toEqual([
    {
      platform: 'instagram',
      source: 'calendar',
      at: Date.parse('2026-08-03T10:00:00.000Z'),
      status: 'scheduled',
    },
    {
      platform: 'pinterest',
      source: 'history',
      at: Date.parse('2026-08-01T10:00:00.000Z'),
      status: 'published',
    },
  ]);
  expect(usageSummaryForPost({ usage_context: [] })).toBe('Fresh listing');
  expect(usageSummaryForPost({ usage_context: [
    { platform: 'instagram', days_ago: 0 },
    { platform: 'pinterest', days_ago: 3 },
    { platform: 'facebook', days_ago: null },
    { platform: 'tiktok', days_ago: 9 },
  ] })).toBe('instagram today · pinterest 3d ago · facebook scheduled');
});

test('streamed JSON parsing accepts the existing response envelopes and fails closed', () => {
  expect(parseAutopilotStreamJson('```json\n{"posts":[]}\n```')).toEqual({ posts: [] });
  expect(parseAutopilotStreamJson('Planning complete:\n{"posts":[{"id":1}]}\nDone.'))
    .toEqual({ posts: [{ id: 1 }] });
  expect(() => parseAutopilotStreamJson('not valid json')).toThrow(
    'Gemini finished, but the streamed plan was not valid JSON. Try fewer posts or run again.',
  );
});

test('history status normalization preserves current display semantics', () => {
  expect(socialHubScheduleStatus({ published: true, status: 'failed' })).toBe('published');
  expect(socialHubScheduleStatus({ status: 'queued_external' })).toBe('queued');
  expect(socialHubScheduleStatus({ status: 'approved_scheduled' })).toBe('queued');
  expect(socialHubScheduleStatus({ scheduled_at: '2026-08-04T10:00:00.000Z' })).toBe('scheduled');
  expect(socialHubScheduleStatus({ metadata: { owner_review_required: true } })).toBe('owner_review');
  expect(socialHubScheduleStatus({})).toBe('draft');

  expect(normalizePublishHistoryStatus({ published: true })).toBe('published');
  expect(normalizePublishHistoryStatus({ queued: true })).toBe('queued_external');
  expect(normalizePublishHistoryStatus({})).toBe('queued_external');
  expect(historyStatusLabel('queued_external')).toBe('sending');
  expect(historyStatusLabel('error')).toBe('failed');
  expect(historyStatusBadge('published')).toBe('badge-green');
  expect(historyStatusBadge('failed')).toBe('badge-red');
  expect(historyStatusBadge('owner_review')).toBe('badge-orange');
});

test('history filtering and sorting supports queued aliases without mutating state', () => {
  const history = [
    { id: 'old-pin', platform: 'pinterest', listing: 'Zulu', status: 'published', _postedAt: 10 },
    { id: 'external', platform: 'instagram', listing: 'Alpha', status: 'queued_external', _postedAt: 30 },
    { id: 'queued', platform: 'facebook', listing: 'Alpha', status: 'queued', _postedAt: 20 },
    { id: 'implicit', platform: 'instagram', listing: 'Middle', _postedAt: 40 },
  ];

  expect(filterAndSortHistory(history, { status: 'queued' }).map(item => item.id))
    .toEqual(['external', 'queued']);
  expect(filterAndSortHistory(history, { platform: 'instagram' }).map(item => item.id))
    .toEqual(['implicit', 'external']);
  expect(filterAndSortHistory(history, { sort: 'oldest' }).map(item => item.id))
    .toEqual(['old-pin', 'queued', 'external', 'implicit']);
  expect(filterAndSortHistory(history, { sort: 'platform' }).map(item => item.id))
    .toEqual(['queued', 'implicit', 'external', 'old-pin']);
  expect(filterAndSortHistory(history, { sort: 'listing' }).map(item => item.id))
    .toEqual(['external', 'queued', 'implicit', 'old-pin']);
  expect(history.map(item => item.id)).toEqual(['old-pin', 'external', 'queued', 'implicit']);
});

test('Social page consumes the extracted view-model module instead of redefining it', async () => {
  const source = await fs.readFile(new URL('../public/pages/social.js', import.meta.url), 'utf8');
  expect(source).toContain("from '../utils/social-view-model.js'");
  for (const functionName of [
    'applySocialSort',
    'listingImageUrls',
    'buildAutopilotUsageIndex',
    'parseAutopilotStreamJson',
    'historyStatusLabel',
  ]) {
    expect(source).not.toContain(`function ${functionName}(`);
  }
});
