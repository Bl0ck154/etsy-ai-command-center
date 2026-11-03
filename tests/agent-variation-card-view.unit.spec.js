import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { createAgentVariationCardView } from '../public/utils/agent-variation-card-view.js';

function renderWithFakeDocument(render) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        className: '',
        innerHTML: '',
        style: {},
        querySelector: () => null,
      };
    },
  };
  try {
    return render();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

function cardView(overrides = {}) {
  return createAgentVariationCardView({
    cancelPendingCard: () => {},
    listingThumbHtml: item => `<img data-listing="${item.listing_id}">`,
    listingLinkHtml: (id, title) => `<a data-id="${id}">${title}</a>`,
    agentNoticeHtml: text => `<aside>${text}</aside>`,
    ...overrides,
  });
}

test('variation editor card preserves final-price, surcharge, profile, and personalization presentation', () => {
  const card = renderWithFakeDocument(() => cardView().renderVariationsCard({
    target_type: 'etsy_listing',
    listing_id: 42,
    listing_title: '<Custom video>',
    listing_type: 'physical',
    base_price: 30,
    taxonomy_id: 2078,
    shipping_profile_id: 701,
    readiness_state_id: 801,
    properties: [
      {
        name: 'Length',
        pricing_mode: 'final_price',
        options: [{ name: 'Short', amount: 30 }, { name: 'Long', amount: 45 }],
      },
      {
        name: 'Color',
        pricing_mode: 'surcharge',
        options: [{ name: 'Original', amount: 0 }, { name: 'Restored', amount: 5 }],
      },
    ],
    personalization_questions: [{ question_text: 'Upload source media', required: true }],
  }, () => {}));

  expect(card.innerHTML).toContain('&lt;Custom video&gt;');
  expect(card.innerHTML).toContain('Final prices sent to Etsy · 4 combinations');
  expect(card.innerHTML).toContain('Color surcharge');
  expect(card.innerHTML).toContain('Restored · +$5.00');
  expect(card.innerHTML).toContain('Keep current listing profile');
  expect(card.innerHTML).toContain('Upload source media</strong> · Required');
  expect(card.innerHTML).toContain('Apply to Etsy listing');
});

test('remove-property card derives the remaining variation summary without mutating the plan', () => {
  const plan = {
    summary: 'Remove Color only',
    property_name: 'Color',
    listings: [{
      listing_id: 42,
      listing_title: 'Custom video',
      summary: { properties: [{ name: 'Length', options: ['Short', 'Long'] }, { name: 'Color', options: ['Original'] }] },
      removed_property: { name: 'Color' },
      update_to: {
        products: [{ property_values: [{ property_id: 1, property_name: 'Length', values: ['Short'] }] }],
      },
    }],
  };
  const snapshot = structuredClone(plan);
  const card = renderWithFakeDocument(() => cardView().renderRemoveVariationPropertyCard(
    plan,
    () => {},
    () => {},
  ));

  expect(card.innerHTML).toContain('Remove Color only');
  expect(card.innerHTML).toContain('Length: Short');
  expect(card.innerHTML).toContain('preserves remaining variation prices/quantities');
  expect(plan).toEqual(snapshot);
});

test('price inventory card remains an approval-only variation-safe preview', () => {
  const card = renderWithFakeDocument(() => cardView().renderPriceMultiplierInventoryCard({
    summary: 'Multiply prices',
    mode: 'multiply',
    multiplier: 2.5,
    listings: [{
      listing_id: 42,
      listing_title: 'Cinematic video',
      summary: { product_count: 2, price_min: 15, price_max: 25, properties: [{ name: 'Length', options: ['Short', 'Long'] }] },
      new_summary: { product_count: 2, price_min: 37.5, price_max: 62.5 },
      changes: [{ index: 1, variation: 'Length: Short', current_price: 15, new_price: 37.5 }],
    }],
  }, () => {}, () => {}));

  expect(card.innerHTML).toContain('Variation-safe price update');
  expect(card.innerHTML).toContain('Preview, not applied');
  expect(card.innerHTML).toContain('Approval required');
  expect(card.innerHTML).toContain('multiplies every inventory offering price by 2.5x');
  expect(card.innerHTML).toContain('preserves all variation properties');
  expect(card.innerHTML).toContain('$15-$25');
  expect(card.innerHTML).toContain('$37.5-$62.5');
  expect(card.innerHTML).toContain('Length: Short: $15 → $37.5');
  expect(card.innerHTML).toContain('Approve & update prices');
});

test('Agent page delegates variation card rendering through the focused view boundary', async () => {
  const pageSource = await fs.readFile(new URL('../public/pages/agent.js', import.meta.url), 'utf8');
  const viewSource = await fs.readFile(
    new URL('../public/utils/agent-variation-card-view.js', import.meta.url),
    'utf8',
  );

  expect(pageSource).toContain("from '../utils/agent-variation-card-view.js'");
  expect(pageSource).toContain('createAgentVariationCardView({');
  expect(pageSource).not.toMatch(/function render(?:Variations|ClearVariations|RemoveVariationProperty|PriceMultiplierInventory)Card\(/);
  expect(viewSource).toContain('function summarizeVariationProducts(');
  expect(viewSource).not.toMatch(
    /fetch\(|localStorage|sessionStorage|etsy\.|agentMessages|systemPrompt|tool[_-]?result|pending_variations\s*=/i,
  );
});
