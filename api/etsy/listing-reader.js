import { mergeListingInventory, positiveListingId } from '../_etsy-listing-associations.js';
import { etsyFetch } from './client.js';

export function createListingInventoryReader({ request = etsyFetch } = {}) {
  async function getListingWithInventory(listingId, includes = []) {
    const id = positiveListingId(listingId);
    const safeIncludes = [...new Set(
      (Array.isArray(includes) ? includes : [])
        .map(value => String(value || '').trim())
        .filter(value => value && !['inventory', 'shipping'].includes(value.toLowerCase())),
    )];
    const listingPath = `/listings/${id}${safeIncludes.length ? `?includes=${safeIncludes.join(',')}` : ''}`;
    const inventoryPath = `/listings/batch/inventory?listing_ids=${id}`;
    const [listing, inventoryBatch] = await Promise.all([
      request(listingPath),
      request(inventoryPath),
    ]);
    return mergeListingInventory(listing, inventoryBatch, id);
  }

  return { getListingWithInventory };
}

const listingInventoryReader = createListingInventoryReader();

export async function getListingWithInventory(listingId, includes = []) {
  return listingInventoryReader.getListingWithInventory(listingId, includes);
}
