import { expect, test } from '@playwright/test';

import { createListingInventoryReader } from '../api/etsy/listing-reader.js';

test('listing inventory reader removes deprecated includes and merges batch inventory', async () => {
  const paths = [];
  const reader = createListingInventoryReader({
    request: async path => {
      paths.push(path);
      if (path.startsWith('/listings/123?')) return { listing_id: 123, title: 'Listing' };
      return { results: [{ listing_id: 123, inventory: { products: [{ product_id: 9 }] } }] };
    },
  });

  await expect(reader.getListingWithInventory(123, [
    'Images',
    'Inventory',
    'Shipping',
    'Images',
    'Videos',
  ])).resolves.toEqual({
    listing_id: 123,
    title: 'Listing',
    inventory: { products: [{ product_id: 9 }] },
  });

  expect(paths).toEqual([
    '/listings/123?includes=Images,Videos',
    '/listings/batch/inventory?listing_ids=123',
  ]);
});

test('listing inventory reader uses parallel listing and inventory requests', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const reader = createListingInventoryReader({
    request: async path => {
      started.push(path);
      if (started.length === 2) release();
      await gate;
      if (path.startsWith('/listings/77')) return { listing_id: 77 };
      return { results: [{ listing_id: 77, inventory: { products: [] } }] };
    },
  });

  await expect(reader.getListingWithInventory(77)).resolves.toEqual({
    listing_id: 77,
    inventory: { products: [] },
  });
  expect(started).toHaveLength(2);
});

test('invalid listing IDs fail before any Etsy request', async () => {
  let calls = 0;
  const reader = createListingInventoryReader({
    request: async () => { calls += 1; return {}; },
  });
  await expect(reader.getListingWithInventory('not-an-id')).rejects.toMatchObject({
    status: 400,
    message: 'A positive numeric Etsy listing_id is required',
  });
  expect(calls).toBe(0);
});
