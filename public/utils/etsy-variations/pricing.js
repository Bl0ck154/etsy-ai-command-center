import { offeringOptionKey } from './identity.js';

export function variationPropertyPricingMode(property = {}, propertyIndex = 0) {
  if (property.pricing_mode === 'final_price' || property.pricing_mode === 'surcharge') {
    return property.pricing_mode;
  }
  const options = property.options || [];
  if (options.some(option => Number.isFinite(Number(option?.price_adjustment)) && Number(option.price_adjustment) !== 0)) {
    return 'surcharge';
  }
  if (options.some(option => Number(option?.price) >= 0.20)) return 'final_price';
  return propertyIndex === 0 ? 'final_price' : 'surcharge';
}

export function variationOptionPricingAmount(property = {}, option = {}, propertyIndex = 0) {
  const mode = variationPropertyPricingMode(property, propertyIndex);
  if (Number.isFinite(Number(option?.amount))) return Number(option.amount);
  return mode === 'surcharge'
    ? (Number(option?.price_adjustment) || 0)
    : (Number(option?.price) >= 0.20 ? Number(option.price) : null);
}

export function variationPricePropertyIds(properties = [], products = []) {
  const enabled = (products || []).filter(product => product.is_enabled !== false);
  return (properties || []).filter(property => {
    const groups = new Map();
    for (const product of enabled) {
      const otherOptions = (product.offerings || [])
        .filter(offering => Number(offering.property_id) !== Number(property.property_id))
        .map(offering => `${offering.property_id}:${offeringOptionKey(offering)}`)
        .sort()
        .join('|');
      if (!groups.has(otherOptions)) groups.set(otherOptions, new Set());
      const price = Number(product.price);
      if (Number.isFinite(price)) groups.get(otherOptions).add(price.toFixed(2));
    }
    return [...groups.values()].some(prices => prices.size > 1);
  }).map(property => Number(property.property_id)).filter(Boolean);
}
