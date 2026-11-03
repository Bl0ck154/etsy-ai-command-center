// public/components/shop-switcher.js
// Displays available shops and lets user switch between them.

import { routeParamsFrom } from '../utils/router.js';
import { shopSwitcherApi } from './shop-switcher-api.js';
import { shopSelectionState } from './shop-selection-state.js';

export async function initShopSwitcher() {
  let shops;
  try {
    shops = await shopSwitcherApi.fetchAvailableShops();
  } catch {
    shops = [];
  }
  const activeShop = shopSelectionState.hydrate(shops);
  updateSidebarDisplay();
  return activeShop;
}

export function getActiveShop() { return shopSelectionState.getActiveShop(); }
export function getActiveShopId() { return shopSelectionState.getActiveShopId(); }

export function setActiveShop(shop) {
  shopSelectionState.select(shop);
  updateSidebarDisplay();
}

function updateSidebarDisplay() {
  const el = document.getElementById('shop-name-display');
  if (!el) return;
  const activeShop = shopSelectionState.getActiveShop();
  const shops = shopSelectionState.getShops();
  if (!activeShop) { el.textContent = 'No shop'; return; }
  el.textContent = activeShop.name || activeShop.id;
  el.title = shops.length > 1 ? `Active: ${activeShop.name} — click to switch` : activeShop.name;
}

export function showShopSwitcher() {
  const shops = shopSelectionState.getShops();
  const activeShop = shopSelectionState.getActiveShop();
  if (shops.length <= 1) return;

  document.getElementById('shop-switcher-dropdown')?.remove();

  const trigger = document.getElementById('shop-name-display');
  if (!trigger) return;

  const rect = trigger.getBoundingClientRect();
  const dropdown = document.createElement('div');
  dropdown.id = 'shop-switcher-dropdown';
  dropdown.style.cssText = `
    position:fixed;
    top:${rect.bottom + 4}px;
    left:${rect.left}px;
    background:var(--bg-card);
    border:1px solid var(--border);
    border-radius:var(--radius-lg);
    box-shadow:0 8px 24px rgba(0,0,0,0.12);
    z-index:1000;
    min-width:200px;
    overflow:hidden;
  `;

  dropdown.innerHTML = `
    <div style="padding:8px 12px;font-size:11px;font-weight:600;color:var(--text-3);border-bottom:1px solid var(--border)">
      SWITCH SHOP
    </div>
    ${shops.map(shop => `
      <div style="
        display:flex;align-items:center;gap:10px;
        padding:9px 12px;cursor:pointer;font-size:13px;
        background:${shop.id === activeShop?.id ? 'var(--orange-light)' : 'transparent'};
        color:${shop.id === activeShop?.id ? 'var(--orange)' : 'var(--text)'};
      "
        onmouseenter="this.style.background='var(--bg-hover)'"
        onmouseleave="this.style.background='${shop.id === activeShop?.id ? 'var(--orange-light)' : 'transparent'}'"
        onclick="window.__selectShop('${shop.id}')">
        <span style="width:26px;height:26px;border-radius:var(--radius-sm);background:${shop.id === activeShop?.id ? 'var(--orange)' : 'var(--bg-hover)'};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:${shop.id === activeShop?.id ? '#fff' : 'var(--text-3)'}">
          ${(shop.name || shop.id)[0].toUpperCase()}
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:${shop.id === activeShop?.id ? '600' : '400'}">${shop.name || shop.id}</div>
          <div style="font-size:11px;color:var(--text-3)">#${shop.id}</div>
        </div>
        ${shop.id === activeShop?.id ? '<span style="color:var(--orange);font-size:12px">✓</span>' : ''}
      </div>`).join('')}
    <div style="padding:8px 12px;border-top:1px solid var(--border)">
      <a href="https://www.etsy.com/your/shops/me/tools/listings" target="_blank"
        style="font-size:12px;color:var(--orange);text-decoration:none">
        Manage on Etsy ↗
      </a>
    </div>
  `;

  document.body.appendChild(dropdown);

  const closeHandler = (e) => {
    if (!dropdown.contains(e.target) && e.target !== trigger) {
      dropdown.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);

  window.__selectShop = (shopId) => {
    const shop = shopSelectionState.findById(shopId);
    if (!shop) return;
    setActiveShop(shop);
    dropdown.remove();
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    const [page, query = ''] = hash.split('?');
    window.navigate(page, routeParamsFrom(query));
  };
}
