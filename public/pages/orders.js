// public/pages/orders.js — smart pagination: loads 2 pages upfront, fetches more on demand
import { etsy } from '../utils/api.js';
import { price, escHtml, truncate } from '../utils/format.js';
import { toastSuccess, toastError, toastInfo } from '../components/toast.js';
import { openModal, closeModal } from '../components/modal.js';
import { get, set, invalidate } from '../utils/store.js';
import { skeletonTable, debounce } from '../utils/perf.js';
import { receiptLifecycle } from '../utils/receipt-lifecycle.js';

const PAGE_SIZE = 20;  // rows per page
const FETCH_CHUNK = 50; // how many to fetch per API call

let state = {
  receipts: [],   // all receipts fetched so far
  filtered: [],
  page: 1,
  loading: false,
  fetching: false,
  totalFetched: 0,   // how many we've asked the API for
  apiDone: false, // true when API returned fewer than FETCH_CHUNK
  sort: { col: 'created_timestamp', dir: 'desc' },
  filter: { search: '', status: '' },
  silentFetch: false, // true when fetching in background without UI updates
};

export async function renderOrders(container) {
  // Reset state on fresh navigation
  const cacheKey = 'orders:all';
  const cached = get(cacheKey);
  if (cached) {
    state.receipts = cached;
    state.totalFetched = cached.length;
    state.apiDone = true; // assume fully loaded from cache
    state.fetching = false; // reset fetching state
  } else {
    state.receipts = [];
    state.totalFetched = 0;
    state.apiDone = false;
    state.fetching = false; // reset fetching state
  }
  state.filtered = [];
  state.page = 1;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Orders</div>
        <div class="page-subtitle" id="orders-count">Loading…</div>
      </div>
      <button class="btn btn-sm" onclick="window._ordRefresh()" title="Force refresh">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M14 8A6 6 0 1 1 2.8 4.5M2 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Refresh
      </button>
    </div>
    <div class="page-body">
      <div class="card">
        <div class="toolbar mb-8">
          <div class="toolbar-search">
            <svg class="toolbar-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            <input id="orders-search" type="text" placeholder="Search by buyer or order #…" style="width:220px" oninput="window._ordSearch(this.value)">
          </div>
          <select onchange="window._ordFilter('status',this.value)" style="width:auto">
            <option value="">All statuses</option>
            <option value="paid">Paid · processing</option>
            <option value="shipped">Shipped</option>
            <option value="canceled">Canceled</option>
            <option value="refunded">Refunded</option>
          </select>
        </div>
        <div id="orders-table-wrap">${skeletonTable(6, 10)}</div>
        <div id="orders-pagination"></div>
      </div>
    </div>`;

  window._ordSearch = debounce((v) => { state.filter.search = v; state.page = 1; applyFilters(); }, 250);
  window._ordFilter = (k, v) => { state.filter[k] = v; state.page = 1; applyFilters(); };
  window._ordRefresh = () => { invalidate('orders'); state.receipts = []; state.totalFetched = 0; state.apiDone = false; state.page = 1; loadChunk(); };
  window._ordSort = (col) => { state.sort.dir = state.sort.col === col && state.sort.dir === 'asc' ? 'desc' : 'asc'; state.sort.col = col; applyFilters(); };
  window._ordPage = async (p) => {
    if (p < 1) return;
    state.page = p;
    renderTable();
    renderPagination();

    // Prefetch next chunk in background if approaching the end
    const maxVisiblePage = Math.ceil(state.filtered.length / PAGE_SIZE);
    if (!state.apiDone && !state.fetching && p >= maxVisiblePage - 2) {
      loadChunk(true); // silent=true - loads in background without UI updates
    }
  };
  window._ordDetail = showOrderDetail;
  window._ordShip = markShipped;

  // Initial load: fetch first 50 (covers first 2+ pages at PAGE_SIZE=20)
  if (!cached) {
    await loadChunk();
  } else {
    applyFilters();
  }
}

async function loadChunk(silent = false) {
  if (state.fetching || state.apiDone) return;
  state.fetching = true;
  state.silentFetch = silent;

  const wrap = document.getElementById('orders-table-wrap');
  if (state.receipts.length === 0 && wrap) wrap.innerHTML = skeletonTable(6, 10);

  try {
    const result = await etsy.getReceipts({ limit: FETCH_CHUNK, offset: state.totalFetched });
    const batch = result.results || [];
    state.totalFetched += batch.length;

    // Deduplicate
    const existingIds = new Set(state.receipts.map(r => r.receipt_id));
    const newOnes = batch.filter(r => !existingIds.has(r.receipt_id));
    state.receipts = [...state.receipts, ...newOnes];

    if (batch.length < FETCH_CHUNK) {
      state.apiDone = true; // no more pages on API
    }

    // Cache when fully loaded
    if (state.apiDone) {
      set('orders:all', state.receipts);
    }

    // Only update UI if not silent
    if (!silent) {
      applyFilters();
    } else {
      // Silent update - just update filtered data without re-rendering
      state.filtered = applyFiltersToData(state.receipts);
    }
  } catch (e) {
    console.error('[orders] loadChunk error:', e);
    if (!silent) {
      toastError('Failed to load orders: ' + e.message);
      const w = document.getElementById('orders-table-wrap');
      if (w && state.receipts.length === 0) w.innerHTML = `<div class="alert alert-error m-16">${escHtml(e.message)}</div>`;
    }
  } finally {
    state.fetching = false;
    state.silentFetch = false;
  }
}

function applyFiltersToData(receipts) {
  let rs = [...receipts];
  const { search, status } = state.filter;

  if (search) {
    const q = search.toLowerCase();
    rs = rs.filter(r =>
      String(r.name || '').toLowerCase().includes(q) ||
      String(r.receipt_id).includes(q) ||
      (r.transactions || []).some(t => String(t.title || '').toLowerCase().includes(q))
    );
  }
  if (status === 'paid') rs = rs.filter(r => receiptLifecycle(r).key === 'paid');
  if (status === 'shipped') rs = rs.filter(r => receiptLifecycle(r).key === 'shipped');
  if (status === 'canceled') rs = rs.filter(r => receiptLifecycle(r).key === 'canceled');
  if (status === 'refunded') rs = rs.filter(r => receiptLifecycle(r).key === 'refunded');

  const { col, dir } = state.sort;
  rs.sort((a, b) => {
    if (col === 'name') {
      const av = String(a.name || ''), bv = String(b.name || '');
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    if (col === 'grandtotal') {
      const av = (a.grandtotal?.amount || 0) / (a.grandtotal?.divisor || 100);
      const bv = (b.grandtotal?.amount || 0) / (b.grandtotal?.divisor || 100);
      return dir === 'asc' ? av - bv : bv - av;
    }
    const av = a[col] ?? 0, bv = b[col] ?? 0;
    return dir === 'asc' ? av - bv : bv - av;
  });

  return rs;
}

function applyFilters() {
  state.filtered = applyFiltersToData(state.receipts);

  const totalRevenue = state.filtered.reduce((s, r) => s + (r.grandtotal?.amount || 0) / (r.grandtotal?.divisor || 100), 0);
  const el = document.getElementById('orders-count');
  if (el) {
    const suffix = !state.apiDone && !state.filter.search && !state.filter.status ? '+' : '';
    el.textContent = `${state.filtered.length}${suffix} orders · Total: $${totalRevenue.toFixed(2)}`;
  }

  renderTable();
  renderPagination();
}

function thSort(col, label) {
  const active = state.sort.col === col;
  const arrow = active ? (state.sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
  return `<th style="cursor:pointer;user-select:none" onclick="window._ordSort('${col}')">${label}${arrow}</th>`;
}

function renderTable() {
  const wrap = document.getElementById('orders-table-wrap');
  if (!wrap) return;

  const start = (state.page - 1) * PAGE_SIZE;
  const page = state.filtered.slice(start, start + PAGE_SIZE);

  if (!page.length && !state.fetching) {
    wrap.innerHTML = '<div class="empty-state" style="padding:32px"><div class="empty-state-icon">📦</div><div class="empty-state-title">No orders found</div></div>';
    return;
  }

  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      ${thSort('receipt_id', 'Order')}
      ${thSort('name', 'Buyer')}
      <th>Items</th>
      ${thSort('grandtotal', 'Total')}
      ${thSort('created_timestamp', 'Date')}
      <th>Status</th>
      <th style="width:120px">Actions</th>
    </tr></thead>
    <tbody>
      ${page.map(r => {
    const lifecycle = receiptLifecycle(r);
    const statusCls = lifecycle.badgeClass;
    const status = lifecycle.label;
    const rawTs = r.created_timestamp || r.create_timestamp || 0;
    const ts = rawTs ? new Date(rawTs * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const itemCount = r.transactions?.length || '—';
    const firstItem = r.transactions?.[0];
    const itemTitle = firstItem ? truncate(firstItem.title || '', 38) : '';
    return `<tr style="cursor:pointer" onclick="window._ordDetail(${r.receipt_id})">
          <td>
            <div style="font-size:13px;font-weight:600">#${r.receipt_id}</div>
            ${itemTitle ? `<div style="font-size:11px;color:var(--text-3)">${escHtml(itemTitle)}</div>` : ''}
          </td>
          <td style="font-weight:500">${escHtml(String(r.name || '—'))}</td>
          <td style="text-align:center">${itemCount}</td>
          <td style="font-weight:600">${r.grandtotal ? price(r.grandtotal.amount, r.grandtotal.divisor) : '—'}</td>
          <td style="font-size:12px;color:var(--text-3)">${ts}</td>
          <td><span class="badge ${statusCls}">${status}</span></td>
          <td>
            <div class="row" style="gap:4px">
              <button class="btn btn-sm" onclick="event.stopPropagation();window._ordDetail(${r.receipt_id})">View</button>
              ${lifecycle.canShip ? `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();window._ordShip(${r.receipt_id})">Ship →</button>` : ''}
            </div>
          </td>
        </tr>`;
  }).join('')}
    </tbody>
  </table></div>`;
}

function renderPagination() {
  const el = document.getElementById('orders-pagination');
  if (!el) return;
  const total = state.filtered.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1 && state.apiDone) { el.innerHTML = ''; return; }

  const start = Math.min((state.page - 1) * PAGE_SIZE + 1, total);
  const end = Math.min(state.page * PAGE_SIZE, total);

  const pageNums = [];
  for (let i = Math.max(1, state.page - 2); i <= Math.min(pages, state.page + 2); i++) pageNums.push(i);

  const loadingMore = !state.apiDone && !state.filter.search && !state.filter.status;

  el.innerHTML = `<div class="pagination">
    <span class="pagination-info">${start}–${end} of ${total}${loadingMore ? '+' : ''}</span>
    <button class="page-btn" onclick="window._ordPage(${state.page - 1})" ${state.page <= 1 ? 'disabled' : ''}>‹</button>
    ${pageNums.map(n => `<button class="page-btn ${n === state.page ? 'active' : ''}" onclick="window._ordPage(${n})">${n}</button>`).join('')}
    ${loadingMore ? `<button class="page-btn" onclick="window._ordPage(${state.page + 1})">›</button>` : `<button class="page-btn" onclick="window._ordPage(${state.page + 1})" ${state.page >= pages ? 'disabled' : ''}>›</button>`}
  </div>`;
}

async function showOrderDetail(receiptId) {
  openModal({ title: `Order #${receiptId}`, body: '<div class="loading-center"><div class="spinner"></div></div>', size: 'lg' });
  try {
    const r = await etsy.getReceipt(receiptId);
    const txs = r.transactions || [];
    const rawTs = r.created_timestamp || r.create_timestamp || 0;
    const dateStr = rawTs ? new Date(rawTs * 1000).toLocaleString() : '—';
    const lifecycle = receiptLifecycle(r);
    const statusText = lifecycle.label;

    const body = `
      <div class="grid-2 mb-16" style="gap:12px">
        <div><div class="text-sm text-muted">Buyer</div><div style="font-weight:500">${escHtml(String(r.name || '—'))}</div></div>
        <div><div class="text-sm text-muted">Total</div><div style="font-weight:600;font-size:16px">${r.grandtotal ? price(r.grandtotal.amount, r.grandtotal.divisor) : '—'}</div></div>
        <div><div class="text-sm text-muted">Date</div><div>${dateStr}</div></div>
        <div><div class="text-sm text-muted">Status</div><div>${statusText}</div></div>
        ${r.message_from_buyer ? `<div style="grid-column:1/-1"><div class="text-sm text-muted">Buyer message</div><div style="background:var(--bg-secondary);padding:8px;border-radius:var(--radius);font-size:13px">${escHtml(r.message_from_buyer)}</div></div>` : ''}
      </div>
      <div style="font-weight:600;margin-bottom:8px">Items (${txs.length})</div>
      ${txs.map(tx => `<div class="row" style="gap:12px;padding:10px 0;border-bottom:1px solid var(--border);align-items:center;cursor:pointer;border-radius:var(--radius-sm)" onclick="window.navigate('create',{listing_id:${tx.listing_id}});closeModal()" title="Open listing">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500">${escHtml(tx.title || '—')}</div>
          <div class="text-sm text-muted" style="color:var(--orange)">↗ Listing #${tx.listing_id}</div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:600">${tx.price ? price(tx.price.amount, tx.price.divisor) : '—'}</div>
          <div class="text-sm text-muted">×${tx.quantity || 1}</div>
        </div>
      </div>`).join('') || '<div class="text-muted">No items</div>'}
      <div class="row" style="margin-top:16px;gap:8px">
        <button class="btn" onclick="closeModal()">Close</button>
        ${lifecycle.canShip ? `<button class="btn btn-primary" onclick="window._ordShip(${receiptId});closeModal()">Mark as shipped →</button>` : ''}
      </div>`;

    const { setModalBody } = await import('../components/modal.js');
    setModalBody(body);
  } catch (e) {
    toastError('Order detail: ' + e.message);
    closeModal();
  }
}

async function markShipped(receiptId) {
  try {
    await etsy.updateReceiptShipment(receiptId, { was_shipped: true });
    toastSuccess('Marked as shipped');
    invalidate('orders');
    state.receipts = state.receipts.map(r => r.receipt_id === receiptId ? { ...r, is_shipped: true } : r);
    set('orders:all', state.receipts);
    applyFilters();
  } catch (e) {
    toastError('Ship error: ' + e.message);
  }
}
