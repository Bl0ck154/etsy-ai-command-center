import {
  customVariationPropertyId,
  newVariationOptionId,
  variationOptionKey,
} from './identity.js';
import {
  variationOptionPricingAmount,
  variationPricePropertyIds,
  variationPropertyPricingMode,
} from './pricing.js';

export function buildDraftVariations(data = {}) {
  const properties = (data.properties || []).slice(0, 2).map((property, propertyIndex) => {
    const pricingMode = variationPropertyPricingMode(property, propertyIndex);
    return {
      property_id: customVariationPropertyId(propertyIndex),
      source: 'custom',
      pricing_mode: pricingMode,
      name: String(property.name || `Variation ${propertyIndex + 1}`).trim(),
      options: (property.options || []).map((option, optionIndex) => {
        const sourceOption = typeof option === 'string' ? { name: option } : option;
        const amount = variationOptionPricingAmount(property, sourceOption, propertyIndex);
        return {
          value_id: null,
          client_id: newVariationOptionId(propertyIndex, optionIndex),
          name: String(sourceOption.name || '').trim(),
          price: pricingMode === 'final_price' && Number(amount) >= 0.20 ? Number(amount) : null,
          price_adjustment: pricingMode === 'surcharge' && Number.isFinite(Number(amount)) ? Number(amount) : 0,
        };
      }).filter(option => option.name),
    };
  }).filter(property => property.options.length);
  const combinations = properties.reduce(
    (rows, property) => rows.flatMap(row => property.options.map(option => [...row, { property, option }])),
    [[]],
  );
  const basePrice = Number(data.base_price) >= 0.20 ? Number(data.base_price) : null;
  const products = combinations.map(combo => {
    const finalPrice = combo.find(item => item.option.price != null)?.option.price ?? basePrice;
    const adjustment = combo.reduce((sum, item) => sum + (Number(item.option.price_adjustment) || 0), 0);
    return {
      sku: '',
      price: finalPrice == null ? '' : Number((finalPrice + adjustment).toFixed(2)),
      quantity: 999,
      is_enabled: true,
      offerings: combo.map(item => ({
        property_id: item.property.property_id,
        option_id: item.option.client_id,
        value_id: null,
      })),
    };
  });
  const cleanProperties = properties.map(property => ({
    ...property,
    options: property.options.map(({ price: _price, price_adjustment: _adjustment, ...option }) => option),
  }));
  return {
    enabled: cleanProperties.length > 0,
    properties: cleanProperties,
    products,
    priceOnProperty: variationPricePropertyIds(cleanProperties, products),
  };
}

export function draftVariationPriceRows(data = {}) {
  const variations = buildDraftVariations(data);
  return variations.products.map(product => ({
    label: (product.offerings || []).map(offering => {
      const property = variations.properties.find(item => Number(item.property_id) === Number(offering.property_id));
      const option = property?.options?.find(item => variationOptionKey(item) === String(offering.option_id || ''));
      return `${property?.name || 'Variation'}: ${option?.name || ''}`;
    }).join(' / '),
    price: Number(product.price),
  }));
}
