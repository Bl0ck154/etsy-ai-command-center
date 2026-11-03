export function moneyNumber(value) {
  const amount = Number(typeof value === 'string' ? value.replace(/[$,\s]/g, '') : value);
  return Number.isFinite(amount) ? amount : null;
}

export function variationPriceSummary(variationsOrProducts = []) {
  const products = Array.isArray(variationsOrProducts)
    ? variationsOrProducts
    : (variationsOrProducts?.products || []);
  const enabled = products.filter(product => product?.is_enabled !== false);
  const prices = enabled.map(product => moneyNumber(product?.price));
  const invalidIndexes = prices
    .map((price, index) => (price == null || price < 0.20 ? index : -1))
    .filter(index => index >= 0);
  const validPrices = prices.filter(price => price != null && price >= 0.20);
  return {
    enabledCount: enabled.length,
    invalidIndexes,
    valid: enabled.length > 0 && invalidIndexes.length === 0,
    min: validPrices.length ? Math.min(...validPrices) : null,
    max: validPrices.length ? Math.max(...validPrices) : null,
  };
}

export function migrateLegacyVariationPrices(variations, basePrice) {
  if (!variations?.enabled || !Array.isArray(variations.products)) {
    return { variations, migrated: false };
  }
  const base = moneyNumber(basePrice);
  if (base == null || base < 0.20) return { variations, migrated: false };
  const enabled = variations.products.filter(product => product?.is_enabled !== false);
  const prices = enabled.map(product => moneyNumber(product?.price));
  const looksLikeLegacyAdjustments = prices.length > 0
    && prices.some(price => price != null && price < 0.20)
    && prices.every(price => price != null && price >= 0 && price < base);
  if (!looksLikeLegacyAdjustments) return { variations, migrated: false };
  return {
    migrated: true,
    variations: {
      ...variations,
      products: variations.products.map(product => ({
        ...product,
        price: Number((base + (moneyNumber(product?.price) || 0)).toFixed(2)),
      })),
    },
  };
}

export function listingReadiness({
  title,
  listingType,
  basePrice,
  taxonomyId,
  shippingProfileId,
  readinessStateId,
  variations,
} = {}) {
  const physical = listingType === 'physical';
  const variationSummary = variations?.enabled ? variationPriceSummary(variations) : null;
  const checks = [
    { key: 'title', label: 'Title', ready: Boolean(String(title || '').trim()) },
    { key: 'price', label: variations?.enabled ? 'Starting price' : 'Price', ready: (moneyNumber(basePrice) || 0) >= 0.20 },
    { key: 'category', label: 'Category', ready: Number(taxonomyId) > 0 },
    ...(physical ? [
      { key: 'shipping', label: 'Shipping profile', ready: Number(shippingProfileId) > 0 },
      { key: 'processing', label: 'Processing profile', ready: Number(readinessStateId) > 0 },
    ] : []),
    ...(variations?.enabled ? [{
      key: 'variations',
      label: 'Variation prices',
      ready: variationSummary?.valid === true,
      detail: variationSummary?.valid
        ? `$${variationSummary.min.toFixed(2)}${variationSummary.max !== variationSummary.min ? `-$${variationSummary.max.toFixed(2)}` : ''}`
        : `${variationSummary?.invalidIndexes.length || 0} missing or invalid`,
    }] : []),
  ];
  return {
    checks,
    blockers: checks.filter(check => !check.ready),
    ready: checks.every(check => check.ready),
  };
}
