import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  defaultReadinessProfileId,
  publishReadinessPresentation,
  readinessProfileControlMarkup,
  shippingProfileControlMarkup,
  variationPricingPresentation,
} from '../public/utils/create-view-model.js';

test('shipping profile presentation preserves loading, failure, empty, and selected states', () => {
  expect(shippingProfileControlMarkup({ status: 'loading' }))
    .toContain('Loading shipping profiles...');
  expect(shippingProfileControlMarkup({ status: 'failed' }))
    .toContain('window.retryShippingProfiles()');

  const empty = shippingProfileControlMarkup({ status: 'loaded' });
  expect(empty).toContain('No shipping profiles exist for this shop.');
  expect(empty).toContain('id="e-shipping"');

  const markup = shippingProfileControlMarkup({
    status: 'loaded',
    selectedValue: '22',
    profiles: [
      { shipping_profile_id: 11, title: 'Standard' },
      { shipping_profile_id: 22, title: '<Express & insured>' },
    ],
  });
  expect(markup).toContain('<option value="11" >Standard</option>');
  expect(markup).toContain('<option value="22" selected>&lt;Express &amp; insured&gt;</option>');
});

test('default readiness selection preserves explicit IDs and the exact legacy 1-7 day match', () => {
  const profiles = [
    {
      readiness_state_id: 101,
      readiness_state: 'made_to_order',
      min_processing_days: 1,
      max_processing_days: 7,
    },
    {
      readiness_state_id: 102,
      readiness_state: 'ready_to_ship',
      min_processing_days: 1,
      max_processing_days: 7,
    },
    {
      readiness_state_id: 103,
      readiness_state: 'made_to_order',
      min_processing_days: 3,
      max_processing_days: 5,
    },
  ];

  expect(defaultReadinessProfileId({ readiness_state_id: '900' }, profiles)).toBe(900);
  expect(defaultReadinessProfileId({ when_made: 'made_to_order' }, profiles)).toBe(101);
  expect(defaultReadinessProfileId({ when_made: '2020_2026' }, profiles)).toBe(102);
  expect(defaultReadinessProfileId({}, profiles.slice(2))).toBeNull();
});

test('processing profile presentation labels states, durations, and selected values', () => {
  expect(readinessProfileControlMarkup({ status: 'loading' }))
    .toContain('Loading processing profiles...');
  expect(readinessProfileControlMarkup({ status: 'failed' }))
    .toContain('window.retryReadinessProfiles()');
  expect(readinessProfileControlMarkup({ status: 'loaded' }))
    .toContain('id="e-readiness"');

  const markup = readinessProfileControlMarkup({
    status: 'loaded',
    selectedValue: 8,
    profiles: [
      {
        readiness_state_id: 7,
        readiness_state: 'ready_to_ship',
        processing_days_display_label: '<1 business day>',
      },
      {
        readiness_state_id: 8,
        readiness_state: 'made_to_order',
        min_processing_days: 2,
        max_processing_days: 4,
      },
    ],
  });
  expect(markup).toContain('Ready to ship · &lt;1 business day&gt;');
  expect(markup).toContain('<option value="8" selected>Made to order · 2-4 days</option>');
});

test('variation pricing presentation depends only on enabled inventory', () => {
  expect(variationPricingPresentation(null)).toEqual({
    hasVariationInventory: false,
    priceLabel: 'Base price (USD)',
    priceNote: 'The price buyers see when this listing has no priced variations.',
    quantityDisplay: 'block',
  });
  expect(variationPricingPresentation({ enabled: true, products: [{ sku: 'one' }] })).toEqual({
    hasVariationInventory: true,
    priceLabel: 'Starting at (USD)',
    priceNote: 'Calculated from the lowest enabled variation price.',
    quantityDisplay: 'none',
  });
  expect(variationPricingPresentation({ enabled: false, products: [{ sku: 'one' }] }))
    .toMatchObject({ hasVariationInventory: false });
});

test('publish readiness presentation maps reports without mutating domain state', () => {
  const report = {
    ready: false,
    checks: [
      { key: 'title', ready: true, label: 'Title', detail: '' },
      { key: 'taxonomy', ready: false, label: '<Category>', detail: 'Pick & confirm' },
    ],
    blockers: [{ key: 'taxonomy' }],
  };
  const snapshot = structuredClone(report);
  const blocked = publishReadinessPresentation(report);

  expect(blocked).toMatchObject({
    ready: false,
    badgeText: '1 required',
    badgeTitle: 'Go to the first required field',
    publishButtonTitle: '1 required item missing',
  });
  expect(blocked.markup).toContain('1 item need attention');
  expect(blocked.markup).toContain('1/2');
  expect(blocked.markup).toContain('&lt;Category&gt;');
  expect(blocked.markup).toContain('Pick &amp; confirm');
  expect(blocked.markup).toContain('<span>Ready</span>');
  expect(report).toEqual(snapshot);

  expect(publishReadinessPresentation({ ready: true, checks: [], blockers: [] }))
    .toMatchObject({
      ready: true,
      badgeText: 'Ready',
      badgeTitle: 'Ready to create on Etsy',
      publishButtonTitle: 'Create this listing in Etsy drafts',
    });
});

test('Create page consumes the extracted view model and the module stays UI-only', async () => {
  const pageSource = await fs.readFile(new URL('../public/pages/create.js', import.meta.url), 'utf8');
  const viewModelSource = await fs.readFile(
    new URL('../public/utils/create-view-model.js', import.meta.url),
    'utf8',
  );

  expect(pageSource).toContain("from '../utils/create-view-model.js'");
  for (const functionName of [
    'shippingProfileControlMarkup',
    'defaultReadinessProfileId',
    'readinessProfileControlMarkup',
  ]) {
    expect(pageSource).not.toContain(`function ${functionName}(`);
  }
  expect(viewModelSource).not.toMatch(/getModel|buildContextPrompt|agentRuntime|tool[_-]?output/i);
});
