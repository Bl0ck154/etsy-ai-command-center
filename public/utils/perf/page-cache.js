export const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
export const PAGE_CACHE_MAX_ENTRIES = 10;

export function createPageCache({ now = () => Date.now(), ttlMs = PAGE_CACHE_TTL_MS, maxEntries = PAGE_CACHE_MAX_ENTRIES } = {}) {
  const pageCache = new Map();

  function getCachedPage(key) {
    const entry = pageCache.get(key);
    if (!entry) return null;
    if (now() - entry.time > ttlMs) {
      pageCache.delete(key);
      return null;
    }
    return entry.html;
  }

  function setCachedPage(key, html) {
    pageCache.set(key, { html, time: now() });
    if (pageCache.size > maxEntries) {
      const oldest = [...pageCache.entries()].sort((a, b) => a[1].time - b[1].time)[0];
      pageCache.delete(oldest[0]);
    }
  }

  function clearPageCache(keyPrefix) {
    if (!keyPrefix) {
      pageCache.clear();
      return;
    }
    [...pageCache.keys()].filter(key => key.startsWith(keyPrefix)).forEach(key => pageCache.delete(key));
  }

  return { getCachedPage, setCachedPage, clearPageCache };
}

const defaultPageCache = createPageCache();
export const getCachedPage = defaultPageCache.getCachedPage;
export const setCachedPage = defaultPageCache.setCachedPage;
export const clearPageCache = defaultPageCache.clearPageCache;
