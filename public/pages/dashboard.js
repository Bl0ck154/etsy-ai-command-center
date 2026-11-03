import { etsy, stats as statsApi } from '../utils/api.js';
import { price, number, truncate, timeAgo, listingType, listingState, escHtml } from '../utils/format.js';
import { toastError, toastSuccess } from '../components/toast.js';
import { getShopContext } from '../utils/shop-context.js';
import { skeleton, skeletonCard, observeLazyImages, lazyImg } from '../utils/perf.js';
import { getOrFetch, get, set, invalidate, ageSeconds } from '../utils/store.js';
import { openModal, closeModal } from '../components/modal.js';
import { receiptLifecycle } from '../utils/receipt-lifecycle.js';

// Dashboard table sort state
let topSort = { col: 'views', dir: 'desc' };
let cachedTopListings = [];

export async function renderDashboard(container) {
  container.innerHTML = `
    <div class="page-header dashboard-hero">
      <div>
        <div class="page-eyebrow">Store intelligence</div>
        <div class="page-title">Welcome back to <span id="dash-shop-name">your studio</span></div>
        <div class="page-subtitle" id="dash-sub">Loading…</div>
      </div>
      <button class="btn" onclick="window.refreshDashboard()">Refresh data</button>
    </div>
    <div class="page-body">
      <div id="stats-row" class="stats-grid dashboard-stats mb-20">
        ${[1, 2, 3, 4, 5].map(() => `<div class="stat-card">${skeleton(2)}</div>`).join('')}
      </div>
      <div class="dashboard-workspace">
        <div class="dashboard-main-column">
        <div class="card dashboard-table-card">
          <div class="dashboard-card-head"><div><div class="page-eyebrow">Performance</div><h2>Listing performance</h2></div><button class="btn btn-sm btn-ghost" onclick="window.navigate('listings')">View all</button></div>
          <div id="top-listings-wrap">${skeletonCard(5)}</div>
        </div>
        <div class="card dashboard-table-card">
          <div class="dashboard-card-head"><div><div class="page-eyebrow">Fulfilment</div><h2>Recent orders</h2></div><button class="btn btn-sm btn-ghost" onclick="window.navigate('orders')">View all</button></div>
          <div id="recent-orders-wrap">${skeletonCard(4)}</div>
        </div></div>
        <aside class="dashboard-ai-rail">
          <div class="dashboard-ai-head"><span>✦</span><div><strong>Agent context</strong><small>The shop brain's current view</small></div></div>
          <div id="context-widget">${skeletonCard(4)}</div>
          <button class="btn btn-primary" onclick="window.navigate('agent')">Open AI Agent</button>
          <button class="btn" onclick="window.refreshContext()">Refresh context</button>
        </aside>
      </div>
    </div>`;

  window.refreshDashboard = () => {
    invalidate('listings'); invalidate('orders'); invalidate('shop'); invalidate('dashboard');
    renderDashboard(container);
  };
  window.refreshContext = async () => {
    invalidate('shopContext');
    await loadContextWidget(true);
  };
  window._dashSortTop = (col) => {
    topSort.dir = (topSort.col === col && topSort.dir === 'desc') ? 'asc' : 'desc';
    topSort.col = col;
    renderTopTable();
  };

  // Define handlers BEFORE await so clicks work immediately during load
  window._openOrderModal = async (receiptId) => {
    const { escHtml: esc } = await import('../utils/format.js');
    openModal({ title: `Order #${receiptId}`, body: '<div class="loading-center"><div class="spinner"></div></div>', size: 'lg' });
    try {
      const r = await etsy.getReceipt(receiptId);
      const txs = r.transactions || [];
      const raw = r.created_timestamp || r.create_timestamp || 0;
      const dateStr = raw ? new Date(raw * 1000).toLocaleString() : '—';
      const lifecycle = receiptLifecycle(r);
      const statusText = lifecycle.label;
      const body = `
        <div class="grid-2 mb-16" style="gap:12px">
          <div><div class="text-sm text-muted">Buyer</div><div style="font-weight:500">${esc(String(r.name || '—'))}</div></div>
          <div><div class="text-sm text-muted">Total</div><div style="font-weight:600;font-size:16px">${r.grandtotal ? price(r.grandtotal.amount, r.grandtotal.divisor) : '—'}</div></div>
          <div><div class="text-sm text-muted">Date</div><div>${dateStr}</div></div>
          <div><div class="text-sm text-muted">Status</div><div>${statusText}</div></div>
          ${r.message_from_buyer ? `<div style="grid-column:1/-1"><div class="text-sm text-muted">Buyer message</div><div style="background:var(--bg-secondary);padding:8px;border-radius:var(--radius);font-size:13px">${esc(r.message_from_buyer)}</div></div>` : ''}
        </div>
        <div style="font-weight:600;margin-bottom:8px">Items (${txs.length})</div>
        ${txs.map(tx => `<div class="row" style="gap:12px;padding:10px 0;border-bottom:1px solid var(--border);align-items:center;cursor:pointer;border-radius:var(--radius-sm)" onclick="window.navigate('create',{listing_id:${tx.listing_id}});closeModal()" title="Open listing">
          <div style="flex:1;min-width:0">
            <div style="font-weight:500">${esc(tx.title || '—')}</div>
            <div class="text-sm text-muted" style="color:var(--orange)">↗ Listing #${tx.listing_id}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:600">${tx.price ? price(tx.price.amount, tx.price.divisor) : '—'}</div>
            <div class="text-sm text-muted">×${tx.quantity || 1}</div>
          </div>
        </div>`).join('')}
        <div class="row" style="margin-top:16px;gap:8px">
          <button class="btn" onclick="closeModal()">Close</button>
          <button class="btn" onclick="window.navigate('orders');closeModal()">View all orders</button>
          ${lifecycle.canShip ? `<button class="btn btn-primary" onclick="window._doDashShip(${receiptId})">Mark as shipped →</button>` : ''}
        </div>`;
      const { setModalBody } = await import('../components/modal.js');
      setModalBody(body);
    } catch (e) {
      toastError('Error: ' + e.message);
      closeModal();
    }
  };

  window._doDashShip = async (receiptId) => {
    try {
      await etsy.updateReceiptShipment(receiptId, { was_shipped: true });
      toastSuccess('Marked as shipped'); closeModal();
      invalidate('orders');
    } catch (e) { toastError(e.message); }
  };

  // Load all in parallel — each reads from cache if available
  await Promise.allSettled([
    loadStats(),
    loadTopListings(),
    loadRecentOrders(),
    loadContextWidget(false),
  ]);

  updateTimestamp();
}

function updateTimestamp() {
  const sub = document.getElementById('dash-sub');
  if (!sub) return;
  const age = ageSeconds('listings:active');
  if (age < 0) {
    sub.textContent = 'Last updated just now';
  } else if (age < 60) {
    sub.textContent = `Last updated ${age}s ago`;
  } else {
    sub.textContent = `Last updated ${Math.floor(age / 60)}m ago`;
  }
}

// ── Data loaders ───────────────────────────────────────────

async function getListings() {
  return getOrFetch('listings:active', async () => {
    const first = await etsy.getListings({ limit: 100, offset: 0, sort_on: 'created', sort_order: 'desc' });
    const results = first.results || [];
    const total = first.count || 0;

    if (results.length >= total) return results;

    const remaining = Math.ceil((total - results.length) / 100);
    const pages = await Promise.all(
      Array.from({ length: remaining }, (_, i) =>
        etsy.getListings({ limit: 100, offset: (i + 1) * 100, sort_on: 'created', sort_order: 'desc' })
          .then(r => r.results || [])
          .catch(() => [])
      )
    );
    return results.concat(...pages);
  });
}

async function loadStats() {
  try {
    const [shop, ls, orderStats] = await Promise.all([
      getOrFetch('shop', () => etsy.getShop()),
      getListings(),
      getOrFetch('dashboard:orderstats:30', () => statsApi.getOrderStats(30).catch(() => null)),
    ]);

    // Update sidebar shop name
    const shopNameEl = document.getElementById('shop-name-display');
    if (shopNameEl && shop.shop_name) {
      shopNameEl.textContent = shop.shop_name;
      shopNameEl.title = shop.shop_name;
    }

    const totalViews = ls.reduce((s, l) => s + (l.views || 0), 0);
    const totalFavs = ls.reduce((s, l) => s + (l.num_favorers || 0), 0);
    const activeCount = ls.length;
    const digitalCount = ls.filter(l => l.listing_type === 'download').length;
    const revenue = orderStats?.total_revenue ? `$${orderStats.total_revenue.toFixed(2)}` : '—';
    const orders = orderStats?.total_orders ?? '—';

    // Update page title with shop name
    const titleEl = document.getElementById('dash-shop-name');
    if (titleEl && shop.shop_name) titleEl.textContent = shop.shop_name;

    const avgPrice = ls.length
      ? ls.reduce((s, l) => s + (l.price?.amount || 0) / (l.price?.divisor || 100), 0) / ls.length
      : 0;

    document.getElementById('stats-row').innerHTML = `
      ${statCard('Active listings', activeCount, `${digitalCount} digital`, 'listings')}
      ${statCard('Total views', number(totalViews), 'all time', 'analytics')}
      ${statCard('Favorites', number(totalFavs), 'all time', 'analytics')}
      ${statCard('Revenue (30d)', revenue, `${orders} paid orders`, 'analytics')}
      ${statCard('Avg price', avgPrice ? '$' + avgPrice.toFixed(2) : '—', 'per listing', 'listings')}`;
  } catch (e) {
    document.getElementById('stats-row').innerHTML = `<div class="alert alert-error">${escHtml(e.message)}</div>`;
  }
}

async function loadTopListings() {
  const wrap = document.getElementById('top-listings-wrap');
  if (!wrap) return;
  try {
    const ls = await getListings();
    cachedTopListings = ls;
    renderTopTable();
  } catch (e) {
    if (wrap) wrap.innerHTML = `<div class="alert alert-error">${escHtml(e.message)}</div>`;
  }
}

function renderTopTable() {
  const wrap = document.getElementById('top-listings-wrap');
  if (!wrap) return;
  const ls = cachedTopListings;
  const top = [...ls].sort((a, b) => {
    const col = topSort.col;
    let av, bv;
    if (col === 'title') {
      av = a.title || ''; bv = b.title || '';
      return topSort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    if (col === 'price') {
      av = (a.price?.amount || 0) / (a.price?.divisor || 100);
      bv = (b.price?.amount || 0) / (b.price?.divisor || 100);
    } else {
      av = a[col] ?? 0; bv = b[col] ?? 0;
    }
    return topSort.dir === 'asc' ? av - bv : bv - av;
  }).slice(0, 8);

  if (!top.length) { wrap.innerHTML = '<div class="empty-state">No listings yet</div>'; return; }

  const thSort = (col, label, cls = '') => {
    const active = topSort.col === col;
    const arrow = active ? (topSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th class="${cls}" style="cursor:pointer;user-select:none" onclick="window._dashSortTop('${col}')">${label}${arrow}</th>`;
  };

  wrap.innerHTML = `<div class="table-wrap"><table class="dashboard-listings-table">
    <thead><tr>
      <th style="width:36px"></th>
      ${thSort('title', 'Title')}
      ${thSort('views', 'Views')}
      ${thSort('num_favorers', 'Favs', 'dash-table-hide')}
      ${thSort('price', 'Price', 'dash-table-hide')}
      <th>Type</th>
    </tr></thead>
    <tbody>
      ${top.map(l => {
    const img = l.images?.[0]?.url_170x135 || '';
    const t = listingType(l.listing_type);
    return `<tr style="cursor:pointer" onclick="window.navigate('create',{listing_id:${l.listing_id}})">
          <td>${img ? lazyImg(img, 'thumbnail thumbnail-sm', '', '') : '<div class="thumbnail thumbnail-sm"></div>'}</td>
          <td><div style="font-size:13px;font-weight:500">${escHtml(truncate(l.title, 52))}</div></td>
          <td><span class="text-bold">${number(l.views)}</span></td>
          <td class="dash-table-hide">${number(l.num_favorers)}</td>
          <td class="dash-table-hide">${price(l.price?.amount || 0, l.price?.divisor)}</td>
          <td><span class="badge ${t.cls}">${t.label}</span></td>
        </tr>`;
  }).join('')}
    </tbody>
  </table></div>`;
  observeLazyImages(wrap);
}

async function loadRecentOrders() {
  const wrap = document.getElementById('recent-orders-wrap');
  if (!wrap) return;
  try {
    // Use same cache key as orders page so data is shared
    let receipts;
    const cached = get('orders:all');
    if (cached) {
      receipts = cached;
    } else {
      const result = await getOrFetch('orders:recent', () => etsy.getReceipts({ limit: 40 }));
      receipts = result.results || result || [];
    }

    if (!receipts.length) { wrap.innerHTML = '<div class="empty-state">No orders yet</div>'; return; }

    // Sort state for recent orders table
    if (!window._dashOrderSort) window._dashOrderSort = { col: 'created_timestamp', dir: 'desc' };
    window._dashSortOrders = (col) => {
      const s = window._dashOrderSort;
      s.dir = s.col === col && s.dir === 'desc' ? 'asc' : 'desc';
      s.col = col;
      renderRecentOrders(receipts, wrap);
    };

    renderRecentOrders(receipts, wrap);
  } catch (e) {
    if (wrap) wrap.innerHTML = `<div class="alert alert-error">${escHtml(e.message)}</div>`;
  }
}

function renderRecentOrders(receipts, wrap) {
  const s = window._dashOrderSort || { col: 'created_timestamp', dir: 'desc' };
  const sorted = [...receipts].sort((a, b) => {
    if (s.col === 'name') {
      const av = String(a.name || ''), bv = String(b.name || '');
      return s.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    if (s.col === 'grandtotal') {
      const av = (a.grandtotal?.amount || 0) / (a.grandtotal?.divisor || 100);
      const bv = (b.grandtotal?.amount || 0) / (b.grandtotal?.divisor || 100);
      return s.dir === 'asc' ? av - bv : bv - av;
    }
    const av = a[s.col] ?? 0, bv = b[s.col] ?? 0;
    return s.dir === 'asc' ? av - bv : bv - av;
  }).slice(0, 12);

  const thO = (col, label) => {
    const active = s.col === col;
    const arrow = active ? (s.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th style="cursor:pointer;user-select:none;font-size:11px" onclick="window._dashSortOrders('${col}')">${label}${arrow}</th>`;
  };

  wrap.innerHTML = `<div class="table-wrap"><table class="dashboard-orders-table">
    <thead><tr>
      <th style="font-size:11px">Order</th>
      ${thO('name', 'Buyer')}
      ${thO('grandtotal', 'Total')}
      ${thO('created_timestamp', 'Date')}
      <th style="font-size:11px">Status</th>
    </tr></thead>
    <tbody>
      ${sorted.map(r => {
    const raw = r.created_timestamp || r.create_timestamp || 0;
    const dt = raw ? new Date(raw * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
    const lifecycle = receiptLifecycle(r);
    const statusCls = lifecycle.badgeClass;
    const status = lifecycle.label;
    const firstItem = r.transactions?.[0];
    const itemTitle = firstItem ? truncate(firstItem.title || '', 28) : '';
    return `<tr style="cursor:pointer" onclick="window._openOrderModal(${r.receipt_id})">
          <td>
            <div style="font-size:12px;color:var(--text-3)">#${r.receipt_id}</div>
            ${itemTitle ? `<div style="font-size:11px;color:var(--text-3)">${escHtml(itemTitle)}</div>` : ''}
          </td>
          <td style="font-size:13px">${escHtml(String(r.name || '—'))}</td>
          <td style="font-weight:600">${r.grandtotal ? price(r.grandtotal.amount, r.grandtotal.divisor) : '—'}</td>
          <td style="font-size:11px;color:var(--text-3)">${dt}</td>
          <td><span class="badge ${statusCls}" style="font-size:10px">${status}</span></td>
        </tr>`;
  }).join('')}
    </tbody>
  </table></div>`;
}

async function loadContextWidget(force = false) {
  const el = document.getElementById('context-widget');
  if (!el) return;
  try {
    const ctx = force
      ? await (async () => { const { clearShopContext } = await import('../utils/shop-context.js'); clearShopContext(); return getShopContext(true); })()
      : await getShopContext(false);

    const age = Math.round((Date.now() - ctx.timestamp) / 60000);
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:10px">
        ${[
        ['Listings analysed', ctx.listings?.length || 0],
        ['Boilerplate blocks', ctx.boilerplateBlocks?.length || 0],
        ['Tag patterns', ctx.topTags?.length || 0],
        ['Cached', age < 1 ? 'just now' : age + 'm ago'],
      ].map(([l, v]) => `<div style="background:var(--bg-secondary);border-radius:var(--radius);padding:8px"><div class="text-sm text-muted">${l}</div><div style="font-size:17px;font-weight:600">${v}</div></div>`).join('')}
      </div>
      ${ctx.personalizationPatterns?.length ? `<div class="alert alert-info" style="font-size:12px"><strong>Personalization pattern (auto-injected):</strong> ${escHtml(ctx.personalizationPatterns[0]?.text?.slice(0, 120))}…</div>` : ''}
      ${ctx.boilerplateBlocks?.length ? `<div class="text-sm text-muted" style="margin-top:6px">Detected blocks: ${ctx.boilerplateBlocks.map(b => `<span class="badge badge-gray" style="margin:2px">${escHtml(b.label)}</span>`).join('')}</div>` : ''}`;
    if (force) toastSuccess('Shop context refreshed');
  } catch (e) {
    if (el) el.innerHTML = `<div class="text-sm text-muted">Context unavailable: ${escHtml(e.message)}</div>`;
  }
}

// ── Helpers ────────────────────────────────────────────────
function statCard(label, value, sub = '', navigateTo = '') {
  const click = navigateTo ? `onclick="window.navigate('${navigateTo}')" style="cursor:pointer" title="Click to view ${navigateTo}"` : '';
  return `<div class="stat-card" ${click}><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;
}
