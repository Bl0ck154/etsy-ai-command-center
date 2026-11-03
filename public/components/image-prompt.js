// public/components/image-prompt.js
// AI image prompt generator + provider-backed generation with "Add to listing" support

import { toastSuccess, toastError } from './toast.js';
// modal.js no longer used here — image gen panel is inline on the create page
import { saveImage } from '../utils/image-store.js';
import { base64ToFile } from '../utils/file-helpers.js';
import { fetchJsonWithTimeout, jobs, userFacingErrorMessage } from '../utils/api.js';
import { IMG_PROMPT_BATCH_SYSTEM, IMG_PROMPT_SYSTEM, SLOT_TEMPLATES, STYLE_CARD_SYSTEM } from '../utils/image-prompt-constants.js';

const DEFAULT_IMAGE_JOB_TIMEOUT_MS = 120000;
const EXTERNAL_IMAGE_JOB_TIMEOUT_MS = 120000;
const IMAGE_JOB_POLL_GRACE_MS = 30000;
const PROMPT_REQUEST_ATTEMPTS = 2;
const PROMPT_RETRY_DELAY_MS = 350;

function imageJobTimeoutMs(provider = localStorage.getItem('image_provider') || 'external') {
  return String(provider || '').toLowerCase() === 'external'
    ? EXTERNAL_IMAGE_JOB_TIMEOUT_MS
    : DEFAULT_IMAGE_JOB_TIMEOUT_MS;
}

// ─── Style card fetch (Phase 1 — run once per listing) ─────────────────────

function waitForPromptRetry(attempt) {
  return new Promise(resolve => setTimeout(resolve, PROMPT_RETRY_DELAY_MS * attempt));
}

function imagePromptPrefetchKey(description = '', listingTitle = '', provider = '') {
  return `${listingTitle.trim()}::${description.trim()}::${provider}`;
}

async function fetchStyleCard(description, provider) {
  let lastError;
  for (let attempt = 1; attempt <= PROMPT_REQUEST_ATTEMPTS; attempt++) {
    try {
      const data = await fetchJsonWithTimeout('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'audit',
          provider,
          _thinkingLevel: 'NONE',
          _rawSystem: STYLE_CARD_SYSTEM,
          _rawPrompt: description,
        }),
      }, 'Prompt writer', 120000);
      const text = typeof data.data === 'string' ? data.data.trim() : '';
      if (text) return text;
      throw new Error('Prompt writer returned an empty style card');
    } catch (error) {
      lastError = error;
      if (attempt < PROMPT_REQUEST_ATTEMPTS) await waitForPromptRetry(attempt);
    }
  }
  throw lastError;
}

// ─── Batch fetch (Phase 2 — receives style card, runs in parallel) ──────────

async function fetchBatchRequest(slotIndices, description, provider, styleCard = '', existingPrompts = []) {
  const slotList = slotIndices.map((i, pos) => {
    const s = SLOT_TEMPLATES[i];
    return `${pos + 1}. Slot ${i} — "${s.label}": ${s.desc}`;
  }).join('\n');

  const styleSection = styleCard
    ? `══ VISUAL STYLE CARD — apply to ALL prompts ══\n${styleCard}\n\nEvery prompt MUST preserve the product truth, palette, lighting character, and camera/render language above. Vary composition and buyer objective without changing the product.\n\n`
    : '';

  const existingSection = existingPrompts.length
    ? `══ ALREADY-WRITTEN PROMPTS FOR THIS LISTING (maintain full consistency) ══\n${existingPrompts.map(p => `Slot ${p.slot} "${p.label}":\n${p.prompt}`).join('\n\n')}\n\nThe prompts you write now must feel like the same campaign: same product identity, palette, lighting grade, camera/render language, and restrained text treatment.\n\n`
    : '';

  const data = await fetchJsonWithTimeout('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'audit',
      provider,
      _thinkingLevel: 'NONE',
      _rawSystem: IMG_PROMPT_BATCH_SYSTEM,
      _rawPrompt: `${styleSection}${existingSection}Etsy listing context:\n${description}

Generate ${slotIndices.length} detailed commercial image briefs for these listing image slots:
${slotList}

Each prompt must be 7-10 sentences and include objective, product/reference fidelity, composition, exact text policy, lighting, camera/render method, consistency, negative constraints, aspect ratio, and crop safety. Follow the Visual Style Card above exactly.
Return ONLY a JSON array with exactly ${slotIndices.length} objects in the same order as the slots above.`,
    }),
  }, 'Prompt writer', 120000);
  return parseBatchResponse(data.data, slotIndices);
}

async function fetchBatch(slotIndices, description, provider, styleCard = '', existingPrompts = [], onPartial = null) {
  const completed = new Map();
  let pending = [...slotIndices];
  let lastError;

  for (let attempt = 1; attempt <= PROMPT_REQUEST_ATTEMPTS && pending.length; attempt++) {
    try {
      const consistencyContext = [...existingPrompts, ...completed.values()];
      const prompts = await fetchBatchRequest(pending, description, provider, styleCard, consistencyContext);
      const live = prompts.filter(prompt => prompt?.prompt);
      live.forEach(prompt => completed.set(prompt.slot, prompt));
      if (live.length) onPartial?.(live);
      pending = pending.filter(slot => !completed.has(slot));
      if (!pending.length) break;
      lastError = new Error(`Prompt writer omitted ${pending.length} prompt${pending.length === 1 ? '' : 's'}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < PROMPT_REQUEST_ATTEMPTS && pending.length) await waitForPromptRetry(attempt);
  }

  if (!completed.size && lastError) throw lastError;
  return slotIndices.map(slot => completed.get(slot) || {
    slot,
    label: SLOT_TEMPLATES[slot].label,
    ratio: SLOT_TEMPLATES[slot].ratio,
    prompt: '',
  });
}

function parseBatchResponse(raw, slotIndices) {
  let arr = null;

  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string') {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
      try { arr = JSON.parse(cleaned.slice(start, end + 1)); } catch { arr = null; }
    }
  }

  if (!Array.isArray(arr)) arr = [];

  // Map results back to their global slot indices — resilient to partial responses
  return slotIndices.map((slotIdx, i) => {
    const s = SLOT_TEMPLATES[slotIdx];
    const obj = arr[i] || {};
    return {
      slot: slotIdx,
      label: obj.label || s.label,
      ratio: s.ratio,
      prompt: obj.prompt || '', // empty prompt if AI missed it — user can edit manually
    };
  });
}

// ─── Background prefetch ────────────────────────────────────────────────────

export function prefetchImagePrompts(description, listingTitle = '', provider = localStorage.getItem('ai_provider') || 'external') {
  const key = imagePromptPrefetchKey(description, listingTitle, provider);
  const existing = window.__imgGenPrefetch;
  if (existing?.key === key && existing.promise && existing.status !== 'error') return existing.promise;

  // prompts array pre-allocated so partial results can be stored as each batch arrives
  const partialPrompts = new Array(SLOT_TEMPLATES.length).fill(null);
  const batch1 = [0, 1, 2, 3, 4];
  const batch2 = [5, 6, 7, 8];

  const applyBatch = (fetchedPrompts) => {
    const pf = window.__imgGenPrefetch;
    if (!pf || pf.key !== key) return;
    fetchedPrompts.forEach(p => { if (p?.slot >= 0 && p.slot < pf.prompts.length) pf.prompts[p.slot] = p; });
    // If panel is already open, fill in newly arrived slots immediately
    fetchedPrompts.forEach(p => {
      if (!p?.prompt) return;
      const ta = document.getElementById(`prompt-ta-${p.slot}`);
      const btn = document.getElementById(`gen-btn-${p.slot}`);
      if (ta && !ta.value) { ta.disabled = false; ta.style.color = ''; ta.placeholder = ''; ta.value = p.prompt; if (window.__imgGen?.prompts[p.slot] !== undefined) window.__imgGen.prompts[p.slot] = p; }
      updatePromptStatus(p.slot, p.prompt);
      if (btn && btn.disabled) btn.disabled = false;
    });
  };

  // One shared style card establishes cohesion; independent prompt batches then run concurrently.
  const promise = (async () => {
    const styleCard = await fetchStyleCard(description, provider).catch(() => '');
    if (window.__imgGenPrefetch?.key === key) window.__imgGenPrefetch.styleCard = styleCard;

    await Promise.allSettled([
      fetchBatch(batch1, description, provider, styleCard, [], applyBatch),
      fetchBatch(batch2, description, provider, styleCard, [], applyBatch),
    ]);

    const pf = window.__imgGenPrefetch;
    if (!pf || pf.key !== key) return partialPrompts;
    const completed = pf.prompts.filter(prompt => prompt?.prompt).length;
    pf.status = completed === SLOT_TEMPLATES.length ? 'done' : (completed > 0 ? 'partial' : 'error');
    return pf.prompts;
  })();

  window.__imgGenPrefetch = { key, promise, status: 'loading', prompts: partialPrompts, listingTitle };
  return promise;
}

// ─── Main entry — opens the modal ──────────────────────────────────────────

export async function generateImagePrompt(productDescription, listingId = null, provider = localStorage.getItem('ai_provider') || 'external', slotCount = 9, listingTitle = '', savedPrompts = [], savedState = {}) {
  slotCount = Math.min(Math.max(slotCount, 1), SLOT_TEMPLATES.length);

  // Restore panel if same listing is re-opened
  const prev = window.__imgGen;
  const panel = document.getElementById('img-gen-panel');
  if (prev?.prompts?.length === slotCount && prev.description === productDescription && (prev.prompts.some(p => p.prompt) || prev._promptLoading || prev._genRunning || prev._genQueue?.length)) {
    // Just show the existing panel — never re-render (preserves generated images + in-flight generation)
    if (panel && panel.children.length > 0) {
      panel.style.cssText = 'position:fixed;inset:0;z-index:9990;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto;background:rgba(0,0,0,0.5)';
      panel.onclick = (e) => { if (e.target === panel) closeImgGenPanel(); };
      document.removeEventListener('keydown', window.__imgGenEscHandler);
      window.__imgGenEscHandler = (e) => { if (e.key === 'Escape') closeImgGenPanel(); };
      document.addEventListener('keydown', window.__imgGenEscHandler);
      return;
    }
  }

  // Render modal immediately with empty slots
  const normalizedSaved = [];
  if (Array.isArray(savedPrompts)) {
    savedPrompts.forEach((prompt, index) => {
      if (!prompt || typeof prompt !== 'object') return;
      const slot = Number.isInteger(prompt.slot) && prompt.slot >= 0 ? prompt.slot : index;
      normalizedSaved[slot] = prompt;
    });
  }
  const skeleton = SLOT_TEMPLATES.slice(0, slotCount).map((s, i) => {
    const saved = normalizedSaved[i];
    return {
      slot: i,
      label: saved?.label || s.label,
      ratio: saved?.ratio || s.ratio,
      prompt: saved?.prompt || '',
    };
  });
  renderModal(skeleton, productDescription, provider, listingTitle, savedState);

  skeleton.forEach((_, i) => {
    const ta = document.getElementById(`prompt-ta-${i}`);
    const btn = document.getElementById(`gen-btn-${i}`);
    const hasPrompt = Boolean(skeleton[i]?.prompt?.trim());
    if (ta) {
      ta.disabled = !hasPrompt;
      ta.placeholder = hasPrompt ? '' : 'Writing prompt…';
      ta.style.color = hasPrompt ? '' : 'var(--text-3)';
    }
    if (btn) btn.disabled = !hasPrompt;
  });

  if (skeleton.every(p => p?.prompt?.trim())) return;

  // ── Check prefetch cache ──────────────────────────────────────────────────
  const pf = window.__imgGenPrefetch;
  const pfKey = imagePromptPrefetchKey(productDescription, listingTitle, provider);

  const applyPrefetchedPrompts = (allPrompts) => {
    allPrompts.slice(0, slotCount).forEach((p, i) => {
      const ta = document.getElementById(`prompt-ta-${i}`);
      const livePrompt = window.__imgGen?.prompts[i]?.prompt?.trim() || ta?.value?.trim();
      if (livePrompt || !p?.prompt?.trim()) return;
      if (window.__imgGen?.prompts[i]) window.__imgGen.prompts[i] = p;
      const btn = document.getElementById(`gen-btn-${i}`);
      if (ta) { ta.disabled = false; ta.style.color = ''; ta.placeholder = ''; ta.value = p.prompt; }
      if (btn) btn.disabled = false;
    });
    window.__saveCreateDraft?.();
    if (pf?.status === 'loading') return;
    // Retry only slots still missing from the live panel after saved/manual prompts and cache are merged.
    const livePrompts = window.__imgGen?.prompts || [];
    const missing = Array.from({ length: slotCount }, (_, i) => i)
      .filter(i => !livePrompts[i]?.prompt?.trim());
    if (missing.length) {
      fetchAndApplyBatch(missing, productDescription, provider, pf?.styleCard || '').catch(() => {});
    }
  };

  if (pf?.key === pfKey && ['done', 'partial'].includes(pf.status) && pf.prompts) {
    applyPrefetchedPrompts(pf.prompts);
    return;
  }

  if (pf?.key === pfKey && pf.status === 'loading' && pf.promise) {
    // Apply whatever is already cached (partial results from completed batches)
    if (pf.prompts?.some(p => p?.prompt)) applyPrefetchedPrompts(pf.prompts);
    // Wait for remaining batches — applyBatch() will fill slots live as they arrive
    try { await pf.promise; } catch { }
    // Final pass to ensure everything is applied
    if (window.__imgGenPrefetch?.prompts) applyPrefetchedPrompts(window.__imgGenPrefetch.prompts);
    return;
  }

  // No prefetch — fetch fresh in 2 parallel batches
  const missingSlots = skeleton
    .map((prompt, index) => prompt?.prompt?.trim() ? null : index)
    .filter(index => index !== null);
  await fetchAndFillSlots(missingSlots, productDescription, provider);
}

async function fetchAndFillAll(slotCount, description, provider) {
  return fetchAndFillSlots(Array.from({ length: slotCount }, (_, i) => i), description, provider);
}

async function fetchAndFillSlots(slotIndices, description, provider) {
  const uniqueSlots = [...new Set((slotIndices || []).filter(i => Number.isInteger(i) && i >= 0 && i < SLOT_TEMPLATES.length))];
  if (!uniqueSlots.length) return;
  if (window.__imgGen) window.__imgGen._promptLoading = true;
  try {
    // Phase 1: generate shared visual style card (one fast call)
    const styleCard = await fetchStyleCard(description, provider).catch(() => '');
    if (window.__imgGen) window.__imgGen.styleCard = styleCard;

    // Phase 2: independent batches share the style card and run concurrently.
    const batch1 = uniqueSlots.slice(0, 5);
    const batch2 = uniqueSlots.slice(5);
    const batch2Promise = batch2.length
      ? fetchAndApplyBatch(batch2, description, provider, styleCard)
        .then(value => ({ value }), error => ({ error }))
      : Promise.resolve({ value: [] });

    try {
      await fetchAndApplyBatch(batch1, description, provider, styleCard);
    } catch {
      toastError('Some prompts failed to generate — enter them manually or click ↺');
    }
    if (batch2.length) {
      try {
        const batch2Result = await batch2Promise;
        if (batch2Result.error) throw batch2Result.error;
      } catch {
        toastError('Some prompts failed to generate — enter them manually or click ↺');
      }
    }
  } finally {
    if (window.__imgGen) window.__imgGen._promptLoading = false;
  }
}

async function fetchAndApplyBatch(slotIndices, description, provider, styleCard = '', existingPrompts = []) {
  try {
    const prompts = await fetchBatch(slotIndices, description, provider, styleCard, existingPrompts);
    let failed = 0;
    prompts.forEach(p => {
      const i = p.slot;
      const existingPrompt = window.__imgGen?.prompts[i]?.prompt;
      if (window.__imgGen?.prompts[i] !== undefined && (p.prompt || !existingPrompt)) window.__imgGen.prompts[i] = p;
      const ta = document.getElementById(`prompt-ta-${i}`);
      const btn = document.getElementById(`gen-btn-${i}`);
      if (p.prompt) {
        if (ta) { ta.disabled = false; ta.style.color = ''; ta.placeholder = ''; ta.value = p.prompt; }
        updatePromptStatus(i, p.prompt);
        if (btn) btn.disabled = false;
      } else {
        failed++;
        if (ta) { ta.disabled = false; ta.style.color = 'var(--red-text)'; ta.placeholder = 'Error — enter prompt manually or click ↺'; }
        if (btn) btn.disabled = false;
      }
    });
    if (failed > 0) toastError(`${failed} prompt${failed > 1 ? 's' : ''} missing — enter manually`);
    window.__saveCreateDraft?.();
    return prompts;
  } catch (e) {
    slotIndices.forEach(i => {
      const ta = document.getElementById(`prompt-ta-${i}`);
      const btn = document.getElementById(`gen-btn-${i}`);
      if (ta) { ta.disabled = false; ta.style.color = 'var(--red-text)'; ta.placeholder = `Error: ${userFacingErrorMessage(e.message)} — enter manually`; }
      if (btn) btn.disabled = false;
    });
    throw e;
  }
}

// ─── Single-slot fetch (for rewrite) ───────────────────────────────────────

async function fetchSlot(slotIndex, description, provider) {
  const s = SLOT_TEMPLATES[slotIndex];
  const data = await fetchJsonWithTimeout('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'audit',
      provider,
      _thinkingLevel: 'NONE',
      _rawSystem: IMG_PROMPT_SYSTEM,
      _rawPrompt: `Etsy listing context: ${description}

Generate ONE image prompt for this slot:
Slot ${slotIndex}: ${s.label} (${s.ratio}) — ${s.desc}

  The prompt will be used by the configured image provider. Write a detailed 7-10 sentence commercial brief, using photography or rendering language appropriate to the exact product.
Return a single JSON object: { "slot": ${slotIndex}, "label": "${s.label}", "ratio": "${s.ratio}", "prompt": "..." }`,
    }),
  }, 'Prompt writer', 120000);
  return parseSlotResponse(data.data, slotIndex);
}

function parseSlotResponse(raw, i) {
  const s = SLOT_TEMPLATES[i];
  if (raw && typeof raw === 'object' && raw.prompt) {
    return { slot: raw.slot ?? i, label: raw.label || s.label, ratio: raw.ratio || s.ratio, prompt: raw.prompt };
  }
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    if (start !== -1) {
      try {
        const obj = JSON.parse(cleaned.slice(start, cleaned.lastIndexOf('}') + 1));
        if (obj?.prompt) return { slot: obj.slot ?? i, label: obj.label || s.label, ratio: obj.ratio || s.ratio, prompt: obj.prompt };
      } catch { }
    }
  }
  throw new Error(`No prompt returned for slot ${i}`);
}

// ─── Overlay panel (fixed modal-style, DOM persists so in-flight fetches survive) ─

function closeImgGenPanel() {
  const p = document.getElementById('img-gen-panel');
  if (p) p.style.cssText = 'display:none';
  document.removeEventListener('keydown', window.__imgGenEscHandler);
}
if (typeof window !== 'undefined') {
  window.__imgGenClose = closeImgGenPanel;
}

function renderModal(prompts, description, provider, listingTitle = '', savedState = {}) {
  const panel = document.getElementById('img-gen-panel');
  if (!panel) return;

  panel.innerHTML = `
    <div id="img-gen-inner" style="background:var(--card,#fff);border-radius:14px;width:100%;max-width:820px;position:relative;box-shadow:0 24px 64px rgba(0,0,0,0.35);display:flex;flex-direction:column;max-height:calc(100vh - 48px)">
      <!-- Sticky header -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap;gap:8px;background:var(--card,#fff);border-radius:14px 14px 0 0">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="font-size:14px;font-weight:700;color:var(--text)">✦ Generate listing images</div>
          <div id="img-gen-ref-indicator" style="display:${window.__imgGenRef ? '' : 'none'};font-size:11px;padding:3px 8px;border-radius:20px;background:var(--orange-light,#fff7ed);color:var(--orange,#f97316);cursor:pointer;font-weight:600" title="Reference image set — click to clear" onclick="window.__imgGenRef=null;this.style.display='none'">
            🖼 Reference set ✕
          </div>
          <label style="font-size:11px;color:var(--text-3);cursor:pointer;display:flex;align-items:center;gap:4px" title="Upload your own reference image">
            <input type="file" accept="image/*" style="display:none" onchange="window.__imgGenLoadRef(this)">
            <span style="padding:3px 8px;border:1px solid var(--border);border-radius:20px;background:var(--bg-secondary)">⊕ Upload ref</span>
          </label>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" id="quick-gen-btn" onclick="window.__imgGen.quickGenerate()" title="Auto-write prompts and generate all images — one click" style="background:linear-gradient(135deg,#f97316,#ec4899);border:none">⚡ Quick Generate</button>
          <button class="btn btn-sm" id="gen-all-btn" onclick="window.__imgGen.generateAll()" title="Generate 1 image per slot for all slots that have prompts">▶ Generate all</button>
          <button class="btn btn-sm" id="stop-gen-btn" onclick="window.__imgGen._stopGenAll=true" title="Stop generating" style="display:none;color:var(--red,#dc2626)">■ Stop</button>
          <button class="btn btn-sm" onclick="window.__imgGenClose()" title="Close (Esc)" style="padding:4px 10px;font-size:17px;line-height:1;color:var(--text-3)">✕</button>
        </div>
      </div>
      <!-- Scrollable slots -->
      <div id="img-gen-slots" style="overflow-y:auto;padding:16px 18px;flex:1">
        ${prompts.map((p, i) => renderSlot(p, i)).join('')}
      </div>
    </div>`;

  // Show as fixed backdrop overlay
  panel.style.cssText = 'position:fixed;inset:0;z-index:9990;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto;background:rgba(0,0,0,0.5)';

  // Close on backdrop click (clicks on the panel itself, not the inner card)
  panel.onclick = (e) => { if (e.target === panel) closeImgGenPanel(); };

  // Escape key
  document.removeEventListener('keydown', window.__imgGenEscHandler);
  window.__imgGenEscHandler = (e) => { if (e.key === 'Escape') closeImgGenPanel(); };
  document.addEventListener('keydown', window.__imgGenEscHandler);

  window.__imgGen = {
    prompts,
    description,
    provider,
    listingTitle,
    styleCard: '',   // filled after fetchAndFillAll / regenAll
    _promptLoading: prompts.some(p => !p.prompt),
    _slotImages: savedState?.slotImages && typeof savedState.slotImages === 'object' ? savedState.slotImages : {},
    _slotJobs: savedState?.slotJobs && typeof savedState.slotJobs === 'object' ? savedState.slotJobs : {},
    _genQueue: [],       // queue of pending slot indices from manual 'Generate' clicks
    _genRunning: false,  // true while any single-slot generation is in progress

    _saveState() {
      window.__saveCreateDraft?.();
    },

    _ensureResultGrid(index) {
      const resultsEl = document.getElementById(`gen-results-${index}`);
      let grid = resultsEl?.querySelector('.img-gen-grid');
      if (!grid && resultsEl) {
        grid = document.createElement('div');
        grid.className = 'img-gen-grid';
        grid.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
        resultsEl.appendChild(grid);
      }
      return grid;
    },

    _ensureShimmerCss() {
      if (document.getElementById('img-gen-shimmer-css')) return;
      const st = document.createElement('style');
      st.id = 'img-gen-shimmer-css';
      st.textContent = '@keyframes igShimmer{0%{transform:translateX(-100%)}100%{transform:translateX(200%)}}';
      document.head.appendChild(st);
    },

    _buildSkeletons(index, count, ratio) {
      this._ensureShimmerCss();
      const grid = this._ensureResultGrid(index);
      if (grid) {
        Array.from(grid.children).forEach(child => {
          if (!child.querySelector('img')) child.remove();
        });
      }
      const [rw, rh] = (ratio || '1:1').split(':').map(Number);
      const skelW = 160;
      const skelH = (rh && rw) ? Math.round(skelW * rh / rw) : 160;
      return Array.from({ length: count }, (_, n) => {
        const timerId = `skel-t-${index}-${n}-${Date.now()}`;
        const skel = document.createElement('div');
        skel.style.cssText = `width:${skelW}px;height:${skelH}px;border-radius:8px;flex-shrink:0;position:relative;overflow:hidden;background:var(--bg-hover)`;
        skel.innerHTML = `
          <div style="position:absolute;inset:0;background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,0.13) 50%,transparent 100%);animation:igShimmer 1.6s ease-in-out infinite;will-change:transform"></div>
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:10px">
            <div class="spinner" style="width:18px;height:18px;border-width:2px;opacity:0.4"></div>
            <span style="font-size:10px;color:var(--text-3);text-align:center;line-height:1.4">Generating...<br><span id="${timerId}" style="opacity:0.6;font-variant-numeric:tabular-nums">0s</span></span>
          </div>`;
        if (grid) grid.appendChild(skel);
        let elapsed = 0;
        const timerInterval = setInterval(() => {
          elapsed++;
          const el = document.getElementById(timerId);
          if (el) el.textContent = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
          else clearInterval(timerInterval);
        }, 1000);
        return { skel, timerInterval };
      });
    },

    async _pollImageJob(jobId, timeoutMs = 300000, onProgress = null) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const job = await jobs.getStatus(jobId);
        onProgress?.(job);
        if (job?.status === 'done') return job.result;
        if (job?.status === 'error') throw new Error(userFacingErrorMessage(job.error || 'Image generation failed'));
      }
      throw new Error(`Image generation timed out after ${Math.round(timeoutMs / 1000)}s`);
    },

    async _pollParallelImageJobs(jobEntries, timeoutMs = 300000, onProgress = null) {
      const entries = Array.isArray(jobEntries) ? jobEntries.filter(job => job?.jobId) : [];
      if (!entries.length) throw new Error('No image generation jobs to resume');
      let completed = 0;
      const results = await Promise.allSettled(entries.map(async (entry, idx) => {
        const result = await this._pollImageJob(entry.jobId, timeoutMs, (job) => {
          onProgress?.({ job, index: idx, completed, total: entries.length });
        });
        entry.done = true;
        completed = entries.filter(item => item.done).length;
        onProgress?.({ job: { status: 'done', message: `Generated ${completed}/${entries.length}` }, index: idx, completed, total: entries.length });
        return result;
      }));
      const images = [];
      let lastError = '';
      for (const result of results) {
        if (result.status === 'fulfilled') images.push(...(result.value?.images || []));
        else lastError = userFacingErrorMessage(result.reason?.message || String(result.reason || 'Image generation failed'));
      }
      if (!images.length) throw new Error(lastError || 'Image generation failed');
      return { images, warning: lastError ? `Some images failed: ${lastError}` : '' };
    },

    _renderSavedImages() {
      Object.entries(this._slotImages || {}).forEach(([slotIndex, images]) => {
        const index = Number(slotIndex);
        if (!Array.isArray(images) || !images.length) return;
        const grid = this._ensureResultGrid(index);
        if (!grid) return;
        grid.innerHTML = '';
        images.forEach((img, imgIndex) => {
          if (img?.base64) grid.appendChild(buildImageCard(img, index, imgIndex));
        });
        const statusEl = document.getElementById(`gen-status-${index}`);
        if (statusEl) statusEl.textContent = 'AI image · Restored from this draft';
      });
    },

    _resumeSavedJobs() {
      Object.entries(this._slotJobs || {}).forEach(([slotIndex, saved]) => {
        const index = Number(slotIndex);
        if (!(saved?.jobId || saved?.jobs?.length) || saved.status === 'done') return;
        this._resumeSlotJob(index, saved).catch(() => {});
      });
    },

    async generateAll() {
      this._stopGenAll = false;
      const CONCURRENCY = 6; // Parallel — backend round-robins across API keys
      const queue = this.prompts
        .map((p, i) => i)
        .filter(i => this.prompts[i]?.prompt?.trim());
      const total = queue.length;
      let done = 0;
      const genAllBtn = document.getElementById('gen-all-btn');
      const stopBtn = document.getElementById('stop-gen-btn');
      const updateBtn = () => {
        if (genAllBtn) genAllBtn.innerHTML = `${done} / ${total} <div class="spinner" style="width:10px;height:10px;border-width:2px;display:inline-block;vertical-align:middle;margin-left:4px"></div>`;
      };
      if (genAllBtn) { genAllBtn.disabled = true; updateBtn(); }
      if (stopBtn) stopBtn.style.display = '';
      this._genRunning = true;
      // Run up to CONCURRENCY slots in parallel
      const worker = async () => {
        while (queue.length > 0 && !this._stopGenAll) {
          const i = queue.shift();
          const slotCount = Math.max(0, parseInt(document.getElementById(`gen-count-${i}`)?.value ?? '1'));
          if (slotCount > 0) await this._runSlot(i).catch(() => { });
          done++;
          updateBtn();
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(queue.length, 1)) }, worker));
      } finally {
        this._genRunning = false;
        if (genAllBtn) { genAllBtn.disabled = false; genAllBtn.innerHTML = '▶ Generate all'; }
        if (stopBtn) stopBtn.style.display = 'none';
        this._processQueue();
      }
    },

    async quickGenerate() {
      this._stopGenAll = false;
      const quickBtn = document.getElementById('quick-gen-btn');
      const genAllBtn = document.getElementById('gen-all-btn');
      const stopBtn = document.getElementById('stop-gen-btn');
      if (quickBtn) { quickBtn.disabled = true; quickBtn.innerHTML = '<div class="spinner" style="width:10px;height:10px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px"></div> Prompts…'; }
      if (genAllBtn) genAllBtn.disabled = true;
      if (stopBtn) stopBtn.style.display = '';

      try {
        // Step 1: Ensure prompts are written — wait for prefetch if in-flight
        const pf = window.__imgGenPrefetch;
        const pfKey = imagePromptPrefetchKey(this.description, this.listingTitle, this.provider);
        if (pf?.key === pfKey && pf.status === 'loading' && pf.promise) {
          // Prefetch already running — wait for it
          try { await pf.promise; } catch {}
        }
        if (window.__imgGenPrefetch?.key === pfKey && window.__imgGenPrefetch?.prompts?.length) {
          window.__imgGenPrefetch.prompts.slice(0, this.prompts.length).forEach((p, i) => {
            if (!p?.prompt) return;
            const ta = document.getElementById(`prompt-ta-${i}`);
            const livePrompt = this.prompts[i]?.prompt?.trim() || ta?.value?.trim();
            if (livePrompt) return;
            this.prompts[i] = p;
            const btn = document.getElementById(`gen-btn-${i}`);
            if (ta) { ta.disabled = false; ta.style.color = ''; ta.placeholder = ''; ta.value = p.prompt; }
            if (btn) btn.disabled = false;
            updatePromptStatus(i, p.prompt);
          });
        }

        const needsPrompts = this.prompts.some(p => !p?.prompt?.trim());
        if (needsPrompts) {
          await fetchAndFillAll(this.prompts.length, this.description, this.provider);
        }

        if (this._stopGenAll) return;

        // Step 2: Generate all slots in parallel
        if (quickBtn) quickBtn.innerHTML = '<div class="spinner" style="width:10px;height:10px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px"></div> Generating…';
        await this.generateAll();
      } finally {
        if (quickBtn) { quickBtn.disabled = false; quickBtn.innerHTML = '⚡ Quick Generate'; }
        if (genAllBtn) { genAllBtn.disabled = false; genAllBtn.innerHTML = '▶ Generate all'; }
        if (stopBtn) stopBtn.style.display = 'none';
      }
    },

    async regenAll() {
      const regenBtn = document.getElementById('regen-all-btn');
      if (regenBtn) { regenBtn.disabled = true; regenBtn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px"></div> Style…'; }
      const count = this.prompts.length;
      const desc = this.description;
      const prov = this.provider;

      for (let i = 0; i < count; i++) {
        const ta = document.getElementById(`prompt-ta-${i}`);
        const genBtn = document.getElementById(`gen-btn-${i}`);
        if (ta) { ta.disabled = true; ta.value = ''; ta.placeholder = 'Writing prompt…'; ta.style.color = 'var(--text-3)'; }
        if (genBtn) genBtn.disabled = true;
      }

      // Phase 1: fresh style card, then Phase 2: parallel batches
      if (regenBtn) regenBtn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px"></div> Prompts…';
      this.styleCard = await fetchStyleCard(desc, prov).catch(() => this.styleCard || '');

      const batch1 = Array.from({ length: Math.min(5, count) }, (_, i) => i);
      const batch2 = count > 5 ? Array.from({ length: count - 5 }, (_, i) => i + 5) : [];
      const batch2Promise = batch2.length
        ? fetchAndApplyBatch(batch2, desc, prov, this.styleCard)
          .then(value => ({ value }), error => ({ error }))
        : Promise.resolve({ value: [] });

      let failed = 0;
      try {
        await fetchAndApplyBatch(batch1, desc, prov, this.styleCard);
      } catch { failed++; }
      if (batch2.length) {
        try {
          const batch2Result = await batch2Promise;
          if (batch2Result.error) throw batch2Result.error;
        } catch { failed++; }
      }

      if (regenBtn) { regenBtn.disabled = false; regenBtn.innerHTML = '↺ Prompts'; }
      if (failed > 0) import('../components/toast.js').then(m => m.toastError('Some prompts failed — enter manually'));
    },

    updatePrompt(index, value) {
      if (this.prompts[index]) this.prompts[index].prompt = value;
      window.__saveCreateDraft?.();
    },

    async rewriteSlot(index) {
      const ta = document.getElementById(`prompt-ta-${index}`);
      const feedbackEl = document.getElementById(`feedback-${index}`);
      const rewriteBtn = document.getElementById(`rewrite-btn-${index}`);
      const currentPrompt = ta?.value?.trim();
      const feedback = feedbackEl?.value?.trim();
      if (!currentPrompt) { toastError('No prompt to rewrite'); return; }
      if (rewriteBtn) { rewriteBtn.disabled = true; rewriteBtn.textContent = '…'; }
      try {
        const data = await fetchJsonWithTimeout('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'audit',
            provider: this.provider,
            _thinkingLevel: 'NONE',
            _rawSystem: IMG_PROMPT_SYSTEM,
            _rawPrompt: `Etsy listing context: ${this.description}
${this.styleCard ? `\nVisual Style Card (must match the other images in this listing):\n${this.styleCard}\n` : ''}
${this.prompts.filter((p, i) => i !== index && p?.prompt).length ? `\nOther prompts already written for this listing (maintain full consistency — same palette, lighting, typography):\n${this.prompts.filter((p, i) => i !== index && p?.prompt).map(p => `Slot ${p.slot} "${p.label}":\n${p.prompt}`).join('\n\n')}\n` : ''}
Current prompt for slot ${index} (${this.prompts[index]?.label}):
${currentPrompt}

User feedback: ${feedback || 'improve the prompt — make it more photorealistic, detailed, and catchy for Etsy'}

Rewrite the prompt based on this feedback. Keep the same truthful slot objective and ratio (${this.prompts[index]?.ratio || '1:1'}). Follow the Visual Style Card above and preserve exact listing/reference details. Make it a detailed 7-10 sentence commercial brief with exact text policy, negative constraints, and crop safety.
Return a single JSON object: { "slot": ${index}, "label": "${this.prompts[index]?.label || ''}", "ratio": "${this.prompts[index]?.ratio || '1:1'}", "prompt": "..." }`,
          }),
        }, 'Prompt rewrite', 120000);
        const p = parseSlotResponse(data.data, index);
        if (window.__imgGen?.prompts[index]) window.__imgGen.prompts[index] = p;
        if (ta) { ta.value = p.prompt; ta.style.color = ''; }
        if (feedbackEl) feedbackEl.value = '';
        window.__saveCreateDraft?.();
        toastSuccess('Prompt rewritten!');
      } catch (e) {
        toastError('Rewrite failed: ' + userFacingErrorMessage(e.message));
      } finally {
        if (rewriteBtn) { rewriteBtn.disabled = false; rewriteBtn.textContent = '↺'; }
      }
    },

    // Public entry point — queues the request if something is already running
    async generateSlot(index) {
      const prompt = this.prompts[index]?.prompt?.trim();
      if (!prompt) { toastError('Prompt is empty'); return; }
      const count = Math.max(0, parseInt(document.getElementById(`gen-count-${index}`)?.value ?? '1'));
      if (count === 0) return;

      const btn = document.getElementById(`gen-btn-${index}`);
      const statusEl = document.getElementById(`gen-status-${index}`);

      if (this._genRunning) {
        // Already generating something — add to queue
        if (this._genQueue.includes(index)) return; // already queued
        this._genQueue.push(index);
        const pos = this._genQueue.length;
        if (btn) { btn.disabled = true; btn.innerHTML = `⏳ ${pos}`; }
        if (statusEl) statusEl.textContent = `⏳ Queued — position ${pos}`;
        return;
      }

      // Nothing running — execute immediately
      this._genRunning = true;
      try {
        await this._runSlot(index);
      } finally {
        this._genRunning = false;
        this._processQueue();
      }
    },

    _processQueue() {
      if (this._genQueue.length === 0 || this._genRunning) return;
      const next = this._genQueue.shift();
      // Update remaining queue positions
      this._genQueue.forEach((idx, pos) => {
        const b = document.getElementById(`gen-btn-${idx}`);
        const s = document.getElementById(`gen-status-${idx}`);
        if (b) b.innerHTML = `⏳ ${pos + 1}`;
        if (s) s.textContent = `⏳ Queued — position ${pos + 1}`;
      });
      this._genRunning = true;
      this._runSlot(next).catch(() => { }).finally(() => {
        this._genRunning = false;
        this._processQueue();
      });
    },

    async _finishGeneratedImages(index, images, prompt, skeletons = [], statusEl = null) {
      if (!this._slotImages[index]) this._slotImages[index] = [];
      const usableImages = Array.isArray(images) ? images.filter(img => img?.base64) : [];
      if (!usableImages.length) throw new Error('Image provider returned no image data');
      let anySuccess = false;
      for (const [offset, img] of usableImages.entries()) {
        img.mimeType = img.mimeType || 'image/png';
        this._slotImages[index].push(img);
        const imgIdx = this._slotImages[index].length - 1;
        const card = buildImageCard(img, index, imgIdx);
        const skel = skeletons[offset]?.skel;
        if (skel?.parentNode) skel.replaceWith(card);
        else this._ensureResultGrid(index)?.appendChild(card);
        anySuccess = true;

        try {
          img.galleryId = await saveImage({
            base64: img.base64,
            mimeType: img.mimeType,
            prompt,
            slotLabel: this.prompts[index]?.label || '',
            listingTitle: this.listingTitle || '',
            provider: img.provider,
            model: img.model,
          });
        } catch (saveErr) {
          console.warn('[image generation] Gallery save failed:', saveErr);
          if (statusEl) statusEl.textContent = `Image generated, but Gallery save failed: ${saveErr.message}`;
        }

        const uploader = window.__uploaders?.['image-uploader-wrap'];
        if (uploader && !uploader.listingId && uploader.images.length < 20) {
          try {
            const ext = img.mimeType.split('/')[1] || 'png';
            const file = base64ToFile(img.base64, img.mimeType, `listing-img-${index + 1}-${imgIdx + 1}.${ext}`);
            await uploader.handleFiles([file]);
            img.added = true;
            card.style.borderColor = 'var(--green-text,#16a34a)';
            const addButton = card.querySelector('button[title="Add to listing"]');
            if (addButton) { addButton.textContent = '✓ Added'; addButton.style.color = 'var(--green-text,#16a34a)'; addButton.disabled = true; }
          } catch (addErr) {
            console.warn('[image generation] Listing add failed:', addErr);
          }
        }
      }
      skeletons.slice(usableImages.length).forEach(({ skel, timerInterval }) => {
        clearInterval(timerInterval);
        skel?.remove();
      });
      skeletons.slice(0, usableImages.length).forEach(({ timerInterval }) => clearInterval(timerInterval));
      delete this._slotJobs[index];
      this._saveState();
      document.getElementById(`gen-results-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (anySuccess && statusEl && !statusEl.textContent.includes('failed')) {
        const uploader = window.__uploaders?.['image-uploader-wrap'];
        statusEl.textContent = uploader && !uploader.listingId
          ? 'AI image · Saved to Gallery and added to this new listing draft'
          : 'AI image · Saved to Gallery · Click + Add to attach it to the existing listing';
      }
      return anySuccess;
    },

    async _resumeSlotJob(index, saved) {
      const prompt = saved.prompt || this.prompts[index]?.prompt?.trim();
      const ratio = saved.ratio || this.prompts[index]?.ratio || '1:1';
      const count = Math.max(1, Number(saved.count) || 1);
      const timeoutMs = Number(saved.timeoutMs) || imageJobTimeoutMs(saved.provider);
      const statusEl = document.getElementById(`gen-status-${index}`);
      const btn = document.getElementById(`gen-btn-${index}`);
      if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }
      if (statusEl) statusEl.textContent = 'Resuming image generation on the server...';
      const skeletons = this._buildSkeletons(index, count, ratio);
      try {
        const jobEntries = Array.isArray(saved.jobs) && saved.jobs.length ? saved.jobs : [{ jobId: saved.jobId, index: 0 }];
        const result = await this._pollParallelImageJobs(jobEntries, timeoutMs + IMAGE_JOB_POLL_GRACE_MS, ({ job, completed, total }) => {
          if (statusEl) statusEl.textContent = job?.message || `Generating images on the server... ${completed || 0}/${total || count}`;
        });
        await this._finishGeneratedImages(index, result?.images || [], prompt, skeletons, statusEl);
      } catch (error) {
        skeletons.forEach(({ skel, timerInterval }) => { clearInterval(timerInterval); skel?.remove(); });
        delete this._slotJobs[index];
        this._saveState();
        if (statusEl) statusEl.textContent = `Error: ${userFacingErrorMessage(error.message)}`;
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '▶ Generate'; }
      }
    },

    async _runSlot(index) {
      const prompt = this.prompts[index]?.prompt?.trim();
      const ratio = this.prompts[index]?.ratio || '1:1';
      const count = Math.max(0, parseInt(document.getElementById(`gen-count-${index}`)?.value ?? '1'));
      if (!prompt) { toastError('Prompt is empty'); return; }
      if (count === 0) return;

      const statusEl = document.getElementById(`gen-status-${index}`);
      const resultsEl = document.getElementById(`gen-results-${index}`);
      const btn = document.getElementById(`gen-btn-${index}`);

      if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }
      if (!this._slotImages[index]) this._slotImages[index] = [];

      {
        const skeletons = this._buildSkeletons(index, count, ratio);
        let anySuccess = false;
        try {
          if (statusEl) statusEl.textContent = count > 1 ? `Generating ${count} images on the server...` : 'Generating image on the server...';
          const provider = localStorage.getItem('image_provider') || 'external';
          const timeoutMs = imageJobTimeoutMs(provider);
          const jobEntries = await Promise.all(Array.from({ length: count }, async (_, jobIndex) => {
            const job = await jobs.startImageGeneration({
              prompt: count > 1 ? `${prompt}\n\nCreate image ${jobIndex + 1} of ${count}. Keep the same listing context, but use a distinct composition.` : prompt,
              aspectRatio: ratio,
              count: 1,
              provider,
              referenceImage: window.__imgGenRef || undefined,
              timeoutMs,
            });
            return { jobId: job.id, index: jobIndex };
          }));
          this._slotJobs[index] = { jobs: jobEntries, prompt, ratio, count, provider, timeoutMs, status: 'running', startedAt: Date.now() };
          this._saveState();
          const result = await this._pollParallelImageJobs(jobEntries, timeoutMs + IMAGE_JOB_POLL_GRACE_MS, ({ job, completed, total }) => {
            if (statusEl) statusEl.textContent = job?.message || `Generating images on the server... ${completed || 0}/${total || count}`;
          });
          anySuccess = await this._finishGeneratedImages(index, result?.images || [], prompt, skeletons, statusEl);
        } catch (e) {
          skeletons.forEach(({ skel, timerInterval }) => { clearInterval(timerInterval); skel?.remove(); });
          delete this._slotJobs[index];
          this._saveState();
          if (statusEl) statusEl.textContent = `Error: ${userFacingErrorMessage(e.message)}`;
        } finally {
          if (!anySuccess && statusEl && !statusEl.textContent.startsWith('Error')) statusEl.textContent = '';
          if (btn) { btn.disabled = false; btn.innerHTML = '▶ Generate'; }
        }
        return;
      }

      let anySuccess = false;
      try {
        let grid = resultsEl?.querySelector('.img-gen-grid');
        if (!grid && resultsEl) {
          grid = document.createElement('div');
          grid.className = 'img-gen-grid';
          grid.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
          resultsEl.appendChild(grid);
        }
        // Clear any previous error cells before starting new generation
        if (grid) {
          Array.from(grid.children).forEach(child => {
            if (!child.querySelector('img')) child.remove();
          });
        }
        if (statusEl) statusEl.textContent = '';

        // Inject shimmer CSS once
        if (!document.getElementById('img-gen-shimmer-css')) {
          const st = document.createElement('style');
          st.id = 'img-gen-shimmer-css';
          st.textContent = '@keyframes igShimmer{0%{transform:translateX(-100%)}100%{transform:translateX(200%)}}';
          document.head.appendChild(st);
        }

        if (statusEl) statusEl.textContent = count > 1 ? `Generating ${count} images…` : '';

        // Build all skeletons upfront, then fire all requests in parallel
        const [rw, rh] = (ratio || '1:1').split(':').map(Number);
        const skelW = 160;
        const skelH = (rh && rw) ? Math.round(skelW * rh / rw) : 160;

        const slots = Array.from({ length: count }, (_, n) => {
          const timerId = `skel-t-${index}-${n}-${Date.now()}`;
          const skel = document.createElement('div');
          skel.style.cssText = `width:${skelW}px;height:${skelH}px;border-radius:8px;flex-shrink:0;position:relative;overflow:hidden;background:var(--bg-hover)`;
          skel.innerHTML = `
            <div style="position:absolute;inset:0;background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,0.13) 50%,transparent 100%);animation:igShimmer 1.6s ease-in-out infinite;will-change:transform"></div>
            <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:10px">
              <div class="spinner" style="width:18px;height:18px;border-width:2px;opacity:0.4"></div>
              <span style="font-size:10px;color:var(--text-3);text-align:center;line-height:1.4">Generating…<br><span id="${timerId}" style="opacity:0.6;font-variant-numeric:tabular-nums">0s</span></span>
            </div>`;
          if (grid) grid.appendChild(skel);

          let elapsed = 0;
          const timerInterval = setInterval(() => {
            elapsed++;
            const el = document.getElementById(timerId);
            if (el) el.textContent = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
            else clearInterval(timerInterval);
          }, 1000);

          return { skel, timerInterval };
        });

        // Fire all requests in parallel
        await Promise.allSettled(slots.map(async ({ skel, timerInterval }) => {
          try {
            const provider = localStorage.getItem('image_provider') || 'external';
            const timeoutMs = imageJobTimeoutMs(provider);
            const job = await jobs.startImageGeneration({
              prompt,
              aspectRatio: ratio,
              count: 1,
              provider,
              referenceImage: window.__imgGenRef || undefined,
              timeoutMs,
            });
            const data = await pollStandaloneImageJob(job.id, timeoutMs + IMAGE_JOB_POLL_GRACE_MS);

            clearInterval(timerInterval);
            const img = data.images?.[0];
            if (img?.base64) {
              img.mimeType = img.mimeType || 'image/png';
              this._slotImages[index].push(img);
              const imgIdx = this._slotImages[index].length - 1;
              skel.replaceWith(buildImageCard(img, index, imgIdx));
              anySuccess = true;
              document.getElementById(`gen-results-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

              // Persist every successful result before considering it complete.
              // Saving and adding to the listing are independent: one failure must
              // not make the generated card disappear or prevent the other action.
              try {
                img.galleryId = await saveImage({
                  base64: img.base64,
                  mimeType: img.mimeType,
                  prompt,
                  slotLabel: this.prompts[index]?.label || '',
                  listingTitle: this.listingTitle || '',
                  provider: img.provider,
                  model: img.model,
                });
              } catch (saveErr) {
                console.warn('[image generation] Gallery save failed:', saveErr);
                if (statusEl) statusEl.textContent = `Image generated, but Gallery save failed: ${saveErr.message}`;
              }

              // Create Listing generations should immediately be visible in the
              // actual listing uploader (the previous extra "+ Add" click was easy
              // to miss after the progress indicator disappeared).
              const uploader = window.__uploaders?.['image-uploader-wrap'];
              // New listing drafts have no Etsy listingId yet, so attaching here is
              // local and safe. Existing listings require the explicit "+ Add"
              // confirmation because ImageUploader uploads immediately when it has
              // a listingId.
              if (uploader && !uploader.listingId && uploader.images.length < 20) {
                try {
                  const ext = img.mimeType.split('/')[1] || 'png';
                  const file = base64ToFile(img.base64, img.mimeType, `listing-img-${index + 1}-${imgIdx + 1}.${ext}`);
                  await uploader.handleFiles([file]);
                  img.added = true;
                  const card = document.querySelector(`#gen-results-${index} .img-gen-grid`)?.lastElementChild;
                  if (card) {
                    card.style.borderColor = 'var(--green-text,#16a34a)';
                    const addButton = card.querySelector('button[title="Add to listing"]');
                    if (addButton) { addButton.textContent = '✓ Added'; addButton.style.color = 'var(--green-text,#16a34a)'; addButton.disabled = true; }
                  }
                } catch (addErr) {
                  console.warn('[image generation] Listing add failed:', addErr);
                }
              }
            } else {
              throw new Error('Image provider returned no image data');
            }
          } catch (e) {
            clearInterval(timerInterval);
            skel.remove();
            if (statusEl) statusEl.textContent = `Error: ${userFacingErrorMessage(e.message)}`;
          }
        }));
      } finally {
        if (anySuccess && statusEl && !statusEl.textContent.includes('failed')) {
          const uploader = window.__uploaders?.['image-uploader-wrap'];
          statusEl.textContent = uploader && !uploader.listingId
            ? 'AI image · Saved to Gallery and added to this new listing draft'
            : 'AI image · Saved to Gallery · Click + Add to attach it to the existing listing';
        }
        else if (!anySuccess && statusEl && !statusEl.textContent.startsWith('Error')) statusEl.textContent = '';
        if (btn) { btn.disabled = false; btn.innerHTML = '▶ Generate'; }
      }
    },

    async addToListing(slotIndex, imgIndex, cardEl, addBtnEl) {
      const img = this._slotImages[slotIndex]?.[imgIndex];
      if (!img) { toastError('Image not found'); return; }

      const uploader = window.__uploaders?.['image-uploader-wrap'];
      if (!uploader) {
        toastError('Open the listing form — Images section must be visible');
        return;
      }

      const MAX = 20;
      if (uploader.images.length >= MAX) {
        toastError(`Listing already has ${MAX} images (Etsy maximum). Remove one first.`);
        return;
      }

      try {
        if (addBtnEl) { addBtnEl.disabled = true; addBtnEl.textContent = '…'; }
        const ext = img.mimeType.split('/')[1] || 'png';
        const file = base64ToFile(img.base64, img.mimeType, `listing-img-${slotIndex + 1}-${imgIndex + 1}.${ext}`);
        await uploader.handleFiles([file]);

        // Mark as added so the state persists if panel re-renders
        if (this._slotImages[slotIndex]?.[imgIndex]) this._slotImages[slotIndex][imgIndex].added = true;
        this._saveState();
        if (cardEl) cardEl.style.borderColor = 'var(--green-text,#16a34a)';
        if (addBtnEl) { addBtnEl.textContent = '✓ Added'; addBtnEl.style.color = 'var(--green-text,#16a34a)'; addBtnEl.disabled = true; }
        toastSuccess('Image added to listing!');
      } catch (e) {
        if (addBtnEl) { addBtnEl.disabled = false; addBtnEl.textContent = '+ Add'; }
        toastError('Could not add image: ' + e.message);
      }
    },
  };
  window.__imgGen._renderSavedImages();
  window.__imgGen._resumeSavedJobs();
}

function makeImageFilename(slotIndex, imgIndex, ext) {
  const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'of', 'in', 'on', 'at', 'to', 'with', 'by', 'from', 'is', 'it', 'its', 'this', 'that']);
  function wordSlug(str, maxWords) {
    const words = str.toLowerCase().replace(/[^a-z0-9\s]+/g, '').trim().split(/\s+/).filter(Boolean);
    const kept = words.filter(w => !STOP.has(w)).slice(0, maxWords);
    return (kept.length ? kept : words.slice(0, maxWords)).join('-') || 'image';
  }
  const title = wordSlug(window.__imgGen?.listingTitle || '', 4);
  const label = wordSlug(window.__imgGen?.prompts?.[slotIndex]?.label || `slot-${slotIndex + 1}`, 2);
  return `${title}-${label}-${imgIndex + 1}.${ext}`;
}

function openImagePreview(dataUrl, img, slotIndex, imgIndex, card) {
  const ext = img.mimeType.split('/')[1] || 'png';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const imgEl2 = document.createElement('img');
  imgEl2.src = dataUrl;
  imgEl2.style.cssText = 'max-width:min(90vw,700px);max-height:75vh;object-fit:contain;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,0.6)';
  overlay.appendChild(imgEl2);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:10px;align-items:stretch';

  const btnBase = 'display:flex;align-items:center;justify-content:center;padding:9px 20px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;text-decoration:none;border:1px solid;box-sizing:border-box;';

  const dlBtn = document.createElement('a');
  dlBtn.href = dataUrl;
  dlBtn.download = makeImageFilename(slotIndex, imgIndex, ext);
  dlBtn.textContent = '↓ Download';
  dlBtn.style.cssText = btnBase + 'background:rgba(255,255,255,0.15);color:#fff;border-color:rgba(255,255,255,0.3);';

  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add to listing';
  addBtn.style.cssText = btnBase + 'background:var(--orange,#f97316);color:#fff;border-color:var(--orange,#f97316);';
  addBtn.onclick = async () => {
    addBtn.disabled = true; addBtn.textContent = '…';
    await window.__imgGen?.addToListing(slotIndex, imgIndex, card, addBtn);
    // Mirror the add-state back to the card in the slot grid
    if (card) card.style.borderColor = 'var(--green-text)';
    overlay.remove();
  };

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ Close';
  closeBtn.style.cssText = btnBase + 'background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.8);border-color:rgba(255,255,255,0.25);';
  closeBtn.onclick = () => overlay.remove();

  actions.append(dlBtn, addBtn, closeBtn);
  overlay.appendChild(actions);

  if (img.provider || img.model) {
    const providerStr = img.provider === 'external'
      ? `external${img.model ? ` (${img.model})` : ''}`
      : (img.provider || 'gemini') + (img.model ? ` (${img.model})` : '');
    const attrEl = document.createElement('div');
    attrEl.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.75);background:rgba(0,0,0,0.6);padding:4px 10px;border-radius:6px;word-break:break-all';
    attrEl.textContent = `Provider: ${providerStr}`;
    overlay.appendChild(attrEl);
  }

  document.body.appendChild(overlay);

  const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('remove', () => document.removeEventListener('keydown', onKey));
}

function buildImageCard(img, slotIndex, imgIndex) {
  const dataUrl = `data:${img.mimeType};base64,${img.base64}`;
  const card = document.createElement('div');
  const borderColor = img.added ? 'var(--green-text,#16a34a)' : 'var(--border)';
  card.style.cssText = `position:relative;border-radius:8px;overflow:hidden;border:2px solid ${borderColor};transition:border-color 0.15s;flex-shrink:0;cursor:zoom-in`;

  const imgEl = document.createElement('img');
  imgEl.src = dataUrl;
  imgEl.style.cssText = 'width:140px;height:140px;object-fit:cover;display:block';
  card.appendChild(imgEl);

  // Hover hint overlay
  const hint = document.createElement('div');
  hint.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.15s;pointer-events:none';
  hint.innerHTML = '<span style="color:#fff;font-size:20px">⤢</span>';
  card.appendChild(hint);
  card.onmouseenter = () => { hint.style.opacity = '1'; };
  card.onmouseleave = () => { hint.style.opacity = '0'; };

  // Click image → fullscreen preview with action buttons
  imgEl.onclick = () => openImagePreview(dataUrl, img, slotIndex, imgIndex, card);
  hint.style.pointerEvents = 'none'; // pass clicks through to imgEl

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:1px;background:rgba(0,0,0,0.65)';

  const dlBtn = document.createElement('a');
  dlBtn.title = 'Download';
  dlBtn.textContent = '↓';
  dlBtn.href = dataUrl;
  dlBtn.download = makeImageFilename(slotIndex, imgIndex, img.mimeType.split('/')[1] || 'png');
  dlBtn.style.cssText = 'flex:1;background:none;border:none;color:#fff;font-size:14px;padding:4px 0;cursor:pointer;text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center';

  const addBtn = document.createElement('button');
  addBtn.title = 'Add to listing';
  addBtn.style.cssText = 'flex:3;background:none;border:none;color:#fff;font-size:11px;font-weight:600;padding:4px 6px;cursor:pointer;white-space:nowrap';
  if (img.added) {
    addBtn.textContent = '✓ Added';
    addBtn.style.color = 'var(--green-text,#16a34a)';
    addBtn.disabled = true;
  } else {
    addBtn.textContent = '+ Add';
    addBtn.onclick = () => window.__imgGen.addToListing(slotIndex, imgIndex, card, addBtn);
  }

  const refBtn = document.createElement('button');
  refBtn.title = 'Use as reference for next generation';
  refBtn.textContent = '⊕ Ref';
  refBtn.style.cssText = 'flex:2;background:none;border:none;color:rgba(255,255,255,0.7);font-size:10px;padding:4px 4px;cursor:pointer;white-space:nowrap';
  refBtn.onclick = (e) => {
    e.stopPropagation();
    window.__imgGenRef = { base64: img.base64, mimeType: img.mimeType };
    // Update global reference indicator
    const ind = document.getElementById('img-gen-ref-indicator');
    if (ind) { ind.style.display = ''; ind.textContent = '🖼 Reference set ✕'; }
    import('./toast.js').then(m => m.toastSuccess('Reference image set for next generation'));
    // Highlight this card
    card.style.outline = '2px solid var(--orange,#f97316)';
    card.style.outlineOffset = '2px';
  };

  bar.append(dlBtn, addBtn, refBtn);
  card.appendChild(bar);

  if (img.provider || img.model) {
    const attr = document.createElement('details');
    attr.style.cssText = 'font-size:9px;color:rgba(255,255,255,0.7);background:rgba(0,0,0,0.85);padding:1px 4px;line-height:1.2;cursor:pointer;user-select:none;border-top:1px solid rgba(255,255,255,0.1)';
    const providerStr = img.provider === 'external'
      ? `external${img.model ? ` (${img.model})` : ''}`
      : (img.provider || 'gemini') + (img.model ? ` (${img.model})` : '');
    attr.innerHTML = `<summary style="outline:none">AI Provider</summary><div style="word-break:break-all;padding:2px 0;color:rgba(255,255,255,0.9)">${providerStr}</div>`;
    card.appendChild(attr);
  }

  return card;
}

// Reference image state — persists across slot generations until cleared
if (typeof window !== 'undefined') {
  window.__imgGenRef = null;
}

function renderSlot(p, i) {
  const slot = SLOT_TEMPLATES[i] || { desc: '' };
  return `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px 14px;margin-bottom:8px" id="slot-card-${i}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span class="badge badge-gray" style="font-size:11px;min-width:20px;text-align:center">${i + 1}</span>
        <span style="font-size:13px;font-weight:600">${escHtml(p.label)}</span>
        <span class="badge badge-orange" style="font-size:10px">${p.ratio}</span>
        <span style="font-size:11px;color:var(--text-3);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml((slot.desc.split('\n')[0] || '').slice(0, 60))}</span>
        <button id="gen-btn-${i}" class="btn btn-primary btn-sm" style="white-space:nowrap;padding:4px 12px"
          onclick="window.__imgGen.generateSlot(${i})">▶ Generate</button>
        <div style="display:flex;align-items:center;gap:4px">
          <span style="font-size:10px;color:var(--text-3)">×</span>
          <input type="number" id="gen-count-${i}" value="1" min="0" max="4"
            style="width:36px;font-size:11px;padding:2px 3px;text-align:center">
        </div>
      </div>

      <!-- Collapsible prompt section -->
      <div id="prompt-section-${i}" style="display:none;margin-top:8px">
        <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:flex-start;margin-bottom:6px">
          <div style="position:relative">
            <textarea id="prompt-ta-${i}" rows="3"
              style="font-size:12px;font-family:inherit;resize:vertical;line-height:1.5;width:100%;box-sizing:border-box;padding-bottom:24px"
              oninput="window.__imgGen.updatePrompt(${i}, this.value)">${escHtml(p.prompt)}</textarea>
            <button title="Copy prompt"
              style="position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,0.12);border:none;border-radius:3px;padding:2px 7px;font-size:12px;cursor:pointer;color:var(--text-2,#555);line-height:1.4;backdrop-filter:blur(2px)"
              onclick="window.__copyPrompt(${i}, this)">⎘ Copy</button>
            <button title="Copy prompt &amp; open in Gemini Web for image generation"
              style="position:absolute;bottom:6px;left:60px;background:rgba(66,133,244,0.15);border:none;border-radius:3px;padding:2px 7px;font-size:12px;cursor:pointer;color:#4285f4;line-height:1.4;backdrop-filter:blur(2px);font-weight:600"
              onclick="window.__openInGemini(${i})">G ↗</button>
          </div>
        </div>
        <div style="position:relative;margin-bottom:6px">
          <input id="feedback-${i}" type="text"
            placeholder="Tell AI what to change in the prompt…"
            style="font-size:11px;padding:6px 72px 6px 10px;width:100%;box-sizing:border-box"
            onkeydown="if(event.key==='Enter')window.__imgGen.rewriteSlot(${i})">
          <button id="rewrite-btn-${i}"
            style="position:absolute;right:3px;top:50%;transform:translateY(-50%);background:var(--orange,#f97316);color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap"
            onclick="window.__imgGen.rewriteSlot(${i})">↺ Rewrite</button>
        </div>
      </div>

      <!-- Compact prompt toggle line -->
      <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
        <button onclick="window.__imgGenToggleSlot(${i})" id="toggle-btn-${i}"
          style="background:none;border:none;padding:0;font-size:11px;color:var(--text-3);cursor:pointer;text-decoration:underline dotted"
          title="Show/hide prompt editor">Show prompt</button>
        <button title="Copy prompt" style="background:none;border:none;padding:0;font-size:11px;color:var(--text-3);cursor:pointer"
          onclick="window.__copyPrompt(${i}, this)">⎘ Copy</button>
        <button title="Open in Gemini" style="background:none;border:none;padding:0;font-size:11px;color:#4285f4;cursor:pointer;font-weight:600"
          onclick="window.__openInGemini(${i})">G ↗</button>
        <span id="prompt-status-${i}" style="font-size:10px;color:var(--text-3);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      </div>

      <div id="gen-status-${i}" style="font-size:11px;color:var(--text-3);min-height:14px;margin-top:4px"></div>
      <div id="gen-results-${i}"></div>
    </div>`;
}

// Toggle individual slot expansion
function toggleSlotExpand(index) {
  const section = document.getElementById(`prompt-section-${index}`);
  const btn = document.getElementById(`toggle-btn-${index}`);
  if (!section) return;
  const hidden = section.style.display === 'none';
  section.style.display = hidden ? '' : 'none';
  if (btn) btn.textContent = hidden ? 'Hide prompt' : 'Show prompt';
}
if (typeof window !== 'undefined') {
  window.__imgGenToggleSlot = toggleSlotExpand;
}

// Update compact prompt status indicator
function updatePromptStatus(index, text) {
  const el = document.getElementById(`prompt-status-${index}`);
  if (el) el.textContent = text ? `✓ ${text.slice(0, 50)}…` : '';
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Clipboard helper — tries modern API, falls back to execCommand
function copyPrompt(slotIndex, btn) {
  const text = document.getElementById(`prompt-ta-${slotIndex}`)?.value || '';
  if (!text) return;
  const done = () => { btn.textContent = '✓ Copied'; setTimeout(() => btn.textContent = '⎘ Copy', 1500); };
  const fail = () => {
    // execCommand fallback
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = '✗ Failed'; setTimeout(() => btn.textContent = '⎘ Copy', 1500); }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fail);
  } else { fail(); }
}
if (typeof window !== 'undefined') {
  window.__copyPrompt = copyPrompt;
}

// Load an uploaded file as the reference image
function loadImageGenerationReference(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const [header, base64] = dataUrl.split(',');
    const mimeType = header.match(/:(.*?)(?:;|$)/)?.[1] || file.type || 'image/jpeg';
    window.__imgGenRef = { base64, mimeType };
    const ind = document.getElementById('img-gen-ref-indicator');
    if (ind) { ind.style.display = ''; ind.textContent = `🖼 ${file.name} ✕`; }
    import('./toast.js').then(m => m.toastSuccess('Reference image loaded'));
  };
  reader.readAsDataURL(file);
  input.value = '';
}
if (typeof window !== 'undefined') {
  window.__imgGenLoadRef = loadImageGenerationReference;
}

export function hasSavedPrompts() { return false; }

export async function generateCoverPrompt(description, provider = localStorage.getItem('ai_provider') || 'external') {
  const prompts = await fetchBatch([0], description, provider, '').catch(() => []);
  const coverPrompt = prompts[0]?.prompt;
  if (!coverPrompt) throw new Error('Failed to generate cover prompt');
  return coverPrompt;
}

// Open prompt in Gemini Web — copies to clipboard and opens gemini.google.com/app
function openPromptInGemini(slotIndex) {
  const text = document.getElementById(`prompt-ta-${slotIndex}`)?.value?.trim();
  if (!text) { import('./toast.js').then(m => m.toastError('Prompt is empty')); return; }
  const copy = () => {
    window.open('https://gemini.google.com/app', '_blank');
    import('./toast.js').then(m => m.toastSuccess('✓ Prompt copied — paste in Gemini and select Image generation'));
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(copy).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); } catch { }
      document.body.removeChild(ta);
      copy();
    });
  } else { copy(); }
}
if (typeof window !== 'undefined') {
  window.__openInGemini = openPromptInGemini;
}

async function pollStandaloneImageJob(jobId, timeoutMs = 150000, onProgress = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const job = await jobs.getStatus(jobId);
    onProgress?.(job);
    if (job?.status === 'done') return job.result;
    if (job?.status === 'error') throw new Error(userFacingErrorMessage(job.error || 'Image generation failed'));
  }
  throw new Error(`Image generation timed out after ${Math.round(timeoutMs / 1000)}s`);
}

export async function generateCoverImageInBackground(description, title = '', provider = localStorage.getItem('ai_provider') || 'external', onProgress = null) {
  try {
    onProgress?.('Writing Etsy-safe cover prompt…');
    // Fetch slot 0 prompt directly. A separate style-card call made automatic
    // cover generation feel endless and its result was not actually used here.
    const coverPrompt = await generateCoverPrompt(description, provider);

    onProgress?.('Generating the cover image…');
    const imageProvider = localStorage.getItem('image_provider') || 'external';
    const timeoutMs = imageJobTimeoutMs(imageProvider);
    const job = await jobs.startImageGeneration({
      prompt: coverPrompt,
      aspectRatio: '1:1',
      count: 1,
      provider: imageProvider,
      timeoutMs,
    });
    const data = await pollStandaloneImageJob(job.id, timeoutMs + IMAGE_JOB_POLL_GRACE_MS, (jobState) => {
      if (jobState?.message) onProgress?.(jobState.message);
    });

    const img = data.images?.[0];
    if (!img) throw new Error('No image returned');

    // Convert base64 to File
    const ext = img.mimeType.split('/')[1] || 'png';
    const file = base64ToFile(img.base64, img.mimeType, `cover-${Date.now()}.${ext}`);

    onProgress?.('Saving generated cover to Gallery…');
    // Persist before reporting success. Previously this failure was swallowed,
    // so the progress UI could finish even though Gallery had no result.
    await saveImage({
      base64: img.base64,
      mimeType: img.mimeType,
      prompt: coverPrompt,
      slotLabel: 'Cover',
      listingTitle: title,
    });

    return file;
  } catch (err) {
    console.error('[generateCoverImageInBackground]', err);
    throw err;
  }
}
