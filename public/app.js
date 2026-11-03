// public/app.js — Main app shell, routing, sidebar

import { initToasts, toastSuccess, toastError, showErrorLog, clearErrorLog } from './components/toast.js';
import { startTokenManager, onTokenRefreshed } from './utils/token-manager.js';
import { initTheme, toggleTheme, initPWA, initMobileSidebar, onMobileNavClick } from './utils/theme.js';
import { initShopSwitcher, showShopSwitcher } from './components/shop-switcher.js';
import { escHtml } from './utils/format.js';
import { loadPageRenderer } from './utils/pages.js';
import { etsy } from './utils/api.js';
import { receiptLifecycle } from './utils/receipt-lifecycle.js';
import { clearCurrentAuthUser, setCurrentAuthUser } from './utils/user-scope.js';
import {
  canonicalRouteUrl,
  routeParamsForPage,
  routeParamsFrom,
} from './utils/router.js';

async function renderAgent(container, params = {}) {
  const module = await import('./pages/agent.js');
  return module.renderAgent(container, params);
}

const PAGES = {
  agent:     { label: 'AI Agent', icon: iconStar, render: renderAgent },
  dashboard: { label: 'Dashboard', icon: iconGrid },
  chat:      { label: 'AI Assistant', icon: iconChat },
  listings:  { label: 'Listings', icon: iconList },
  create:    { label: 'Create listing', icon: iconPlus, hidden: true },
  bulk:      { label: 'Bulk Create', icon: iconBulk },
  gallery:   { label: 'Image Gallery', icon: iconPhoto },
  orders:    { label: 'Orders', icon: iconBox },
  messages:  { label: 'Messages', icon: iconChat },
  sales:     { label: 'Sales & Discounts', icon: iconTag },
  reviews:   { label: 'Reviews', icon: iconReview },
  social:    { label: 'Social Hub', icon: iconShare },
  schedule:  { label: 'Schedule', icon: iconCalendar },
  analytics: { label: 'Analytics', icon: iconChart },
  competitor:{ label: 'Competitor', icon: iconSpy },
  settings:  { label: 'Settings', icon: iconGear },
};

let currentPage = 'dashboard';
let appUpdateNoticeShown = false;

function showAppUpdateNotice() {
  if (appUpdateNoticeShown || document.getElementById('app-update-notice')) return;
  appUpdateNoticeShown = true;
  const el = document.createElement('div');
  el.id = 'app-update-notice';
  el.className = 'app-update-notice';
  el.innerHTML = `
    <span style="min-width:0">A newer version is ready. Reload once before continuing.</span>
    <button class="btn btn-primary btn-sm" style="white-space:nowrap" type="button">Reload</button>`;
  el.querySelector('button')?.addEventListener('click', () => window.location.reload());
  document.body.appendChild(el);
  document.body.classList.add('app-update-notice-visible');
  const updateOffset = () => {
    document.documentElement.style.setProperty('--app-update-notice-offset', `${el.offsetHeight + 28}px`);
  };
  requestAnimationFrame(updateOffset);
  window.addEventListener('resize', updateOffset, { passive: true });
}

function initAppUpdateWatcher() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'APP_UPDATED') showAppUpdateNotice();
  });
  navigator.serviceWorker.ready.then(reg => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showAppUpdateNotice();
        }
      });
    });
  }).catch(() => {});
  setInterval(() => {
    navigator.serviceWorker.getRegistration().then(reg => reg?.update()).catch(() => {});
  }, 60_000);
}

function currentRoute() {
  const hashRaw = window.location.hash.replace(/^#/, '');
  if (hashRaw) {
    const [hashPage, hashQuery = ''] = hashRaw.split('?');
    const page = hashPage in PAGES ? hashPage : 'agent';
    return {
      page,
      params: routeParamsForPage(page, {
        ...routeParamsFrom(window.location.search),
        ...routeParamsFrom(hashQuery),
      }),
    };
  }
  const pathPage = window.location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
  const page = pathPage in PAGES ? pathPage : 'agent';
  return {
    page,
    params: routeParamsForPage(page, routeParamsFrom(window.location.search)),
  };
}

function buildSidebar() {
  return `
    <div class="sidebar-brand">
      <div class="sidebar-logo-mark">AI</div>
      <div class="sidebar-brand-copy">
        <div class="sidebar-logo-text">AI Command Center</div>
        <button id="shop-name-display" class="sidebar-shop-switch" type="button" title="Switch shop" onclick="window.showShopSwitcher()">Loading...</button>
      </div>
      <span class="sidebar-live-dot" title="Live workspace"></span>
    </div>

    <div class="sidebar-nav">
      ${navItem('agent', 'AI Agent')}
      ${navItem('dashboard', 'Overview')}
      ${sidebarSection('Shop', [navItem('listings'), navItem('orders'), navItem('messages'), navItem('reviews'), navItem('sales', 'Sales')])}
      ${sidebarSection('Studio', [navItem('create', 'Create listing'), navItem('bulk', 'Bulk studio'), navItem('gallery', 'Media library')])}
      ${sidebarSection('Growth', [navItem('social'), navItem('schedule', 'Content calendar'), navItem('analytics'), navItem('competitor', 'Market research')])}
    </div>

    <div class="sidebar-bottom">
      ${navItem('settings')}
      <div class="sidebar-utilities">
        <button class="sidebar-utility" type="button" onclick="window.__toggleTheme()" title="Toggle theme"><span data-theme-icon>◐</span><span>Theme</span></button>
        <button class="sidebar-utility" type="button" onclick="window.__logout()" title="Sign out"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M10 8H2M6 5l-3 3 3 3M9 3h4a1 1 0 011 1v8a1 1 0 01-1 1H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Sign out</span></button>
      </div>
    </div>`;
}

function sidebarSection(label, items) {
  return `<div class="sidebar-section-block">
    <div class="sidebar-section-label">${label}</div>
    ${items.join('')}
  </div>`;
}

function buildTopbar() {
  return `<header class="app-topbar">
    <div class="app-topbar-search">
      <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.6"/><path d="m13.5 13.5 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <input id="global-search" type="search" placeholder="Search listings, orders, reviews…" aria-label="Search listings, orders and reviews" autocomplete="off" oninput="window.__queueGlobalSearch(this.value)" onkeydown="window.__globalSearchKeydown(event)">
      <div id="global-search-results" class="global-search-results" role="listbox" aria-label="Search results"></div>
    </div>
    <div class="app-topbar-actions">
      <button class="btn btn-primary" type="button" onclick="window.navigate('create')">+ Create listing</button>
    </div>
  </header>`;
}

function navItem(id, overrideLabel) {
  const page = PAGES[id];
  if (!page) return '';
  const label = overrideLabel || page.label;
  const active = currentPage === id ? 'active' : '';
  return `<button class="nav-item ${active}" data-page="${id}" onclick="window.navigate('${id}')">
    ${page.icon()} ${label}
  </button>`;
}

let navigationRevision = 0;

window.navigate = async function (pageId, params = {}) {
  if (!PAGES[pageId]) return;
  const revision = ++navigationRevision;
  const cleanup = window.__pageCleanup;
  if (typeof cleanup === 'function') {
    delete window.__pageCleanup;
    await cleanup();
    if (revision !== navigationRevision) return;
  }
  currentPage = pageId;

  // Update nav active state
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === pageId);
  });

  // Hide FAB on agent page (it's the full page), show on others
  const fab = document.getElementById('agent-fab');
  if (fab) fab.style.display = pageId === 'agent' ? 'none' : 'flex';
  if (pageId === 'agent') window.closeAgentFloat?.();

  const main = document.getElementById('main-area');
  main.innerHTML = '<div class="page-body"><div class="alert alert-info" style="margin:36px auto;max-width:620px">Loading ' + escHtml(PAGES[pageId].label) + '...</div></div>';
  main.style.cssText = ''; // reset any styles set by previous page (e.g. agent sets overflow:hidden)
  try {
    const render = PAGES[pageId].render || await loadPageRenderer(pageId);
    if (revision !== navigationRevision) return;
    if (!PAGES[pageId].render) PAGES[pageId].render = render;
    await render(main, params);
  } catch (err) {
    console.error('[navigate]', pageId, err);
    main.innerHTML = `
      <div class="page-body">
        <div class="alert alert-error" style="max-width:720px;margin:32px auto;font-size:13px;line-height:1.55">
          <strong>Page failed to load.</strong>
          <div style="margin-top:6px">${escHtml(err?.message || 'Unknown error')}</div>
          <button class="btn btn-sm btn-primary" style="margin-top:12px" onclick="window.navigate('${pageId}')">Retry</button>
        </div>
      </div>`;
    toastError(`Could not open ${PAGES[pageId].label}`);
  }

  // Scroll to top
  main.scrollTop = 0;
};

// ── Icons ──────────────────────────────────────────────────

function iconStar() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`; }
function iconChat() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M14 2H2a1 1 0 00-1 1v8a1 1 0 001 1h3l2 2 2-2h5a1 1 0 001-1V3a1 1 0 00-1-1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5 6h6M5 9h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`; }
function iconGrid() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.4"/></svg>`; }
function iconList() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`; }
function iconPlus() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`; }
function iconBulk() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 3h6M2 7h6M2 11h6M10 3h4M10 7h4M10 11h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`; }
function iconBox() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M13 5.5L8 3 3 5.5M13 5.5v5L8 13m5-7.5L8 8M8 13L3 10.5v-5M8 13V8M3 5.5L8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function iconShare() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="12" cy="4" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="4" cy="8" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.4"/><path d="M6 7l4-2M6 9l4 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`; }
function iconChart() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 12l4-4 3 3 5-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function iconSpy() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="6" cy="8" r="4" stroke="currentColor" stroke-width="1.4"/><path d="M10 8h4M2 8c0-2.2 1.8-4 4-4s4 1.8 4 4-1.8 4-4 4-4-1.8-4-4z" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="8" r="1.5" fill="currentColor"/></svg>`; }
function iconGear() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M3.05 12.95l1.42-1.42M11.53 4.47l1.42-1.42" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`; }
function iconPhoto() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/><circle cx="5.5" cy="7.5" r="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M1 11l4-3 3 2.5 3-3.5 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function iconTag() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8.5 2H3a1 1 0 00-1 1v5.5a1 1 0 00.3.7l6 6a1 1 0 001.4 0l5-5a1 1 0 000-1.4l-6-6A1 1 0 008.5 2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="5.5" cy="6.5" r="1" fill="currentColor"/></svg>`; }
function iconCalendar() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5 1v4M11 1v4M2 7h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="5.5" cy="10.5" r="1" fill="currentColor"/><circle cx="10.5" cy="10.5" r="1" fill="currentColor"/></svg>`; }
function iconReview() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.5 3.5L13 5.5l-2.5 2.8.5 3.7L8 10.5 4.5 12l.5-3.7L2.5 5.5 6 4.5 8 1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`; }

// ── Auth ───────────────────────────────────────────────────

async function checkAuth() {
  try {
    const res = await fetch('/api/login');
    const data = await res.json();
    return data;
  } catch {
    return { authenticated: false, requires_username: true };
  }
}

function showLoginScreen(requiresUsername = true) {
  const app = document.getElementById('app');
  app.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100vh;background:var(--bg-page)';
  app.innerHTML = `
    <div style="width:100%;max-width:340px;padding:0 16px">
      <div class="card" style="padding:36px 32px">
        <div style="text-align:center;margin-bottom:28px">
          <div style="width:44px;height:44px;background:var(--orange);border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#fff;margin-bottom:14px">E</div>
          <div style="font-size:18px;font-weight:700;color:var(--text)">Etsy AI Command Center</div>
          <div style="font-size:13px;color:var(--text-2);margin-top:3px">Sign in to continue</div>
        </div>
        <form id="login-form" onsubmit="window.__submitLogin(event)" style="display:flex;flex-direction:column;gap:10px">
          <input id="login-username" type="text" placeholder="Username" autocomplete="username" ${requiresUsername ? 'required' : ''}
            style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box;outline:none;font-family:inherit">
          <input id="login-password" type="password" placeholder="Password" autocomplete="current-password"
            style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box;outline:none;font-family:inherit">
          <div id="login-error" style="display:none;color:var(--red-text);font-size:12px;text-align:center;margin:-4px 0"></div>
          <button type="submit" id="login-btn" class="btn btn-primary" style="width:100%;padding:10px;font-size:14px;justify-content:center">
            Sign in
          </button>
        </form>
      </div>
    </div>`;
  const usernameField = document.getElementById('login-username');
  if (usernameField) usernameField.style.display = requiresUsername ? 'block' : 'none';
  setTimeout(() => document.getElementById(requiresUsername ? 'login-username' : 'login-password')?.focus(), 50);
}

window.__showLoginScreen = async () => {
  const config = await checkAuth();
  showLoginScreen(config.requires_username !== false);
};

window.__submitLogin = async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username')?.value?.trim() || '';
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errEl.style.display = 'none';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      errEl.textContent = data.error || 'Wrong password';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Sign in';
      return;
    }
    window.location.reload();
  } catch {
    errEl.textContent = 'Network error. Please try again.';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
};

window.__logout = async () => {
  await fetch('/api/login', { method: 'DELETE' }).catch(() => {});
  clearCurrentAuthUser();
  window.location.reload();
};

// ── Init ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initToasts();
  initTheme();
  initPWA();

  // Auth gate — check before rendering anything
  const authStatus = await checkAuth();
  if (!authStatus.authenticated) {
    clearCurrentAuthUser();
    showLoginScreen(authStatus.requires_username !== false);
    return;
  }
  setCurrentAuthUser(authStatus.user || { id: 'local-dev', name: 'Local development' });
  initAppUpdateWatcher();

  const app = document.getElementById('app');
  app.innerHTML = `
    <nav class="sidebar" id="sidebar">${buildSidebar()}</nav>
    <div class="app-workspace">
      ${buildTopbar()}
      <main class="main-area" id="main-area"><div class="page-body"><div class="alert alert-info" style="margin:36px auto;max-width:620px">Preparing your workspace...</div></div></main>
    </div>`;

  // External Etsy/CDN media can be unavailable in privacy-restricted browsers.
  // Keep the layout stable and remove the browser's broken-image glyph globally.
  document.addEventListener('error', event => {
    const target = event.target;
    if (target instanceof HTMLImageElement) target.style.visibility = 'hidden';
  }, true);

  let globalSearchTimer;
  let globalSearchCache;
  let globalSearchCacheAt = 0;
  let globalSearchRequest;

  const getGlobalSearchData = async () => {
    if (globalSearchCache && Date.now() - globalSearchCacheAt < 120_000) return globalSearchCache;
    if (globalSearchRequest) return globalSearchRequest;
    globalSearchRequest = Promise.allSettled([
      etsy.getListings({ limit: 100, offset: 0, state: 'active' }),
      etsy.getReceipts({ limit: 100, offset: 0 }),
      etsy.getReviews({ limit: 100, offset: 0 }),
    ]).then(([listings, orders, reviews]) => {
      const rows = result => result.status === 'fulfilled' ? (result.value?.results || result.value || []) : [];
      globalSearchCache = { listings: rows(listings), orders: rows(orders), reviews: rows(reviews) };
      globalSearchCacheAt = Date.now();
      return globalSearchCache;
    }).finally(() => { globalSearchRequest = null; });
    return globalSearchRequest;
  };

  const openGlobalSearchTarget = async button => {
    const pageId = button.dataset.searchPage;
    const value = button.dataset.searchValue || '';
    document.getElementById('global-search-results')?.classList.remove('open');
    await window.navigate(pageId);
    const input = document.querySelector(pageId === 'listings' ? '#search-input' : pageId === 'orders' ? '#orders-search' : '#reviews-search');
    if (input) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
  };

  window.__globalSearch = async query => {
    const value = String(query || '').trim();
    const panel = document.getElementById('global-search-results');
    if (!panel) return;
    if (value.length < 2) {
      panel.classList.remove('open');
      panel.innerHTML = '';
      return;
    }

    panel.classList.add('open');
    panel.innerHTML = '<div class="global-search-state"><span class="spinner"></span>Searching shop data…</div>';
    const data = await getGlobalSearchData();
    if (document.getElementById('global-search')?.value.trim() !== value) return;
    const q = value.toLowerCase();
    const includes = (...parts) => parts.some(part => String(part || '').toLowerCase().includes(q));
    const listingMatches = data.listings.filter(item => includes(item.title, item.listing_id, ...(item.tags || []))).slice(0, 4).map(item => ({
      page: 'listings', value: item.title || String(item.listing_id), kind: 'Listing', title: item.title || `Listing #${item.listing_id}`, meta: `#${item.listing_id} · ${item.state || 'active'}`,
    }));
    const orderMatches = data.orders.filter(item => includes(item.receipt_id, item.name, ...(item.transactions || []).map(tx => tx.title))).slice(0, 4).map(item => ({
      page: 'orders', value: String(item.receipt_id), kind: 'Order', title: `Order #${item.receipt_id}${item.name ? ` · ${item.name}` : ''}`, meta: item.transactions?.[0]?.title || receiptLifecycle(item).label,
    }));
    const reviewMatches = data.reviews.filter(item => includes(item.review, item.transaction_id, item.listing_id)).slice(0, 4).map(item => ({
      page: 'reviews', value: String(item.transaction_id || item.listing_id || value), kind: 'Review', title: `${item.rating || '—'} star review`, meta: item.review || `Transaction #${item.transaction_id}`,
    }));
    const results = [...listingMatches, ...orderMatches, ...reviewMatches];

    if (!results.length) {
      panel.innerHTML = `<div class="global-search-state">No matches for <strong>${escHtml(value)}</strong> in listings, orders or reviews.</div>`;
      return;
    }
    panel.innerHTML = results.map(result => `
      <button class="global-search-result" type="button" role="option" data-search-page="${result.page}" data-search-value="${escHtml(result.value)}">
        <span class="global-search-kind">${result.kind}</span>
        <span class="global-search-copy"><strong>${escHtml(result.title)}</strong><small>${escHtml(result.meta)}</small></span>
      </button>`).join('');
    panel.querySelectorAll('.global-search-result').forEach(button => button.addEventListener('click', () => openGlobalSearchTarget(button)));
  };

  window.__queueGlobalSearch = query => {
    clearTimeout(globalSearchTimer);
    globalSearchTimer = setTimeout(() => window.__globalSearch(query), 240);
  };
  window.__globalSearchKeydown = event => {
    if (event.key === 'Escape') {
      document.getElementById('global-search-results')?.classList.remove('open');
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const first = document.querySelector('#global-search-results .global-search-result');
      if (first) openGlobalSearchTarget(first);
      else window.__globalSearch(event.currentTarget.value);
    }
  };
  document.addEventListener('click', event => {
    if (!event.target.closest('.app-topbar-search')) document.getElementById('global-search-results')?.classList.remove('open');
  });

  // ── Floating AI Agent ────────────────────────────────────
  const agentFloat = document.createElement('div');
  agentFloat.id = 'agent-float-root';
  agentFloat.hidden = true;
  agentFloat.innerHTML = `
    <button id="agent-fab" title="Open shop agent" aria-label="Open shop agent" onclick="window.toggleAgentFloat()">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.45 4.05L17.5 8.5l-4.05 1.45L12 14l-1.45-4.05L6.5 8.5l4.05-1.45L12 3Zm6 11 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z"/></svg>
    </button>
    <div id="agent-float-panel">
      <div class="agent-float-header">
        <div class="agent-float-identity">
          <span class="agent-float-status-dot" aria-hidden="true"></span>
          <span class="agent-float-title">Shop agent</span>
        </div>
        <div class="agent-float-actions">
          <button class="agent-float-icon-btn" title="Open full agent" aria-label="Open full agent" onclick="window.navigate('agent');window.closeAgentFloat()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M8 21H3v-5m18 0v5h-5"/></svg>
          </button>
          <button class="agent-float-icon-btn" title="Close agent" aria-label="Close agent" onclick="window.closeAgentFloat()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
      </div>
      <div id="float-agent-host"></div>
    </div>`;
  document.body.appendChild(agentFloat);
  agentFloat.hidden = false;

  let floatRenderRevision = 0;

  async function renderFloatAgent() {
    const host = document.getElementById('float-agent-host');
    if (!host) return;
    const revision = ++floatRenderRevision;
    host.replaceChildren();
    try {
      await renderAgent(host, { compact: true });
      if (revision !== floatRenderRevision) host.replaceChildren();
    } catch (err) {
      if (revision !== floatRenderRevision) return;
      host.innerHTML = `<div style="padding:14px;color:var(--red-text);font-size:12px">Agent could not open: ${escHtml(err?.message || 'Unknown error')}</div>`;
    }
  }

  window.toggleAgentFloat = () => {
    const panel = document.getElementById('agent-float-panel');
    const fab = document.getElementById('agent-fab');
    if (!panel || !fab) return;
    if (panel.style.display === 'flex') {
      window.closeAgentFloat?.();
      return;
    }
    panel.style.display = 'flex';
    fab.classList.add('active');
    renderFloatAgent();
  };

  window.closeAgentFloat = () => {
    floatRenderRevision += 1;
    const panel = document.getElementById('agent-float-panel');
    const fab = document.getElementById('agent-fab');
    if (panel) panel.style.display = 'none';
    if (fab) fab.classList.remove('active');
    document.getElementById('float-agent-host')?.replaceChildren();
  };

  initMobileSidebar();
  window.__toggleTheme = toggleTheme;
  window.showShopSwitcher = showShopSwitcher;

  // Resolve the workspace before loading a page whose local state is scoped to
  // the authenticated user and active shop.
  const initialShop = await initShopSwitcher();
  if (initialShop) {
    const el = document.getElementById('shop-name-display');
    if (el) el.textContent = initialShop.name || initialShop.id;
  }

  // Fetch real shop name from Etsy API
  fetch('/api/etsy?action=getShop').then(r => r.json()).then(d => {
    if (d.data?.shop_name) {
      const el = document.getElementById('shop-name-display');
      if (el) { el.textContent = d.data.shop_name; el.title = d.data.shop_name; }
    }
  }).catch(() => { });

  // Close mobile sidebar on nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', onMobileNavClick);
  });

  // Start background token manager
  startTokenManager();
  // token countdown UI removed — auto-refresh still active
  onTokenRefreshed(() => { /* silent auto-refresh */ });

  // Keep one canonical route in the hash. This removes stale query parameters
  // from an older page and makes every current page/sub-view shareable.
  const origNavigate = window.navigate;
  let observedLocation = window.location.href;

  const writeRoute = (page, params = {}, { replace = false } = {}) => {
    const publicParams = routeParamsForPage(page, params);
    const target = canonicalRouteUrl(page, publicParams);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current !== target) {
      window.history[replace ? 'replaceState' : 'pushState'](
        { page, params: publicParams },
        '',
        target,
      );
    }
    observedLocation = window.location.href;
  };

  window.navigate = async (page, params) => {
    const nextParams = params && typeof params === 'object' ? params : {};
    writeRoute(page, nextParams);
    await origNavigate(page, nextParams);
  };

  window.updateCurrentRouteParams = (params = {}, options = {}) => {
    writeRoute(currentPage, params, options);
  };

  const handleLocationRoute = () => {
    if (window.location.href === observedLocation) return;
    observedLocation = window.location.href;
    const next = currentRoute();
    origNavigate(next.page, next.params);
  };
  window.addEventListener('popstate', handleLocationRoute);
  window.addEventListener('hashchange', handleLocationRoute);

  // Accept legacy direct links such as /schedule?preview_id=..., then normalize
  // them once so later navigation cannot retain that page's object ID.
  const initialRoute = currentRoute();
  // A fresh install has no Etsy shop yet: start with setup instructions instead of an empty AI screen.
  if (!initialShop && !window.location.hash && window.location.pathname === '/') {
    initialRoute.page = 'settings';
    initialRoute.params = {};
  }
  writeRoute(initialRoute.page, initialRoute.params, { replace: true });
  await origNavigate(initialRoute.page, initialRoute.params);
});
