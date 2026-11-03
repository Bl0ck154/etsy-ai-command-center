let parsedShopsCache = null;

export function parseShopsFromEnv() {
  if (parsedShopsCache) return parsedShopsCache;
  const multi = process.env.ETSY_SHOP_IDS || '';
  if (multi) {
    parsedShopsCache = multi.split(',').map(s => {
      const [id, ...nameParts] = s.trim().split(':');
      return { id: id.trim(), name: nameParts.join(':').trim() || id.trim() };
    }).filter(s => s.id);
  } else {
    const single = process.env.ETSY_SHOP_ID;
    parsedShopsCache = single ? [{ id: single, name: 'My Shop' }] : [];
  }
  return parsedShopsCache;
}

export function getActiveShopId(req) {
  const raw = (req.headers && req.headers['x-shop-id'])
    || (req.query && req.query.shop_id)
    || (req.body && req.body.shop_id)
    || process.env.ETSY_SHOP_ID
    || parseShopsFromEnv()[0]?.id
    || '';
  const digits = String(raw).replace(/[^0-9]/g, '').trim();
  return digits || '';
}
