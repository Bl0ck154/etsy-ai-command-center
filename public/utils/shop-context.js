// public/utils/shop-context.js — compatibility/composition facade.

import { shopContextApi } from './shop-context-api.js';
import { createShopContextCache } from './shop-context/cache-service.js';
import { buildShopContext } from './shop-context/model.js';
export { buildContextPrompt } from './shop-context/prompt.js';

const contextCache = createShopContextCache({
  api: shopContextApi,
  buildFresh: async () => {
    const { listings, sections } = await shopContextApi.fetchSource();
    return buildShopContext({ listings, sections });
  },
});

export function getShopContext(force = false) {
  return contextCache.get(force);
}

export function clearShopContext() {
  contextCache.clear();
}
