export const ACTIVE_SHOP_KEY = 'etsy_mgr_active_shop';

export function createShopSelectionState({ storageProvider = () => sessionStorage } = {}) {
  let shops = [];
  let activeShop = null;

  function storage() {
    try { return storageProvider?.() || null; } catch { return null; }
  }

  function persist() {
    const target = storage();
    if (!target) return;
    try {
      if (activeShop?.id) target.setItem(ACTIVE_SHOP_KEY, activeShop.id);
      else target.removeItem(ACTIVE_SHOP_KEY);
    } catch { /* selection still works without browser storage */ }
  }

  function hydrate(nextShops = []) {
    shops = Array.isArray(nextShops) ? nextShops : [];
    let savedId = null;
    try { savedId = storage()?.getItem(ACTIVE_SHOP_KEY) || null; } catch {}
    activeShop = shops.find(shop => shop.id === savedId) || shops[0] || null;
    persist();
    return activeShop;
  }

  function select(shop) {
    activeShop = shop || null;
    persist();
    return activeShop;
  }

  return {
    hydrate,
    select,
    getShops: () => shops,
    getActiveShop: () => activeShop,
    getActiveShopId: () => activeShop?.id || '',
    findById: id => shops.find(shop => shop.id === id) || null,
  };
}

export const shopSelectionState = createShopSelectionState();
