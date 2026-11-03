// api/kv.js — Server-side key-value storage via Upstash-compatible Redis REST
// Free tier: 30k commands/month, 256MB — plenty for 2 users
// Stores: image prompts per listing, shop context cache, user preferences
//
// Setup: configure KV_REST_API_URL and KV_REST_API_TOKEN in the runtime environment.

import { requireAuth } from './_auth.js';
import { sendPublicError } from './_errors.js';
import { MODEL } from './_config.js';
import { resolveSchedulerConfiguredPlatforms } from './_scheduler.js';
import {
  deleteScheduledPost,
  getScheduledPosts,
  saveScheduledPostBatch,
  updateScheduledPost,
} from './modules/social/queue.js';
import { createSocialPublishHistoryRepository } from './modules/social/infrastructure/publish-history-repository.js';
import { createEtsyReviewResponseRepository } from './modules/etsy/index.js';
import { etsyTokenStateRepository, mergeEtsyTokenSettings } from './_etsy-token-state.js';
import {
  createAgentMemoryRepository,
  userAgentMemoryKey as buildUserAgentMemoryKey,
} from './agent/memory-repository.js';

const EXTERNAL_IMAGE_RESPONSE_FORMATS = new Set(['data_uri', 'base64_json', 'markdown_url']);
const EXTERNAL_IMAGE_ADAPTERS = new Set(['chat_data_uri', 'openai_images', 'openai_responses']);
const EXTERNAL_IMAGE_REFERENCE_MODES = new Set(['unsupported', 'chat_multimodal', 'provider_native']);

function externalBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function externalImageResponseFormat(value) {
  const format = String(value || 'base64_json').trim().toLowerCase();
  return EXTERNAL_IMAGE_RESPONSE_FORMATS.has(format) ? format : 'base64_json';
}

export function normalizeExternalImageAdapter(value) {
  const adapter = String(value || '').trim().toLowerCase();
  return EXTERNAL_IMAGE_ADAPTERS.has(adapter) ? adapter : '';
}

export function assertExternalImageContract({ imageModel, imagePath, imageAdapter }) {
  if (!imageModel) return;
  if (!imageAdapter) {
    const err = new Error('Image adapter must be explicitly configured');
    err.status = 400;
    throw err;
  }
  if (!imagePath) {
    const err = new Error('Image path must be explicitly configured');
    err.status = 400;
    throw err;
  }
  if (String(imageModel).toLowerCase().startsWith('codex/')
    && (imageAdapter !== 'openai_responses' || String(imagePath).replace(/\/+$/, '').toLowerCase() !== '/v1/responses')) {
    const err = new Error('Codex OAuth image generation requires openai_responses at /v1/responses');
    err.status = 400;
    throw err;
  }
}

function externalImageReferenceMode(value) {
  const mode = String(value || 'unsupported').trim().toLowerCase();
  return EXTERNAL_IMAGE_REFERENCE_MODES.has(mode) ? mode : 'unsupported';
}

function externalImageTimeout(value, fallback = 120000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(120000, Math.max(5000, parsed)) : fallback;
}

function normalizeMetaAiCookieSetting(value) {
  let input = value;
  if (typeof input === 'string' && input.trim().startsWith('{')) {
    try {
      input = JSON.parse(input);
    } catch {}
  }
  const header = typeof input === 'string'
    ? input.trim().replace(/^cookie\s*:\s*/i, '').trim()
    : (input && typeof input === 'object'
      ? Object.entries(input)
        .filter(([, cookieValue]) => cookieValue !== undefined && cookieValue !== null && String(cookieValue).trim() !== '')
        .map(([name, cookieValue]) => `${name}=${String(cookieValue).trim()}`)
        .join('; ')
      : '');
  const parsed = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const cookieValue = part.slice(idx + 1).trim();
    if (name) parsed[name] = cookieValue;
  }
  if (!parsed.rd_challenge && parsed.datr) {
    parsed.rd_challenge = parsed.datr;
  }
  const missing = ['ecto_1_sess', 'rd_challenge'].filter(name => !parsed[name]);
  if (missing.length) {
    const found = Object.keys(parsed).length ? Object.keys(parsed).join(', ') : 'none';
    const err = new Error(`Meta AI cookies must include ecto_1_sess and rd_challenge. Missing: ${missing.join(', ')}. Found: ${found}. If your page still shows datr, paste rd_challenge into that field and save again.`);
    err.status = 400;
    throw err;
  }
  const preferred = ['ecto_1_sess', 'rd_challenge'];
  const ordered = [
    ...preferred,
    ...Object.keys(parsed).filter(name => !preferred.includes(name)).sort(),
  ];
  return ordered
    .filter(name => parsed[name])
    .map(name => `${name}=${parsed[name]}`)
    .join('; ');
}

function publicExternalAiConfig(saved = {}) {
  const apiKey = saved.apiKey || process.env.EXTERNAL_AI_API_KEY || process.env.OMNIROUTE_API_KEY || '';
  const baseUrl = saved.baseUrl || process.env.EXTERNAL_AI_BASE_URL || process.env.OMNIROUTE_BASE_URL || '';
  const runtimeImageAdapter = process.env.EXTERNAL_IMAGE_ADAPTER || process.env.OMNIROUTE_IMAGE_ADAPTER;
  return {
    configured: Boolean(baseUrl && apiKey),
    baseUrl,
    method: saved.method || process.env.EXTERNAL_AI_METHOD || 'openai',
    textPath: saved.textPath || process.env.EXTERNAL_AI_TEXT_PATH || '/v1/chat/completions',
    imagePath: process.env.EXTERNAL_AI_IMAGE_PATH || saved.imagePath || '',
    textModel: saved.textModel || process.env.EXTERNAL_AI_MODEL || process.env.OMNIROUTE_TEXT_MODEL || MODEL.external,
    visionModel: saved.visionModel || process.env.EXTERNAL_VISION_MODEL || process.env.OMNIROUTE_VISION_MODEL || saved.textModel || process.env.EXTERNAL_AI_MODEL || process.env.OMNIROUTE_TEXT_MODEL || MODEL.external,
    imageModel: process.env.EXTERNAL_IMAGE_MODEL || process.env.OMNIROUTE_IMAGE_MODEL || saved.imageModel || MODEL.externalImage,
    imageStream: externalBoolean(saved.imageStream ?? process.env.EXTERNAL_IMAGE_STREAM ?? process.env.OMNIROUTE_IMAGE_STREAM, false),
    imageResponseFormat: externalImageResponseFormat(saved.imageResponseFormat || process.env.EXTERNAL_IMAGE_RESPONSE_FORMAT || process.env.OMNIROUTE_IMAGE_RESPONSE_FORMAT),
    imageAdapter: normalizeExternalImageAdapter(runtimeImageAdapter || saved.imageAdapter),
    imageReferenceMode: externalImageReferenceMode(saved.imageReferenceMode || process.env.EXTERNAL_IMAGE_REFERENCE_MODE || process.env.OMNIROUTE_IMAGE_REFERENCE_MODE),
    imageDownloadPathPrefix: saved.imageDownloadPathPrefix || process.env.EXTERNAL_IMAGE_DOWNLOAD_PATH_PREFIX || process.env.OMNIROUTE_IMAGE_DOWNLOAD_PATH_PREFIX || '',
    imageTimeoutMs: externalImageTimeout(saved.imageTimeoutMs || process.env.EXTERNAL_IMAGE_TIMEOUT_MS || process.env.OMNIROUTE_IMAGE_TIMEOUT_MS || process.env.OMNIROUTE_TIMEOUT_MS),
    imageBaseUrl: saved.imageBaseUrl || process.env.EXTERNAL_IMAGE_BASE_URL || process.env.OMNIROUTE_IMAGE_BASE_URL || '',
    apiKey: apiKey ? `${String(apiKey).slice(0, 8)}${'•'.repeat(20)}` : '',
  };
}

function getKvCreds() {
  const url   = (process.env.KV_REST_API_URL   || '').replace(/^["']|["']$/g, '');
  const token = (process.env.KV_REST_API_TOKEN || '').replace(/^["']|["']$/g, '');
  return { url, token };
}

const SHOP_ID = process.env.ETSY_SHOP_ID || 'default';

// ── KV client (Upstash Redis REST protocol) ──────────
async function kvCall(command, ...args) {
  const { url, token } = getKvCreds();
  if (!url || !token) throw new Error('KV_REST_API_URL or KV_REST_API_TOKEN not configured. Add an Upstash-compatible Redis REST endpoint to the runtime environment.');

  const res = await fetch(`${url}/${[command, ...args].join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

const socialPublishHistoryRepository = createSocialPublishHistoryRepository({
  callKv: kvCall,
  shopId: SHOP_ID,
});
const etsyReviewResponseRepository = createEtsyReviewResponseRepository({
  callKv: kvCall,
  shopId: SHOP_ID,
});
const agentMemoryRepository = createAgentMemoryRepository({
  callKv: kvCall,
  shopId: SHOP_ID,
});

export async function kvSet(key, value, exSeconds) {
  const fullKey = `${SHOP_ID}:${key}`;
  const serialized = JSON.stringify(value);
  if (exSeconds) {
    return kvCall('SET', fullKey, encodeURIComponent(serialized), 'EX', exSeconds);
  }
  return kvCall('SET', fullKey, encodeURIComponent(serialized));
}

export async function kvSetNx(key, value, exSeconds) {
  const fullKey = `${SHOP_ID}:${key}`;
  const serialized = encodeURIComponent(JSON.stringify(value));
  const args = ['SET', fullKey, serialized, 'NX'];
  if (exSeconds) args.push('EX', String(exSeconds));
  return (await kvCall(...args)) === 'OK';
}

export async function kvGet(key) {
  const fullKey = `${SHOP_ID}:${key}`;
  const raw = await kvCall('GET', fullKey);
  if (!raw) return null;
  return JSON.parse(decodeURIComponent(raw));
}

export function userAgentMemoryKey(userId) {
  return buildUserAgentMemoryKey(userId);
}

export async function loadUserAgentMemory(userId) {
  return agentMemoryRepository.load(userId);
}

export async function saveUserAgentMemory(userId, value) {
  return agentMemoryRepository.save(userId, value);
}

export async function appendUserAgentMemory(userId, value = {}) {
  return agentMemoryRepository.append(userId, value);
}

export async function deleteUserAgentMemory(userId, memoryId) {
  return agentMemoryRepository.remove(userId, memoryId);
}

async function kvDel(key) {
  return kvCall('DEL', `${SHOP_ID}:${key}`);
}

async function kvKeys(pattern) {
  const fullPattern = `${SHOP_ID}:${pattern}`;
  return kvCall('KEYS', fullPattern);
}

function normalizeScheduledPlatform(value = '') {
  return String(value || '').trim().toLowerCase();
}

const SCHEDULED_APPROVAL_INPUT_FIELDS = new Set([
  'approved_for_publish',
  'approved_by',
  'approved_at',
  'approval_note',
  'approval_source',
  'publish_method',
  'post_url',
  'publish_result',
  'published_at',
  'last_publish_attempt_at',
  'queue_state',
]);

function withoutScheduledApprovalInput(value = {}) {
  return Object.fromEntries(Object.entries(value || {}).filter(([key]) => !SCHEDULED_APPROVAL_INPUT_FIELDS.has(key)));
}

function asUnapprovedScheduledRecord(value = {}) {
  const record = withoutScheduledApprovalInput(value);
  const requestedStatus = String(record.status || '').trim().toLowerCase();
  const status = ['draft', 'scheduled', 'paused'].includes(requestedStatus)
    ? requestedStatus
    : record.scheduled_at ? 'scheduled' : 'draft';
  return {
    ...record,
    status,
    approved_for_publish: false,
    approved_by: null,
    approved_at: null,
    approval_note: null,
    approval_source: null,
    publish_method: null,
    post_url: null,
    publish_result: null,
    published_at: null,
    last_publish_attempt_at: null,
    queue_state: status,
  };
}

function scheduledPostAllTargetFromConfigs(configs = {}) {
  return resolveSchedulerConfiguredPlatforms(configs).filter(platform => platform && platform !== 'all');
}

async function expandAllPlatformScheduledRecord(record = {}) {
  if (normalizeScheduledPlatform(record.platform) !== 'all') return [record];
  const configs = (await kvGet('social_configs')) || {};
  const targets = scheduledPostAllTargetFromConfigs(configs);
  if (!targets.length) {
    const err = new Error('platform=all requires at least one UI-configured social platform. Configure Social settings or save one explicit platform.');
    err.code = 'ALL_PLATFORM_TARGET_EMPTY';
    err.status = 400;
    throw err;
  }
  const baseId = String(record.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);
  return targets.map(platform => ({
    ...record,
    id: targets.length === 1 ? baseId : `${baseId}-${platform}`,
    platform,
    metadata: {
      ...(record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata : {}),
      expanded_from_platform: 'all',
      all_platform_target: targets,
    },
  }));
}

// ── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const { action, key, value, ttl } = req.method === 'GET' ? req.query : req.body;
  const userId = String(req.auth?.user?.id || 'anonymous').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'anonymous';
  const galleryMetaKey = `${SHOP_ID}:user:${userId}:gallery:meta`;
  const galleryVideosKey = `${SHOP_ID}:user:${userId}:gallery:videos`;

  try {
    switch (action) {

      // Store image prompts for a listing
      case 'setPrompts': {
        if (!key) return res.status(400).json({ error: 'key required (listing_id)' });
        await kvSet(`prompts:${key}`, value, ttl || 60 * 60 * 24 * 30); // 30 days
        return res.json({ success: true });
      }

      case 'getPrompts': {
        if (!key) return res.status(400).json({ error: 'key required (listing_id)' });
        const data = await kvGet(`prompts:${key}`);
        return res.json({ success: true, data });
      }

      case 'deletePrompts': {
        await kvDel(`prompts:${key}`);
        return res.json({ success: true });
      }

      // List all prompt keys for this shop
      case 'listPrompts': {
        const keys = await kvKeys('prompts:*');
        return res.json({ success: true, data: keys });
      }

      // Shop context cache (shared between both users)
      case 'setContext': {
        await kvSet('shop_context', value, 60 * 30); // 30 min TTL
        return res.json({ success: true });
      }

      case 'getContext': {
        const data = await kvGet('shop_context');
        return res.json({ success: true, data });
      }

      // Generic get/set for preferences/settings
      case 'set': {
        if (!key) return res.status(400).json({ error: 'key required' });
        await kvSet(`data:${key}`, value, ttl);
        return res.json({ success: true });
      }

      case 'get': {
        if (!key) return res.status(400).json({ error: 'key required' });
        const data = await kvGet(`data:${key}`);
        return res.json({ success: true, data });
      }

      case 'del': {
        await kvDel(key.startsWith('data:') ? key : `data:${key}`);
        return res.json({ success: true });
      }

      // ── Post history (social media tracking) ─────────────
      // Records: { listing_id, listing_title, platform, service, postedAt }
      case 'recordPost':
      case 'clearPosts': {
        return res.status(405).json({
          success: false,
          code: 'PUBLISH_HISTORY_SERVER_WRITABLE_ONLY',
          error: 'Publish history is read-only from browser/API KV routes and is written only by confirmed scheduler or Make callback results.',
        });
      }

      case 'getPosts': {
        const records = await socialPublishHistoryRepository.list();
        return res.json({ success: true, data: records });
      }

      // ── Image gallery metadata ────────────────────────────
      // Stores metadata only (no base64) — image binary lives in IndexedDB as cache
      case 'saveGalleryMeta': {
        // value: { id, prompt, slotLabel, listingTitle, mimeType, createdAt }
        const record = JSON.stringify(value);
        await kvCall('LPUSH', galleryMetaKey, encodeURIComponent(record));
        await kvCall('LTRIM', galleryMetaKey, '0', '999');
        return res.json({ success: true });
      }

      case 'getGalleryMeta': {
        const raw = await kvCall('LRANGE', galleryMetaKey, '0', '-1');
        const records = (raw || []).map(r => { try { return JSON.parse(decodeURIComponent(r)); } catch { return null; } }).filter(Boolean);
        return res.json({ success: true, data: records });
      }

      case 'deleteGalleryMeta': {
        // Remove one item by re-writing the list without it
        const raw = await kvCall('LRANGE', galleryMetaKey, '0', '-1');
        const records = (raw || []).map(r => { try { return JSON.parse(decodeURIComponent(r)); } catch { return null; } }).filter(Boolean);
        const filtered = records.filter(r => r.id !== value.id);
        await kvCall('DEL', galleryMetaKey);
        for (const r of [...filtered].reverse()) {
          await kvCall('LPUSH', galleryMetaKey, encodeURIComponent(JSON.stringify(r)));
        }
        return res.json({ success: true });
      }

      case 'clearGalleryMeta': {
        await kvCall('DEL', galleryMetaKey);
        return res.json({ success: true });
      }

      // ── Scheduled posts (social media drafts & calendar) ─────
      // Schema: { id, caption, platform, listing_id, listing_title, listing_image_url, custom_image_url, scheduled_at, status, created_at }
      case 'saveScheduledPost': {
        const baseRecord = asUnapprovedScheduledRecord({
          ...value,
          id: value.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          created_at: value.created_at || Date.now(),
        });
        const expandedRecords = await expandAllPlatformScheduledRecord(baseRecord);
        const savedRecords = await saveScheduledPostBatch(expandedRecords);
        return res.json({ success: true, data: savedRecords.length === 1 ? savedRecords[0] : savedRecords });
      }

      case 'getScheduledPosts': {
        return res.json({ success: true, data: await getScheduledPosts() });
      }

      case 'updateScheduledPost': {
        if (Object.prototype.hasOwnProperty.call(value || {}, 'platform')
          && normalizeScheduledPlatform(value.platform) === 'all') {
          return res.status(400).json({
            error: 'Updating one scheduled post to platform=all is not allowed. Create a new all-platform post so Etsy AI Command Center can expand it into concrete platform records.',
            code: 'ALL_PLATFORM_UPDATE_NOT_ALLOWED',
          });
        }
        const safeValue = withoutScheduledApprovalInput(value || {});
        try {
          const updatedRecord = await updateScheduledPost(safeValue.id, safeValue, { updatedAt: Date.now() });
          return res.json({ success: true, data: updatedRecord });
        } catch (error) {
          if (/^Scheduled post not found:/i.test(String(error?.message || ''))) {
            return res.status(404).json({ error: error.message });
          }
          throw error;
        }
      }

      case 'deleteScheduledPost': {
        const result = await deleteScheduledPost(value.id);
        return res.json({ success: true, data: { id: value.id, ...result } });
      }

      // ── Review response tracking ───────────────────────────
      case 'getRespondedReviews': {
        return res.json({ success: true, data: await etsyReviewResponseRepository.read() });
      }

      case 'markReviewResponded': {
        await etsyReviewResponseRepository.markResponded(value.transaction_id);
        return res.json({ success: true });
      }

      case 'unmarkReviewResponded': {
        await etsyReviewResponseRepository.unmarkResponded(value.transaction_id);
        return res.json({ success: true });
      }

      // ── Extra Gemini API keys (parallel image generation) ──
      case 'setGeminiKeys': {
        // value: string[] of API keys
        await kvSet('gemini_extra_keys', (Array.isArray(value) ? value : []).filter(Boolean));
        return res.json({ success: true });
      }

      case 'getGeminiKeys': {
        const data = await kvGet('gemini_extra_keys');
        return res.json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      case 'setExternalAiConfig': {
        const cfg = value && typeof value === 'object' ? value : {};
        const existing = (await kvGet('external_ai_config')) || {};
        const imageModel = String(cfg.imageModel || '').trim();
        const imagePath = String(cfg.imagePath || '').trim();
        const imageAdapter = normalizeExternalImageAdapter(cfg.imageAdapter);
        assertExternalImageContract({ imageModel, imagePath, imageAdapter });
        await kvSet('external_ai_config', {
          baseUrl: String(cfg.baseUrl || '').trim(),
          apiKey: String(cfg.apiKey || existing.apiKey || '').trim(),
          method: String(cfg.method || 'openai').trim().toLowerCase(),
          textPath: String(cfg.textPath || '/v1/chat/completions').trim(),
          imagePath,
          textModel: String(cfg.textModel || '').trim(),
          visionModel: String(cfg.visionModel || cfg.textModel || '').trim(),
          imageModel,
          imageStream: cfg.imageStream === true,
          imageResponseFormat: externalImageResponseFormat(cfg.imageResponseFormat),
          imageAdapter,
          imageReferenceMode: externalImageReferenceMode(cfg.imageReferenceMode),
          imageDownloadPathPrefix: String(cfg.imageDownloadPathPrefix || '').trim(),
          imageTimeoutMs: externalImageTimeout(cfg.imageTimeoutMs),
          imageBaseUrl: String(cfg.imageBaseUrl || '').trim(),
        });
        return res.json({ success: true });
      }

      case 'getExternalAiConfig': {
        const saved = (await kvGet('external_ai_config')) || {};
        return res.json({ success: true, data: publicExternalAiConfig(saved) });
      }

      case 'getAiProviderStatus': {
        const saved = (await kvGet('external_ai_config')) || {};
        const external = publicExternalAiConfig(saved);
        const { apiKey: _maskedApiKey, ...externalStatus } = external;
        return res.json({ success: true, data: {
          textDefaultProvider: external.configured ? 'external' : (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'claude' : 'none'),
          imageDefaultProvider: external.configured ? 'external' : (process.env.GEMINI_API_KEY ? 'gemini' : 'none'),
          providers: [
            { key: 'external', label: 'OpenAI-compatible external provider', ...externalStatus, supportsTools: true, supportsImages: Boolean(external.imageModel), supportsVision: Boolean(external.visionModel) },
            { key: 'gemini', label: 'Google Gemini / Nano Banana', configured: Boolean(process.env.GEMINI_API_KEY), textModel: MODEL.gemini, imageModel: MODEL.geminiImage, supportsTools: true, supportsImages: true },
            { key: 'claude', label: 'Claude', configured: Boolean(process.env.ANTHROPIC_API_KEY), textModel: MODEL.claudeFast, supportsTools: true, supportsImages: false },
          ],
        } });
      }

      case 'setEtsyTokens': {
        const cfg = value && typeof value === 'object' ? value : {};
        await etsyTokenStateRepository.update(current => mergeEtsyTokenSettings(current, cfg));
        return res.json({ success: true });
      }

      // ── Meta AI session cookies ────────────────────────────
      case 'setMetaCookies': {
        await kvSet('meta_ai_cookies', normalizeMetaAiCookieSetting(value));
        return res.json({ success: true });
      }

      case 'getMetaCookies': {
        const data = await kvGet('meta_ai_cookies');
        return res.json({ success: true, data: data || '' });
      }

      // ── Video gallery metadata ────────────────────────────
      case 'saveVideoMeta': {
        const record = JSON.stringify(value);
        await kvCall('LPUSH', galleryVideosKey, encodeURIComponent(record));
        await kvCall('LTRIM', galleryVideosKey, '0', '299');
        return res.json({ success: true });
      }

      case 'getVideoMeta': {
        const raw = await kvCall('LRANGE', galleryVideosKey, '0', '-1');
        const records = (raw || []).map(r => { try { return JSON.parse(decodeURIComponent(r)); } catch { return null; } }).filter(Boolean);
        return res.json({ success: true, data: records });
      }

      case 'deleteVideoMeta': {
        const raw = await kvCall('LRANGE', galleryVideosKey, '0', '-1');
        const records = (raw || []).map(r => { try { return JSON.parse(decodeURIComponent(r)); } catch { return null; } }).filter(Boolean);
        const filtered = records.filter(r => r.id !== value.id);
        await kvCall('DEL', galleryVideosKey);
        for (const r of [...filtered].reverse()) {
          await kvCall('LPUSH', galleryVideosKey, encodeURIComponent(JSON.stringify(r)));
        }
        return res.json({ success: true });
      }

      case 'clearVideoMeta': {
        await kvCall('DEL', galleryVideosKey);
        return res.json({ success: true });
      }

      // ── Social platform configs (shared across users/devices) ────
      case 'getSocialConfigs': {
        const data = await kvGet('social_configs');
        return res.json({ success: true, data: data || {} });
      }

      case 'setSocialConfig': {
        if (!key) return res.status(400).json({ error: 'key required' });
        const configs = (await kvGet('social_configs')) || {};
        if (value) configs[key] = value; else delete configs[key];
        await kvSet('social_configs', configs);
        return res.json({ success: true });
      }

      case 'deleteSocialConfig': {
        if (!key) return res.status(400).json({ error: 'key required' });
        const configs2 = (await kvGet('social_configs')) || {};
        delete configs2[key];
        await kvSet('social_configs', configs2);
        return res.json({ success: true });
      }

      // ── Personalization prefs (shared across users/devices) ──
      case 'getPersonalizationPrefs': {
        const data = await kvGet('personalization_prefs');
        return res.json({ success: true, data: data || null });
      }

      case 'setPersonalizationPrefs': {
        await kvSet('personalization_prefs', value);
        return res.json({ success: true });
      }

      // ── Agent memory (private to the authenticated user) ─────
      case 'getAgentMemory': {
        const data = await loadUserAgentMemory(userId);
        return res.json({ success: true, data });
      }

      case 'setAgentMemory': {
        await saveUserAgentMemory(userId, value);
        return res.json({ success: true });
      }

      case 'appendAgentMemory': {
        const data = await appendUserAgentMemory(userId, value || {});
        return res.json({ success: true, data });
      }

      case 'deleteAgentMemory': {
        const memoryId = String(value?.id || value || '').trim();
        const data = await deleteUserAgentMemory(userId, memoryId);
        return res.json({ success: true, data });
      }

      case 'getShopOperatingContext': {
        const data = await kvGet('shop_operating_context');
        return res.json({ success: true, data: data || null });
      }

      case 'setShopOperatingContext': {
        await kvSet('shop_operating_context', value || null);
        return res.json({ success: true });
      }

      // ── Facebook Shop sync state (shared across users/devices) ──
      case 'getFbSync': {
        const data = await kvGet('fb_sync');
        return res.json({ success: true, data: data || {} });
      }

      case 'setFbSync': {
        // value: { listing_id, ...entry } — pass null entry to delete
        const { listing_id, ...entry } = value || {};
        if (!listing_id) return res.status(400).json({ error: 'listing_id required' });
        const sync = (await kvGet('fb_sync')) || {};
        if (Object.keys(entry).length === 0) {
          delete sync[listing_id];
        } else {
          sync[listing_id] = entry;
        }
        await kvSet('fb_sync', sync);
        return res.json({ success: true });
      }

      // Health check
      case 'ping': {
        await kvCall('PING');
        return res.json({ success: true, message: 'KV storage connected' });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    if (err.status || err.code === 'ALL_PLATFORM_TARGET_EMPTY') {
      return res.status(err.status || 400).json({ error: err.message, code: err.code || 'BAD_REQUEST' });
    }
    // Graceful fallback — KV might not be configured
    if (err.message.includes('not configured')) {
      return res.status(503).json({
        error: 'KV storage not configured',
        hint: 'Add KV_REST_API_URL and KV_REST_API_TOKEN to the runtime environment.',
      });
    }
    console.error('[kv.js]', err.message);
    return sendPublicError(res, err);
  }
}
