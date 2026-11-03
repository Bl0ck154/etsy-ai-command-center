import {
  ETSY_CUSTOM_VARIATION_PROPERTY_IDS,
  customVariationPropertyId,
  newVariationOptionId,
  offeringOptionKey,
  variationOptionKey,
} from './identity.js';
import { variationPricePropertyIds } from './pricing.js';

function isSyntheticValueId(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric >= 1e12;
}

function isCustomDraftProperty(property = {}) {
  const propertyId = Number(property.property_id || 0);
  if ([100, 101].includes(propertyId) || property.source === 'custom') return true;
  if (property.source === 'etsy' || property.source === 'taxonomy') return false;
  return (property.options || []).some(option =>
    String(option.client_id || '').startsWith('custom-')
    || isSyntheticValueId(option.value_id));
}

export function normalizeDraftVariations(variations = {}) {
  const oldProperties = variations.properties || [];
  const sourceProperties = oldProperties.slice(0, 2);
  const customFlags = sourceProperties.map(isCustomDraftProperty);
  const occupiedCustomSlots = new Set(sourceProperties
    .filter((property, index) => !customFlags[index])
    .map(property => Number(property.property_id || 0))
    .filter(propertyId => ETSY_CUSTOM_VARIATION_PROPERTY_IDS.includes(propertyId)));
  const assignedCustomSlots = new Set();

  const properties = sourceProperties.map((property, propertyIndex) => {
    const custom = customFlags[propertyIndex];
    const currentPropertyId = Number(property.property_id || 0);
    let propertyId = currentPropertyId;
    if (custom) {
      const currentSlotAvailable = ETSY_CUSTOM_VARIATION_PROPERTY_IDS.includes(currentPropertyId)
        && !occupiedCustomSlots.has(currentPropertyId)
        && !assignedCustomSlots.has(currentPropertyId);
      propertyId = currentSlotAvailable
        ? currentPropertyId
        : ETSY_CUSTOM_VARIATION_PROPERTY_IDS.find(id => !occupiedCustomSlots.has(id) && !assignedCustomSlots.has(id));
      if (propertyId) assignedCustomSlots.add(propertyId);
    }
    return {
      ...property,
      property_id: propertyId || currentPropertyId || customVariationPropertyId(propertyIndex),
      source: custom ? 'custom' : property.source,
      name: String(property.name || `Variation ${propertyIndex + 1}`).trim(),
      options: (property.options || []).map((option, optionIndex) => {
        const valueId = custom ? null : (Number(option.value_id || 0) || null);
        return {
          ...option,
          value_id: valueId,
          client_id: custom
            ? (variationOptionKey(option) || newVariationOptionId(propertyIndex, optionIndex))
            : (option.client_id || (valueId ? `etsy-${valueId}` : newVariationOptionId(propertyIndex, optionIndex))),
          name: String(option.name || '').trim(),
        };
      }).filter(option => option.name),
    };
  });

  const propertyIdMap = new Map();
  sourceProperties.forEach((property, index) => {
    propertyIdMap.set(String(property.property_id ?? index), properties[index]?.property_id);
  });
  const optionKeyMap = new Map();
  sourceProperties.forEach((property, propertyIndex) => {
    (property.options || []).forEach((option, optionIndex) => {
      const sourceKey = variationOptionKey(option);
      const normalized = properties[propertyIndex]?.options?.[optionIndex];
      if (sourceKey && normalized) optionKeyMap.set(`${propertyIndex}:${sourceKey}`, variationOptionKey(normalized));
    });
  });

  const products = (variations.products || []).map(product => ({
    ...product,
    offerings: (product.offerings || []).map((offering, propertyIndex) => {
      const property = properties[propertyIndex];
      const custom = customFlags[propertyIndex];
      const optionKey = optionKeyMap.get(`${propertyIndex}:${offeringOptionKey(offering)}`)
        || variationOptionKey(property?.options?.find(option => option.name === offering.name))
        || variationOptionKey(property?.options?.[0]);
      const option = property?.options?.find(candidate => variationOptionKey(candidate) === String(optionKey));
      return {
        property_id: propertyIdMap.get(String(offering.property_id ?? propertyIndex)) || property?.property_id,
        option_id: optionKey || '',
        value_id: custom ? null : (Number(option?.value_id || offering.value_id || 0) || null),
      };
    }),
  }));

  return {
    ...variations,
    enabled: Boolean(variations.enabled && properties.length),
    properties,
    products,
    priceOnProperty: variationPricePropertyIds(properties, products),
  };
}
