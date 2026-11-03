// public/pages/listings.js — Full listings manager

import { etsy, social, kv } from '../utils/api.js';
import { price, number, truncate, timeAgo, listingState, listingType, escHtml, escJsSingle } from '../utils/format.js';
import { toastSuccess, toastError, toastInfo } from '../components/toast.js';
import { openModal, closeModal, setModalBody } from '../components/modal.js';
import { runSeoAudit } from '../components/seo-audit.js';
import { generateImagePrompt } from '../components/image-prompt.js';
import { openImageResizeModal } from '../components/image-resize-modal.js';
import { debounce, skeletonTable, observeLazyImages, lazyImg, clearPageCache } from '../utils/perf.js';
import { getOrFetch, invalidate, set, get } from '../utils/store.js';
import { getPostsByListing } from '../utils/post-store.js';

const PAGE_SIZE = 25;

let state = {
  listings: [],
  filtered: [],
  selected: new Set(),
  page: 1,
  perPage: PAGE_SIZE,
  sort: { col: 'views', dir: 'desc' },
  filter: { search: '', status: 'active', type: '', section: '' },
  view: 'list',
  loading: false,
  total: 0,
  sections: [],
  postMap: new Map(), // listing_id -> { platforms: Set<platform>, urls: Map<platform, url> }
  fbSyncMap: new Map(), // listing_id -> { synced_at: '...' }
};

// ── Facebook Shop sync state (server-side KV, localStorage fallback) ──────
const FB_SYNC_KEY = 'fb_shop_sync';

async function loadFbSyncMap() {
  try {
    const data = await kv.getFbSync();
    // data is { listing_id: entry } from server
    const map = new Map(Object.entries(data || {}).map(([k, v]) => [Number(k), v]));
    // Persist to localStorage as local cache
    localStorage.setItem(FB_SYNC_KEY, JSON.stringify(Object.fromEntries(map)));
    return map;
  } catch {
    // KV not configured or offline — fall back to localStorage
    try { return new Map(Object.entries(JSON.parse(localStorage.getItem(FB_SYNC_KEY) || '{}')).map(([k, v]) => [Number(k), v])); } catch { return new Map(); }
  }
}

function loadFbConfig() {
  try { return JSON.parse(localStorage.getItem('fb_shop_config') || 'null'); } catch { return null; }
}

async function saveFbSyncEntry(listingId, data) {
  // Update local cache immediately
  try {
    const obj = JSON.parse(localStorage.getItem(FB_SYNC_KEY) || '{}');
    if (data) obj[listingId] = data; else delete obj[listingId];
    localStorage.setItem(FB_SYNC_KEY, JSON.stringify(obj));
  } catch { }
  // Persist to server (fire and forget — UI already updated from in-memory state)
  try {
    await kv.setFbSync(data ? { listing_id: listingId, ...data } : { listing_id: listingId });
  } catch { /* KV not configured — localStorage cache is fine for single user */ }
}

export async function renderListings(container, params = {}) {
  container.innerHTML = `
    <div class="page-header listings-hero">
      <div>
        <div class="page-eyebrow">Catalog workspace</div>
        <div class="page-title">Listings</div>
        <div id="listings-count" class="page-subtitle">Loading...</div>
      </div>
      <div class="row">
        <button class="btn btn-primary" onclick="window.navigate('create')">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          New listing
        </button>
        <button class="btn btn-sm" id="refresh-btn" onclick="window.reloadListings()" title="Force refresh">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M14 8A6 6 0 1 1 2.8 4.5M2 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="page-body">
      <div class="card">
        <div class="toolbar" id="toolbar">
          <div class="toolbar-search">
            <svg class="toolbar-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            <input type="text" placeholder="Search listings..." id="search-input" oninput="window.listingsSearch(this.value)" value="${state.filter.search}">
          </div>
          <select id="filter-status" onchange="window.listingsFilter('status', this.value)" style="width:auto">
            <option value="active" ${state.filter.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="inactive" ${state.filter.status === 'inactive' ? 'selected' : ''}>Inactive</option>
            <option value="draft" ${state.filter.status === 'draft' ? 'selected' : ''}>Draft</option>
            <option value="all">All</option>
          </select>
          <select id="filter-type" onchange="window.listingsFilter('type', this.value)" style="width:auto">
            <option value="">All types</option>
            <option value="download" ${state.filter.type === 'download' ? 'selected' : ''}>Digital</option>
            <option value="physical" ${state.filter.type === 'physical' ? 'selected' : ''}>Physical/Service</option>
          </select>
          <select id="filter-section" onchange="window.listingsFilter('section', this.value)" style="width:auto">
            <option value="">All sections</option>
          </select>
          <div class="toolbar-sep"></div>
          <div class="toolbar-right">
            <button class="btn btn-sm" id="fb-sync-all-btn" onclick="window.syncAllToFbShop()" title="Import Facebook catalog — marks which listings are already in FB Shop" style="color:#1877F2;gap:4px">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9 6h2.5L11 8.5H9V14H6.5V8.5H5V6h1.5V4.5C6.5 3 7.5 2 9 2h2v2.5H9.5C9.2 4.5 9 4.7 9 5V6z"/></svg>
              FB Shop ↓
            </button>
            <button class="btn btn-sm" onclick="window.openResizeTool()" title="Resize images for all platforms">📐 Resize</button>
            <button class="btn btn-sm ${state.view === 'list' ? 'btn-primary' : ''}" onclick="window.setView('list')" title="List view">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
            <button class="btn btn-sm ${state.view === 'grid' ? 'btn-primary' : ''}" onclick="window.setView('grid')" title="Grid view">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
          </div>
        </div>

        <div id="listings-body"></div>
        <div id="pagination-row"></div>
      </div>
      <div id="bulk-bar"></div>
    </div>`;

  window.reloadListings = () => { invalidate('listings'); loadListings(true); };
  window.listingsSearch = debounce((val) => { state.filter.search = val; state.page = 1; applyFilters(); }, 250);
  window.openResizeTool = openImageResizeModal;
  window.listingsFilter = (key, val) => { state.filter[key] = val; state.page = 1; if (key === 'status') { invalidate('listings'); loadListings(true); } else { applyFilters(); } };
  window.setView = (v) => { state.view = v; applyFilters(); document.querySelectorAll('.toolbar .btn-sm').forEach(b => b.classList.toggle('btn-primary', b.getAttribute('onclick')?.includes(v))); };
  window.sortListings = (col) => { state.sort.dir = (state.sort.col === col && state.sort.dir === 'asc') ? 'desc' : 'asc'; state.sort.col = col; applyFilters(); };
  window.toggleSelect = (id, checked) => { checked ? state.selected.add(id) : state.selected.delete(id); renderBulkBar(); };
  window.toggleSelectAll = (checked) => { state.filtered.forEach(l => checked ? state.selected.add(l.listing_id) : state.selected.delete(l.listing_id)); renderBulkBar(); renderListingsBody(); };
  window.bulkActivate = () => bulkAction('active');
  window.bulkDeactivate = () => bulkAction('inactive');
  window.bulkDelete = () => confirmBulkDelete();
  window.bulkClearSelection = () => { state.selected.clear(); renderBulkBar(); renderListingsBody(); };
  window.deactivateListing = deactivateListing;
  window.deleteListing = deleteListing;
  window.duplicateListing = duplicateListing;
  window.openListingModal = openListingModal;
  window.runSeoAudit = async (listingId) => {
    const listing = state.listings.find(l => l.listing_id === listingId);
    if (listing) await runSeoAudit(listing, 'gemini');
  };
  window.runAiImprove = async (listingId) => {
    const listing = state.listings.find(l => l.listing_id === listingId);
    if (!listing) return;
    const prevCount = parseInt(localStorage.getItem('ai_improve_count_' + listingId) || '0');
    if (prevCount > 0) {
      const again = confirm(`This listing was already AI-improved ${prevCount} time${prevCount > 1 ? 's' : ''}.\n\nRe-running gives diminishing returns — the AI may suggest only minor tweaks.\n\nContinue?`);
      if (!again) return;
    }
    const btn = document.getElementById('improve-btn-' + listingId);
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'audit',
          provider: 'gemini',
          _rawSystem: 'You are an Etsy SEO expert. Return ONLY valid JSON, no markdown, no explanation.',
          _rawPrompt: `Improve this Etsy listing for 2026 search algorithm. Return ONLY JSON:
{
  "title": "improved title ≤140 chars, strongest keywords first",
  "tags": ["up to 13 tags", "each ≤20 chars", "mix short and long-tail"],
  "description_intro": "improved first 160 chars — hooks buyer, includes top keyword naturally"
}

Current listing:
Title (${listing.title?.length || 0}/140): "${listing.title || ''}"
Tags (${(listing.tags || []).length}/13): ${(listing.tags || []).join(', ')}
Description start: "${(listing.description || '').slice(0, 300)}"
Price: $${((listing.price?.amount || 0) / (listing.price?.divisor || 100)).toFixed(2)}
Type: ${listing.listing_type || 'digital'}
Views: ${listing.views || 0} | Favorites: ${listing.num_favorers || 0}
Niche: Canva templates, SVG/PNG sublimation, AI photo services, custom portraits. US market.`,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      let improve = data.data;
      if (typeof improve === 'string') {
        const m = improve.match(/\{[\s\S]*\}/);
        improve = m ? JSON.parse(m[0]) : {};
      }
      sessionStorage.setItem('ai_improve_' + listingId, JSON.stringify(improve));
      // Increment usage counter so subsequent runs require confirmation
      const ck = 'ai_improve_count_' + listingId;
      localStorage.setItem(ck, (parseInt(localStorage.getItem(ck) || '0') + 1).toString());
      window.navigate('create', { listing_id: listingId });
    } catch (e) {
      toastError('AI improve failed: ' + e.message);
      const cnt = parseInt(localStorage.getItem('ai_improve_count_' + listingId) || '0');
      if (btn) { btn.disabled = false; btn.textContent = cnt > 0 ? '✦ Re-improve' : '✦ Improve'; }
    }
  };
  window.openListingImagePrompt = async (listingId) => {
    const listing = state.listings.find(l => l.listing_id === listingId);
    if (listing) await generateImagePrompt(listing.title || '', listingId, 'claude', 6);
  };
  window.startInlinePrice = startInlinePrice;
  window.saveInlinePrice = saveInlinePrice;
  window.setPage = (p) => { state.page = p; renderListingsBody(); renderPagination(); };
  window.setPerPage = (n) => { state.perPage = parseInt(n); state.page = 1; renderListingsBody(); renderPagination(); };
  window.openFbShopModal = openFbShopModal;
  window.syncToFbShop = syncToFbShop;
  window.unsyncFromFbShop = unsyncFromFbShop;
  window.syncAllToFbShop = syncAllToFbShop;

  const [fbMap] = await Promise.all([loadFbSyncMap(), loadListings(false), loadSections()]);
  state.fbSyncMap = fbMap;
  // Re-render now that fbSyncMap is loaded — avoids race where applyFilters ran
  // before loadFbSyncMap resolved (listings hit cache faster than KV responds)
  applyFilters();
}

let _listingsReqId = 0;

// Fetches ALL listings by paginating through Etsy API (max 100 per request)
async function fetchAllListings(statusParam) {
  const PAGE = 100;
  const first = await etsy.getListings({ limit: PAGE, offset: 0, state: statusParam });
  const total = first.count || 0;
  const results = [...(first.results || [])];

  if (total > PAGE) {
    const pages = await Promise.allSettled(
      Array.from({ length: Math.ceil((total - PAGE) / PAGE) }, (_, i) =>
        etsy.getListings({ limit: PAGE, offset: PAGE + i * PAGE, state: statusParam })
      )
    );
    for (const p of pages) {
      if (p.status === 'fulfilled') results.push(...(p.value.results || []));
    }
  }

  return results;
}

async function loadListings(forceRefresh = false) {
  const reqId = ++_listingsReqId;
  state.loading = true;
  const body = document.getElementById('listings-body');

  const statusParam = state.filter.status === 'all' ? 'active' : (state.filter.status || 'active');
  const cacheKey = `listings:${statusParam}`;

  // Try cache first (unless force refresh)
  if (!forceRefresh) {
    const cached = get(cacheKey);
    if (cached) {
      if (reqId !== _listingsReqId) return;
      state.listings = cached;
      state.loading = false;
      getPostsByListing().then(m => { state.postMap = m; applyFilters(); }).catch(() => applyFilters());
      return;
    }
  }

  if (body) body.innerHTML = skeletonTable(8, 10);

  try {
    const [listings] = await Promise.all([
      fetchAllListings(statusParam),
      getPostsByListing().then(m => { state.postMap = m; }).catch(() => {}),
    ]);
    if (reqId !== _listingsReqId) return;
    state.listings = listings;
    set(cacheKey, state.listings);
    applyFilters();
  } catch (e) {
    if (reqId !== _listingsReqId) return;
    toastError('Failed to load listings: ' + e.message);
    const b = document.getElementById('listings-body');
    if (b) b.innerHTML = `<div class="alert alert-error m-16">Failed to load: ${escHtml(e.message)}</div>`;
  }
  state.loading = false;
}

async function loadSections() {
  try {
    const result = await getOrFetch('sections', () => etsy.getShopSections());
    state.sections = result.results || result || [];
    const sel = document.getElementById('filter-section');
    if (sel && state.sections.length) {
      state.sections.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.shop_section_id;
        opt.textContent = s.title;
        sel.appendChild(opt);
      });
    }
  } catch (e) {
    console.warn('[listings] loadSections failed:', e.message);
  }
}

function applyFilters() {
  let ls = [...state.listings];
  const { search, type, section } = state.filter;

  if (search) {
    const q = search.toLowerCase();
    ls = ls.filter(l => l.title?.toLowerCase().includes(q) || (l.tags || []).some(t => t.toLowerCase().includes(q)));
  }
  if (type) ls = ls.filter(l => l.listing_type === type);
  if (section) ls = ls.filter(l => String(l.shop_section_id) === String(section));

  // Sort
  const { col, dir } = state.sort;
  ls.sort((a, b) => {
    let av = a[col] ?? 0, bv = b[col] ?? 0;
    if (col === 'price') { av = a.price?.amount || 0; bv = b.price?.amount || 0; }
    if (col === 'title') { av = a.title || ''; bv = b.title || ''; return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av); }
    return dir === 'asc' ? av - bv : bv - av;
  });

  state.filtered = ls;
  const countEl = document.getElementById('listings-count');
  if (countEl) countEl.textContent = `${ls.length} listings`;
  renderListingsBody();
  renderPagination();
}

const PLATFORM_STYLE = {
  pinterest: { label: 'Pin', bg: '#fdecea', color: '#c62828' },
  instagram: { label: 'IG',  bg: '#f3e5f5', color: '#7b1fa2' },
  facebook:  { label: 'FB',  bg: '#e3f2fd', color: '#1565c0' },
  tiktok:    { label: 'TT',  bg: '#f5f5f5', color: '#111'    },
};

function socialBadges(listingId) {
  const entry = state.postMap.get(Number(listingId));
  if (!entry?.platforms?.size) return '';
  return `<span style="display:inline-flex;gap:3px;margin-top:3px">${
    [...entry.platforms].map(p => {
      const s = PLATFORM_STYLE[p] || { label: p.slice(0,2).toUpperCase(), bg: 'var(--bg-secondary)', color: 'var(--text-2)' };
      const url = entry.urls?.get(p);
      const inner = `<span title="Posted to ${p}${url ? ' — click to view' : ''}" style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;background:${s.bg};color:${s.color}">✓ ${s.label}</span>`;
      return url ? `<a href="${url}" target="_blank" rel="noopener" style="text-decoration:none">${inner}</a>` : inner;
    }).join('')
  }</span>`;
}

// ── Facebook Shop: import catalog → mark which listings are in FB ──────────
// READ-ONLY: reads your FB catalog and marks matching Etsy listings with the FB badge.
// Does NOT push anything to Facebook.
async function syncAllToFbShop() {
  const btn = document.getElementById('fb-sync-all-btn');
  const fbCfg = loadFbConfig();

  if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }

  try {
    const res = await social.getFacebookCatalogProducts(
      fbCfg ? { token: fbCfg.token, catalog_id: fbCfg.catalog_id } : {}
    );
    if (!res.success) throw new Error(res.error || 'Failed to read catalog');

    const products = res.products || [];
    if (!products.length) {
      toastInfo('Facebook catalog is empty — no listings to mark');
      return;
    }

    // Match by retailer_id = "etsy_<listing_id>"
    let matched = 0;
    const now = new Date().toISOString();
    for (const product of products) {
      const rid = product.retailer_id || '';
      if (!rid.startsWith('etsy_')) continue;
      const listingId = Number(rid.replace('etsy_', ''));
      if (!listingId) continue;
      if (!state.fbSyncMap.has(listingId)) {
        const entry = { synced_at: now };
        state.fbSyncMap.set(listingId, entry);
        saveFbSyncEntry(listingId, entry);
        matched++;
      }
    }

    renderListingsBody();
    toastSuccess(`FB Shop: ${products.length} product${products.length !== 1 ? 's' : ''} in catalog — ${matched} newly marked`);
  } catch (e) {
    toastError('FB catalog read failed: ' + e.message);
  }

  if (btn) {
    btn.disabled = false;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9 6h2.5L11 8.5H9V14H6.5V8.5H5V6h1.5V4.5C6.5 3 7.5 2 9 2h2v2.5H9.5C9.2 4.5 9 4.7 9 5V6z"/></svg> FB Shop ↓`;
  }
}

// ── Facebook Shop modal + sync ─────────────────────────────
async function openFbShopModal(listingId) {
  const listing = state.listings.find(l => l.listing_id === listingId);
  if (!listing) return;

  const isSynced = state.fbSyncMap.has(listingId);
  const syncData = state.fbSyncMap.get(listingId);
  const etsyUrl = `https://www.etsy.com/listing/${listingId}`;
  const priceVal = ((listing.price?.amount || 0) / (listing.price?.divisor || 100)).toFixed(2);
  const images = (listing.images || []).filter(img => img.url_fullxfull || img.url_570xN);

  const imagesHtml = images.length ? `
    <div class="form-group">
      <label class="form-label">Images (${Math.min(images.length, 10)} will sync to Facebook)</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
        ${images.slice(0, 10).map((img, i) => {
          const url = img.url_170x135 || img.url_570xN || img.url_fullxfull;
          return `<img src="${escHtml(url)}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:${i === 0 ? '2px solid #1877F2' : '1px solid var(--border)'}">`;
        }).join('')}
      </div>
      <div style="font-size:11px;color:var(--text-3);margin-top:5px">Blue border = main image. All images sent automatically from your Etsy listing.</div>
    </div>
  ` : `<div style="font-size:12px;color:var(--text-3);padding:8px;background:var(--bg-secondary);border-radius:6px">No images found on this listing.</div>`;

  openModal({
    title: 'Sync to Facebook Shop',
    size: 'lg',
    body: `
      <div style="display:flex;flex-direction:column;gap:14px">
        ${isSynced ? `<div style="background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7;border-radius:8px;padding:8px 12px;font-size:12px">✓ Already in Facebook catalog since ${new Date(syncData.synced_at).toLocaleDateString()}. Clicking "Update" will overwrite.</div>` : ''}
        <div class="form-group">
          <label class="form-label">Product title <span style="color:var(--text-3);font-weight:400">(editable)</span></label>
          <input id="fb-name" type="text" value="${escHtml(listing.title || '')}" maxlength="200">
        </div>
        <div class="form-group">
          <label class="form-label">Description <span style="color:var(--text-3);font-weight:400">(editable)</span></label>
          <textarea id="fb-description" class="input" rows="3" style="resize:vertical" maxlength="9999">${escHtml((listing.description || '').slice(0, 2000))}</textarea>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group">
            <label class="form-label">Price (USD) <span style="color:var(--text-3);font-weight:400">(editable)</span></label>
            <input id="fb-price" class="input" type="number" step="0.01" min="0" value="${priceVal}">
          </div>
          <div class="form-group">
            <label class="form-label">Checkout URL <span style="color:var(--text-3);font-weight:400">(auto)</span></label>
            <div style="font-size:11px;padding:8px 10px;background:var(--bg-secondary);border-radius:6px;border:1px solid var(--border);color:var(--text-2);line-height:1.4;word-break:break-all">
              Customers click → your Etsy listing<br>
              <a href="${etsyUrl}" target="_blank" rel="noopener" style="color:#1877F2;font-size:10px">${etsyUrl}</a>
            </div>
          </div>
        </div>
        ${imagesHtml}
      </div>`,
    footer: `
      <div style="display:flex;gap:8px;justify-content:space-between;width:100%;flex-wrap:wrap">
        <div style="display:flex;gap:6px">
          ${isSynced ? `<button class="btn btn-sm btn-danger" id="fb-remove-btn" onclick="window.unsyncFromFbShop(${listingId})">Remove</button>` : ''}
          ${(() => { const cfg = loadFbConfig(); const fbIcon = `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0"><path d="M9 6h2.5L11 8.5H9V14H6.5V8.5H5V6h1.5V4.5C6.5 3 7.5 2 9 2h2v2.5H9.5C9.2 4.5 9 4.7 9 5V6z"/></svg>`; return cfg?.catalog_id ? `<a href="https://business.facebook.com/commerce/catalogs/${cfg.catalog_id}/products/" target="_blank" rel="noopener" class="btn btn-sm" style="background:#1877F2;color:#fff;display:inline-flex;align-items:center;gap:5px" title="View all products in Commerce Manager">${fbIcon} Commerce Manager</a><a href="https://www.facebook.com/${cfg.page_id}?sk=shop" target="_blank" rel="noopener" class="btn btn-sm" style="background:#1877F2;color:#fff;display:inline-flex;align-items:center;gap:5px" title="View Facebook Page Shop">${fbIcon} Page Shop</a>` : ''; })()}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" onclick="closeModal()">Cancel</button>
          <button class="btn btn-sm btn-primary" id="fb-sync-btn" onclick="window.syncToFbShop(${listingId})">${isSynced ? 'Update' : 'Add to Facebook Shop'}</button>
        </div>
      </div>`,
  });

  // Check config asynchronously — show warning if not set up
  const fbCfg = loadFbConfig();
  social.checkFacebookShopConfig(fbCfg ? { token: fbCfg.token, catalog_id: fbCfg.catalog_id } : {}).then(cfg => {
    if (!cfg.hasToken || !cfg.hasCatalogId) {
      const btn = document.getElementById('fb-sync-btn');
      if (btn) {
        btn.disabled = true;
        btn.title = 'Configure FACEBOOK_PAGE_TOKEN and FACEBOOK_CATALOG_ID in the application server environment';
      }
      const body = document.getElementById('modal-body');
      if (body) {
        const warn = document.createElement('div');
        warn.className = 'alert';
        warn.style.cssText = 'background:var(--yellow-bg,#fff8e1);color:var(--yellow-text,#7c5700);border:1px solid var(--yellow-border,#ffe082);border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:8px';
        warn.innerHTML = `Not configured. Go to <strong>Settings → Social → Facebook Shop</strong> and connect your account.`;
        body.prepend(warn);
      }
    }
  }).catch(() => {});
}

async function syncToFbShop(listingId) {
  const btn = document.getElementById('fb-sync-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }

  const name = document.getElementById('fb-name')?.value?.trim();
  const description = document.getElementById('fb-description')?.value?.trim();
  const price_amount = parseFloat(document.getElementById('fb-price')?.value || 0);
  const checkout_url = `${window.location.origin}/api/checkout?products=etsy_${listingId}:1`;

  // Collect all image URLs from the listing in state
  const listing = state.listings.find(l => l.listing_id === listingId);
  const image_urls = (listing?.images || [])
    .slice(0, 10)
    .map(img => img.url_fullxfull || img.url_570xN)
    .filter(Boolean);

  const fbCfg = loadFbConfig();
  try {
    const res = await social.syncFacebookShop({ listing_id: listingId, name, description, price_amount, currency: 'USD', image_urls, checkout_url, ...(fbCfg ? { token: fbCfg.token, catalog_id: fbCfg.catalog_id } : {}) });
    if (!res.success) throw new Error(res.error || 'Sync failed');

    const entry = { synced_at: new Date().toISOString() };
    state.fbSyncMap.set(listingId, entry);
    saveFbSyncEntry(listingId, entry); // async, fire-and-forget ok
    renderListingsBody();
    closeModal();
    toastSuccess('Added to Facebook Shop');
  } catch (e) {
    toastError('Facebook sync failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Add to Facebook Shop'; }
  }
}

async function unsyncFromFbShop(listingId) {
  const btn = document.getElementById('fb-remove-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }

  const fbCfg2 = loadFbConfig();
  try {
    const res = await social.unsyncFacebookShop({ listing_id: listingId, ...(fbCfg2 ? { token: fbCfg2.token, catalog_id: fbCfg2.catalog_id } : {}) });
    if (!res.success) throw new Error(res.error || 'Remove failed');

    state.fbSyncMap.delete(listingId);
    saveFbSyncEntry(listingId, null); // async, fire-and-forget ok
    renderListingsBody();
    closeModal();
    toastSuccess('Removed from Facebook Shop');
  } catch (e) {
    toastError('Facebook remove failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Remove from Facebook'; }
  }
}

// ── Listing detail modal ──────────────────────────────────────────────────────
async function openListingModal(listingId) {
  const listing = state.listings.find(l => l.listing_id === listingId);
  if (!listing) return;

  const img = listing.MainImage?.url_570xN || listing.images?.[0]?.url_570xN || '';
  const priceVal = ((listing.price?.amount || 0) / (listing.price?.divisor || 100)).toFixed(2);
  const etsyUrl = `https://www.etsy.com/listing/${listingId}`;
  const type = listingType(listing.listing_type);
  const st = listingState(listing.state);
  const postedEntry = state.postMap.get(Number(listingId));
  const PSTYLE = { pinterest: { bg: '#fdecea', color: '#c62828', label: 'Pinterest' }, instagram: { bg: '#f3e5f5', color: '#7b1fa2', label: 'Instagram' }, facebook: { bg: '#e3f2fd', color: '#1565c0', label: 'Facebook' }, tiktok: { bg: '#f5f5f5', color: '#111', label: 'TikTok' } };
  const postedBadges = postedEntry?.platforms?.size ? [...postedEntry.platforms].map(p => {
    const s = PSTYLE[p] || { label: p, bg: 'var(--bg-secondary)', color: 'var(--text-2)' };
    const url = postedEntry.urls?.get(p);
    const badge = `<span style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:5px;background:${s.bg};color:${s.color}">✓ ${s.label}</span>`;
    return url ? `<a href="${url}" target="_blank" rel="noopener" style="text-decoration:none" title="View post">${badge}</a>` : badge;
  }).join(' ') : '';

  const cnt = parseInt(localStorage.getItem('ai_improve_count_' + listingId) || '0');

  openModal({
    title: truncate(listing.title || 'Listing', 55),
    size: 'lg',
    body: `
      <div style="display:flex;gap:16px;margin-bottom:16px">
        ${img ? `<img src="${escHtml(img)}" style="width:120px;height:120px;object-fit:cover;border-radius:8px;flex-shrink:0;border:1px solid var(--border)">` : `<div style="width:120px;height:120px;background:var(--bg-secondary);border-radius:8px;flex-shrink:0"></div>`}
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;margin-bottom:6px;line-height:1.4">${escHtml(listing.title || '')}</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
            <span style="font-size:13px;font-weight:700;color:var(--orange)">$${priceVal}</span>
            <span class="badge ${type.cls}">${type.label}</span>
            <span class="badge ${st.cls}">${st.label}</span>
          </div>
          <div style="font-size:12px;color:var(--text-3);display:flex;gap:12px;flex-wrap:wrap">
            <span>${number(listing.views || 0)} views</span>
            <span>${number(listing.num_favorers || 0)} favs</span>
            <span>ID: ${listingId}</span>
          </div>
          ${postedBadges ? `<div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap">${postedBadges}</div>` : ''}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button class="btn btn-primary" onclick="closeModal();window.navigate('create',{listing_id:${listingId}})" style="justify-content:center">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-9 9H2v-3l9-9z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
          Edit listing
        </button>
        <button class="btn btn-primary" style="background:#C13584;border-color:#C13584;justify-content:center" onclick="closeModal();window.navigate('social',{listing_id:${listingId},autoGenerate:true})">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="4" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="4" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="13" r="2" stroke="currentColor" stroke-width="1.4"/><path d="M6 4h2M8 4l2 0M5.7 5.7l1.6 5.6M10.3 5.7L8.7 11.3" stroke="currentColor" stroke-width="1.4"/></svg>
          Post to Social
        </button>
        <button class="btn" onclick="closeModal();window.runSeoAudit(${listingId})" style="justify-content:center;color:var(--orange)">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.5 3.5L13 6l-3 3 .8 4L8 11l-2.8 2 .8-4L3 6l3.5-1.5L8 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          SEO Audit
        </button>
        <button class="btn" id="modal-improve-btn" onclick="closeModal();window.runAiImprove(${listingId})" style="justify-content:center${cnt > 0 ? ';color:var(--orange)' : ''}">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
          ${cnt > 0 ? 'Re-improve' : 'AI Improve'}
        </button>
        <button class="btn" onclick="closeModal();window.openListingImagePrompt(${listingId})" style="justify-content:center;color:var(--blue-text)">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M2 10l3-3 2 2 3-3 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Image Prompts
        </button>
        <button class="btn" onclick="closeModal();window.openFbShopModal(${listingId})" style="justify-content:center;color:${state.fbSyncMap.has(listingId) ? 'var(--green-text,#2e7d32)' : '#1877F2'}">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M9 6h2.5L11 8.5H9V14H6.5V8.5H5V6h1.5V4.5C6.5 3 7.5 2 9 2h2v2.5H9.5C9.2 4.5 9 4.7 9 5V6z"/></svg>
          ${state.fbSyncMap.has(listingId) ? 'FB Shop ✓' : 'Add to FB Shop'}
        </button>
      </div>`,
    footer: `
      <div style="display:flex;gap:8px;justify-content:space-between;width:100%;align-items:center">
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-danger" onclick="closeModal();window.deleteListing(${listingId},'${(listing.title || '').slice(0, 30).replace(/'/g, '')}')" title="Delete listing">Delete</button>
          <button class="btn btn-sm" onclick="closeModal();window.deactivateListing(${listingId},'${listing.state}')">${listing.state === 'active' ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-sm" onclick="closeModal();window.duplicateListing(${listingId})">Duplicate</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <a href="${etsyUrl}" target="_blank" rel="noopener" class="btn btn-sm" style="color:var(--orange)">View on Etsy ↗</a>
          <button class="btn btn-sm" onclick="closeModal()">Close</button>
        </div>
      </div>`,
  });
}

function renderListingsBody() {
  const body = document.getElementById('listings-body');
  if (!body) return;

  const start = (state.page - 1) * state.perPage;
  const page = state.filtered.slice(start, start + state.perPage);

  if (!page.length) {
    body.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📦</div><div class="empty-state-title">No listings found</div><p>Try changing your filters</p></div>`;
    return;
  }

  if (state.view === 'grid') {
    body.innerHTML = `<div class="listings-grid" style="padding:12px">
      ${page.map(l => {
      const img = l.MainImage?.url_170x135 || l.images?.[0]?.url_170x135 || l.Images?.[0]?.url_170x135 || '';
      const sel = state.selected.has(l.listing_id);
      const type = listingType(l.listing_type);
      return `<div class="listing-card ${sel ? 'selected' : ''}" onclick="window.openListingModal(${l.listing_id})">
          <input type="checkbox" class="listing-card-check" ${sel ? 'checked' : ''} onclick="event.stopPropagation(); window.toggleSelect(${l.listing_id}, this.checked)">
          ${img ? `<img class="listing-card-img" src="${img}" loading="lazy" alt="" onerror="this.onerror=null;this.style.visibility='hidden'">` : `<div class="listing-card-img" style="background:var(--bg-hover)"></div>`}
          <div class="listing-card-body">
            <div class="listing-card-title">${escHtml(truncate(l.title, 60))}</div>
            <div class="row-between">
              <span class="listing-card-price">${price(l.price?.amount || 0, l.price?.divisor)}</span>
              <span class="badge ${type.cls}">${type.label}</span>
            </div>
            <div class="listing-card-meta mt-4">${number(l.views)} views · ${number(l.num_favorers)} favs</div>
            ${socialBadges(l.listing_id)}
            ${state.fbSyncMap.has(l.listing_id) ? `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;background:#e3f2fd;color:#1565c0;cursor:pointer" onclick="event.stopPropagation();window.openFbShopModal(${l.listing_id})" title="In Facebook Shop">FB Shop</span>` : ''}
          </div>
        </div>`;
    }).join('')}
    </div>`;
    return;
  }

  // List view
  const allSelected = page.every(l => state.selected.has(l.listing_id));
  body.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th class="check-col"><input type="checkbox" ${allSelected ? 'checked' : ''} onchange="window.toggleSelectAll(this.checked)"></th>
      <th style="width:76px"></th>
      <th onclick="window.sortListings('title')" class="${sortClass('title')}">Title</th>
      <th onclick="window.sortListings('price')" class="${sortClass('price')}" style="width:80px">Price</th>
      <th onclick="window.sortListings('views')" class="${sortClass('views')}" style="width:70px">Views</th>
      <th onclick="window.sortListings('num_favorers')" class="${sortClass('num_favorers')}" style="width:60px">Favs</th>
      <th style="width:80px">Type</th>
      <th style="width:80px">Status</th>
      <th onclick="window.sortListings('created_timestamp')" class="${sortClass('created_timestamp')}" style="width:90px">Created</th>
      <th style="width:90px"></th>
    </tr></thead>
    <tbody>
      ${page.map(l => {
    const img = l.MainImage?.url_170x135 || l.images?.[0]?.url_170x135 || l.Images?.[0]?.url_170x135 || '';
    const sel = state.selected.has(l.listing_id);
    const type = listingType(l.listing_type);
    const st = listingState(l.state);
    return `<tr style="cursor:pointer" onclick="window.openListingModal(${l.listing_id})">
          <td class="check-col" onclick="event.stopPropagation()"><input type="checkbox" ${sel ? 'checked' : ''} onchange="window.toggleSelect(${l.listing_id}, this.checked)"></td>
          <td style="padding:4px 6px"><img class="thumbnail thumbnail-sm" src="${img}" loading="lazy" alt="" onerror="this.onerror=null;this.style.visibility='hidden'" style="${img ? '' : 'visibility:hidden'}"></td>
          <td>
            <div style="font-weight:500;font-size:12px;color:var(--text)">${escHtml(truncate(l.title, 65))}</div>
            <div class="text-sm text-muted" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">ID: ${l.listing_id}${socialBadges(l.listing_id)}${(() => {
              const synced = state.fbSyncMap.has(l.listing_id);
              return `<span data-fb-lid="${l.listing_id}" onclick="event.stopPropagation();window.openFbShopModal(${l.listing_id})" title="${synced ? 'In Facebook Shop — click to manage' : 'Add to Facebook Shop'}" style="cursor:pointer;display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:${synced ? '#1877F2' : 'var(--bg-hover)'};color:${synced ? '#fff' : '#1877F2'};border:1px solid #1877F2"><svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor"><path d="M9 6h2.5L11 8.5H9V14H6.5V8.5H5V6h1.5V4.5C6.5 3 7.5 2 9 2h2v2.5H9.5C9.2 4.5 9 4.7 9 5V6z"/></svg>${synced ? 'FB Shop ✓' : 'FB Shop'}</span>`;
            })()}<span class="listing-mobile-meta"><span class="badge ${st.cls}" style="font-size:9px">${st.label}</span><span class="badge ${type.cls}" style="font-size:9px">${type.label}</span></span></div>
          </td>
          <td onclick="event.stopPropagation()">
            <div id="price-cell-${l.listing_id}" onclick="window.startInlinePrice(${l.listing_id}, ${(l.price?.amount || 0) / (l.price?.divisor || 100)})" style="cursor:pointer;font-weight:600" title="Click to edit price">
              ${price(l.price?.amount || 0, l.price?.divisor)}
            </div>
          </td>
          <td>${number(l.views)}</td>
          <td>${number(l.num_favorers)}</td>
          <td><span class="badge ${type.cls}">${type.label}</span></td>
          <td><span class="badge ${st.cls}">${st.label}</span></td>
          <td class="text-sm text-muted">${timeAgo(l.original_creation_timestamp || l.created_timestamp || l.creation_timestamp)}</td>
          <td onclick="event.stopPropagation()">
            <div class="row" style="gap:4px">
              <button class="btn btn-sm btn-icon" title="Edit" onclick="window.navigate('create', {listing_id: ${l.listing_id}})">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-9 9H2v-3l9-9z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
              </button>
              <a href="https://www.etsy.com/listing/${l.listing_id}" target="_blank" rel="noopener" class="btn btn-sm btn-icon" title="View on Etsy" style="color:var(--orange)">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10 2h4v4M14 2l-6 6M6 3H3v10h10v-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </a>
              ${(() => {
                const fbSynced = state.fbSyncMap.has(l.listing_id);
                return `<button class="btn btn-sm btn-icon" title="${fbSynced ? 'In Facebook Shop — click to manage' : 'Add to Facebook Shop'}" onclick="window.openFbShopModal(${l.listing_id})" style="color:${fbSynced ? 'var(--green-text,#2e7d32)' : '#1877F2'}">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="${fbSynced ? 'currentColor' : 'none'}"><path d="M9 6h2.5L11 8.5H9V14H6.5V8.5H5V6h1.5V4.5C6.5 3 7.5 2 9 2h2v2.5H9.5C9.2 4.5 9 4.7 9 5V6z" stroke="${fbSynced ? 'none' : 'currentColor'}" stroke-width="${fbSynced ? '0' : '0.5'}" fill="${fbSynced ? 'currentColor' : 'currentColor'}"/></svg>
                </button>`;
              })()}
              <button class="btn btn-sm btn-icon" title="Duplicate" onclick="window.duplicateListing(${l.listing_id})">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3a1 1 0 0 1 1-1h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              </button>
              <button class="btn btn-sm btn-icon" title="${l.state === 'active' ? 'Deactivate' : 'Activate'}" onclick="window.deactivateListing(${l.listing_id}, '${l.state}')">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              </button>
              <button class="btn btn-sm btn-icon btn-danger" title="Delete" onclick="window.deleteListing(${l.listing_id}, '${escJsSingle(l.title?.slice(0, 30) || '')}')">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M4 4l.8 9.2a.8.8 0 0 0 .8.8h4.8a.8.8 0 0 0 .8-.8L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
          </td>
        </tr>`;
  }).join('')}
    </tbody>
  </table></div>`;
  // Activate lazy image loading
  observeLazyImages(body);
}
function renderPagination() {
  const el = document.getElementById('pagination-row');
  if (!el) return;
  const total = state.filtered.length;
  const pages = Math.ceil(total / state.perPage);
  if (pages <= 1 && total <= 10) { el.innerHTML = ''; return; }
  const start = (state.page - 1) * state.perPage + 1;
  const end = Math.min(state.page * state.perPage, total);

  const pageNums = [];
  for (let i = Math.max(1, state.page - 2); i <= Math.min(pages, state.page + 2); i++) pageNums.push(i);

  el.innerHTML = `<div class="pagination">
    <span class="pagination-info">Showing ${start}–${end} of ${total}</span>
    <select onchange="window.setPerPage(this.value)" style="width:auto;padding:4px 24px 4px 8px">
      ${[10, 25, 50, 100].map(n => `<option value="${n}" ${state.perPage === n ? 'selected' : ''}>${n} per page</option>`).join('')}
    </select>
    <button class="page-btn" onclick="window.setPage(${state.page - 1})" ${state.page === 1 ? 'disabled' : ''}>‹</button>
    ${pageNums.map(n => `<button class="page-btn ${n === state.page ? 'active' : ''}" onclick="window.setPage(${n})">${n}</button>`).join('')}
    <button class="page-btn" onclick="window.setPage(${state.page + 1})" ${state.page >= pages ? 'disabled' : ''}>›</button>
  </div>`;
}

function renderBulkBar() {
  const el = document.getElementById('bulk-bar');
  if (!el) return;
  if (!state.selected.size) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="bulk-bar">
    <span class="bulk-bar-count">${state.selected.size} selected</span>
    <div class="bulk-bar-sep"></div>
    <button class="bulk-btn" onclick="window.bulkActivate()">Activate</button>
    <button class="bulk-btn" onclick="window.bulkDeactivate()">Deactivate</button>
    <button class="bulk-btn danger" onclick="window.bulkDelete()">Delete</button>
    <button class="bulk-btn" style="margin-left:auto" onclick="window.bulkClearSelection()">✕ Clear</button>
  </div>`;
}

function startInlinePrice(listingId, currentPrice) {
  const cell = document.getElementById(`price-cell-${listingId}`);
  if (!cell) return;
  cell.innerHTML = `
    <div class="row" style="gap:4px">
      <span style="color:var(--text-3);font-size:12px">$</span>
      <input type="number" id="inline-price-${listingId}" value="${currentPrice.toFixed(2)}"
        step="0.01" min="0.20" style="width:72px;padding:3px 6px;font-size:12px"
        onkeydown="if(event.key==='Enter')window.saveInlinePrice(${listingId});if(event.key==='Escape')window.reloadListings()"
        onclick="event.stopPropagation()">
      <button class="btn btn-sm" style="padding:3px 8px;font-size:11px" onclick="event.stopPropagation();window.saveInlinePrice(${listingId})">✓</button>
    </div>`;
  document.getElementById(`inline-price-${listingId}`)?.focus();
}

async function saveInlinePrice(listingId) {
  const input = document.getElementById(`inline-price-${listingId}`);
  if (!input) return;
  const newPrice = parseFloat(input.value);
  if (isNaN(newPrice) || newPrice < 0.20) { toastError('Price must be at least $0.20'); return; }
  const cell = document.getElementById(`price-cell-${listingId}`);
  if (cell) cell.innerHTML = `<span style="font-weight:600;color:var(--text-3)">Saving...</span>`;
  try {
    await etsy.updateListing(listingId, { price: newPrice });
    // Update in state
    const l = state.listings.find(l => l.listing_id === listingId);
    if (l) { l.price = { amount: Math.round(newPrice * 100), divisor: 100, currency_code: 'USD' }; }
    if (cell) cell.outerHTML = `<td><div id="price-cell-${listingId}" onclick="window.startInlinePrice(${listingId}, ${newPrice})" style="cursor:pointer;font-weight:600" title="Click to edit price">$${newPrice.toFixed(2)}</div></td>`;
    toastSuccess(`Price updated to $${newPrice.toFixed(2)}`);
  } catch (e) {
    toastError('Failed to update price: ' + e.message);
    await loadListings(true);
  }
}

function sortClass(col) {
  if (state.sort.col !== col) return '';
  return state.sort.dir === 'asc' ? 'sort-asc' : 'sort-desc';
}

async function deactivateListing(id, currentState) {
  const newState = currentState === 'active' ? 'inactive' : 'active';
  try {
    await etsy.updateListingState(id, newState);
    toastSuccess(`Listing ${newState === 'active' ? 'activated' : 'deactivated'}`);
    await loadListings(true);
  } catch (e) { toastError(e.message); }
}

async function deleteListing(id, title) {
  if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
  try {
    await etsy.deleteListing(id);
    toastSuccess('Listing deleted'); invalidate('listings');
    state.selected.delete(id);
    await loadListings(true);
  } catch (e) { toastError(e.message); }
}

async function duplicateListing(id) {
  toastInfo('Duplicating...');
  try {
    await etsy.duplicateListing(id);
    toastSuccess('Listing duplicated as draft');
    await loadListings(true);
  } catch (e) { toastError(e.message); }
}

async function bulkAction(newState) {
  const ids = [...state.selected];
  toastInfo(`Updating ${ids.length} listings...`);
  let done = 0, failed = 0;
  for (const id of ids) {
    try { await etsy.updateListingState(id, newState); done++; } catch { failed++; }
  }
  if (failed > 0) toastError(`${failed} listing(s) failed to update`);
  else toastSuccess(`Updated ${done} / ${ids.length} listings`);
  state.selected.clear();
  renderBulkBar();
  await loadListings(true);
}

function confirmBulkDelete() {
  const count = state.selected.size;
  openModal({
    title: `Delete ${count} listings?`,
    body: `<p>This will permanently delete ${count} listings from your Etsy shop. This cannot be undone.</p>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button>
             <button class="btn btn-danger" onclick="doBulkDelete()">Delete ${count} listings</button>`,
  });
  window.doBulkDelete = async () => {
    closeModal();
    const ids = [...state.selected];
    toastInfo(`Deleting ${ids.length}...`);
    let done = 0, failed = 0;
    for (const id of ids) {
      try { await etsy.deleteListing(id); done++; } catch { failed++; }
    }
    if (failed > 0) toastError(`${failed} listing(s) failed to delete`);
    else toastSuccess(`Deleted ${done} listings`);
    state.selected.clear();
    renderBulkBar();
    await loadListings(true);
  };
}
