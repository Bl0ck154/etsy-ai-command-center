export const SHOP_CONTEXT_CACHE_TTL_MS = 30 * 60 * 1000;
export const SHOP_CONTEXT_LOCAL_KEY = 'etsy_mgr_shop_context';

export function createShopContextCache({
  api,
  buildFresh,
  storageProvider = () => localStorage,
  now = () => Date.now(),
  ttlMs = SHOP_CONTEXT_CACHE_TTL_MS,
  localKey = SHOP_CONTEXT_LOCAL_KEY,
} = {}) {
  let memoryCache = null;
  let buildPromise = null;

  function isFresh(context) {
    return Boolean(context?.timestamp && now() - context.timestamp < ttlMs);
  }

  function storage() {
    try { return storageProvider?.() || null; } catch { return null; }
  }

  async function loadKv() {
    try {
      const context = await api?.getCached?.();
      return isFresh(context) ? context : null;
    } catch { return null; }
  }

  function loadLocal() {
    try {
      const raw = storage()?.getItem(localKey);
      if (!raw) return null;
      const context = JSON.parse(raw);
      return isFresh(context) ? context : null;
    } catch { return null; }
  }

  async function saveKv(context) {
    try {
      const minimal = { ...context, listings: context.listings.slice(0, 30) };
      await api?.setCached?.(minimal);
    } catch { /* server cache is best effort */ }
  }

  function saveLocal(context) {
    try {
      const minimal = { ...context, listings: context.listings.slice(0, 20) };
      storage()?.setItem(localKey, JSON.stringify(minimal));
    } catch { /* local cache is best effort */ }
  }

  async function get(force = false) {
    if (!force && isFresh(memoryCache)) return memoryCache;

    if (!force) {
      const serverContext = await loadKv();
      if (serverContext) {
        memoryCache = serverContext;
        return serverContext;
      }
      const localContext = loadLocal();
      if (localContext) {
        memoryCache = localContext;
        return localContext;
      }
    }

    if (!buildPromise) {
      buildPromise = Promise.resolve(buildFresh())
        .then(context => {
          memoryCache = context;
          saveKv(context);
          saveLocal(context);
          return context;
        })
        .finally(() => { buildPromise = null; });
    }
    return buildPromise;
  }

  function clear() {
    memoryCache = null;
    try { storage()?.removeItem(localKey); } catch {}
    try { api?.clearCached?.()?.catch?.(() => {}); } catch {}
  }

  return {
    get,
    clear,
  };
}
