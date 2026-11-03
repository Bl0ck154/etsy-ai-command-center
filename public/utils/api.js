// public/utils/api.js — Frontend API client
// All requests go through /api/* to avoid CORS

import { createAgentMemoryClient } from './agent-memory-client.js';

const BASE = '';
const TIMEOUT_MS = 60_000;
const LONG_TIMEOUT_MS = 170_000;
const pendingGets = new Map();

export function userFacingErrorMessage(message) {
  let text = String(message || '').trim();
  if (!text) return 'Request failed. Please try again.';
  if (/Error in input stream|Failed to fetch|NetworkError|Load failed|body stream|connection (?:closed|reset|lost|interrupted)/i.test(text)) {
    return 'The connection was interrupted. Please retry.';
  }
  if (/JSON\.parse|Unexpected end of JSON input|unexpected end of data/i.test(text)) {
    return 'The server returned an empty response. The provider may have timed out or returned no details.';
  }
  return text
    .replace(/OmniRoute/gi, 'the external provider')
    .replace(/omniroute/gi, 'external-provider')
    .replace(/Pollinations/gi, 'the external provider')
    .replace(/pollinations/gi, 'external-provider')
    .replace(/\b(?:gpt-image-2|flux|chatgpt-web\/[^\s,)]+)/gi, 'the configured image model')
    .replace(/https?:\/\/[^\s,)]+/gi, '[provider endpoint]')
    .replace(/\bExternal image AI\b/g, 'Image provider')
    .replace(/\bExternal AI\b/g, 'AI provider');
}

export async function parseJsonResponse(res, context = 'Request') {
  const raw = await res.text().catch(() => '');
  if (!String(raw || '').trim()) {
    const data = {};
    Object.defineProperty(data, '__emptyResponse', { value: true });
    return data;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${context} returned an invalid response instead of JSON.`);
  }
}

export async function readJsonResponse(res, context = 'Request') {
  const data = await parseJsonResponse(res, context);
  if (!res.ok || data.error) {
    const reason = data.__emptyResponse ? `empty response (HTTP ${res.status})` : (data.detail_text || data.error || data.message || `HTTP ${res.status}`);
    throw new Error(userFacingErrorMessage(`${context} failed: ${reason}`));
  }
  return data;
}

export async function fetchJsonWithTimeout(endpoint, options = {}, context = 'Request', timeoutMs = LONG_TIMEOUT_MS) {
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener?.('abort', abortFromUpstream, { once: true });

  const { timeoutMs: _timeoutMs, signal: _signal, ...fetchOptions } = options;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(fetchOptions.headers || {}),
      },
    });
    return await readJsonResponse(res, context);
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`${context} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(userFacingErrorMessage(`${context} failed: ${e?.message || e}`));
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener?.('abort', abortFromUpstream);
  }
}

function getShopHeader() {
  try {
    const id = sessionStorage.getItem('etsy_mgr_active_shop');
    return id ? { 'x-shop-id': id } : {};
  } catch { return {}; }
}

async function request(endpoint, options = {}, attempt = 0) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}${endpoint}`, {
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...getShopHeader(),
        ...(fetchOptions.headers || {}),
      },
      ...fetchOptions,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(userFacingErrorMessage(`Request failed: ${e?.message || e}`));
  }
  clearTimeout(timer);

  // Retry on 429 (rate limit) with exponential backoff — safe for all methods
  if (res.status === 429 && attempt < 3) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10);
    const delay = Math.min(retryAfter * 1000, 500 * Math.pow(2, attempt + 1));
    await new Promise(r => setTimeout(r, delay));
    return request(endpoint, options, attempt + 1);
  }

  const data = await parseJsonResponse(res, 'API request');
  if (res.status === 401 && data.code === 'AUTH_REQUIRED') {
    window.__showLoginScreen?.();
    throw new Error('Session expired. Please log in again.');
  }
  if (!res.ok || data.error) {
    const reason = data.__emptyResponse ? `Request failed: empty response (${res.status})` : (data.detail_text || data.error || `Request failed: ${res.status}`);
    throw new Error(userFacingErrorMessage(reason));
  }
  return data.data !== undefined ? data.data : data;
}

function get(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${endpoint}${qs ? '?' + qs : ''}`;
  // Dedup concurrent identical GET requests
  if (pendingGets.has(url)) return pendingGets.get(url);
  const p = request(url).finally(() => pendingGets.delete(url));
  pendingGets.set(url, p);
  return p;
}

function post(endpoint, body = {}) {
  return request(endpoint, { method: 'POST', body: JSON.stringify(body) });
}

const agentMemoryClient = createAgentMemoryClient({ get, post });

// ── AI image generation ──────────────────────────────────
export const imagen = {
  generate: (prompt, aspectRatio = '1:1', count = 4) =>
    request('/api/media', { method: 'POST', timeoutMs: LONG_TIMEOUT_MS, body: JSON.stringify({ action: 'generate', prompt, aspectRatio, count, provider: localStorage.getItem('image_provider') || 'external' }) }),
};

// ── Stats ─────────────────────────────────────────────────
export const stats = {
  getShopStats:    (days = 30) => get('/api/stats', { action: 'getShopStats', days }),
  getRevenue:      (days = 30) => get('/api/stats', { action: 'getRevenue', days }),
  getListingStats: ()          => get('/api/stats', { action: 'getListingStats' }),
  getOrderStats:   (days = 30) => get('/api/stats', { action: 'getOrderStats', days }),
};

// ── Etsy ─────────────────────────────────────────────────
export const etsy = {
  // Shop
  getShop: () => get('/api/etsy', { action: 'getShop' }),
  getAvailableShops: () => get('/api/etsy', { action: 'getAvailableShops' }),
  getShopSections: () => get('/api/etsy', { action: 'getShopSections' }),
  getShippingProfiles: () => get('/api/etsy', { action: 'getShippingProfiles' }),
  getReadinessStateDefinitions: () => get('/api/etsy', { action: 'getReadinessStateDefinitions' }),
  getReturnPolicies: () => get('/api/etsy', { action: 'getReturnPolicies' }),
  getShopStats: (params = {}) => get('/api/etsy', { action: 'getShopStats', ...params }),

  // Listings
  getListings: (params = {}) => get('/api/etsy', { action: 'getListings', ...params }),
  getListing: (id) => get('/api/etsy', { action: 'getListing', listing_id: id }),
  createListing: (body) => post('/api/etsy', { action: 'createListing', ...body }),
  updateListing: (id, body) => post('/api/etsy', { action: 'updateListing', listing_id: id, ...body }),
  deleteListing: (id) => post('/api/etsy', { action: 'deleteListing', listing_id: id }),
  duplicateListing: (id, params = {}) => post('/api/etsy', { action: 'duplicateListing', listing_id: id, ...params }),
  updateListingState: (id, state) => post('/api/etsy', { action: 'updateListingState', listing_id: id, state }),
  getListingPersonalization: (id) => get('/api/etsy', { action: 'getListingPersonalization', listing_id: id }),
  updateListingPersonalization: (id, questions) => post('/api/etsy', { action: 'updateListingPersonalization', listing_id: id, personalization_questions: questions }),
  deleteListingPersonalization: (id) => post('/api/etsy', { action: 'deleteListingPersonalization', listing_id: id }),

  // Images
  getListingImages: (id) => get('/api/etsy', { action: 'getListingImages', listing_id: id }),
  getListingImage: (listingId, imageId) => get('/api/etsy', { action: 'getListingImage', listing_id: listingId, listing_image_id: imageId }),
  updateListingImageAltText: (listingId, imageId, altText, confirmation = {}) => post('/api/etsy', {
    action: 'updateListingImageAltText',
    listing_id: listingId,
    listing_image_id: imageId,
    alt_text: altText,
    confirmed: confirmation.confirmed === true,
    confirmed_by: confirmation.confirmed_by || 'user',
  }),
  deleteListingImage: (listingId, imageId) => post('/api/etsy', { action: 'deleteListingImage', listing_id: listingId, listing_image_id: imageId }),

  // Videos
  getListingVideos: (id) => get('/api/etsy', { action: 'getListingVideos', listing_id: id }),
  uploadListingVideo: async (listingId, videoFile) => {
    const MAX_MB = 35;
    if (videoFile.size > MAX_MB * 1024 * 1024) {
      throw new Error(`Video is too large (${(videoFile.size / 1024 / 1024).toFixed(0)} MB). Maximum is ${MAX_MB} MB.`);
    }

    const reader = new FileReader();
    const base64Promise = new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(videoFile);
    });
    const videoBase64 = await base64Promise;

    return post('/api/etsy', {
      action: 'uploadListingVideo',
      listing_id: listingId,
      videoBase64,
      name: videoFile.name,
    });
  },
  deleteListingVideo: (listingId, videoId) => post('/api/etsy', { action: 'deleteListingVideo', listing_id: listingId, video_id: videoId }),

  // Inventory
  getListingInventory: (id) => get('/api/etsy', { action: 'getListingInventory', listing_id: id }),
  updateListingInventory: (id, products, price_on_property = [], readiness_state_id = null) => post('/api/etsy', {
    action: 'updateListingInventory',
    listing_id: id,
    products,
    price_on_property,
    readiness_state_id,
  }),

  // Orders
  getReceipts: (params = {}) => get('/api/etsy', { action: 'getReceipts', ...params }),
  getReceipt: (id) => get('/api/etsy', { action: 'getReceipt', receipt_id: id }),
  updateReceiptShipment: (id, body) => post('/api/etsy', { action: 'updateReceiptShipment', receipt_id: id, ...body }),
  getTransactions: (params = {}) => get('/api/etsy', { action: 'getTransactions', ...params }),

  // Discounts / Sales
  getDiscounts: () => get('/api/etsy', { action: 'getDiscounts' }),
  getDiscount: (id) => get('/api/etsy', { action: 'getDiscount', discount_id: id }),
  createDiscount: (body) => post('/api/etsy', { action: 'createDiscount', ...body }),
  updateDiscount: (id, body) => post('/api/etsy', { action: 'updateDiscount', discount_id: id, ...body }),
  deleteDiscount: (id) => post('/api/etsy', { action: 'deleteDiscount', discount_id: id }),

  // Reviews
  getReviews: (params = {}) => get('/api/etsy', { action: 'getReviews', ...params }),

  // Taxonomy
  getTaxonomy: () => get('/api/etsy', { action: 'getTaxonomy' }),

  // Auth
  getTokenStatus: () => get('/api/auth'),
  refreshToken: () => post('/api/auth'),
};

// ── KV storage ───────────────────────────────────────────
export const kv = {
  // FB shop sync state
  getFbSync:               ()            => get('/api/kv', { action: 'getFbSync' }),
  setFbSync:               (value)       => post('/api/kv', { action: 'setFbSync', value }),
  // Social platform configs
  getSocialConfigs:        ()            => get('/api/kv', { action: 'getSocialConfigs' }),
  setSocialConfig:         (key, value)  => post('/api/kv', { action: 'setSocialConfig', key, value }),
  deleteSocialConfig:      (key)         => post('/api/kv', { action: 'deleteSocialConfig', key }),
  // Personalization prefs
  getPersonalizationPrefs: ()            => get('/api/kv', { action: 'getPersonalizationPrefs' }),
  setPersonalizationPrefs: (value)       => post('/api/kv', { action: 'setPersonalizationPrefs', value }),
  getExternalAiConfig:    ()             => get('/api/kv', { action: 'getExternalAiConfig' }),
  setExternalAiConfig:    (value)        => post('/api/kv', { action: 'setExternalAiConfig', value }),
  getAiProviderStatus:    ()             => get('/api/kv', { action: 'getAiProviderStatus' }),
  setEtsyTokens:          (value)        => post('/api/kv', { action: 'setEtsyTokens', value }),
  // Agent memory
  getAgentMemory: () => agentMemoryClient.load(),
  setAgentMemory: (value) => agentMemoryClient.replace(value),
  appendAgentMemory: (value) => agentMemoryClient.append(value),
  deleteAgentMemory: (id) => agentMemoryClient.remove(id),
  getShopOperatingContext: ()            => get('/api/kv', { action: 'getShopOperatingContext' }),
  setShopOperatingContext: (value)       => post('/api/kv', { action: 'setShopOperatingContext', value }),
  // Reviews responded tracking
  getRespondedReviews:     ()            => get('/api/kv', { action: 'getRespondedReviews' }),
  markReviewResponded:     (id)          => post('/api/kv', { action: 'markReviewResponded',   value: { transaction_id: id } }),
  unmarkReviewResponded:   (id)          => post('/api/kv', { action: 'unmarkReviewResponded', value: { transaction_id: id } }),
};

// ── AI ────────────────────────────────────────────────────
export const etsyGuidance = {
  getStatus: () => get('/api/etsy-guidance', { action: 'status' }),
  refresh: (force = false) => request('/api/etsy-guidance', {
    method: 'POST',
    timeoutMs: LONG_TIMEOUT_MS,
    body: JSON.stringify({ action: 'refresh', force }),
  }),
  approve: (candidateId, candidateSha256) => post('/api/etsy-guidance', {
    action: 'approve',
    candidate_id: candidateId,
    candidate_sha256: candidateSha256,
  }),
  dismiss: (candidateId, candidateSha256) => post('/api/etsy-guidance', {
    action: 'dismiss',
    candidate_id: candidateId,
    candidate_sha256: candidateSha256,
  }),
  restoreBundled: () => post('/api/etsy-guidance', { action: 'restore_bundled' }),
};

export const ai = {
  generateListing: (params) => post('/api/ai', { type: 'listing', ...params }),
  generateSocial: (params) => post('/api/ai', { type: 'social', ...params }),
  planAutopilot: (params) => post('/api/ai', { type: 'autopilot', ...params }),
  streamAutopilot: (params) => streamJson('/api/ai', { type: 'autopilot', stream: true, ...params }),
};

// ── Background jobs ───────────────────────────────────────
export const jobs = {
  startListingGeneration: (params) => post('/api/jobs', { action: 'startListingGeneration', ...params }),
  startImageGeneration: (params) => post('/api/jobs', { action: 'startImageGeneration', ...params }),
  getStatus: (id) => get('/api/jobs', { action: 'status', job_id: id }),
  recordAgentRuntimeFault: (jobId, fault) => post('/api/jobs', { action: 'recordAgentRuntimeFault', job_id: jobId || '', fault }),
};

async function* streamJson(endpoint, body = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}${endpoint}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...getShopHeader() },
      body: JSON.stringify(body),
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Request timed out after 60s');
    throw new Error(userFacingErrorMessage(`Streaming request failed: ${e?.message || e}`));
  }
  if (!res.ok) {
    clearTimeout(timer);
    const data = await parseJsonResponse(res, 'Streaming request').catch(() => ({}));
    const reason = data.__emptyResponse ? `Request failed: empty response (${res.status})` : (data.error || `Request failed: ${res.status}`);
    throw new Error(userFacingErrorMessage(reason));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try { yield JSON.parse(raw); } catch {}
      }
    }
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Request timed out after 60s');
    throw new Error(userFacingErrorMessage(`Streaming request failed: ${e?.message || e}`));
  } finally {
    clearTimeout(timer);
  }
}

// ── Social ────────────────────────────────────────────────
export const social = {
  postPinterest: (p) => post('/api/social', { action: 'postPinterest', ...p }),
  postInstagram: (p) => post('/api/social', { action: 'postInstagram', ...p }),
  postInstagramCarousel: (p) => post('/api/social', { action: 'postInstagramCarousel', ...p }),
  extendFacebookToken: (p) => post('/api/social', { action: 'extendFacebookToken', ...p }),
  getMyInstagram: (token) => post('/api/social', { action: 'getMyInstagram', token }),
  verifyInstagramDirect: (p) => post('/api/social', { action: 'verifyInstagramDirect', ...p }),
  refreshInstagramToken: (token) => post('/api/social', { action: 'refreshInstagramToken', token }),
  postFacebook: (p) => post('/api/social', { action: 'postFacebook', ...p }),
  postTikTok: (p) => post('/api/social', { action: 'postTikTok', ...p }),
  sendToBuffer: (p) => post('/api/social', { action: 'postBuffer', ...p }),
  sendToMetricool: (p) => post('/api/social', { action: 'postMetricool', ...p }),
  sendToMake: (p) => post('/api/social', { action: 'postMake', ...p }),
  sendToZapier: (p) => post('/api/social', { action: 'postZapier', ...p }),
  checkConfig: () => post('/api/social', { action: 'checkConfig' }),
  getPinterestBoards: () => post('/api/social', { action: 'getPinterestBoards' }),
  getFacebookPages: () => post('/api/social', { action: 'getFacebookPages' }),
  syncFacebookShop: (p) => post('/api/social', { action: 'syncFacebookShop', ...p }),
  unsyncFacebookShop: (p) => post('/api/social', { action: 'unsyncFacebookShop', ...p }),
  checkFacebookShopConfig: (p) => post('/api/social', { action: 'checkFacebookShopConfig', ...p }),
  getFacebookCatalogProducts: (p) => post('/api/social', { action: 'getFacebookCatalogProducts', ...p }),
  getMyFacebook: (token) => post('/api/social', { action: 'getMyFacebook', token }),
  createFacebookCatalog: (p) => post('/api/social', { action: 'createFacebookCatalog', ...p }),
};
