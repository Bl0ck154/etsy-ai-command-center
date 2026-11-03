// public/pages/create.js — Create / Edit listing with AI generation

import { etsy, ai, jobs, fetchJsonWithTimeout, userFacingErrorMessage } from '../utils/api.js';
import { escHtml, charCount } from '../utils/format.js';
import { toastSuccess, toastError, toastInfo } from '../components/toast.js';
import { ImageUploader } from '../components/image-uploader.js';
import { openGalleryPicker as showGalleryPicker } from '../components/gallery-picker.js';
import { VariationsManager } from '../components/variations.js';
import { TaxonomySelect } from '../components/taxonomy-select.js';
import { generateImagePrompt, prefetchImagePrompts, generateCoverPrompt } from '../components/image-prompt.js';
import { getShopContext, buildContextPrompt } from '../utils/shop-context.js';
import { getOrFetch } from '../utils/store.js';
import { getModel } from '../utils/models.js';
import { drafts as idbDrafts } from '../utils/idb.js';
import { viewOnEtsyButton, listingIdBadge } from '../components/view-on-etsy-button.js';
import { listingVideoUrl, normalizeMediaUrl } from '../utils/media-url.js';
import { saveImage, getImage, warmGalleryImageSummaries } from '../utils/image-store.js';
import { base64ToFile } from '../utils/file-helpers.js';
import { agentRuntimeUserMessage, classifyAgentRuntimeError, runIdempotentRuntimeRecovery } from '../utils/agent-runtime-contract.js';
import { listingReadiness, migrateLegacyVariationPrices, moneyNumber } from '../utils/listing-readiness.js';
import {
  defaultReadinessProfileId,
  publishReadinessPresentation,
  readinessProfileControlMarkup,
  shippingProfileControlMarkup,
  variationPricingPresentation,
} from '../utils/create-view-model.js';
import {
  createPersonalizationQuestion,
  defaultUploadPersonalizationQuestions,
  normalizeGeneratedPersonalizationQuestions,
  normalizePersonalizationQuestions,
  personalizationPayload,
  personalizationQuestionsMarkup,
  readPersonalizationQuestions,
} from '../utils/create-personalization-view.js';

window.viewImageFullscreen = (src) => {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
  overlay.onclick = () => overlay.remove();
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:90vw;max-height:90vh;object-fit:contain;border-radius:8px';
  overlay.appendChild(img);
  document.body.appendChild(overlay);
};
import { invalidate } from '../utils/store.js';

const PRODUCT_TYPES = [
  { value: 'canva_template', label: 'Canva Template' },
  { value: 'svg_bundle', label: 'SVG / PNG Bundle' },
  { value: 'sublimation', label: 'Sublimation Design' },
  { value: 'ai_photo_merge', label: 'AI Photo Merge' },
  { value: 'ai_animation', label: 'AI Animation / Video' },
  { value: 'watercolor_portrait', label: 'Custom Watercolor Portrait' },
  { value: 'digital_planner', label: 'Digital Planner / Journal' },
  { value: 'wall_art', label: 'Printable Wall Art' },
  { value: 'clipart', label: 'Clipart / Illustration Set' },
  { value: 'font', label: 'Font / Typography' },
  { value: 'social_media_kit', label: 'Social Media Kit / Template' },
  { value: 'mockup', label: 'Mockup / Scene Creator' },
  { value: 'resume_template', label: 'Resume / CV Template' },
  { value: 'business_card', label: 'Business Card Template' },
  { value: 'invitation', label: 'Invitation / Card Design' },
  { value: 'other', label: 'Other Digital Product' },
];
// Populated from shop sections at runtime
let shopSectionTypes = [];

let state = {
  step: 1,
  mode: 'create',
  listingId: null,
  provider: localStorage.getItem('ai_provider') || 'external',
  productType: 'canva_template',
  listingType: 'download',
  description: '',
  price: '',
  extra: '',
  generated: null,
  form: {},
  sections: [],
  shippingProfiles: [],
  shippingProfilesStatus: 'idle',
  shippingProfilesError: '',
  readinessProfiles: [],
  readinessProfilesStatus: 'idle',
  readinessProfilesError: '',
  returnPolicies: [],
  loading: false,
  generating: false,
  publishedId: null,
  publishedUrl: null,
  socialPosts: null,
  tags: [],
  materials: [],
  personalizationQuestions: [],
  imageUploader: null,
  variationsManager: null,
  taxonomySelect: null,
  _coverImageGenerating: false,
  _draftInterval: null,
  agentControlledDraft: false,
  restoringDraft: false,
  coverImageJobId: null,
  coverImagePrompt: '',
  imageGenerationJobs: {},
  imageGenerationImages: {},
  _agentAttachedImages: [],
  _agentStoredImageIds: [],
  _agentWorkflowId: null,
  _draftId: null,
  _agentReferenceImage: null,
  _draftDirty: true,
  _draftChangeVersion: 0,
  _draftRevision: 0,
  _serverDraftRevision: 0,
  _replaceServerDraft: false,
};

function markDraftDirty() {
  state._draftDirty = true;
  state._draftChangeVersion = (Number(state._draftChangeVersion) || 0) + 1;
}

function normalizeAgentDraftParams(params = {}) {
  const generated = params.agentDraft?.generated || params.generated || params.agent_generated || null;
  if (!generated || typeof generated !== 'object') return null;
  return {
    generated: {
      ...generated,
      title: String(generated.title || '').trim(),
      description: String(generated.description || '').trim(),
      tags: Array.isArray(generated.tags) ? generated.tags.map(String).filter(Boolean).slice(0, 13) : [],
      materials: Array.isArray(generated.materials) ? generated.materials.map(String).filter(Boolean).slice(0, 13) : [],
      price_suggestion: generated.price_suggestion ?? generated.price ?? params.price ?? '',
      personalization_questions: Array.isArray(generated.personalization_questions) ? generated.personalization_questions : [],
    },
    description: params.agentDraft?.description || params.description || generated.source_description || generated.brief || '',
    productType: params.agentDraft?.productType || params.productType || 'other',
    listingType: params.agentDraft?.listingType || params.listingType || generated.listing_type || 'download',
    price: params.agentDraft?.price || params.price || generated.price_suggestion || generated.price || '',
    taxonomyId: params.agentDraft?.taxonomy_id || params.taxonomy_id || null,
    taxonomyCategory: params.agentDraft?.taxonomy_category || params.taxonomy_category || generated.taxonomy_category || null,
    shippingProfileId: params.agentDraft?.shipping_profile_id || params.shipping_profile_id || null,
    readinessStateId: params.agentDraft?.readiness_state_id || params.readiness_state_id || null,
    extra: params.agentDraft?.extra || params.extra || '',
    attachedImages: Array.isArray(params.agentDraft?.attachedImages) ? params.agentDraft.attachedImages : [],
    storedImageIds: Array.isArray(params.agentDraft?.storedImageIds) ? params.agentDraft.storedImageIds.map(String).filter(Boolean) : [],
    workflowId: params.agentDraft?.workflow_id || params.workflow_id || null,
    referenceImage: params.agentDraft?.referenceImage || params.agentDraft?.reference_image || params.referenceImage || params.reference_image || null,
  };
}

// ── Draft autosave (server primary, IndexedDB fallback) ─────
const DRAFT_KEY = 'create_draft';
let serverDraftSaveInFlight = false;
let pendingServerDraft = null;
let serverDraftFlushPromise = null;

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function imageToDraftUrl(img) {
  if (img?.url && /^https?:\/\//i.test(String(img.url))) return img.url;
  if (img?.preview && /^data:image\//i.test(String(img.preview))) return img.preview;
  if (img?.base64) {
    const mimeType = img.mimeType || img.file?.type || 'image/jpeg';
    return String(img.base64).startsWith('data:') ? img.base64 : `data:${mimeType};base64,${img.base64}`;
  }
  if (img?.file) return fileToDataUrl(img.file);
  return null;
}

async function imageToDraftRecord(img, index) {
  const dataUrl = await imageToDraftUrl(img);
  if (!dataUrl || !(/^(https?:\/\/|data:image\/)/i.test(dataUrl))) return null;
  const mimeType = img?.mimeType || img?.file?.type || dataUrl.match(/^data:([^;]+)/i)?.[1] || '';
  return {
    id: img?.id || `draft-image-${index}`,
    galleryId: img?.galleryId || null,
    dataUrl,
    mimeType,
    filename: img?.filename || img?.file?.name || '',
    rank: Number(img?.rank) || index + 1,
    isExisting: Boolean(img?.isExisting),
    etsyListingId: Number(img?.etsyListingId || 0) || null,
    source: img?.source || '',
    prompt: img?.prompt || '',
    slotLabel: img?.slotLabel || '',
    listingTitle: img?.listingTitle || '',
    provider: img?.provider || '',
    model: img?.model || '',
  };
}

function draftShopHeader() {
  try {
    const id = sessionStorage.getItem('etsy_mgr_active_shop');
    return id ? { 'x-shop-id': id } : {};
  } catch { return {}; }
}

async function getServerDraft() {
  const payload = await fetchJsonWithTimeout(
    `/api/drafts?action=get&key=${encodeURIComponent(DRAFT_KEY)}`,
    { method: 'GET', headers: draftShopHeader(), timeoutMs: 10_000 },
    'Draft restore',
    10_000,
  );
  const draft = payload?.data || null;
  if (draft) state._serverDraftRevision = Number(draft.revision) || 0;
  return draft;
}

async function saveServerDraftNow(draft) {
  return fetchJsonWithTimeout(
    '/api/drafts',
    {
      method: 'POST',
      headers: draftShopHeader(),
      body: JSON.stringify({
        action: 'set',
        key: DRAFT_KEY,
        draft,
        expected_revision: Number(state._serverDraftRevision) || 0,
        replace_existing: state._replaceServerDraft === true,
      }),
      timeoutMs: 10_000,
    },
    'Draft save',
    10_000,
  );
}

function queueServerDraftSave(draft) {
  pendingServerDraft = draft;
  if (!serverDraftFlushPromise) {
    serverDraftFlushPromise = (async () => {
      serverDraftSaveInFlight = true;
      let lastError = null;
      try {
        while (pendingServerDraft) {
          const nextDraft = pendingServerDraft;
          pendingServerDraft = null;
          try {
            const saved = await saveServerDraftNow(nextDraft);
            state._serverDraftRevision = Number(saved?.data?.revision || nextDraft.revision) || state._serverDraftRevision;
            state._replaceServerDraft = false;
            lastError = null;
          } catch (err) {
            lastError = err;
            console.warn('[draft autosave] server save failed:', err?.message || err);
          }
        }
      } finally {
        serverDraftSaveInFlight = false;
      }
      return { saved: !lastError, error: lastError };
    })().finally(() => {
      serverDraftFlushPromise = null;
      if (pendingServerDraft) queueServerDraftSave(pendingServerDraft);
    });
  }
  return serverDraftFlushPromise;
}

async function deleteServerDraft() {
  return fetchJsonWithTimeout(
    '/api/drafts',
    {
      method: 'POST',
      headers: draftShopHeader(),
      body: JSON.stringify({
        action: 'delete',
        key: DRAFT_KEY,
        expected_revision: Number(state._serverDraftRevision) || 0,
        draft_id: state._draftId || '',
      }),
      timeoutMs: 10_000,
    },
    'Draft delete',
    10_000,
  );
}

async function waitForServerDraftSaveIdle() {
  if (serverDraftFlushPromise) await serverDraftFlushPromise;
}

function normalizeImagePromptsForDraft(prompts = []) {
  const out = [];
  if (!Array.isArray(prompts)) return out;
  prompts.forEach((prompt, index) => {
    if (!prompt || typeof prompt !== 'object') return;
    const slot = Number.isInteger(prompt.slot) && prompt.slot >= 0 ? prompt.slot : index;
    out[slot] = {
      slot,
      label: prompt.label || '',
      ratio: prompt.ratio || '1:1',
      prompt: String(prompt.prompt || ''),
    };
  });
  return out;
}

function mergeImagePromptsForDraft(primary = [], fallback = []) {
  const merged = normalizeImagePromptsForDraft(fallback);
  normalizeImagePromptsForDraft(primary).forEach((prompt, index) => {
    if (!prompt) return;
    if (prompt.prompt || !merged[index]?.prompt) merged[index] = prompt;
  });
  return merged;
}

function currentImagePromptsForDraft() {
  return mergeImagePromptsForDraft(window.__imgGen?.prompts, state.imagePrompts);
}

async function saveDraft({ surfaceServerError = false, skipIfClean = false } = {}) {
  if (state.mode === 'edit' || !state.generated) return;
  if (skipIfClean && !state._draftDirty) return { skipped: true };
  const changeVersion = state._draftChangeVersion;
  const listingTypeControl = document.getElementById('e-ltype');
  if (listingTypeControl?.value) {
    state.listingType = listingTypeControl.value;
    state.form = { ...(state.form || {}), listing_type: state.listingType };
  }
  const taxonomyId = state.taxonomySelect?.getValue() || null;
  const currentPrice = document.getElementById('e-price')?.value || state.price || '';
  state.price = currentPrice;
  const draftImages = (await Promise.all(
    (state.imageUploader?.images || []).map((img, index) => imageToDraftRecord(img, index)),
  )).filter(Boolean);
  const varMgr = state.variationsManager;
  const variations = varMgr?.enabled
    ? { enabled: true, properties: varMgr.properties, products: varMgr.products, priceOnProperty: varMgr.priceOnProperty || [] }
    : null;
  syncPersonalizationQuestionsFromDom();
  if (!state._draftId) state._draftId = `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const draft = {
    draft_id: state._draftId,
    description: state.description,
    productType: state.productType,
    listingType: state.listingType,
    price: currentPrice,
    extra: state.extra,
    generated: state.generated,
    tags: [...state.tags],
    materials: [...state.materials],
    provider: state.provider,
    title: document.getElementById('e-title')?.value || '',
    desc: document.getElementById('e-desc')?.value || '',
    taxonomy_id: taxonomyId,
    taxonomy_category: state.form?.taxonomy_category || state.generated?.taxonomy_category || '',
    shipping_profile_id: Number(document.getElementById('e-shipping')?.value || state.form?.shipping_profile_id || 0) || null,
    readiness_state_id: Number(document.getElementById('e-readiness')?.value || state.form?.readiness_state_id || 0) || null,
    return_policy_id: Number(document.getElementById('e-return')?.value || state.form?.return_policy_id || 0) || null,
    shop_section_id: Number(document.getElementById('e-section')?.value || state.form?.shop_section_id || 0) || null,
    quantity: Number(document.getElementById('e-qty')?.value || state.form?.quantity || 999) || 999,
    who_made: document.getElementById('e-whomade')?.value || state.form?.who_made || 'i_did',
    when_made: document.getElementById('e-whenmade')?.value || state.form?.when_made || 'made_to_order',
    draftImages,
    variations,
    personalizationQuestions: state.personalizationQuestions,
    imagePrompts: currentImagePromptsForDraft(),
    imageGenerationJobs: window.__imgGen?._slotJobs || state.imageGenerationJobs || {},
    imageGenerationImages: window.__imgGen?._slotImages || state.imageGenerationImages || {},
    coverImageJobId: state.coverImageJobId || null,
    coverImagePrompt: state.coverImagePrompt || '',
    agentReferenceImage: state._agentReferenceImage || null,
    workflow_id: state._agentWorkflowId || null,
    etsyDraftListingId: Number(state.publishedId || 0) || null,
    etsyDraftListingUrl: state.publishedUrl || '',
    createdBy: state.agentControlledDraft ? 'agent' : 'create_page',
    savedAt: Date.now(),
    revision: Math.max(Number(state._draftRevision) + 1 || 0, Date.now()),
  };
  const [serverResult, localResult] = await Promise.allSettled([
    queueServerDraftSave(draft),
    idbDrafts.set(DRAFT_KEY, draft),
  ]);
  const serverSaved = serverResult.status === 'fulfilled' && serverResult.value?.saved !== false;
  const localSaved = localResult.status === 'fulfilled';
  if ((serverSaved || localSaved) && state._draftChangeVersion === changeVersion) {
    state._draftDirty = false;
    state._draftRevision = draft.revision;
  }
  if (!localSaved) console.warn('[draft autosave] local save failed:', localResult.reason?.message || localResult.reason);
  if (!serverSaved && surfaceServerError) {
    toastInfo(localSaved
      ? 'Images saved on this device. Server draft sync will retry automatically.'
      : 'Draft images could not be saved. Please retry.');
  }
  if (!serverSaved && !localSaved) throw new Error('Draft could not be saved locally or on the server');
  return { serverSaved, localSaved, draft };
}

async function clearDraft() {
  pendingServerDraft = null;
  await waitForServerDraftSaveIdle();
  try {
    await deleteServerDraft();
  } catch (err) {
    console.warn('[draft autosave] server delete failed:', err?.message || err);
    return { deleted: false, error: err };
  }
  await idbDrafts.delete(DRAFT_KEY).catch(err => console.warn('[draft autosave] local delete failed:', err?.message || err));
  state._serverDraftRevision = 0;
  state._replaceServerDraft = false;
  return { deleted: true };
}

async function getDraft() {
  const [serverResult, localResult] = await Promise.allSettled([
    getServerDraft(),
    idbDrafts.get(DRAFT_KEY),
  ]);
  const serverDraft = serverResult.status === 'fulfilled' ? serverResult.value : null;
  const localDraft = localResult.status === 'fulfilled' ? localResult.value : null;
  if (serverResult.status === 'rejected') {
    console.warn('[draft autosave] server restore failed:', serverResult.reason?.message || serverResult.reason);
  }
  const draftTime = draft => Number(draft?.savedAt) || Number(draft?.serverSavedAt) || 0;
  if (serverDraft && (!localDraft || draftTime(serverDraft) >= draftTime(localDraft))) {
    idbDrafts.set(DRAFT_KEY, serverDraft).catch(err => console.warn('[draft autosave] local mirror failed:', err?.message || err));
    return serverDraft;
  }
  if (localDraft && serverDraft && draftTime(localDraft) > draftTime(serverDraft)) {
    queueServerDraftSave(localDraft).catch(err => console.warn('[draft autosave] server catch-up failed:', err?.message || err));
  }
  return localDraft;
}

function renderPersonalizationQuestionsWrap() {
  const wrap = document.getElementById('personal-questions-wrap');
  if (wrap) wrap.innerHTML = personalizationQuestionsMarkup(state.personalizationQuestions);
  const addBtn = document.getElementById('add-personal-question-btn');
  if (addBtn) addBtn.disabled = state.personalizationQuestions.length >= 10;
}

function syncPersonalizationQuestionsFromDom() {
  const cards = [...document.querySelectorAll('.personal-question')];
  state.personalizationQuestions = readPersonalizationQuestions(cards, state.personalizationQuestions);
  return state.personalizationQuestions;
}

function getPersonalizationPayload() {
  return personalizationPayload(syncPersonalizationQuestionsFromDom());
}

export async function renderCreate(container, params = {}) {
  clearInterval(state._draftInterval);
  clearInterval(state._genInterval);
  const agentDraft = normalizeAgentDraftParams(params);
  state.step = 1; state.generated = null; state.loading = false;
  state.generating = false; state.publishedId = null; state.socialPosts = null;
  state.tags = []; state.materials = []; state.personalizationQuestions = [];
  state.form = {};
  state.sections = [];
  state.shippingProfiles = [];
  state.shippingProfilesStatus = 'idle';
  state.shippingProfilesError = '';
  state.returnPolicies = [];
  state.readinessProfiles = [];
  state.readinessProfilesStatus = 'idle';
  state.readinessProfilesError = '';
  state.imageUploader = null;
  state.variationsManager = null;
  state._draftDirty = true;
  state._draftChangeVersion = 0;
  state._draftRevision = 0;
  state._serverDraftRevision = Number(params.expectedDraftRevision) || 0;
  state._replaceServerDraft = params.replaceServerDraft === true;
  state.restoringDraft = false;
  state.coverImageJobId = null;
  state.coverImagePrompt = '';
  state.imageGenerationJobs = {};
  state.imageGenerationImages = {};
  state._draftImages = [];
  state._draftImageUrls = [];
  state._agentReferenceImage = null;
  state._agentStoredImageIds = [];
  state._agentWorkflowId = null;
  state._draftId = params.agentDraft?.draft_id || params.draft_id || null;
  state._agentRequestedImages = false;
  state._agentAttachedImages = [];
  state.agentControlledDraft = Boolean(agentDraft);
  // Reset listing type to default — prevent physical leaking from previous session
  if (!params.listing_id) state.listingType = 'download';

  if (params.listing_id) {
    state.mode = 'edit';
    state.listingId = params.listing_id;
  } else {
    state.mode = 'create';
    state.listingId = null;
    // Pre-fill from agent navigation params
    if (params.description) state.description = params.description;
    if (params.productType) state.productType = params.productType;
    if (params.price) state.price = params.price;
    if (params.extra) state.extra = params.extra;
    if (params.listingType) state.listingType = params.listingType;
    if (agentDraft) {
      state.description = agentDraft.description || state.description;
      state.productType = agentDraft.productType || state.productType;
      state.listingType = agentDraft.listingType || state.listingType || 'download';
      state.price = agentDraft.price || state.price;
      state.extra = agentDraft.extra || state.extra;
      state.generated = agentDraft.generated;
      state._agentRequestedImages = Boolean(params.agentDraft?.generateImages);
      state._agentAttachedImages = Array.isArray(agentDraft.attachedImages) ? agentDraft.attachedImages : [];
      state._agentStoredImageIds = Array.isArray(agentDraft.storedImageIds) ? agentDraft.storedImageIds : [];
      state._agentWorkflowId = agentDraft.workflowId || null;
      state._agentReferenceImage = agentDraft.referenceImage?.base64 && agentDraft.referenceImage?.mimeType ? agentDraft.referenceImage : null;
      state.tags = [...(agentDraft.generated.tags || [])];
      state.materials = [...(agentDraft.generated.materials || [])];
      state.form = {
        listing_type: state.listingType,
        ...(agentDraft.taxonomyId ? { taxonomy_id: agentDraft.taxonomyId } : {}),
        ...(agentDraft.taxonomyCategory ? { taxonomy_category: agentDraft.taxonomyCategory } : {}),
        ...(agentDraft.shippingProfileId ? { shipping_profile_id: agentDraft.shippingProfileId } : {}),
        ...(agentDraft.readinessStateId ? { readiness_state_id: agentDraft.readinessStateId } : {}),
        ...(agentDraft.generated.personalization_instructions ? { personalization_instructions: agentDraft.generated.personalization_instructions } : {}),
        ...(agentDraft.generated.personalization_questions?.length ? { personalization_questions: agentDraft.generated.personalization_questions } : {}),
      };
      state.personalizationQuestions = normalizePersonalizationQuestions(state.form, state.generated);
    }
  }

  container.innerHTML = `
    <div class="page-header create-workspace-hero" id="create-page-header">
      <div>
        <div class="page-eyebrow">AI listing studio</div>
        <div class="page-title" id="create-title">
          ${state.mode === 'edit' ? 'Edit listing' : 'Create listing'}
          ${state.mode === 'edit' && state.listingId ? viewOnEtsyButton(state.listingId, { style: 'margin-left:12px;font-size:12px;vertical-align:middle' }) : ''}
        </div>
        <div class="page-subtitle" id="create-subtitle">Build, review, and publish with the shop agent beside you</div>
      </div>
    </div>
    <div class="page-body">
      <div id="create-content"></div>
    </div>`;
  const initialContent = document.getElementById('create-content');
  if (initialContent) {
    initialContent.innerHTML = '<div class="loading-center" style="min-height:220px"><div class="spinner"></div><span>Loading Create page...</span></div>';
  }

  window.setProvider = (p) => { state.provider = p; localStorage.setItem('ai_provider', p); };
  window.generateListing = generateListing;
  window.publishListing = publishListing;
  window.generateSocial = generateSocial;
  window.__saveCreateDraft = () => saveDraft().catch(err => console.warn('[draft autosave]', err));
  window.__setCreateListingType = (value, options = {}) => {
    if (value !== 'physical' && value !== 'download') return;
    state.listingType = value;
    state.form = { ...(state.form || {}), listing_type: value };
    const physical = value === 'physical';
    const display = (id, visible) => {
      const element = document.getElementById(id);
      if (element) element.style.display = visible ? 'block' : 'none';
    };
    display('physical-fields', physical);
    display('variations-card', physical);
    display('shipping-section', physical);
    if (!physical) display('var-inventory-outer', false);
    updatePublishReadiness();
    if (options.highlight) {
      const card = document.getElementById('create-listing-settings');
      card?.classList.add('create-agent-updated');
      setTimeout(() => card?.classList.remove('create-agent-updated'), 1600);
    }
    if (options.persist !== false) {
      markDraftDirty();
      saveDraft().catch(error => console.warn('[listing type save]', error?.message || error));
    }
  };
  const markDirtyFromControl = event => {
    if (event.target?.closest?.('#create-content')) {
      markDraftDirty();
      setTimeout(updatePublishReadiness, 0);
    }
  };
  container.addEventListener('input', markDirtyFromControl, true);
  container.addEventListener('change', markDirtyFromControl, true);
  let draftSyncChannel = null;
  const applyDraftPatch = async event => {
    const draft = event?.detail?.draft || event?.data?.draft;
    if (!draft || typeof draft !== 'object') return;
    const hadUnsavedChanges = state._draftDirty;
    state.listingType = draft.listingType || state.listingType;
    state.form = {
      ...(state.form || {}),
      listing_type: state.listingType,
      ...(draft.taxonomy_id ? { taxonomy_id: draft.taxonomy_id } : {}),
      ...(draft.taxonomy_category ? { taxonomy_category: draft.taxonomy_category } : {}),
      ...(draft.shipping_profile_id ? { shipping_profile_id: draft.shipping_profile_id } : {}),
      ...(draft.readiness_state_id ? { readiness_state_id: draft.readiness_state_id } : {}),
    };
    state._draftRevision = Number(draft.revision) || state._draftRevision;
    state._serverDraftRevision = Number(draft.revision) || state._serverDraftRevision;
    if (state.listingType === 'physical' && (state.shippingProfilesStatus !== 'loaded' || state.readinessProfilesStatus !== 'loaded')) {
      await loadMeta();
      renderShippingProfileControl();
      renderReadinessProfileControl();
    }
    const listingTypeEl = document.getElementById('e-ltype');
    if (listingTypeEl) {
      listingTypeEl.value = state.listingType;
      window.__setCreateListingType?.(state.listingType, { persist: false, highlight: true });
    }
    const migrated = migrateLegacyVariationPrices(draft.variations, draft.price || state.price);
    if (migrated.variations?.enabled && state.variationsManager) {
      const manager = state.variationsManager;
      manager.loadDraft(migrated.variations);
      syncBasePriceFromVariations();
      syncVariationPricingMode();
      document.getElementById('variations-card')?.classList.add('create-agent-updated');
      setTimeout(() => document.getElementById('variations-card')?.classList.remove('create-agent-updated'), 1600);
    }
    const priceEl = document.getElementById('e-price');
    if (priceEl && Number(draft.price) >= 0.20) priceEl.value = String(draft.price);
    if (migrated.variations?.enabled) syncBasePriceFromVariations();
    const shippingEl = document.getElementById('e-shipping');
    if (shippingEl && draft.shipping_profile_id) shippingEl.value = String(draft.shipping_profile_id);
    const readinessEl = document.getElementById('e-readiness');
    if (readinessEl && draft.readiness_state_id) readinessEl.value = String(draft.readiness_state_id);
    await applySuggestedTaxonomy(draft.taxonomy_id, draft.taxonomy_category);
    updatePublishReadiness();
    const localDraft = migrated.migrated ? { ...draft, variations: migrated.variations } : draft;
    if (!hadUnsavedChanges) {
      state._draftDirty = false;
      await idbDrafts.set(DRAFT_KEY, localDraft).catch(() => {});
    }
    if (hadUnsavedChanges || migrated.migrated || (!draft.taxonomy_id && state.taxonomySelect?.getValue())) {
      markDraftDirty();
      await saveDraft({ surfaceServerError: true }).catch(error => console.warn('[draft normalization]', error?.message || error));
    }
  };
  window.addEventListener('etsy:create-draft-patched', applyDraftPatch);
  try {
    draftSyncChannel = new BroadcastChannel('etsy-create-draft');
    draftSyncChannel.onmessage = applyDraftPatch;
  } catch {}
  window.__pageCleanup = async () => {
    clearInterval(state._draftInterval);
    clearInterval(state._genInterval);
    if (state._draftDirty) await saveDraft({ surfaceServerError: true }).catch(() => {});
    await waitForServerDraftSaveIdle();
    container.removeEventListener('input', markDirtyFromControl, true);
    container.removeEventListener('change', markDirtyFromControl, true);
    window.removeEventListener('etsy:create-draft-patched', applyDraftPatch);
    draftSyncChannel?.close();
    if (window['__varMgr_variations-wrap'] === state.variationsManager) delete window['__varMgr_variations-wrap'];
    if (window.__pageCleanup) delete window.__pageCleanup;
  };
  warmGalleryImageSummaries().catch(error => console.warn('[gallery warmup]', error?.message || error));
  window.resetCreate = async () => {
    const result = await clearDraft();
    clearInterval(state._draftInterval);
    await renderCreate(container, result.deleted ? {} : { restoreDraft: true });
  };
  window.addTag = addTag;
  window.removeTag = removeTag;
  window.addMaterial = addMaterial;
  window.removeMaterial = removeMaterial;
  window.updateCharCount = updateCharCount;
  window.copyToClipboard = (id) => { const el = document.getElementById(id); if (el) navigator.clipboard.writeText(el.value).then(() => toastSuccess('Copied!')); };

  const initialDraftPromise = state.mode === 'create' && !agentDraft ? getDraft() : null;
  // Required Etsy metadata must exist before review controls are rendered.
  // Fetch it in parallel with the potentially large image draft.
  await loadMeta();
  if (agentDraft) {
    await renderStep3({ agentDraft: true });
    await saveDraft({ surfaceServerError: true });
  }

  // If editing, load the listing
  if (state.mode === 'edit' && state.listingId) {
    await loadForEdit();
  } else if (!agentDraft) {
    await renderStep1(initialDraftPromise ? await initialDraftPromise : undefined);
    if (params.restoreDraft) {
      await window.restoreDraft?.();
      return;
    }
    // When agent pre-fills the description, auto-start generation immediately
    if (params.description) {
      setTimeout(() => window.generateListing?.(), 200);
    }
  }
}

function metadataCacheKey(kind) {
  let shopId = 'default';
  try { shopId = sessionStorage.getItem('etsy_mgr_active_shop') || shopId; } catch {}
  return `${kind}:${shopId}`;
}

async function loadMeta({ forceShipping = false, forceReadiness = false } = {}) {
  const sectionKey = metadataCacheKey('sections');
  const shippingKey = metadataCacheKey('shipping');
  const returnsKey = metadataCacheKey('returnPolicies');
  const readinessKey = metadataCacheKey('readiness');
  if (forceShipping) invalidate(shippingKey);
  if (forceReadiness) invalidate(readinessKey);
  state.shippingProfilesStatus = 'loading';
  state.readinessProfilesStatus = 'loading';
  const [sections, shipping, returns, readiness] = await Promise.allSettled([
    getOrFetch(sectionKey, () => etsy.getShopSections()),
    getOrFetch(shippingKey, () => etsy.getShippingProfiles()),
    getOrFetch(returnsKey, () => etsy.getReturnPolicies()),
    getOrFetch(readinessKey, () => etsy.getReadinessStateDefinitions()),
  ]);
  state.sections = sections.status === 'fulfilled' ? (sections.value?.results || sections.value || []) : [];
  state.returnPolicies = returns.status === 'fulfilled' ? (returns.value?.results || returns.value || []) : [];
  if (shipping.status === 'fulfilled') {
    state.shippingProfiles = shipping.value?.results || shipping.value || [];
    state.shippingProfilesStatus = 'loaded';
    state.shippingProfilesError = '';
  } else {
    state.shippingProfiles = [];
    state.shippingProfilesStatus = 'failed';
    state.shippingProfilesError = shipping.reason?.message || 'Shipping profiles could not be loaded';
  }
  if (readiness.status === 'fulfilled') {
    state.readinessProfiles = readiness.value?.results || readiness.value || [];
    state.readinessProfilesStatus = 'loaded';
    state.readinessProfilesError = '';
  } else {
    state.readinessProfiles = [];
    state.readinessProfilesStatus = 'failed';
    state.readinessProfilesError = readiness.reason?.message || 'Processing profiles could not be loaded';
  }
}

function renderShippingProfileControl() {
  const container = document.getElementById('shipping-profile-control');
  if (!container) return;
  const current = document.getElementById('e-shipping')?.value || state.form?.shipping_profile_id || '';
  container.innerHTML = shippingProfileControlMarkup({
    status: state.shippingProfilesStatus,
    profiles: state.shippingProfiles,
    selectedValue: current,
  });
}

function renderReadinessProfileControl() {
  const container = document.getElementById('readiness-profile-control');
  if (!container) return;
  const current = document.getElementById('e-readiness')?.value
    || state.form?.readiness_state_id
    || defaultReadinessProfileId(state.form || {}, state.readinessProfiles);
  container.innerHTML = readinessProfileControlMarkup({
    status: state.readinessProfilesStatus,
    profiles: state.readinessProfiles,
    selectedValue: current,
  });
}

async function applySuggestedTaxonomy(taxonomyId, taxonomyCategory) {
  if (!state.taxonomySelect) return null;
  if (Number(taxonomyId) > 0) {
    state.taxonomySelect.setValue(Number(taxonomyId));
    state.form = { ...(state.form || {}), taxonomy_id: Number(taxonomyId) };
    return Number(taxonomyId);
  }
  if (!taxonomyCategory || state.taxonomySelect.getValue()) return state.taxonomySelect.getValue();
  const best = state.taxonomySelect.findBest(taxonomyCategory);
  if (!best) return null;
  state.taxonomySelect.setValue(best.id);
  state.form = { ...(state.form || {}), taxonomy_id: best.id, taxonomy_category: taxonomyCategory };
  return best.id;
}

function syncBasePriceFromVariations() {
  const manager = state.variationsManager;
  if (!manager?.enabled) return null;
  const summary = manager.getPriceSummary();
  if (!summary.valid || summary.min == null) return null;
  const price = Number(summary.min.toFixed(2));
  state.price = String(price);
  const priceElement = document.getElementById('e-price');
  if (priceElement) priceElement.value = String(price);
  return price;
}

function syncVariationPricingMode() {
  const presentation = variationPricingPresentation(state.variationsManager);
  const priceInput = document.getElementById('e-price');
  const priceLabel = document.getElementById('create-base-price-label');
  const priceNote = document.getElementById('create-base-price-note');
  const quantityField = document.getElementById('create-base-quantity-field');
  if (priceInput) {
    priceInput.readOnly = presentation.hasVariationInventory;
    priceInput.classList.toggle('create-input-readonly', presentation.hasVariationInventory);
  }
  if (priceLabel) priceLabel.textContent = presentation.priceLabel;
  if (priceNote) priceNote.textContent = presentation.priceNote;
  if (quantityField) quantityField.style.display = presentation.quantityDisplay;
}

function currentVariationsSnapshot() {
  const manager = state.variationsManager;
  if (!manager?.enabled) return null;
  return {
    enabled: true,
    properties: manager.properties,
    products: manager.products,
    priceOnProperty: manager.priceOnProperty || [],
  };
}

function updatePublishReadiness() {
  const target = document.getElementById('publish-readiness');
  const report = listingReadiness({
    title: document.getElementById('e-title')?.value || state.generated?.title || '',
    listingType: document.getElementById('e-ltype')?.value || state.listingType,
    basePrice: document.getElementById('e-price')?.value || state.price,
    taxonomyId: state.taxonomySelect?.getValue() || state.form?.taxonomy_id,
    shippingProfileId: document.getElementById('e-shipping')?.value || state.form?.shipping_profile_id,
    readinessStateId: document.getElementById('e-readiness')?.value || state.form?.readiness_state_id,
    variations: currentVariationsSnapshot(),
  });
  const presentation = publishReadinessPresentation(report);
  if (target) {
    target.classList.toggle('is-ready', presentation.ready);
    target.innerHTML = presentation.markup;
  }
  const badge = document.getElementById('create-sticky-readiness');
  if (badge) {
    badge.textContent = presentation.badgeText;
    badge.classList.toggle('is-ready', presentation.ready);
    badge.title = presentation.badgeTitle;
  }
  window.focusFirstCreateBlocker = () => {
    const first = report.blockers[0];
    if (first) window.focusCreateReadinessField?.(first.key);
  };
  const publishButton = document.getElementById('pub-btn-top');
  if (publishButton) publishButton.title = presentation.publishButtonTitle;
}

async function fetchCompetitorData(description, productType) {
  try {
    // Build a search keyword from description
    const keyword = description.split(/[,.\n]/)[0].trim().slice(0, 60);
    const res = await fetch(`/api/etsy?action=searchListings&keyword=${encodeURIComponent(keyword)}&limit=8`);
    if (!res.ok) return '';
    const data = await res.json();
    const listings = data?.results || data?.data?.results || [];
    if (!listings.length) return '';
    return listings.slice(0, 8).map((l, i) => {
      const price = l.price ? `$${(l.price.amount / (l.price.divisor || 100)).toFixed(2)}` : 'N/A';
      return `${i + 1}. "${l.title}" — ${price} | Views: ${l.views || '?'} | Favs: ${l.num_favorers || '?'}`;
    }).join('\n');
  } catch { return ''; }
}

async function loadForEdit() {
  const content = document.getElementById('create-content');
  content.innerHTML = `<div class="loading-center"><div class="spinner spinner-lg"></div><span>Loading listing...</span></div>`;
  try {
    const listing = await etsy.getListing(state.listingId);
    state.generated = {
      title: listing.title,
      description: listing.description,
      tags: listing.tags || [],
      materials: listing.materials || [],
      price_suggestion: (listing.price?.amount || 0) / (listing.price?.divisor || 100),
    };
    state.form = listing;
    state.tags = [...(listing.tags || [])];
    state.materials = [...(listing.materials || [])];
    state.step = 3;
    await renderStep3();

    // Apply pending AI improvements from "✦ Improve" button on Listings page
    const pendingKey = 'ai_improve_' + state.listingId;
    const pending = sessionStorage.getItem(pendingKey);
    if (pending) {
      sessionStorage.removeItem(pendingKey);
      try { applyAiImprovements(JSON.parse(pending)); } catch { }
    }
  } catch (e) {
    content.innerHTML = `<div class="alert alert-error">${escHtml(e.message)}</div>`;
  }
}

function applyAiImprovements(improve) {
  const applied = [];
  const skipped = [];

  if (improve.title?.trim()) {
    const t = improve.title.trim().slice(0, 140);
    const currentTitle = (document.getElementById('e-title')?.value || state.generated?.title || '').trim();
    if (t.toLowerCase() === currentTitle.toLowerCase()) {
      skipped.push('title (unchanged)');
    } else {
      state.generated.title = t;
      const el = document.getElementById('e-title');
      if (el) { el.value = t; updateCharCount('e-title', 'title-count', 140); }
      applied.push('title');
    }
  }

  if (improve.tags?.length) {
    const newTags = improve.tags.slice(0, 13).map(t => String(t).trim().slice(0, 20)).filter(Boolean);
    const currentStr = [...state.tags].sort().join('|');
    const newStr = [...newTags].sort().join('|');
    if (newStr === currentStr) {
      skipped.push('tags (unchanged)');
    } else {
      state.tags = newTags;
      refreshTagsWrap();
      applied.push(`${state.tags.length} tags`);
    }
  }

  if (improve.description_intro?.trim()) {
    const intro = improve.description_intro.trim();
    const descEl = document.getElementById('e-desc');
    if (descEl) {
      const bannerId = 'ai-desc-banner';
      const existing = document.getElementById(bannerId);
      if (existing) existing.remove();
      const banner = document.createElement('div');
      banner.id = bannerId;
      banner.dataset.intro = intro;
      banner.style.cssText = 'background:var(--orange-light,#fff7ed);border:1px solid var(--orange-border,#fed7aa);border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;display:flex;gap:10px;align-items:flex-start';
      banner.innerHTML = `<div style="flex:1"><div style="font-weight:600;color:var(--orange);margin-bottom:4px">✦ AI suggested opening:</div><div style="color:var(--text-2);line-height:1.5;white-space:pre-wrap">${escHtml(intro)}</div></div><button class="btn btn-sm" style="flex-shrink:0" onclick="window.__applyAiIntro()">Apply</button>`;
      descEl.insertAdjacentElement('beforebegin', banner);

      window.__applyAiIntro = () => {
        const b = document.getElementById('ai-desc-banner');
        const text = b?.dataset?.intro || '';
        const d = document.getElementById('e-desc');
        if (d && text) {
          // Replace only the opening paragraph (up to first double newline), keep the rest
          const rest = d.value.replace(/^[\s\S]*?\n\n/, '');
          d.value = text + (rest.trim() ? '\n\n' + rest.trim() : '');
        }
        b?.remove();
      };
    }
  }

  if (applied.length) {
    toastSuccess(`✦ AI applied: ${applied.join(', ')} — review & save`);
  } else if (skipped.length) {
    toastInfo(`✦ AI found no improvements needed — listing already looks good!`);
  }
}

async function hydrateRestoredDraftImages() {
  if (!state.imageUploader) return 0;
  const savedImages = state._draftImages?.length
    ? state._draftImages
    : (state._draftImageUrls || []).map((dataUrl, index) => ({ dataUrl, rank: index + 1 }));
  if (!savedImages.length) return 0;

  const dataImages = savedImages
    .filter(image => /^data:image\//i.test(String(image?.dataUrl || '')))
    .map((image, index) => {
      const url = String(image.dataUrl);
      const mimeType = image.mimeType || url.match(/^data:([^;]+)/i)?.[1] || 'image/jpeg';
      return {
        ...image,
        id: image.galleryId || image.id,
        preview: url,
        base64: url.includes(',') ? url.slice(url.indexOf(',') + 1) : '',
        mimeType,
        filename: image.filename || `draft-image-${index + 1}.${mimeType.split('/')[1]?.split('+')[0] || 'jpg'}`,
        source: image.source || 'draft_restore',
      };
    });
  const remoteRecords = savedImages.filter(image => /^https:\/\//i.test(String(image?.dataUrl || '')));
  const targetListingId = Number(state.listingId || 0) || null;
  const attachedIds = new Set();
  const attachedUrls = new Set();
  if (targetListingId && remoteRecords.some(image => Number(image.etsyListingId || 0) !== targetListingId)) {
    try {
      const current = await etsy.getListingImages(targetListingId);
      for (const image of current?.results || []) {
        attachedIds.add(String(image.listing_image_id || ''));
        [image.url_fullxfull, image.url_570xN, image.url_170x135].filter(Boolean).forEach(url => attachedUrls.add(String(url)));
      }
    } catch (error) {
      console.warn('[draft image ownership check]', error?.message || error);
    }
  }
  const belongsToTarget = image => Boolean(targetListingId) && (
    Number(image.etsyListingId || 0) === targetListingId
    || attachedIds.has(String(image.id || ''))
    || attachedUrls.has(String(image.dataUrl || ''))
  );
  const existingRemoteImages = remoteRecords.filter(belongsToTarget).map((image, index) => ({
    url_570xN: image.dataUrl,
    url_fullxfull: image.dataUrl,
    url_170x135: image.dataUrl,
    listing_image_id: image.id || `draft-img-${index}`,
    listing_id: targetListingId,
    etsyListingId: targetListingId,
    rank: image.rank || index + 1,
  }));
  const pendingRemoteImages = remoteRecords.filter(image => !belongsToTarget(image)).map((image, index) => ({
    id: image.id || `draft-img-${index}`,
    sourceUrl: image.dataUrl,
    preview: image.dataUrl,
    mimeType: image.mimeType || '',
    filename: image.filename || '',
    rank: image.rank || index + 1,
  }));
  if (!state.imageUploader.images.length) {
    if (existingRemoteImages.length) state.imageUploader.loadExisting(existingRemoteImages, { listingId: targetListingId });
    if (pendingRemoteImages.length) state.imageUploader.addRemoteImages(pendingRemoteImages);
  }
  const added = dataImages.length ? await state.imageUploader.addDataImages(dataImages) : 0;
  state._draftImages = null;
  state._draftImageUrls = null;
  return existingRemoteImages.length + pendingRemoteImages.length + added;
}

async function renderStep1(initialDraft = undefined) {
  state.step = 1;
  document.getElementById('create-page-header')?.classList.remove('create-header-hidden');
  const examples = [
    'Pickleball sublimation PNG bundle, 5 patriotic USA designs, digital download',
    'AI photo merge memorial portrait with deceased loved one, personalized gift',
    'Birthday Canva invitation template, editable, kids unicorn party',
    'Custom watercolor pet portrait, 1-3 pets, 8×10 inch, print-ready',
    'SVG bundle vintage retro logo set, 20 designs, commercial license',
  ];
  const draft = initialDraft === undefined ? await getDraft() : initialDraft;
  const content = document.getElementById('create-content');

  window.restoreDraft = async () => {
    const d = draft || await getDraft();
    if (!d) return;
    state.description = d.description || '';
    state.productType = d.productType || 'canva_template';
    state.listingType = d.listingType || 'download';
    state.form = {
      ...(state.form || {}),
      listing_type: state.listingType,
      taxonomy_id: d.taxonomy_id || null,
      taxonomy_category: d.taxonomy_category || d.generated?.taxonomy_category || null,
      shipping_profile_id: d.shipping_profile_id || null,
      readiness_state_id: d.readiness_state_id || null,
      return_policy_id: d.return_policy_id || null,
      shop_section_id: d.shop_section_id || null,
      quantity: d.quantity || 999,
      who_made: d.who_made || 'i_did',
      when_made: d.when_made || 'made_to_order',
    };
    state._draftRevision = Number(d.revision) || 0;
    state.price = d.price || '';
    state.extra = d.extra || '';
    state.provider = d.provider || state.provider;
    state.generated = d.generated;
    state.tags = [...(d.tags || [])];
    state.materials = [...(d.materials || [])];
    state.personalizationQuestions = Array.isArray(d.personalizationQuestions) ? d.personalizationQuestions : [];
    state.imagePrompts = normalizeImagePromptsForDraft(d.imagePrompts);
    state.imageGenerationJobs = d.imageGenerationJobs || {};
    state.imageGenerationImages = d.imageGenerationImages || {};
    state.coverImageJobId = d.coverImageJobId || null;
    state.coverImagePrompt = d.coverImagePrompt || '';
    state._agentWorkflowId = d.workflow_id || null;
    state._draftId = d.draft_id || null;
    if (Number(d.etsyDraftListingId) > 0) {
      state.mode = 'edit';
      state.listingId = Number(d.etsyDraftListingId);
      state.publishedId = state.listingId;
      state.publishedUrl = d.etsyDraftListingUrl || `https://www.etsy.com/listing/${state.listingId}`;
    }
    state.agentControlledDraft = d.createdBy === 'agent' || Boolean(d.workflow_id);
    state._agentReferenceImage = d.agentReferenceImage?.base64 && d.agentReferenceImage?.mimeType ? d.agentReferenceImage : null;
    const migratedVariations = migrateLegacyVariationPrices(d.variations, state.price);
    if (migratedVariations.migrated) d.variations = migratedVariations.variations;
    // Carry structured image records for restoration after render. imageUrls is
    // retained as a migration path for drafts saved by older app revisions.
    state._draftImages = Array.isArray(d.draftImages) ? d.draftImages : [];
    state._draftImageUrls = state._draftImages.length ? [] : (d.imageUrls || []);
    await renderStep3({ restoringDraft: true });
    if (d.variations?.enabled && state.variationsManager) {
      const manager = state.variationsManager;
      manager.loadDraft(d.variations);
      syncBasePriceFromVariations();
      syncVariationPricingMode();
    }
    const titleEl = document.getElementById('e-title');
    const descEl = document.getElementById('e-desc');
    if (titleEl && d.title) titleEl.value = d.title;
    if (descEl && d.desc) descEl.value = d.desc;
    if (d.taxonomy_id && state.taxonomySelect) state.taxonomySelect.setValue(d.taxonomy_id);
    updatePublishReadiness();
    state._draftDirty = false;
    state.restoringDraft = false;
    if (migratedVariations.migrated) {
      markDraftDirty();
      await saveDraft({ surfaceServerError: true }).catch(error => console.warn('[legacy variation price migration]', error?.message || error));
    } else if (state.generated) {
      prepareImagePromptsInBackground(titleEl?.value || d.title, descEl?.value || d.desc, state.tags, state.provider);
    }
  };
  window.discardDraft = async () => {
    const result = await clearDraft();
    if (result.deleted) await renderStep1();
    else await window.restoreDraft();
  };

  content.innerHTML = `
    ${draft ? `<div style="background:var(--orange-light);border:1px solid var(--orange-border);border-radius:var(--radius);padding:10px 16px;margin-bottom:14px;max-width:680px;margin-left:auto;margin-right:auto;display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div>
        <span style="font-size:13px;font-weight:600">↩ Unsaved draft</span>
        <span style="font-size:12px;color:var(--text-2);margin-left:8px">saved ${new Date(draft.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-sm btn-primary" onclick="window.restoreDraft()">Restore draft</button>
        <button class="btn btn-sm" onclick="window.discardDraft()">Discard</button>
      </div>
    </div>` : ''}
    <div style="max-width:680px;margin:0 auto">
      <div class="card" style="padding:20px 24px;margin-bottom:10px">
        <div class="label-row" style="margin-bottom:8px">
          <label style="font-size:14px;font-weight:600">What are you selling?</label>
          <span class="label-hint">Be specific — colours, sizes, use case, target buyer</span>
        </div>
        <textarea id="f-desc" rows="4"
          style="font-size:14px;line-height:1.65;border-radius:10px"
          placeholder="e.g. Pickleball sublimation PNG bundle, 5 patriotic USA designs, red white blue, print-ready for t-shirts and tumblers, digital download">${escHtml(state.description)}</textarea>

        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
          ${examples.map(ex => `<button class="btn btn-sm" style="font-size:11px;color:var(--text-2);border-color:var(--border)" onclick="document.getElementById('f-desc').value='${ex.replace(/'/g, "\\'")}'">
            ${ex.split(',')[0].length > 32 ? ex.split(',')[0].slice(0, 32) + '…' : ex.split(',')[0]}
          </button>`).join('')}
        </div>
      </div>

      <div class="card" style="padding:16px 24px;margin-bottom:10px">
        <div class="create-format-row" style="display:grid;grid-template-columns:1fr 120px;gap:14px;align-items:end">
          <div class="field" style="margin:0">
            <label style="font-size:12px">Format</label>
            <select id="f-ltype">
              <option value="download" ${state.listingType === 'download' ? 'selected' : ''}>Digital download</option>
              <option value="physical" ${state.listingType === 'physical' ? 'selected' : ''}>Physical / Service</option>
            </select>
          </div>
          <div class="field" style="margin:0">
            <label style="font-size:12px">Price (USD)</label>
            <div class="input-prefix">
              <span class="input-prefix-text">$</span>
              <input type="number" id="f-price" step="0.01" min="0.20" placeholder="AI suggests" value="${state.price}" style="border-radius:0 var(--radius) var(--radius) 0">
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="padding:16px 24px;margin-bottom:8px">
        <div class="create-generate-row" style="display:flex;align-items:center;justify-content:space-between;gap:20px">
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.5px;margin-bottom:8px">AI MODEL</div>
            <div class="create-provider-options" style="display:flex;gap:16px">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:400">
                <input type="radio" name="provider" value="claude" ${state.provider === 'claude' ? 'checked' : ''} onchange="window.setProvider('claude')"> Claude Sonnet
              </label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:400">
                <input type="radio" name="provider" value="gemini" ${state.provider === 'gemini' ? 'checked' : ''} onchange="window.setProvider('gemini')"> Gemini Flash
              </label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:400">
                <input type="radio" name="provider" value="external" ${state.provider === 'external' ? 'checked' : ''} onchange="window.setProvider('external')"> External AI
              </label>
            </div>
          </div>
          <button class="btn btn-primary" id="gen-btn" onclick="window.generateListing()"
            style="font-size:14px;padding:11px 28px;border-radius:10px;white-space:nowrap">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
            Generate listing
          </button>
        </div>
      </div>

      <div style="text-align:center;font-size:11px;color:var(--text-3);padding:6px 0">
        AI researches top competitors · writes SEO title + 13 tags + full description · suggests pricing
      </div>
    </div>`;
}

function updateGenBtn() {
  // no-op — button now uses universal "Generate with AI" label
}
window.updateGenBtn = updateGenBtn;

function renderStep2() {
  state.step = 2;
  const steps = [
    { icon: '🔍', text: 'Searching top Etsy competitors...' },
    { icon: '📊', text: 'Analysing market pricing...' },
    { icon: '✍️', text: 'Crafting your bestseller title...' },
    { icon: '📝', text: 'Writing SEO-optimized description...' },
    { icon: '🏷️', text: 'Building your 13-tag strategy...' },
    { icon: '💡', text: 'Generating GEO-optimized content...' },
    { icon: '💰', text: 'Finalizing price recommendation...' },
  ];

  document.getElementById('create-content').innerHTML = `
    <div style="max-width:500px;margin:60px auto 0;text-align:center">
      <div style="width:64px;height:64px;border-radius:50%;background:var(--orange-light);display:flex;align-items:center;justify-content:center;margin:0 auto 24px;position:relative">
        <svg width="28" height="28" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="var(--orange)" stroke-width="1.5" stroke-linejoin="round"/></svg>
      </div>
      <div style="font-size:20px;font-weight:700;margin-bottom:6px">Creating your listing...</div>
      <div id="gen-step-icon" style="font-size:22px;margin:16px 0 6px;transition:opacity 0.3s">${steps[0].icon}</div>
      <div id="gen-step-text" style="font-size:14px;color:var(--text-2);min-height:22px;transition:opacity 0.3s">${steps[0].text}</div>
      <div style="width:280px;height:4px;background:var(--border);border-radius:2px;margin:20px auto 0;overflow:hidden">
        <div id="gen-progress-bar" style="height:100%;background:var(--orange);border-radius:2px;width:8%;transition:width 3s ease"></div>
      </div>
      <div style="margin-top:24px;font-size:11px;color:var(--text-3)">
        Researches competitors · 2026 Etsy Muse GEO · SEO title + 13 tags + full description
      </div>
    </div>`;

  // Animate steps
  let i = 0;
  const stepTextEl = () => document.getElementById('gen-step-text');
  const stepIconEl = () => document.getElementById('gen-step-icon');
  const barEl = () => document.getElementById('gen-progress-bar');

  state._genInterval = setInterval(() => {
    i = Math.min(i + 1, steps.length - 1);
    const txt = stepTextEl(); const ico = stepIconEl(); const bar = barEl();
    if (txt) { txt.style.opacity = '0'; setTimeout(() => { if (stepTextEl()) { stepTextEl().textContent = steps[i].text; stepTextEl().style.opacity = '1'; } }, 200); }
    if (ico) { ico.style.opacity = '0'; setTimeout(() => { if (stepIconEl()) { stepIconEl().textContent = steps[i].icon; stepIconEl().style.opacity = '1'; } }, 200); }
    if (bar) bar.style.width = `${Math.min(8 + i * 13, 90)}%`;
  }, 3500);
}

async function aiInspectField(field, fieldId, value, ctx) {
  const { openModal, setModalBody } = await import('../components/modal.js');

  // ctx can be a plain string (legacy title) or a rich context object
  const context = typeof ctx === 'object' && ctx !== null ? ctx : { title: ctx || value };

  // Return cached result if the field value hasn't changed since last analysis
  const cacheKey = fieldId || field;
  const cached = window.__aiInspectCache?.[cacheKey];
  if (cached && cached.value === value) {
    openModal({ title: `✦ AI: Analyse "${field}"`, body: `<div id="ai-stream-out"></div>`, size: 'md' });
    window.__aiApplyFn = cached.applyFn;
    setModalBody(cached.html);
    return;
  }

  openModal({
    title: `✦ AI: Analyse "${field}"`,
    body: `<div id="ai-stream-out" style="min-height:80px;font-size:12px;font-family:inherit;line-height:1.7;white-space:pre-wrap;color:var(--text-2)">Analysing…</div>`,
    size: 'md',
  });

  // Build listing context block — pass everything available
  const ctxLines = [
    `Title: ${context.title || '(not set)'}`,
    context.description ? `Description (first 400 chars): ${context.description.slice(0, 400)}${context.description.length > 400 ? '…' : ''}` : '',
    context.tags?.length ? `Tags (${context.tags.length}/13): ${context.tags.join(', ')}` : 'Tags: (none)',
    context.price ? `Price: $${context.price}` : '',
    context.listingType ? `Listing type: ${context.listingType}` : '',
    context.section ? `Shop section: ${context.section}` : '',
  ].filter(Boolean).join('\n');

  const PROMPT = `## Full listing context
${ctxLines}

## Field being analysed
Field name: ${field}
Current value: ${JSON.stringify(value || '')}

Analyse this field in the context of the FULL listing above. Format your response EXACTLY like this:

## Score: [A/B/C/D] — [one-line reason]
Score criteria: A = excellent, near-perfect for this specific product; B = good but has clear room to improve; C = mediocre, multiple issues; D = poor, needs rewrite. Give Score A when genuinely deserved.

## What's good
[1-3 specific strengths grounded in the listing context. If Score A: "Already well-optimised."]

## Issues & fixes
[Numbered list of real, specific issues with concrete fixes. Evaluate each issue against the actual product — do NOT suggest generic simplifications that lose the product's niche positioning or premium nature. If Score A: "No significant issues found."]

## Improved version
[Rewritten version ready to copy-paste${field === 'Title' ? '. HARD LIMIT: ≤140 characters — count every character.' : ''}. Must preserve the product's niche, tone, and price positioning. If Score A and current value is already optimal, reproduce it unchanged.]

Use **bold** for emphasis. Never use HTML tags.`;

  const bold = (s) => escHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const renderMd = (text) => text.split('\n').map(line => {
    if (/^##\s/.test(line)) return `<div style="font-size:11px;font-weight:700;margin:12px 0 4px;color:var(--orange);text-transform:uppercase;letter-spacing:0.05em">${bold(line.replace(/^##\s*/, ''))}</div>`;
    if (/^\d+\.\s/.test(line)) return `<div style="padding:3px 0 3px 12px;font-size:12px;line-height:1.65;border-left:2px solid var(--border)">${bold(line)}</div>`;
    if (line.trim() === '') return '<div style="height:4px"></div>';
    return `<div style="font-size:12px;line-height:1.65">${bold(line)}</div>`;
  }).join('');

  let fullText = '';
  let finalized = false;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    const improvedMatch = fullText.match(/##\s*Improved version\s*\n([\s\S]+?)(?=\n##|$)/i);
    const improvedText = improvedMatch ? improvedMatch[1].trim() : null;

    // If Score A — field already optimal, don't offer Apply (would change nothing / loop)
    const scoreMatch = fullText.match(/##\s*Score:\s*([A-D])/i);
    const scoreGrade = scoreMatch ? scoreMatch[1].toUpperCase() : null;
    const isOptimal = scoreGrade === 'A';

    // Store apply logic in window — avoids embedding large text in onclick HTML attribute
    window.__aiApplyFn = null;
    if (improvedText && !isOptimal) {
      if (fieldId) {
        // Truncate title to 140 chars at word boundary if needed
        let applyText = improvedText;
        const maxLen = fieldId === 'e-title' ? 140 : null;
        if (maxLen && applyText.length > maxLen) {
          applyText = applyText.slice(0, maxLen).replace(/\s+\S*$/, '');
        }
        window.__aiApplyFn = () => {
          const el = document.getElementById(fieldId);
          if (el) {
            // Use execCommand so the browser records it in undo history (Ctrl+Z works)
            el.focus();
            el.select();
            if (!document.execCommand('insertText', false, applyText)) {
              el.value = applyText; // fallback for browsers without execCommand
            }
            el.dispatchEvent(new Event('input'));
          }
          window.closeModal?.();
        };
      } else {
        // Tags: parse comma/newline/bullet list from improved text
        window.__aiApplyFn = () => {
          const parsed = improvedText.split(/[\n,]+/)
            .map(t => t.trim().replace(/^[-•*"']\s*/, '').replace(/["']$/, '').trim())
            .filter(t => t && t.length <= 20);
          if (parsed.length) {
            state.tags = [...new Set(parsed)].slice(0, 13);
            refreshTagsWrap();
          }
          window.closeModal?.();
        };
      }
    }

    const applyBtn = window.__aiApplyFn
      ? `<button class="btn btn-primary" onclick="window.__aiApplyFn()">Apply improved version</button>`
      : isOptimal
        ? `<span style="color:var(--green-text);font-size:12px;font-weight:500">✓ Already well-optimised — no changes needed</span>`
        : '';
    const finalHtml = `
      <div style="max-height:60vh;overflow-y:auto">${renderMd(fullText)}</div>
      <div class="row" style="margin-top:14px;justify-content:flex-end;gap:8px;flex-wrap:wrap">
        ${applyBtn}
        <button class="btn" onclick="window.closeModal?.()">Close</button>
      </div>`;
    setModalBody(finalHtml);

    // Cache so re-opening the modal for same value skips the API call
    if (!window.__aiInspectCache) window.__aiInspectCache = {};
    window.__aiInspectCache[cacheKey] = { value, html: finalHtml, applyFn: window.__aiApplyFn };
  };

  // Try streaming (Claude Haiku — fast)
  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'audit',
        stream: true,
        provider: state.provider || 'gemini',
        _rawPrompt: PROMPT,
        _rawSystem: `You are an expert Etsy SEO consultant for 2026, specialising in the Muse AI / Etsy search algorithm.

CRITICAL — FIELD-SPECIFIC OUTPUT RULES:
- **Title analysis**: "Improved version" must contain ONLY the rewritten title text. ≤140 characters hard limit. Count every character. No tags, no bullets, no extra text — just the title string.
- **Description analysis**: "Improved version" contains the rewritten description. Preserve formatting (line breaks, bullets). No truncation — output the full improved description.
- **Tags analysis**: "Improved version" must contain EXACTLY 13 tags, one per line, no numbering, no quotes, no trailing punctuation. Each tag ≤20 characters.
- NEVER mix field types — do not include tags when analysing a title, do not include a title when analysing tags.

SEO ANALYSIS RULES:
- Analyse the field in context of the full listing: price, description, listing type all determine the correct strategy.
- Premium/niche products (high price, specialised service like cinematic animation, custom portrait, etc.) must KEEP their niche-specific vocabulary in the title — do not simplify to generic terms that lose conversion power for that audience.
- Title: front-load the 2-3 most specific buyer-intent keywords. Avoid keyword stuffing but maximise the 140-char space. Check that title keywords and tag keywords complement (not duplicate) each other.
- Tags: prefer multi-word long-tail phrases (2-4 words) over single words. Use all 13 slots. Cross-reference with title to avoid exact full-phrase duplication.
- Description: hook in the first line (visible in search), feature bullets, format/delivery details, clear CTA.
- Give honest scores. Score A when genuinely well-optimised. Do not manufacture issues. Do not downgrade a well-optimised field to manufacture advice.
- Use **bold** for emphasis. Never use HTML tags.`,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let evt; try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        if (evt.type === 'delta') {
          fullText += evt.text;
          const el = document.getElementById('ai-stream-out');
          if (el) el.textContent = fullText;
        }
        if (evt.type === 'error') throw new Error(evt.error);
        if (evt.type === 'done') finalize();
      }
    }
    if (!finalized && fullText) finalize();
  } catch (streamErr) {
    if (finalized) return;
    // Fallback: non-streaming via Gemini
    try {
      const el = document.getElementById('ai-stream-out');
      if (el) el.textContent = 'Analysing with AI…';
      const r2 = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'audit', provider: state.provider || 'gemini', _rawPrompt: PROMPT }),
      });
      const data = await r2.json();
      if (data.error) throw new Error(data.error);
      fullText = String(data.data || '');
      finalize();
    } catch (e) {
      setModalBody(`<div class="alert alert-error">${escHtml(e.message)}</div>`);
    }
  }
}
window.aiInspectField = aiInspectField;

// ── Video uploader ────────────────────────────────────────
function initVideoUploader() {
  const wrap = document.getElementById('video-uploader-wrap');
  if (!wrap) return;

  state.video = state.video || null; // { file, url, video_id, uploading }

  const render = () => {
    if (state.video) {
      document.getElementById('listing-video-panel')?.setAttribute('open', '');
      const isExisting = !!state.video.video_id;
      const videoUrl = normalizeMediaUrl(state.video.url) || (state.video.file ? URL.createObjectURL(state.video.file) : '');

      wrap.innerHTML = `
        <div style="position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg-secondary)">
          <video src="${escHtml(videoUrl)}" controls playsinline preload="metadata" style="width:100%;max-height:220px;display:block"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='block'"></video>
          <div style="display:none;padding:18px;text-align:center;font-size:12px;color:var(--text-3)">Preview unavailable. <a href="${escHtml(videoUrl)}" target="_blank" rel="noopener">Open video</a></div>
          ${state.video.uploading ? '<div style="position:absolute;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center"><div class="spinner"></div></div>' : ''}
          <div style="position:absolute;top:8px;right:8px;display:flex;gap:6px">
            ${isExisting ? `<a href="${escHtml(videoUrl)}" download="listing-video.mp4" class="btn btn-sm" style="background:var(--bg-card);padding:4px 8px;font-size:11px" title="Download">⬇</a>` : ''}
            <button class="btn btn-sm" onclick="window.__removeVideo()" style="background:var(--red-bg);color:var(--red-text);padding:4px 8px;font-size:11px" title="Remove">×</button>
          </div>
        </div>`;

      // Store blob URL for cleanup
      if (state.video.file && !state.video._blobUrl) {
        state.video._blobUrl = videoUrl;
      }
    } else {
      wrap.innerHTML = `
        <label style="display:block;border:2px dashed var(--border);border-radius:8px;padding:20px;text-align:center;cursor:pointer;transition:all 0.2s"
               onmouseover="this.style.borderColor='var(--orange)'"
               onmouseout="this.style.borderColor='var(--border)'">
          <input type="file" accept="video/mp4,video/quicktime,video/x-msvideo" style="display:none" onchange="window.__handleVideoFile(this.files[0])">
          <div style="font-size:13px;font-weight:500;margin-bottom:4px">Click to upload video</div>
          <div style="font-size:11px;color:var(--text-3)">MP4, MOV · Max 35MB</div>
        </label>`;
    }
  };

  window.__handleVideoFile = (file) => {
    if (!file) return;
    if (file.size > 35 * 1024 * 1024) {
      toastError('Video must be under 35MB');
      return;
    }
    // Cleanup old blob URL if exists
    if (state.video?._blobUrl) {
      URL.revokeObjectURL(state.video._blobUrl);
    }
    state.video = { file, uploading: false };
    render();
  };

  window.__removeVideo = async () => {
    // Only delete from Etsy if video has a valid video_id
    if (state.video?.video_id && state.listingId) {
      try {
        await etsy.deleteListingVideo(state.listingId, state.video.video_id);
        toastSuccess('Video removed from Etsy');
      } catch (e) {
        console.error('Failed to delete video from Etsy:', e);
        // Don't show error to user - video might not exist on Etsy
      }
    }
    // Cleanup blob URL for local files
    if (state.video?._blobUrl) {
      URL.revokeObjectURL(state.video._blobUrl);
    }
    state.video = null;
    render();
    toastSuccess('Video removed');
  };

  // Load existing video if editing
  if (state.listingId && state.mode === 'edit') {
    etsy.getListingVideos(state.listingId).then(data => {
      if (data.results?.length) {
        const v = data.results[0];
        // Prefer Etsy's CDN URL. Besides avoiding unnecessary proxying, this
        // lets the browser issue Range requests required by video seeking.
        // The proxy remains a fallback for response variants without a URL.
        const directUrl = listingVideoUrl(v);
        const proxyUrl = `/api/etsy?action=getListingVideoFile&listing_id=${encodeURIComponent(state.listingId)}`;
        state.video = { video_id: v.video_id, url: directUrl || proxyUrl, file: null };
        render();
      }
    }).catch(err => {
      console.log('[video] No video found or error loading:', err.message);
      // Don't set state.video - keep it null to show upload UI
    });
  }

  window.__renderVideoUploader = render;
  render();
}

// ── Animate cover image → video modal ─────────────────────
window.__animateCoverToVideo = () => {
  const images = state.imageUploader?.images;
  if (!images?.length) {
    toastError('No cover image yet — generate or upload an image first.');
    return;
  }
  const img = images[0];
  const imgSrc = img.url || img.preview || img.base64 || '';
  const defaultPrompt = (state.generated?.title || '').trim();

  document.getElementById('animate-modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'animate-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg-card);border-radius:var(--radius);width:480px;max-width:100%;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,0.3);max-height:90vh;overflow-y:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="font-weight:700;font-size:14px">🎬 Animate cover image</div>
        <button onclick="document.getElementById('animate-modal-overlay').remove()" style="background:none;border:none;cursor:pointer;font-size:20px;color:var(--text-3);line-height:1">×</button>
      </div>
      ${imgSrc ? `<div style="margin-bottom:12px;border-radius:8px;overflow:hidden;max-height:160px;background:var(--bg-secondary);text-align:center"><img src="${imgSrc}" style="max-height:160px;max-width:100%;object-fit:cover;display:block;margin:auto"></div>` : ''}
      <div class="field" style="margin-bottom:12px">
        <label>Motion prompt <span style="font-weight:400;color:var(--text-3)">(optional)</span></label>
        <textarea id="animate-prompt" rows="2" placeholder="e.g. slow zoom in, gentle sparkle, subtle rotation…" style="font-size:12px;resize:vertical">${defaultPrompt ? 'Product showcase: ' + defaultPrompt.slice(0, 100) : ''}</textarea>
        <div style="font-size:11px;color:var(--text-3);margin-top:3px">Leave blank for automatic animation based on the image</div>
      </div>
      <div id="animate-modal-result"></div>
      <div id="animate-modal-actions" style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="document.getElementById('animate-modal-overlay').remove()" class="btn btn-sm">Cancel</button>
        <button id="animate-run-btn" onclick="window.__runAnimateModal()" class="btn btn-sm btn-primary">🎬 Generate video</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
};

function base64ToVideoFile(b64, mime) {
  const byteStr = atob(b64);
  const ab = new ArrayBuffer(byteStr.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
  const blob = new Blob([ab], { type: mime });
  const ext = mime.includes('mp4') ? 'mp4' : 'mov';
  return { file: new File([blob], `listing-video-${Date.now()}.${ext}`, { type: mime }), blobUrl: URL.createObjectURL(blob) };
}

window.__runAnimateModal = async () => {
  const images = state.imageUploader?.images;
  if (!images?.length) return;
  const img = images[0];
  const prompt = document.getElementById('animate-prompt')?.value?.trim() || '';
  const btn = document.getElementById('animate-run-btn');
  const resultEl = document.getElementById('animate-modal-result');
  const actionsEl = document.getElementById('animate-modal-actions');

  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:10px;height:10px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:5px"></div>Generating…'; }
  if (resultEl) resultEl.innerHTML = '';

  try {
    let base64 = img.base64 || img.preview || null;
    let mimeType = 'image/jpeg';
    if (base64?.startsWith('data:')) {
      const m = base64.match(/^data:([^;]+);base64,(.+)$/s);
      if (m) { mimeType = m[1]; base64 = m[2]; }
    }
    const body = base64
      ? { action: 'animateImage', referenceImage: { base64, mimeType }, prompt }
      : { action: 'animateImage', imageUrl: img.url, prompt };

    const r = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok || !data.success) throw new Error(data.error || 'Animation failed');

    const { file, blobUrl } = base64ToVideoFile(data.video.base64, data.video.mimeType || 'video/mp4');
    window.__pendingAnimatedVideo = file;

    if (resultEl) {
      resultEl.innerHTML = `<div style="margin-bottom:10px;border-radius:8px;overflow:hidden;border:1px solid var(--border)"><video src="${blobUrl}" controls autoplay muted loop style="width:100%;max-height:220px;display:block"></video></div>`;
    }
    if (actionsEl) {
      actionsEl.innerHTML = `
        <button onclick="window.__runAnimateModal()" class="btn btn-sm">🔄 Regenerate</button>
        <button onclick="window.__extendAnimatedVideo()" class="btn btn-sm" title="Generate a new segment with 'extend' hint">⏩ Extend</button>
        <button onclick="window.__acceptAnimatedVideo()" class="btn btn-sm btn-primary">✓ Use this video</button>`;
    }
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div style="color:var(--red-text);font-size:12px;margin-bottom:10px">✕ ${escHtml(err.message)}</div>`;
    if (btn) { btn.disabled = false; btn.innerHTML = '🎬 Generate video'; }
  }
};

window.__extendAnimatedVideo = () => {
  // Re-run with an "extend" hint appended to the prompt
  const promptEl = document.getElementById('animate-prompt');
  if (promptEl && !promptEl.value.includes('extend')) {
    const base = promptEl.value.trim();
    promptEl.value = base ? base + ', continue motion smoothly' : 'extend motion, smooth continuation';
  }
  window.__runAnimateModal();
};

window.__acceptAnimatedVideo = () => {
  if (!window.__pendingAnimatedVideo) return;
  state.video = { file: window.__pendingAnimatedVideo, uploading: false };
  window.__renderVideoUploader?.();
  document.getElementById('animate-modal-overlay')?.remove();
  toastSuccess('Video added!');
  window.__pendingAnimatedVideo = null;
};

// ── Background cover image generation ─────────────────────
async function startBackgroundCoverGeneration() {
  if (state.restoringDraft || state._agentAttachedImages?.length > 0) return;
  if (state._coverImageGenerating || state._coverImageGenerated) return;
  const btn = document.getElementById('gen-images-btn');
  const btnText = document.getElementById('gen-btn-text');
  const banner = document.getElementById('img-auto-gen-banner');
  const statusEl = document.getElementById('img-auto-gen-status');
  const spinner = document.getElementById('img-auto-gen-spinner');

  if (!btn || !btnText) return;

  state._coverImageGenerating = true;
  if (banner) banner.style.display = 'flex';
  if (spinner) spinner.style.display = '';
  if (statusEl) statusEl.textContent = 'Preparing 1 automatic cover in the background… You can keep editing.';
  btnText.textContent = 'Generating cover…';

  try {
    const title = document.getElementById('e-title')?.value?.trim() || state.generated?.title || '';
    const desc = buildListingContext(
      title,
      document.getElementById('e-desc')?.value?.trim() || state.generated?.description || state.description || '',
      state.tags
    );

    if (statusEl) statusEl.textContent = 'Writing Etsy-safe cover prompt…';
    const coverPrompt = await generateCoverPrompt(desc, state.provider);
    state.coverImagePrompt = coverPrompt;
    if (statusEl) statusEl.textContent = 'Cover image job started on the server…';
    const job = await jobs.startImageGeneration({
      prompt: coverPrompt,
      aspectRatio: '1:1',
      count: 1,
      provider: localStorage.getItem('image_provider') || 'external',
      timeoutMs: 120000,
      referenceImage: state._agentReferenceImage || undefined,
    });
    state.coverImageJobId = job.id;
    await saveDraft();

    const result = await pollImageGenerationJob(job.id, 120000, (jobState) => {
      if (statusEl) statusEl.textContent = jobState?.message || 'Generating cover image on the server…';
    });
    await attachGeneratedCoverImage(result, coverPrompt, title);

    btnText.textContent = 'Generate more images';
  } catch (err) {
    console.warn('Background cover generation failed:', err);
    const message = userFacingErrorMessage(err.message);
    if (!/timed out/i.test(String(err?.message || ''))) state.coverImageJobId = null;
    if (statusEl) statusEl.textContent = `Cover generation failed: ${message}. Use "Generate images" to retry manually.`;
    if (spinner) spinner.style.display = 'none';
    toastError(`Cover generation failed: ${message}`);
    btnText.textContent = 'Generate images';
  } finally {
    state._coverImageGenerating = false;
    state.coverImageJobId = state._coverImageGenerated ? null : state.coverImageJobId;
    if (state._coverImageGenerated) state.coverImagePrompt = '';
    saveDraft();
    btn.style.opacity = '1';
    btn.disabled = false;
    if (banner && state._coverImageGenerated) setTimeout(() => { banner.style.display = 'none'; }, 6000);
  }
}

async function pollImageGenerationJob(jobId, timeoutMs = 120000, onProgress = null) {
  if (!jobId) throw new Error('Image job did not return an id');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise(r => setTimeout(r, 1500));
    const job = await jobs.getStatus(jobId);
    onProgress?.(job);
    if (job?.status === 'done') return job.result;
    if (job?.status === 'error') throw new Error(userFacingErrorMessage(job.error || 'Image generation failed'));
  }
  throw new Error(`Cover generation timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function attachGeneratedCoverImage(result, coverPrompt, title) {
  const img = result?.images?.[0];
  const uploader = window.__uploaders?.['image-uploader-wrap'] || state.imageUploader;
  if (!img?.base64 || !uploader) throw new Error('Generated cover is unavailable or the image uploader is not ready');
  const mimeType = img.mimeType || 'image/png';
  const ext = mimeType.split('/')[1]?.split('+')[0] || 'png';
  const file = base64ToFile(img.base64, mimeType, `cover-${Date.now()}.${ext}`);
  const before = uploader.images.length;
  await uploader.handleFiles([file]);
  if (uploader.images.length <= before) throw new Error('Generated cover could not be attached to the listing');
  state.imageUploader = uploader;
  await saveImage({
    base64: img.base64,
    mimeType,
    prompt: coverPrompt,
    slotLabel: 'Cover',
    listingTitle: title,
  });
  state._coverImageGenerated = true;
  state.coverImageJobId = null;
  state.coverImagePrompt = '';
  const statusEl = document.getElementById('img-auto-gen-status');
  if (statusEl) statusEl.textContent = 'Cover generated, saved to Gallery, and added locally. Etsy upload will happen on Save/Publish.';
  toastSuccess('Cover generated and added locally');
  await saveDraft();
}

async function resumeBackgroundCoverGeneration() {
  if (!state.coverImageJobId || state._coverImageGenerating || state._coverImageGenerated) return;
  const btnText = document.getElementById('gen-btn-text');
  const banner = document.getElementById('img-auto-gen-banner');
  const statusEl = document.getElementById('img-auto-gen-status');
  const spinner = document.getElementById('img-auto-gen-spinner');
  const title = document.getElementById('e-title')?.value?.trim() || state.generated?.title || '';
  state._coverImageGenerating = true;
  if (banner) banner.style.display = 'flex';
  if (spinner) spinner.style.display = '';
  if (btnText) btnText.textContent = 'Generating cover…';
  if (statusEl) statusEl.textContent = 'Resuming cover image generation…';
  try {
    const result = await pollImageGenerationJob(state.coverImageJobId, 120000, (jobState) => {
      if (statusEl) statusEl.textContent = jobState?.message || 'Generating cover image on the server…';
    });
    await attachGeneratedCoverImage(result, state.coverImagePrompt || 'Automatic Etsy cover image', title);
    if (btnText) btnText.textContent = 'Generate more images';
  } catch (err) {
    console.warn('Cover job resume failed:', err);
    if (!/timed out/i.test(String(err?.message || ''))) state.coverImageJobId = null;
    if (statusEl) statusEl.textContent = `Cover generation failed: ${err.message}. Use "Generate images" to retry manually.`;
    if (spinner) spinner.style.display = 'none';
    if (btnText) btnText.textContent = 'Generate images';
  } finally {
    state._coverImageGenerating = false;
    if (state._coverImageGenerated) {
      state.coverImageJobId = null;
      state.coverImagePrompt = '';
      await saveDraft();
      if (banner) setTimeout(() => { banner.style.display = 'none'; }, 6000);
    }
  }
}

async function renderStep3({ loadingAI = false, agentDraft = false, restoringDraft = false } = {}) {
  state.step = 3;
  state.restoringDraft = Boolean(restoringDraft);
  document.getElementById('create-page-header')?.classList.add('create-header-hidden');
  const g = state.generated || {};
  const listing = state.form || {};

  const returnOpts = state.returnPolicies.map(p => {
    const label = (p.policy_name && !/^policy$/i.test(p.policy_name.trim())) ? p.policy_name : p.accepts_returns ? 'Accepts returns' : 'No returns';
    return `<option value="${p.return_policy_id}" ${(listing.return_policy_id || '') == p.return_policy_id ? 'selected' : ''}>${escHtml(label)}</option>`;
  }).join('');
  const isPhysical = (listing.listing_type || state.listingType) === 'physical';
  const selectedShippingId = listing.shipping_profile_id || '';
  const selectedReadinessId = listing.readiness_state_id
    || (isPhysical ? defaultReadinessProfileId(listing, state.readinessProfiles) : '');
  const displayBasePrice = moneyNumber(g.price_suggestion) ?? moneyNumber(state.price) ?? '';
  if (selectedReadinessId && !listing.readiness_state_id) {
    state.form = { ...(state.form || {}), readiness_state_id: selectedReadinessId };
  }
  const hasListingImages = Boolean(
    state.form?.images?.length
    || state._draftImages?.length
    || state._draftImageUrls?.length
    || state._agentAttachedImages?.length
  );
  const showAutomaticCoverOption = state.mode === 'create'
    && !state.restoringDraft
    && !hasListingImages;
  if (!state.personalizationQuestions.length) state.personalizationQuestions = normalizePersonalizationQuestions(listing, g);
  const isPersonalizable = state.personalizationQuestions.length > 0;
  const personalizationMarkup = `
    <div class="card mb-12 create-personalization-wide">
      <div class="create-personalization-heading">
        <div>
          <div class="create-section-title-row">
            <div class="card-title" style="margin:0">Personalization</div>
            ${isPersonalizable ? `<span class="badge badge-orange" style="font-size:9px">AI recommended</span>` : ''}
          </div>
          <div class="create-section-description">Collect buyer instructions, choices, and source files directly through Etsy.</div>
        </div>
        <div class="create-personalization-controls">
          <label class="personal-inline-toggle">
            <span>Allow personalization</span>
            <span class="toggle-wrap"><span class="toggle ${isPersonalizable ? 'on' : ''}" id="toggle-personal" onclick="window.togglePersonalization()"></span></span>
          </label>
        </div>
      </div>
      <div id="personal-fields" style="display:${isPersonalizable ? 'block' : 'none'}">
        <div id="personal-questions-wrap">
          ${personalizationQuestionsMarkup(state.personalizationQuestions)}
        </div>
        <button type="button" class="btn btn-sm" id="add-personal-question-btn" onclick="window.addPersonalizationQuestion()" ${state.personalizationQuestions.length >= 10 ? 'disabled' : ''}>+ Add question</button>
      </div>
    </div>`;

  // Auto-select section from AI suggestion
  let autoSectionId = String(listing.shop_section_id || '');
  if (!autoSectionId && g.section_suggestion) {
    const hint = g.section_suggestion.toLowerCase();
    const match = state.sections.find(s => s.title.toLowerCase().includes(hint) || hint.includes(s.title.toLowerCase()));
    if (match) autoSectionId = String(match.shop_section_id);
  }
  const sectionOpts = state.sections.map(s => `<option value="${s.shop_section_id}" ${String(s.shop_section_id) === autoSectionId ? 'selected' : ''}>${escHtml(s.title)}</option>`).join('');

  document.getElementById('create-content').innerHTML = `
    <!-- Sticky top bar -->
    <div class="create-sticky-bar">
      <div style="display:flex;align-items:center;gap:8px">
        <button type="button" class="create-back-btn" onclick="renderStep1()" title="Back" aria-label="Back">←</button>
        <span class="create-sticky-title" style="font-size:13px;font-weight:600">${state.mode === 'edit' ? 'Edit listing' : 'Review & publish'}</span>
        ${state.listingId ? listingIdBadge(state.listingId) : '<span class="badge badge-orange" style="font-size:10px">AI Draft</span>'}
        <button type="button" class="create-sticky-readiness" id="create-sticky-readiness" onclick="window.focusFirstCreateBlocker?.()">Checking...</button>
      </div>
      <button class="btn btn-primary" id="pub-btn-top" onclick="window.publishListing()">
        ${state.mode === 'edit' ? '✓ Save changes' : 'Create Etsy draft'}
      </button>
    </div>

    <div class="create-review-grid">

      <!-- Left: content fields -->
      <div>
        <!-- Images -->
        <div class="card mb-12">
          <div class="create-media-heading">
            <div class="card-title" style="margin:0">Listing images</div>
            <div class="create-media-actions">
              ${showAutomaticCoverOption ? `
              <label id="auto-gen-cover-option" class="create-auto-cover-option" title="Runs once for this new draft while you continue editing">
                <input type="checkbox" id="auto-gen-cover" ${state.agentControlledDraft ? '' : 'checked'} style="width:14px;height:14px;cursor:pointer">
                <span>Generate one cover automatically</span>
              </label>` : ''}
              <button class="btn btn-sm" onclick="window.openGalleryPicker()" title="Pick from saved AI gallery">
                🖼 From Gallery
              </button>
              <button class="btn btn-sm btn-primary" id="gen-images-btn" onclick="window.openImagePrompt()" title="Open the image generator">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
                <span id="gen-btn-text">Generate images</span>
              </button>
            </div>
          </div>
          <div id="img-auto-gen-banner" style="display:none;align-items:center;gap:10px;padding:10px 12px;background:var(--orange-light);border-radius:var(--radius);margin:8px 0 10px;border:1px solid var(--orange-border);font-size:12px">
            <div id="img-auto-gen-spinner" class="spinner" style="width:16px;height:16px;border-width:2px;flex-shrink:0"></div>
            <span id="img-auto-gen-status">Preparing 1 automatic cover in the background… You can keep editing.</span>
          </div>

          <div id="image-uploader-wrap"></div>

          <details class="create-video-panel" id="listing-video-panel">
            <summary>
              <span class="create-video-summary-icon">▶</span>
              <span>Add listing video</span>
              <span class="create-video-summary-meta">Optional · MP4 or MOV · max 35MB</span>
            </summary>
            <div id="video-uploader-wrap"></div>
          </details>

          <!-- Persistent image generation overlay — hides but never destroys DOM so in-flight fetches survive -->
          <div id="img-gen-panel" style="display:none"></div>
        </div>

        <!-- AI loading banner — shown while AI generates content in background -->
        ${agentDraft || state.agentControlledDraft ? `
        <div id="agent-draft-ready-banner" style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--green-bg,#f0fdf4);border-radius:var(--radius);margin-bottom:12px;border:1px solid var(--green-border,#bbf7d0);font-size:12px;color:var(--green-text,#166534)">
          <strong>✓ Agent draft loaded.</strong>
          <span>Fields are pre-filled. Review and publish when ready.</span>
          <button onclick="this.parentElement.style.display='none'" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--green-text,#166534);font-size:14px;padding:0 4px" title="Dismiss">✕</button>
        </div>` : ''}
        ${loadingAI ? `
        <div id="ai-listing-loading-banner" style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--orange-light);border-radius:var(--radius);margin-bottom:12px;border:1px solid var(--orange-border);font-size:12px">
          <div class="spinner" style="width:14px;height:14px;border-width:2px;flex-shrink:0"></div>
          <span id="ai-listing-loading-status">✦ AI is crafting your listing — images, pricing &amp; settings are ready to edit</span>
        </div>` : ''}

        <!-- Title + Description -->
        <div class="card mb-12">
          <div class="field">
            <div class="label-row">
              <label>Title</label>
              <div class="row" style="gap:6px;align-items:center">
                <span class="label-hint" id="title-count">${charCount(g.title, 140).label}</span>
                <button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="window.aiInspectField('Title', 'e-title', document.getElementById('e-title')?.value, window.__getListingCtx())">✦ Analyse</button>
              </div>
            </div>
            <input type="text" id="e-title" value="${escHtml(g.title || '')}" maxlength="140"
              ${loadingAI ? 'disabled placeholder="✦ AI is writing your title…" style="color:var(--text-3)"' : ''}
              oninput="window.updateCharCount('e-title','title-count',140)">
          </div>

          <div class="field">
            <div class="label-row">
              <label>Description</label>
              <button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="window.aiInspectField('Description', 'e-desc', document.getElementById('e-desc')?.value, window.__getListingCtx())">✦ Analyse</button>
            </div>
            <textarea id="e-desc" rows="14" style="font-size:13px;line-height:1.65${loadingAI ? ';color:var(--text-3)' : ''}"
              ${loadingAI ? 'disabled placeholder="✦ AI is crafting your description…"' : ''}>${escHtml(g.description || '')}</textarea>
          </div>
        </div>

        <!-- Tags + Materials -->
        <div class="card mb-12">
          <div class="field">
            <div class="label-row">
              <label>Tags <span style="font-size:11px;font-weight:400;color:var(--text-3)">— Etsy Muse AI buyer intent</span></label>
              <div class="row" style="gap:6px;align-items:center">
                <span id="tags-count" style="font-size:12px;font-weight:600;color:${state.tags.length === 13 ? 'var(--green-text)' : 'var(--text-2)'}">${state.tags.length}/13</span>
                <button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="window.aiInspectField('Tags', null, JSON.stringify(window.__getStateTags?.()||[]), window.__getListingCtx())">✦ Analyse</button>
              </div>
            </div>
            ${loadingAI
      ? `<div id="tags-wrap" style="min-height:42px;display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary)"><div class="spinner" style="width:12px;height:12px;border-width:2px;flex-shrink:0"></div><span style="font-size:12px;color:var(--text-3)">Generating 13 Muse AI-optimised tags…</span></div>`
      : `<div class="tags-input-wrap" id="tags-wrap">
              ${state.tags.map(t => tagChip(t, 'tag')).join('')}
              <input type="text" placeholder="${state.tags.length < 13 ? 'Add tag, press Enter' : 'Max 13 tags'}" maxlength="20" ${state.tags.length >= 13 ? 'disabled' : ''} onkeydown="if(event.key==='Enter'||event.key===','){event.preventDefault();window.addTag(this.value);this.value=''}">
            </div>`}
            <div style="font-size:11px;color:var(--text-3);margin-top:4px">Each tag max 20 chars · Press Enter or comma to add</div>
          </div>

          <div class="field">
            <div class="label-row">
              <label>Materials</label>
              <span class="label-hint" id="mat-count">${state.materials.length}/13</span>
            </div>
            ${loadingAI
      ? `<div id="mat-wrap" style="min-height:38px;display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary)"><div class="spinner" style="width:12px;height:12px;border-width:2px;flex-shrink:0"></div><span style="font-size:12px;color:var(--text-3)">Generating materials…</span></div>`
      : `<div class="tags-input-wrap" id="mat-wrap">
              ${state.materials.map(m => tagChip(m, 'mat')).join('')}
              <input type="text" placeholder="${state.materials.length < 13 ? 'Add material, press Enter' : 'Max 13'}" ${state.materials.length >= 13 ? 'disabled' : ''} onkeydown="if(event.key==='Enter'||event.key===','){event.preventDefault();window.addMaterial(this.value);this.value=''}">
            </div>`}
          </div>
        </div>

      </div>

      <!-- Right: sidebar -->
      <div>
        <!-- Pricing -->
        <div class="card mb-12" id="create-pricing-card">
          <div class="card-title">Base pricing</div>
          <div class="field">
            <label id="create-base-price-label">Base price (USD)</label>
            <div class="input-prefix">
              <span class="input-prefix-text">$</span>
              <input type="number" id="e-price" step="0.01" min="0.20" value="${displayBasePrice}" style="border-radius:0 var(--radius) var(--radius) 0">
            </div>
            <div class="create-field-note" id="create-base-price-note">The price buyers see when this listing has no priced variations.</div>
            ${g.price_rationale ? `<div style="font-size:11px;color:var(--text-3);margin-top:5px;line-height:1.5">💡 ${escHtml(g.price_rationale)}</div>` : ''}
          </div>
          <div class="field" id="create-base-quantity-field">
            <label>Quantity</label>
            <input type="number" id="e-qty" value="${listing.quantity || 999}" min="1">
          </div>
        </div>

        <!-- Listing settings -->
        <div class="card mb-12" id="create-listing-settings">
          <div class="card-title">Listing settings</div>
          <div class="field">
            <label>Format</label>
            <select id="e-ltype" onchange="window.__setCreateListingType(this.value)">
              <option value="download" ${(listing.listing_type || state.listingType) === 'download' ? 'selected' : ''}>Digital download</option>
              <option value="physical" ${(listing.listing_type || state.listingType) === 'physical' ? 'selected' : ''}>Physical / Service</option>
            </select>
          </div>
          <div class="field">
            <label>Who made it</label>
            <select id="e-whomade">
              <option value="i_did" ${(listing.who_made || 'i_did') === 'i_did' ? 'selected' : ''}>I did</option>
              <option value="collective" ${listing.who_made === 'collective' ? 'selected' : ''}>Collective</option>
              <option value="someone_else" ${listing.who_made === 'someone_else' ? 'selected' : ''}>Someone else</option>
            </select>
          </div>
          <div class="field">
            <label>When made</label>
            <select id="e-whenmade">
              ${['made_to_order', '2020_2024', '2010_2019', '2000_2009', 'before_2000', '1990s', '1980s', '1970s', '1960s', '1950s', 'before_1950'].map(v => `<option value="${v}" ${(listing.when_made || 'made_to_order') === v ? 'selected' : ''}>${v.replace(/_/g, ' ')}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;gap:16px;margin-top:4px;align-items:stretch">
            <div class="field" style="flex:1;margin-bottom:0;display:flex;align-items:center">
              <label style="margin:0;font-size:12px;flex:1">Is supply</label>
              <div class="toggle-wrap"><div class="toggle ${listing.is_supply ? 'on' : ''}" id="toggle-supply" onclick="this.classList.toggle('on')"></div></div>
            </div>
            <div class="field" style="flex:1;margin-bottom:0;display:flex;align-items:center">
              <label style="margin:0;font-size:12px;flex:1">Auto-renew</label>
              <div class="toggle-wrap"><div class="toggle ${listing.should_auto_renew !== false ? 'on' : ''}" id="toggle-renew" onclick="this.classList.toggle('on')"></div></div>
            </div>
          </div>
        </div>

        <!-- Organization -->
        <div class="card mb-12" style="overflow:visible">
          <div class="card-title">Organization</div>
          <div class="field">
            <label>Category</label>
            <div id="taxonomy-select-wrap"></div>
          </div>
          <div class="field">
            <div class="label-row">
              <label>Shop section</label>
              ${autoSectionId && g.section_suggestion ? `<span class="badge badge-orange" style="font-size:9px">AI suggested</span>` : ''}
            </div>
            <select id="e-section">
              <option value="">No section</option>
              ${sectionOpts}
            </select>
            ${g.section_suggestion && !autoSectionId ? `<div style="font-size:11px;color:var(--text-3);margin-top:3px">AI suggests: "${escHtml(g.section_suggestion)}"</div>` : ''}
          </div>
          <div id="shipping-section" style="display:${isPhysical ? 'block' : 'none'}">
            <div class="field">
              <div class="label-row"><label>Shipping profile <span style="color:var(--red);font-size:11px">*required</span></label></div>
              <div id="shipping-profile-control">${shippingProfileControlMarkup({
                status: state.shippingProfilesStatus,
                profiles: state.shippingProfiles,
                selectedValue: selectedShippingId,
              })}</div>
            </div>
            ${returnOpts ? `<div class="field"><label>Return policy</label><select id="e-return"><option value="">None</option>${returnOpts}</select></div>` : ''}
          </div>
        </div>

        <!-- Processing profile (physical only) -->
        <div class="card mb-12" id="physical-fields" style="display:${isPhysical ? 'block' : 'none'}">
          <div class="card-title">Processing</div>
          <div class="field" style="margin-bottom:0">
            <label>Processing profile <span style="color:var(--red);font-size:11px">*required</span></label>
            <div id="readiness-profile-control">${readinessProfileControlMarkup({
              status: state.readinessProfilesStatus,
              profiles: state.readinessProfiles,
              selectedValue: selectedReadinessId,
            })}</div>
          </div>
        </div>

      </div>
    </div>

    ${personalizationMarkup}

    <div class="card mb-12 create-variations-wide" id="variations-card" style="display:${isPhysical ? 'block' : 'none'}">
      <div id="variations-wrap"></div>
      <div id="var-inventory-outer" style="display:none"></div>
    </div>`;

  window.renderStep1 = renderStep1;
  window.__getStateTags = () => state.tags;
  window.retryShippingProfiles = async () => {
    state.shippingProfilesStatus = 'loading';
    renderShippingProfileControl();
    await loadMeta({ forceShipping: true });
    renderShippingProfileControl();
    renderReadinessProfileControl();
    updatePublishReadiness();
  };
  window.retryReadinessProfiles = async () => {
    state.readinessProfilesStatus = 'loading';
    renderReadinessProfileControl();
    await loadMeta({ forceReadiness: true });
    renderShippingProfileControl();
    renderReadinessProfileControl();
    updatePublishReadiness();
  };
  window.focusCreateReadinessField = key => {
    const selectors = {
      title: '#e-title',
      price: '#e-price',
      category: '#taxonomy-select-wrap-trigger',
      shipping: '#e-shipping',
      processing: '#e-readiness',
      variations: '#variations-card',
    };
    const element = document.querySelector(selectors[key] || '');
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => element?.focus?.(), 250);
  };
  window.togglePersonalization = () => {
    const toggle = document.getElementById('toggle-personal');
    const fields = document.getElementById('personal-fields');
    toggle?.classList.toggle('on');
    const enabled = toggle?.classList.contains('on') === true;
    if (fields) fields.style.display = enabled ? 'block' : 'none';
    if (enabled && !state.personalizationQuestions.length) {
      state.personalizationQuestions = [createPersonalizationQuestion()];
      renderPersonalizationQuestionsWrap();
    }
  };
  window.addPersonalizationQuestion = () => {
    syncPersonalizationQuestionsFromDom();
    if (state.personalizationQuestions.length >= 10) return;
    state.personalizationQuestions.push(createPersonalizationQuestion());
    renderPersonalizationQuestionsWrap();
  };
  window.removePersonalizationQuestion = (idx) => {
    syncPersonalizationQuestionsFromDom();
    if (state.personalizationQuestions.length <= 1) return;
    state.personalizationQuestions.splice(idx, 1);
    renderPersonalizationQuestionsWrap();
  };
  window.updatePersonalizationQuestionType = (idx, type) => {
    syncPersonalizationQuestionsFromDom();
    if (state.personalizationQuestions[idx]) state.personalizationQuestions[idx].question_type = type;
    renderPersonalizationQuestionsWrap();
  };
  window.__getListingCtx = () => ({
    listing_id: Number(state.listingId || state.publishedId || 0) || null,
    source: state.mode === 'edit' ? 'etsy_listing' : 'local_draft',
    etsy_state: state.form?.state || (state.mode === 'edit' ? 'draft' : null),
    title: document.getElementById('e-title')?.value || state.generated?.title || '',
    description: document.getElementById('e-desc')?.value || '',
    tags: state.tags || [],
    price: document.getElementById('e-price')?.value || state.price || '',
    listingType: document.getElementById('e-ltype')?.value || state.listingType || state.form?.listing_type || '',
    section: document.getElementById('e-section')?.options?.[document.getElementById('e-section')?.selectedIndex]?.text || '',
  });
  window.resetToGenerated = () => {
    const g = state.generated;
    if (!g) return;
    const titleEl = document.getElementById('e-title');
    const descEl = document.getElementById('e-desc');
    if (titleEl) { titleEl.focus(); titleEl.select(); document.execCommand('insertText', false, g.title || '') || (titleEl.value = g.title || ''); titleEl.dispatchEvent(new Event('input')); }
    if (descEl) { descEl.focus(); descEl.select(); document.execCommand('insertText', false, g.description || '') || (descEl.value = g.description || ''); descEl.dispatchEvent(new Event('input')); }
    state.tags = [...(g.tags || [])]; refreshTagsWrap();
    state.materials = [...(g.materials || [])]; refreshMatsWrap();
    toastInfo('All fields reset');
  };
  window.openImagePrompt = () => {
    const title = document.getElementById('e-title')?.value?.trim() || state.generated?.title || '';
    const desc = buildListingContext(
      title,
      document.getElementById('e-desc')?.value?.trim() || state.generated?.description || state.description || '',
      state.tags
    );
    const savedPrompts = currentImagePromptsForDraft();
    state.imagePrompts = savedPrompts;
    generateImagePrompt(desc, state.listingId, state.provider, 9, title, savedPrompts, {
      slotJobs: state.imageGenerationJobs || {},
      slotImages: state.imageGenerationImages || {},
    });
  };

  window.openGalleryPicker = () => {
    const listingTitle = document.getElementById('e-title')?.value?.trim() || state.generated?.title?.trim() || '';
    const uploader = state.imageUploader;
    const remaining = Math.max(0, 20 - (uploader?.images?.length || 0));
    if (!uploader || remaining === 0) {
      toastInfo('This listing already has the maximum number of images');
      return;
    }
    showGalleryPicker({
      listingTitle,
      maxSelection: remaining,
      title: 'Choose images from Gallery',
      confirmLabel: 'Add to listing draft',
      onConfirm: async records => {
        const added = await uploader.addDataImages(records.map(image => ({
          ...image,
          galleryId: image.id,
          source: 'gallery',
        })));
        if (!added) throw new Error('No valid images could be added');
        saveDraft({ surfaceServerError: true }).catch(error => {
          console.error('Failed to save gallery images in draft:', error);
          toastError(error?.message || 'Could not save the selected images in this draft');
        });
        toastSuccess(`Added ${added} image${added > 1 ? 's' : ''} to the listing draft`);
      },
    });
  };

  // Init image uploader immediately — before any awaits so it appears right away
  state.imageUploader = new ImageUploader('image-uploader-wrap', {
    listingId: state.listingId,
    onImagesChange: (imgs) => {
      markDraftDirty();
      if (imgs?.length) document.getElementById('auto-gen-cover-option')?.remove();
    },
  });
  state.imageUploader.render();
  if (state.form?.images?.length) {
    state.imageUploader.loadExisting(state.form.images);
  }
  if (state.restoringDraft) await hydrateRestoredDraftImages();
  if (state._agentAttachedImages?.length) {
    await state.imageUploader.addDataImages(state._agentAttachedImages);
    state._agentAttachedImages = [];
    await saveDraft();
  }
  if (state._agentStoredImageIds?.length) {
    const requestedIds = [...state._agentStoredImageIds];
    try {
      const loadImages = () => Promise.all(requestedIds.map(id => getImage(id).catch(() => null)));
      const loaded = await runIdempotentRuntimeRecovery({
        attempts: [
          loadImages,
          async () => {
            await new Promise(resolve => setTimeout(resolve, 100));
            return loadImages();
          },
        ],
        accept: images => Array.isArray(images) && images.length === requestedIds.length && images.every(image => image?.base64 && image?.mimeType),
        context: {
          operation: 'load_agent_generated_images',
          workflow_id: state._agentWorkflowId || '',
          retryable: true,
          code: 'APP_GENERATED_ASSET_MISSING',
          recovery: 'regenerate_missing_previews',
          safe_message: 'Etsy AI Command Center could not read one or more saved generated images.',
        },
      });
      const storedImages = loaded.value.map((image, index) => ({
        base64: image.base64,
        mimeType: image.mimeType,
        filename: `agent-image-${index + 1}.${image.mimeType.split('/')[1]?.split('+')[0] || 'png'}`,
      }));
      await state.imageUploader.addDataImages(storedImages);
      await saveDraft();
      window.__agentMarkImagesAttached?.(state._agentWorkflowId || '');
    } catch (error) {
      const fault = error?.runtime_fault || classifyAgentRuntimeError(error, {
        operation: 'load_agent_generated_images',
        workflow_id: state._agentWorkflowId || '',
        retryable: true,
        code: 'APP_GENERATED_ASSET_MISSING',
        recovery: 'regenerate_missing_previews',
        safe_message: 'Etsy AI Command Center could not read one or more saved generated images.',
      });
      window.__agentRecordRuntimeFault?.(fault, { operation: 'load_agent_generated_images' });
      toastError(agentRuntimeUserMessage(fault));
    }
    state._agentStoredImageIds = [];
  }
  if (state._agentReferenceImage?.base64 && state._agentReferenceImage?.mimeType) {
    window.__imgGenRef = state._agentReferenceImage;
  }

  if (state.coverImageJobId) {
    resumeBackgroundCoverGeneration();
  }

  // Init video uploader
  initVideoUploader();

  // Auto-generate cover image in background if agent requested it or checkbox is checked
  const autoGenCheckbox = document.getElementById('auto-gen-cover');
  const agentRequestedImages = Boolean(state._agentRequestedImages);
  if (agentRequestedImages && autoGenCheckbox) autoGenCheckbox.checked = true;
  if (!loadingAI && !state.coverImageJobId && !state.restoringDraft && (autoGenCheckbox?.checked || agentRequestedImages) && !state._coverImageGenerated && !state.imageUploader?.images?.length && !state.form?.images?.length && !state._draftImages?.length && !state._draftImageUrls?.length) {
    startBackgroundCoverGeneration();
  }
  // Auto-dismiss agent banner after 5 seconds
  if (state.agentControlledDraft) {
    setTimeout(() => { document.getElementById('agent-draft-ready-banner')?.remove(); }, 5000);
  }

  // Prepare the complete image brief whenever listing context is available. This
  // runs independently of automatic cover generation so edit/restored drafts open
  // the image studio with prompts ready as well.
  if (state.generated && !state.restoringDraft) {
    const title = document.getElementById('e-title')?.value?.trim() || state.generated?.title || '';
    const description = document.getElementById('e-desc')?.value?.trim() || state.generated?.description || '';
    prepareImagePromptsInBackground(title, description, state.tags, state.provider);
  }

  // Init taxonomy select
  state.taxonomySelect = new TaxonomySelect('taxonomy-select-wrap', {
    value: state.form?.taxonomy_id || listing?.taxonomy_id || null,
    onChange: (id) => {
      state.form = { ...(state.form || {}), taxonomy_id: id };
      markDraftDirty();
      updatePublishReadiness();
    },
  });
  await state.taxonomySelect.render();
  const resolvedTaxonomy = await applySuggestedTaxonomy(
    state.form?.taxonomy_id || listing?.taxonomy_id,
    state.form?.taxonomy_category || listing?.taxonomy_category || g.taxonomy_category,
  );
  if (resolvedTaxonomy && !listing?.taxonomy_id) markDraftDirty();

  // Init variations manager
  state.variationsManager = new VariationsManager('variations-wrap', {
    inventoryContainerId: 'var-inventory-outer',
    onChange: () => {
      syncBasePriceFromVariations();
      syncVariationPricingMode();
      markDraftDirty();
      updatePublishReadiness();
    },
  });
  state.variationsManager.render();
  if (state.form?.inventory) {
    state.variationsManager.loadFromEtsy(state.form.inventory);
    syncBasePriceFromVariations();
  }
  syncVariationPricingMode();
  updatePublishReadiness();

  // Autosave draft every 5s while on step 3
  clearInterval(state._draftInterval);
  if (state.mode !== 'edit') {
    state._draftInterval = setInterval(() => saveDraft({ skipIfClean: true }), 5000);
  }
}

function renderStep4() {
  state.step = 4;
  const isEdit = state.mode === 'edit';
  const listingId = Number(state.publishedId || state.listingId || 0) || null;
  const listingTitle = state.generated?.title || document.getElementById('e-title')?.value || 'Etsy listing';
  document.getElementById('create-content').innerHTML = `
    <div style="max-width:480px;margin:60px auto 0;text-align:center">
      <div style="width:64px;height:64px;border-radius:50%;background:var(--green-bg);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px">✓</div>
      <div style="font-size:20px;font-weight:700;margin-bottom:8px">${isEdit ? 'Listing updated!' : 'Listing saved to Etsy!'}</div>
      <div style="font-size:13px;color:var(--text-3);margin-bottom:28px">${isEdit ? 'Changes saved successfully.' : 'Your listing is now in your Etsy drafts — review and activate it there.'}</div>
      ${listingId ? `<div style="text-align:left;border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin-bottom:16px">
        <div style="font-weight:600;line-height:1.35">${escHtml(listingTitle)}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:4px">Etsy listing ID ${listingId}</div>
      </div>` : ''}
      <div style="display:flex;flex-direction:column;gap:10px;align-items:stretch">
        ${listingId ? `<button class="btn btn-primary" style="justify-content:center;padding:11px" onclick="window.navigate('create', {listing_id: ${listingId}})">Continue editing in Etsy AI Command Center</button>` : ''}
        ${listingId ? `<a href="${state.publishedUrl}" target="_blank" class="btn" style="justify-content:center;text-decoration:none;padding:11px">View this listing on Etsy ↗</a>` : ''}
        ${!isEdit ? `<a href="https://www.etsy.com/your/shops/me/tools/listings/state:draft,sort:update_date,view:table,stats:true?ref=seller-platform-mcnav" target="_blank" class="btn btn-ghost" style="justify-content:center;text-decoration:none">Open all Etsy drafts ↗</a>` : ''}
        <button class="btn" onclick="window.navigate('social', {listing_id: ${state.publishedId}})">Generate social posts</button>
        <button class="btn" onclick="window.resetCreate()">+ Create another listing</button>
      </div>
    </div>`;
}

// ── Core actions ──────────────────────────────────────────

async function generateListing() {
  if (state.generating) return; // prevent double-submit

  const desc = document.getElementById('f-desc')?.value?.trim();
  const price = document.getElementById('f-price')?.value;
  const ltype = document.getElementById('f-ltype')?.value || state.listingType;
  const extra = document.getElementById('f-extra')?.value || '';
  const prov = document.querySelector('input[name="provider"]:checked')?.value || state.provider;

  if (!desc) { toastError('Add a product description first'); return; }

  state.generating = true;
  state.description = desc; state.price = price;
  state.listingType = ltype; state.extra = extra; state.provider = prov;

  renderStep2();
  setGenerationStatus('Analysing market & competitors…');

  // Phase 1: fetch competitor data + shop context (fast, ~3-5s)
  const [ctx, competitorData] = await Promise.allSettled([
    getShopContext().catch(() => null),
    fetchCompetitorData(desc),
  ]);
  const shopContext = ctx.status === 'fulfilled' && ctx.value ? buildContextPrompt(ctx.value) : '';
  const competitors = competitorData.status === 'fulfilled' ? competitorData.value : '';

  // Phase 2: show the form immediately — AI fields load in background
  state.generated = {};
  state.tags = [];
  state.materials = [];
  state.form = {};
  clearInterval(state._genInterval);
  await renderStep3({ loadingAI: true });
  saveDraft();

  // Phase 3: start AI content in a server-side worker and poll progress.
  // The browser stays on the editable form instead of being blocked by a long
  // /api/ai request. If the worker endpoint is unavailable, fall back once to
  // the legacy direct path so staging/tests stay usable.
  let lastError = null;
  try {
    setAILoadingStatus(competitors
      ? '✦ Market data ready — agent worker is crafting your bestseller listing…'
      : '✦ Agent worker is crafting your listing content…');
    const job = await jobs.startListingGeneration({
      listingType: ltype,
      description: desc,
      price: price || 'suggest',
      extra,
      provider: prov,
      shopContext,
      competitorData: competitors,
      model: getModel(prov),
    });
    const result = await pollListingGenerationJob(job.id);
    applyGeneratedListingResult(result, desc, prov);
    state.generating = false;
    return;
  } catch (e) {
    lastError = e;
    console.warn('[generate] background job failed, trying legacy direct generation:', e.message);
    try {
      setAILoadingStatus('✦ Background worker failed — trying direct AI generation once…');
      const result = await ai.generateListing({
        listingType: ltype,
        description: desc,
        price: price || 'suggest',
        extra,
        provider: prov,
        shopContext,
        competitorData: competitors,
        model: getModel(prov),
      });
      applyGeneratedListingResult(result, desc, prov);
      state.generating = false;
      return;
    } catch (fallbackErr) {
      lastError = fallbackErr;
    }
  }

  state.generating = false;

  // All attempts failed — show error in the loading banner (form is still interactive)
  const banner = document.getElementById('ai-listing-loading-banner');
  if (banner) {
    banner.style.background = 'var(--red-light, #fff5f5)';
    banner.style.borderColor = 'var(--red-border, #fca5a5)';
    banner.innerHTML = `
      <span style="font-size:12px;color:var(--red-text, #dc2626);flex:1">
        ⚠️ AI failed: ${escHtml(lastError?.message || 'Unknown error')} — you can edit fields manually
      </span>
      <button class="btn btn-sm" style="flex-shrink:0" onclick="window.__retryAIGeneration()">↻ Retry</button>`;
    window.__retryAIGeneration = async () => {
      banner.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px;flex-shrink:0"></div><span id="ai-listing-loading-status">↻ Retrying AI generation…</span>`;
      banner.style.background = 'var(--orange-light)';
      banner.style.borderColor = 'var(--orange-border)';
      try {
        const result = await ai.generateListing({ listingType: ltype, description: desc, price: price || 'suggest', extra, provider: prov, shopContext, competitorData: competitors, model: getModel(prov) });
        state.generated = result;
        state.tags = [...(result.tags || [])];
        state.materials = [...(result.materials || [])];
        fillAIFields(result);
        saveDraft();
        if (result.title) {
          prepareImagePromptsInBackground(result.title, result.description, result.tags, prov);
          maybeStartAutomaticCoverGeneration();
        }
      } catch (e) {
        banner.innerHTML = `<span style="font-size:12px;color:var(--red-text, #dc2626);flex:1">⚠️ Still failing: ${escHtml(e.message)}</span><button class="btn btn-sm" style="flex-shrink:0" onclick="window.__retryAIGeneration()">↻ Retry</button>`;
        banner.style.background = 'var(--red-light, #fff5f5)';
        banner.style.borderColor = 'var(--red-border, #fca5a5)';
      }
    };
  }
}

async function pollListingGenerationJob(jobId) {
  if (!jobId) throw new Error('Background job did not return an id');
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    await new Promise(r => setTimeout(r, 1500));
    const job = await jobs.getStatus(jobId);
    if (job?.message) setAILoadingStatus(`✦ ${job.message}${job.progress ? ` (${job.progress}%)` : ''}`);
    if (job?.status === 'done') return job.result;
    if (job?.status === 'error') throw new Error(job.error || 'Background job failed');
  }
  throw new Error('Background job timed out after 180s');
}

function applyGeneratedListingResult(result, desc, prov) {
  state.generated = result || {};
  state.tags = [...(result?.tags || [])];
  state.materials = [...(result?.materials || [])];
  if (result?.personalization_instructions) {
    state.form.personalization_instructions = result.personalization_instructions;
  }
  if (Array.isArray(result?.personalization_questions)) {
    state.form.personalization_questions = result.personalization_questions;
  }

  fillAIFields(result || {});
  saveDraft();

  if (result?.title) {
    prepareImagePromptsInBackground(result.title, result.description, result.tags, prov);
    maybeStartAutomaticCoverGeneration();
  }
}

function maybeStartAutomaticCoverGeneration() {
  const automaticCover = document.getElementById('auto-gen-cover')?.checked;
  const requestedByAgent = Boolean(state._agentRequestedImages);
  if (!automaticCover && !requestedByAgent) return;
  if (state.restoringDraft || state.coverImageJobId || state._coverImageGenerating || state._coverImageGenerated) return;
  if (state.imageUploader?.images?.length || state.form?.images?.length || state._draftImages?.length || state._draftImageUrls?.length) return;
  startBackgroundCoverGeneration();
}

function prepareImagePromptsInBackground(title, description, tags = [], provider = state.provider) {
  const cleanTitle = String(title || '').trim();
  const context = buildListingContext(cleanTitle, description, tags);
  const existingPrompts = currentImagePromptsForDraft();
  if (!cleanTitle || !context || existingPrompts.filter(prompt => prompt?.prompt?.trim()).length >= 9) return null;
  const promptPrefetch = prefetchImagePrompts(context, cleanTitle, provider);
  if (!promptPrefetch?.then) return promptPrefetch;
  promptPrefetch.then(prompts => {
    // Existing prompts may have been manually edited or restored from the server;
    // use background results only to fill missing slots.
    state.imagePrompts = mergeImagePromptsForDraft(currentImagePromptsForDraft(), prompts);
    saveDraft().catch(error => console.warn('[prompt prefetch autosave]', error?.message || error));
  }).catch(error => console.warn('[prompt prefetch]', error?.message || error));
  return promptPrefetch;
}

function buildListingContext(title, description, tags = []) {
  const parts = [];
  if (title) parts.push(`Title: ${title}`);
  if (description) parts.push(`Description: ${description.slice(0, 600)}`);
  if (tags.length) parts.push(`Tags: ${tags.slice(0, 13).join(', ')}`);
  return parts.join('\n\n') || title || 'Etsy product';
}

function setAILoadingStatus(msg) {
  const el = document.getElementById('ai-listing-loading-status');
  if (el) el.textContent = msg;
}

// Fills AI-generated fields into the already-rendered form without re-rendering
function fillAIFields(result) {
  // Title
  const titleEl = document.getElementById('e-title');
  if (titleEl) {
    titleEl.value = result.title || '';
    titleEl.disabled = false;
    titleEl.placeholder = '';
    titleEl.style.color = '';
    titleEl.dispatchEvent(new Event('input'));
  }

  // Description
  const descEl = document.getElementById('e-desc');
  if (descEl) {
    descEl.value = result.description || '';
    descEl.disabled = false;
    descEl.placeholder = '';
    descEl.style.color = '';
  }

  // Tags
  const tagsWrap = document.getElementById('tags-wrap');
  const tagsCount = document.getElementById('tags-count');
  if (tagsWrap) {
    const maxed = state.tags.length >= 13;
    tagsWrap.className = 'tags-input-wrap';
    tagsWrap.style.cssText = '';
    tagsWrap.innerHTML = state.tags.map(t => tagChip(t, 'tag')).join('') +
      `<input type="text" placeholder="${maxed ? 'Max 13 tags' : 'Add tag, press Enter'}" maxlength="20" ${maxed ? 'disabled' : ''} onkeydown="if(event.key==='Enter'||event.key===','){event.preventDefault();window.addTag(this.value);this.value=''}">`;
  }
  if (tagsCount) {
    tagsCount.textContent = `${state.tags.length}/13`;
    tagsCount.style.color = state.tags.length === 13 ? 'var(--green-text)' : 'var(--text-2)';
  }

  // Materials
  const matWrap = document.getElementById('mat-wrap');
  const matCount = document.getElementById('mat-count');
  if (matWrap) {
    const maxed = state.materials.length >= 13;
    matWrap.className = 'tags-input-wrap';
    matWrap.style.cssText = '';
    matWrap.innerHTML = state.materials.map(m => tagChip(m, 'mat')).join('') +
      `<input type="text" placeholder="${maxed ? 'Max 13' : 'Add material, press Enter'}" ${maxed ? 'disabled' : ''} onkeydown="if(event.key==='Enter'||event.key===','){event.preventDefault();window.addMaterial(this.value);this.value=''}">`;
  }
  if (matCount) matCount.textContent = `${state.materials.length}/13`;

  // Price (only update if AI suggested one and price field is still at user's original input)
  const priceEl = document.getElementById('e-price');
  if (priceEl && result.price_suggestion) priceEl.value = result.price_suggestion;

  // Price rationale hint
  if (result.price_rationale && priceEl) {
    const field = priceEl.closest('.field');
    if (field && !field.querySelector('[data-price-note]')) {
      const hint = document.createElement('div');
      hint.setAttribute('data-price-note', '1');
      hint.style.cssText = 'font-size:11px;color:var(--text-3);margin-top:5px;line-height:1.5';
      hint.textContent = '💡 ' + result.price_rationale;
      field.appendChild(hint);
    }
  }

  // Personalization — prefer Etsy upload questions over legacy “send photos by
  // email/message” instructions for custom/photo-based products.
  if (result.is_personalizable) {
    const toggle = document.getElementById('toggle-personal');
    const fields = document.getElementById('personal-fields');
    state.personalizationQuestions = normalizeGeneratedPersonalizationQuestions(result);
    if (!state.personalizationQuestions.length) state.personalizationQuestions = defaultUploadPersonalizationQuestions(result);
    if (toggle && !toggle.classList.contains('on')) {
      toggle.classList.add('on');
      if (fields) fields.style.display = 'block';
    }
    renderPersonalizationQuestionsWrap();
  }

  // Section suggestion
  if (result.section_suggestion) {
    const sectionEl = document.getElementById('e-section');
    if (sectionEl && !sectionEl.value) {
      const hint = result.section_suggestion.toLowerCase();
      const match = state.sections.find(s => s.title.toLowerCase().includes(hint) || hint.includes(s.title.toLowerCase()));
      if (match) sectionEl.value = String(match.shop_section_id);
    }
  }

  // Taxonomy auto-select from AI suggestion
  if (result.taxonomy_category && state.taxonomySelect && !state.taxonomySelect.getValue()) {
    const taxWin = window[`__tax_taxonomy-select-wrap`];
    if (taxWin) {
      const best = taxWin.findBest(result.taxonomy_category);
      if (best) {
        taxWin.select(best.id);
        toastInfo(`✦ AI selected category: ${best.label}`);
      }
    }
  }

  // Remove the loading banner
  document.getElementById('ai-listing-loading-banner')?.remove();
}

function setGenerationStatus(msg) {
  const el = document.querySelector('.generation-status');
  if (el) el.textContent = msg;
}

async function uploadPendingImagesWithProgress(listingId, btn) {
  const uploadStatusId = 'publish-upload-status';
  let status = document.getElementById(uploadStatusId);
  if (!status && btn) {
    status = document.createElement('div');
    status.id = uploadStatusId;
    status.style.cssText = 'margin-top:8px;font-size:12px;color:var(--text-2);text-align:center;line-height:1.4';
    btn.insertAdjacentElement('afterend', status);
  }
  const intendedImages = state.imageUploader.getImages().length;
  try {
    await state.imageUploader.uploadAllPending(listingId, {
      onProgress: ({ done, total, phase }) => {
        const current = phase === 'complete' ? done : Math.min(done + 1, total);
        const msg = total > 0 ? `Uploading images ${current} / ${total}…` : 'Checking listing images…';
        if (btn) btn.innerHTML = `<div class="spinner"></div> ${msg}`;
        if (status) status.textContent = `${msg} Etsy media upload can take a while; progress is shown here.`;
        if (phase === 'complete') {
          markDraftDirty();
          saveDraft({ surfaceServerError: false }).catch(error => console.warn('[image upload checkpoint]', error?.message || error));
        }
      },
    });
    const unattached = state.imageUploader.getUnattachedImages(listingId);
    if (unattached.length) throw new Error(`${unattached.length} image${unattached.length === 1 ? '' : 's'} could not be attached to this Etsy listing`);

    const current = await etsy.getListingImages(listingId);
    const remoteImages = Array.isArray(current?.results) ? current.results : [];
    if (remoteImages.length < intendedImages) {
      throw new Error(`Etsy confirmed ${remoteImages.length} of ${intendedImages} listing images`);
    }
  } catch (error) {
    markDraftDirty();
    await saveDraft({ surfaceServerError: true }).catch(saveError => console.warn('[partial image upload draft save]', saveError?.message || saveError));
    throw error;
  }
  if (status) status.textContent = 'Image upload complete.';
}

async function publishListing() {
  syncBasePriceFromVariations();
  const title = document.getElementById('e-title')?.value?.trim();
  const desc = document.getElementById('e-desc')?.value?.trim();
  const priceV = parseFloat(document.getElementById('e-price')?.value || '0');
  const qty = parseInt(document.getElementById('e-qty')?.value || '999');
  const ltype = document.getElementById('e-ltype')?.value || state.listingType;
  const whoMade = document.getElementById('e-whomade')?.value || 'i_did';
  const whenMade = document.getElementById('e-whenmade')?.value || 'made_to_order';
  const section = document.getElementById('e-section')?.value || '';
  // Fall back to existing value from loaded form (in case select wasn't rendered or in edit mode)
  const shipping = document.getElementById('e-shipping')?.value
    || String(state.form?.shipping_profile_id || '');
  const ret = document.getElementById('e-return')?.value
    || String(state.form?.return_policy_id || '');
  const readiness = document.getElementById('e-readiness')?.value
    || String(state.form?.readiness_state_id || '');
  const isSupply = document.getElementById('toggle-supply')?.classList.contains('on');
  const autoRenew = document.getElementById('toggle-renew')?.classList.contains('on') !== false;
  const isPersonal = document.getElementById('toggle-personal')?.classList.contains('on');
  const personalQuestions = isPersonal ? getPersonalizationPayload() : [];
  const taxonomyId = state.taxonomySelect?.getValue() || null;
  const variationErrors = state.variationsManager?.getValidationErrors?.() || [];

  if (!title) { toastError('Title is required'); document.getElementById('e-title')?.focus(); return; }
  if (!priceV || priceV < 0.20) { toastError('Base / starting price must be at least $0.20'); document.getElementById('e-price')?.focus(); return; }
  if (!taxonomyId) { toastError('Category is required — select a category in the Organization section'); document.getElementById('taxonomy-select-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (ltype === 'physical' && state.shippingProfilesStatus === 'failed') { toastError('Shipping profiles could not be loaded. Retry before creating the Etsy draft.'); return; }
  if (ltype === 'physical' && !shipping) { toastError('Shipping profile is required for physical listings'); document.getElementById('e-shipping')?.focus(); return; }
  if (ltype === 'physical' && state.readinessProfilesStatus === 'failed') { toastError('Processing profiles could not be loaded. Retry before creating the Etsy draft.'); return; }
  if (ltype === 'physical' && !readiness) { toastError('Processing profile is required for physical listings'); document.getElementById('e-readiness')?.focus(); return; }
  if (variationErrors.length) { toastError(variationErrors[0]); document.getElementById('var-inventory-outer')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (isPersonal && !personalQuestions.length) { toastError('Add at least one personalization question or turn personalization off'); return; }
  if (personalQuestions.some(q => q.question_type === 'dropdown' && !q.options?.length)) { toastError('Dropdown personalization questions need at least one option'); return; }
  if (/send\s+(your\s+)?(photo|file|image)|email|message\s+(me|us)|etsy chat/i.test(desc || '')) {
    toastInfo('Tip: use the Personalization upload fields instead of asking buyers to email/message photos.');
  }

  const payload = {
    title, description: desc, price: priceV, quantity: qty,
    listing_type: ltype, who_made: whoMade, when_made: whenMade,
    tags: state.tags, materials: state.materials,
    // Digital downloads must have is_supply=false to avoid duplication
    is_supply: ltype === 'download' ? false : isSupply,
    should_auto_renew: autoRenew,
    taxonomy_id: taxonomyId,
    shop_section_id: section || undefined,
    // Shipping & return ONLY for physical — never send for digital downloads
    ...(ltype !== 'download' ? {
      shipping_profile_id: shipping || undefined,
      return_policy_id: ret || undefined,
      readiness_state_id: readiness || undefined,
    } : {}),
    // NOTE: Personalization is saved separately via updateListingPersonalization after listing save
  };
  const invPayload = state.variationsManager?.getInventoryPayload(readiness || null);
  if (state.mode === 'edit' && invPayload) delete payload.price;

  const btn = document.getElementById('pub-btn-top');
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="spinner"></div> ${state.mode === 'edit' ? 'Saving...' : 'Creating Etsy draft...'}`; }
  state.loading = true;
  let createdDraftId = null;

  try {
    let result;
    if (state.mode === 'edit' && state.listingId) {
      result = await etsy.updateListing(state.listingId, payload);
      state.publishedId = state.listingId;
      state.publishedUrl = `https://www.etsy.com/listing/${state.listingId}`;

      // Validate and save structured inventory before slower media uploads.
      if (invPayload) {
        if (btn) btn.innerHTML = '<div class="spinner"></div> Saving variations...';
        await etsy.updateListingInventory(state.listingId, invPayload.products, invPayload.price_on_property, readiness || null);
      }

      // Upload any new images
      if (state.imageUploader?.hasPendingUploads()) {
        await uploadPendingImagesWithProgress(state.listingId, btn);
      }

      // Upload video if present and new
      if (state.video?.file && !state.video.video_id) {
        if (btn) btn.innerHTML = '<div class="spinner"></div> Uploading video...';
        try {
          await etsy.uploadListingVideo(state.listingId, state.video.file);
        } catch (videoErr) {
          console.warn('Video upload failed:', videoErr);
          toastError('Video upload failed: ' + videoErr.message);
        }
      }

      toastSuccess('Listing updated!');
    } else {
      result = await etsy.createListing(payload);
      state.publishedId = result.listing_id;
      state.publishedUrl = `https://www.etsy.com/listing/${result.listing_id}`;
      createdDraftId = Number(result.listing_id);
      state.imageUploader?.setListingId(createdDraftId);
      markDraftDirty();
      await saveDraft({ surfaceServerError: true });

      // Fail fast on invalid variation data before uploading large media files.
      if (invPayload) {
        if (btn) btn.innerHTML = '<div class="spinner"></div> Saving variations...';
        await etsy.updateListingInventory(result.listing_id, invPayload.products, invPayload.price_on_property, readiness || null);
      }

      // Upload images to the newly created listing
      if (state.imageUploader?.images.length) {
        await uploadPendingImagesWithProgress(result.listing_id, btn);
        markDraftDirty();
        await saveDraft({ surfaceServerError: true });
      }

      // Upload video if present
      if (state.video?.file) {
        if (btn) btn.innerHTML = '<div class="spinner"></div> Uploading video...';
        try {
          await etsy.uploadListingVideo(result.listing_id, state.video.file);
        } catch (videoErr) {
          console.warn('Video upload failed:', videoErr);
          toastError('Video upload failed: ' + videoErr.message);
        }
      }

      invalidate('listings:active');
      toastSuccess('Etsy draft created!');
    }

    // Sync personalization via new dedicated endpoint (legacy fields removed Apr 9 2026)
    if (state.publishedId) {
      if (isPersonal) {
        if (btn) btn.innerHTML = '<div class="spinner"></div> Saving personalization...';
        try {
          await etsy.updateListingPersonalization(state.publishedId, personalQuestions);
        } catch (pErr) {
          console.warn('[personalization] update failed:', pErr.message);
          toastError('Personalization save failed: ' + pErr.message);
        }
      } else if (state.mode === 'edit') {
        // Was personalizable before (check both legacy field and new format) — remove it
        const hadPersonalization = state.form?.is_personalizable
          || (state.form?.personalization?.personalization_questions?.length > 0);
        if (hadPersonalization) {
          try {
            await etsy.deleteListingPersonalization(state.publishedId);
          } catch (pErr) {
            console.warn('[personalization] delete failed:', pErr.message);
          }
        }
      }
    }

    await clearDraft();
    clearInterval(state._draftInterval);
    renderStep4();
  } catch (e) {
    if (createdDraftId) {
      state.mode = 'edit';
      state.listingId = createdDraftId;
      state.imageUploader?.setListingId(createdDraftId);
      toastError(`Etsy draft ${createdDraftId} was created, but the final save step failed: ${e.message}. Retry continues this draft.`);
      if (btn) { btn.disabled = false; btn.innerHTML = 'Retry remaining steps'; }
    } else {
      toastError('Etsy save failed: ' + e.message);
      if (btn) { btn.disabled = false; btn.innerHTML = state.mode === 'edit' ? 'Save changes' : 'Create Etsy draft'; }
    }
  }
  state.loading = false;
}

async function generateSocial() {
  const btn = document.getElementById('social-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Generating...'; }
  const tone = document.getElementById('social-tone')?.value || 'engaging';

  try {
    const result = await ai.generateSocial({
      title: state.generated?.title || '',
      price: state.form?.price || state.price || '',
      url: state.publishedUrl || '',
      productType: state.productType,
      tone,
      provider: state.provider,
    });
    state.socialPosts = result;
    renderStep4();
  } catch (e) {
    toastError('Social generation failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.innerHTML = 'Generate for all platforms'; }
  }
}

// ── Tags helpers ──────────────────────────────────────────

function addTag(val) {
  const raw = val.trim();
  if (!raw) return;
  if (state.tags.length >= 13) { toastInfo('Max 13 tags'); return; }
  const tag = raw.slice(0, 20); // enforce 20-char hard limit
  if (raw.length > 20) toastInfo(`Tag truncated to 20 chars: "${tag}"`);
  if (state.tags.includes(tag)) return;
  state.tags.push(tag);
  // Clear input and reset placeholder
  const inp = document.querySelector('#tags-wrap input');
  if (inp) { inp.value = ''; inp.placeholder = state.tags.length < 13 ? 'Add tag, press Enter' : 'Max 13 tags'; }
  refreshTagsWrap();
}

function removeTag(tag) {
  state.tags = state.tags.filter(t => t !== tag);
  refreshTagsWrap();
}

function addMaterial(val) {
  const mat = val.trim().slice(0, 45);
  if (!mat || state.materials.includes(mat) || state.materials.length >= 13) return;
  state.materials.push(mat);
  refreshMatsWrap();
}

function removeMaterial(mat) {
  state.materials = state.materials.filter(m => m !== mat);
  refreshMatsWrap();
}

function refreshTagsWrap() {
  const wrap = document.getElementById('tags-wrap');
  if (!wrap) return;
  const inputEl = wrap.querySelector('input');
  const inputVal = inputEl?.value || '';
  wrap.innerHTML = state.tags.map(t => tagChip(t, 'tag')).join('');
  const newInput = document.createElement('input');
  newInput.type = 'text';
  newInput.placeholder = state.tags.length < 13 ? 'Add tag, press Enter' : 'Max 13 tags';
  newInput.disabled = state.tags.length >= 13;
  newInput.value = inputVal;
  newInput.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); window.addTag(newInput.value); newInput.value = ''; } };
  wrap.appendChild(newInput);
  const count = document.getElementById('tags-count');
  if (count) { count.textContent = `${state.tags.length}/13`; count.style.color = state.tags.length === 13 ? 'var(--green-text)' : ''; }
}

function refreshMatsWrap() {
  const wrap = document.getElementById('mat-wrap');
  if (!wrap) return;
  const inputEl = wrap.querySelector('input');
  const inputVal = inputEl?.value || '';
  wrap.innerHTML = state.materials.map(m => tagChip(m, 'mat')).join('');
  const newInput = document.createElement('input');
  newInput.type = 'text';
  newInput.placeholder = state.materials.length < 13 ? 'Add material, press Enter' : 'Max 13';
  newInput.disabled = state.materials.length >= 13;
  newInput.value = inputVal;
  newInput.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); window.addMaterial(newInput.value); newInput.value = ''; } };
  wrap.appendChild(newInput);
  const count = document.getElementById('mat-count');
  if (count) count.textContent = `${state.materials.length}/13`;
}

function tagChip(text, type) {
  const fn = type === 'tag' ? 'removeTag' : 'removeMaterial';
  // Store value in data-attribute — avoids apostrophes/quotes breaking the onclick JS string
  return `<span class="tag-chip" data-v="${escHtml(text)}">${escHtml(text)}<button class="tag-chip-remove" onclick="window.${fn}(this.closest('[data-v]').dataset.v)" title="Remove">×</button></span>`;
}

function updateCharCount(inputId, countId, max) {
  const input = document.getElementById(inputId);
  const counter = document.getElementById(countId);
  if (!input || !counter) return;
  const c = charCount(input.value, max);
  counter.textContent = c.label;
  counter.className = 'label-hint' + (c.over ? ' char-count over' : '');
}
