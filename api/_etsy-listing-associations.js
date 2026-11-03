export function positiveListingId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    const err = new Error('A positive numeric Etsy listing_id is required');
    err.status = 400;
    throw err;
  }
  return id;
}

export function mergeListingInventory(listing, inventoryBatch, listingId) {
  const id = positiveListingId(listingId);
  const inventoryListing = inventoryBatch?.results?.find(
    item => Number(item?.listing_id) === id
  );

  if (!inventoryListing || !Object.prototype.hasOwnProperty.call(inventoryListing, 'inventory')) {
    const err = new Error(`Etsy inventory batch response did not include listing ${id}`);
    err.status = 502;
    err.data = { code: 'ETSY_INVENTORY_BATCH_MISSING_LISTING', listing_id: id };
    throw err;
  }

  return { ...listing, inventory: inventoryListing.inventory };
}
