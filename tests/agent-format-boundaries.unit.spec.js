import fs from 'node:fs';
import { expect, test } from '@playwright/test';

import { renderAgentMarkdown } from '../public/utils/agent-format/markdown.js';
import {
  extractListingThumbnailRows,
  formatAgentMessageForCopy,
  renderListingThumbnails,
  stripListingThumbnailMetadata,
} from '../public/utils/agent-format/listing-media.js';
import {
  formatPlanValue,
  getPlanUpdateChangeDetails,
  listingWriteFields,
  normalizePlanUpdate,
  valuesEqualForPlan,
} from '../public/utils/agent-format/plan-update.js';

test('Agent markdown keeps Etsy listing table links and escapes raw markup', () => {
  const html = renderAgentMarkdown('| Listing ID | Title |\n| --- | --- |\n| 123456789 | <Test> |');
  expect(html).toContain('https://www.etsy.com/listing/123456789');
  expect(html).toContain('&lt;Test&gt;');
  expect(html).toContain('>Open<');
});

test('listing media extraction preserves metadata projection and copy stripping', () => {
  const raw = 'Listing media:\nListing ID: 123456789 | State: active | Views: 12 | image_url: https://img.example/x.jpg | Etsy URL: https://www.etsy.com/listing/123456789 | Title: Test listing\nVisible answer';
  expect(extractListingThumbnailRows(raw)).toEqual([expect.objectContaining({
    listing_id: '123456789',
    title: 'Test listing',
    state: 'active',
    views: '12',
    image_url: 'https://img.example/x.jpg',
  })]);
  expect(stripListingThumbnailMetadata(raw)).toBe('Visible answer');
  expect(formatAgentMessageForCopy('assistant', raw)).toBe('Visible answer');
  expect(renderListingThumbnails(raw)).toContain('data-agent-listing-id="123456789"');
});

test('plan update formatting preserves nested personalization and write-field filtering', () => {
  const normalized = normalizePlanUpdate({
    personalization: { personalization_questions: [{ question_text: 'Name?', required: true }] },
  });
  expect(normalized.personalization).toBeUndefined();
  expect(normalized.personalization_questions).toHaveLength(1);

  const update = {
    listing_id: '123',
    current_values: { title: 'Old title', price: { amount: 1200, divisor: 100 } },
    title: 'New title',
    price: 12,
  };
  expect(valuesEqualForPlan('price', update.current_values.price, update.price)).toBe(true);
  expect(listingWriteFields(update)).toEqual({ title: 'New title' });
  expect(getPlanUpdateChangeDetails(update).map(change => change.field)).toEqual(['title']);
  expect(formatPlanValue({ amount: 1250, divisor: 100 }, 'price')).toBe('$12.50');
});

test('agent-format public entry remains a thin compatibility facade', () => {
  const source = fs.readFileSync(new URL('../public/utils/agent-format.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(30);
  expect(source).not.toContain('function renderAgentMarkdown');
  expect(source).not.toContain('function extractListingThumbnailRows');
  expect(source).not.toContain('PLAN_FIELD_LABELS');
  expect(source).toContain("./agent-format/markdown.js");
  expect(source).toContain("./agent-format/listing-media.js");
  expect(source).toContain("./agent-format/plan-update.js");
});
