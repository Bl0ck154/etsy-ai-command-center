// public/utils/shop-context-api.js — transport adapter for shop-context.js

import { etsy } from './api.js';
import { kvGet, kvPost } from './kv-client.js';

export function createShopContextApi({
  etsyClient = etsy,
  getKv = kvGet,
  postKv = kvPost,
} = {}) {
  return {
    async fetchSource() {
      const [listingsResult, sectionsResult] = await Promise.allSettled([
        etsyClient.getListings({ limit: 100, state: 'active' }),
        etsyClient.getShopSections(),
      ]);
      return {
        listings: listingsResult.status === 'fulfilled'
          ? (listingsResult.value?.results || [])
          : [],
        sections: sectionsResult.status === 'fulfilled'
          ? (sectionsResult.value?.results || [])
          : [],
      };
    },

    getCached() {
      return getKv('getContext');
    },

    setCached(value) {
      return postKv('setContext', value);
    },

    clearCached() {
      return postKv('del', null, { key: 'shop_context' });
    },
  };
}

export const shopContextApi = createShopContextApi();
