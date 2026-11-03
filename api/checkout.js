/**
 * Facebook Shop Checkout Endpoint
 * Redirects to Etsy shop with selected products
 */

function getConfiguredShopUrl() {
  const direct = String(process.env.ETSY_SHOP_URL || '').trim();
  if (direct) return direct.replace(/\/+$/, '');

  const configuredShopId = String(process.env.ETSY_SHOP_ID || '').trim();
  if (configuredShopId) return `https://www.etsy.com/shop/${configuredShopId}`;

  return 'https://www.etsy.com';
}

export default async function handler(req, res) {
  const { products, coupon, cart_origin } = req.query;

  // Parse products parameter: "etsy_4420886705:99,etsy_1466981145:99"
  const productIds = products
    ? products.split(',').map(p => p.split(':')[0].replace('etsy_', ''))
    : [];

  // Config-driven Etsy shop URL
  const etsyShopUrl = getConfiguredShopUrl();

  // If specific products, redirect to first product
  // (Etsy doesn't support multi-product cart URLs directly)
  if (productIds.length > 0) {
    const firstProductId = productIds[0];
    const productUrl = `https://www.etsy.com/listing/${firstProductId}`;

    return res.redirect(302, productUrl);
  }

  // Fallback to shop homepage
  return res.redirect(302, etsyShopUrl);
}
