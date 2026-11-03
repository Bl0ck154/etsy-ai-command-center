// public/pages/competitor.js — Competitor Analyzer
// Fetches top Etsy listings by keyword, AI analyses patterns, gives recommendations

import { escHtml, price, number, truncate, escJsSingle } from '../utils/format.js';
import { toastError, toastInfo, toastSuccess } from '../components/toast.js';
import { getOrFetch, invalidate } from '../utils/store.js';

let state = {
  keyword: '',
  results: [],
  analysis: null,
  loading: false,
  analyzing: false,
  myListings: [],
};

export async function renderCompetitor(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Competitor Analyzer</div>
        <div class="page-subtitle">Analyse top Etsy listings by keyword and get AI recommendations</div>
      </div>
    </div>
    <div class="page-body">
      <div class="card mb-12">
        <div class="row" style="gap:8px">
          <input type="text" id="comp-keyword" placeholder="e.g. pickleball sublimation png, birthday canva template, photo merge service..."
            value="${escHtml(state.keyword)}" style="flex:1"
            onkeydown="if(event.key==='Enter') window.runCompetitorSearch()">
          <select id="comp-limit" style="width:auto">
            <option value="10">Top 10</option>
            <option value="20" selected>Top 20</option>
            <option value="30">Top 30</option>
          </select>
          <button class="btn btn-primary" id="comp-search-btn" onclick="window.runCompetitorSearch()">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Analyse
          </button>
        </div>
        <div class="alert alert-info" style="margin-top:10px;font-size:11px">
          Uses Etsy public search API. Shows top listings by relevance, then AI analyses patterns in titles, tags, prices and gives you actionable recommendations.
        </div>
      </div>

      <div id="comp-results"></div>
    </div>`;

  window.runCompetitorSearch = runSearch;
  window.runAIAnalysis = runAIAnalysis;
  window._compCopyTag = (tag) => { navigator.clipboard.writeText(tag).then(() => toastSuccess(`Copied: ${tag}`)); };
  window._compOpenListing = (id) => { window.open(`https://www.etsy.com/listing/${id}`, '_blank'); };

  if (state.results.length) renderResults();
}

async function runSearch() {
  const keyword = document.getElementById('comp-keyword')?.value?.trim();
  const limit = parseInt(document.getElementById('comp-limit')?.value || '20');
  if (!keyword) { toastError('Enter a keyword to search'); return; }

  state.keyword = keyword;
  state.results = [];
  state.analysis = null;
  state.loading = true;

  const btn = document.getElementById('comp-search-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Searching...'; }

  document.getElementById('comp-results').innerHTML = `
    <div class="loading-center" style="padding:48px">
      <div class="spinner spinner-lg"></div>
      <span>Fetching top Etsy listings for "${escHtml(keyword)}"...</span>
    </div>`;

  try {
    // Use Etsy public listings search (no auth required for browsing)
    const res = await fetch(`/api/etsy?action=searchListings&keyword=${encodeURIComponent(keyword)}&limit=${limit}`);
    const data = await res.json();

    if (data.error || !data.data) throw new Error(data.error || 'No results');
    state.results = data.data?.results || [];

    if (!state.results.length) {
      document.getElementById('comp-results').innerHTML = `
        <div class="empty-state"><div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">No results found</div><p>Try a different keyword</p></div>`;
      return;
    }

    renderResults();
  } catch (e) {
    // Fallback: generate mock data to show the UI works
    state.results = generateMockResults(keyword, limit);
    renderResults();
    toastInfo('Live search unavailable — showing simulated data for UI preview');
  }

  state.loading = false;
  if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Analyse`; }
}

function renderResults() {
  const el = document.getElementById('comp-results');
  if (!el) return;

  // Stats summary
  const prices = state.results.map(r => (r.price?.amount || 0) / (r.price?.divisor || 100));
  const avgPrice = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : 0;
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 0;
  const totalFavs = state.results.reduce((s, r) => s + (r.num_favorers || 0), 0);

  // Tag frequency analysis
  const tagFreq = {};
  state.results.forEach(r => (r.tags || []).forEach(t => { tagFreq[t] = (tagFreq[t] || 0) + 1; }));
  const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 20);

  // Title word frequency
  const wordFreq = {};
  state.results.forEach(r => {
    (r.title || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).forEach(w => {
      if (w.length > 3) wordFreq[w] = (wordFreq[w] || 0) + 1;
    });
  });
  const topWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 15);

  el.innerHTML = `
    <!-- Summary stats -->
    <div class="stats-grid mb-12">
      ${statCard('Results', state.results.length, `for "${escHtml(state.keyword)}"`)}
      ${statCard('Price range', `$${minPrice.toFixed(2)}–$${maxPrice.toFixed(2)}`, `avg $${avgPrice.toFixed(2)}`)}
      ${statCard('Total favorites', number(totalFavs), 'across all results')}
      ${statCard('Avg favorites', number(Math.round(totalFavs / (state.results.length || 1))), 'per listing')}
    </div>

    <div class="grid-2 mb-12">
      <!-- Top tags -->
      <div class="card">
        <div class="card-title">Most used tags by competitors</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">
          ${topTags.map(([tag, count]) => {
    const pct = Math.round((count / state.results.length) * 100);
    return `<span class="tag-chip" style="cursor:pointer" title="${count} of ${state.results.length} listings — click to copy"
              onclick="window._compCopyTag('${escJsSingle(tag)}')">
              ${escHtml(tag)} <span style="color:var(--text-3);font-size:10px">${pct}%</span>
            </span>`;
  }).join('')}
        </div>
      </div>

      <!-- Top title words -->
      <div class="card">
        <div class="card-title">Most common title keywords</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Keyword</th><th style="width:60px">Count</th><th style="width:80px">Usage</th></tr></thead>
            <tbody>
              ${topWords.map(([word, count]) => {
    const pct = Math.round((count / state.results.length) * 100);
    return `<tr style="cursor:pointer" onclick="window._compCopyTag('${escJsSingle(word)}')">
                  <td style="font-size:12px">${escHtml(word)}</td>
                  <td style="font-size:12px">${count}</td>
                  <td>
                    <div style="background:var(--bg-hover);border-radius:3px;height:5px;overflow:hidden">
                      <div style="background:var(--orange);height:100%;width:${pct}%"></div>
                    </div>
                  </td>
                </tr>`;
  }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- AI Analysis button -->
    <div class="card mb-12">
      <div class="row-between">
        <div>
          <div style="font-size:13px;font-weight:600">AI Analysis & Recommendations</div>
          <div class="text-sm text-muted">AI analyses all ${state.results.length} listings and gives specific advice for your shop</div>
        </div>
        <button class="btn btn-primary" id="ai-analyse-btn" onclick="window.runAIAnalysis()">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
          Analyse with AI
        </button>
      </div>
      <div id="ai-analysis-result" style="${state.analysis ? '' : 'display:none'}">
        ${state.analysis ? renderAnalysis(state.analysis) : ''}
      </div>
    </div>

    <!-- Listings table -->
    <div class="card">
      <div class="card-title">Top ${state.results.length} listings — "${escHtml(state.keyword)}"</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th style="width:36px">#</th>
            <th style="width:56px"></th>
            <th>Title</th>
            <th style="width:80px">Price</th>
            <th style="width:70px">Favs</th>
            <th style="width:200px">Tags (sample)</th>
          </tr></thead>
          <tbody>
            ${state.results.map((r, i) => {
    const img = r.MainImage?.url_170x135 || r.images?.[0]?.url_170x135 || '';
    const topListingTags = (r.tags || []).slice(0, 4);
    const isBestseller = (r.num_favorers || 0) > 50;
    return `<tr style="cursor:pointer" onclick="window._compOpenListing(${r.listing_id})">
                <td style="font-size:12px;color:var(--text-3);font-weight:600">${i + 1}</td>
                <td>${img
        ? `<img src="${img}" class="thumbnail thumbnail-sm" alt="" style="width:44px;height:44px;object-fit:cover">`
        : `<div class="thumbnail thumbnail-sm" style="width:44px;height:44px;background:var(--bg-hover);display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--text-3)">📦</div>`}
                </td>
                <td>
                  <div style="font-size:12px;font-weight:500">
                    ${isBestseller ? '<span class="badge badge-orange" style="font-size:9px;margin-right:4px">🔥 Hot</span>' : ''}
                    ${escHtml(truncate(r.title || '', 65))}
                  </div>
                  <div class="text-sm text-muted">ID: ${r.listing_id}</div>
                </td>
                <td style="font-weight:600">${price(r.price?.amount || 0, r.price?.divisor)}</td>
                <td>${number(r.num_favorers || 0)}</td>
                <td>
                  <div style="display:flex;flex-wrap:wrap;gap:3px" onclick="event.stopPropagation()">
                    ${topListingTags.map(t => `<span class="tag-chip" style="font-size:10px;padding:1px 5px;cursor:pointer" onclick="window._compCopyTag('${escJsSingle(t)}')" title="Click to copy">${escHtml(t)}</span>`).join('')}
                  </div>
                </td>
              </tr>`;
  }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function runAIAnalysis() {
  const btn = document.getElementById('ai-analyse-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Analysing...'; }

  const analysisEl = document.getElementById('ai-analysis-result');
  if (analysisEl) { analysisEl.style.display = 'block'; analysisEl.innerHTML = '<div class="loading-center"><div class="spinner"></div> AI is analysing competitor patterns...</div>'; }

  try {
    const tagFreq = {};
    state.results.forEach(r => (r.tags || []).forEach(t => { tagFreq[t] = (tagFreq[t] || 0) + 1; }));
    const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t]) => t);

    const prices = state.results.map(r => (r.price?.amount || 0) / (r.price?.divisor || 100));
    const avgP = prices.reduce((s, p) => s + p, 0) / prices.length;

    const topListings = state.results.slice(0, 8).map(r => ({
      title: r.title?.slice(0, 80),
      price: ((r.price?.amount || 0) / (r.price?.divisor || 100)).toFixed(2),
      favs: r.num_favorers,
      tags: (r.tags || []).slice(0, 6),
    }));

    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'audit',
        provider: 'gemini',
        _rawSystem: `You are an Etsy market research expert. Analyse competitor data and give actionable recommendations.
Return ONLY valid JSON:
{
  "market_summary": "2-3 sentence market overview",
  "price_insight": "Price positioning advice",
  "top_keywords": ["keyword1", "keyword2", ...8 keywords to target],
  "gaps": ["Gap/opportunity 1", "Gap 2", "Gap 3"],
  "recommendations": [
    {"title": "Action title", "description": "Specific action to take"},
    {"title": "Action 2", "description": "..."},
    {"title": "Action 3", "description": "..."},
    {"title": "Action 4", "description": "..."}
  ],
  "avoid": ["Thing to avoid 1", "Thing to avoid 2"],
  "suggested_price_range": "$X.XX–$Y.YY"
}`,
        _rawPrompt: `Keyword searched: "${state.keyword}"
Total results analysed: ${state.results.length}
Average price: $${avgP.toFixed(2)}
Price range: $${Math.min(...prices).toFixed(2)}–$${Math.max(...prices).toFixed(2)}
Most used tags: ${topTags.join(', ')}
Top 8 listings: ${JSON.stringify(topListings, null, 2)}

My shop sells: Canva templates, SVG/PNG sublimation bundles, AI photo merge services, AI animation services, custom watercolor portraits. US market.

Analyse this competitor data and give specific recommendations for my shop.`,
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.analysis = data.data;

    if (analysisEl) analysisEl.innerHTML = renderAnalysis(state.analysis);
  } catch (e) {
    if (analysisEl) analysisEl.innerHTML = `<div class="alert alert-error" style="margin-top:10px">${escHtml(e.message)}</div>`;
    toastError('AI analysis failed: ' + e.message);
  }

  if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg> Re-analyse`; }
}

function renderAnalysis(a) {
  if (!a) return '';
  return `
    <div class="divider"></div>
    <div class="grid-2 mb-12">
      <div>
        <div style="font-size:12px;font-weight:600;margin-bottom:6px">Market overview</div>
        <p style="font-size:12px;color:var(--text-2);line-height:1.6">${escHtml(a.market_summary || '')}</p>
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;margin-bottom:6px">Pricing insight</div>
        <p style="font-size:12px;color:var(--text-2);line-height:1.6">${escHtml(a.price_insight || '')}
        ${a.suggested_price_range ? `<br><strong>Suggested range: ${escHtml(a.suggested_price_range)}</strong>` : ''}</p>
      </div>
    </div>

    <div class="grid-2 mb-12">
      <div>
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">Keywords to target</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${(a.top_keywords || []).map(k => `<span class="tag-chip" style="background:var(--green-bg);border-color:var(--green-text);color:var(--green-text);cursor:pointer" onclick="window._compCopyTag('${escJsSingle(k)}')" title="Click to copy">${escHtml(k)}</span>`).join('')}
        </div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">Market gaps / opportunities</div>
        ${(a.gaps || []).map(g => `<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border);color:var(--text-2)">💡 ${escHtml(g)}</div>`).join('')}
      </div>
    </div>

    <div class="mb-12">
      <div style="font-size:12px;font-weight:600;margin-bottom:8px">Recommendations for your shop</div>
      <div class="grid-2">
        ${(a.recommendations || []).map((r, i) => `
          <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
            <div style="display:flex;gap:8px;align-items:flex-start">
              <span style="width:20px;height:20px;border-radius:50%;background:var(--orange);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i + 1}</span>
              <div>
                <div style="font-size:12px;font-weight:600;margin-bottom:3px">${escHtml(r.title)}</div>
                <div style="font-size:11px;color:var(--text-2)">${escHtml(r.description)}</div>
              </div>
            </div>
          </div>`).join('')}
      </div>
    </div>

    ${a.avoid?.length ? `
    <div>
      <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--red-text)">What to avoid</div>
      ${a.avoid.map(av => `<div style="font-size:12px;color:var(--text-2);padding:3px 0">✕ ${escHtml(av)}</div>`).join('')}
    </div>` : ''}`;
}

function generateMockResults(keyword, count) {
  const mocks = [];
  const words = keyword.split(' ');
  for (let i = 0; i < count; i++) {
    mocks.push({
      listing_id: 1000000 + i,
      title: `${words.join(' ')} template digital download printable editable canva ${i + 1}`,
      price: { amount: Math.round((2.5 + Math.random() * 12) * 100), divisor: 100 },
      num_favorers: Math.round(Math.random() * 200),
      tags: [keyword.split(' ')[0], 'digital download', 'canva template', 'printable', 'editable', ...words],
      images: [],
    });
  }
  return mocks;
}

function statCard(label, value, sub = '') {
  return `<div class="stat-card">
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  </div>`;
}
