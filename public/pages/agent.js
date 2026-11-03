// public/pages/agent.js — AI Agent main page + shared chat state

import { toastSuccess, toastError } from '../components/toast.js';
import { get, set, getOrFetch, invalidate } from '../utils/store.js';
import { etsy, fetchJsonWithTimeout, jobs, kv, readJsonResponse, userFacingErrorMessage } from '../utils/api.js';
import { viewOnEtsyButton, listingDestinationUrl } from '../components/view-on-etsy-button.js';
import { saveScheduledPost, getScheduledPosts, deleteScheduledPost, generateId } from '../utils/schedule-store.js';
import { saveImage, getImage } from '../utils/image-store.js';
import { history as idbHistory } from '../utils/idb.js';
import { renderAgentMarkdown as md, renderListingThumbnails, extractListingThumbnailRows, stripListingThumbnailMetadata, formatAgentMessageForCopy, getPlanUpdateFields, getPlanUpdateChangeDetails, normalizePlanUpdate, listingWriteFields, formatPlanValue, shortValue } from '../utils/agent-format.js';
import { agentDraftHistorySnapshot, extractDuplicateListingId, latestDuplicateResultFromMessages, mergeAgentDraftSnapshots, persistAgentDraftInHistory, sameAgentDraftWorkflow } from '../utils/agent-history.js';
import { actionCardState, wireActionCard } from '../utils/action-card.js';
import { DEFAULT_MODELS } from '../utils/models.js';
import { agentProgressElapsedMs, formatAgentProgress } from '../utils/agent-progress.js';
import { normalizeMediaUrl } from '../utils/media-url.js';
import { agentModelConversation, agentRuntimeUserMessage, classifyAgentRuntimeError, createAgentRuntimeFault, listingWorkflowSnapshot, validateListingImageTransition } from '../utils/agent-runtime-contract.js';
import { scopedClientKey } from '../utils/user-scope.js';
import { buildDraftVariations, draftVariationsToInventoryPayload } from '../utils/etsy-variations.js';
import { agentHistoryPanelPresentation, agentMemoryPanelsPresentation } from '../utils/agent-panel-view-model.js';
import { createAgentVariationCardView } from '../utils/agent-variation-card-view.js';
import {
  agentAttachmentPresentation,
  agentDebugTracePresentation,
  agentLoadingMarkup,
  agentMessageRolePresentation,
  agentShellMarkup,
  agentSuggestionChipsMarkup,
  agentWelcomeMarkup,
} from '../utils/agent-chat-view-model.js';

const PLATFORM_ASPECT = { instagram: '1/1', pinterest: '2/3', facebook: '1.91/1', tiktok: '9/16' };

// ── Shared conversation state ──────────────────────────────
// sessionStorage: fast sync access within same tab
// IDB: persists across tab closes / browser restarts, one key per session
const HISTORY_KEY    = 'agent_history';    // sessionStorage cache for current tab
const SESSIONS_KEY   = 'agent_sessions';   // IDB: [{id, created_at, last_at, preview}]
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000; // 24 h → start fresh
const MAX_AGENT_MESSAGES = 60;
const MAX_AGENT_REQUEST_MESSAGES = 40;
const LAST_AGENT_DRAFT_KEY = 'agent_last_created_draft';
const LAST_AGENT_LISTING_TARGET_KEY = 'agent_last_target_listing';
const ACTIVE_AGENT_TURN_KEY = 'agent_active_turn';
const AGENT_RESPONSE_TIMEOUT_MS = 240000;
const AGENT_UI_RUNTIME_ID = `agent_ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const agentSessionStorage = {
  getItem: key => sessionStorage.getItem(scopedClientKey(key)),
  setItem: (key, value) => sessionStorage.setItem(scopedClientKey(key), value),
  removeItem: key => sessionStorage.removeItem(scopedClientKey(key)),
};

let _currentSessionId = null;
let _activeAgentTurn = loadActiveAgentTurn();
const _activeAgentTurnListeners = new Set();

function loadActiveAgentTurn() {
  try {
    const turn = JSON.parse(agentSessionStorage.getItem(ACTIVE_AGENT_TURN_KEY) || 'null');
    if (!turn?.id || !turn?.session_id) return null;
    return { ...turn, runtime_active: false };
  } catch {
    return null;
  }
}

function saveActiveAgentTurn(turn) {
  _activeAgentTurn = turn || null;
  try {
    if (turn) agentSessionStorage.setItem(ACTIVE_AGENT_TURN_KEY, JSON.stringify(turn));
    else agentSessionStorage.removeItem(ACTIVE_AGENT_TURN_KEY);
  } catch {}
}

function notifyActiveAgentTurn(change) {
  for (const listener of _activeAgentTurnListeners) listener(change);
}

function startActiveAgentTurn(text, hasImage, ownerInstanceId = '') {
  const turn = {
    id: `job_agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
    session_id: _currentSessionId,
    text: String(text || '').slice(0, 500),
    has_image: Boolean(hasImage),
    started_at: Date.now(),
    stage: hasImage ? 'Analyzing attached image' : 'Working on your request',
    owner_instance_id: ownerInstanceId,
    runtime_active: true,
  };
  saveActiveAgentTurn(turn);
  notifyActiveAgentTurn({ type: 'started', turn });
  return turn;
}

function updateActiveAgentTurn(turnId, event) {
  if (_activeAgentTurn?.id !== turnId) return;
  const message = event?.message || event?.name || event?.model || event?.provider || _activeAgentTurn.stage;
  const next = { ..._activeAgentTurn, stage: String(message || 'Working on your request').slice(0, 240), progress: event || null, progress_at: Date.now() };
  saveActiveAgentTurn(next);
  notifyActiveAgentTurn({ type: 'progress', turn: next });
}

function finishActiveAgentTurn(turnId) {
  if (_activeAgentTurn?.id !== turnId) return;
  const turn = _activeAgentTurn;
  saveActiveAgentTurn(null);
  notifyActiveAgentTurn({ type: 'finished', turn });
}

export function rememberLatestAgentDraft(draft) {
  if (!draft?.generated) return;
  window.__lastAgentDraft = draft;
  window.__lastAgentDraftSessionId = _currentSessionId || '';
  try { agentSessionStorage.setItem(`${LAST_AGENT_DRAFT_KEY}:${_currentSessionId || 'unassigned'}`, JSON.stringify(draft)); } catch {}
}

export function getLatestAgentDraft() {
  if (window.__lastAgentDraft?.generated && window.__lastAgentDraftSessionId === (_currentSessionId || '')) return window.__lastAgentDraft;
  try {
    const draft = JSON.parse(agentSessionStorage.getItem(`${LAST_AGENT_DRAFT_KEY}:${_currentSessionId || 'unassigned'}`) || 'null');
    if (draft?.generated) {
      window.__lastAgentDraft = draft;
      window.__lastAgentDraftSessionId = _currentSessionId || '';
      return draft;
    }
  } catch {}
  return null;
}

function currentDraftForWorkflow(originalDraft, messageIndex = -1) {
  let resolved = originalDraft;
  const current = getLatestAgentDraft();
  if (current?.generated && sameAgentDraftWorkflow(originalDraft, current)) {
    resolved = mergeAgentDraftSnapshots(resolved, current);
  }
  const historyDraft = agentMessages[messageIndex]?.pending_generate_listing?.agent_draft;
  if (historyDraft?.generated && sameAgentDraftWorkflow(originalDraft, historyDraft)) {
    resolved = mergeAgentDraftSnapshots(resolved, historyDraft);
  }
  return resolved;
}

function persistCurrentAgentDraft(draft, messageIndex = -1) {
  rememberLatestAgentDraft(draft);
  persistAgentDraftInHistory(agentMessages, draft, messageIndex);
  saveHistory(agentMessages);
  return draft;
}

window.__agentMarkImagesAttached = workflowId => {
  const draft = getLatestAgentDraft();
  if (!draft?.generated) return false;
  if (workflowId && draft.workflow_id && String(workflowId) !== String(draft.workflow_id)) return false;
  persistCurrentAgentDraft({ ...draft, workflow_state: 'images_attached' });
  return true;
};

function normalizeAgentListingTarget(input = {}) {
  const id = input.listing_id || input.id || input.source_listing_id;
  if (!id) return null;
  return {
    listing_id: Number(id),
    listing_title: input.listing_title || input.title || input.source_title || `Listing ${id}`,
    title: input.title || input.listing_title || input.source_title || `Listing ${id}`,
    state: input.state || input.listing_state || input.source_state || 'active',
    image_url: input.image_url || input.listing_image_url || input.thumbnail || null,
    etsy_url: input.etsy_url || input.url || null,
    url: input.url || input.etsy_url || null,
  };
}

function rememberAgentListingTarget(target) {
  const normalized = normalizeAgentListingTarget(target);
  if (!normalized) return null;
  window.__lastAgentListingTarget = normalized;
  try { agentSessionStorage.setItem(LAST_AGENT_LISTING_TARGET_KEY, JSON.stringify(normalized)); } catch {}
  return normalized;
}

function getRememberedAgentListingTarget() {
  const existing = normalizeAgentListingTarget(window.__lastAgentListingTarget || {});
  if (existing) return existing;
  try {
    const parsed = JSON.parse(agentSessionStorage.getItem(LAST_AGENT_LISTING_TARGET_KEY) || 'null');
    const normalized = normalizeAgentListingTarget(parsed || {});
    if (normalized) {
      window.__lastAgentListingTarget = normalized;
      return normalized;
    }
  } catch {}
  return null;
}

function clearRememberedAgentListingTarget() {
  delete window.__lastAgentListingTarget;
  try { agentSessionStorage.removeItem(LAST_AGENT_LISTING_TARGET_KEY); } catch {}
}

function clearLatestAgentDraft() {
  delete window.__lastAgentDraft;
  delete window.__lastAgentDraftSessionId;
  try { agentSessionStorage.removeItem(`${LAST_AGENT_DRAFT_KEY}:${_currentSessionId || 'unassigned'}`); } catch {}
}

function restoreLatestAgentDraftFromMessages(messages = agentMessages) {
  delete window.__lastAgentDraft;
  delete window.__lastAgentDraftSessionId;
  const saved = [...(messages || [])].reverse()
    .map(message => message?.pending_generate_listing?.agent_draft)
    .find(draft => draft?.generated);
  if (saved) rememberLatestAgentDraft(saved);
  return saved || null;
}

function currentAgentDraftContext() {
  const draft = getLatestAgentDraft();
  if (!draft?.generated) return null;
  return {
    title: draft.generated.title || '',
    description: String(draft.generated.description || draft.description || '').slice(0, 1200),
    tags: Array.isArray(draft.generated.tags) ? draft.generated.tags.slice(0, 13) : [],
    listing_type: draft.listingType || draft.generated.listing_type || '',
    price: draft.price || draft.generated.price_suggestion || '',
    has_reference_image: Boolean(draft.referenceImage?.base64 && draft.referenceImage?.mimeType),
    has_attached_images: Array.isArray(draft.attachedImages) && draft.attachedImages.length > 0,
    created_at: draft.createdAt || null,
    workflow_id: draft.workflow_id || null,
    workflow_state: draft.workflow_state || (draft.generated ? 'listing_draft_ready' : null),
  };
}

export function scheduleDraftImageQuickGenerate() {
  let opened = false;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (!opened && typeof window.openImagePrompt === 'function') {
      opened = true;
      try { window.openImagePrompt(); } catch {}
    }
    if (window.__imgGen?.quickGenerate) {
      clearInterval(timer);
      try { window.__imgGen.quickGenerate(); } catch {}
    } else if (attempts >= 20) {
      clearInterval(timer);
    }
  }, 250);
}

export async function executeDraftImageActionFromAgent(actionInput = {}) {
  if (String(actionInput?.action || '') !== 'open_image_generator') return false;
  clearLatestPendingListingImagePlan();
  const currentPage = (window.location.hash || '#dashboard').replace(/^#/, '').split(/[?&]/)[0] || 'dashboard';
  if (currentPage === 'create') {
    scheduleDraftImageQuickGenerate();
    return true;
  }
  const latestDraft = getLatestAgentDraft();
  if (!latestDraft?.generated) return false;
  const draftForImages = { ...latestDraft, generateImages: true };
  rememberLatestAgentDraft(draftForImages);
  await navigateToAgentDraftCreate(draftForImages);
  scheduleDraftImageQuickGenerate();
  return true;
}

function waitForDomNode(selector, timeoutMs = 8000) {
  const existing = document.querySelector(selector);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = document.querySelector(selector);
      if (found || Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(found || null);
      }
    }, 100);
  });
}

async function navigateToAgentDraftCreate(agentDraft) {
  if (typeof window.navigate !== 'function') return false;
  let expectedDraftRevision = 0;
  let replaceServerDraft = false;
  try {
    const payload = await fetchJsonWithTimeout(
      '/api/drafts?action=get&key=create_draft',
      { method: 'GET', headers: draftShopHeader(), timeoutMs: 10_000 },
      'Listing draft read',
      10_000,
    );
    const saved = payload?.data;
    expectedDraftRevision = Number(saved?.revision) || 0;
    const savedTitle = String(saved?.title || saved?.generated?.title || '').trim();
    const nextTitle = String(agentDraft?.generated?.title || '').trim();
    const sameWorkflow = saved?.workflow_id && agentDraft?.workflow_id
      && String(saved.workflow_id) === String(agentDraft.workflow_id);
    const sameDraftId = saved?.draft_id && agentDraft?.draft_id
      && String(saved.draft_id) === String(agentDraft.draft_id);
    if (saved && (sameWorkflow || sameDraftId)) {
      await window.navigate('create', { restoreDraft: true });
      return Boolean(await waitForDomNode('#e-title', 6000));
    }
    if (saved) {
      const replace = window.confirm(`A different listing draft is already saved: "${savedTitle.slice(0, 100)}". Replace it with "${nextTitle.slice(0, 100)}"?`);
      if (!replace) return false;
      replaceServerDraft = true;
    }
  } catch (error) {
    console.warn('[agent draft navigation] could not verify current server draft:', error?.message || error);
    return false;
  }
  const createParams = { agentDraft, expectedDraftRevision, replaceServerDraft };
  await window.navigate('create', createParams);
  if (await waitForDomNode('#e-title', 6000)) return true;
  await window.navigate('create', createParams);
  return Boolean(await waitForDomNode('#e-title', 6000));
}

function _genSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function _sessionKey(id) { return `agent_session_${id}`; }

function isSyntheticUpdateResult(msg) {
  const text = String(msg?.content || '');
  return msg?.role === 'assistant' && /^Updated \d+\/\d+ listings\. \d+ failed — check DevTools for details\.$/.test(text);
}

function normalizeActionPersonalizationQuestions(questions) {
  return Array.isArray(questions) ? questions.map(q => {
    const next = { ...q };
    if (next.question_type === 'file_upload') {
      const labels = Array.isArray(next.options)
        ? next.options.map(o => ({ label: String(o.label || o || '').replace(/\s*\([^)]*\)\s*/g, '').trim().slice(0, 20) })).filter(o => o.label)
        : [];
      if (labels.length) {
        next.options = labels;
        next.max_allowed_files = labels.length;
      } else {
        delete next.options;
        next.max_allowed_files = 10;
      }
    }
    return next;
  }) : questions;
}

function clampEtsyTitle(value, max = 140) {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim();
  return title.length > max ? title.slice(0, max).trim() : title;
}

function normalizeDuplicateProposal(dup = {}) {
  return {
    ...dup,
    ...(dup.title !== undefined ? { title: clampEtsyTitle(dup.title) } : {}),
    ...(Array.isArray(dup.personalization_questions) ? { personalization_questions: normalizeActionPersonalizationQuestions(dup.personalization_questions) } : {}),
  };
}

function stripEmbeddedImagePayloads(value = '') {
  return String(value || '')
    .replace(/!\[[^\]\n]*\]\(\s*data:image\/[^)\s]+[^)]*\)/gi, '[image omitted]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]{80,}/gi, '[image data omitted]')
    .replace(/!\[[^\]\n]*\]\(\s*\[image data omitted\]\s*\)?/gi, '[image omitted]')
    .replace(/!\[[^\]\n]*\]\(\s*\[image omitted\]\s*\)?/gi, '[image omitted]')
    .replace(/!\[[^\]\n]*\]\(\s*blob:[^)]+\)/gi, '[image omitted]')
    .replace(/\[image data omitted\]/gi, '[image omitted]')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeImagePromptText(value = '', max = 4000) {
  return stripEmbeddedImagePayloads(value).slice(0, max).trim();
}

function cleanUiCopy(copy = {}) {
  const out = {};
  if (!copy || typeof copy !== 'object') return out;
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === 'string' && value.trim()) {
      out[key] = stripEmbeddedImagePayloads(value).slice(0, 500).trim();
    }
  }
  return out;
}

function uiText(copy = {}, key, fallback = '') {
  return copy?.[key] || fallback;
}

function normalizeListingImagePlan(plan = {}) {
  const modes = ['add', 'replace_cover', 'replace_all', 'replace_selected', 'delete_selected'];
  const mode = modes.includes(plan.mode) ? plan.mode : 'add';
  const normalizeImageRef = (img, idx = 0) => {
    const parsedRank = parseInt(img.rank, 10);
    return {
    listing_image_id: img.listing_image_id || img.id || null,
    url: img.url || img.url_570xN || img.url_fullxfull || img.url_170x135 || img.image_url || '',
      rank: Number.isFinite(parsedRank) ? parsedRank : idx + 1,
    };
  };
  const currentImages = Array.isArray(plan.current_images) ? plan.current_images.slice(0, 20).map(normalizeImageRef).filter(img => img.url || img.listing_image_id) : [];
  const selectedImages = [];
  const addSelected = (ref) => {
    const normalized = normalizeImageRef(ref);
    const current = currentImages.find(img => (
      (normalized.listing_image_id && String(img.listing_image_id) === String(normalized.listing_image_id))
      || (!normalized.listing_image_id && normalized.rank && img.rank === normalized.rank)
    ));
    const next = current ? { ...normalized, ...current } : normalized;
    if (!next.url && !next.listing_image_id) return;
    if (!selectedImages.some(img => (
      (next.listing_image_id && String(img.listing_image_id) === String(next.listing_image_id))
      || (!next.listing_image_id && next.rank && img.rank === next.rank)
    ))) selectedImages.push(next);
  };
  if (Array.isArray(plan.selected_images)) plan.selected_images.forEach(addSelected);
  const selectedIds = new Set((plan.selected_image_ids || []).map(id => String(id)));
  const selectedRanks = new Set((plan.selected_image_ranks || []).map(rank => parseInt(rank, 10)).filter(Number.isFinite));
  currentImages.forEach(img => {
    if ((img.listing_image_id && selectedIds.has(String(img.listing_image_id))) || selectedRanks.has(img.rank)) addSelected(img);
  });
  const hasRequestedCount = plan.count !== undefined && plan.count !== null && plan.count !== '';
  const requestedCount = parseInt(plan.count, 10);
  const defaultCount = mode === 'delete_selected'
    ? 0
    : mode === 'replace_cover'
      ? 1
      : mode === 'replace_selected' && selectedImages.length
        ? selectedImages.length
        : mode === 'replace_all' && currentImages.length
          ? currentImages.length
          : 3;
  const count = mode === 'delete_selected'
    ? 0
    : mode === 'replace_selected' && selectedImages.length
      ? selectedImages.length
      : Math.max(1, Math.min(10, hasRequestedCount && Number.isFinite(requestedCount) ? requestedCount : defaultCount));
  const generatedImages = Array.isArray(plan.generated_images) ? plan.generated_images.map((img, idx) => ({
    id: img.id || img.image_id || '',
    mimeType: img.mimeType || img.mime_type || 'image/jpeg',
    ...(img.preview ? { preview: img.preview } : {}),
    rank: img.rank || idx + 1,
    ...(img.slot ? { slot: img.slot } : {}),
  })).filter(img => img.id) : [];
  const slots = Array.isArray(plan.slots) ? plan.slots.slice(0, 10).map((slot, idx) => ({
    purpose: String(slot.purpose || `Listing image ${idx + 1}`),
    visual_prompt: sanitizeImagePromptText(slot.visual_prompt || plan.prompt || ''),
    ...(slot.cover_hook ? { cover_hook: String(slot.cover_hook) } : {}),
    ...(slot.alt_text ? { alt_text: sanitizeImagePromptText(slot.alt_text, 250) } : {}),
  })) : [];
  return {
    ...plan,
    mode,
    count,
    aspect_ratio: plan.aspect_ratio || plan.aspectRatio || '1:1',
    prompt: sanitizeImagePromptText(plan.prompt || ''),
    current_images: currentImages,
    selected_images: selectedImages,
    selected_image_ids: Array.isArray(plan.selected_image_ids) ? plan.selected_image_ids.map(String) : selectedImages.map(img => img.listing_image_id).filter(Boolean).map(String),
    selected_image_ranks: Array.isArray(plan.selected_image_ranks) ? plan.selected_image_ranks.map(rank => parseInt(rank, 10)).filter(Number.isFinite) : selectedImages.map(img => img.rank).filter(Number.isFinite),
    generated_images: generatedImages,
    slots,
    uploaded_generated_ids: Array.isArray(plan.uploaded_generated_ids) ? plan.uploaded_generated_ids.map(String) : [],
    uploaded_listing_image_ids: Array.isArray(plan.uploaded_listing_image_ids) ? plan.uploaded_listing_image_ids.map(String) : [],
    target_old_image_ids: Array.isArray(plan.target_old_image_ids) ? plan.target_old_image_ids.map(String) : [],
    deleted_old_image_ids: Array.isArray(plan.deleted_old_image_ids) ? plan.deleted_old_image_ids.map(String) : [],
    reference_image: plan.reference_image || plan.referenceImage || null,
    ui_copy: cleanUiCopy(plan.ui_copy),
    status: plan.status || (generatedImages.length ? 'generated' : 'pending'),
  };
}

function imagePlanResult(plan = {}) {
  const normalized = normalizeListingImagePlan(plan);
  return {
    listing_id: normalized.listing_id,
    listing_title: normalized.listing_title || '',
    mode: normalized.mode,
    prompt: normalized.prompt || '',
    aspect_ratio: normalized.aspect_ratio,
    count: normalized.count,
    slots: normalized.slots || [],
    generated_images: normalized.generated_images || [],
    workflow_id: normalized.workflow_id || null,
    workflow_state: 'images_attached',
    applied_at: new Date().toISOString(),
  };
}

function persistListingImagePlan(messageIndex, plan) {
  if (messageIndex !== undefined && messageIndex >= 0 && agentMessages[messageIndex]) {
    agentMessages[messageIndex].pending_listing_images = plan;
    saveHistory(agentMessages);
  }
}

function replaceListingImagesCard(el, plan, messageIndex) {
  const card = renderListingImagesCard(
    plan,
    (nextPlan, cardEl) => generateListingImages(nextPlan, cardEl, messageIndex),
    (nextPlan, cardEl) => applyListingImages(nextPlan, cardEl, messageIndex),
    (cardEl) => { cardEl.style.opacity = '0.4'; },
    {},
  );
  el.replaceWith(card);
  return card;
}

function setListingImageCardBusy(el, label = 'Working...') {
  const genBtn = el.querySelector('#listing-img-generate-btn');
  const applyBtn = el.querySelector('#listing-img-apply-btn');
  const cancelBtn = el.querySelector('#listing-img-cancel-btn');
  if (genBtn) { genBtn.disabled = true; genBtn.textContent = label; }
  if (applyBtn) applyBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
}

function imageProviderPromptForSlot(plan = {}, slot = {}, imageIndex = 0) {
  // The assistant/server already used listing + conversation context to build
  // plan.prompt / slot.visual_prompt. The image provider should receive only a
  // clean visual brief, never internal listing IDs, action state, or chat logs.
  const visualBrief = sanitizeImagePromptText(slot.visual_prompt || plan.prompt || '', 4000);
  const purpose = slot.purpose || `Listing image ${imageIndex + 1}`;
  return [
    visualBrief,
    `Create image ${imageIndex + 1} of ${plan.count || 1}. Purpose: ${purpose}.`,
    'Make this a high-converting, premium Etsy listing photo. Focus on commercial product photography.',
    slot.cover_hook ? `Include this marketing hook prominently: ${slot.cover_hook}.` : 'Include feature callouts, dimensions, or step-by-step marketing text if it helps sell the product.',
    'Ensure any text added is clear and visually integrated. No fake review stars or generic UI elements.',
  ].filter(Boolean).join('\n\n').slice(0, 6000);
}

function referenceImageForListingImagePlan(plan = {}, imageIndex = 0) {
  if (plan.reference_image || plan.referenceImage) return plan.reference_image || plan.referenceImage;
  const selected = plan.selected_images?.[imageIndex] || plan.selected_images?.[0];
  const current = plan.current_images?.[imageIndex] || plan.current_images?.[0];
  const ref = selected || current;
  return ref?.url ? { url: ref.url } : undefined;
}

function listingImageModeLabel(mode) {
  return mode === 'replace_all' ? 'Replace all images'
    : mode === 'replace_cover' ? 'Replace cover image'
      : mode === 'replace_selected' ? 'Replace selected images'
        : mode === 'delete_selected' ? 'Delete selected images'
          : 'Add images';
}

function resolveSelectedListingImages(plan = {}, currentImages = []) {
  const selected = [];
  const ids = new Set((plan.selected_image_ids || []).map(String));
  const ranks = new Set((plan.selected_image_ranks || []).map(rank => parseInt(rank, 10)).filter(Number.isFinite));
  const add = (img) => {
    if (!img?.listing_image_id && !img?.url && !img?.rank) return;
    if (selected.some(existing => (
      (img.listing_image_id && String(existing.listing_image_id) === String(img.listing_image_id))
      || (!img.listing_image_id && img.rank && existing.rank === img.rank)
    ))) return;
    selected.push(img);
  };
  (plan.selected_images || []).forEach(ref => {
    const match = currentImages.find(img => (
      (ref.listing_image_id && String(img.listing_image_id) === String(ref.listing_image_id))
      || (!ref.listing_image_id && ref.rank && img.rank === ref.rank)
    ));
    add(match ? { ...ref, ...match } : ref);
  });
  currentImages.forEach(img => {
    if ((img.listing_image_id && ids.has(String(img.listing_image_id))) || ranks.has(img.rank)) add(img);
  });
  return selected;
}

function listingImagesFromApi(data = {}) {
  return (data.data?.results || data.data || []).map((img, idx) => ({
    listing_image_id: img.listing_image_id,
    url: img.url_570xN || img.url_fullxfull || img.url_170x135 || img.url || '',
    rank: img.rank || idx + 1,
  })).filter(img => img.listing_image_id || img.url);
}

function buildDuplicateResult(dup = {}, newListingId, createdAt) {
  const normalized = normalizeDuplicateProposal(dup);
  return {
    source_listing_id: normalized.source_listing_id,
    source_title: normalized.source_title || '',
    source_image_url: normalized.source_image_url || normalized.listing_image_url || normalized.image_url || null,
    source_state: normalized.source_state || normalized.state || normalized.listing_state || 'active',
    new_listing_id: newListingId,
    new_listing_title: normalized.title || normalized.source_title || '',
    listing_id: newListingId,
    listing_title: normalized.title || normalized.source_title || '',
    image_url: normalized.source_image_url || normalized.listing_image_url || normalized.image_url || null,
    applied_changes: {
      ...(normalized.title !== undefined ? { title: normalized.title } : {}),
      ...(normalized.description !== undefined ? { description: normalized.description } : {}),
      ...(normalized.tags !== undefined ? { tags: normalized.tags } : {}),
      ...(normalized.price !== undefined ? { price: normalized.price } : {}),
      ...(normalized.personalization_questions !== undefined ? { personalization_questions: normalized.personalization_questions } : {}),
    },
    personalization_questions: normalized.personalization_questions || null,
    created_at: createdAt || new Date().toISOString(),
  };
}

function sanitizeAgentHistory(msgs) {
  if (!Array.isArray(msgs)) return [];
  const cleaned = msgs.filter(m => !isSyntheticUpdateResult(m)).map(m => ({ ...m }));
  for (let i = 0; i < cleaned.length; i++) {
    const newListingId = extractDuplicateListingId(cleaned[i]?.content);
    if (!newListingId) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (!cleaned[j]?.pending_duplicate?.source_listing_id) continue;
      cleaned[j].duplicate_result = cleaned[j].duplicate_result || buildDuplicateResult(cleaned[j].pending_duplicate, newListingId);
      cleaned[j].pending_duplicate = null;
      break;
    }
  }
  for (const msg of cleaned) {
    if (msg.pending_listing_images?.generated_images?.length) {
      msg.pending_listing_images = {
        ...msg.pending_listing_images,
        generated_images: msg.pending_listing_images.generated_images.map(({ preview, ...img }) => img),
      };
    }
    if (msg.listing_image_result?.generated_images?.length) {
      msg.listing_image_result = {
        ...msg.listing_image_result,
        generated_images: msg.listing_image_result.generated_images.map(({ preview, ...img }) => img),
      };
    }
  }
  return cleaned;
}

function imageHistoryPayload(img) {
  if (!img) return null;
  const parsedPreview = parseImageDataUrl(img.preview || '');
  const base64 = img.base64 || parsedPreview?.base64 || '';
  const mimeType = img.mimeType || parsedPreview?.mimeType || 'image/jpeg';
  return {
    preview: img.preview || '',
    base64,
    mimeType,
    filename: img.filename || 'image.jpg',
    ...(img.originalBase64 || base64 ? { originalBase64: img.originalBase64 || base64 } : {}),
    ...(img.originalMimeType || mimeType ? { originalMimeType: img.originalMimeType || mimeType } : {}),
  };
}

function imageFromHistoryPayload(payload) {
  if (!payload) return null;
  const parsedPreview = parseImageDataUrl(payload.preview || '');
  const mimeType = payload.mimeType || parsedPreview?.mimeType || 'image/jpeg';
  const base64 = payload.base64 || parsedPreview?.base64 || '';
  const originalMimeType = payload.originalMimeType || mimeType;
  const originalBase64 = payload.originalBase64 || base64;
  return {
    preview: payload.preview || (base64 ? `data:${mimeType};base64,${base64}` : ''),
    base64,
    mimeType,
    filename: payload.filename || 'image.jpg',
    originalBase64,
    originalMimeType,
    originalDataUrl: originalBase64 ? `data:${originalMimeType};base64,${originalBase64}` : (payload.preview || ''),
  };
}

function parseImageDataUrl(value) {
  const match = String(value || '').match(/^data:(image\/[^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

function loadHistory() {
  try {
    const cached = agentSessionStorage.getItem(HISTORY_KEY);
    if (cached) return sanitizeAgentHistory(JSON.parse(cached));
  } catch {}
  return [];
}

export function saveHistory(msgs) {
  const limited = sanitizeAgentHistory(msgs).slice(-MAX_AGENT_MESSAGES);
  if (msgs === agentMessages && agentMessages.length > limited.length) {
    agentMessages.splice(0, agentMessages.length, ...limited);
  }
  try { agentSessionStorage.setItem(HISTORY_KEY, JSON.stringify(limited)); } catch {}
  if (_currentSessionId) {
    idbHistory.set(_sessionKey(_currentSessionId), limited);
    _saveSessionMeta(_currentSessionId, limited);
  }
}

export let agentMessages = loadHistory();

function runtimeEventsForContext() {
  return agentMessages
    .filter(message => message?.role === 'runtime' && message.runtime_fault?.schema === 'agent_runtime_fault_v1')
    .slice(-5)
    .map(message => ({
      at: message.created_at || null,
      fault: message.runtime_fault,
    }));
}

function latestAgentTurnId(messageIndex) {
  if (Number.isInteger(messageIndex) && messageIndex >= 0 && agentMessages[messageIndex]?.agent_turn_id) {
    return agentMessages[messageIndex].agent_turn_id;
  }
  return [...agentMessages].reverse().find(message => message?.agent_turn_id)?.agent_turn_id || '';
}

function recordAgentRuntimeFault(errorOrFault, options = {}) {
  const fault = errorOrFault?.schema === 'agent_runtime_fault_v1'
    ? createAgentRuntimeFault(errorOrFault)
    : classifyAgentRuntimeError(errorOrFault, options);
  const record = {
    role: 'runtime',
    content: agentRuntimeUserMessage(fault),
    runtime_fault: fault,
    created_at: new Date().toISOString(),
    ...(options.job_id || latestAgentTurnId(options.messageIndex) ? { agent_turn_id: options.job_id || latestAgentTurnId(options.messageIndex) } : {}),
  };
  agentMessages.push(record);
  saveHistory(agentMessages);
  jobs.recordAgentRuntimeFault(record.agent_turn_id || '', fault).catch(() => {});
  window.__agentRenderRuntimeEvent?.(record);
  return record;
}

window.__agentRecordRuntimeFault = recordAgentRuntimeFault;

function preferredSessionHistory(cached, stored) {
  const local = sanitizeAgentHistory(Array.isArray(cached) ? cached : []);
  const durable = sanitizeAgentHistory(Array.isArray(stored) ? stored : []);
  // sessionStorage is updated synchronously before IndexedDB. During an active
  // turn it is the only copy guaranteed to include the just-sent user message.
  if (!local.length) return durable;
  if (!durable.length || local.length >= durable.length) return local;
  return durable;
}

function agentMessagesForRequest() {
  // Runtime events are explicit application context, never synthetic model history.
  const sanitized = agentModelConversation(sanitizeAgentHistory(agentMessages));
  const firstUser = sanitized.find(m => m.role === 'user');
  const tail = sanitized.slice(-MAX_AGENT_REQUEST_MESSAGES);
  if (!firstUser || tail.includes(firstUser)) return tail;
  return [firstUser, ...tail];
}

// Called once in renderAgent() before first render — sets up or resumes a session
async function _initSession() {
  // Same tab: session already active
  const tabId = agentSessionStorage.getItem('agent_current_session');
  if (tabId) {
    _currentSessionId = tabId;
    const stored = await idbHistory.get(_sessionKey(tabId)).catch(() => null);
    const sanitized = preferredSessionHistory(agentMessages, stored);
    if (sanitized !== agentMessages) {
      agentMessages.length = 0;
      agentMessages.push(...sanitized);
      try { agentSessionStorage.setItem(HISTORY_KEY, JSON.stringify(agentMessages)); } catch {}
    }
    if (sanitized.length !== (Array.isArray(stored) ? stored.length : 0)) saveHistory(agentMessages);
    restoreLatestAgentDraftFromMessages(agentMessages);
    return;
  }

  // New tab / browser restart — consult IDB sessions list
  let sessions = [];
  try { sessions = (await idbHistory.get(SESSIONS_KEY)) || []; } catch {}

  // Legacy migration: old single agent_history key → archive as one old session
  if (!sessions.length) {
    const legacy = await idbHistory.get(HISTORY_KEY).catch(() => null);
    if (Array.isArray(legacy) && legacy.length) {
      const id = _genSessionId();
      const preview = legacy.find(m => m.role === 'user')?.content?.slice(0, 80) || 'Previous conversation';
      const stale = Date.now() - SESSION_IDLE_MS - 1000;
      sessions = [{ id, created_at: stale - 3_600_000, last_at: stale, preview }];
      await Promise.all([
        idbHistory.set(_sessionKey(id), legacy.slice(-60)),
        idbHistory.delete(HISTORY_KEY),
        idbHistory.set(SESSIONS_KEY, sessions),
      ]);
    }
  }

  // Pick most recent session
  sessions.sort((a, b) => b.last_at - a.last_at);
  const latest = sessions[0];

  if (latest && (Date.now() - latest.last_at) < SESSION_IDLE_MS) {
    _currentSessionId = latest.id;
    const msgs = await idbHistory.get(_sessionKey(latest.id)).catch(() => null);
    if (Array.isArray(msgs) && msgs.length) {
      const sanitized = sanitizeAgentHistory(msgs);
      agentMessages.length = 0;
      agentMessages.push(...sanitized);
      try { agentSessionStorage.setItem(HISTORY_KEY, JSON.stringify(agentMessages)); } catch {}
      if (sanitized.length !== msgs.length) await idbHistory.set(_sessionKey(latest.id), sanitized);
    }
  } else {
    // Idle too long or no history — start fresh
    _currentSessionId = _genSessionId();
    agentMessages.length = 0;
    try { agentSessionStorage.setItem(HISTORY_KEY, '[]'); } catch {}
  }
  agentSessionStorage.setItem('agent_current_session', _currentSessionId);
  restoreLatestAgentDraftFromMessages(agentMessages);
}

async function _saveSessionMeta(sessionId, msgs) {
  try {
    const sessions = (await idbHistory.get(SESSIONS_KEY)) || [];
    const preview = msgs.find(m => m.role === 'user')?.content?.slice(0, 80) || '';
    const idx = sessions.findIndex(s => s.id === sessionId);
    if (idx >= 0) {
      sessions[idx].last_at = Date.now();
      if (preview) sessions[idx].preview = preview;
    } else {
      sessions.unshift({ id: sessionId, created_at: Date.now(), last_at: Date.now(), preview });
    }
    await idbHistory.set(SESSIONS_KEY, sessions.sort((a, b) => b.last_at - a.last_at).slice(0, 30));
  } catch {}
}

// ── Markdown renderer ─────────────────────────────────────

// ── Plan card ─────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function imageDataUrlFromObject(item = {}) {
  const direct = item.preview
    || item.dataUrl
    || item.data_url
    || item.originalDataUrl
    || item.original_data_url
    || item.src
    || '';
  if (/^(?:https?:\/\/|data:image\/)/i.test(String(direct || ''))) return direct;
  const base64 = item.base64 || item.originalBase64 || item.original_base64 || '';
  const mimeType = item.mimeType || item.mime_type || item.contentType || item.content_type || 'image/png';
  return base64 ? `data:${mimeType};base64,${base64}` : '';
}

function listingImageUrl(item = {}) {
  const reference = item.reference_image || item.referenceImage || null;
  const attached = Array.isArray(item.attached_images) ? item.attached_images[0] : null;
  const attachedCamel = Array.isArray(item.attachedImages) ? item.attachedImages[0] : null;
  return normalizeMediaUrl(imageDataUrlFromObject(item)
    || item.listing_image_url
    || item.source_image_url
    || item.image_url
    || item.url
    || item.url_570xN
    || item.url_170x135
    || item.url_fullxfull
    || item.MainImage?.url_570xN
    || item.MainImage?.url_170x135
    || item.images?.[0]?.url_570xN
    || item.images?.[0]?.url_170x135
    || item.images?.[0]?.url_fullxfull
    || item.Images?.[0]?.url_570xN
    || item.Images?.[0]?.url_170x135
    || item.Images?.[0]?.url_fullxfull
    || imageDataUrlFromObject(reference || {})
    || reference?.url
    || reference?.image_url
    || imageDataUrlFromObject(attached || {})
    || attached?.url
    || attached?.image_url
    || imageDataUrlFromObject(attachedCamel || {})
    || attachedCamel?.url
    || attachedCamel?.image_url
    || '');
}

function listingThumbHtml(item = {}, size = 56) {
  const url = listingImageUrl(item);
  return url
    ? `<img src="${esc(url)}" alt="" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:6px;flex-shrink:0;border:1px solid var(--border)" onerror="this.style.display='none'">`
    : '';
}

function cachedListingForId(id) {
  if (!id) return null;
  const key = String(id);
  const detail = get(`listing:${key}`) || get(`listing:${Number(key)}`);
  if (detail) return detail;
  const active = get('listings:active') || [];
  let found = active.find(l => String(l.listing_id) === key);
  if (found) return found;
  const draft = get('listings:draft') || [];
  found = draft.find(l => String(l.listing_id) === key);
  if (found) return found;
  const inactive = get('listings:inactive') || [];
  return inactive.find(l => String(l.listing_id) === key) || null;
}

function enrichListingDisplayItem(item = {}) {
  const id = item.listing_id || item.source_listing_id || item.id;
  const cached = cachedListingForId(id) || {};
  const rememberedTarget = getRememberedAgentListingTarget();
  const remembered = String(rememberedTarget?.listing_id || '') === String(id || '') ? rememberedTarget : {};
  const merged = { ...cached, ...remembered, ...item };
  const image = listingImageUrl(item) || listingImageUrl(remembered) || listingImageUrl(cached);
  if (image) {
    merged.image_url = image;
    merged.listing_image_url = merged.listing_image_url || image;
  }
  return merged;
}

function enrichListingThumbnailRows(rows = []) {
  return rows.map(row => {
    const enriched = enrichListingDisplayItem(row);
    const image = row.image_url || listingImageUrl(enriched);
    return {
      ...row,
      title: row.title || enriched.title || enriched.listing_title || '',
      state: row.state || enriched.state || enriched.listing_state || 'active',
      views: row.views !== '' && row.views != null ? row.views : enriched.views,
      sales: row.sales !== '' && row.sales != null ? row.sales : (enriched.sales ?? enriched.num_sales ?? enriched.sold_count),
      revenue: row.revenue !== '' && row.revenue != null ? row.revenue : (enriched.revenue ?? enriched.revenue_usd ?? enriched.total_revenue),
      price: row.price !== '' && row.price != null ? row.price : enriched.price,
      image_url: image || '',
      etsy_url: row.etsy_url || row.url || enriched.etsy_url || enriched.url || listingDestinationUrl(row.listing_id, row.state || enriched.state || 'active'),
      url: row.url || row.etsy_url || enriched.url || enriched.etsy_url || listingDestinationUrl(row.listing_id, row.state || enriched.state || 'active'),
    };
  });
}

function listingStateLabel(item = {}) {
  const state = String(item.state || item.listing_state || item.source_state || 'active').trim() || 'active';
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function listingLinkHtml(id, title, state = 'active') {
  if (!id) return esc(title || 'Listing');
  return `<a href="${esc(listingDestinationUrl(id, state))}" target="_blank" rel="noopener noreferrer" class="agent-action-card-title-link">${esc(title || `Listing ${id}`)}</a>`;
}

function titleLengthHint(title) {
  if (!title) return '';
  const len = String(title).length;
  const color = len > 130 ? 'var(--yellow-text)' : 'var(--text-3)';
  return `<span style="color:${color}">${len}/140</span>`;
}

function agentNoticeHtml(text, tone = 'info') {
  const toneClass = tone === 'warn' ? 'agent-notice-warn' : tone === 'success' ? 'agent-notice-success' : 'agent-notice-info';
  return `<div class="agent-notice ${toneClass}">${esc(text)}</div>`;
}

const {
  renderVariationsCard,
  renderClearVariationsCard,
  renderRemoveVariationPropertyCard,
  renderPriceMultiplierInventoryCard,
} = createAgentVariationCardView({
  cancelPendingCard,
  listingThumbHtml,
  listingLinkHtml,
  agentNoticeHtml,
});

function renderPlanChangeDiff(change, copy = {}) {
  const max = change.field === 'description' ? 320 : 180;
  const before = shortValue(formatPlanValue(change.before, change.field), max);
  const after = shortValue(formatPlanValue(change.after, change.field), max);
  return `<div class="agent-field-diff">
    <div class="agent-field-diff-label">${esc(change.label)}</div>
    <div class="agent-field-diff-values">
      <div class="agent-field-diff-value agent-field-diff-before"><span>${esc(uiText(copy, 'current_label', 'Current'))}</span><p>${esc(before)}</p></div>
      <div class="agent-field-diff-arrow">→</div>
      <div class="agent-field-diff-value agent-field-diff-after"><span>${esc(uiText(copy, 'new_label', 'New'))}</span><p>${esc(after)}</p></div>
    </div>
  </div>`;
}

function renderPlanCard(plan, onApprove, onCancel, options = {}) {
  const el = document.createElement('div');
  el.className = 'agent-action-card agent-action-card-update';
  const copy = cleanUiCopy(plan.ui_copy);

  const items = plan.updates.map(rawUpdate => {
    const u = enrichListingDisplayItem(normalizePlanUpdate(rawUpdate));
    const changes = getPlanUpdateFields(u);
    const details = getPlanUpdateChangeDetails(u);
    const displayTitle = u.listing_title || u.title_current || u.title || `Listing ${u.listing_id}`;
    const state = u.state || u.listing_state || 'active';
    const img = listingThumbHtml(u, 72);
    const link = listingLinkHtml(u.listing_id, displayTitle, state);
    const detailsHtml = details.length
      ? `<div class="agent-action-card-diffs">${details.map(change => renderPlanChangeDiff(change, copy)).join('')}</div>`
      : `<div class="agent-action-card-details agent-action-card-warning">${esc(uiText(copy, 'no_values_warning', 'No concrete field values detected - ask for a clearer preview before approving.'))}</div>`;
    return `<div class="agent-action-card-item">
      ${img || '<div class="agent-action-card-thumb-placeholder">Image unavailable</div>'}
      <div class="agent-action-card-item-body">
        <div class="agent-action-card-meta"><span class="agent-action-card-state">${esc(listingStateLabel({ state }))}</span><span>${esc(uiText(copy, 'target_listing_label', 'Target listing'))}</span><span>ID ${esc(u.listing_id)}</span>${u.title ? titleLengthHint(u.title) : ''}</div>
        <div class="agent-action-card-title">${link}</div>
        <div class="agent-action-card-changes"><strong>${esc(changes.join(', ') || uiText(copy, 'no_field_changes', 'No field changes'))}</strong></div>
        ${detailsHtml}
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="agent-action-card-heading">${esc(uiText(copy, 'heading', `Preview - ${plan.summary || 'Update listing'}`))}</div>
    <div class="agent-preview-status-row">
      <span class="agent-preview-pill">${esc(uiText(copy, 'preview_status', 'Preview, not applied'))}</span>
      <span class="agent-preview-pill agent-preview-pill-approval">${esc(uiText(copy, 'approval_status', 'Approval required'))}</span>
    </div>
    ${agentNoticeHtml(uiText(copy, 'notice', 'Preview only. Nothing changes on Etsy until you approve this card.'), 'info')}
    <div class="agent-action-card-list">${items}</div>
    <div class="agent-action-card-actions">
      <button class="btn btn-primary btn-sm" id="plan-approve-btn">${esc(uiText(copy, 'approve_button', `Approve preview & apply (${plan.updates.length})`))}</button>
      <button class="btn btn-sm" id="plan-cancel-btn" style="color:var(--red-text)">${esc(uiText(copy, 'cancel_button', 'Cancel'))}</button>
    </div>
    <div id="plan-progress" class="agent-action-card-progress"></div>`;

  wireActionCard(el, {
    approveSelector: '#plan-approve-btn',
    cancelSelector: '#plan-cancel-btn',
    progressSelector: '#plan-progress',
    onApprove: () => onApprove(plan, el),
    onCancel: () => onCancel(el),
  }, options);

  return el;
}

// ── Social post card ──────────────────────────────────────
function renderSocialPostCard(post, onApprove, options = {}) {
  const el = document.createElement('div');
  el.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:8px 0';
  const platform = esc(post.platform || 'all');
  const platformTag = post.platform && post.platform !== 'all'
    ? `<span style="font-size:10px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px">${esc(post.platform)}</span>`
    : '';
  const imgHtml = post.listing_image_url
    ? `<img src="${esc(post.listing_image_url)}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0" onerror="this.style.display='none'">`
    : '';
  const headerMeta = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
      ${imgHtml}
      <div style="min-width:0">
        <div style="font-weight:700;font-size:13px;margin-bottom:2px">📱 Social post — ${platform}</div>
        ${platformTag}
        ${post.listing_title ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📦 ${esc(post.listing_title)}</div>` : ''}
      </div>
    </div>`;

  el.innerHTML = `
    ${headerMeta}
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.6;margin-bottom:10px;white-space:pre-wrap;max-height:160px;overflow-y:auto">${esc(post.caption)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary btn-sm" id="social-approve-btn">✓ Post now</button>
      <button class="btn btn-sm" id="social-save-btn">📅 Save draft</button>
      <button class="btn btn-sm" id="social-hub-btn" style="margin-left:auto">→ Social Hub</button>
    </div>
    <div id="social-progress" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>`;

  wireActionCard(el, {
    approveSelector: '#social-approve-btn',
    progressSelector: '#social-progress',
    hideCancel: false,
    onApprove: () => onApprove(post, el),
  }, options);
  const state = actionCardState(options);
  const hubBtn = el.querySelector('#social-hub-btn');
  const saveBtn = el.querySelector('#social-save-btn');
  if (state.disabled) {
    if (hubBtn) hubBtn.disabled = true;
    if (saveBtn) saveBtn.disabled = true;
    return el;
  }
  hubBtn.onclick = () => window.navigate?.('social', { caption: post.caption, platform: post.platform || 'all', ...(post.listing_id ? { listing_id: post.listing_id } : {}) });
  saveBtn.onclick = async () => {
    const saveBtn = el.querySelector('#social-save-btn');
    const progressEl = el.querySelector('#social-progress');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      await saveScheduledPost({ id: generateId(), caption: post.caption, platform: post.platform || 'all', listing_id: post.listing_id || null, listing_title: post.listing_title || null, listing_image_url: post.listing_image_url || null, status: 'draft', created_at: Date.now() });
      progressEl.innerHTML = '✓ Saved as draft — <button style="background:none;border:none;color:var(--orange);cursor:pointer;font-size:12px;padding:0;text-decoration:underline" onclick="window.navigate?.(\'schedule\')">View in Schedule →</button>';
      saveBtn.textContent = '✓ Saved!';
      toastSuccess('Post saved as draft!');
    } catch (e) {
      progressEl.textContent = 'Failed: ' + e.message;
      saveBtn.disabled = false; saveBtn.textContent = '📅 Save draft';
      toastError('Failed to save: ' + e.message);
    }
  };
  return el;
}

// ── Scheduled post card ───────────────────────────────────
function renderScheduledPostCard(post, onConfirm, onCancel, options = {}) {
  const el = document.createElement('div');
  el.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--orange-border);border-radius:10px;padding:14px 16px;margin:8px 0';
  const platform = esc(post.platform || 'all');
  const listing  = post.listing_title ? `<div style="font-size:11px;color:var(--text-3);margin-bottom:6px">Listing: ${esc(post.listing_title)}</div>` : '';
  const thumb = listingThumbHtml(post);
  const dateInfo = post.scheduled_at ? `<div style="font-size:11px;color:var(--orange);margin-bottom:6px">⏰ Scheduled: ${esc(new Date(post.scheduled_at).toLocaleString())}</div>` : '<div style="font-size:11px;color:var(--text-3);margin-bottom:6px">📝 Save as draft</div>';

  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">
      ${thumb}
      <div style="min-width:0">
        <div style="font-weight:700;font-size:13px;margin-bottom:6px">📅 Schedule post — ${platform}</div>
        ${listing}
        ${dateInfo}
      </div>
    </div>
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.6;margin-bottom:10px;white-space:pre-wrap;max-height:160px;overflow-y:auto">${esc(post.caption)}</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" id="sched-confirm-btn">✓ Save to schedule</button>
      <button class="btn btn-sm" id="sched-cancel-btn" style="color:var(--red-text)">✗ Cancel</button>
    </div>
    <div id="sched-progress" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>`;

  wireActionCard(el, {
    approveSelector: '#sched-confirm-btn',
    cancelSelector: '#sched-cancel-btn',
    progressSelector: '#sched-progress',
    onApprove: () => onConfirm(post, el),
    onCancel: () => onCancel(el),
  }, options);
  return el;
}

// ── Execute save scheduled post ───────────────────────────
async function executeScheduledPost(post, el, messageIndex) {
  const confirmBtn  = el.querySelector('#sched-confirm-btn');
  const cancelBtn   = el.querySelector('#sched-cancel-btn');
  const progressEl  = el.querySelector('#sched-progress');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Saving…'; }
  if (cancelBtn)  cancelBtn.style.display = 'none';

  try {
    await saveScheduledPost({ id: generateId(), caption: post.caption, platform: post.platform || 'all', listing_id: post.listing_id || null, listing_title: post.listing_title || null, listing_image_url: post.listing_image_url || null, scheduled_at: post.scheduled_at || null, status: 'draft', created_at: Date.now() });
    if (progressEl) progressEl.textContent = '✓ Saved! Open Schedule page to manage it.';
    if (confirmBtn) { confirmBtn.textContent = '✓ Saved!'; confirmBtn.style.background = 'var(--green)'; confirmBtn.style.borderColor = 'var(--green)'; confirmBtn.style.color = 'white'; }
    clearPendingAction(messageIndex, 'pending_scheduled_post');
    toastSuccess('Post saved to schedule!');
  } catch (e) {
    const fault = e?.runtime_fault || classifyAgentRuntimeError(e, {
      operation: 'save_scheduled_post',
      retryable: true,
    });
    const runtimeRecord = recordAgentRuntimeFault(fault, { messageIndex });
    if (progressEl) progressEl.textContent = runtimeRecord.content;
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '↻ Retry'; }
    toastError(runtimeRecord.content);
  }
}

// ── Duplicate listing card ───────────────────────────────
function renderDuplicateCard(dup, onApprove, onCancel, options = {}) {
  dup = normalizeDuplicateProposal(dup);
  const el = document.createElement('div');
  el.className = 'agent-action-card agent-action-card-duplicate';

  const changes = [];
  if (dup.title) changes.push(`Title: ${esc(dup.title)}`);
  if (dup.description) changes.push(`Description: ${esc(dup.description.length > 260 ? dup.description.slice(0, 260).trim() + '...' : dup.description)}`);
  if (dup.tags) changes.push(`Tags: ${esc(dup.tags.join(', '))}`);
  if (dup.price) changes.push(`Price: $${dup.price}`);
  if (dup.personalization_questions?.length) changes.push(`Personalization: ${dup.personalization_questions.length} new question${dup.personalization_questions.length === 1 ? '' : 's'}`);

  const sourceState = dup.source_state || dup.state || dup.listing_state || 'active';
  const sourceDisplay = enrichListingDisplayItem({ ...dup, listing_id: dup.source_listing_id, title: dup.source_title, state: sourceState });

  el.innerHTML = `
    <div class="agent-action-card-heading">📋 ${esc(dup.changes_summary || 'Duplicate listing')}</div>
    <div class="agent-action-card-item">
      ${listingThumbHtml(sourceDisplay, 76) || '<div class="agent-action-card-thumb-placeholder">Image unavailable</div>'}
      <div class="agent-action-card-item-body">
        <div class="agent-action-card-meta"><span class="agent-action-card-state">${esc(listingStateLabel({ state: sourceState }))}</span><span>ID ${esc(dup.source_listing_id)}</span>${dup.title ? titleLengthHint(dup.title) : ''}</div>
        <div class="agent-action-card-source-label">Source listing</div>
        <div class="agent-action-card-title">${listingLinkHtml(dup.source_listing_id, dup.source_title, sourceState)}</div>
      </div>
    </div>
    <div class="agent-action-card-details">${changes.length ? changes.map(c => `<div>• ${c}</div>`).join('') : 'No changes - exact copy'}</div>
    <div class="agent-action-card-actions">
      <button class="btn btn-primary btn-sm" id="dup-approve-btn">✓ Create duplicate</button>
      <button class="btn btn-sm" id="dup-cancel-btn" style="color:var(--red-text)">✗ Cancel</button>
    </div>
    <div id="dup-progress" class="agent-action-card-progress"></div>`;

  wireActionCard(el, {
    approveSelector: '#dup-approve-btn',
    cancelSelector: '#dup-cancel-btn',
    progressSelector: '#dup-progress',
    onApprove: () => onApprove(dup, el),
    onCancel: () => onCancel(el),
  }, options);
  return el;
}

// ── Field fill card ──────────────────────────────────────
function renderFieldFillCard(fills, onApply, options = {}) {
  const el = document.createElement('div');
  el.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:8px 0';

  const rows = (fills.fields || []).map(f => `<tr>
    <td style="padding:4px 8px;border:1px solid var(--border);font-size:12px;font-weight:600;white-space:nowrap">${esc(f.label || f.field_id)}</td>
    <td style="padding:4px 8px;border:1px solid var(--border);font-size:12px;color:var(--text-2);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.value)}">${esc(f.value)}</td>
  </tr>`).join('');

  el.innerHTML = `
    <div style="font-weight:700;font-size:13px;margin-bottom:8px">✏️ ${esc(fills.summary || 'Fill fields')}</div>
    <div style="overflow-x:auto;margin-bottom:10px">
      <table style="border-collapse:collapse;width:100%;font-size:12px">
        <tr>
          <th style="padding:4px 8px;border:1px solid var(--border);background:var(--bg-card);text-align:left;font-size:11px">Field</th>
          <th style="padding:4px 8px;border:1px solid var(--border);background:var(--bg-card);text-align:left;font-size:11px">Value</th>
        </tr>
        ${rows}
      </table>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" id="fill-apply-btn">✓ Apply to page</button>
      <button class="btn btn-sm" id="fill-cancel-btn" style="color:var(--text-3)">✗ Cancel</button>
    </div>
    <div id="fill-progress" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>`;

  wireActionCard(el, {
    approveSelector: '#fill-apply-btn',
    cancelSelector: '#fill-cancel-btn',
    progressSelector: '#fill-progress',
    onApprove: () => onApply(fills, el),
    onCancel: () => {
      cancelPendingCard(el, fills._messageIndex, 'pending_field_fills', ['#fill-apply-btn', '#fill-cancel-btn']);
    },
  }, options);
  return el;
}

// ── Variations card ──────────────────────────────────────
function agentDebugTraceVisible() {
  try {
    return window.__ETSY_AGENT_DEBUG__ === true || localStorage.getItem('etsy_agent_debug_trace') === '1';
  } catch {
    return false;
  }
}

function renderAgentDebugTrace(trace = []) {
  const presentation = agentDebugTracePresentation(trace, agentDebugTraceVisible());
  if (!presentation) return null;
  const el = document.createElement('details');
  el.className = 'agent-debug-trace';
  el.style.cssText = 'max-width:820px;margin:4px 0 2px 0;font-size:11px;color:var(--text-3)';
  const summary = document.createElement('summary');
  summary.textContent = 'Debug trace';
  summary.style.cssText = 'cursor:pointer;user-select:none';
  el.appendChild(summary);
  const body = document.createElement('pre');
  body.style.cssText = 'white-space:pre-wrap;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:4px;max-height:220px;overflow:auto';
  body.textContent = presentation.bodyText;
  el.appendChild(body);
  return el;
}

function draftShopHeader() {
  try {
    const shopId = sessionStorage.getItem('etsy_mgr_active_shop');
    return shopId ? { 'x-shop-id': shopId } : {};
  } catch { return {}; }
}

async function patchCreateDraft(patch, expectedRevision = null) {
  const payload = await fetchJsonWithTimeout('/api/drafts', {
    method: 'POST',
    headers: draftShopHeader(),
    body: JSON.stringify({
      action: 'patch',
      key: 'create_draft',
      patch,
      ...(expectedRevision !== null && expectedRevision !== undefined && Number.isFinite(Number(expectedRevision))
        ? { expected_revision: Number(expectedRevision) }
        : {}),
    }),
    timeoutMs: 10_000,
  }, 'Listing draft update', 10_000);
  const draft = payload?.data;
  window.dispatchEvent(new CustomEvent('etsy:create-draft-patched', { detail: { draft, patch } }));
  try {
    const channel = new BroadcastChannel('etsy-create-draft');
    channel.postMessage({ type: 'patched', draft, patch });
    channel.close();
  } catch {}
  return draft;
}

async function readCreateDraftContext() {
  try {
    const payload = await fetchJsonWithTimeout(
      '/api/drafts?action=get&key=create_draft',
      { method: 'GET', headers: draftShopHeader(), timeoutMs: 10_000 },
      'Listing draft read',
      10_000,
    );
    const draft = payload?.data;
    if (!draft || typeof draft !== 'object') return null;
    const shopId = draftShopHeader()['x-shop-id'] || 'default';
    const [shippingResult, readinessResult] = await Promise.allSettled([
      getOrFetch(`shipping:${shopId}`, () => etsy.getShippingProfiles()),
      getOrFetch(`readiness:${shopId}`, () => etsy.getReadinessStateDefinitions()),
    ]);
    const shippingProfiles = shippingResult.status === 'fulfilled'
      ? (shippingResult.value?.results || shippingResult.value || [])
      : [];
    const readinessProfiles = readinessResult.status === 'fulfilled'
      ? (readinessResult.value?.results || readinessResult.value || [])
      : [];
    return {
      draft_id: draft.draft_id || null,
      revision: Number(draft.revision) || 0,
      workflow_id: draft.workflow_id || null,
      listing_type: draft.listingType || draft.generated?.listing_type || 'download',
      title: String(draft.title || draft.generated?.title || '').slice(0, 180),
      description: String(draft.desc || draft.generated?.description || '').slice(0, 2500),
      tags: Array.isArray(draft.tags) ? draft.tags.slice(0, 13) : [],
      price: draft.price || draft.generated?.price_suggestion || '',
      taxonomy_id: draft.taxonomy_id || null,
      taxonomy_category: draft.taxonomy_category || draft.generated?.taxonomy_category || null,
      shipping_profile_id: draft.shipping_profile_id || null,
      readiness_state_id: draft.readiness_state_id || null,
      shipping_profiles_status: shippingResult.status === 'fulfilled' ? 'loaded' : 'failed',
      shipping_profiles: shippingProfiles.map(profile => ({
        id: profile.shipping_profile_id,
        title: profile.title || `Shipping profile ${profile.shipping_profile_id}`,
        origin_country: profile.origin_country_iso || null,
      })),
      readiness_profiles_status: readinessResult.status === 'fulfilled' ? 'loaded' : 'failed',
      readiness_profiles: readinessProfiles.map(profile => ({
        id: profile.readiness_state_id,
        state: profile.readiness_state,
        processing_time: profile.processing_days_display_label || `${profile.min_processing_days || '?'}-${profile.max_processing_days || '?'} days`,
      })),
      image_count: Array.isArray(draft.draftImages) ? draft.draftImages.length : 0,
      variations: draft.variations?.enabled ? {
        enabled: true,
        properties: (draft.variations.properties || []).map(property => ({
          name: property.name || 'Variation',
          options: (property.options || []).map(option => option.name || String(option)).filter(Boolean),
        })),
        product_count: Array.isArray(draft.variations.products) ? draft.variations.products.length : 0,
        prices: Array.from(new Set((draft.variations.products || [])
          .map(product => Number(product.price))
          .filter(price => Number.isFinite(price) && price >= 0.20)))
          .sort((a, b) => a - b)
          .slice(0, 20),
      } : null,
    };
  } catch {
    return null;
  }
}

async function applyVariations(data, el) {
  const applyBtn   = el.querySelector('#var-apply-btn');
  const cancelBtn  = el.querySelector('#var-cancel-btn');
  const progressEl = el.querySelector('#var-progress');
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying…'; }
  if (cancelBtn) cancelBtn.disabled = true;
  try {
    const variations = data.properties?.length ? buildDraftVariations(data) : undefined;
    const personalizationQuestions = Array.isArray(data.personalization_questions) && data.personalization_questions.length
      ? normalizeActionPersonalizationQuestions(data.personalization_questions)
      : undefined;
    if (data.target_type === 'etsy_listing' && Number(data.listing_id) > 0) {
      const listingId = Number(data.listing_id);
      if (data.listing_type && data.current_listing_type && data.listing_type !== data.current_listing_type) {
        await etsy.updateListing(listingId, {
          listing_type: data.listing_type,
          ...(Number(data.taxonomy_id) > 0 ? { taxonomy_id: Number(data.taxonomy_id) } : {}),
          ...(Number(data.shipping_profile_id) > 0 ? { shipping_profile_id: Number(data.shipping_profile_id) } : {}),
        });
      }
      let appliedInventory = null;
      if (variations) {
        appliedInventory = draftVariationsToInventoryPayload(variations, data.readiness_state_id);
        const inventory = appliedInventory;
        await etsy.updateListingInventory(listingId, inventory.products, inventory.price_on_property, inventory.readiness_state_id);
      }
      if (personalizationQuestions !== undefined) {
        await etsy.updateListingPersonalization(listingId, personalizationQuestions);
      }
      invalidate('listings');
      invalidate(`listing:${listingId}`);
      const appliedParts = [variations ? 'variations and prices' : '', personalizationQuestions !== undefined ? 'personalization' : ''].filter(Boolean);
      if (applyBtn) applyBtn.textContent = 'Applied to Etsy';
      if (progressEl) {
        progressEl.textContent = `✓ ${appliedParts.join(' and ') || 'Listing options'} updated successfully.`;
        progressEl.style.color = 'var(--green-text,var(--green))';
        progressEl.style.fontWeight = '600';
      }
      const resultActions = el.querySelector('#var-result-actions');
      const verifyBtn = el.querySelector('#var-verify-btn');
      const openEditorBtn = el.querySelector('#var-open-editor-btn');
      if (resultActions) resultActions.style.display = 'flex';
      openEditorBtn?.addEventListener('click', () => {
        window.location.hash = `create?id=${listingId}`;
      });
      verifyBtn?.addEventListener('click', async () => {
        verifyBtn.disabled = true;
        verifyBtn.textContent = 'Checking...';
        try {
          const liveInventory = await etsy.getListingInventory(listingId);
          const livePrices = (liveInventory?.products || []).flatMap(product => product.offerings || [])
            .filter(offering => offering.is_enabled !== false)
            .map(offering => Number(offering.price?.amount !== undefined
              ? offering.price.amount / (offering.price.divisor || 100)
              : offering.price))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
          const expectedPrices = (appliedInventory?.products || [])
            .map(product => Number(product.offerings?.[0]?.price))
            .sort((a, b) => a - b);
          const pricesMatch = livePrices.length === expectedPrices.length
            && livePrices.every((price, index) => Math.abs(price - expectedPrices[index]) < 0.001);
          if (!pricesMatch) throw new Error('Live Etsy inventory does not match the approved price matrix yet.');
          if (personalizationQuestions) {
            const livePersonalization = await etsy.getListingPersonalization(listingId);
            const liveQuestions = livePersonalization?.personalization_questions
              || livePersonalization?.personalization?.personalization_questions
              || livePersonalization?.results
              || [];
            const liveQuestionTexts = new Set(liveQuestions.map(question => String(question.question_text || '').trim()));
            const personalizationMatches = liveQuestions.length === personalizationQuestions.length
              && personalizationQuestions.every(question => liveQuestionTexts.has(String(question.question_text || '').trim()));
            if (!personalizationMatches) throw new Error('Live Etsy personalization does not match the approved questions yet.');
          }
          if (progressEl) {
            const personalizationStatus = personalizationQuestions
              ? `${personalizationQuestions.length} personalization question${personalizationQuestions.length === 1 ? '' : 's'} applied.`
              : 'Personalization was not changed.';
            progressEl.textContent = `✓ Verified on Etsy: ${livePrices.length} combinations, $${livePrices[0].toFixed(2)}–$${livePrices.at(-1).toFixed(2)}. ${personalizationStatus}`;
            progressEl.style.color = 'var(--green-text,var(--green))';
          }
          verifyBtn.textContent = 'Verified';
        } catch (error) {
          if (progressEl) {
            progressEl.textContent = userFacingErrorMessage(error?.message || 'Could not verify the live listing');
            progressEl.style.color = 'var(--red-text)';
          }
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'Verify again';
        }
      });
      toastSuccess('Etsy listing options updated');
      clearPendingAction(data._messageIndex, 'pending_variations');
      return;
    }
    const patch = {
      ...(data.listing_type ? { listingType: data.listing_type } : {}),
      ...(Number(data.base_price) >= 0.20 ? { price: Number(data.base_price) } : {}),
      ...(data.taxonomy_category ? { taxonomy_category: data.taxonomy_category } : {}),
      ...(Number(data.shipping_profile_id) > 0 ? { shipping_profile_id: Number(data.shipping_profile_id) } : {}),
      ...(Number(data.readiness_state_id) > 0 ? { readiness_state_id: Number(data.readiness_state_id) } : {}),
      ...(variations ? { variations } : {}),
      ...(personalizationQuestions !== undefined ? { personalizationQuestions } : {}),
    };
    await patchCreateDraft(patch, data.expected_revision);
    if (applyBtn) applyBtn.textContent = 'Applied to draft';
    if (progressEl) progressEl.textContent = 'The saved listing draft and any open Create page are now updated.';
    clearPendingAction(data._messageIndex, 'pending_variations');
  } catch (error) {
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = data.target_type === 'etsy_listing' ? 'Retry Etsy update' : 'Retry draft update';
    }
    if (cancelBtn) cancelBtn.disabled = false;
    if (progressEl) {
      progressEl.textContent = userFacingErrorMessage(error?.message || 'Could not update the listing');
      progressEl.style.color = 'var(--red-text)';
    }
  }
}

function latestAssistantMessageWith(predicate) {
  return [...agentMessages].slice(0, -1).reverse().find(m => m.role === 'assistant' && predicate(m));
}

function latestDuplicateResult() {
  return latestDuplicateResultFromMessages(agentMessages.slice(0, -1));
}

function latestCancelledDuplicate() {
  const history = agentMessages.slice(0, -1);
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;
    if (msg.cancelled_duplicate?.source_listing_id) return msg.cancelled_duplicate;
    if (/Duplication cancelled\.|Дублювання скасовано|дублікат.*скас/i.test(String(msg.content || ''))) {
      for (let j = i - 1; j >= 0; j--) {
        const previous = history[j];
        if (previous?.role === 'assistant' && previous.pending_duplicate?.source_listing_id) {
          return normalizeDuplicateProposal(previous.pending_duplicate);
        }
      }
    }
  }
  return null;
}

function latestActivePendingDuplicate() {
  const history = agentMessages.slice(0, -1).reverse();
  for (const msg of history) {
    if (msg.role !== 'assistant') continue;
    if (msg.cancelled_duplicate?.source_listing_id) return null;
    if (msg.pending_duplicate?.source_listing_id) return msg.pending_duplicate;
  }
  return null;
}

function compactListingReference(input = {}, source = 'conversation') {
  const normalized = normalizeAgentListingTarget(input);
  if (!normalized) return null;
  return {
    ...normalized,
    source,
    mode: input.mode || null,
    summary: input.summary || input.changes_summary || null,
    image_count: Array.isArray(input.current_images) ? input.current_images.length : undefined,
  };
}

function latestListingImagePlan(options = {}) {
  return latestListingImagePlanEntry(options)?.plan || null;
}

function latestListingImagePlanEntry(options = {}) {
  for (let i = agentMessages.length - 1; i >= 0; i--) {
    const msg = agentMessages[i];
    if (msg?.role === 'assistant' && msg.pending_listing_images?.listing_id && !msg.listing_image_result?.applied_at) {
      return { plan: msg.pending_listing_images, messageIndex: i };
    }
  }
  return null;
}

function latestListingImageCardElement() {
  const cards = [...document.querySelectorAll('.agent-action-card')]
    .filter(el => el.querySelector('#listing-img-generate-btn') || el.querySelector('#listing-img-apply-btn'));
  return cards[cards.length - 1] || null;
}

async function executeListingImageActionFromAgent(actionInput = {}) {
  const action = String(actionInput?.action || '');
  if (action !== 'generate_previews' && action !== 'apply_to_listing') return false;
  const entry = latestListingImagePlanEntry();
  if (!entry?.plan) return false;
  if (actionInput.listing_id && String(actionInput.listing_id) !== String(entry.plan.listing_id)) {
    appendMessage('assistant', `The active image plan is for listing ${entry.plan.listing_id}, so I did not run an action for listing ${actionInput.listing_id}.`);
    return true;
  }
  const cardEl = latestListingImageCardElement();
  if (!cardEl) {
    appendMessage('assistant', 'I found the active image plan, but its action card is not visible. Reopen the current chat card and try again.');
    return true;
  }
  const plan = normalizeListingImagePlan(entry.plan);
  if (action === 'apply_to_listing' && plan.mode !== 'delete_selected' && !(plan.generated_images || []).length) {
    appendMessage('assistant', 'Generate the previews first, then tell me to apply them.');
    return true;
  }
  if (action === 'generate_previews') await generateListingImages(plan, cardEl, entry.messageIndex);
  else await applyListingImages(plan, cardEl, entry.messageIndex);
  return true;
}

export async function __executeListingImageActionForTest(action = {}) {
  return executeListingImageActionFromAgent(action);
}

function latestListingSelectionCandidates() {
  const msg = latestAssistantMessageWith(m => extractListingThumbnailRows(m.content || '').length);
  if (!msg) return [];
  return enrichListingThumbnailRows(extractListingThumbnailRows(msg.content || ''))
    .slice(0, 6)
    .map(normalizeAgentListingTarget)
    .filter(Boolean);
}

function latestConversationListingReferences(limit = 10) {
  const refs = [];
  const seen = new Set();
  const add = (input, source, messageIndex) => {
    const ref = compactListingReference(input, source);
    if (!ref?.listing_id) return;
    const key = `${source}:${ref.listing_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ ...ref, message_index: messageIndex, recency: refs.length });
  };
  for (let i = agentMessages.length - 1; i >= 0 && refs.length < limit; i--) {
    const msg = agentMessages[i];
    if (msg?.role !== 'assistant') continue;
    if (msg.pending_listing_images?.listing_id && !msg.listing_image_result?.applied_at) {
      add(msg.pending_listing_images, 'active_listing_image_plan', i);
    }
    if (msg.listing_image_result?.listing_id && msg.listing_image_result?.applied_at) {
      add(msg.listing_image_result, 'completed_listing_image_plan', i);
    }
    for (const update of msg.pending_updates?.updates || []) add(update, 'pending_update_plan', i);
    for (const item of msg.pending_price_multiplier_inventory?.listings || []) add(item, 'pending_price_inventory_plan', i);
    for (const item of msg.pending_clear_variations?.listings || []) add(item, 'pending_variation_plan', i);
    for (const item of msg.pending_remove_variation_property?.listings || []) add(item, 'pending_variation_plan', i);
    for (const row of enrichListingThumbnailRows(extractListingThumbnailRows(msg.content || ''))) add(row, 'visible_listing_result', i);
  }
  const remembered = getRememberedAgentListingTarget();
  if (remembered) refs.unshift({ ...remembered, source: 'user_selected_listing', recency: -1 });
  return refs.slice(0, limit);
}

export function clearLatestPendingListingImagePlan() {
  for (let i = agentMessages.length - 1; i >= 0; i--) {
    const msg = agentMessages[i];
    if (msg?.role === 'assistant' && msg.pending_listing_images?.listing_id && !msg.listing_image_result?.applied_at) {
      msg.pending_listing_images = null;
      saveHistory(agentMessages);
      return true;
    }
  }
  return false;
}

function clearPendingAction(messageIndex, key) {
  if (messageIndex !== undefined && messageIndex >= 0 && agentMessages[messageIndex]) {
    agentMessages[messageIndex][key] = null;
    saveHistory(agentMessages);
  }
}

async function hydrateGeneratedImagePreviews(images = []) {
  return Promise.all((images || []).map(async img => {
    if (img.preview) return img;
    const stored = await getImage(img.id).catch(() => null);
    return stored?.base64
      ? { ...img, preview: `data:${stored.mimeType || img.mimeType || 'image/jpeg'};base64,${stored.base64}` }
      : img;
  }));
}

function applyFieldFills(fills, el) {
  const applyBtn   = el.querySelector('#fill-apply-btn');
  const progressEl = el.querySelector('#fill-progress');
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying…'; }

  let applied = 0;
  const notFound = [];

  for (const f of fills.fields || []) {
    const target = document.getElementById(f.field_id);
    if (!target) { notFound.push(f.field_id); continue; }

    // Set value
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement?.prototype || {}, 'value')?.set;
    if (nativeInputValueSetter && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      nativeInputValueSetter.call(target, f.value);
    } else {
      target.value = f.value;
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));

    // Scroll into view and highlight
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.style.transition = 'box-shadow 0.3s ease';
    target.style.boxShadow = '0 0 0 3px var(--orange)';
    setTimeout(() => { target.style.boxShadow = ''; }, 2500);
    applied++;
  }

  const progressEl2 = el.querySelector('#fill-progress');
  if (progressEl2) {
    if (applied > 0 && !notFound.length) progressEl2.textContent = `✓ Filled ${applied} field${applied > 1 ? 's' : ''} — fields highlighted on page`;
    else if (applied > 0) progressEl2.textContent = `✓ Filled ${applied}. Not found: ${notFound.join(', ')}`;
    else progressEl2.textContent = `Fields not found in current view: ${notFound.join(', ')}`;
  }
  if (applyBtn) {
    applyBtn.textContent = applied > 0 ? `✓ Applied (${applied})` : '✗ Not found';
    if (applied > 0) { applyBtn.style.background = 'var(--green)'; applyBtn.style.borderColor = 'var(--green)'; applyBtn.style.color = 'white'; }
  }
  clearPendingAction(fills._messageIndex, 'pending_field_fills');
}

function renderListingImagesCard(planInput, onGenerate, onApply, onCancel, options = {}) {
  const plan = normalizeListingImagePlan(planInput);
  const displayPlan = enrichListingDisplayItem(plan);
  const copy = cleanUiCopy(plan.ui_copy);
  const el = document.createElement('div');
  el.className = 'agent-action-card agent-action-card-update';
  el.style.borderLeftColor = 'var(--blue,#2563eb)';
  const modeLabel = uiText(copy, `mode_${plan.mode}`, listingImageModeLabel(plan.mode));
  const needsGeneration = plan.mode !== 'delete_selected';
  const generatedCount = plan.generated_images?.length || 0;
  const selectedCount = plan.selected_images?.length || plan.selected_image_ranks?.length || 0;
  const isDraft = plan.listing_id === 'draft' || !plan.listing_id || plan.listing_id === 0 || plan.listing_id === '0';
  const reviewFallback = !needsGeneration
    ? `${selectedCount} selected image${selectedCount === 1 ? '' : 's'} queued for deletion`
    : generatedCount
      ? `${generatedCount}/${plan.count} preview${generatedCount === 1 ? '' : 's'} ready`
      : `${plan.count} new preview${plan.count === 1 ? '' : 's'} - ${plan.aspect_ratio}`;
  const reviewCopy = uiText(copy, 'review_line', reviewFallback);
  const applyLabel = !needsGeneration ? uiText(copy, 'delete_button', 'Delete selected') : (isDraft ? uiText(copy, 'attach_draft_button', 'Add generated images to draft listing') : uiText(copy, 'apply_button', 'Apply to listing'));
  const completed = Boolean(options.completed || plan.status === 'applied' || plan.workflow_state === 'images_attached');
  const completedLabel = isDraft
    ? uiText(copy, 'attached_draft_label', 'Added to draft listing')
    : uiText(copy, 'applied_label', 'Applied to listing');
  const current = (plan.current_images || []).slice(0, 6).map(img => listingThumbHtml(img, 48)).join('');
  const selected = (plan.selected_images || []).map(img => listingThumbHtml(img, 64)).join('');
  const generated = (plan.generated_images || []).map((img, idx) => {
    const slotPurpose = String(plan.slots?.[idx]?.purpose || img.slot?.purpose || '').toLowerCase();
    const isCoverPreview = plan.mode === 'replace_cover' || ['cover', 'hero', 'main', 'thumbnail'].some(token => slotPurpose.includes(token));
    const providerStr = img.provider
      ? (img.provider === 'external' ? `external${img.model ? ` (${img.model})` : ''}` : img.provider + (img.model ? ` (${img.model})` : ''))
      : '';
    return `
    <div class="agent-generated-preview-tile" style="position:relative;width:124px;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg-card)">
      <div style="position:relative;width:124px;height:124px;background:var(--bg-secondary)">
        ${img.preview ? `<img src="${esc(img.preview)}" alt="${esc(uiText(copy, 'generated_image_alt', 'Generated preview'))} ${idx + 1}" data-agent-preview-src="${esc(img.preview)}" style="width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in">` : `<div style="font-size:11px;color:var(--text-3);padding:8px">${esc(uiText(copy, 'saved_image_label', 'Saved image'))}</div>`}
      ${isCoverPreview ? `<div style="position:absolute;left:4px;top:4px;background:var(--orange);color:white;border-radius:4px;padding:1px 5px;font-size:10px">${esc(uiText(copy, 'cover_badge', 'Cover'))}</div>` : ''}
      <div style="position:absolute;left:4px;right:4px;bottom:4px;background:rgba(17,24,39,.72);color:#fff;border-radius:6px;padding:2px 5px;font-size:9px;font-weight:800;text-align:center;text-transform:uppercase">${esc(uiText(copy, 'preview_badge', 'Preview only'))}</div>
      </div>
      <div style="display:flex;gap:4px;padding:5px">
        ${img.preview ? `<button class="btn btn-sm agent-preview-open-btn" data-agent-preview-src="${esc(img.preview)}" style="flex:1;font-size:10px;padding:3px 5px">${esc(uiText(copy, 'view_button', 'View'))}</button>` : ''}
        ${img.preview ? `<a class="btn btn-sm" href="${esc(img.preview)}" download="agent-listing-preview-${idx + 1}.jpg" style="font-size:10px;padding:3px 5px">${esc(uiText(copy, 'download_button', 'Download'))}</a>` : ''}
      </div>
      ${providerStr ? `<details style="font-size:8px;color:var(--text-3);background:var(--bg-secondary);padding:2px 6px;border-top:1px solid var(--border);cursor:pointer;line-height:1.2"><summary style="outline:none;user-select:none">${esc(uiText(copy, 'provider_label', 'AI Provider'))}</summary><div style="padding-top:2px;word-break:break-all;color:var(--text-2)">${esc(providerStr)}</div></details>` : ''}
    </div>`;
  }).join('');
  const slotSummary = needsGeneration && plan.slots?.length ? plan.slots.map((slot, idx) => `
    <li style="margin-bottom:5px"><strong>${idx + 1}. ${esc(slot.purpose || `Image ${idx + 1}`)}</strong>${slot.alt_text ? ` — <span style="color:var(--text-2)">${esc(slot.alt_text)}</span>` : ''}</li>
  `).join('') : '';

  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px">
      ${listingThumbHtml(plan.current_images?.[0] || displayPlan, 58) || (isDraft ? '' : `<div class="agent-action-card-thumb-placeholder" style="width:58px;height:58px">${esc(uiText(copy, 'image_unavailable_label', 'Image unavailable'))}</div>`)}
      <div style="min-width:0;flex:1">
        <div class="agent-action-card-heading" style="margin-bottom:4px">${esc(uiText(copy, 'heading', isDraft ? `New listing draft image set - ${modeLabel}` : `Existing listing images - ${modeLabel}`))}</div>
        <div class="agent-action-card-title">${isDraft ? esc(plan.listing_title || uiText(copy, 'new_listing_draft_title', 'New Listing Draft')) : listingLinkHtml(plan.listing_id, plan.listing_title || `Listing ${plan.listing_id}`, plan.state || plan.listing_state || 'active')}</div>
        <div style="font-size:11px;color:var(--text-2);margin-top:4px">${isDraft ? `${esc(uiText(copy, 'draft_studio_label', 'Draft Studio'))} - ${esc(reviewCopy)}` : `ID ${esc(plan.listing_id)} - ${esc(reviewCopy)}`}</div>
      </div>
    </div>
    ${plan.mode === 'replace_all' || plan.mode === 'replace_cover' || plan.mode === 'replace_selected' ? agentNoticeHtml(uiText(copy, 'replace_notice', 'Old Etsy images are deleted only after new uploads succeed.'), 'warn') : ''}
    ${plan.mode === 'delete_selected' ? agentNoticeHtml(uiText(copy, 'delete_notice', 'Selected Etsy images will be deleted only after you approve this card.'), 'warn') : ''}
    ${current ? `<div style="font-size:11px;color:var(--text-3);margin-bottom:5px;text-transform:uppercase;font-weight:800;letter-spacing:.04em">${esc(uiText(copy, 'current_images_label', 'Current images on Etsy'))}</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${current}</div>` : ''}
    ${selected ? `<div style="font-size:11px;color:var(--orange);margin-bottom:5px;text-transform:uppercase;font-weight:800;letter-spacing:.04em">${esc(uiText(copy, 'selected_images_label', 'Selected for change'))}</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${selected}</div>` : ''}
    ${needsGeneration ? `<div style="font-size:11px;color:var(--text-3);margin-bottom:5px;text-transform:uppercase;font-weight:800;letter-spacing:.04em">${esc(uiText(copy, 'visual_brief_label', 'Visual brief'))}</div><div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.5;color:var(--text-2);max-height:120px;overflow:auto;margin-bottom:10px">${esc(plan.prompt || '')}</div>` : ''}
    ${slotSummary ? `<div style="font-size:11px;color:var(--text-3);margin-bottom:5px;text-transform:uppercase;font-weight:800;letter-spacing:.04em">${esc(uiText(copy, 'slots_label', 'Planned slots / alt text'))}</div><ul style="margin:0 0 10px 18px;padding:0;font-size:12px;line-height:1.45">${slotSummary}</ul>` : ''}
    ${generated ? `<div style="font-size:11px;color:var(--green-text,var(--green));margin-bottom:5px;text-transform:uppercase;font-weight:800;letter-spacing:.04em">${esc(completed ? uiText(copy, 'completed_images_label', 'Generated images') : uiText(copy, 'generated_label', 'Generated previews - awaiting approval'))}</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${generated}</div>${completed ? '' : `<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--text-2);margin-bottom:10px">${esc(uiText(copy, isDraft ? 'generated_help_draft' : 'generated_help_listing', isDraft ? 'Review the generated images. Add them to the draft listing only if they look right.' : 'Review the generated images. The listing will not change until you approve applying them.'))}</div>`}` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${completed
        ? `<button class="btn btn-sm" type="button" disabled aria-disabled="true">${esc(completedLabel)}</button>`
        : `${needsGeneration ? `<button class="btn btn-primary btn-sm" id="listing-img-generate-btn">${esc(plan.generated_images?.length ? (plan.generated_images.length >= plan.count ? uiText(copy, 'regenerate_button', 'Regenerate preview') : uiText(copy, 'continue_button', 'Continue generation')) : uiText(copy, 'generate_button', 'Generate previews'))}</button>` : ''}
          <button class="btn btn-primary btn-sm" id="listing-img-apply-btn" ${(!needsGeneration || plan.generated_images?.length) ? '' : 'disabled'}>${esc(applyLabel)}</button>
          <button class="btn btn-sm" id="listing-img-cancel-btn" style="color:var(--text-3)">${esc(uiText(copy, 'cancel_button', 'Cancel'))}</button>`}
    </div>
    <div id="listing-img-progress" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>`;

  const state = wireActionCard(el, {
    approveSelector: '#listing-img-generate-btn',
    cancelSelector: '#listing-img-cancel-btn',
    progressSelector: '#listing-img-progress',
    onApprove: () => needsGeneration ? onGenerate(plan, el) : onApply(plan, el),
    onCancel: () => onCancel(el),
  }, {
    ...options,
    completed,
    disabledLabel: options.disabledLabel || uiText(copy, 'disabled_label', 'Expired'),
    disabledReason: options.disabledReason || (completed
      ? uiText(copy, 'completed_action_reason', completedLabel)
      : options.restored ? uiText(copy, 'restored_action_reason', 'This action card was restored from chat history after reload and is disabled to prevent stale writes. Ask the agent to prepare a fresh plan.') : undefined),
  });
  const applyBtn = el.querySelector('#listing-img-apply-btn');
  const cancelBtn = el.querySelector('#listing-img-cancel-btn');
  el.querySelectorAll('[data-agent-preview-src]').forEach(node => {
    node.addEventListener('click', event => {
      event.preventDefault();
      window.__agentViewImg?.(node.getAttribute('data-agent-preview-src'));
    });
  });
  if (state.disabled) {
    if (applyBtn) applyBtn.disabled = true;
    if (!needsGeneration && cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.style.display = 'none';
    }
  } else if (applyBtn && (!needsGeneration || plan.generated_images?.length)) {
    applyBtn.onclick = async () => {
      const hydrated = needsGeneration ? { ...plan, generated_images: await hydrateGeneratedImagePreviews(plan.generated_images || []) } : plan;
      await onApply(hydrated, el);
    };
  }
  return el;
}

export function __renderAgentPlanPreviewForTest(plan, options = {}) {
  return renderPlanCard(plan, () => {}, () => {}, options);
}

export function __renderListingImagesPreviewForTest(plan, options = {}) {
  return renderListingImagesCard(plan, () => {}, () => {}, () => {}, options);
}

export function __renderInteractiveListingImagesPreviewForTest(plan, messageIndex = -1, options = {}) {
  return renderListingImagesCard(
    plan,
    (nextPlan, cardEl) => generateListingImages(nextPlan, cardEl, messageIndex),
    (nextPlan, cardEl) => applyListingImages(nextPlan, cardEl, messageIndex),
    (cardEl) => { cardEl.style.opacity = '0.4'; },
    options,
  );
}

export function __renderPriceInventoryPreviewForTest(plan, options = {}) {
  return renderPriceMultiplierInventoryCard(plan, () => {}, () => {}, options);
}

export function __renderAgentDebugTraceForTest(trace) {
  return renderAgentDebugTrace(trace);
}

const AGENT_IMAGE_JOB_TIMEOUT_MS = 120000;
const AGENT_IMAGE_JOB_POLL_GRACE_MS = 30000;

async function pollAgentImageJob(jobId, timeoutMs = AGENT_IMAGE_JOB_TIMEOUT_MS) {
  const started = Date.now();
  let lastPollError = null;
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      const job = await jobs.getStatus(jobId);
      lastPollError = null;
      if (job?.status === 'done') return job.result;
      if (job?.status === 'error') {
        const terminalError = new Error(userFacingErrorMessage(job.error || 'Image generation failed'));
        terminalError.terminal = true;
        throw terminalError;
      }
    } catch (err) {
      if (err?.terminal) throw err;
      lastPollError = err;
    }
  }
  if (lastPollError) throw lastPollError;
  throw new Error(`Image generation timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function generateListingImages(planInput, el, messageIndex) {
  const plan = normalizeListingImagePlan(planInput);
  const copy = plan.ui_copy || {};
  const generationLabel = uiText(copy, 'generation_progress_label', 'Generating image');
  const failedLabel = uiText(copy, 'failed_label', 'failed');
  const generatedSummaryLabel = uiText(copy, 'generated_summary_label', 'Generated');
  const generationReviewHelp = uiText(copy, 'generation_review_help', 'Review the available previews here in chat.');
  const generationFailedLabel = uiText(copy, 'generation_failed_label', 'Generation failed');
  if (plan.mode === 'delete_selected') {
    await applyListingImages(plan, el, messageIndex);
    return;
  }
  const generateBtn = el.querySelector('#listing-img-generate-btn');
  const applyBtn = el.querySelector('#listing-img-apply-btn');
  const cancelBtn = el.querySelector('#listing-img-cancel-btn');
  const progressEl = el.querySelector('#listing-img-progress');
  if (generateBtn) { generateBtn.disabled = true; generateBtn.textContent = `${generationLabel}...`; }
  if (applyBtn) applyBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  try {
    let currentEl = el;
    const existing = plan.generated_images || [];
    const shouldRegenerate = !plan.generation_job_id && existing.length >= plan.count;
    const saved = shouldRegenerate ? [] : existing.map(({ preview, ...img }) => img);
    const previewImages = shouldRegenerate ? [] : await hydrateGeneratedImagePreviews(existing);
    if (shouldRegenerate) {
      const resetPlan = { ...plan, generated_images: [], uploaded_generated_ids: [], uploaded_listing_image_ids: [], deleted_old_image_ids: [], target_old_image_ids: [], generation_job_id: null, status: 'pending' };
      persistListingImagePlan(messageIndex, resetPlan);
      currentEl = replaceListingImagesCard(currentEl, resetPlan, messageIndex);
    }
    const savedRanks = new Set(saved.map(image => Number(image.rank)).filter(Number.isFinite));
    const missingSlotIndexes = Array.from({ length: plan.count }, (_, index) => index)
      .filter(index => !savedRanks.has(index + 1));
    if (missingSlotIndexes.length) {
      setListingImageCardBusy(currentEl, `${generationLabel}...`);
      const provider = localStorage.getItem('image_provider') || 'external';
      const progress = currentEl.querySelector('#listing-img-progress');
      if (progress) progress.innerHTML = `<span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:-2px;margin-right:6px"></span>${esc(generationLabel)}: ${missingSlotIndexes.length}`;
      const jobSlotIndexes = plan.generation_job_id && Array.isArray(plan.generation_slot_indexes)
        ? plan.generation_slot_indexes
        : missingSlotIndexes;
      const prompts = jobSlotIndexes.map(i => {
        const slot = plan.slots?.[i] || {};
        return imageProviderPromptForSlot(plan, slot, i);
      });

      const referenceImage = referenceImageForListingImagePlan(plan, jobSlotIndexes[0] || 0);
      let jobId = plan.generation_job_id || null;
      if (!jobId) {
        const job = await jobs.startImageGeneration({
          prompts,
          aspectRatio: plan.aspect_ratio,
          count: prompts.length,
          provider,
          referenceImage,
          timeoutMs: AGENT_IMAGE_JOB_TIMEOUT_MS,
        });
        jobId = job.id;
        persistListingImagePlan(messageIndex, {
          ...plan,
          generated_images: saved,
          generation_job_id: jobId,
          generation_slot_indexes: jobSlotIndexes,
          generation_started_at: new Date().toISOString(),
          status: 'generating',
        });
      }

      const result = await pollAgentImageJob(jobId, AGENT_IMAGE_JOB_TIMEOUT_MS + AGENT_IMAGE_JOB_POLL_GRACE_MS);
      const returned = (result?.images || []).filter(image => image?.base64);
      const errors = [];
      if (returned.length < prompts.length) errors.push(`Only ${returned.length} of ${prompts.length} images were returned.`);
      if (!returned.length) throw new Error(errors.join(' | ') || 'No images were returned.');
      let completed = 0;
      let hasError = false;
      const totalToGenerate = returned.length;
      const completedLabel = uiText(copy, 'completed_label', 'done');

      for (let offset = 0; offset < returned.length; offset++) {
        const promptIndex = Number.isInteger(returned[offset]?.prompt_index) ? returned[offset].prompt_index : offset;
        const i = jobSlotIndexes[promptIndex];
        if (!Number.isInteger(i) || saved.some(image => Number(image.rank) === i + 1)) continue;
        const slot = plan.slots?.[i] || null;
        const prompt = prompts[promptIndex];
        const img = returned[offset];
        const slotLabel = slot?.purpose || `Image ${i + 1}`;

        // Update progress UI for current slot
        const liveProgress = currentEl.querySelector('#listing-img-progress');
        if (liveProgress) {
          const counters = [
            completed > 0 ? `✓ ${completed} ${esc(completedLabel)}` : '',
            errors.length > 0 ? `${errors.length} ${esc(failedLabel)}` : '',
          ].filter(Boolean).join(' · ');
          liveProgress.innerHTML = `<span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:-2px;margin-right:6px"></span>${counters ? `${counters} · ` : ''}${esc(generationLabel)} ${offset + 1}/${totalToGenerate}${slotLabel ? ` — ${esc(slotLabel)}` : ''}...`;
        }

        try {
          const id = await saveImage({ base64: img.base64, mimeType: img.mimeType || 'image/jpeg', prompt, slotLabel: slot?.purpose || `Agent ${i + 1}`, listingTitle: plan.listing_title || '', provider: img.provider, model: img.model });
          const savedItem = { id, mimeType: img.mimeType || 'image/jpeg', rank: i + 1, ...(slot ? { slot } : {}), ...(img.provider ? { provider: img.provider } : {}), ...(img.model ? { model: img.model } : {}) };
          const previewItem = { ...savedItem, preview: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` };

          saved.push(savedItem);
          previewImages.push(previewItem);
          saved.sort((a, b) => a.rank - b.rank);
          previewImages.sort((a, b) => a.rank - b.rank);
          completed++;
        } catch (err) {
          hasError = true;
          errors.push(err.message);
        }

        // Persist each completed slot while the server job remains resumable.
        const storedPlan = { ...plan, generated_images: saved, generation_job_id: jobId, generation_slot_indexes: jobSlotIndexes, status: 'generating' };
        const previewPlan = { ...storedPlan, generated_images: previewImages };
        persistListingImagePlan(messageIndex, storedPlan);
        currentEl = replaceListingImagesCard(currentEl, previewPlan, messageIndex);
        setListingImageCardBusy(currentEl, `${generationLabel}...`);
      }

      if (hasError && saved.length === 0) {
        throw new Error([...new Set(errors)].join(' | '));
      }
      const finalStoredPlan = {
        ...plan,
        generated_images: saved,
        generation_job_id: null,
        generation_slot_indexes: [],
        status: saved.length ? 'generated' : 'pending',
        generated_at: new Date().toISOString(),
      };
      persistListingImagePlan(messageIndex, finalStoredPlan);
      currentEl = replaceListingImagesCard(currentEl, { ...finalStoredPlan, generated_images: previewImages }, messageIndex);
      const nextProgress = currentEl.querySelector('#listing-img-progress');
      if (nextProgress) nextProgress.innerHTML = `<strong style="color:var(--green-text,var(--green))">${esc(generatedSummaryLabel)} ${saved.length}/${plan.count}.</strong>${errors.length ? ` ${errors.length} ${esc(failedLabel)}.` : ''} ${esc(generationReviewHelp)}`;
    }
    toastSuccess(`${generatedSummaryLabel}: ${saved.length}`);
  } catch (e) {
    const message = userFacingErrorMessage(e.message);
    if (messageIndex !== undefined && messageIndex >= 0 && agentMessages[messageIndex]?.pending_listing_images) {
      persistListingImagePlan(messageIndex, {
        ...agentMessages[messageIndex].pending_listing_images,
        generation_job_id: null,
        status: 'pending',
        generation_error: message,
      });
    }
    const activeProgress = document.body.contains(el) ? progressEl : document.querySelector('#listing-img-progress');
    const activeGenerate = document.body.contains(el) ? generateBtn : document.querySelector('#listing-img-generate-btn');
    const activeCancel = document.body.contains(el) ? cancelBtn : document.querySelector('#listing-img-cancel-btn');
    if (activeProgress) activeProgress.textContent = `${generationFailedLabel}: ${message}`;
    if (activeGenerate) { activeGenerate.disabled = false; activeGenerate.textContent = uiText(copy, 'retry_button', 'Retry generation'); }
    if (activeCancel) activeCancel.disabled = false;
    toastError(`${generationFailedLabel}: ${message}`);
  }
}

async function applyListingImages(planInput, el, messageIndex) {
  const plan = normalizeListingImagePlan(planInput);
  const applyBtn = el.querySelector('#listing-img-apply-btn');
  const generateBtn = el.querySelector('#listing-img-generate-btn');
  const cancelBtn = el.querySelector('#listing-img-cancel-btn');
  const progressEl = el.querySelector('#listing-img-progress');
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying...'; }
  if (generateBtn) generateBtn.disabled = true;
  if (cancelBtn) cancelBtn.style.display = 'none';
  try {
    const generated = plan.generated_images || [];
    const needsGeneration = plan.mode !== 'delete_selected';
    const isDraft = plan.listing_id === 'draft' || !plan.listing_id || plan.listing_id === 0 || plan.listing_id === '0';
    const currentDraft = isDraft ? getLatestAgentDraft() : null;
    const transition = validateListingImageTransition({ action: 'apply_to_listing', plan, draft: currentDraft });
    if (!transition.ok) {
      const transitionError = new Error(transition.fault.safe_message);
      transitionError.runtime_fault = transition.fault;
      throw transitionError;
    }
    if (isDraft) {
      const storedImageIds = generated.map(image => String(image?.id || '')).filter(Boolean);
      if (!storedImageIds.length) throw new Error('The generated image records are unavailable. Generate the previews again before attaching them.');
      // Keep binary image data in IndexedDB. sessionStorage has a small quota and
      // must never carry generated data URLs between the Agent and Create pages.
      const draftWithImages = {
        ...currentDraft,
        storedImageIds: [...new Set([...(currentDraft.storedImageIds || []), ...storedImageIds])],
        workflow_state: 'images_attached',
      };
      persistCurrentAgentDraft(draftWithImages, messageIndex);
      if (progressEl) progressEl.textContent = 'Opening the listing draft with saved images...';
      const opened = await navigateToAgentDraftCreate(draftWithImages);
      if (!opened) throw new Error('Could not open the listing draft. Your generated images remain safely saved in the gallery.');
      if (applyBtn) {
         applyBtn.textContent = 'Attached to draft';
         applyBtn.disabled = true;
         applyBtn.style.background = 'var(--green)';
         applyBtn.style.borderColor = 'var(--green)';
         applyBtn.style.color = 'white';
      }
      if (progressEl) progressEl.innerHTML = `<strong style="color:var(--green-text,var(--green))">Attached.</strong> Redirecting...`;
      if (messageIndex !== undefined && messageIndex >= 0 && agentMessages[messageIndex]) {
        const completedPlan = { ...plan, status: 'applied', workflow_state: 'images_attached' };
        agentMessages[messageIndex].listing_image_result = {
          ...imagePlanResult(completedPlan),
          status: 'applied',
          message: 'Generated images added to draft listing.',
        };
        agentMessages[messageIndex].pending_listing_images = completedPlan;
        saveHistory(agentMessages);
      }
      return { ok: true };
    }
    let currentImages = plan.current_images || [];
    if (plan.mode !== 'add') {
      const currentRes = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'getImages', listing_id: plan.listing_id }) });
      const currentData = await currentRes.json();
      if (!currentRes.ok || currentData.error) throw new Error(currentData.error || 'Could not read current Etsy images before replacement.');
      currentImages = listingImagesFromApi(currentData);
    }
    const selectedImages = resolveSelectedListingImages(plan, currentImages);
    const uploadStartRank = plan.mode === 'add' ? currentImages.length + 1 : plan.mode === 'replace_selected' && selectedImages.length ? selectedImages[0].rank || 1 : 1;
    const uploadedGeneratedIds = new Set((plan.uploaded_generated_ids || []).map(String));
    const uploadedListingImageIds = new Set((plan.uploaded_listing_image_ids || []).map(String));
    const uploadedIds = new Set(uploadedListingImageIds);
    const uploadErrors = [];
    const targetOldImageIds = new Set((plan.target_old_image_ids || []).map(String));
    const deletedOldImageIds = new Set((plan.deleted_old_image_ids || []).map(String));
    const initialDeleteTargets = plan.mode === 'replace_all'
      ? currentImages
      : plan.mode === 'replace_cover'
        ? currentImages.slice(0, 1)
        : plan.mode === 'replace_selected' || plan.mode === 'delete_selected'
          ? selectedImages
          : [];
    initialDeleteTargets.forEach(img => { if (img.listing_image_id) targetOldImageIds.add(String(img.listing_image_id)); });
    uploadedListingImageIds.forEach(id => targetOldImageIds.delete(String(id)));
    if ((plan.mode === 'delete_selected' || plan.mode === 'replace_selected') && !targetOldImageIds.size) throw new Error('Selected images could not be matched on Etsy. Prepare a fresh plan and try again.');
    for (let i = 0; i < generated.length; i++) {
      if (uploadedGeneratedIds.has(String(generated[i].id))) continue;
      if (progressEl) progressEl.textContent = `Uploading ${i + 1}/${generated.length}...`;
      try {
        const stored = await getImage(generated[i].id);
        if (!stored?.base64) throw new Error(`Generated image ${i + 1} is missing from local storage.`);
        const uploadRes = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'uploadImage',
            listing_id: plan.listing_id,
            imageBase64: stored.base64,
            contentType: stored.mimeType || generated[i].mimeType || 'image/jpeg',
            rank: uploadStartRank + i,
            overwrite: false,
            ...(generated[i].slot?.alt_text || plan.slots?.[i]?.alt_text ? { alt_text: generated[i].slot?.alt_text || plan.slots?.[i]?.alt_text } : {}),
          }),
        });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok || uploadData.error) throw new Error(uploadData.error || 'Upload failed');
        if (uploadData.data?.listing_image_id) {
          uploadedIds.add(String(uploadData.data.listing_image_id));
          uploadedListingImageIds.add(String(uploadData.data.listing_image_id));
        }
        uploadedGeneratedIds.add(String(generated[i].id));
        persistListingImagePlan(messageIndex, { ...plan, selected_images: selectedImages, target_old_image_ids: [...targetOldImageIds], uploaded_generated_ids: [...uploadedGeneratedIds], uploaded_listing_image_ids: [...uploadedListingImageIds], deleted_old_image_ids: [...deletedOldImageIds] });
      } catch (e) {
        uploadErrors.push(e.message);
      }
    }
    if (needsGeneration && !uploadedGeneratedIds.size) throw new Error(uploadErrors.join('; ') || 'No images uploaded.');
    const deleteTargets = uploadErrors.length ? [] : currentImages.filter(img => targetOldImageIds.has(String(img.listing_image_id)));
    const deleteErrors = [];
    for (let i = 0; i < deleteTargets.length; i++) {
      const imageId = deleteTargets[i].listing_image_id;
      if (!imageId) continue;
      if (deletedOldImageIds.has(String(imageId))) continue;
      if (uploadedIds.has(String(imageId))) continue;
      if (uploadedListingImageIds.has(String(imageId))) continue;
      if (progressEl) progressEl.textContent = `Removing old image ${i + 1}/${deleteTargets.length}...`;
      try {
        const delRes = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'deleteImage', listing_id: plan.listing_id, listing_image_id: imageId }),
        });
        const delData = await delRes.json();
        if (!delRes.ok || delData.error) throw new Error(delData.error || 'Delete failed');
        deletedOldImageIds.add(String(imageId));
        persistListingImagePlan(messageIndex, { ...plan, selected_images: selectedImages, target_old_image_ids: [...targetOldImageIds], uploaded_generated_ids: [...uploadedGeneratedIds], uploaded_listing_image_ids: [...uploadedListingImageIds], deleted_old_image_ids: [...deletedOldImageIds] });
      } catch (e) {
        deleteErrors.push(e.message);
      }
    }
    const errors = [...uploadErrors, ...deleteErrors];
    if (progressEl) progressEl.textContent = errors.length
      ? `${needsGeneration ? `Uploaded ${uploadedGeneratedIds.size}/${generated.length}; ` : ''}old images ${deleteTargets.length ? 'partially updated' : 'kept'}. Failed: ${errors.join('; ')}`
      : plan.mode === 'delete_selected'
        ? `Deleted ${deletedOldImageIds.size} selected image${deletedOldImageIds.size === 1 ? '' : 's'} from listing ${plan.listing_id}.`
        : `Applied ${uploadedGeneratedIds.size} image${uploadedGeneratedIds.size === 1 ? '' : 's'} to listing ${plan.listing_id}.`;
    if (progressEl && !errors.length) {
      progressEl.innerHTML = `<strong style="color:var(--green-text,var(--green))">Applied to listing.</strong> ${progressEl.textContent}`;
    }
    if (applyBtn) {
      applyBtn.textContent = errors.length ? '↻ Retry apply' : 'Applied';
      applyBtn.disabled = !errors.length;
      if (!errors.length) { applyBtn.style.background = 'var(--green)'; applyBtn.style.borderColor = 'var(--green)'; applyBtn.style.color = 'white'; }
    }
    if (messageIndex !== undefined && messageIndex >= 0 && agentMessages[messageIndex]) {
      const nextPlan = { ...plan, selected_images: selectedImages, target_old_image_ids: [...targetOldImageIds], uploaded_generated_ids: [...uploadedGeneratedIds], uploaded_listing_image_ids: [...uploadedListingImageIds], deleted_old_image_ids: [...deletedOldImageIds] };
      if (errors.length) {
        agentMessages[messageIndex].pending_listing_images = nextPlan;
      } else {
        const completedPlan = { ...nextPlan, status: 'applied' };
        agentMessages[messageIndex].listing_image_result = imagePlanResult(completedPlan);
        agentMessages[messageIndex].pending_listing_images = completedPlan;
      }
      saveHistory(agentMessages);
    }
    if (errors.length) {
      const partialFault = createAgentRuntimeFault({
        code: 'APP_LISTING_IMAGE_APPLY_PARTIAL',
        operation: 'apply_listing_images',
        fault_domain: 'provider',
        retryable: true,
        recovery: 'retry_idempotent_operation',
        workflow_id: plan.workflow_id || '',
        safe_message: 'Etsy AI Command Center applied only part of the image plan. Completed uploads were preserved for a safe retry.',
      });
      recordAgentRuntimeFault(partialFault, { messageIndex });
      toastError(agentRuntimeUserMessage(partialFault));
      return { ok: false, fault: partialFault, partial: true };
    }
    toastSuccess('Listing images updated');
    return { ok: true };
  } catch (e) {
    const fault = e?.runtime_fault || classifyAgentRuntimeError(e, {
      operation: 'apply_listing_images',
      workflow_id: plan.workflow_id || '',
      state: listingWorkflowSnapshot({ plan, draft: getLatestAgentDraft() }).state,
      code: 'APP_LISTING_IMAGE_APPLY_FAILED',
      fault_domain: 'provider',
      retryable: true,
      recovery: 'retry_idempotent_operation',
      safe_message: 'Etsy AI Command Center could not finish applying the image plan.',
    });
    const runtimeRecord = recordAgentRuntimeFault(fault, { messageIndex });
    if (progressEl) progressEl.textContent = runtimeRecord.content;
    if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = '↻ Retry apply'; }
    toastError(runtimeRecord.content);
    return { ok: false, fault };
  }
}

function cancelPendingCard(cardEl, messageIndex, key, buttonSelectors = []) {
  cardEl.style.opacity = '0.4';
  for (const selector of buttonSelectors) {
    const button = cardEl.querySelector(selector);
    if (button) button.disabled = true;
  }
  clearPendingAction(messageIndex, key);
}

async function executeClearVariations(plan, el, messageIndex) {
  const approveBtn = el.querySelector('#clear-var-approve-btn');
  const cancelBtn = el.querySelector('#clear-var-cancel-btn');
  const progressEl = el.querySelector('#clear-var-progress');
  if (approveBtn) { approveBtn.disabled = true; approveBtn.textContent = 'Removing...'; }
  if (cancelBtn) cancelBtn.style.display = 'none';

  let done = 0;
  const errors = [];
  const failedItems = [];
  for (const item of plan.listings || []) {
    if (progressEl) progressEl.textContent = `Removing variations ${done + 1} / ${plan.listings.length}...`;
    try {
      const res = await fetch('/api/etsy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'clearListingVariations',
          listing_id: item.listing_id,
          products: item.clear_to?.products || [],
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(apiErrorMessage(data, 'Inventory API error'));
      done++;
    } catch (e) {
      errors.push(`${item.listing_id}: ${e.message}`);
      failedItems.push(item);
    }
  }

  if (progressEl) progressEl.textContent = errors.length
    ? `Removed ${done}/${plan.listings.length}; failed: ${errors.join('; ')}`
    : `Removed variations from ${done} listing${done === 1 ? '' : 's'}.`;
  if (errors.length) {
    plan.listings = failedItems;
    if (agentMessages[messageIndex]) agentMessages[messageIndex].pending_clear_variations = plan;
    saveHistory(agentMessages);
    if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Retry failed'; }
  } else {
    if (approveBtn) approveBtn.textContent = 'Done';
    clearPendingAction(messageIndex, 'pending_clear_variations');
  }
  if (done) invalidate('listings');
  if (done) toastSuccess(`Removed variations from ${done} listing${done === 1 ? '' : 's'}`);
  if (errors.length) toastError('Some variations were not removed');
}

async function executeRemoveVariationProperty(plan, el, messageIndex) {
  const approveBtn = el.querySelector('#remove-var-prop-approve-btn');
  const cancelBtn = el.querySelector('#remove-var-prop-cancel-btn');
  const progressEl = el.querySelector('#remove-var-prop-progress');
  if (approveBtn) { approveBtn.disabled = true; approveBtn.textContent = 'Updating...'; }
  if (cancelBtn) cancelBtn.style.display = 'none';

  let done = 0;
  const errors = [];
  const failedItems = [];
  for (const item of plan.listings || []) {
    if (progressEl) progressEl.textContent = `Updating variations ${done + 1} / ${plan.listings.length}...`;
    try {
      const res = await fetch('/api/etsy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateListingVariationInventory',
          listing_id: item.listing_id,
          products: item.update_to?.products || [],
          price_on_property: item.update_to?.price_on_property || [],
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(apiErrorMessage(data, 'Inventory API error'));
      done++;
    } catch (e) {
      errors.push(`${item.listing_id}: ${e.message}`);
      failedItems.push(item);
    }
  }

  if (progressEl) progressEl.textContent = errors.length
    ? `Updated ${done}/${plan.listings.length}; failed: ${errors.join('; ')}`
    : `Updated variations on ${done} listing${done === 1 ? '' : 's'}.`;
  if (errors.length) {
    plan.listings = failedItems;
    if (agentMessages[messageIndex]) agentMessages[messageIndex].pending_remove_variation_property = plan;
    saveHistory(agentMessages);
    if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Retry failed'; }
  } else {
    if (approveBtn) approveBtn.textContent = 'Done';
    clearPendingAction(messageIndex, 'pending_remove_variation_property');
  }
  if (done) invalidate('listings');
  if (done) toastSuccess(`Updated variations on ${done} listing${done === 1 ? '' : 's'}`);
  if (errors.length) toastError('Some variation updates failed');
}

async function executePriceMultiplierInventory(plan, el, messageIndex) {
  const approveBtn = el.querySelector('#price-mult-approve-btn');
  const cancelBtn = el.querySelector('#price-mult-cancel-btn');
  const progressEl = el.querySelector('#price-mult-progress');
  if (approveBtn) { approveBtn.disabled = true; approveBtn.textContent = 'Updating prices...'; }
  if (cancelBtn) cancelBtn.style.display = 'none';

  let done = 0;
  const errors = [];
  const failedItems = [];
  for (const item of plan.listings || []) {
    if (progressEl) progressEl.textContent = `Updating inventory prices ${done + 1} / ${plan.listings.length}...`;
    try {
      const res = await fetch('/api/etsy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateListingVariationInventory',
          listing_id: item.listing_id,
          products: item.update_to?.products || [],
          price_on_property: item.update_to?.price_on_property || [],
          quantity_on_property: item.update_to?.quantity_on_property || [],
          sku_on_property: item.update_to?.sku_on_property || [],
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(apiErrorMessage(data, 'Inventory API error'));
      done++;
    } catch (e) {
      errors.push(`${item.listing_id}: ${e.message}`);
      failedItems.push(item);
    }
  }

  if (progressEl) progressEl.innerHTML = errors.length
    ? `<strong style="color:var(--red-text)">Apply incomplete.</strong> ${esc(`Updated ${done}/${plan.listings.length}; failed: ${errors.join('; ')}`)}`
    : `<strong style="color:var(--green-text,var(--green))">Applied to Etsy after approval.</strong> ${esc(`Updated inventory prices on ${done} listing${done === 1 ? '' : 's'}; variations preserved.`)}`;
  if (approveBtn) {
    approveBtn.textContent = errors.length ? 'Retry failed' : 'Done';
    approveBtn.disabled = !errors.length;
    if (!errors.length) { approveBtn.style.background = 'var(--green)'; approveBtn.style.borderColor = 'var(--green)'; approveBtn.style.color = 'white'; }
  }
  if (errors.length) {
    plan.listings = failedItems;
    if (agentMessages[messageIndex]) agentMessages[messageIndex].pending_price_multiplier_inventory = plan;
    saveHistory(agentMessages);
  } else {
    clearPendingAction(messageIndex, 'pending_price_multiplier_inventory');
  }
  if (done) invalidate('listings');
  if (done) toastSuccess(`Updated prices on ${done} listing${done === 1 ? '' : 's'}`);
  if (errors.length) toastError('Some price updates failed');
}

// ── Execute approved duplicate ────────────────────────────
async function executeDuplicate(dup, el, messageIndex) {
  const persistedDuplicate = agentMessages[messageIndex]?.pending_duplicate || {};
  dup = normalizeDuplicateProposal({
    ...dup,
    created_listing_id: Number(dup?.created_listing_id || persistedDuplicate.created_listing_id || 0) || undefined,
  });
  const approveBtn = el.querySelector('#dup-approve-btn');
  const cancelBtn  = el.querySelector('#dup-cancel-btn');
  const progressEl = el.querySelector('#dup-progress');
  if (approveBtn) { approveBtn.disabled = true; approveBtn.textContent = 'Creating…'; }
  if (cancelBtn)  cancelBtn.style.display = 'none';

  try {
    let dupData = {};
    let newListingId = Number(dup.created_listing_id || 0) || null;
    if (!newListingId) {
      if (progressEl) progressEl.textContent = 'Duplicating listing...';
      const dupRes = await fetch('/api/etsy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'duplicateListing',
          listing_id: dup.source_listing_id,
          ...(dup.personalization_questions?.length ? { personalization_questions: dup.personalization_questions } : {}),
        }),
      });
      dupData = await dupRes.json();
      if (!dupRes.ok || dupData.error) throw new Error(dupData.error || 'Failed to duplicate listing');
      newListingId = dupData.data?.listing_id || dupData.listing_id;
      dup.created_listing_id = newListingId;
      if (agentMessages[messageIndex]) {
        agentMessages[messageIndex].pending_duplicate = dup;
        saveHistory(agentMessages);
      }
    }

    // Note: Images are being copied in the background and may take a few moments to appear

    // Now apply user's changes if any were specified
    const hasChanges = dup.title || dup.description || dup.tags || dup.price;
    if (hasChanges) {
      if (progressEl) progressEl.textContent = 'Applying your changes...';

      const updates = {};
      if (dup.title) updates.title = clampEtsyTitle(dup.title);
      if (dup.description) updates.description = dup.description;
      if (dup.tags) updates.tags = dup.tags;
      if (dup.price) updates.price = dup.price;

      const updateRes = await fetch('/api/etsy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateListing', listing_id: newListingId, ...updates }),
      });
      const updateData = await updateRes.json();
      if (!updateRes.ok || updateData.error) {
        throw new Error(`Listing ${newListingId} was created, but its requested changes failed: ${updateData.error || 'unknown update error'}`);
      } else {
        toastSuccess('Changes applied successfully!');
      }
    }

    const copied = [];
    if (dupData.data?.inventory_copied) copied.push('variations');
    if (dupData.data?.personalization_copied) copied.push('personalization');
    if (progressEl) progressEl.textContent = `✓ Created listing ${newListingId}${hasChanges ? ' with your changes' : ''}${copied.length ? `; copied ${copied.join(' and ')}` : ''}!`;
    if (approveBtn) {
      approveBtn.textContent = '✓ Created!';
      approveBtn.disabled = true;
      approveBtn.style.background = 'var(--green)';
      approveBtn.style.borderColor = 'var(--green)';
      approveBtn.style.color = 'white';
      // Add buttons to view on Etsy and edit
      const btnContainer = document.createElement('div');
      btnContainer.style.cssText = 'display:inline-flex;gap:8px;margin-left:8px';
      btnContainer.innerHTML = `
        ${viewOnEtsyButton(newListingId, { icon: false, state: 'draft' })}
        <button onclick="window.location.hash='create?id=${newListingId}'" class="btn btn-primary btn-sm">
          Edit Listing
        </button>
      `;
      approveBtn.parentElement.appendChild(btnContainer);
    }

    const duplicateResult = buildDuplicateResult(dup, newListingId);
    if (messageIndex !== undefined && messageIndex >= 0 && agentMessages[messageIndex]) {
      agentMessages[messageIndex].pending_duplicate = null;
      agentMessages[messageIndex].duplicate_result = duplicateResult;
    }
    if (duplicateResult.image_url) set(`listing:${newListingId}`, { listing_id: newListingId, title: duplicateResult.new_listing_title, image_url: duplicateResult.image_url });
      const resultMsg = `✓ Listing duplicated successfully! New listing ID: ${newListingId}. Future edits in this chat will target this duplicate unless you explicitly ask for another copy.`;
    agentMessages.push({ role: 'assistant', content: resultMsg });
    saveHistory(agentMessages);
    toastSuccess('Listing duplicated!');
  } catch (e) {
    if (progressEl) progressEl.textContent = 'Failed: ' + e.message;
    if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = dup.created_listing_id ? 'Retry remaining changes' : 'Retry'; }
    toastError('Duplication failed: ' + e.message);
  }
}

// ── Execute approved social post ──────────────────────────
async function executeSocialPost(post, el, messageIndex) {
  const approveBtn = el.querySelector('#social-approve-btn');
  const cancelBtn  = el.querySelector('#social-cancel-btn');
  const progressEl = el.querySelector('#social-progress');
  if (approveBtn) { approveBtn.disabled = true; approveBtn.textContent = 'Posting…'; }
  if (cancelBtn)  cancelBtn.style.display = 'none';

  try {
    const res = await fetch('/api/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:     'smartPost',
        text:       post.caption,
        platform:   post.platform || 'all',
        listing_id: post.listing_id || null,
        title:      post.listing_title || '',
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Social post failed');

    if (progressEl) progressEl.textContent = `✓ Posted via ${data.method || 'social'}!`;
    if (approveBtn) approveBtn.textContent = '✓ Posted!';
    clearPendingAction(messageIndex, 'pending_social_post');

    const resultMsg = `✓ Social post published via ${data.method || 'social hub'}!`;
    agentMessages.push({ role: 'assistant', content: resultMsg });
    saveHistory(agentMessages);
    toastSuccess('Posted to social media!');
  } catch (e) {
    if (progressEl) progressEl.textContent = 'Failed: ' + e.message;
    if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = '↻ Retry'; }
    toastError('Social post failed: ' + e.message);
  }
}

// ── Execute approved updates ──────────────────────────────
async function executeUpdates(plan, planEl, messageIndex) {
  const approveBtn = planEl.querySelector('#plan-approve-btn');
  const cancelBtn  = planEl.querySelector('#plan-cancel-btn');
  const progressEl = planEl.querySelector('#plan-progress');
  if (approveBtn) { approveBtn.disabled = true; approveBtn.textContent = 'Applying…'; }
  if (cancelBtn)  cancelBtn.style.display = 'none';

  let done = 0, failed = 0;
  const errors = [];
  const failedUpdates = [];
  for (const u of plan.updates) {
    const normalizedUpdate = normalizePlanUpdate(u);
    const { listing_id } = normalizedUpdate;
    const fields = listingWriteFields(normalizedUpdate);

    // Check if there are any fields to update
    if (Object.keys(fields).length === 0) {
      console.warn('No fields to update for listing', listing_id);
      failed++;
      failedUpdates.push(u);
      continue;
    }

    const { personalization_questions, ...listingFields } = fields;
    const hasListingFields = Object.keys(listingFields).length > 0;
    const hasPersonalization = personalization_questions !== undefined;

    if (progressEl) progressEl.textContent = `Updating ${done + 1} / ${plan.updates.length}…`;
    console.log('Updating listing', listing_id, 'with fields:', fields);

    try {
      if (hasListingFields) {
        const res = await fetch('/api/etsy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'updateListing', listing_id, ...listingFields }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(apiErrorMessage(data, 'API error'));
      }
      if (hasPersonalization) {
        const res = await fetch('/api/etsy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'updateListingPersonalization', listing_id, personalization_questions }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(apiErrorMessage(data, 'Personalization API error'));
      }
      done++;
    } catch (e) {
      failed++;
      failedUpdates.push(u);
      errors.push(`${listing_id}: ${e.message}`);
      console.warn('Update failed for', listing_id, e.message);
    }
  }

  if (progressEl) {
    if (failed) {
      progressEl.innerHTML = `<strong style="color:var(--red-text)">Apply incomplete.</strong> ${esc(`Failed to update ${failed}/${plan.updates.length}: ${errors.join('; ') || 'unknown error'}`)}`;
    } else {
      progressEl.innerHTML = `<strong style="color:var(--green-text,var(--green))">Applied to Etsy after approval.</strong> ${esc(`All ${done} listing${done === 1 ? '' : 's'} updated.`)}`;
    }
  }
  if (approveBtn) { approveBtn.textContent = done > 0 ? `✓ Done (${done}/${plan.updates.length})` : '✗ Failed'; }

  if (failed) {
    plan.updates = failedUpdates;
    if (agentMessages[messageIndex]) agentMessages[messageIndex].pending_updates = plan;
    saveHistory(agentMessages);
    if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Retry failed'; }
  } else {
    clearPendingAction(messageIndex, 'pending_updates');
  }
  if (done) invalidate('listings');

  if (done > 0) toastSuccess(`${done} listing${done !== 1 ? 's' : ''} updated!`);
  else toastError('No listings were updated');
}

// ── Image attachment state ────────────────────────────────
let attachedImage = null; // { base64, mimeType, preview, originalBase64, originalMimeType, originalDataUrl }

// Resize image client-side to ≤800px before storing/sending
function resizeImageForChat(dataUrl, mimeType) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const MAX = 800;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL('image/jpeg', 0.85);
      resolve({ preview: out, base64: out.split(',')[1], mimeType: 'image/jpeg' });
    };
    img.onerror = () => {
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      resolve({ preview: dataUrl, base64, mimeType });
    };
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = e => resolve(e.target.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function draftImagesFromAttachment(img) {
  if (!img) return [];
  const base64 = img.originalBase64 || img.base64;
  const mimeType = img.originalMimeType || img.mimeType || 'image/jpeg';
  if (!base64 || !mimeType.startsWith('image/')) return [];
  return [{
    base64,
    mimeType,
    filename: img.filename || `agent-attached-${Date.now()}.${mimeType.split('/')[1]?.split('+')[0] || 'jpg'}`,
    preview: img.originalDataUrl || img.preview || `data:${mimeType};base64,${base64}`,
    source: 'agent_upload',
  }];
}

function listingReferenceImageFromAttachment(img) {
  if (!img) return null;
  const base64 = img.originalBase64 || img.base64;
  const mimeType = img.originalMimeType || img.mimeType || 'image/jpeg';
  if (!base64 || !mimeType.startsWith('image/')) return null;
  return {
    base64,
    mimeType,
    filename: img.filename || 'reference-image.jpg',
  };
}

function attachedImageContext(img, analysis) {
  if (!img) return {};
  return {
    attached_image: {
      filename: img.filename || 'attached image',
      mime_type: img.originalMimeType || img.mimeType || '',
      analysis: String(analysis || '').slice(0, 4000),
      available_as_original_listing_image: true,
      available_as_reference_image: true,
      note: 'The uploaded original is available both as an unchanged listing image and as a visual reference. The model must choose generate_listing_content.attached_image_role when creating a listing from this attachment.',
    },
  };
}

function apiErrorMessage(data, fallback = 'API error') {
  const details = data?.details;
  const detailText = data?.detail_text || details?.error_description || details?.error || details?.message || details?.raw;
  const requestText = data?.request ? ` Request: ${JSON.stringify(data.request)}` : '';
  return `${detailText || data?.error || fallback}${requestText}`;
}

// ── Model preference ──────────────────────────────────────
const MODEL_KEY = 'agent_model';
export function getAgentModel() {
  const key = scopedClientKey(MODEL_KEY);
  const value = localStorage.getItem(key) || localStorage.getItem(MODEL_KEY) || 'auto';
  if (!localStorage.getItem(key)) localStorage.setItem(key, value);
  return value;
}
export function setAgentModel(v) { localStorage.setItem(scopedClientKey(MODEL_KEY), v); }

const AGENT_MODEL_OPTIONS = {
  auto: { label: 'Auto', detail: 'Auto · safest available model' },
  external: { label: 'External AI', detail: 'Project model' },
  gemini: { label: 'Gemini', detail: 'Gemini' },
  claude: { label: 'Claude', detail: 'Claude' },
};

// ── Persistent agent memory (KV primary + localStorage cache) ────────────────
const MEMORY_STORAGE_KEY = 'agent_memory_items';
let shopMemoryCache = { items: [] };

export function loadMemories() {
  try {
    return JSON.parse(localStorage.getItem(scopedClientKey(MEMORY_STORAGE_KEY)) || localStorage.getItem(MEMORY_STORAGE_KEY) || '[]');
  } catch { return []; }
}
// On page load: pull KV into localStorage cache
async function _kvSyncMemories() {
  try {
    const items = await kv.getAgentMemory();
    if (Array.isArray(items)) localStorage.setItem(scopedClientKey(MEMORY_STORAGE_KEY), JSON.stringify(items));
  } catch {}
}
async function _kvSyncShopMemories() {
  try {
    const value = await kv.getShopOperatingContext();
    shopMemoryCache = value && typeof value === 'object' ? value : { items: [] };
  } catch {}
  return shopMemoryCache;
}
function loadShopMemories() {
  return Array.isArray(shopMemoryCache?.items) ? shopMemoryCache.items : [];
}
function saveMemoryItem(item, syncServer = true) {
  const items = loadMemories();
  if (!items.some(existing => existing.id === item.id || existing.text?.toLowerCase() === item.text?.toLowerCase())) items.unshift(item);
  localStorage.setItem(scopedClientKey(MEMORY_STORAGE_KEY), JSON.stringify(items));
  if (syncServer) kv.setAgentMemory(items).catch(() => {});
}
function deleteMemoryItem(id, syncServer = true) {
  const items = loadMemories().filter(m => m.id !== id);
  localStorage.setItem(scopedClientKey(MEMORY_STORAGE_KEY), JSON.stringify(items));
  if (syncServer) kv.setAgentMemory(items).catch(() => {});
}
function memoryId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Batch schedule card ───────────────────────────────────
function renderBatchScheduleCard(batch, onApprove, onCancel, options = {}) {
  const el = document.createElement('div');
  el.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--orange-border);border-radius:10px;padding:14px 16px;margin:8px 0';

  const rows = (batch.posts || []).map(p => {
    const date = p.scheduled_at ? new Date(p.scheduled_at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : 'Draft';
    const platform = esc(p.platform || 'all');
    const preview  = esc((p.caption || '').slice(0, 60)) + ((p.caption?.length > 60) ? '…' : '');
    const thumb = listingThumbHtml(p, 34);
    return `<tr>
      <td style="padding:4px 8px;border:1px solid var(--border);font-size:11px;white-space:nowrap;color:var(--orange)">${esc(date)}</td>
      <td style="padding:4px 8px;border:1px solid var(--border);font-size:11px;white-space:nowrap">${platform}</td>
      <td style="padding:4px 8px;border:1px solid var(--border);font-size:11px;max-width:300px"><div style="display:flex;gap:8px;align-items:center;min-width:0">${thumb}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${preview}</span></div></td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div style="font-weight:700;font-size:13px;margin-bottom:8px">📅 Content calendar — ${batch.posts?.length || 0} posts</div>
    <div style="overflow-x:auto;margin-bottom:10px">
      <table style="border-collapse:collapse;width:100%;font-size:12px">
        <tr>
          <th style="padding:4px 8px;border:1px solid var(--border);background:var(--bg-card);text-align:left;font-size:11px">Date</th>
          <th style="padding:4px 8px;border:1px solid var(--border);background:var(--bg-card);text-align:left;font-size:11px">Platform</th>
          <th style="padding:4px 8px;border:1px solid var(--border);background:var(--bg-card);text-align:left;font-size:11px">Caption</th>
        </tr>
        ${rows}
      </table>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" id="batch-approve-btn">✓ Save all (${batch.posts?.length || 0})</button>
      <button class="btn btn-sm" id="batch-cancel-btn" style="color:var(--red-text)">✗ Cancel</button>
    </div>
    <div id="batch-progress" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>`;

  wireActionCard(el, {
    approveSelector: '#batch-approve-btn',
    cancelSelector: '#batch-cancel-btn',
    progressSelector: '#batch-progress',
    onApprove: () => onApprove(batch, el),
    onCancel: () => onCancel(el),
  }, options);
  return el;
}

async function executeBatchSchedule(batch, el, messageIndex) {
  const approveBtn  = el.querySelector('#batch-approve-btn');
  const cancelBtn   = el.querySelector('#batch-cancel-btn');
  const progressEl  = el.querySelector('#batch-progress');
  if (approveBtn) { approveBtn.disabled = true; approveBtn.textContent = 'Saving…'; }
  if (cancelBtn)  cancelBtn.style.display = 'none';

  let saved = 0, failed = 0;
  const failedPosts = [];
  for (const p of batch.posts || []) {
    try {
      await saveScheduledPost({ id: generateId(), caption: p.caption, platform: p.platform || 'all', listing_id: p.listing_id || null, listing_title: p.listing_title || null, listing_image_url: p.listing_image_url || null, scheduled_at: p.scheduled_at || null, status: 'draft', created_at: Date.now() });
      saved++;
      if (progressEl) progressEl.textContent = `Saving… ${saved}/${batch.posts.length}`;
    } catch { failed++; failedPosts.push(p); }
  }

  if (progressEl) progressEl.textContent = failed ? `✓ ${saved} saved, ${failed} failed.` : `✓ All ${saved} posts saved to schedule!`;
  if (approveBtn && !failed) { approveBtn.textContent = `✓ Saved (${saved})`; approveBtn.style.background = 'var(--green)'; approveBtn.style.borderColor = 'var(--green)'; approveBtn.style.color = 'white'; }
  if (failed) {
    batch.posts = failedPosts;
    if (agentMessages[messageIndex]) agentMessages[messageIndex].pending_batch_schedule = batch;
    saveHistory(agentMessages);
    if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Retry failed'; }
  } else {
    clearPendingAction(messageIndex, 'pending_batch_schedule');
  }
  if (saved > 0) toastSuccess(`${saved} post${saved > 1 ? 's' : ''} added to schedule!`);
  else toastError('No posts were saved');
}

// ── Delete scheduled post card ────────────────────────────
function renderDeletePostCard(deletePost, onConfirm, onCancel, options = {}) {
  const el = document.createElement('div');
  el.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:8px 0';
  const preview = esc((deletePost.caption_preview || '').slice(0, 80));
  el.innerHTML = `
    <div style="font-weight:700;font-size:13px;margin-bottom:6px">🗑️ Delete scheduled post</div>
    ${preview ? `<div style="font-size:12px;color:var(--text-2);margin-bottom:8px;padding:6px 10px;background:var(--bg-card);border-radius:6px">${preview}${deletePost.caption_preview?.length > 80 ? '…' : ''}</div>` : ''}
    <div style="display:flex;gap:8px">
      <button class="btn btn-sm" id="delpost-confirm-btn" style="background:var(--red-text);color:#fff;border-color:var(--red-text)">🗑️ Delete</button>
      <button class="btn btn-sm" id="delpost-cancel-btn" style="color:var(--text-3)">✗ Cancel</button>
    </div>
    <div id="delpost-progress" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>`;

  wireActionCard(el, {
    approveSelector: '#delpost-confirm-btn',
    cancelSelector: '#delpost-cancel-btn',
    progressSelector: '#delpost-progress',
    onApprove: () => onConfirm(deletePost, el),
    onCancel: () => { el.style.opacity = '0.5'; el.querySelector('#delpost-confirm-btn').disabled = true; el.querySelector('#delpost-cancel-btn').disabled = true; },
  }, options);
  return el;
}

async function executeDeletePost(deletePost, el, messageIndex) {
  const confirmBtn  = el.querySelector('#delpost-confirm-btn');
  const progressEl  = el.querySelector('#delpost-progress');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Deleting…'; }
  try {
    await deleteScheduledPost(deletePost.id);
    if (progressEl) progressEl.textContent = '✓ Post deleted from schedule.';
    if (confirmBtn) { confirmBtn.textContent = '✓ Deleted'; confirmBtn.style.background = 'var(--green)'; confirmBtn.style.borderColor = 'var(--green)'; }
    clearPendingAction(messageIndex, 'pending_delete_post');
    toastSuccess('Post deleted from schedule!');
  } catch (e) {
    if (progressEl) progressEl.textContent = 'Failed: ' + e.message;
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '↻ Retry'; }
    toastError('Delete failed: ' + e.message);
  }
}

// ── Page context collector (semantic snapshot of current page state) ─────────
function collectPageContext(page) {
  const ctx = { page };
  const main = document.getElementById('main-area');
  if (!main) return ctx;

  // Page heading
  const heading = main.querySelector('h1, h2, [class*="page-title"]');
  if (heading) ctx.heading = heading.textContent.trim().slice(0, 80);

  switch (page) {
    case 'create': {
      const idMatch = (window.location.hash || '').match(/[?&]id=(\d+)/);
      if (idMatch) ctx.listing_id = Number(idMatch[1]);
      const subtitle = document.getElementById('create-subtitle');
      if (subtitle) ctx.active_step = subtitle.textContent.trim().slice(0, 80);
      // Step 1: input fields
      const fDesc = document.getElementById('f-desc');
      if (fDesc?.value) ctx.input_description = fDesc.value.slice(0, 300);
      const fPrice = document.getElementById('f-price');
      if (fPrice?.value) ctx.price = fPrice.value;
      const fLtype = document.getElementById('f-ltype');
      if (fLtype?.value) ctx.listing_type = fLtype.value;
      // Step 3: generated listing fields (full content for agent to read + edit)
      const eTitle = document.getElementById('e-title');
      if (eTitle?.value) ctx.listing_title = eTitle.value;
      const eDesc = document.getElementById('e-desc');
      if (eDesc?.value) ctx.listing_description = eDesc.value.slice(0, 3000);
      const tagChips = [...document.querySelectorAll('#tags-wrap .tag-chip[data-v]')].map(el => el.dataset.v);
      if (tagChips.length) ctx.listing_tags = tagChips;
      const taxonomyId = window['__tax_taxonomy-select-wrap']?.getValue?.() || null;
      if (taxonomyId) ctx.taxonomy_id = taxonomyId;
      const images = document.querySelectorAll('#image-uploader-wrap img, #image-uploader-wrap [data-image-id]');
      if (images.length) ctx.image_count = images.length;
      const personalOn = document.getElementById('toggle-personal')?.classList.contains('on');
      if (personalOn !== undefined) ctx.is_personalizable = personalOn;
      const pqs = [...document.querySelectorAll('.personal-question')].map(card => ({
        question_type: card.querySelector('[data-pq-field="question_type"]')?.value || 'text_input',
        question_text: card.querySelector('[data-pq-field="question_text"]')?.value || 'Personalization',
        instructions: card.querySelector('[data-pq-field="instructions"]')?.value || '',
        required: card.querySelector('[data-pq-field="required"]')?.classList.contains('on') === true,
        options: (card.querySelector('[data-pq-field="options"]')?.value || '').split('\n').map(s => s.trim()).filter(Boolean).map(label => ({ label })),
      }));
      if (pqs.length) ctx.personalization_questions = pqs;
      break;
    }
    case 'listings': {
      const searchEl = main.querySelector('input[id*="search"], input[placeholder*="earch"]');
      if (searchEl?.value) ctx.search_filter = searchEl.value;
      const rows = main.querySelectorAll('[data-listing-id], .listing-row, .listing-card');
      if (rows.length) ctx.visible_count = rows.length;
      // Checked/selected listings
      const checked = [...main.querySelectorAll('input[type=checkbox]:checked')];
      const selectedIds = checked.map(el => el.dataset.listingId || el.closest('[data-listing-id]')?.dataset.listingId).filter(Boolean);
      if (selectedIds.length) ctx.selected_listing_ids = selectedIds.slice(0, 20);
      break;
    }
    case 'social': {
      const activeTab = main.querySelector('[class*="tab"][class*="active"], [class*="active"][data-platform]');
      if (activeTab) ctx.active_platform = (activeTab.dataset?.platform || activeTab.textContent.trim()).slice(0, 30);
      const captionEl = main.querySelector('textarea[id*="caption"], textarea[placeholder*="caption"]');
      if (captionEl?.value) ctx.caption_preview = captionEl.value.slice(0, 120) + '…';
      break;
    }
    case 'orders': {
      const rows = main.querySelectorAll('[data-order-id], .order-row, .order-item');
      if (rows.length) ctx.visible_orders = rows.length;
      break;
    }
    case 'analytics': {
      const active = main.querySelector('[class*="period"][class*="active"], [data-days][class*="active"]');
      if (active) ctx.active_period = (active.dataset?.days ? active.dataset.days + ' days' : active.textContent.trim()).slice(0, 30);
      break;
    }
    case 'schedule': {
      const rows = main.querySelectorAll('[data-post-id], [class*="post-item"], [class*="schedule-row"]');
      if (rows.length) ctx.scheduled_posts_visible = rows.length;
      break;
    }
    case 'competitor': {
      const searchEl = main.querySelector('input[id*="search"], input[id*="keyword"]');
      if (searchEl?.value) ctx.search_keyword = searchEl.value;
      const results = main.querySelectorAll('[class*="result"], [class*="competitor"]');
      if (results.length) ctx.results_visible = results.length;
      break;
    }
    case 'dashboard': {
      // Grab visible stat numbers
      const stats = [...main.querySelectorAll('[class*="stat"], [class*="metric"], [class*="revenue"]')]
        .slice(0, 4)
        .map(el => el.textContent.trim().slice(0, 40))
        .filter(Boolean);
      if (stats.length) ctx.visible_stats = stats;
      break;
    }
  }

  return ctx;
}

// ── Core send function (shared with float) ────────────────
function storeAgentFinalResult(finalResult, turnId = '') {
  if (!finalResult) return null;
  const existing = turnId && agentMessages.find(message => message.role === 'assistant' && message.agent_turn_id === turnId);
  if (existing) return { ...existing, message: existing.content || '' };

  if (finalResult.pending_memory_save?.text) {
    saveMemoryItem({
      id: finalResult.pending_memory_save.id || memoryId(),
      text: finalResult.pending_memory_save.text,
      category: finalResult.pending_memory_save.category || 'fact',
      createdAt: finalResult.pending_memory_save.createdAt || Date.now(),
    }, finalResult.pending_memory_save.persisted !== true);
    window.__updateMemoryBadge?.();
  }
  if (finalResult.pending_memory_delete?.id) {
    deleteMemoryItem(finalResult.pending_memory_delete.id, finalResult.pending_memory_delete.persisted !== true);
    window.__updateMemoryBadge?.();
  }

  const sp = finalResult.pending_social_post;
  if (sp?.listing_id && sp?.listing_image_url) {
    set(`listing:${sp.listing_id}`, { listing_id: sp.listing_id, title: sp.listing_title || '', image_url: sp.listing_image_url });
  }

  const reply = finalResult.message || '';
  if (finalResult.pending_listing_images?.listing_id) rememberAgentListingTarget(finalResult.pending_listing_images);
  agentMessages.push({
    role: 'assistant',
    content: reply,
    agent_ui_runtime_id: AGENT_UI_RUNTIME_ID,
    ...(turnId ? { agent_turn_id: turnId } : {}),
    pending_updates: finalResult.pending_updates || null,
    pending_price_multiplier_inventory: finalResult.pending_price_multiplier_inventory || null,
    pending_social_post: finalResult.pending_social_post || null,
    pending_duplicate: finalResult.pending_duplicate || null,
    pending_scheduled_post: finalResult.pending_scheduled_post || null,
    navigation_action: finalResult.navigation_action || null,
    pending_field_fills: finalResult.pending_field_fills || null,
    pending_batch_schedule: finalResult.pending_batch_schedule || null,
    pending_delete_post: finalResult.pending_delete_post || null,
    pending_variations: finalResult.pending_variations || null,
    pending_generate_listing: finalResult.pending_generate_listing || null,
    pending_clear_variations: finalResult.pending_clear_variations || null,
    pending_remove_variation_property: finalResult.pending_remove_variation_property || null,
    pending_listing_images: finalResult.pending_listing_images || null,
    pending_listing_image_action: finalResult.pending_listing_image_action || null,
    pending_draft_image_action: finalResult.pending_draft_image_action || null,
    debug_trace: finalResult.debug_trace || null,
    ...(finalResult.pending_listing_images?.listing_id ? { listing_image_result: null } : {}),
  });
  saveHistory(agentMessages);

  return {
    message: reply,
    pending_updates: finalResult.pending_updates || null,
    pending_price_multiplier_inventory: finalResult.pending_price_multiplier_inventory || null,
    pending_social_post: finalResult.pending_social_post || null,
    pending_duplicate: finalResult.pending_duplicate || null,
    pending_scheduled_post: finalResult.pending_scheduled_post || null,
    navigation_action: finalResult.navigation_action || null,
    pending_field_fills: finalResult.pending_field_fills || null,
    pending_batch_schedule: finalResult.pending_batch_schedule || null,
    pending_delete_post: finalResult.pending_delete_post || null,
    pending_variations: finalResult.pending_variations || null,
    pending_generate_listing: finalResult.pending_generate_listing || null,
    pending_clear_variations: finalResult.pending_clear_variations || null,
    pending_remove_variation_property: finalResult.pending_remove_variation_property || null,
    pending_listing_images: finalResult.pending_listing_images || null,
    pending_listing_image_action: finalResult.pending_listing_image_action || null,
    pending_draft_image_action: finalResult.pending_draft_image_action || null,
    debug_trace: finalResult.debug_trace || null,
  };
}

async function pollTrackedAgentTurn(turn, onProgress, timeoutMs = AGENT_RESPONSE_TIMEOUT_MS + 60_000) {
  const startedAt = Date.now();
  let lastEventAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const job = await jobs.getStatus(turn.id);
    if (job?.updated_at !== lastEventAt) {
      lastEventAt = job?.updated_at;
      if (job?.last_event) onProgress?.(job.last_event);
      else if (job?.message) onProgress?.({ type: 'tool', message: job.message });
    }
    if (job?.status === 'done' && job.result) return job.result;
    if (job?.status === 'error') throw new Error(userFacingErrorMessage(job.error || 'Agent request failed'));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Agent background job timed out. The saved conversation can be retried safely.');
}

export async function sendAgentMessage(userText, onProgress, extraContext = {}) {
  if (!userText.trim()) return null;

  const turnId = /^job_agent_[a-z0-9_]+$/i.test(String(extraContext?._agent_turn_id || ''))
    ? String(extraContext._agent_turn_id)
    : '';
  const context = {};
  Object.assign(context, extraContext || {});
  delete context._agent_turn_id;

  // Current page + fillable DOM fields (for fill_ui_fields tool)
  context.current_page = (window.location.hash || '').replace(/^#/, '').split('?')[0] || 'dashboard';
  const availableFields = [];
  document.querySelectorAll('input[id]:not([type=hidden]), textarea[id], select[id]').forEach(el => {
    if (!el.id) return;
    // Exclude the float panel and agent page's own input area — not page-level fields
    if (el.closest('#agent-float-root, #agent-input-wrap')) return;
    // Use computed style for reliable visibility check (handles CSS classes, not just inline style)
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const labelEl = document.querySelector(`label[for="${el.id}"]`);
    const label = el.getAttribute('aria-label')
      || labelEl?.textContent?.trim()
      || el.getAttribute('placeholder')
      || el.closest('.field')?.querySelector('label')?.textContent?.trim()
      || el.id;
    const tag = el.tagName.toLowerCase();
    // Normalize type: skip defaults (text, textarea, select-one); shorten select-multiple→multiple
    const rawType = el.type || '';
    const typeStr = (rawType && rawType !== 'text' && rawType !== tag && rawType !== 'select-one')
      ? ':' + rawType.replace('select-multiple', 'multiple')
      : '';
    const entry = { id: el.id, label, type: tag + typeStr };
    if (el.value) entry.value = String(el.value).slice(0, 300);
    availableFields.push(entry);
  });
  if (availableFields.length) context.available_fields = availableFields.slice(0, 40);
  context.page_context = collectPageContext(context.current_page);
  const currentDraft = currentAgentDraftContext();
  if (currentDraft) context.current_agent_draft = currentDraft;
  const activeCreateDraft = await readCreateDraftContext();
  if (activeCreateDraft) context.active_create_draft = activeCreateDraft;
  const runtimeEvents = runtimeEventsForContext();
  if (runtimeEvents.length) context.agent_runtime_events = runtimeEvents;

  // Persistent agent memory
  const memories = loadMemories();
  if (memories.length) context.agent_memory = memories.map(m => ({ id: m.id, text: m.text, category: m.category }));
  try {
    const shopCtx = await kv.getShopOperatingContext();
    if (shopCtx) context.shop_operating_context = shopCtx;
  } catch {}

  // Pass cached listings so agent doesn't make redundant API calls
  const cachedListings = get('listings:active');
  if (cachedListings?.length) {
    context.listings = cachedListings.map(l => ({
      listing_id:        l.listing_id,
      title:             l.title,
      description:       (l.description || '').slice(0, 600),
      tags:              l.tags || [],
      price:             l.price ? +(l.price.amount / l.price.divisor).toFixed(2) : null,
      views:             l.views,
      favorites:         l.num_favorers,
      should_auto_renew: l.should_auto_renew ?? true,
      state:             l.state || l.listing_state || 'active',
      image_url:         listingImageUrl(l) || null,
      etsy_url:          listingDestinationUrl(l.listing_id, l.state || l.listing_state || 'active'),
      url:               listingDestinationUrl(l.listing_id, l.state || l.listing_state || 'active'),
    }));
  }
  // Pass cached listing details so agent skips redundant get_listing_details API calls
  const listingDetails = {};
  if (cachedListings?.length) {
    for (const l of cachedListings) {
      const detail = get(`listing:${l.listing_id}`);
      if (detail) listingDetails[l.listing_id] = detail;
    }
  }
  if (Object.keys(listingDetails).length) context.listing_details = listingDetails;

  const lastDup = latestDuplicateResult();
  if (lastDup) context.last_duplicate_result = lastDup;
  const cancelledDup = latestCancelledDuplicate();
  if (cancelledDup) context.cancelled_duplicate = cancelledDup;
  const lastImagePlan = latestListingImagePlan();
  if (lastImagePlan) context.pending_listing_images = lastImagePlan;
  const lastCompletedImagePlan = latestAssistantMessageWith(message => message.listing_image_result?.applied_at)?.listing_image_result;
  if (lastCompletedImagePlan) context.last_listing_image_result = lastCompletedImagePlan;
  const listingWorkflow = listingWorkflowSnapshot({ plan: lastImagePlan, draft: getLatestAgentDraft() });
  if (listingWorkflow.workflow_id) context.agent_listing_workflow = listingWorkflow;
  const listingSelectionCandidates = latestListingSelectionCandidates();
  if (listingSelectionCandidates.length) context.last_listing_selection = listingSelectionCandidates;
  const conversationListingReferences = latestConversationListingReferences();
  if (conversationListingReferences.length) {
    context.conversation_listing_references = conversationListingReferences;
    context.last_visible_listing_reference = conversationListingReferences[0];
  }

  // Pass scheduled posts so agent can read the calendar (get_scheduled_posts tool uses context)
  try {
    const scheduled = await getScheduledPosts();
    if (scheduled?.length) {
      context.scheduled_posts = scheduled.slice(0, 50).map(p => ({
        id: p.id, caption: (p.caption || '').slice(0, 120), platform: p.platform,
        scheduled_at: p.scheduled_at || null, status: p.status || 'draft',
        listing_title: p.listing_title || null,
      }));
    }
  } catch {}

  // If this conversation already produced a content calendar, pass it so agent can re-show it
  const lastBatch = latestAssistantMessageWith(m => m.pending_batch_schedule?.posts?.length);
  if (lastBatch) context.pending_batch_schedule = lastBatch.pending_batch_schedule;

  const lastPendingUpdates = latestAssistantMessageWith(m => m.pending_updates?.updates?.length);
  if (lastPendingUpdates) context.pending_updates = lastPendingUpdates.pending_updates;

  const lastTargetUpdate = latestAssistantMessageWith(m => m.pending_updates?.updates?.[0]?.listing_id);
  const lastTargetVariation = latestAssistantMessageWith(m => m.pending_variations?.listing_id || m.pending_remove_variation_property?.listings?.[0]?.listing_id || m.pending_clear_variations?.listings?.[0]?.listing_id || m.pending_price_multiplier_inventory?.listings?.[0]?.listing_id);
  const lastTargetImagePlan = latestAssistantMessageWith(m => m.pending_listing_images?.listing_id && !m.listing_image_result?.applied_at)?.pending_listing_images;
  const rememberedListingTarget = getRememberedAgentListingTarget();
  const target = lastImagePlan
    || lastTargetImagePlan
    || rememberedListingTarget
    || (lastTargetVariation?.pending_variations?.listing_id ? lastTargetVariation.pending_variations : null)
    || lastTargetVariation?.pending_remove_variation_property?.listings?.[0]
    || lastTargetVariation?.pending_clear_variations?.listings?.[0]
    || lastTargetVariation?.pending_price_multiplier_inventory?.listings?.[0]
    || lastTargetUpdate?.pending_updates?.updates?.[0]
    || (listingSelectionCandidates.length === 1 ? listingSelectionCandidates[0] : null)
    || conversationListingReferences[0];
  const normalizedTarget = normalizeAgentListingTarget(target || {});
  if (normalizedTarget) context.last_target_listing = normalizedTarget;

  const lastAssistantWith = (key, check) => latestAssistantMessageWith(m => check(m[key]));
  const activePendingDuplicate = latestActivePendingDuplicate();
  if (activePendingDuplicate) context.pending_duplicate = activePendingDuplicate;

  const pendingContextKeys = [
    ['pending_price_multiplier_inventory', v => v?.listings?.length],
    ['pending_social_post', v => v?.caption],
    ['pending_scheduled_post', v => v?.caption],
    ['pending_field_fills', v => v?.fields?.length],
    ['pending_variations', v => v?.listing_type || v?.properties?.length],
    ['pending_generate_listing', v => v?.description && !['done', 'error', 'cancelled'].includes(v.status)],
    ['pending_clear_variations', v => v?.listings?.length],
    ['pending_remove_variation_property', v => v?.listings?.length],
  ];
  for (const [key, check] of pendingContextKeys) {
    const msg = lastAssistantWith(key, check);
    if (msg) context[key] = msg[key];
  }

  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => abortCtrl.abort(), AGENT_RESPONSE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({
        messages: agentMessagesForRequest(),
        context,
        provider: getAgentModel(),
        turn_id: turnId || undefined,
        model_overrides: {
          gemini: localStorage.getItem('ai_model_gemini'),
          claude: localStorage.getItem('ai_model_claude')
        }
      }),
      signal: abortCtrl.signal,
      cache: 'no-store',
    });
  } catch (fetchErr) {
    clearTimeout(abortTimer);
    if (turnId) {
      try {
        const recovered = await pollTrackedAgentTurn({ id: turnId }, onProgress, 60_000);
        return storeAgentFinalResult(recovered, turnId);
      } catch {}
    }
    const requestError = fetchErr.name === 'AbortError' ? new Error('Agent request timed out') : fetchErr;
    recordAgentRuntimeFault(requestError, { operation: 'agent_turn_request', job_id: turnId, retryable: true });
    return null;
  }

  // Non-SSE error (auth failure, 503, etc.)
  if (!res.ok) {
    clearTimeout(abortTimer);
    let errMsg = 'Agent error';
    try {
      const d = await res.json();
      errMsg = d.error || errMsg;
    } catch {
      try {
        const text = await res.text();
        if (text) errMsg = text.slice(0, 300);
      } catch {}
    }
    recordAgentRuntimeFault(new Error(errMsg), { operation: 'agent_turn_http', job_id: turnId, retryable: res.status >= 500 });
    return null;
  }

  // Read SSE stream. Agent tool chains can legitimately take a couple minutes on VPS.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;
  let agentError = null;
  const handleSseChunk = (chunk) => {
    if (!chunk.startsWith('data: ')) return;
    try {
      const obj = JSON.parse(chunk.slice(6));
      if (obj.type === 'model' || obj.type === 'tool' || obj.type === 'tool_result') {
        onProgress?.(obj);
      } else if (obj.type === 'done') {
        finalResult = obj;
      } else if (obj.type === 'error') {
        agentError = obj.error || 'Agent request failed.';
      }
    } catch {}
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop();
      for (const chunk of chunks) {
        handleSseChunk(chunk);
      }
    }
    if (buffer.trim()) handleSseChunk(buffer.trim());
  } catch (streamErr) {
    if (!finalResult) {
      if (turnId) {
        try {
          finalResult = await pollTrackedAgentTurn({ id: turnId }, onProgress, 60_000);
        } catch {}
      }
    }
    if (!finalResult) {
      const timedOut = streamErr?.name === 'AbortError' || abortCtrl.signal.aborted;
      const seconds = Math.round(AGENT_RESPONSE_TIMEOUT_MS / 1000);
      const errMsg = timedOut
        ? `Agent response timed out after ${seconds}s.`
        : 'Agent connection was interrupted.';
      recordAgentRuntimeFault(new Error(errMsg), { operation: 'agent_turn_stream', job_id: turnId, retryable: true });
      return null;
    }
  } finally {
    clearTimeout(abortTimer);
    try { reader.releaseLock(); } catch {}
  }

  if (!agentError && !finalResult && turnId) {
    try {
      finalResult = await pollTrackedAgentTurn({ id: turnId }, onProgress, 60_000);
    } catch {}
  }

  if (agentError || !finalResult) {
    const errMsg = agentError || 'Agent response ended before completion. This can happen during a server restart or interrupted connection. Please retry.';
    recordAgentRuntimeFault(new Error(errMsg), { operation: 'agent_turn_completion', job_id: turnId, retryable: true });
    return null;
  }

  return storeAgentFinalResult(finalResult, turnId);
}

// ── Full-page render ──────────────────────────────────────
// ── Durable server-side listing generation ────────────────────────────────
async function pollAgentListingJob(jobId, timeoutMs = AGENT_RESPONSE_TIMEOUT_MS) {
  const started = Date.now();
  let lastPollError = null;
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    try {
      const job = await jobs.getStatus(jobId);
      lastPollError = null;
      if (job?.status === 'done') return job.result;
      if (job?.status === 'error') {
        const terminalError = new Error(userFacingErrorMessage(job.error || 'Listing generation failed'));
        terminalError.terminal = true;
        throw terminalError;
      }
    } catch (err) {
      if (err?.terminal) throw err;
      lastPollError = err;
    }
  }
  if (lastPollError) throw lastPollError;
  throw new Error(`Listing generation timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function runGenerateListing(params, messagesEl, msgIndex, options = {}) {
  const restoredSnapshot = Boolean(options.restored && params.generated);
  const isExistingListing = params.target_type === 'etsy_listing' && Number(params.listing_id) > 0;
  // Progress card
  const card = document.createElement('div');
  card.className = 'agent-action-card agent-action-card-update';
  card.style.borderLeftColor = 'var(--blue,#2563eb)';
  card.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><div class="spinner" style="width:13px;height:13px;border-width:2px;flex-shrink:0"></div><span>${isExistingListing ? 'Preparing listing update...' : 'Preparing listing draft...'}</span></div>`;
  messagesEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const provider = getAgentModel();
  try {
    let data = params.generated;

    if (!data) {
      let jobId = params.generation_job_id || `job_listing_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
      if (msgIndex !== undefined && msgIndex >= 0 && agentMessages[msgIndex]) {
        agentMessages[msgIndex].pending_generate_listing = {
          ...params,
          generation_job_id: jobId,
          generation_started_at: params.generation_started_at || new Date().toISOString(),
          status: 'generating',
        };
        saveHistory(agentMessages);
      }
      const job = await jobs.startListingGeneration({
        job_id: jobId,
        provider,
        description: params.description,
        listingType: params.listing_type || 'download',
        price: params.price || '',
        extra: params.extra || '',
        productType: params.product_type || params.description?.slice(0, 80) || '',
        shopContext: params.shop_context || '',
      });
      jobId = job.id || jobId;
      data = await pollAgentListingJob(jobId);
    }

    if (!data.title) throw new Error('No title in response');

    if (isExistingListing) {
      const plan = {
        summary: `Optimize ${params.listing_title || `listing ${params.listing_id}`}`,
        updates: [{
          listing_id: Number(params.listing_id),
          listing_title: params.listing_title || params.current_values?.title || `Listing ${params.listing_id}`,
          current_values: params.current_values || {},
          title: data.title,
          description: data.description,
          tags: Array.isArray(data.tags) ? data.tags : [],
        }],
      };
      if (msgIndex !== undefined && msgIndex >= 0 && agentMessages[msgIndex]) {
        agentMessages[msgIndex].pending_generate_listing = null;
        agentMessages[msgIndex].pending_updates = plan;
        agentMessages[msgIndex].generated_listing_update = {
          listing_id: Number(params.listing_id),
          generated_at: new Date().toISOString(),
        };
        saveHistory(agentMessages);
      }
      const planCard = renderPlanCard(
        plan,
        (approvedPlan, planEl) => executeUpdates(approvedPlan, planEl, msgIndex),
        planEl => {
          planEl.style.opacity = '0.4';
          planEl.querySelector('#plan-approve-btn').disabled = true;
          planEl.querySelector('#plan-cancel-btn').disabled = true;
          clearPendingAction(msgIndex, 'pending_updates');
        },
      );
      card.replaceWith(planCard);
      return plan;
    }

    const generatedDraft = {
      generated: data,
      description: params.description || '',
      productType: params.product_type || params.description?.slice(0, 80) || 'other',
      listingType: params.listing_type || 'download',
      price: params.price || data.price_suggestion || '',
      extra: params.extra || '',
      attachedImages: Array.isArray(params.attached_images) ? params.attached_images : [],
      referenceImage: params.reference_image || params.referenceImage || null,
      createdBy: 'agent',
      createdAt: Date.now(),
      workflow_id: params.workflow_id || null,
      workflow_state: 'listing_draft_ready',
    };
    let agentDraft = params.agent_draft?.generated && sameAgentDraftWorkflow(generatedDraft, params.agent_draft)
      ? mergeAgentDraftSnapshots(generatedDraft, params.agent_draft)
      : generatedDraft;
    const latestWorkflowDraft = getLatestAgentDraft();
    if (latestWorkflowDraft?.generated && sameAgentDraftWorkflow(agentDraft, latestWorkflowDraft)) {
      agentDraft = mergeAgentDraftSnapshots(agentDraft, latestWorkflowDraft);
    }
    const hasAttachedImages = agentDraft.attachedImages.length > 0;
    const hasReferenceImage = Boolean(agentDraft.referenceImage?.base64 && agentDraft.referenceImage?.mimeType);
    if (!restoredSnapshot) persistCurrentAgentDraft(agentDraft, msgIndex);
    if (msgIndex !== undefined && msgIndex >= 0 && agentMessages[msgIndex]) {
      agentMessages[msgIndex].pending_generate_listing = {
        ...params,
        generated: data,
        agent_draft: agentDraftHistorySnapshot(agentDraft),
        generation_job_id: null,
        status: 'done',
        workflow_state: agentDraft.workflow_state || 'listing_draft_ready',
        storedImageIds: Array.isArray(agentDraft.storedImageIds) ? [...agentDraft.storedImageIds] : [],
      };
      saveHistory(agentMessages);
    }

    // Build result card
    const tagsHtml = Array.isArray(data.tags)
      ? data.tags.map(t => `<span style="background:var(--bg-card);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:11px">${esc(t)}</span>`).join(' ')
      : '';

    card.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px;color:var(--text)">✓ Listing draft ready</div>
      <div style="margin-bottom:6px"><span style="color:var(--text-3)">Title:</span> ${esc(data.title || '')}</div>
      <div style="font-size:11px;color:var(--text-2);margin-bottom:6px;max-height:48px;overflow:hidden;line-height:1.4">${esc((data.description || '').slice(0, 200))}${(data.description || '').length > 200 ? '…' : ''}</div>
      ${data.price_suggestion ? `<div style="margin-bottom:6px;font-size:12px"><span style="color:var(--text-3)">Suggested price:</span> $${Number(data.price_suggestion).toFixed(2)}</div>` : ''}
      <div style="font-size:11px;color:var(--green-text,#166534);margin-bottom:8px">${restoredSnapshot ? 'Historical draft snapshot. Continue the conversation before using it again.' : '✦ Draft ready. Continue here to create images, or open it for manual editing.'}</div>
      ${tagsHtml ? `<div style="margin-top:6px;color:var(--text-3);font-size:11px;margin-bottom:4px">Tags:</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">${tagsHtml}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" id="agent-generate-draft-images-btn">Generate listing images now</button>
        <button class="btn btn-sm" id="agent-open-created-draft-btn">Edit draft on Create page</button>
      </div>
      ${hasAttachedImages ? `<div style="font-size:11px;color:var(--text-2);margin-top:8px">Attached image will be added to the draft unchanged.</div>` : ''}
      ${hasReferenceImage ? `<div style="font-size:11px;color:var(--text-2);margin-top:8px">Attached image will be used as the visual reference for generated listing images.</div>` : ''}
    `;
    if (restoredSnapshot) {
      card.querySelectorAll('button').forEach(button => { button.disabled = true; });
      return agentDraft;
    }
    card.querySelector('#agent-open-created-draft-btn')?.addEventListener('click', async () => {
      const currentDraft = persistCurrentAgentDraft(currentDraftForWorkflow(agentDraft, msgIndex), msgIndex);
      await navigateToAgentDraftCreate(currentDraft);
    });
    card.querySelector('#agent-generate-draft-images-btn')?.addEventListener('click', async () => {
      persistCurrentAgentDraft(currentDraftForWorkflow(agentDraft, msgIndex), msgIndex);
      await window.__agentSend?.('Generate listing images for this draft now.');
    });

    if (params.after_generation === 'attach_active_image_plan') {
      const entry = latestListingImagePlanEntry();
      const imageCard = latestListingImageCardElement();
      const sameWorkflow = entry?.plan?.workflow_id && agentDraft.workflow_id
        ? String(entry.plan.workflow_id) === String(agentDraft.workflow_id)
        : Boolean(entry?.plan);
      if (!entry?.plan || !imageCard || !sameWorkflow) {
        const fault = createAgentRuntimeFault({
          code: 'AGENT_STALE_LISTING_WORKFLOW',
          operation: 'resume_attach_after_listing_generation',
          fault_domain: 'workflow',
          retryable: false,
          workflow_id: agentDraft.workflow_id || '',
          required_transition: 'select_matching_listing_draft',
          safe_message: 'The saved image plan no longer matches the generated listing draft.',
        });
        recordAgentRuntimeFault(fault, { messageIndex: msgIndex });
      } else {
        if (msgIndex !== undefined && msgIndex >= 0 && agentMessages[msgIndex]?.pending_generate_listing) {
          agentMessages[msgIndex].pending_generate_listing.after_generation = 'none';
          agentMessages[msgIndex].pending_generate_listing.after_generation_status = 'running';
          saveHistory(agentMessages);
        }
        const resumed = await applyListingImages(entry.plan, imageCard, entry.messageIndex);
        if (msgIndex !== undefined && msgIndex >= 0 && agentMessages[msgIndex]?.pending_generate_listing) {
          agentMessages[msgIndex].pending_generate_listing.after_generation_status = resumed?.ok ? 'done' : 'error';
          saveHistory(agentMessages);
        }
      }
    }

  } catch (err) {
    if (msgIndex !== undefined && msgIndex >= 0 && agentMessages[msgIndex]) {
      agentMessages[msgIndex].pending_generate_listing = {
        ...params,
        generation_job_id: null,
        status: 'error',
        generation_error: userFacingErrorMessage(err.message),
      };
      saveHistory(agentMessages);
    }
    card.innerHTML = `<div style="color:var(--red-text)">Generation failed: ${esc(err.message)}</div>`;
  }
}

export async function renderAgent(container, options = {}) {
  const compact = options.compact === true;
  const renderInstanceId = `agent_view_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  container.classList.toggle('agent-compact-host', compact);
  container.style.cssText = compact
    ? 'display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--bg)'
    : 'display:flex;flex-direction:column;height:100vh;overflow:hidden;background:linear-gradient(180deg,var(--bg-secondary),var(--bg))';
  container.innerHTML = agentShellMarkup();

  const messagesEl   = container.querySelector('#agent-messages');
  const inputEl      = container.querySelector('#agent-input');
  const sendBtn      = container.querySelector('#agent-send-btn');
  const clearBtn     = container.querySelector('#agent-clear-btn');
  const chipsEl      = container.querySelector('#agent-chips');
  const attachEl     = container.querySelector('#agent-attachment');
  const attThumb     = container.querySelector('#agent-att-thumb');
  const attName      = container.querySelector('#agent-att-name');
  const dragOverlay  = container.querySelector('#agent-drag-overlay');
  const imgFileInput = container.querySelector('#agent-img-file');
  const imgBtn       = container.querySelector('#agent-img-btn');

  // Load durable preferences before the first turn on a new browser/device.
  if (sendBtn) sendBtn.disabled = true;
  await Promise.race([
    Promise.allSettled([_kvSyncMemories(), _kvSyncShopMemories()]),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (sendBtn) sendBtn.disabled = false;

  function clearAgentWelcome() {
    messagesEl.querySelectorAll('.agent-welcome').forEach(el => el.remove());
    if (agentMessages.length) chipsEl.innerHTML = '';
  }

  // ── Attachment helpers ────────────────────────────────────
  function showAttachment(imgData) {
    attachedImage = imgData;
    const presentation = agentAttachmentPresentation(imgData);
    if (attThumb) attThumb.src = presentation.preview;
    if (attName) attName.textContent = presentation.filename;
    if (attachEl) attachEl.style.display = presentation.display;
    if (imgBtn) {
      imgBtn.style.borderColor = presentation.accent;
      imgBtn.style.color = presentation.accent;
    }
    inputEl?.focus();
  }

  function clearAttachmentUI() {
    attachedImage = null;
    const presentation = agentAttachmentPresentation();
    if (attachEl) attachEl.style.display = presentation.display;
    if (imgBtn) {
      imgBtn.style.borderColor = presentation.accent;
      imgBtn.style.color = presentation.accent;
    }
  }

  window.__agentClearAttachment = clearAttachmentUI;

  async function handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const imgData = await resizeImageForChat(dataUrl, file.type);
      imgData.filename = file.name;
      imgData.originalDataUrl = dataUrl;
      imgData.originalBase64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      imgData.originalMimeType = file.type;
      showAttachment(imgData);
    } catch { toastError('Could not read image'); }
  }

  window.__agentHandleImgFile = handleImageFile;

  // ── Drag & drop on messages area ─────────────────────────
  let dragCounter = 0;
  messagesEl.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragCounter++;
    if (dragOverlay) dragOverlay.style.display = 'flex';
  });
  messagesEl.addEventListener('dragleave', () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (!dragCounter && dragOverlay) dragOverlay.style.display = 'none';
  });
  messagesEl.addEventListener('dragover', e => { e.preventDefault(); });
  messagesEl.addEventListener('drop', async e => {
    e.preventDefault();
    dragCounter = 0;
    if (dragOverlay) dragOverlay.style.display = 'none';
    const file = e.dataTransfer?.files?.[0];
    if (file) await handleImageFile(file);
  });

  // ── Drag & drop on input area ─────────────────────────────
  const inputWrap = container.querySelector('#agent-input-wrap');
  inputWrap?.addEventListener('dragover', e => e.preventDefault());
  inputWrap?.addEventListener('drop', async e => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) await handleImageFile(file);
  });

  // ── Paste image from clipboard ────────────────────────────
  inputEl?.addEventListener('paste', async e => {
    const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    await handleImageFile(file);
  });

  const CHIPS = [
    'Show all active listings',
    'What are my stats for last 30 days?',
    'Show my last 10 orders',
    'Find listings with low views (under 100)',
    'List all listings and their prices',
  ];

  function updateModelSelect() {
    const m = getAgentModel();
    const select = container.querySelector('#agent-model-select');
    const caption = container.querySelector('#agent-model-caption');
    if (select) select.value = AGENT_MODEL_OPTIONS[m] ? m : 'auto';
    if (caption) caption.textContent = AGENT_MODEL_OPTIONS[m]?.detail || AGENT_MODEL_OPTIONS.auto.detail;
  }

  const modelSelect = container.querySelector('#agent-model-select');
  if (modelSelect) modelSelect.onchange = () => { setAgentModel(modelSelect.value); updateModelSelect(); };
  updateModelSelect();

  // ── Memory panel ──────────────────────────────────────
  const memoryPanel = container.querySelector('#agent-memory-panel');
  const memoryList  = container.querySelector('#agent-memory-list');
  const shopMemoryList = container.querySelector('#agent-shop-memory-list');
  const memoryCount = container.querySelector('#agent-memory-count');
  const memoryBtn   = container.querySelector('#agent-memory-btn');
  const memoryClearBtn = container.querySelector('#agent-memory-clear-btn');

  function renderMemoryPanel() {
    const items = loadMemories();
    const shopItems = loadShopMemories();
    const presentation = agentMemoryPanelsPresentation(items, shopItems, { escapeHtml: esc });
    if (memoryCount) memoryCount.textContent = presentation.badgeText;
    if (!memoryList || !shopMemoryList) return;
    memoryList.innerHTML = presentation.personalMarkup;
    shopMemoryList.innerHTML = presentation.shopMarkup;
  }

  window.__updateMemoryBadge = renderMemoryPanel;
  window.__deleteMemory = async (id) => {
    const next = loadMemories().filter(item => item.id !== id);
    try {
      await kv.setAgentMemory(next);
      localStorage.setItem(scopedClientKey(MEMORY_STORAGE_KEY), JSON.stringify(next));
      renderMemoryPanel();
      toastSuccess('Memory removed');
    } catch (err) {
      toastError(userFacingErrorMessage(err?.message || 'Could not remove memory'));
    }
  };
  window.__deleteShopMemory = async (id) => {
    try {
      const current = await kv.getShopOperatingContext() || { items: [] };
      const next = {
        ...current,
        items: (Array.isArray(current.items) ? current.items : []).filter(item => String(item.id) !== String(id)),
        updated_at: new Date().toISOString(),
      };
      await kv.setShopOperatingContext(next);
      shopMemoryCache = next;
      renderMemoryPanel();
      toastSuccess('Shared shop memory removed');
    } catch (err) {
      toastError(userFacingErrorMessage(err?.message || 'Could not remove shared shop memory'));
    }
  };

  memoryBtn?.addEventListener('click', async () => {
    if (!memoryPanel) return;
    const open = memoryPanel.style.display !== 'none';
    memoryPanel.style.display = open ? 'none' : 'flex';
    memoryPanel.style.flexDirection = 'column';
    if (!open) await _kvSyncShopMemories();
    renderMemoryPanel();
  });

  memoryClearBtn?.addEventListener('click', async () => {
    if (!confirm('Clear personal agent memories for this account?')) return;
    try {
      await kv.setAgentMemory([]);
      localStorage.removeItem(scopedClientKey(MEMORY_STORAGE_KEY));
      renderMemoryPanel();
      toastSuccess('Personal memories cleared');
    } catch (err) {
      toastError(userFacingErrorMessage(err?.message || 'Could not clear memory'));
    }
  });

  renderMemoryPanel();

  // ── History panel ─────────────────────────────────────
  const historyPanel = container.querySelector('#agent-history-panel');
  const historyList  = container.querySelector('#agent-history-list');
  const historyBtn   = container.querySelector('#agent-history-btn');
  const composerPlaceholder = inputEl?.getAttribute('placeholder') || '';

  function setArchivedConversationView(active) {
    if (inputEl) {
      inputEl.disabled = active;
      inputEl.placeholder = active ? 'Continue this chat to send a message' : composerPlaceholder;
    }
    if (sendBtn) sendBtn.disabled = active;
    if (imgBtn) imgBtn.disabled = active;
  }

  async function renderHistoryPanel() {
    if (!historyList) return;
    let sessions = [];
    try { sessions = (await idbHistory.get(SESSIONS_KEY)) || []; } catch {}
    historyList.innerHTML = agentHistoryPanelPresentation(
      sessions,
      _currentSessionId,
      { escapeHtml: esc },
    ).markup;
  }

  historyBtn?.addEventListener('click', async () => {
    if (!historyPanel) return;
    const open = historyPanel.style.display !== 'none';
    historyPanel.style.display = open ? 'none' : 'block';
    if (!open) await renderHistoryPanel();
  });

  window.__loadHistorySession = async (sessionId) => {
    historyPanel.style.display = 'none';
    const msgs = await idbHistory.get(_sessionKey(sessionId)).catch(() => null);
    if (!Array.isArray(msgs) || !msgs.length) { toastError('Session not found'); return; }
    messagesEl.innerHTML = '';
    setArchivedConversationView(true);
    const banner = document.createElement('div');
    banner.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:8px 14px;display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--text-2);margin-bottom:4px;flex-shrink:0';
    banner.innerHTML = `<span>Viewing past conversation</span><button class="btn btn-sm" onclick="window.__returnToCurrentSession()">← Back to current chat</button>`;
    messagesEl.appendChild(banner);
    banner.innerHTML = `<span>Viewing past conversation</span><span style="display:flex;gap:6px"><button class="btn btn-sm" onclick="window.__continueHistorySession('${sessionId}')">Continue this chat</button><button class="btn btn-sm" onclick="window.__returnToCurrentSession()">Back to current chat</button></span>`;
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      const completedDraft = msg.pending_generate_listing?.generated ? msg.pending_generate_listing : null;
      appendMessage(msg.role, msg.content, msg.pending_updates || null, msg.pending_social_post || null, msg.pending_duplicate || null, msg.pending_scheduled_post || null, msg.navigation_action || null, -1, msg.pending_field_fills || null, msg._imgData || null, msg.pending_batch_schedule || null, msg.pending_delete_post || null, msg.pending_variations || null, completedDraft, msg.pending_clear_variations || null, msg.pending_remove_variation_property || null, msg.pending_listing_images || null, msg.pending_price_multiplier_inventory || null, msg.debug_trace || null, { restored: true });
    }
  };

  window.__continueHistorySession = async (sessionId) => {
    const msgs = await idbHistory.get(_sessionKey(sessionId)).catch(() => null);
    if (!Array.isArray(msgs) || !msgs.length) { toastError('Session not found'); return; }
    _currentSessionId = sessionId;
    agentSessionStorage.setItem('agent_current_session', _currentSessionId);
    agentMessages.length = 0;
    agentMessages.push(...sanitizeAgentHistory(msgs));
    try { agentSessionStorage.setItem(HISTORY_KEY, JSON.stringify(agentMessages)); } catch {}
    clearRememberedAgentListingTarget();
    restoreLatestAgentDraftFromMessages(agentMessages);
    setArchivedConversationView(false);
    renderAll();
  };

  window.__returnToCurrentSession = () => {
    setArchivedConversationView(false);
    renderAll();
  };

  window.__deleteHistorySession = async (sessionId) => {
    if (!confirm('Delete this conversation?')) return;
    try {
      const sessions = (await idbHistory.get(SESSIONS_KEY)) || [];
      await Promise.all([
        idbHistory.set(SESSIONS_KEY, sessions.filter(s => s.id !== sessionId)),
        idbHistory.delete(_sessionKey(sessionId)),
      ]);
      await renderHistoryPanel();
      toastSuccess('Conversation deleted');
    } catch { toastError('Failed to delete'); }
  };

  function renderChips() {
    if (agentMessages.length) { chipsEl.innerHTML = ''; return; }
    chipsEl.innerHTML = agentSuggestionChipsMarkup(CHIPS);
  }

  function bindListingSelectionButtons(root, content) {
    const listingRows = enrichListingThumbnailRows(extractListingThumbnailRows(content));
    root.querySelectorAll('[data-copy-listing-id]').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = btn.getAttribute('data-copy-listing-id') || '';
        rememberAgentListingTarget(listingRows.find(row => String(row.listing_id) === String(id)) || { listing_id: id });
        navigator.clipboard?.writeText(id).then(() => {
          btn.textContent = 'Selected';
          setTimeout(() => { btn.textContent = `Use ID ${id}`; }, 1200);
        }).catch(() => {
          inputEl.value = id;
          inputEl.focus();
        });
      });
    });
  }

  function renderAssistantContent(target, content) {
    const listingRows = enrichListingThumbnailRows(extractListingThumbnailRows(content));
    target.innerHTML = md(stripListingThumbnailMetadata(content)) + renderListingThumbnails(content, { rows: listingRows });
    bindListingSelectionButtons(target, content);
  }

  function typeAssistantContent(target, content) {
    const text = String(content || '');
    if (!text || text.length > 1800 || /^Error:/i.test(text)) {
      renderAssistantContent(target, content);
      return;
    }
    const started = performance.now();
    const maxMs = Math.min(1800, Math.max(500, text.length * 10));
    const step = () => {
      const elapsed = performance.now() - started;
      const ratio = Math.min(1, elapsed / maxMs);
      const count = Math.max(1, Math.ceil(text.length * ratio));
      target.innerHTML = md(stripListingThumbnailMetadata(text.slice(0, count)));
      if (ratio < 1) {
        requestAnimationFrame(step);
      } else {
        renderAssistantContent(target, content);
      }
    };
    requestAnimationFrame(step);
  }

  function renderAndAppendImagePlanCard(pendingListingImages, messagesEl, messageIndex, options = {}) {
    const hasActiveJob = Boolean(pendingListingImages.generation_job_id && pendingListingImages.status === 'generating');
    const completed = pendingListingImages.status === 'applied' || pendingListingImages.workflow_state === 'images_attached';
    const imgCard = renderListingImagesCard(
      pendingListingImages,
      (plan, cardEl) => generateListingImages(plan, cardEl, messageIndex),
      (plan, cardEl) => applyListingImages(plan, cardEl, messageIndex),
      (cardEl) => {
        cardEl.style.opacity = '0.4';
        const genBtn = cardEl.querySelector('#listing-img-generate-btn');
        const applyBtn = cardEl.querySelector('#listing-img-apply-btn');
        const cancelBtn = cardEl.querySelector('#listing-img-cancel-btn');
        if (genBtn) genBtn.disabled = true;
        if (applyBtn) applyBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        clearPendingAction(messageIndex, 'pending_listing_images');
      },
      { restored: options.restored && !hasActiveJob && !completed, completed },
    );
    const imgWrap = document.createElement('div');
    imgWrap.style.cssText = 'max-width:820px';
    imgWrap.appendChild(imgCard);
    messagesEl.appendChild(imgWrap);
    if (hasActiveJob && messageIndex >= 0) {
      setTimeout(() => generateListingImages(pendingListingImages, imgCard, messageIndex), 0);
    } else if (pendingListingImages.generated_images?.length) {
      hydrateGeneratedImagePreviews(pendingListingImages.generated_images).then(images => {
        const hydrated = { ...pendingListingImages, generated_images: images };
        imgWrap.innerHTML = '';
        imgWrap.appendChild(renderListingImagesCard(
          hydrated,
          (plan, cardEl) => generateListingImages(plan, cardEl, messageIndex),
          (plan, cardEl) => applyListingImages(plan, cardEl, messageIndex),
          (cardEl) => { cardEl.style.opacity = '0.4'; },
          { restored: options.restored && !completed, completed },
        ));
      }).catch(() => {});
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendMessage(role, content, pendingUpdates, pendingSocialPost, pendingDuplicate, pendingScheduledPost, navigationAction, messageIndex, pendingFieldFills, imgData, pendingBatchSchedule, pendingDeletePost, pendingVariations, pendingGenerateListing, pendingClearVariations, pendingRemoveVariationProperty, pendingListingImages, pendingPriceMultiplierInventory, debugTrace, options = {}) {
    clearAgentWelcome();
    const rolePresentation = agentMessageRolePresentation(role);
    const wrap = document.createElement('div');
    wrap.className = rolePresentation.wrapClassName;
    wrap.style.cssText = rolePresentation.wrapStyle;

    const bubble = document.createElement('div');
    bubble.className = rolePresentation.bubbleClassName;
    bubble.style.cssText = rolePresentation.bubbleStyle;

    const copyLabel = document.createElement('span');
    copyLabel.className = 'agent-copy-sender-label';
    copyLabel.textContent = rolePresentation.senderLabel;
    bubble.appendChild(copyLabel);

    if (role === 'user') {
      // Show attached image thumbnail above the text
      if (imgData?.preview) {
        const imgWrap = document.createElement('div');
        imgWrap.style.cssText = 'margin-bottom:8px';
        const thumb = document.createElement('img');
        thumb.src = imgData.preview;
        thumb.alt = 'attached image';
        thumb.style.cssText = 'max-width:220px;max-height:180px;border-radius:8px;display:block;border:2px solid rgba(255,255,255,0.3);cursor:pointer';
        thumb.onclick = () => window.__agentViewImg?.(imgData.preview);
        imgWrap.appendChild(thumb);
        bubble.appendChild(imgWrap);
      }
      if (content) {
        const textNode = document.createTextNode(content);
        bubble.appendChild(textNode);
      }
    } else if (role === 'runtime') {
      const contentHost = document.createElement('div');
      contentHost.className = 'agent-message-content';
      contentHost.textContent = String(content || 'Etsy AI Command Center encountered an internal runtime problem.');
      bubble.appendChild(contentHost);
    } else {
      const contentHost = document.createElement('div');
      contentHost.className = 'agent-message-content';
      bubble.appendChild(contentHost);
      if (options.restored || options.animate === false) renderAssistantContent(contentHost, content);
      else typeAssistantContent(contentHost, content);
    }
    wrap.appendChild(bubble);

    // ── Action buttons ────────────────────────────────────
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:2px;margin-top:3px';
    const btnStyle = 'background:none;border:none;cursor:pointer;font-size:10px;color:var(--text-3);padding:2px 6px;border-radius:4px';
    const hoverOn  = e => e.currentTarget.style.color = 'var(--text)';
    const hoverOff = e => e.currentTarget.style.color = 'var(--text-3)';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.style.cssText = btnStyle;
    copyBtn.onmouseenter = hoverOn; copyBtn.onmouseleave = hoverOff;
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(formatAgentMessageForCopy(role, content)).then(() => {
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      }).catch(() => {});
    };
    actions.appendChild(copyBtn);

    if (role === 'user') {
      const editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.style.cssText = btnStyle;
      editBtn.onmouseenter = hoverOn; editBtn.onmouseleave = hoverOff;
      editBtn.onclick = () => {
        // Remove this specific user message and the following assistant response from history
        if (messageIndex !== undefined && messageIndex >= 0) {
          // Remove user message and assistant response if it exists
          const removeCount = agentMessages[messageIndex + 1]?.role === 'assistant' ? 2 : 1;
          agentMessages.splice(messageIndex, removeCount);
          saveHistory(agentMessages);
          renderAll();
        }
        if (inputEl) {
          inputEl.value = content;
          inputEl.focus();
          inputEl.style.height = 'auto';
          inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
        }
        if (imgData) showAttachment(imageFromHistoryPayload(imgData));
      };
      actions.appendChild(editBtn);

      const retryBtn = document.createElement('button');
      retryBtn.textContent = 'Retry';
      retryBtn.style.cssText = btnStyle;
      retryBtn.onmouseenter = hoverOn; retryBtn.onmouseleave = hoverOff;
      retryBtn.onclick = () => {
        if (messageIndex === undefined || messageIndex < 0) return;
        // Keep user message at messageIndex — remove only the error(s) after it
        const removeFrom = messageIndex + 1;
        const removeCount = agentMessages.length - removeFrom;
        if (removeCount > 0) {
          agentMessages.splice(removeFrom, removeCount);
          saveHistory(agentMessages);
        }
        clearRememberedAgentListingTarget();
        renderAll();
        // Re-send without re-adding the user message (it's already in history)
        window.__agentSend(content, { isRetry: true, retryImage: imgData ? imageFromHistoryPayload(imgData) : null });
      };
      actions.appendChild(retryBtn);
    }

    wrap.appendChild(actions);
    messagesEl.appendChild(wrap);
    if (role === 'assistant') {
      const traceEl = renderAgentDebugTrace(debugTrace);
      if (traceEl) messagesEl.appendChild(traceEl);
    }

    if (pendingUpdates && pendingUpdates.updates?.length) {
      const planCard = renderPlanCard(
        pendingUpdates,
        (plan, el) => executeUpdates(plan, el, messageIndex),
        (el) => {
          cancelPendingCard(el, messageIndex, 'pending_updates', ['#plan-approve-btn', '#plan-cancel-btn']);
          agentMessages.push({ role: 'assistant', content: 'Changes cancelled.' });
          saveHistory(agentMessages);
          appendMessage('assistant', 'Changes cancelled.');
          scrollBottom();
        },
        { restored: options.restored }
      );
      const planWrap = document.createElement('div');
      planWrap.style.cssText = 'max-width:820px';
      planWrap.appendChild(planCard);
      messagesEl.appendChild(planWrap);
    }

    if (pendingPriceMultiplierInventory?.listings?.length) {
      const priceCard = renderPriceMultiplierInventoryCard(
        pendingPriceMultiplierInventory,
        (plan, el) => executePriceMultiplierInventory(plan, el, messageIndex),
        (el) => {
          cancelPendingCard(el, messageIndex, 'pending_price_multiplier_inventory', ['#price-mult-approve-btn', '#price-mult-cancel-btn']);
          scrollBottom();
        },
        { restored: options.restored },
      );
      const priceWrap = document.createElement('div');
      priceWrap.style.cssText = 'max-width:820px';
      priceWrap.appendChild(priceCard);
      messagesEl.appendChild(priceWrap);
    }

    if (pendingSocialPost?.caption) {
      const socialCard = renderSocialPostCard(
        pendingSocialPost,
        (post, el) => executeSocialPost(post, el, messageIndex),
        { restored: options.restored },
      );
      const socialWrap = document.createElement('div');
      socialWrap.style.cssText = 'max-width:820px';
      socialWrap.appendChild(socialCard);
      messagesEl.appendChild(socialWrap);
    }

    if (pendingScheduledPost?.caption) {
      const schedCard = renderScheduledPostCard(
        pendingScheduledPost,
        (post, el) => executeScheduledPost(post, el, messageIndex),
        (el) => {
          cancelPendingCard(el, messageIndex, 'pending_scheduled_post', ['#sched-confirm-btn', '#sched-cancel-btn']);
          scrollBottom();
        },
        { restored: options.restored },
      );
      const schedWrap = document.createElement('div');
      schedWrap.style.cssText = 'max-width:820px';
      schedWrap.appendChild(schedCard);
      messagesEl.appendChild(schedWrap);
    }

    if (pendingDuplicate?.source_listing_id) {
      const dupCard = renderDuplicateCard(
        pendingDuplicate,
        (dup, el) => executeDuplicate(dup, el, messageIndex),
        (el) => {
          cancelPendingCard(el, messageIndex, 'pending_duplicate', ['#dup-approve-btn', '#dup-cancel-btn']);
          agentMessages.push({ role: 'assistant', content: 'Duplication cancelled.', cancelled_duplicate: normalizeDuplicateProposal(pendingDuplicate) });
          saveHistory(agentMessages);
          appendMessage('assistant', 'Duplication cancelled.');
          scrollBottom();
        },
        { restored: options.restored },
      );
      const dupWrap = document.createElement('div');
      dupWrap.style.cssText = 'max-width:820px';
      dupWrap.appendChild(dupCard);
      messagesEl.appendChild(dupWrap);
    }

    if (pendingFieldFills?.fields?.length) {
      const fillCard = renderFieldFillCard(
        { ...pendingFieldFills, _messageIndex: messageIndex },
        (fills, cardEl) => applyFieldFills({ ...fills, _messageIndex: messageIndex }, cardEl),
        { restored: options.restored },
      );
      const fillWrap = document.createElement('div');
      fillWrap.style.cssText = 'max-width:820px';
      fillWrap.appendChild(fillCard);
      messagesEl.appendChild(fillWrap);
    }

    if (pendingBatchSchedule?.posts?.length) {
      const batchCard = renderBatchScheduleCard(
        pendingBatchSchedule,
        (batch, cardEl) => executeBatchSchedule(batch, cardEl, messageIndex),
        (cardEl) => cancelPendingCard(cardEl, messageIndex, 'pending_batch_schedule', ['#batch-approve-btn', '#batch-cancel-btn']),
        { restored: options.restored },
      );
      const batchWrap = document.createElement('div');
      batchWrap.style.cssText = 'max-width:820px';
      batchWrap.appendChild(batchCard);
      messagesEl.appendChild(batchWrap);
    }

    if (pendingDeletePost?.id) {
      const delCard = renderDeletePostCard(
        pendingDeletePost,
        (dp, cardEl) => executeDeletePost(dp, cardEl, messageIndex),
        (cardEl) => cancelPendingCard(cardEl, messageIndex, 'pending_delete_post', ['#delpost-confirm-btn', '#delpost-cancel-btn']),
        { restored: options.restored },
      );
      const delWrap = document.createElement('div');
      delWrap.style.cssText = 'max-width:820px';
      delWrap.appendChild(delCard);
      messagesEl.appendChild(delWrap);
    }

    if (pendingVariations && (pendingVariations.listing_type || pendingVariations.properties?.length)) {
      const varCard = renderVariationsCard(
        { ...pendingVariations, _messageIndex: messageIndex },
        (data, cardEl) => applyVariations({ ...data, _messageIndex: messageIndex }, cardEl),
        { restored: options.restored },
      );
      const varWrap = document.createElement('div');
      varWrap.style.cssText = 'max-width:820px';
      varWrap.appendChild(varCard);
      messagesEl.appendChild(varWrap);
    }

    if (pendingGenerateListing?.description) {
      const draftDone = runGenerateListing(pendingGenerateListing, messagesEl, messageIndex, options);
      // If image plan arrived in the same response, defer it until draft card renders
      if (pendingListingImages?.listing_id) {
        draftDone.then(() => {
          renderAndAppendImagePlanCard(pendingListingImages, messagesEl, messageIndex, options);
        }).catch(() => {
          // Still show image plan even if draft failed
          renderAndAppendImagePlanCard(pendingListingImages, messagesEl, messageIndex, options);
        });
      }
    } else if (pendingListingImages?.listing_id) {
      renderAndAppendImagePlanCard(pendingListingImages, messagesEl, messageIndex, options);
    }

    if (pendingClearVariations?.listings?.length) {
      const clearCard = renderClearVariationsCard(
        pendingClearVariations,
        (plan, cardEl) => executeClearVariations(plan, cardEl, messageIndex),
        (cardEl) => cancelPendingCard(cardEl, messageIndex, 'pending_clear_variations', ['#clear-var-approve-btn', '#clear-var-cancel-btn']),
        { restored: options.restored },
      );
      const clearWrap = document.createElement('div');
      clearWrap.style.cssText = 'max-width:820px';
      clearWrap.appendChild(clearCard);
      messagesEl.appendChild(clearWrap);
    }

    if (pendingRemoveVariationProperty?.listings?.length) {
      const removePropCard = renderRemoveVariationPropertyCard(
        pendingRemoveVariationProperty,
        (plan, cardEl) => executeRemoveVariationProperty(plan, cardEl, messageIndex),
        (cardEl) => cancelPendingCard(cardEl, messageIndex, 'pending_remove_variation_property', ['#remove-var-prop-approve-btn', '#remove-var-prop-cancel-btn']),
        { restored: options.restored },
      );
      const removePropWrap = document.createElement('div');
      removePropWrap.style.cssText = 'max-width:820px';
      removePropWrap.appendChild(removePropCard);
      messagesEl.appendChild(removePropWrap);
    }

    if (navigationAction?.page) {
      const { page, params } = navigationAction;
      const navWrap = document.createElement('div');
      navWrap.style.cssText = 'max-width:820px;margin-top:6px';
      const navBtn = document.createElement('button');
      navBtn.className = 'btn btn-sm';
      navBtn.style.cssText = 'background:var(--orange);color:#fff;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600';
      navBtn.textContent = page === 'create' && params?.restoreDraft ? 'Open current listing draft' : `→ Open: ${page}`;
      navBtn.onclick = async () => {
        navBtn.disabled = true;
        navBtn.textContent = 'Opening…';
        await window.navigate?.(page, params || {});
        setTimeout(() => {
          const panel = document.getElementById('agent-float-panel');
          if (panel && panel.style.display === 'none') window.toggleAgentFloat?.();
        }, 150);
      };
      navWrap.appendChild(navBtn);
      messagesEl.appendChild(navWrap);
    }

    scrollBottom();
  }

  // ── Image analysis result card ────────────────────────────
  function appendImageAnalysis(analysis, imgRef) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;max-width:820px';

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:4px 14px 14px 14px;font-size:13px;max-width:820px;box-shadow:var(--shadow-sm);overflow:hidden';

    const analysisHtml = `
      <div style="padding:12px 16px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v4M8 11v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Image analysis
        </div>
        <div style="line-height:1.6;color:var(--text)">${md(analysis)}</div>
      </div>
      <div style="padding:10px 16px;border-top:1px solid var(--border);background:var(--bg-secondary);display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button id="img-gen-btn" class="btn btn-sm btn-primary" style="gap:5px">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M2 10l3-3 2 2 3-3 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Generate variations
        </button>
        <select id="img-gen-count" style="font-size:11px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);cursor:pointer">
          <option value="2">2 images</option>
          <option value="4" selected>4 images</option>
          <option value="6">6 images</option>
        </select>
        <button id="img-listing-btn" class="btn btn-sm" style="margin-left:auto;gap:5px;color:var(--orange)">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-9 9H2v-3l9-9z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
          Create listing →
        </button>
      </div>
      <div id="img-gen-results" style="display:none;padding:12px 16px;border-top:1px solid var(--border)"></div>`;

    card.innerHTML = analysisHtml;
    wrap.appendChild(card);
    messagesEl.appendChild(wrap);
    scrollBottom();

    // Add to chat history as text-only (no base64 stored)
    agentMessages.push({ role: 'assistant', content: analysis });
    saveHistory(agentMessages);

    // ── "Generate variations" button ────────────────────────
    card.querySelector('#img-gen-btn').onclick = async () => {
      const genBtn   = card.querySelector('#img-gen-btn');
      const countSel = card.querySelector('#img-gen-count');
      const resultsEl = card.querySelector('#img-gen-results');
      const count = parseInt(countSel?.value || '4');

      genBtn.disabled = true;
      genBtn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px"></div> Generating…';
      resultsEl.style.display = 'block';
      resultsEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-3);font-size:12px;padding:8px 0">
          <div class="spinner" style="width:14px;height:14px;border-width:2px"></div>
          Generating ${count} image${count > 1 ? 's' : ''}…
        </div>`;

      try {
        const provider = localStorage.getItem('image_provider') || 'external';
        const prompts = Array.from({ length: count }, (_, idx) => `${analysis.slice(0, 400)}\n\nCreate variation ${idx + 1} of ${count}. Keep the uploaded reference design recognizable and use a distinct Etsy-ready mockup composition.`);
        const job = await jobs.startImageGeneration({
          prompts,
          aspectRatio: '1:1',
          count,
          provider,
          referenceImage: { base64: imgRef.base64, mimeType: imgRef.mimeType },
          timeoutMs: AGENT_IMAGE_JOB_TIMEOUT_MS,
        });
        const result = await pollAgentImageJob(job.id, AGENT_IMAGE_JOB_TIMEOUT_MS + AGENT_IMAGE_JOB_POLL_GRACE_MS);
        const images = (result?.images || []).filter(img => img?.base64);
        if (!images.length) throw new Error('Generation failed');

        resultsEl.innerHTML = `
          <div style="font-size:11px;font-weight:600;color:var(--text-3);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px">
            Generated ${images.length} image${images.length > 1 ? 's' : ''} — based on your reference
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px" id="gen-grid"></div>`;

        const grid = resultsEl.querySelector('#gen-grid');
        for (const img of images) {
          const imgCard = document.createElement('div');
          imgCard.style.cssText = 'border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg-secondary)';
          imgCard.innerHTML = `
            <img src="data:${img.mimeType};base64,${img.base64}" alt="generated" style="width:100%;aspect-ratio:1;object-fit:cover;display:block;cursor:pointer" onclick="window.__agentViewImg?.(this.src)">
            <div style="padding:6px 8px;display:flex;gap:5px">
              <button class="btn btn-sm" style="flex:1;font-size:10px;padding:3px 6px" title="Add to gallery">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                Gallery
              </button>
              <a href="data:${img.mimeType};base64,${img.base64}" download="agent-gen-${Date.now()}.jpg" class="btn btn-sm" style="font-size:10px;padding:3px 6px" title="Download">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M4 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </a>
            </div>`;

          // "Gallery" button handler
          const galleryBtn = imgCard.querySelector('button');
          galleryBtn.onclick = async () => {
            galleryBtn.disabled = true;
            galleryBtn.innerHTML = '<div class="spinner" style="width:8px;height:8px;border-width:1.5px;display:inline-block"></div>';
            try {
              await saveImage({ base64: img.base64, mimeType: img.mimeType, prompt: analysis.slice(0, 200), slotLabel: 'Agent', listingTitle: '' });
              galleryBtn.innerHTML = '✓ Saved';
              galleryBtn.style.color = 'var(--green-text,#2e7d32)';
              toastSuccess('Added to gallery!');
            } catch {
              galleryBtn.disabled = false;
              galleryBtn.innerHTML = 'Retry';
              toastError('Could not save to gallery');
            }
          };
          grid.appendChild(imgCard);
        }

        genBtn.innerHTML = `✓ ${images.length} generated`;
        genBtn.style.background = 'var(--bg-secondary)';
        genBtn.style.borderColor = 'var(--border)';
        genBtn.style.color = 'var(--text-2)';
        toastSuccess(`${images.length} images generated!`);
      } catch (e) {
        resultsEl.innerHTML = `<div style="font-size:12px;color:var(--red-text,#c62828);padding:4px 0">Error: ${esc(e.message)}</div>`;
        genBtn.disabled = false;
        genBtn.innerHTML = '↻ Retry';
        toastError(e.message);
      }
    };

    // ── "Create listing" button ──────────────────────────────
    card.querySelector('#img-listing-btn').onclick = () => {
      const btn = card.querySelector('#img-listing-btn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Creating draft...';
      }
      runGenerateListing({
        description: String(analysis || '').slice(0, 1200),
        listing_type: 'download',
        extra: 'Use the attached image as visual/product context and as a reference for generated listing images. Do not attach the uploaded original unchanged unless the user explicitly asks for that.',
        reference_image: listingReferenceImageFromAttachment(imgRef),
      }, messagesEl);
    };
  }

  // ── Fullscreen image viewer ───────────────────────────────
  window.__agentViewImg = (src) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
    ov.onclick = () => ov.remove();
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;object-fit:contain;box-shadow:0 8px 40px rgba(0,0,0,0.6)';
    img.onclick = e => e.stopPropagation();
    ov.appendChild(img);
    document.body.appendChild(ov);
    const close = e => { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', close); } };
    document.addEventListener('keydown', close);
  };

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderAll() {
    messagesEl.innerHTML = '';
    if (!agentMessages.length) {
      messagesEl.innerHTML = agentWelcomeMarkup();
      renderChips();
      return;
    }
    for (let i = 0; i < agentMessages.length; i++) {
      const msg = agentMessages[i];
      const restored = msg.role === 'assistant' && msg.agent_ui_runtime_id !== AGENT_UI_RUNTIME_ID;
      appendMessage(msg.role, msg.content, msg.pending_updates || null, msg.pending_social_post || null, msg.pending_duplicate || null, msg.pending_scheduled_post || null, msg.navigation_action || null, i, msg.pending_field_fills || null, msg._imgData || null, msg.pending_batch_schedule || null, msg.pending_delete_post || null, msg.pending_variations || null, msg.pending_generate_listing || null, msg.pending_clear_variations || null, msg.pending_remove_variation_property || null, msg.pending_listing_images || null, msg.pending_price_multiplier_inventory || null, msg.debug_trace || null, { restored, animate: false });
    }
    clearAgentWelcome();
    renderChips();
  }

  window.__agentRenderRuntimeEvent = record => {
    appendMessage('runtime', record?.content || 'Etsy AI Command Center encountered an internal runtime problem.', null, null, null, null, null, agentMessages.indexOf(record), null, null, null, null, null, null, null, null, null, null, null, { animate: false });
    scrollBottom();
  };

  let progressStartedAt = 0;
  let progressStageStartedAt = 0;
  let progressEvent = null;
  let progressTimer = null;

  function renderProgress() {
    const statusEl = messagesEl.querySelector('#agent-tool-status');
    if (!statusEl || !progressStartedAt) return;
    statusEl.textContent = formatAgentProgress(progressEvent, agentProgressElapsedMs(progressStageStartedAt, performance.now()));
  }

  function appendProgressResult(event) {
    const historyEl = messagesEl.querySelector('#agent-progress-history');
    if (!historyEl) return;
    const row = document.createElement('div');
    row.style.cssText = 'overflow-wrap:anywhere';
    row.textContent = formatAgentProgress(event);
    historyEl.appendChild(row);
    while (historyEl.children.length > 5) historyEl.firstElementChild?.remove();
  }

  function setLoading(on) {
    sendBtn.disabled = on;
    if (on) {
      messagesEl.querySelectorAll('.agent-progress-complete').forEach(el => el.remove());
      if (messagesEl.querySelector('#agent-loading')) return;
      progressStartedAt = performance.now();
      progressStageStartedAt = progressStartedAt;
      progressEvent = null;
      clearAgentWelcome();
      sendBtn.style.opacity = '0.5';
      sendBtn.style.cursor = 'not-allowed';
      const loading = document.createElement('div');
      loading.id = 'agent-loading';
      loading.style.cssText = 'display:flex;flex-direction:column;gap:3px;color:var(--text-3);font-size:12px';
      loading.innerHTML = agentLoadingMarkup();
      messagesEl.appendChild(loading);
      renderProgress();
      clearInterval(progressTimer);
      progressTimer = setInterval(renderProgress, 1000);
      scrollBottom();
    } else {
      clearInterval(progressTimer);
      progressTimer = null;
      progressStartedAt = 0;
      progressStageStartedAt = 0;
      progressEvent = null;
      sendBtn.style.opacity = '1';
      sendBtn.style.cursor = 'pointer';
      const loading = messagesEl.querySelector('#agent-loading');
      const history = loading?.querySelector('#agent-progress-history');
      if (history?.children.length) {
        const completed = document.createElement('div');
        completed.className = 'agent-progress-complete';
        completed.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding-left:22px;font-size:10px;color:var(--text-3)';
        completed.appendChild(history);
        messagesEl.appendChild(completed);
      }
      loading?.remove();
    }
  }

  const refreshActiveTurnUi = (change = {}) => {
    if (!messagesEl.isConnected) {
      _activeAgentTurnListeners.delete(refreshActiveTurnUi);
      return;
    }
    const turn = _activeAgentTurn;
    if (turn?.session_id === _currentSessionId) {
      setLoading(true);
      const mountedAt = performance.now();
      progressStartedAt = mountedAt;
      progressStageStartedAt = mountedAt;
      progressEvent = turn.progress || { type: 'tool', message: turn.stage || 'Working on your request' };
      renderProgress();
      return;
    }
    setLoading(false);
    if (change.type === 'interrupted' || (change.type === 'finished' && change.turn?.owner_instance_id !== renderInstanceId)) renderAll();
  };
  _activeAgentTurnListeners.add(refreshActiveTurnUi);
  refreshActiveTurnUi({ type: 'mount' });

  const resumeTrackedTurn = async () => {
    const turn = _activeAgentTurn;
    if (!turn || turn.runtime_active || turn.session_id !== _currentSessionId) return;
    saveActiveAgentTurn({ ...turn, owner_instance_id: renderInstanceId, runtime_active: true });
    refreshActiveTurnUi();
    try {
      const finalResult = await pollTrackedAgentTurn(turn, event => updateActiveAgentTurn(turn.id, event));
      const response = storeAgentFinalResult(finalResult, turn.id);
      finishActiveAgentTurn(turn.id);
      renderAll();
      await executeListingImageActionFromAgent(response?.pending_listing_image_action);
      await executeDraftImageActionFromAgent(response?.pending_draft_image_action);
    } catch (err) {
      const alreadyStored = agentMessages.some(message => message.agent_turn_id === turn.id && (message.role === 'assistant' || message.role === 'runtime'));
      if (!alreadyStored) {
        recordAgentRuntimeFault(err, { operation: 'resume_agent_turn', job_id: turn.id, retryable: true });
      }
      finishActiveAgentTurn(turn.id);
      renderAll();
    }
  };

  window.__agentSend = async (overrideText, opts = {}) => {
    const text = overrideText || inputEl.value.trim();
    const retryImage = opts.retryImage ? { ...opts.retryImage } : null;
    const hasImage = !!attachedImage || !!retryImage;
    if (!text && !hasImage) return;
    if (sendBtn.disabled) return;
    clearAgentWelcome();

    const turn = startActiveAgentTurn(text, hasImage, renderInstanceId);

    inputEl.value = '';
    inputEl.style.height = 'auto';

    // Capture + clear attachment before async work
    const imgSnap = opts.isRetry && retryImage ? retryImage : (attachedImage ? { ...attachedImage } : retryImage);
    clearAttachmentUI();

    if (!opts.isRetry) {
      // Normal send: add user message to history + DOM
      const userMsg = { role: 'user', content: text, ...(imgSnap ? { _imgData: imageHistoryPayload(imgSnap) } : {}) };
      agentMessages.push(userMsg);
      saveHistory(agentMessages);
      clearAgentWelcome();
      appendMessage('user', text, null, null, null, null, null, agentMessages.length - 1, null, imgSnap, null, null, null, null, null, null, null);
      renderChips();
    }
    setLoading(true);

    const onProgress = (event) => {
      updateActiveAgentTurn(turn.id, event);
      if (event?.type === 'tool_result') appendProgressResult(event);
      progressEvent = event;
      progressStageStartedAt = performance.now();
      renderProgress();
    };

    try {
      if (imgSnap) {
        try {
          // Analyze the attachment before passing grounded image facts to the agent.
          const visionPrompt = text || 'Describe this image in detail. What product is shown? What style, materials, colors? How could it be used for an Etsy listing?';
          const r = await fetch('/api/media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'analyzeImage',
              referenceImage: { base64: imgSnap.base64, mimeType: imgSnap.mimeType },
              prompt: visionPrompt,
            }),
          });
          const d = await readJsonResponse(r, 'Image analysis');
          setLoading(false);
          if (text) {
            setLoading(true);
            const resp = await sendAgentMessage(text, onProgress, {
              ...attachedImageContext(imgSnap, d.analysis),
              _agent_turn_id: turn.id,
            });
            setLoading(false);
            if (resp) {
              const msgIdx = agentMessages.length - 1;
              if (resp.pending_generate_listing) {
                if (resp.pending_generate_listing.attached_image_role === 'listing_image') {
                  resp.pending_generate_listing.attached_images = draftImagesFromAttachment(imgSnap);
                } else {
                  resp.pending_generate_listing.reference_image = listingReferenceImageFromAttachment(imgSnap);
                }
                if (agentMessages[msgIdx]) {
                  agentMessages[msgIdx].pending_generate_listing = resp.pending_generate_listing;
                  saveHistory(agentMessages);
                }
              }
              appendMessage('assistant', resp.message, resp.pending_updates, resp.pending_social_post, resp.pending_duplicate, resp.pending_scheduled_post, resp.navigation_action, msgIdx, resp.pending_field_fills, null, resp.pending_batch_schedule, resp.pending_delete_post, resp.pending_variations, resp.pending_generate_listing, resp.pending_clear_variations, resp.pending_remove_variation_property, resp.pending_listing_images, resp.pending_price_multiplier_inventory, resp.debug_trace);
              await executeListingImageActionFromAgent(resp.pending_listing_image_action);
              await executeDraftImageActionFromAgent(resp.pending_draft_image_action);
            }
          } else {
            appendImageAnalysis(d.analysis, imgSnap);
          }
        } catch (err) {
          setLoading(false);
          recordAgentRuntimeFault(err, { operation: 'analyze_attached_image', job_id: turn.id, retryable: true });
        }
      } else {
        // Text-only path: normal agent
        const resp = await sendAgentMessage(text, onProgress, { _agent_turn_id: turn.id });
        setLoading(false);
        if (resp) {
          // sendAgentMessage already pushed the assistant message; its index is length-1
          const msgIdx = agentMessages.length - 1;
          appendMessage('assistant', resp.message, resp.pending_updates, resp.pending_social_post, resp.pending_duplicate, resp.pending_scheduled_post, resp.navigation_action, msgIdx, resp.pending_field_fills, null, resp.pending_batch_schedule, resp.pending_delete_post, resp.pending_variations, resp.pending_generate_listing, resp.pending_clear_variations, resp.pending_remove_variation_property, resp.pending_listing_images, resp.pending_price_multiplier_inventory, resp.debug_trace);
          await executeListingImageActionFromAgent(resp.pending_listing_image_action);
          await executeDraftImageActionFromAgent(resp.pending_draft_image_action);
        }
      }
    } catch (e) {
      setLoading(false);
      recordAgentRuntimeFault(e, { operation: 'agent_ui_turn', job_id: turn.id, retryable: true });
    } finally {
      finishActiveAgentTurn(turn.id);
    }
  };

  clearBtn.onclick = () => {
    if (!confirm('Start a new chat? Current conversation will be saved to history.')) return;
    _currentSessionId = _genSessionId();
    agentSessionStorage.setItem('agent_current_session', _currentSessionId);
    agentMessages.length = 0;
    clearRememberedAgentListingTarget();
    clearLatestAgentDraft();
    try { agentSessionStorage.setItem(HISTORY_KEY, '[]'); } catch {}
    renderAll();
  };

  await _initSession();
  renderAll();
  refreshActiveTurnUi();
  void resumeTrackedTurn();
  setTimeout(() => inputEl?.focus(), 100);
}
