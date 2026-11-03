export function variationPricingPresentation(manager = null) {
  const hasVariationInventory = Boolean(manager?.enabled && manager?.products?.length);
  return {
    hasVariationInventory,
    priceLabel: hasVariationInventory ? 'Starting at (USD)' : 'Base price (USD)',
    priceNote: hasVariationInventory
      ? 'Calculated from the lowest enabled variation price.'
      : 'The price buyers see when this listing has no priced variations.',
    quantityDisplay: hasVariationInventory ? 'none' : 'block',
  };
}
