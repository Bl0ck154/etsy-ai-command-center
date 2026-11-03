import { kvGet } from '../kv.js';
import { baselineSnapshot } from './source-contracts.js';
import { validateStoredSnapshot } from './snapshot-contracts.js';

const ACTIVE_KEY = 'etsy_guidance:active';
const CACHE_MS = 5 * 60 * 1000;
const KV_TIMEOUT_MS = 1500;

let activeCache = null;
let activeCacheExpiresAt = 0;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function getActiveEtsyGuidance({ fresh = false } = {}) {
  if (!fresh && activeCache && activeCacheExpiresAt > Date.now()) return activeCache;
  let active = null;
  try {
    active = validateStoredSnapshot(
      await withTimeout(kvGet(ACTIVE_KEY), KV_TIMEOUT_MS, 'Etsy guidance storage'),
      'active',
    );
  } catch {}
  activeCache = active || baselineSnapshot();
  activeCacheExpiresAt = Date.now() + CACHE_MS;
  return activeCache;
}

export function invalidateEtsyGuidanceCache() {
  activeCache = null;
  activeCacheExpiresAt = 0;
}
