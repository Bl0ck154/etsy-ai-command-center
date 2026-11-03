import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const facade = fs.readFileSync(new URL('../api/_etsy.js', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../api/etsy/client.js', import.meta.url), 'utf8');
const listingReader = fs.readFileSync(new URL('../api/etsy/listing-reader.js', import.meta.url), 'utf8');

test('legacy Etsy helper remains a small compatibility facade', () => {
  expect(facade).toContain("from './etsy/client.js'");
  expect(facade).toContain("from './etsy/listing-reader.js'");
  expect(facade).toContain("from './_etsy-listing-associations.js'");
  expect(facade).not.toContain('fetch(');
  expect(facade).not.toContain('getValidToken');
  expect(facade).not.toContain('refreshAccessToken');
  expect(facade).not.toContain('includes=');
  expect(facade.split('\n').length).toBeLessThan(20);
});

test('Etsy client owns authentication retry, rate limiting and timeout transport', () => {
  expect(client).toContain("response.status === 401 && !retried");
  expect(client).toContain('await refreshToken()');
  expect(client).toContain('response.status === 429 && attempt < 3');
  expect(client).toContain('ETSY_TIMEOUT_MS = 20_000');
  expect(client).toContain("'x-api-key': API_KEY_FULL");
});

test('listing reader owns July-2026 inventory association compatibility', () => {
  expect(listingReader).toContain("!['inventory', 'shipping'].includes(value.toLowerCase())");
  expect(listingReader).toContain('/listings/batch/inventory?listing_ids=');
  expect(listingReader).toContain('Promise.all([');
  expect(listingReader).toContain('mergeListingInventory(listing, inventoryBatch, id)');
});
