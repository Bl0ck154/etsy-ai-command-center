// public/pages/reviews.js — Reviews page with honest reply tracking
import { etsy, kv } from '../utils/api.js';
import { escHtml, timeAgo, formatDate } from '../utils/format.js';
import { toastSuccess, toastError } from '../components/toast.js';
import { get, set, invalidate } from '../utils/store.js';
import { skeletonCard, debounce } from '../utils/perf.js';
import { reviewMediaUrls, reviewResponseStatus, reviewResponseSummary } from './reviews-data.js';

const PAGE_SIZE = 20;
const FETCH_CHUNK = 100;
const MANUAL_KEY = 'reviews_manual'; // localStorage cache key

function reviewMediaProxyUrl(value) {
  const url = String(value || '').trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'i.etsystatic.com') return url;
    return `/api/media?action=proxyEtsyReviewImage&url=${encodeURIComponent(parsed.href)}`;
  } catch {
    return url;
  }
}

let state = {
  reviews: [],
  filtered: [],
  respondedIds: new Set(),
  reviewsPageUrl: '',
  responseStatusSource: 'not_available_in_etsy_open_api',
  page: 1,
  loading: false,
  apiDone: false,
  totalFetched: 0,
  filter: { search: '', rating: '', response: '' },
};

// ── KV-backed helpers (localStorage cache for instant reads) ──────────────────

async function loadManual() {
  try {
    const ids = await kv.getRespondedReviews();
    const s = new Set((ids || []).map(Number));
    localStorage.setItem(MANUAL_KEY, JSON.stringify([...s]));
    return s;
  } catch {
    // KV offline — fall back to localStorage cache
    try { return new Set(JSON.parse(localStorage.getItem(MANUAL_KEY) || '[]').map(Number)); } catch { return new Set(); }
  }
}
function _cacheManual(s) {
  try { localStorage.setItem(MANUAL_KEY, JSON.stringify([...s])); } catch {}
}

// ── Entry point ────────────────────────────────────────────

export async function renderReviews(container) {
  const cached = get('reviews:all');
  state.reviewsPageUrl = get('reviews:pageUrl') || '';
  if (cached) {
    state.reviews = cached;
    state.totalFetched = cached.length;
    state.apiDone = true;
  } else {
    state.reviews = [];
    state.totalFetched = 0;
    state.apiDone = false;
  }
  state.filtered = [];
  state.page = 1;
  state.respondedIds = await loadManual();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Reviews</div>
        <div class="page-subtitle" id="reviews-count">Loading...</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
        <a id="reviews-page-link" class="btn btn-sm" target="_blank" rel="noopener" style="display:none;text-decoration:none">
          Etsy reviews page
        </a>
        <button class="btn btn-sm" onclick="window._revRefresh()">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M14 8A6 6 0 1 1 2.8 4.5M2 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Refresh
        </button>
      </div>
    </div>
    <div class="page-body">
      <div class="card">
        <div class="toolbar mb-8" style="flex-wrap:wrap;gap:8px">
          <div class="toolbar-search">
            <svg class="toolbar-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            <input id="reviews-search" type="text" placeholder="Search reviews..." style="width:220px" oninput="window._revSearch(this.value)">
          </div>
          <select onchange="window._revFilter('rating',this.value)" style="width:auto">
            <option value="">All ratings</option>
            <option value="5">★★★★★ 5 stars</option>
            <option value="4">★★★★☆ 4 stars</option>
            <option value="3">★★★☆☆ 3 stars</option>
            <option value="2">★★☆☆☆ 2 stars</option>
            <option value="1">★☆☆☆☆ 1 star</option>
          </select>
          <select onchange="window._revFilter('response',this.value)" style="width:auto">
            <option value="">All reviews</option>
            <option value="responded">Seller replied / marked replied</option>
            <option value="pending">Reply not recorded</option>
          </select>
        </div>
        <div id="reviews-stats" style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap"></div>
        <div id="reviews-response-note" style="margin-bottom:14px;font-size:12px;line-height:1.5;color:var(--text-3);background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px">
          Etsy Open API supplies review photos, but does not supply seller reply text or reply status. Replies shown here are displayed only when an upstream source actually provides them; otherwise the marker is manual and unmarked reviews remain unknown, not unanswered.
        </div>
        <div id="reviews-list">${skeletonCard(4)}${skeletonCard(4)}${skeletonCard(4)}</div>
        <div id="reviews-pagination"></div>
      </div>
    </div>`;

  window._revSearch  = debounce(v => { state.filter.search = v;  state.page = 1; applyFilters(); }, 250);
  window._revFilter  = (k, v) => { state.filter[k] = v; state.page = 1; applyFilters(); };
  window._revRefresh = () => { invalidate('reviews'); state.reviews = []; state.reviewsPageUrl = ''; state.totalFetched = 0; state.apiDone = false; state.page = 1; loadAll(); };
  window._revPage    = p => { if (p >= 1) { state.page = p; renderList(); renderPagination(); } };
  window._revToggle  = toggleResponded;

  if (state.reviews.length) applyFilters();
  await loadAll();
}

// ── Data loading ──────────────────────────────────────────

async function loadAll() {
  if (state.loading) return;
  state.loading = true;
  try {
    while (!state.apiDone) {
      const data = await etsy.getReviews({ limit: FETCH_CHUNK, offset: state.totalFetched });
      const results = data.results || [];
      if (data.reviews_page_url) {
        state.reviewsPageUrl = data.reviews_page_url;
        set('reviews:pageUrl', state.reviewsPageUrl);
      }
      state.responseStatusSource = data.response_status_source || 'not_available_in_etsy_open_api';
      state.reviews.push(...results);
      state.totalFetched += results.length;
      if (results.length < FETCH_CHUNK) state.apiDone = true;
      applyFilters();
    }
    set('reviews:all', state.reviews);
  } catch (err) {
    toastError('Failed to load reviews: ' + err.message);
  }
  state.loading = false;
  applyFilters();
}

// ── Toggle responded ──────────────────────────────────────

function toggleResponded(transactionId) {
  if (state.respondedIds.has(transactionId)) {
    state.respondedIds.delete(transactionId);
    _cacheManual(state.respondedIds);
    kv.unmarkReviewResponded(transactionId).catch(() => {});
    toastSuccess('Marked as not responded');
  } else {
    state.respondedIds.add(transactionId);
    _cacheManual(state.respondedIds);
    kv.markReviewResponded(transactionId).catch(() => {});
    toastSuccess('Marked as responded');
  }
  applyFilters();
}

// ── Filtering & rendering ─────────────────────────────────

function applyFilters() {
  let list = [...state.reviews].sort((a, b) => b.created_timestamp - a.created_timestamp);

  if (state.filter.search) {
    const q = state.filter.search.toLowerCase();
    list = list.filter(r =>
      (r.review || '').toLowerCase().includes(q) ||
      String(r.listing_id).includes(q) ||
      String(r.transaction_id).includes(q)
    );
  }
  if (state.filter.rating) {
    list = list.filter(r => r.rating === parseInt(state.filter.rating));
  }
  if (state.filter.response === 'responded') {
    list = list.filter(isReviewResponded);
  } else if (state.filter.response === 'pending') {
    list = list.filter(r => !isReviewResponded(r));
  }

  state.filtered = list;
  renderStats();
  renderList();
  renderPagination();
  updateCount();
  renderReviewsPageLink();
}

function isReviewResponded(r) {
  return reviewResponseStatus(r, state.respondedIds).responded;
}

function updateCount() {
  const el = document.getElementById('reviews-count');
  if (!el) return;
  const total   = state.reviews.length;
  const showing = state.filtered.length;
  const suffix  = state.loading ? ' · loading...' : '';
  el.textContent = showing === total
    ? `${total} reviews${suffix}`
    : `Showing ${showing} of ${total}${suffix}`;
}

function renderStats() {
  const el = document.getElementById('reviews-stats');
  if (!el || !state.reviews.length) { if (el) el.innerHTML = ''; return; }

  const total     = state.reviews.length;
  const avg       = (state.reviews.reduce((s, r) => s + r.rating, 0) / total).toFixed(1);
  const distrib   = [5, 4, 3, 2, 1].map(n => ({ n, count: state.reviews.filter(r => r.rating === n).length }));
  const replies   = reviewResponseSummary(state.reviews, state.respondedIds);
  const replyParts = [];
  if (replies.authoritative) replyParts.push(`${replies.authoritativeResponded} seller ${replies.authoritativeResponded === 1 ? 'reply' : 'replies'} available`);
  if (replies.manualResponded || !replies.authoritative) replyParts.push(`${replies.manualResponded} manually marked`);
  const replyLabel = replyParts.join(' · ');

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--bg-secondary);border-radius:var(--radius)">
      <div style="font-size:28px;font-weight:800;color:var(--text)">${avg}</div>
      <div>
        <div style="color:#f59e0b;font-size:14px">${stars(Math.round(parseFloat(avg)))}</div>
        <div style="font-size:11px;color:var(--text-3)">${total} reviews</div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:3px;padding:8px 14px;background:var(--bg-secondary);border-radius:var(--radius);min-width:160px">
      ${distrib.map(({ n, count }) => `
        <div style="display:flex;align-items:center;gap:6px;font-size:11px">
          <span style="width:14px;text-align:right;color:var(--text-2)">${n}</span>
          <div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${total ? (count / total * 100) : 0}%;background:#f59e0b;border-radius:3px"></div>
          </div>
          <span style="width:24px;color:var(--text-3)">${count}</span>
        </div>`).join('')}
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--bg-secondary);border-radius:var(--radius)">
      <div style="font-size:24px;font-weight:800;color:var(--text)">${replies.responded}</div>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--text)">Reply tracking</div>
        <div style="font-size:11px;color:var(--text-3)">${replyLabel} · ${replies.unknown} unknown</div>
      </div>
    </div>`;
}

function renderReviewsPageLink() {
  const el = document.getElementById('reviews-page-link');
  if (!el) return;
  if (!state.reviewsPageUrl) {
    el.style.display = 'none';
    return;
  }
  el.href = state.reviewsPageUrl;
  el.style.display = 'inline-flex';
}

function renderList() {
  const el = document.getElementById('reviews-list');
  if (!el) return;

  const start     = (state.page - 1) * PAGE_SIZE;
  const pageItems = state.filtered.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    el.innerHTML = state.loading
      ? `${skeletonCard(4)}${skeletonCard(4)}${skeletonCard(4)}`
      : `<div style="text-align:center;padding:40px;color:var(--text-3)">No reviews found</div>`;
    return;
  }

  el.innerHTML = pageItems.map(r => {
    const response    = reviewResponseStatus(r, state.respondedIds);
    const isResponded = response.responded;
    const text        = escHtml(r.review || '');
    const replyUrl    = `https://www.etsy.com/your/orders/transactions/${r.transaction_id}`;
    const mediaUrls   = reviewMediaUrls(r);

    return `
      <div style="padding:14px;border:1.5px solid var(--border);border-radius:var(--radius);margin-bottom:10px;background:var(--bg-card)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;flex-wrap:wrap">
            <div style="color:#f59e0b;font-size:14px;flex-shrink:0">${stars(r.rating)}</div>
            <div style="font-size:12px;color:var(--text-3);flex-shrink:0" title="${formatDate(r.created_timestamp)}">${timeAgo(r.created_timestamp)}</div>
            <div style="font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              #${r.transaction_id}${r.listing_id ? ` · listing ${r.listing_id}` : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            ${response.source === 'etsy'
              ? `<span class="btn btn-sm ${isResponded ? 'btn-primary' : ''}" style="font-size:11px;cursor:default">${isResponded ? 'Seller replied' : 'No seller reply'}</span>`
              : `<button class="btn btn-sm ${isResponded ? 'btn-primary' : ''}"
                  onclick="window._revToggle(${r.transaction_id})"
                  style="font-size:11px;${isResponded ? '' : 'border:1.5px solid var(--border)'}">
                  ${isResponded
                    ? `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Marked replied`
                    : `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M14 2H2a1 1 0 00-1 1v8a1 1 0 001 1h3l2 2 2-2h5a1 1 0 001-1V3a1 1 0 00-1-1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg> Mark replied`}
                </button>`}
            <a href="${replyUrl}" target="_blank" rel="noopener"
              class="btn btn-sm" style="font-size:11px;text-decoration:none">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M7 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1V9M9 1h6m0 0v6m0-6L7 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Reply on Etsy
            </a>
          </div>
        </div>
        ${text
          ? `<div style="margin-top:10px;font-size:13px;line-height:1.6;color:var(--text);white-space:pre-wrap">${text}</div>`
          : `<div style="margin-top:8px;font-size:12px;color:var(--text-3);font-style:italic">No review text</div>`}
        ${mediaUrls.length
          ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${mediaUrls.map((url, index) => `<a href="${escHtml(url)}" target="_blank" rel="noopener" title="Open review attachment"><img src="${escHtml(reviewMediaProxyUrl(url))}" data-review-image-fallback="${escHtml(url)}" onerror="if(this.dataset.reviewImageFallback&&this.src!==this.dataset.reviewImageFallback){this.src=this.dataset.reviewImageFallback}else{this.replaceWith(Object.assign(document.createElement('span'),{textContent:'Review photo unavailable',style:'font-size:11px;color:var(--text-3);padding:8px'}))}" style="width:160px;height:160px;object-fit:cover;border-radius:8px;border:1px solid var(--border);display:block" loading="lazy" alt="Review attachment ${index + 1}"></a>`).join('')}</div>`
          : ''}
        ${response.text
          ? `<div style="margin-top:12px;padding:10px 12px;border-left:3px solid var(--green);background:var(--bg-secondary);border-radius:0 8px 8px 0"><div style="font-size:11px;font-weight:700;color:var(--green-text);margin-bottom:4px">Seller reply</div><div style="font-size:13px;line-height:1.55;color:var(--text);white-space:pre-wrap">${escHtml(response.text)}</div></div>`
          : ''}
      </div>`;
  }).join('');
}

function renderPagination() {
  const el = document.getElementById('reviews-pagination');
  if (!el) return;
  const totalPages = Math.ceil(state.filtered.length / PAGE_SIZE);
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const btns = [];
  btns.push(`<button class="btn btn-sm" ${state.page <= 1 ? 'disabled' : ''} onclick="window._revPage(${state.page - 1})">‹</button>`);
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 7 && i > 2 && i < totalPages - 1 && Math.abs(i - state.page) > 1) {
      if (btns.at(-1) !== '<span style="padding:0 4px;color:var(--text-3)">…</span>') btns.push('<span style="padding:0 4px;color:var(--text-3)">…</span>');
      continue;
    }
    btns.push(`<button class="btn btn-sm ${i === state.page ? 'btn-primary' : ''}" onclick="window._revPage(${i})">${i}</button>`);
  }
  btns.push(`<button class="btn btn-sm" ${state.page >= totalPages ? 'disabled' : ''} onclick="window._revPage(${state.page + 1})">›</button>`);
  el.innerHTML = `<div style="display:flex;gap:4px;justify-content:center;margin-top:14px">${btns.join('')}</div>`;
}

function stars(n) {
  return '★'.repeat(Math.max(0, n)) + '☆'.repeat(Math.max(0, 5 - n));
}
