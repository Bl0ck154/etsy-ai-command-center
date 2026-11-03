import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  ETSY_CUSTOM_VARIATION_PROPERTY_IDS,
  customVariationPropertyId,
  newVariationOptionId,
  variationOptionKey,
} from '../public/utils/etsy-variations/identity.js';
import {
  variationOptionPricingAmount,
  variationPricePropertyIds,
  variationPropertyPricingMode,
} from '../public/utils/etsy-variations/pricing.js';
import { normalizeDraftVariations } from '../public/utils/etsy-variations/normalize.js';
import { buildDraftVariations, draftVariationPriceRows } from '../public/utils/etsy-variations/draft-builder.js';
import { draftVariationsToInventoryPayload } from '../public/utils/etsy-variations/inventory-payload.js';

test('identity owner preserves custom property slots and option-key precedence', () => {
  expect(ETSY_CUSTOM_VARIATION_PROPERTY_IDS).toEqual([513, 514]);
  expect(customVariationPropertyId(0)).toBe(513);
  expect(customVariationPropertyId(1)).toBe(514);
  expect(customVariationPropertyId(2)).toBeNull();
  expect(variationOptionKey({ client_id: 'c', option_id: 'o', value_id: 2, name: 'N' })).toBe('c');
  expect(newVariationOptionId(1, 2)).toMatch(/^custom-1-2-/);
});

test('pricing owner preserves explicit/inferred final-price and surcharge modes', () => {
  expect(variationPropertyPricingMode({ pricing_mode: 'surcharge' }, 0)).toBe('surcharge');
  expect(variationPropertyPricingMode({ options: [{ price: 12 }] }, 1)).toBe('final_price');
  expect(variationPropertyPricingMode({ options: [{ price_adjustment: 2 }] }, 0)).toBe('surcharge');
  expect(variationPropertyPricingMode({ options: [] }, 1)).toBe('surcharge');
  expect(variationOptionPricingAmount({ pricing_mode: 'final_price' }, { price: 8.5 }, 0)).toBe(8.5);
});

test('legacy custom properties are normalized into current Etsy slots', () => {
  const normalized = normalizeDraftVariations({
    enabled: true,
    properties: [
      { property_id: 100, name: 'Color', options: [{ value_id: 1000000000001, name: 'Red' }] },
      { property_id: 101, name: 'Size', options: [{ value_id: 1000000000002, name: 'A4' }] },
    ],
    products: [{ price: 5, offerings: [{ property_id: 100, value_id: 1000000000001 }, { property_id: 101, value_id: 1000000000002 }] }],
  });
  expect(normalized.properties.map(property => property.property_id)).toEqual([513, 514]);
  expect(normalized.properties.every(property => property.source === 'custom')).toBe(true);
  expect(normalized.properties[0].options[0].value_id).toBeNull();
});

test('draft builder creates cartesian combinations and price rows', () => {
  const data = {
    base_price: 10,
    properties: [
      { name: 'Color', pricing_mode: 'final_price', options: [{ name: 'Red', price: 12 }, { name: 'Blue', price: 13 }] },
      { name: 'Size', pricing_mode: 'surcharge', options: [{ name: 'A4', price_adjustment: 0 }, { name: 'A3', price_adjustment: 2 }] },
    ],
  };
  const built = buildDraftVariations(data);
  expect(built.products).toHaveLength(4);
  expect(built.products.map(product => product.price)).toEqual([12, 14, 13, 15]);
  const rows = draftVariationPriceRows(data);
  expect(rows[0].label).toContain('Color: Red');
  expect(rows[0].label).toContain('Size: A4');
});

test('price-on-property identifies dimensions that actually change final price', () => {
  const properties = [{ property_id: 513 }, { property_id: 514 }];
  const products = [
    { price: 10, offerings: [{ property_id: 513, option_id: 'red' }, { property_id: 514, option_id: 'a4' }] },
    { price: 12, offerings: [{ property_id: 513, option_id: 'blue' }, { property_id: 514, option_id: 'a4' }] },
  ];
  expect(variationPricePropertyIds(properties, products)).toContain(513);
});

test('inventory payload validates enabled products and clamps quantity', () => {
  const variations = {
    enabled: true,
    properties: [{ property_id: 513, name: 'Color', options: [{ client_id: 'red', name: 'Red', value_id: null }] }],
    products: [{ price: 9.5, quantity: 5000, is_enabled: true, offerings: [{ property_id: 513, option_id: 'red' }] }],
  };
  const payload = draftVariationsToInventoryPayload(variations, 77);
  expect(payload.products[0].offerings[0]).toMatchObject({ price: 9.5, quantity: 999, readiness_state_id: 77 });
  expect(payload.products[0].property_values[0]).toMatchObject({ property_id: 513, value_ids: [], values: ['Red'] });
  expect(() => draftVariationsToInventoryPayload({ ...variations, products: [{ ...variations.products[0], price: 0 }] })).toThrow(/at least \$0\.20/);
});

test('legacy etsy-variations entry remains facade-only', () => {
  const source = fs.readFileSync(new URL('../public/utils/etsy-variations.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(24);
  expect(source).not.toContain('const combinations');
  expect(source).not.toContain('occupiedCustomSlots');
  expect(source).toContain("from './etsy-variations/normalize.js'");
});
