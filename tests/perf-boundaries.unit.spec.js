import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { debounce, throttle } from '../public/utils/perf/timing.js';
import { skeleton, skeletonTable } from '../public/utils/perf/skeletons.js';
import { lazyImg } from '../public/utils/perf/lazy-images.js';
import { createRequestDeduper } from '../public/utils/perf/request-dedupe.js';
import { createPageCache, PAGE_CACHE_MAX_ENTRIES, PAGE_CACHE_TTL_MS } from '../public/utils/perf/page-cache.js';

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

test('debounce keeps only the latest call', async () => {
  const calls = [];
  const fn = debounce(value => calls.push(value), 10);
  fn('a');
  fn('b');
  await delay(25);
  expect(calls).toEqual(['b']);
});

test('throttle runs immediately and suppresses calls inside limit', async () => {
  const calls = [];
  const fn = throttle(value => calls.push(value), 10);
  fn('a');
  fn('b');
  await delay(15);
  fn('c');
  expect(calls).toEqual(['a', 'c']);
});

test('skeleton helpers preserve last-line width and table shape', () => {
  const lines = skeleton(3, '90%');
  expect((lines.match(/skeleton-line/g) || []).length).toBe(3);
  expect(lines).toContain('width:60%');
  const table = skeletonTable(2, 3);
  expect((table.match(/<th>/g) || []).length).toBe(2);
  expect((table.match(/<tr>/g) || []).length).toBe(4);
});

test('lazy image falls back to native loading when observer is unavailable', () => {
  const html = lazyImg('https://cdn/image.jpg', 'thumb', 'width:10px', 'Preview');
  expect(html).toContain('src="https://cdn/image.jpg"');
  expect(html).toContain('loading="lazy"');
});

test('request deduper shares identical in-flight requests and clears after settle', async () => {
  let calls = 0;
  let resolveFetch;
  const pending = new Promise(resolve => { resolveFetch = resolve; });
  const { dedupedFetch } = createRequestDeduper({ fetchImpl: async () => { calls += 1; return pending; } });
  const first = dedupedFetch('/x', { method: 'GET' });
  const second = dedupedFetch('/x', { method: 'GET' });
  expect(calls).toBe(1);
  resolveFetch({ ok: true });
  expect(await first).toBe(await second);
  await dedupedFetch('/x', { method: 'GET' });
  expect(calls).toBe(2);
});

test('page cache preserves five-minute TTL, ten-entry cap and prefix clear', () => {
  expect(PAGE_CACHE_TTL_MS).toBe(5 * 60 * 1000);
  expect(PAGE_CACHE_MAX_ENTRIES).toBe(10);
  let now = 1000;
  const cache = createPageCache({ now: () => now, ttlMs: 100, maxEntries: 2 });
  cache.setCachedPage('a:1', '<a>');
  now += 1;
  cache.setCachedPage('a:2', '<b>');
  now += 1;
  cache.setCachedPage('b:1', '<c>');
  expect(cache.getCachedPage('a:1')).toBeNull();
  expect(cache.getCachedPage('a:2')).toBe('<b>');
  cache.clearPageCache('a:');
  expect(cache.getCachedPage('a:2')).toBeNull();
  expect(cache.getCachedPage('b:1')).toBe('<c>');
  now += 101;
  expect(cache.getCachedPage('b:1')).toBeNull();
});

test('perf public entry remains compatibility facade', () => {
  const source = fs.readFileSync(new URL('../public/utils/perf.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(18);
  expect(source).not.toContain('pendingRequests');
  expect(source).not.toContain('IntersectionObserver');
  expect(source).not.toContain('PAGE_CACHE_TTL');
  expect(source).toContain("import './perf/styles.js'");
});
