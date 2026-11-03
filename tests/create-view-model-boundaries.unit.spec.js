import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  defaultReadinessProfileId,
  readinessProfileControlMarkup,
  shippingProfileControlMarkup,
} from '../public/utils/create-metadata-controls.js';
import { variationPricingPresentation } from '../public/utils/create-variation-pricing.js';
import { publishReadinessPresentation } from '../public/utils/create-publish-readiness.js';

const facade = fs.readFileSync(new URL('../public/utils/create-view-model.js', import.meta.url), 'utf8');

test('shipping and readiness controls preserve loading/failure/selection behavior', () => {
  expect(shippingProfileControlMarkup({ status: 'loading' })).toContain('Loading shipping profiles');
  expect(readinessProfileControlMarkup({ status: 'failed' })).toContain('retryReadinessProfiles');
  expect(shippingProfileControlMarkup({ profiles: [{ shipping_profile_id: 7, title: 'Fast & <safe>' }], selectedValue: 7 }))
    .toContain('value="7" selected');
});

test('legacy readiness default prefers matching 1-7 day profile', () => {
  expect(defaultReadinessProfileId({ when_made: 'made_to_order' }, [
    { readiness_state_id: 9, readiness_state: 'made_to_order', min_processing_days: 1, max_processing_days: 7 },
  ])).toBe(9);
  expect(defaultReadinessProfileId({ readiness_state_id: 12 }, [])).toBe(12);
});

test('variation pricing projection preserves presentation contract', () => {
  expect(variationPricingPresentation({ enabled: true, products: [{}] })).toEqual({
    hasVariationInventory: true,
    priceLabel: 'Starting at (USD)',
    priceNote: 'Calculated from the lowest enabled variation price.',
    quantityDisplay: 'none',
  });
});

test('publish readiness projection preserves counts, labels and escaping', () => {
  const view = publishReadinessPresentation({
    ready: false,
    blockers: [{ key: 'title' }],
    checks: [
      { key: 'title', ready: false, label: '<Title>', detail: 'Required' },
      { key: 'price', ready: true, label: 'Price' },
    ],
  });
  expect(view.badgeText).toBe('1 required');
  expect(view.publishButtonTitle).toBe('1 required item missing');
  expect(view.markup).toContain('1/2');
  expect(view.markup).toContain('&lt;Title&gt;');
});

test('create view-model remains only a compatibility facade', () => {
  expect(facade.split('\n').length).toBeLessThan(12);
  expect(facade).not.toContain('create-readiness-heading');
  expect(facade).not.toContain('shipping profiles exist');
  expect(facade).toContain("from './create-metadata-controls.js'");
});
