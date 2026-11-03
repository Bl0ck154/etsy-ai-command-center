// public/pages/bulk-create.js
// Bulk listing creator — paste N product ideas, AI generates all in parallel, review & publish

import { etsy, ai } from '../utils/api.js';
import { escHtml, truncate } from '../utils/format.js';
import { toastSuccess, toastError, toastInfo } from '../components/toast.js';
import { getShopContext, buildContextPrompt } from '../utils/shop-context.js';
import { getOrFetch, invalidate } from '../utils/store.js';
import { getModel } from '../utils/models.js';

let state = {
  step: 'input',
  provider: localStorage.getItem('ai_provider') || 'external',
  defaultListingType: 'download',
  defaultPrice: '',
  taxonomyId: null,
  taxonomyLabel: '',
  inputText: '',
  items: [],
  sections: [],
  publishResults: [],
  shopContext: '',
};

export async function renderBulkCreate(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Bulk Create</div>
        <div class="page-subtitle">Generate multiple listings at once with AI</div>
      </div>
    </div>
    <div class="page-body">
      <div id="bulk-content"></div>
    </div>`;

  window.bulkSetProvider = (p) => { state.provider = p; localStorage.setItem('ai_provider', p); };
  window.bulkStartGen = startGeneration;
  window.bulkApproveItem = approveItem;
  window.bulkEditField = editField;
  window.bulkPublishAll = publishAll;
  window.bulkPublishOne = (id) => { const r = state.publishResults.find(x => x.id === id); if (r) r.status = 'pending'; publishOne(id); };
  window.bulkRegenOne = regenOne;
  window.bulkReset = () => { state.step = 'input'; state.items = []; state.publishResults = []; renderStep(); };

  try {
    const result = await getOrFetch('sections', () => etsy.getShopSections());
    state.sections = result?.results || result || [];
  } catch { }

  renderStep();
}

function renderStep() {
  const map = { input: renderInput, generating: renderGenerating, review: renderReview, publishing: renderPublishing, done: renderDone };
  (map[state.step] || renderInput)();
}

// ── Step 1: Input ──────────────────────────────────────────

function renderInput() {
  const el = document.getElementById('bulk-content');
  el.innerHTML = `
    <div class="bulk-main-grid">
      <div class="card">
        <div class="card-title mb-8">Product list</div>
        <div style="font-size:12px;color:var(--text-2);margin-bottom:10px;line-height:1.5">
          One product per line — be specific (colours, sizes, use case, target buyer).
        </div>
        <textarea id="bulk-input" rows="16" style="font-size:13px;line-height:1.65" placeholder="Pickleball sublimation PNG bundle, 5 patriotic USA designs, print-ready
Hawaii 2026 Family Vacation PNG, tropical theme, matching shirts
Custom Birthday Canva template, girl age 7, princess theme, editable
Florida beach vacation SVG bundle, 8 designs, summer vibes
Bocce ball tournament flyer Canva template, editable, 8.5x11
Wedding watercolor portrait from photo, couple illustration
Dominican Republic 2026 vacation PNG, family matching shirts
Memorial photo merge service, add deceased loved one to family photo">${escHtml(state.inputText)}</textarea>
        <div class="row-between" style="margin-top:10px">
          <span style="font-size:12px;color:var(--text-3)" id="bulk-line-count">0 products</span>
          <button class="btn btn-primary" onclick="window.bulkStartGen()">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
            Generate all listings →
          </button>
        </div>
      </div>

      <div>
        <div class="card mb-10">
          <div class="card-title mb-10">Settings</div>

          <div class="field">
            <label style="font-size:12px">AI Model</label>
            <div style="display:flex;flex-direction:column;gap:5px">
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:400;cursor:pointer">
                <input type="radio" name="bulk-provider" value="gemini" ${state.provider === 'gemini' ? 'checked' : ''} onchange="window.bulkSetProvider('gemini')"> Gemini Flash
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:400;cursor:pointer">
                <input type="radio" name="bulk-provider" value="claude" ${state.provider === 'claude' ? 'checked' : ''} onchange="window.bulkSetProvider('claude')"> Claude Sonnet
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:400;cursor:pointer">
                <input type="radio" name="bulk-provider" value="external" ${state.provider === 'external' ? 'checked' : ''} onchange="window.bulkSetProvider('external')"> Configured AI
              </label>
            </div>
          </div>

          <div class="field">
            <label style="font-size:12px">Format</label>
            <select id="bulk-ltype" onchange="state.defaultListingType=this.value">
              <option value="download" ${state.defaultListingType === 'download' ? 'selected' : ''}>Digital download</option>
              <option value="physical" ${state.defaultListingType === 'physical' ? 'selected' : ''}>Physical / Service</option>
            </select>
          </div>

          <div class="field">
            <label style="font-size:12px">Default price (optional)</label>
            <div class="input-prefix">
              <span class="input-prefix-text">$</span>
              <input type="number" id="bulk-price" step="0.01" placeholder="AI suggests"
                value="${state.defaultPrice}" onchange="state.defaultPrice=this.value"
                style="border-radius:0 var(--radius) var(--radius) 0">
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title mb-8">How it works</div>
          <div style="font-size:12px;color:var(--text-2);line-height:1.8">
            <div>1. Paste product ideas (one per line)</div>
            <div>2. AI researches competitors + generates SEO title, 13 tags, description, price</div>
            <div>3. Review & edit each listing</div>
            <div>4. Approve what you want</div>
            <div>5. Publish all approved at once</div>
          </div>
        </div>
      </div>
    </div>`;

  const ta = document.getElementById('bulk-input');
  if (ta) {
    const update = () => {
      const n = ta.value.split('\n').filter(l => l.trim()).length;
      const el = document.getElementById('bulk-line-count');
      if (el) el.textContent = `${n} product${n !== 1 ? 's' : ''}`;
    };
    ta.addEventListener('input', update);
    update();
  }
}

// ── Step 2: Generating ─────────────────────────────────────

async function startGeneration() {
  const ta = document.getElementById('bulk-input');
  const raw = ta?.value || '';
  const ltype = document.getElementById('bulk-ltype')?.value || state.defaultListingType;
  const defPrice = document.getElementById('bulk-price')?.value || state.defaultPrice;

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) { toastError('Add at least one product'); return; }
  if (lines.length > 20) { toastError('Max 20 products at once'); return; }

  state.inputText = raw;
  state.defaultListingType = ltype;
  state.defaultPrice = defPrice;

  state.items = lines.map((line, i) => ({
    id: i, raw: line, status: 'pending', phase: '',
    generated: null, approved: true, price: defPrice || '', tags: [], materials: [], error: null,
  }));

  state.step = 'generating';
  renderGenerating();

  try {
    const ctx = await getShopContext();
    state.shopContext = buildContextPrompt(ctx);
  } catch { state.shopContext = ''; }

  // Generate in batches of 3
  const BATCH = 3;
  for (let i = 0; i < state.items.length; i += BATCH) {
    await Promise.allSettled(state.items.slice(i, i + BATCH).map(item => generateItem(item, ltype, defPrice)));
  }

  state.step = 'review';
  renderStep();
}

async function generateItem(item, ltype, defPrice) {
  item.status = 'generating';
  item.phase = 'Fetching competitor data…';
  renderGeneratingProgress();

  let competitors = '';
  try {
    const kw = item.raw.split(/[,.\n]/)[0].trim().slice(0, 60);
    const res = await fetch(`/api/etsy?action=searchListings&keyword=${encodeURIComponent(kw)}&limit=6`);
    if (res.ok) {
      const data = await res.json();
      const ls = data?.results || data?.data?.results || [];
      competitors = ls.slice(0, 6).map((l, i) => {
        const p = l.price ? `$${(l.price.amount / (l.price.divisor || 100)).toFixed(2)}` : 'N/A';
        return `${i + 1}. "${l.title}" — ${p} | Views: ${l.views || '?'} | Favs: ${l.num_favorers || '?'}`;
      }).join('\n');
    }
  } catch { }

  item.phase = 'Generating listing…';
  renderGeneratingProgress();

  try {
    const result = await ai.generateListing({
      listingType: ltype,
      description: item.raw,
      price: defPrice || 'suggest',
      provider: state.provider,
      shopContext: state.shopContext,
      competitorData: competitors,
      model: getModel(state.provider),
    });
    item.generated = result;
    item.tags = [...(result.tags || [])];
    item.materials = [...(result.materials || [])];
    item.price = defPrice || result.price_suggestion || '';
    item.status = 'done';
    item.phase = '';
  } catch (e) {
    item.error = e.message;
    item.status = 'error';
    item.phase = '';
  }
  renderGeneratingProgress();
}

function renderGenerating() {
  document.getElementById('bulk-content').innerHTML = `
    <div class="card" style="padding:32px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <div class="spinner spinner-lg"></div>
        <div>
          <div style="font-size:15px;font-weight:600">Generating ${state.items.length} listings…</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:2px">Researching competitors + AI writing — in batches of 3</div>
        </div>
      </div>
      <div id="bulk-progress-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
        ${state.items.map(item => progressCard(item)).join('')}
      </div>
    </div>`;
}

function renderGeneratingProgress() {
  const el = document.getElementById('bulk-progress-grid');
  if (el) el.innerHTML = state.items.map(progressCard).join('');
}

function progressCard(item) {
  const cfg = {
    pending:    { icon: '·',  color: 'var(--text-3)',    bg: 'var(--bg-secondary)' },
    generating: { icon: '⚡', color: 'var(--orange)',     bg: 'var(--orange-light)' },
    done:       { icon: '✓',  color: 'var(--green-text)', bg: 'var(--bg-secondary)' },
    error:      { icon: '✕',  color: 'var(--red-text)',   bg: 'var(--bg-secondary)' },
  };
  const c = cfg[item.status] || cfg.pending;
  return `<div style="background:${c.bg};border:1px solid var(--border);border-radius:var(--radius);padding:10px">
    <div style="font-size:12px;font-weight:600;color:${c.color};margin-bottom:3px">${c.icon} ${item.phase || (item.status.charAt(0).toUpperCase() + item.status.slice(1))}</div>
    <div style="font-size:11px;color:var(--text-3);line-height:1.4">${escHtml(truncate(item.raw, 55))}</div>
    ${item.error ? `<div style="font-size:10px;color:var(--red-text);margin-top:4px">${escHtml(item.error)}</div>` : ''}
  </div>`;
}

// ── Step 3: Review ─────────────────────────────────────────

function renderReview() {
  const done = state.items.filter(i => i.status === 'done').length;
  const errors = state.items.filter(i => i.status === 'error').length;
  const approved = state.items.filter(i => i.approved && i.status === 'done').length;

  document.getElementById('bulk-content').innerHTML = `
    <div style="position:sticky;top:0;z-index:100;background:var(--bg-page);border-bottom:1px solid var(--border);padding:10px 0;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="badge badge-green">${done} generated</span>
        ${errors ? `<span class="badge badge-red">${errors} failed</span>` : ''}
        <span class="badge badge-orange" id="bulk-approved-badge">${approved} approved</span>
      </div>
      <div class="row" style="gap:8px">
        <button class="btn btn-sm" onclick="window.bulkReset()" title="Back" style="padding:5px 12px;font-size:16px;line-height:1;font-weight:400">←</button>
        <button class="btn btn-primary" id="bulk-pub-btn" onclick="window.bulkPublishAll()" ${approved === 0 ? 'disabled' : ''}>
          Publish ${approved} listing${approved !== 1 ? 's' : ''} →
        </button>
      </div>
    </div>

    <div id="bulk-review-list">
      ${state.items.map(item => renderReviewCard(item)).join('')}
    </div>`;
}

function renderReviewCard(item) {
  if (item.status === 'error') {
    return `<div class="card mb-10" style="border-color:var(--red)" id="bulk-item-${item.id}">
      <div class="row-between">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--red-text)">✕ Failed</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:2px">${escHtml(truncate(item.raw, 70))}</div>
          <div style="font-size:11px;color:var(--red-text);margin-top:4px">${escHtml(item.error)}</div>
        </div>
        <button class="btn btn-sm" onclick="window.bulkRegenOne(${item.id})">↺ Retry</button>
      </div>
    </div>`;
  }

  const g = item.generated;
  if (!g) return '';

  const titleLen = (g.title || '').length;
  const titleColor = titleLen > 130 ? 'var(--green-text)' : titleLen > 100 ? 'var(--text-2)' : 'var(--text-3)';
  const priceVal = item.price || g.price_suggestion || '';

  return `<div class="card mb-10" id="bulk-item-${item.id}" style="${item.approved ? '' : 'opacity:0.45;border-style:dashed'}">
    <div class="row-between mb-10">
      <div class="row" style="gap:8px;min-width:0">
        <div class="toggle ${item.approved ? 'on' : ''}" id="bulk-toggle-${item.id}"
          onclick="window.bulkApproveItem(${item.id},!${item.approved})"
          title="${item.approved ? 'Click to skip' : 'Click to approve'}"></div>
        <span style="font-size:12px;font-weight:500;color:${item.approved ? 'var(--green-text)' : 'var(--text-3)'}">${item.approved ? 'Approved' : 'Skipped'}</span>
        <span style="font-size:11px;color:var(--text-3)">${escHtml(truncate(item.raw, 50))}</span>
      </div>
      <button class="btn btn-sm" onclick="window.bulkRegenOne(${item.id})" title="Regenerate">↺ Regen</button>
    </div>

    <div class="field" style="margin-bottom:8px">
      <div class="row-between" style="margin-bottom:3px">
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3)">Title</label>
        <span style="font-size:11px;color:${titleColor}" id="bc-tlen-${item.id}">${titleLen}/140</span>
      </div>
      <input type="text" value="${escHtml(g.title || '')}" maxlength="140" style="font-size:13px"
        oninput="window.bulkEditField(${item.id},'title',this.value);document.getElementById('bc-tlen-${item.id}').textContent=this.value.length+'/140'">
    </div>

    <div class="bulk-review-row">
      <div class="field" style="margin:0">
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3)">Price (USD)</label>
        <div class="input-prefix" style="margin-top:3px">
          <span class="input-prefix-text">$</span>
          <input type="number" step="0.01" min="0.20" value="${priceVal}"
            placeholder="${g.price_suggestion || 'suggest'}"
            oninput="window.bulkEditField(${item.id},'price',this.value)"
            style="border-radius:0 var(--radius) var(--radius) 0;font-size:12px">
        </div>
      </div>
      <div class="field" style="margin:0">
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3)">Tags (${item.tags.length}/13)</label>
        <input type="text" value="${escHtml(item.tags.join(', '))}" style="font-size:12px;margin-top:3px"
          oninput="window.bulkEditField(${item.id},'tags',this.value)"
          placeholder="tag1, tag2, tag3...">
      </div>
    </div>

    <details style="margin-top:4px">
      <summary style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);cursor:pointer;user-select:none">Description (click to expand)</summary>
      <textarea rows="5" style="font-size:11px;margin-top:6px;line-height:1.6"
        oninput="window.bulkEditField(${item.id},'description',this.value)">${escHtml(g.description || '')}</textarea>
    </details>
  </div>`;
}

// ── Step 4: Publishing ─────────────────────────────────────

async function publishAll() {
  const toPublish = state.items.filter(i => i.approved && i.status === 'done');
  if (!toPublish.length) { toastError('No approved listings'); return; }

  state.step = 'publishing';
  state.publishResults = toPublish.map(i => ({ id: i.id, status: 'pending', listing_id: null, url: null, error: null }));
  renderPublishing();

  for (const item of toPublish) {
    await publishOne(item.id);
  }

  state.step = 'done';
  renderStep();
}

async function publishOne(itemId) {
  const item = state.items.find(i => i.id === itemId);
  if (!item?.generated) return;

  let result = state.publishResults.find(r => r.id === itemId);
  if (!result) { result = { id: itemId, status: 'pending', listing_id: null, url: null, error: null }; state.publishResults.push(result); }

  result.status = 'publishing';
  renderPublishingProgress();

  try {
    const g = item.generated;
    const priceVal = parseFloat(item.price || g.price_suggestion || 5);
    const payload = {
      title: (g.title || '').slice(0, 140),
      description: g.description || '',
      price: Math.max(priceVal, 0.20),
      quantity: 999,
      tags: item.tags.slice(0, 13),
      materials: (item.materials || g.materials || []).slice(0, 13),
      listing_type: state.defaultListingType,
      who_made: 'i_did',
      when_made: 'made_to_order',
      is_supply: false,
      should_auto_renew: true,
    };
    const res = await etsy.createListing(payload);
    result.listing_id = res.listing_id;
    result.url = `https://www.etsy.com/listing/${res.listing_id}`;
    result.status = 'done';
    invalidate('listings:active');
  } catch (e) {
    result.error = e.message;
    result.status = 'error';
  }
  renderPublishingProgress();
}

function renderPublishing() {
  document.getElementById('bulk-content').innerHTML = `
    <div class="card" style="padding:32px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <div class="spinner spinner-lg"></div>
        <div>
          <div style="font-size:15px;font-weight:600">Publishing to Etsy…</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:2px">Publishing one by one</div>
        </div>
      </div>
      <div id="bulk-pub-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
        ${state.publishResults.map(pubCard).join('')}
      </div>
    </div>`;
}

function renderPublishingProgress() {
  const el = document.getElementById('bulk-pub-grid');
  if (el) el.innerHTML = state.publishResults.map(pubCard).join('');
}

function pubCard(r) {
  const item = state.items.find(i => i.id === r.id);
  const cfg = {
    pending:    { icon: '·',  color: 'var(--text-3)' },
    publishing: { icon: '⬆', color: 'var(--orange)' },
    done:       { icon: '✓',  color: 'var(--green-text)' },
    error:      { icon: '✕',  color: 'var(--red-text)' },
  };
  const c = cfg[r.status] || cfg.pending;
  return `<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px">
    <div style="font-size:12px;font-weight:600;color:${c.color};margin-bottom:3px">${c.icon} ${r.status}</div>
    <div style="font-size:11px;color:var(--text-3)">${escHtml(truncate(item?.generated?.title || item?.raw || '', 55))}</div>
    ${r.url ? `<a href="${r.url}" target="_blank" style="font-size:10px;color:var(--orange);margin-top:3px;display:block">View on Etsy ↗</a>` : ''}
    ${r.error ? `<div style="font-size:10px;color:var(--red-text);margin-top:3px">${escHtml(r.error)}</div>` : ''}
  </div>`;
}

// ── Step 5: Done ───────────────────────────────────────────

function renderDone() {
  const ok = state.publishResults.filter(r => r.status === 'done');
  const fail = state.publishResults.filter(r => r.status === 'error');

  document.getElementById('bulk-content').innerHTML = `
    <div class="card" style="text-align:center;padding:36px;margin-bottom:12px">
      <div style="font-size:36px;margin-bottom:12px">${fail.length === 0 ? '🎉' : '⚠️'}</div>
      <div style="font-size:18px;font-weight:700;margin-bottom:4px">${ok.length} listing${ok.length !== 1 ? 's' : ''} published!</div>
      ${fail.length ? `<div style="font-size:13px;color:var(--red-text);margin-bottom:12px">${fail.length} failed</div>` : ''}
      <div class="row" style="justify-content:center;gap:8px;margin-top:20px">
        <button class="btn btn-primary" onclick="window.navigate('listings')">View all listings</button>
        <button class="btn" onclick="window.bulkReset()">Create more</button>
      </div>
    </div>

    ${ok.length ? `<div class="card">
      <div class="card-title mb-8">Published</div>
      ${ok.map(r => {
        const item = state.items.find(i => i.id === r.id);
        return `<div class="row-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="min-width:0;flex:1">
            <div style="font-size:13px;font-weight:500">${escHtml(truncate(item?.generated?.title || '', 65))}</div>
            <a href="${r.url}" target="_blank" style="font-size:11px;color:var(--orange)">${r.url}</a>
          </div>
          <a href="${r.url}" target="_blank" class="btn btn-sm" style="margin-left:12px;flex-shrink:0">View ↗</a>
        </div>`;
      }).join('')}
      ${fail.map(r => {
        const item = state.items.find(i => i.id === r.id);
        return `<div class="row-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:13px;color:var(--text-2)">${escHtml(truncate(item?.raw || '', 65))}</div>
            <div style="font-size:11px;color:var(--red-text)">${escHtml(r.error)}</div>
          </div>
          <button class="btn btn-sm" onclick="window.bulkPublishOne(${r.id})">Retry</button>
        </div>`;
      }).join('')}
    </div>` : ''}`;
}

// ── Helpers ────────────────────────────────────────────────

function approveItem(id, approved) {
  const item = state.items.find(i => i.id === id);
  if (item) item.approved = approved;
  document.getElementById(`bulk-toggle-${id}`)?.classList.toggle('on', approved);
  const card = document.getElementById(`bulk-item-${id}`);
  if (card) { card.style.opacity = approved ? '1' : '0.45'; card.style.borderStyle = approved ? '' : 'dashed'; }
  // Update status label inside card
  const label = card?.querySelector(`[id^="bulk-toggle-"] + span`);
  // Simpler: re-query by DOM position
  updateHeaderBadge();
}

function updateHeaderBadge() {
  const approved = state.items.filter(i => i.approved && i.status === 'done').length;
  const badge = document.getElementById('bulk-approved-badge');
  if (badge) badge.textContent = `${approved} approved`;
  const btn = document.getElementById('bulk-pub-btn');
  if (btn) { btn.textContent = `Publish ${approved} listing${approved !== 1 ? 's' : ''} →`; btn.disabled = approved === 0; }
}

function editField(id, field, value) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  if (field === 'tags') item.tags = value.split(',').map(t => t.trim()).filter(Boolean).slice(0, 13);
  else if (field === 'title' && item.generated) item.generated.title = value;
  else if (field === 'description' && item.generated) item.generated.description = value;
  else if (field === 'price') item.price = value;
}

async function regenOne(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  item.status = 'pending'; item.generated = null; item.error = null;
  const card = document.getElementById(`bulk-item-${id}`);
  if (card) card.innerHTML = `<div class="row" style="gap:8px;padding:8px 0"><div class="spinner"></div><span style="font-size:13px">Regenerating…</span></div>`;
  await generateItem(item, state.defaultListingType, state.defaultPrice);
  // Replace card
  const existing = document.getElementById(`bulk-item-${id}`);
  if (existing) {
    const tmp = document.createElement('div');
    tmp.innerHTML = renderReviewCard(item);
    existing.replaceWith(tmp.firstElementChild);
  }
  updateHeaderBadge();
}
