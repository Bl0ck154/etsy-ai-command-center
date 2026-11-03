import { variationOptionKey } from './identity.js';
import { variationPricePropertyIds } from './pricing.js';

export function draftVariationsToInventoryPayload(variations = {}, readinessStateId = null) {
  if (!variations.enabled || !(variations.products || []).length) return null;
  const readinessId = Number(readinessStateId || 0);
  const enabledProducts = variations.products.filter(product => product.is_enabled !== false);
  if (!enabledProducts.length) throw new Error('Enable at least one variation combination.');
  const invalidPrices = enabledProducts.filter(product => !Number.isFinite(Number(product.price)) || Number(product.price) < 0.20);
  if (invalidPrices.length) throw new Error(`Set a final price of at least $0.20 for every enabled variation (${invalidPrices.length} missing).`);

  return {
    products: enabledProducts.map(product => ({
      sku: product.sku || undefined,
      offerings: [{
        price: Number(product.price),
        quantity: Math.max(0, Math.min(999, parseInt(product.quantity, 10) || 0)),
        is_enabled: true,
        ...(readinessId > 0 ? { readiness_state_id: readinessId } : {}),
      }],
      property_values: (product.offerings || []).map(offering => {
        const property = (variations.properties || []).find(item => Number(item.property_id) === Number(offering.property_id));
        const optionKey = String(offering.option_id || offering.value_id || '');
        const option = property?.options?.find(candidate => variationOptionKey(candidate) === optionKey);
        const valueId = Number(option?.value_id || 0);
        return {
          property_id: offering.property_id,
          value_ids: valueId > 0 ? [valueId] : [],
          property_name: property?.name || '',
          values: [option?.name || ''],
          ...(property?.scale_id != null ? { scale_id: property.scale_id } : {}),
        };
      }),
    })),
    price_on_property: variationPricePropertyIds(variations.properties || [], variations.products || []),
    readiness_state_id: readinessId || null,
  };
}
