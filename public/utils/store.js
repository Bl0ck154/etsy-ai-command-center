// public/utils/store.js — Global in-memory cache / store
// Pages read from here instead of calling API directly.
// API is called only on cache miss or explicit invalidation.
// This eliminates redundant fetches on tab navigation.

const TTLS = {
  listings:     5 * 60_000,  // 5 min
  orders:       2 * 60_000,  // 2 min
  dashboard:    2 * 60_000,
  shop:         10 * 60_000, // 10 min
  sections:     10 * 60_000,
  shipping:     10 * 60_000,
  reviews:      5 * 60_000,  // 5 min
  taxonomy:     30 * 60_000, // 30 min — rarely changes
  shopContext:  30 * 60_000,
  analytics:    5 * 60_000,
};

const store = new Map(); // key → { data, ts }

// ── Core API ───────────────────────────────────────────────

/** Get cached value or null if expired/missing */
export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  const ttl = TTLS[key.split(':')[0]] ?? 5 * 60_000;
  if (Date.now() - entry.ts > ttl) { store.delete(key); return null; }
  return entry.data;
}

/** Set a value in cache */
export function set(key, data) {
  store.set(key, { data, ts: Date.now() });
  return data;
}

/** Invalidate one key or a prefix (e.g. 'listings' clears all listings:* keys) */
export function invalidate(prefix) {
  for (const k of store.keys()) {
    if (k === prefix || k.startsWith(prefix + ':')) store.delete(k);
  }
}

/** Get-or-fetch: returns cached data or calls fetchFn() and caches result */
export async function getOrFetch(key, fetchFn) {
  const cached = get(key);
  if (cached !== null) return cached;
  const data = await fetchFn();
  return set(key, data);
}

/** Force-refresh: invalidate then fetch */
export async function refresh(key, fetchFn) {
  invalidate(key);
  const data = await fetchFn();
  return set(key, data);
}

/** How stale is a key in seconds (-1 if not cached) */
export function ageSeconds(key) {
  const entry = store.get(key);
  if (!entry) return -1;
  return Math.round((Date.now() - entry.ts) / 1000);
}

/** Export for debug */
export function dumpKeys() {
  return [...store.keys()].map(k => ({ k, age: ageSeconds(k) + 's' }));
}
