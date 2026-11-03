import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { mergeListingInventory } from '../api/_etsy-listing-associations.js';

test('dedicated inventory response is merged into the existing listing shape', () => {
  const listing = { listing_id: 42, title: 'Example', images: [{ listing_image_id: 7 }] };
  const inventory = { products: [{ product_id: 9 }], price_on_property: [] };

  expect(mergeListingInventory(listing, {
    count: 1,
    results: [{ listing_id: 42, inventory }],
  }, 42)).toEqual({ ...listing, inventory });
});

test('missing inventory association fails closed instead of returning incomplete listing data', () => {
  expect(() => mergeListingInventory({ listing_id: 42 }, { count: 0, results: [] }, 42))
    .toThrow('Etsy inventory batch response did not include listing 42');
});

test('getListing calls no longer request deprecated Inventory or Shipping includes', () => {
  const files = [
    'api/etsy.js',
    'api/chat.js',
    'api/agent/tools-dispatch.js',
    'api/agent/helpers.js',
  ];
  const deprecatedInclude = /includes\s*=\s*[^`'"\r\n]*(Inventory|Shipping)/i;

  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(source, file).not.toMatch(deprecatedInclude);
  }

  const listingReader = fs.readFileSync(path.join(process.cwd(), 'api/etsy/listing-reader.js'), 'utf8');
  expect(listingReader).toContain('/listings/batch/inventory?listing_ids=');
});
