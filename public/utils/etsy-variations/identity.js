export const ETSY_CUSTOM_VARIATION_PROPERTY_IDS = Object.freeze([513, 514]);

let optionSequence = 0;

export function customVariationPropertyId(index) {
  return ETSY_CUSTOM_VARIATION_PROPERTY_IDS[index] || null;
}

export function newVariationOptionId(propertyIndex = 0, optionIndex = 0) {
  optionSequence += 1;
  return `custom-${propertyIndex}-${optionIndex}-${Date.now().toString(36)}-${optionSequence.toString(36)}`;
}

export function variationOptionKey(option = {}) {
  return String(option.client_id || option.option_id || option.value_id || option.name || '');
}

export function offeringOptionKey(offering = {}) {
  return String(offering.option_id || offering.client_id || offering.value_id || '');
}
