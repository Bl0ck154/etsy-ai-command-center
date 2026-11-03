import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  buildShopContext,
  extractBoilerplateBlocks,
  extractPersonalizationPatterns,
  extractPriceRange,
  extractTopTags,
} from '../public/utils/shop-context/model.js';
import { buildContextPrompt } from '../public/utils/shop-context/prompt.js';
import {
  createShopContextCache,
  SHOP_CONTEXT_CACHE_TTL_MS,
  SHOP_CONTEXT_LOCAL_KEY,
} from '../public/utils/shop-context/cache-service.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    value: key => data.get(key),
    has: key => data.has(key),
  };
}

test('shop context model preserves extracted patterns, counts, tags and prices', () => {
  const listings = [
    { listing_id: 1, title: 'A', listing_type: 'download', price: { amount: 500, divisor: 100 }, tags: ['gift', 'portrait'], is_personalizable: true, personalization_instructions: 'Send your name and photo', description: 'HOW TO DOWNLOAD\nOpen the file\n\nLICENSE\nYou CAN NOT resell', shop_section_id: 9 },
    { listing_id: 2, title: 'B', listing_type: 'physical', price: { amount: 1500, divisor: 100 }, tags: ['gift'], is_personalizable: true, personalization_instructions: 'Send your name and photo', description: 'HOW TO DOWNLOAD\nOpen the file\n\nLICENSE\nYou CAN NOT resell', shop_section_id: 10 },
  ];
  const context = buildShopContext({ listings, sections: [{ title: 'Portraits' }], timestamp: 123 });
  expect(context.timestamp).toBe(123);
  expect(context.digitalCount).toBe(1);
  expect(context.physicalCount).toBe(1);
  expect(context.personalizationPatterns).toHaveLength(1);
  expect(context.topTags.slice(0, 2)).toEqual(['gift', 'portrait']);
  expect(context.priceRange).toEqual({ min: 5, max: 15, avg: 10 });
  expect(context.sectionNames).toEqual(['Portraits']);
  expect(context.listings[0]).not.toHaveProperty('description');
  expect(extractPersonalizationPatterns(listings)).toHaveLength(1);
  expect(extractTopTags(listings)[0]).toBe('gift');
  expect(extractPriceRange(listings).avg).toBe(10);
  expect(extractBoilerplateBlocks(listings).length).toBeGreaterThan(0);
});

test('prompt projection preserves context framing and limits', () => {
  expect(buildContextPrompt(null)).toBe('');
  const context = {
    listings: [{ id: 1 }],
    personalizationPatterns: [{ text: 'A'.repeat(150) }],
    descriptionSections: ['HOW TO ORDER'],
    topTags: Array.from({ length: 20 }, (_, index) => `tag${index}`),
    priceRange: { min: 2, max: 8, avg: 5 },
    sectionNames: ['Custom'],
  };
  const prompt = buildContextPrompt(context);
  expect(prompt).toContain('=== YOUR SHOP CONTEXT');
  expect(prompt).toContain('Your price range: $2.00–$8.00, avg $5.00');
  expect(prompt).toContain('Your shop sections: Custom');
  expect(prompt).not.toContain('tag15');
});

test('cache reads fresh KV before local and fresh builder', async () => {
  const now = 1_000_000;
  const kv = { timestamp: now - 1000, listings: [{ id: 'kv' }] };
  const local = { timestamp: now - 500, listings: [{ id: 'local' }] };
  const storage = memoryStorage({ [SHOP_CONTEXT_LOCAL_KEY]: JSON.stringify(local) });
  let builds = 0;
  const cache = createShopContextCache({
    api: { getCached: async () => kv },
    buildFresh: async () => { builds += 1; return { timestamp: now, listings: [{ id: 'fresh' }] }; },
    storageProvider: () => storage,
    now: () => now,
  });
  expect((await cache.get()).listings[0].id).toBe('kv');
  expect(builds).toBe(0);
});

test('cache falls back to local when KV is absent or stale', async () => {
  const now = 2_000_000;
  const local = { timestamp: now - 1000, listings: [{ id: 'local' }] };
  const storage = memoryStorage({ [SHOP_CONTEXT_LOCAL_KEY]: JSON.stringify(local) });
  const cache = createShopContextCache({
    api: { getCached: async () => ({ timestamp: now - SHOP_CONTEXT_CACHE_TTL_MS - 1, listings: [{ id: 'stale' }] }) },
    buildFresh: async () => ({ timestamp: now, listings: [{ id: 'fresh' }] }),
    storageProvider: () => storage,
    now: () => now,
  });
  expect((await cache.get()).listings[0].id).toBe('local');
});

test('force refresh deduplicates concurrent fresh builds', async () => {
  let resolveBuild;
  let builds = 0;
  const build = new Promise(resolve => { resolveBuild = resolve; });
  const cache = createShopContextCache({
    api: {},
    buildFresh: () => { builds += 1; return build; },
    storageProvider: () => memoryStorage(),
  });
  const first = cache.get(true);
  const second = cache.get(true);
  expect(builds).toBe(1);
  resolveBuild({ timestamp: Date.now(), listings: [] });
  expect(await first).toEqual(await second);
});

test('fresh build keeps historical KV/local listing caps and clear behavior', async () => {
  const storage = memoryStorage();
  let kvSaved = null;
  let clears = 0;
  const listings = Array.from({ length: 35 }, (_, index) => ({ id: index }));
  const cache = createShopContextCache({
    api: {
      setCached: async value => { kvSaved = value; },
      clearCached: async () => { clears += 1; },
    },
    buildFresh: async () => ({ timestamp: 10, listings }),
    storageProvider: () => storage,
    now: () => 10,
  });
  await cache.get(true);
  expect(kvSaved.listings).toHaveLength(30);
  expect(JSON.parse(storage.value(SHOP_CONTEXT_LOCAL_KEY)).listings).toHaveLength(20);
  cache.clear();
  expect(storage.has(SHOP_CONTEXT_LOCAL_KEY)).toBe(false);
  await Promise.resolve();
  expect(clears).toBe(1);
});

test('shop-context public file is composition-only', () => {
  const source = fs.readFileSync(new URL('../public/utils/shop-context.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(28);
  expect(source).not.toContain('extractDescriptionSections');
  expect(source).not.toContain('localStorage');
  expect(source).not.toContain('CACHE_TTL_MS');
  expect(source).toContain("from './shop-context/cache-service.js'");
});
