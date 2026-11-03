// api/_etsy.js — stable Etsy API compatibility facade.
// Imported by etsy.js, stats.js, upload.js, chat.js and other runtime owners.

export { mergeListingInventory } from './_etsy-listing-associations.js';
export {
  API_KEY_FULL,
  ETSY_BASE,
  etsyFetch,
  getShopId,
} from './etsy/client.js';
export { getListingWithInventory } from './etsy/listing-reader.js';
