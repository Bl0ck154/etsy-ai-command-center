import { MODEL } from './_config.js';
import { kvGet } from './kv.js';
import { parseJsonish } from './_utils.js';

const SUPPORTED_METHODS = new Set(['openai']);
const DEFAULT_TEXT_PATH = '/v1/chat/completions';
const DEFAULT_IMAGE_PATH = '';
const IMAGE_RETRY_DELAY_MIN_MS = 10_000;
const IMAGE_RETRY_DELAY_MAX_MS = 20_000;
// Generic external image providers often need a long-running job behind an
// OpenAI-compatible chat/completions facade. Retry exactly once for transient
// transport/502/503/missing-image responses; do not loop forever.
const IMAGE_MAX_ATTEMPTS = 2;
const DEFAULT_IMAGE_TIMEOUT_MS = 120_000;
const DEFAULT_TEXT_TIMEOUT_MS = 120_000;
const DEFAULT_EXTERNAL_CONFIG_KV_TIMEOUT_MS = 2_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SSE_TEXT_BYTES = 1024 * 1024;
const IMAGE_RESPONSE_FORMATS = new Set(['data_uri', 'base64_json', 'markdown_url']);
const IMAGE_ADAPTERS = new Set(['chat_data_uri', 'openai_images', 'openai_images_json', 'openai_responses']);
const IMAGE_REFERENCE_MODES = new Set(['unsupported', 'chat_multimodal', 'provider_native']);
const EXTERNAL_PROVIDERS_ENV = 'EXTERNAL_AI_PROVIDERS_JSON';
const SOCIAL_MEDIA_ASSET_ID_RE = /^shmedia_[a-f0-9]{24}$/i;

function boolConfig(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function firstConfigured(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function normalizeImageResponseFormat(value) {
  const format = String(value || 'base64_json').trim().toLowerCase();
  return IMAGE_RESPONSE_FORMATS.has(format) ? format : 'base64_json';
}

function normalizeImageAdapter(value) {
  const adapter = String(value || '').trim().toLowerCase();
  return IMAGE_ADAPTERS.has(adapter) ? adapter : '';
}

function normalizedProviderId(value, index = 0) {
  const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || `external-${index + 1}`;
}

function readProviderEnv(name) {
  const key = String(name || '').trim();
  return key ? String(process.env[key] || '').trim() : '';
}

function providerValue(record = {}, key, fallback = '') {
  const envKey = record[`${key}Env`] || record[`${key}_env`];
  if (envKey) return readProviderEnv(envKey) || fallback;
  const value = record[key] ?? record[key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`)];
  return value === undefined || value === null ? fallback : value;
}

function providerSectionValue(record = {}, section, key, fallback = '') {
  const nested = record?.[section] && typeof record[section] === 'object' ? record[section] : {};
  return providerValue(nested, key, providerValue(record, `${section}${key[0].toUpperCase()}${key.slice(1)}`, fallback));
}

function parseAdditionalExternalProviderRecords() {
  const raw = String(process.env[EXTERNAL_PROVIDERS_ENV] || '').trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${EXTERNAL_PROVIDERS_ENV} must be a JSON array`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${EXTERNAL_PROVIDERS_ENV} must be a JSON array`);
  return parsed.filter(item => item && typeof item === 'object' && item.enabled !== false);
}

function normalizeAdditionalExternalProvider(record, index) {
  const id = normalizedProviderId(record.id || record.name, index + 1);
  const baseUrl = String(providerValue(record, 'baseUrl', '') || '').replace(/\/+$/, '');
  const apiKey = String(providerValue(record, 'apiKey', '') || '');
  const imageBaseUrl = String(providerSectionValue(record, 'image', 'baseUrl', providerValue(record, 'imageBaseUrl', '')) || '').replace(/\/+$/, '');
  const imageApiKey = String(providerSectionValue(record, 'image', 'apiKey', providerValue(record, 'imageApiKey', '')) || '');
  const imageModel = String(providerSectionValue(record, 'image', 'model', providerValue(record, 'imageModel', '')) || '');
  const imagePath = String(providerSectionValue(record, 'image', 'path', providerValue(record, 'imagePath', '')) || '');
  const rawImageAdapter = providerSectionValue(record, 'image', 'adapter', providerValue(record, 'imageAdapter', ''));
  const imageAdapter = normalizeImageAdapter(rawImageAdapter);
  if (imageModel && !imageAdapter) {
    throw new Error(`${EXTERNAL_PROVIDERS_ENV} provider "${id}" must declare a supported image.adapter`);
  }
  if (imageModel && !imagePath) {
    throw new Error(`${EXTERNAL_PROVIDERS_ENV} provider "${id}" must declare image.path`);
  }
  return {
    id,
    baseUrl,
    apiKey,
    method: String(providerValue(record, 'method', 'openai') || 'openai').toLowerCase(),
    textPath: String(providerSectionValue(record, 'text', 'path', providerValue(record, 'textPath', DEFAULT_TEXT_PATH)) || DEFAULT_TEXT_PATH),
    textModel: String(providerSectionValue(record, 'text', 'model', providerValue(record, 'textModel', '')) || ''),
    // An agent turn has a stronger contract than ordinary text generation: it
    // must return OpenAI-style tool_calls. Keep providers out of that route
    // until that capability has been verified for the configured model.
    textToolCalling: boolConfig(providerSectionValue(record, 'text', 'toolCalling', providerValue(record, 'textToolCalling', false)), false),
    visionModel: String(providerSectionValue(record, 'vision', 'model', providerValue(record, 'visionModel', '')) || ''),
    imageBaseUrl,
    imageApiKey,
    imagePath,
    imageModel,
    imageAdapter,
    imageReferenceMode: normalizeImageReferenceMode(providerSectionValue(record, 'image', 'referenceMode', providerValue(record, 'imageReferenceMode', 'unsupported'))),
    imageReferenceField: String(providerSectionValue(record, 'image', 'referenceField', providerValue(record, 'imageReferenceField', 'input_image')) || 'input_image'),
    imageSize: String(providerSectionValue(record, 'image', 'size', providerValue(record, 'imageSize', '1024x1024')) || '1024x1024'),
    imageGenerationSize: String(providerSectionValue(record, 'image', 'imageSize', providerValue(record, 'imageGenerationSize', '')) || '').toUpperCase(),
    imageOutputFormat: String(providerSectionValue(record, 'image', 'outputFormat', providerValue(record, 'imageOutputFormat', 'preserve')) || 'preserve').toLowerCase(),
    imageStream: boolConfig(providerSectionValue(record, 'image', 'stream', providerValue(record, 'imageStream', false))),
    imageResponseFormat: normalizeImageResponseFormat(providerSectionValue(record, 'image', 'responseFormat', providerValue(record, 'imageResponseFormat', 'base64_json'))),
    imageDownloadPathPrefix: String(providerSectionValue(record, 'image', 'downloadPathPrefix', providerValue(record, 'imageDownloadPathPrefix', '')) || '').trim(),
    textTimeoutMs: normalizedTimeoutMs(providerSectionValue(record, 'text', 'timeoutMs', providerValue(record, 'textTimeoutMs', DEFAULT_TEXT_TIMEOUT_MS)), DEFAULT_TEXT_TIMEOUT_MS),
    imageTimeoutMs: normalizedTimeoutMs(providerSectionValue(record, 'image', 'timeoutMs', providerValue(record, 'imageTimeoutMs', DEFAULT_IMAGE_TIMEOUT_MS)), DEFAULT_IMAGE_TIMEOUT_MS),
  };
}

function normalizeImageReferenceMode(value) {
  const mode = String(value || 'unsupported').trim().toLowerCase();
  return IMAGE_REFERENCE_MODES.has(mode) ? mode : 'unsupported';
}

function normalizedTimeoutMs(value, fallback, max = 900_000) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  return Math.max(5_000, Math.min(max, ms));
}

function externalConfigKvTimeoutMs() {
  const ms = Number(process.env.EXTERNAL_AI_CONFIG_KV_TIMEOUT_MS);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_EXTERNAL_CONFIG_KV_TIMEOUT_MS;
  return Math.max(100, Math.min(5_000, ms));
}

function hasExplicitRuntimeImagePipeline() {
  return Boolean(
    (process.env.EXTERNAL_AI_BASE_URL || process.env.OMNIROUTE_BASE_URL)
    && (process.env.EXTERNAL_AI_API_KEY || process.env.OMNIROUTE_API_KEY)
    && (process.env.EXTERNAL_IMAGE_MODEL || process.env.OMNIROUTE_IMAGE_MODEL)
    && (process.env.EXTERNAL_IMAGE_ADAPTER || process.env.OMNIROUTE_IMAGE_ADAPTER)
    && process.env.EXTERNAL_AI_IMAGE_PATH
  );
}

async function loadSavedExternalAiConfig() {
  let timer;
  try {
    return await new Promise(resolve => {
      timer = setTimeout(() => resolve(null), externalConfigKvTimeoutMs());
      Promise.resolve(kvGet('external_ai_config'))
        .then(value => resolve(value), () => resolve(null));
    });
  } finally {
    clearTimeout(timer);
  }
}

function getExternalAiConfig() {
  return {
    baseUrl: (process.env.EXTERNAL_AI_BASE_URL || process.env.OMNIROUTE_BASE_URL || '').replace(/\/+$/, ''),
    imageBaseUrl: (process.env.EXTERNAL_IMAGE_BASE_URL || process.env.OMNIROUTE_IMAGE_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.EXTERNAL_AI_API_KEY || process.env.OMNIROUTE_API_KEY || '',
    imageApiKey: process.env.EXTERNAL_IMAGE_API_KEY || process.env.OMNIROUTE_IMAGE_API_KEY || '',
    method: (process.env.EXTERNAL_AI_METHOD || 'openai').toLowerCase(),
    textPath: process.env.EXTERNAL_AI_TEXT_PATH || DEFAULT_TEXT_PATH,
    imagePath: process.env.EXTERNAL_AI_IMAGE_PATH || DEFAULT_IMAGE_PATH,
    textModel: process.env.EXTERNAL_AI_MODEL || process.env.OMNIROUTE_TEXT_MODEL || MODEL.external,
    visionModel: process.env.EXTERNAL_VISION_MODEL || process.env.OMNIROUTE_VISION_MODEL || '',
    imageModel: process.env.EXTERNAL_IMAGE_MODEL || process.env.OMNIROUTE_IMAGE_MODEL || '',
    imageStream: boolConfig(process.env.EXTERNAL_IMAGE_STREAM || process.env.OMNIROUTE_IMAGE_STREAM),
    imageResponseFormat: normalizeImageResponseFormat(process.env.EXTERNAL_IMAGE_RESPONSE_FORMAT || process.env.OMNIROUTE_IMAGE_RESPONSE_FORMAT),
    imageAdapter: normalizeImageAdapter(process.env.EXTERNAL_IMAGE_ADAPTER || process.env.OMNIROUTE_IMAGE_ADAPTER),
    imageReferenceMode: normalizeImageReferenceMode(process.env.EXTERNAL_IMAGE_REFERENCE_MODE || process.env.OMNIROUTE_IMAGE_REFERENCE_MODE),
    imageDownloadPathPrefix: String(process.env.EXTERNAL_IMAGE_DOWNLOAD_PATH_PREFIX || process.env.OMNIROUTE_IMAGE_DOWNLOAD_PATH_PREFIX || '').trim(),
    textTimeoutMs: normalizedTimeoutMs(process.env.EXTERNAL_AI_TIMEOUT_MS || process.env.OMNIROUTE_TEXT_TIMEOUT_MS || process.env.OMNIROUTE_TIMEOUT_MS, DEFAULT_TEXT_TIMEOUT_MS),
    imageTimeoutMs: normalizedTimeoutMs(process.env.EXTERNAL_IMAGE_TIMEOUT_MS || process.env.OMNIROUTE_IMAGE_TIMEOUT_MS || process.env.OMNIROUTE_TIMEOUT_MS, DEFAULT_IMAGE_TIMEOUT_MS),
  };
}

export async function getExternalAiConfigAsync() {
  const config = getExternalAiConfig();
  // A complete runtime image pipeline takes precedence over Settings. Do not
  // block image generation on a KV request whose values cannot affect it.
  if (hasExplicitRuntimeImagePipeline()) return config;
  const saved = await loadSavedExternalAiConfig();
  if (!saved || typeof saved !== 'object') return config;
  // Each explicitly supplied runtime value wins independently. A server-side key
  // must not accidentally erase non-secret capabilities saved through Settings.
  return {
    baseUrl: String(firstDefined(process.env.EXTERNAL_AI_BASE_URL, process.env.OMNIROUTE_BASE_URL, saved.baseUrl, config.baseUrl) || '').replace(/\/+$/, ''),
    imageBaseUrl: String(firstDefined(process.env.EXTERNAL_IMAGE_BASE_URL, process.env.OMNIROUTE_IMAGE_BASE_URL, saved.imageBaseUrl, config.imageBaseUrl) || '').replace(/\/+$/, ''),
    apiKey: firstConfigured(process.env.EXTERNAL_AI_API_KEY, process.env.OMNIROUTE_API_KEY, saved.apiKey, config.apiKey) || '',
    imageApiKey: firstConfigured(process.env.EXTERNAL_IMAGE_API_KEY, process.env.OMNIROUTE_IMAGE_API_KEY, saved.imageApiKey, config.imageApiKey) || '',
    method: String(firstDefined(process.env.EXTERNAL_AI_METHOD, saved.method, config.method) || 'openai').toLowerCase(),
    textPath: firstDefined(process.env.EXTERNAL_AI_TEXT_PATH, saved.textPath, config.textPath) || DEFAULT_TEXT_PATH,
    imagePath: firstDefined(process.env.EXTERNAL_AI_IMAGE_PATH, saved.imagePath, config.imagePath) || DEFAULT_IMAGE_PATH,
    textModel: firstDefined(process.env.EXTERNAL_AI_MODEL, process.env.OMNIROUTE_TEXT_MODEL, saved.textModel, config.textModel) || '',
    visionModel: firstDefined(process.env.EXTERNAL_VISION_MODEL, process.env.OMNIROUTE_VISION_MODEL, saved.visionModel, config.visionModel) || '',
    imageModel: firstDefined(process.env.EXTERNAL_IMAGE_MODEL, process.env.OMNIROUTE_IMAGE_MODEL, saved.imageModel, config.imageModel) || '',
    imageStream: boolConfig(firstDefined(process.env.EXTERNAL_IMAGE_STREAM, process.env.OMNIROUTE_IMAGE_STREAM, saved.imageStream), config.imageStream),
    imageResponseFormat: normalizeImageResponseFormat(firstDefined(process.env.EXTERNAL_IMAGE_RESPONSE_FORMAT, process.env.OMNIROUTE_IMAGE_RESPONSE_FORMAT, saved.imageResponseFormat, config.imageResponseFormat)),
    imageAdapter: normalizeImageAdapter(firstDefined(process.env.EXTERNAL_IMAGE_ADAPTER, process.env.OMNIROUTE_IMAGE_ADAPTER, saved.imageAdapter, config.imageAdapter)),
    imageReferenceMode: normalizeImageReferenceMode(firstDefined(process.env.EXTERNAL_IMAGE_REFERENCE_MODE, process.env.OMNIROUTE_IMAGE_REFERENCE_MODE, saved.imageReferenceMode, config.imageReferenceMode)),
    imageDownloadPathPrefix: String(firstDefined(process.env.EXTERNAL_IMAGE_DOWNLOAD_PATH_PREFIX, process.env.OMNIROUTE_IMAGE_DOWNLOAD_PATH_PREFIX, saved.imageDownloadPathPrefix, config.imageDownloadPathPrefix) || '').trim(),
    textTimeoutMs: normalizedTimeoutMs(firstDefined(process.env.EXTERNAL_AI_TIMEOUT_MS, process.env.OMNIROUTE_TEXT_TIMEOUT_MS, process.env.OMNIROUTE_TIMEOUT_MS, saved.textTimeoutMs, config.textTimeoutMs), DEFAULT_TEXT_TIMEOUT_MS),
    imageTimeoutMs: normalizedTimeoutMs(firstDefined(process.env.EXTERNAL_IMAGE_TIMEOUT_MS, process.env.OMNIROUTE_IMAGE_TIMEOUT_MS, process.env.OMNIROUTE_TIMEOUT_MS, saved.imageTimeoutMs, config.imageTimeoutMs), DEFAULT_IMAGE_TIMEOUT_MS),
  };
}

function legacyExternalProvider(config = {}) {
  return {
    ...config,
    id: normalizedProviderId(process.env.EXTERNAL_AI_PRIMARY_PROVIDER_ID || 'primary'),
    textPath: config.textPath || DEFAULT_TEXT_PATH,
    imagePath: config.imagePath || DEFAULT_IMAGE_PATH,
    // The legacy primary is the existing agent provider and retains its
    // established tool-call capability. Additional providers opt in through
    // EXTERNAL_AI_PROVIDERS_JSON after a live verification.
    textToolCalling: true,
    imageReferenceField: 'input_image',
    imageSize: '1024x1024',
    imageGenerationSize: '',
    imageOutputFormat: 'preserve',
  };
}

function providerSupportsCapability(provider = {}, capability) {
  if (!provider.baseUrl || !provider.apiKey || !SUPPORTED_METHODS.has(provider.method)) return false;
  if (capability === 'image') {
    return Boolean(
      (provider.imageApiKey || provider.apiKey)
      && String(provider.imageModel || '').trim()
      && String(provider.imagePath || '').trim()
      && IMAGE_ADAPTERS.has(provider.imageAdapter)
    );
  }
  if (capability === 'agent') return Boolean(provider.textToolCalling && String(provider.textModel || '').trim());
  return Boolean(String(provider.textModel || '').trim());
}

/**
 * Ordered server-side external provider chain. The existing external runtime
 * configuration is always first; EXTERNAL_AI_PROVIDERS_JSON appends explicit
 * fallbacks. Browser storage is never read here.
 */
export async function getExternalAiProviderChain(capability = 'text') {
  const primary = legacyExternalProvider(await getExternalAiConfigAsync());
  const additional = parseAdditionalExternalProviderRecords().map(normalizeAdditionalExternalProvider);
  const seen = new Set();
  return [primary, ...additional]
    .filter(provider => providerSupportsCapability(provider, capability))
    .filter(provider => {
      if (seen.has(provider.id)) return false;
      seen.add(provider.id);
      return true;
    });
}

export async function getSafeExternalAiConfig() {
  const config = await getExternalAiConfigAsync();
  const providers = await getExternalAiProviderChain('text').catch(() => []);
  return {
    configured: providers.length > 0,
    baseUrl: config.baseUrl,
    imageBaseUrl: config.imageBaseUrl || '',
    imageApiKeyConfigured: Boolean(config.imageApiKey || config.apiKey),
    method: config.method,
    textPath: config.textPath,
    imagePath: config.imagePath,
    textModel: config.textModel || '',
    visionModel: config.visionModel || config.textModel || '',
    imageModel: config.imageModel || '',
    imageStream: config.imageStream,
    imageResponseFormat: config.imageResponseFormat,
    imageAdapter: config.imageAdapter,
    imageReferenceMode: config.imageReferenceMode,
    imageDownloadPathPrefix: config.imageDownloadPathPrefix,
    textTimeoutMs: config.textTimeoutMs,
    imageTimeoutMs: config.imageTimeoutMs,
    apiKey: config.apiKey ? `${String(config.apiKey).slice(0, 8)}${'•'.repeat(20)}` : '',
    providers: providers.map(provider => ({ id: provider.id, textModel: provider.textModel, imageModel: provider.imageModel || '' })),
  };
}

export async function getExternalAiRuntimeConfig() {
  return validateExternalAiConfigAsync();
}

export async function hasExternalAiConfigAsync() {
  return (await getExternalAiProviderChain('text')).length > 0;
}

export async function hasExternalImageConfigAsync() {
  try {
    return (await getExternalAiProviderChain('image')).length > 0;
  } catch {
    return false;
  }
}

export async function getExternalImageCapabilities() {
  const providers = await getExternalAiProviderChain('image');
  const generatedImageAvailable = providers.length > 0;
  const referenceProvider = providers.find(provider => provider.imageReferenceMode !== 'unsupported');
  return {
    generatedImageAvailable,
    referenceImageSupported: Boolean(referenceProvider),
    referenceMode: referenceProvider?.imageReferenceMode || 'unsupported',
    models: providers.map(provider => ({
      providerId: provider.id,
      model: provider.imageModel,
      referenceImageSupported: provider.imageReferenceMode !== 'unsupported',
      referenceMode: provider.imageReferenceMode,
    })),
  };
}

export function hasExternalAiConfig() {
  const config = getExternalAiConfig();
  return Boolean(config.baseUrl && config.apiKey);
}

export function validateExternalAiConfig() {
  const config = getExternalAiConfig();
  if (!config.baseUrl) throw new Error('EXTERNAL_AI_BASE_URL not configured');
  if (!config.apiKey) throw new Error('EXTERNAL_AI_API_KEY not configured');
  if (!SUPPORTED_METHODS.has(config.method)) {
    throw new Error(`Unsupported EXTERNAL_AI_METHOD: ${config.method}`);
  }
  return config;
}

async function validateExternalAiConfigAsync() {
  const config = await getExternalAiConfigAsync();
  if (!config.baseUrl) throw new Error('EXTERNAL_AI_BASE_URL not configured');
  if (!config.apiKey) throw new Error('EXTERNAL_AI_API_KEY not configured');
  if (!SUPPORTED_METHODS.has(config.method)) {
    throw new Error(`Unsupported EXTERNAL_AI_METHOD: ${config.method}`);
  }
  return config;
}

function isAbsolutePathPrefix(value) {
  const prefix = String(value || '').trim();
  return prefix.startsWith('/') && !prefix.startsWith('//') && !prefix.includes('?') && !prefix.includes('#') && !prefix.includes('\\');
}

function requireExternalImageConfig(config) {
  if (!String(config.imageModel || '').trim()) throw new Error('EXTERNAL_IMAGE_MODEL not configured');
  if (!IMAGE_ADAPTERS.has(config.imageAdapter)) {
    throw new Error('EXTERNAL_IMAGE_ADAPTER must be explicitly configured to a supported adapter');
  }
  if (!String(config.imagePath || '').trim()) throw new Error('EXTERNAL_AI_IMAGE_PATH not configured');
  const imageModel = String(config.imageModel || '').trim().toLowerCase();
  const imagePath = String(config.imagePath || '').trim().replace(/\/+$/, '').toLowerCase();
  if (imageModel.startsWith('codex/') && (config.imageAdapter !== 'openai_responses' || imagePath !== '/v1/responses')) {
    throw new Error('Codex OAuth image generation requires EXTERNAL_IMAGE_ADAPTER=openai_responses and EXTERNAL_AI_IMAGE_PATH=/v1/responses');
  }
  return config;
}

export function buildExternalUrl(path) {
  const config = validateExternalAiConfig();
  return buildProviderUrl(config.baseUrl, path);
}

export function buildProviderUrl(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const dedupedPath = /\/v1$/i.test(baseUrl) && normalizedPath.toLowerCase().startsWith('/v1/')
    ? normalizedPath.slice(3)
    : normalizedPath;
  return `${baseUrl}${dedupedPath}`;
}

function authHeaders(config, extra = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    ...extra,
  };
}

function extractText(data) {
  const choice = data?.choices?.[0] || {};
  const content = choice?.message?.content ?? choice?.delta?.content ?? choice?.delta?.text;
  const contentText = Array.isArray(content)
    ? content.map(part => typeof part === 'string' ? part : part?.text || part?.content || '').join('')
    : content;
  return contentText
    || choice?.message?.reasoning_content
    || choice?.message?.text
    || choice?.delta?.reasoning_content
    || choice?.text
    || data?.output_text
    || data?.output?.[0]?.content?.[0]?.text
    || data?.text
    || '';
}

function validatedBase64Image(base64, mimeType = 'image/png') {
  const normalizedBase64 = String(base64 || '').replace(/\s+/g, '');
  let normalizedMime = String(mimeType || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!normalizedBase64) return null;
  const bytes = Buffer.from(normalizedBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
  const detectedMime = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8
      ? 'image/jpeg'
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
        ? 'image/webp'
        : '';
  if (!detectedMime) return null;
  // Some OpenAI-compatible image APIs omit mime_type with b64_json and can
  // still return JPEG/WebP. Trust the bytes, not an optimistic JSON label.
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(normalizedMime) || normalizedMime !== detectedMime) normalizedMime = detectedMime;
  return { base64: normalizedBase64, mimeType: normalizedMime };
}

async function normalizeImageOutput(image, config = {}) {
  if (!image || config.imageOutputFormat !== 'png' || image.mimeType === 'image/png') return image;
  try {
    const sharp = (await import('sharp')).default;
    const png = await sharp(Buffer.from(image.base64, 'base64')).png().toBuffer();
    return { base64: png.toString('base64'), mimeType: 'image/png' };
  } catch (err) {
    throw externalError(`External image AI returned ${image.mimeType}; PNG normalization failed: ${err?.message || 'unknown error'}`, {
      parserStage: 'external_image_png_normalize',
    });
  }
}

function normalizeDataUriImage(content) {
  const match = typeof content === 'string'
    ? content.match(/data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)/i)
    : null;
  return match ? validatedBase64Image(match[2], match[1]) : null;
}

async function normalizeExternalChatImage(config, responseText, signal, timeoutMs) {
  const dataUriImage = normalizeDataUriImage(responseText);
  if (dataUriImage) return dataUriImage;

  const urls = markdownImageUrls(responseText);
  if (urls.length && config.imageResponseFormat === 'markdown_url') {
    let lastError = null;
    for (const url of urls) {
      try {
        return await downloadProviderImage(config, url, signal, timeoutMs);
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
  }

  return null;
}

function responseShape(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') return `object(${Object.keys(value).slice(0, 10).join(',')})`;
  return typeof value;
}

async function readJsonWithDiagnostics(res, endpoint, parserStage = 'provider_response_json_parse') {
  const raw = await res.text();
  if (!String(raw || '').trim()) {
    const e = new Error(`External image AI returned an empty response (HTTP ${res.status})`);
    e.status = res.status;
    e.endpoint = endpoint;
    e.response_shape = 'empty';
    e.parser_stage = parserStage;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = new Error(`External image AI returned non-JSON response (status=${res.status}, parse=${err?.message || 'JSON parse failed'}, preview=${raw.slice(0, 80)})`);
    e.status = res.status;
    e.endpoint = endpoint;
    e.response_shape = 'non_json_text';
    e.parser_stage = parserStage;
    throw e;
  }
}

function externalError(message, { status, endpoint, data, parserStage } = {}) {
  const e = new Error(message);
  if (status !== undefined) e.status = status;
  if (endpoint) e.endpoint = endpoint;
  if (data !== undefined) e.response_shape = responseShape(data);
  if (parserStage) e.parser_stage = parserStage;
  return e;
}



function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function imageRetryDelayMs() {
  return IMAGE_RETRY_DELAY_MIN_MS + Math.floor(Math.random() * (IMAGE_RETRY_DELAY_MAX_MS - IMAGE_RETRY_DELAY_MIN_MS + 1));
}

function externalImageTimeoutMs(config = {}) {
  const raw = Number(config.imageTimeoutMs || process.env.EXTERNAL_IMAGE_TIMEOUT_MS || process.env.OMNIROUTE_IMAGE_TIMEOUT_MS || process.env.OMNIROUTE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 5_000 && raw <= 900_000) return raw;
  return DEFAULT_IMAGE_TIMEOUT_MS;
}

function markdownImageUrls(text = '') {
  const urls = [];
  const add = value => {
    const url = String(value || '').trim().replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
  };
  for (const match of String(text || '').matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi)) add(match[1]);
  return urls;
}

async function readOpenAiEventStream(res) {
  if (!res.body) throw externalError('External image AI returned an empty event stream', { status: res.status, parserStage: 'external_chat_image_sse_empty' });
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';
  let text = '';
  const consume = eventBlock => {
    const dataLines = String(eventBlock || '')
      .split(/\r?\n/)
      .filter(line => line.trimStart().startsWith('data:'))
      .map(line => line.trimStart().slice(5).trimStart());
    if (!dataLines.length) return;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') return;
    try {
      text += extractText(JSON.parse(payload));
      if (Buffer.byteLength(text, 'utf8') > MAX_SSE_TEXT_BYTES) {
        throw externalError('External image AI event stream exceeded the maximum response size', { status: res.status, parserStage: 'external_chat_image_sse_size' });
      }
    } catch (err) {
      if (err?.parser_stage === 'external_chat_image_sse_size') throw err;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_TEXT_BYTES) {
      throw externalError('External image AI event stream exceeded the maximum response size', { status: res.status, parserStage: 'external_chat_image_sse_size' });
    }
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    for (const event of events) consume(event);
    if (done) break;
  }
  if (buffer) consume(buffer);
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function isAllowedProviderImageUrl(config, value) {
  try {
    const image = new URL(value);
    const provider = new URL(config.baseUrl);
    const prefix = String(config.imageDownloadPathPrefix || '').trim();
    if (!isAbsolutePathPrefix(prefix) || image.username || image.password || image.search || image.hash) return false;
    let decodedPath;
    try { decodedPath = decodeURIComponent(image.pathname); } catch { return false; }
    if (decodedPath.split('/').includes('..') || decodedPath.includes('\\')) return false;
    const allowedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return image.protocol === provider.protocol
      && image.host === provider.host
      && image.pathname.startsWith(allowedPrefix)
      && decodedPath.startsWith(allowedPrefix);
  } catch {
    return false;
  }
}

async function downloadProviderImage(config, imageUrl, signal, timeoutMs) {
  if (!isAllowedProviderImageUrl(config, imageUrl)) {
    throw externalError('External image AI returned an untrusted image URL', { endpoint: imageUrl, parserStage: 'external_chat_image_url_validation' });
  }
  const res = await fetchWithTimeout(imageUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    redirect: 'error',
    signal,
  }, timeoutMs);
  if (!res.ok) throw externalError(`External image download failed with HTTP ${res.status}`, { status: res.status, endpoint: imageUrl, parserStage: 'external_chat_image_download_http' });
  const declaredLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw externalError('External image download exceeds the maximum size', { status: res.status, endpoint: imageUrl, parserStage: 'external_chat_image_download_size' });
  }
  const mimeType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    throw externalError(`External image download returned invalid Content-Type: ${mimeType || 'missing'}`, { status: res.status, endpoint: imageUrl, parserStage: 'external_chat_image_download_content_type' });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw externalError('External image download exceeds the maximum size', { status: res.status, endpoint: imageUrl, parserStage: 'external_chat_image_download_size' });
  }
  const validMagic = mimeType === 'image/png'
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mimeType === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!validMagic || bytes.length < 1024) {
    throw externalError('External image download did not contain a valid image payload', { status: res.status, endpoint: imageUrl, parserStage: 'external_chat_image_download_validation' });
  }
  return { base64: bytes.toString('base64'), mimeType };
}

function decodedPathIsSafe(url) {
  try {
    const decodedPath = decodeURIComponent(url.pathname);
    return !decodedPath.split('/').includes('..') && !decodedPath.includes('\\');
  } catch {
    return false;
  }
}

export function isAllowedExternalReferenceImageUrl(value) {
  try {
    const raw = String(value || '');
    if (/%(?:2e|5c)/i.test(raw)) return false;
    const url = new URL(raw);
    if (url.username || url.password || url.hash || !decodedPathIsSafe(url)) return false;

    if (url.protocol === 'https:' && url.hostname === 'i.etsystatic.com' && !url.port) {
      return true;
    }

    const configuredBase = String(process.env.PUBLIC_BASE_URL || '').trim();
    if (!configuredBase) return false;
    const publicBase = new URL(configuredBase);
    if (process.env.NODE_ENV === 'production' && publicBase.protocol !== 'https:') return false;
    if (url.origin !== publicBase.origin || url.pathname !== '/api/social') return false;
    const params = [...url.searchParams.keys()];
    return params.length === 2
      && params.includes('action')
      && params.includes('id')
      && url.searchParams.get('action') === 'mediaAsset'
      && SOCIAL_MEDIA_ASSET_ID_RE.test(String(url.searchParams.get('id') || ''));
  } catch {
    return false;
  }
}

async function downloadReferenceImage(referenceImage, signal, timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS) {
  if (!referenceImage) return null;
  if (referenceImage.base64 && (referenceImage.mimeType || referenceImage.mime_type)) {
    return validatedBase64Image(referenceImage.base64, referenceImage.mimeType || referenceImage.mime_type);
  }
  const imageUrl = typeof referenceImage === 'string'
    ? referenceImage
    : referenceImage.url || referenceImage.image_url || '';
  if (!/^https?:\/\//i.test(String(imageUrl || ''))) return null;
  if (!isAllowedExternalReferenceImageUrl(imageUrl)) {
    throw externalError('Reference image URL is not an allowed Etsy or Etsy AI Command Center media origin', {
      endpoint: imageUrl,
      parserStage: 'external_reference_image_url_validation',
    });
  }
  const res = await fetchWithTimeout(imageUrl, { method: 'GET', redirect: 'error', signal }, timeoutMs);
  if (!res.ok) throw externalError(`Reference image download failed with HTTP ${res.status}`, { status: res.status, endpoint: imageUrl, parserStage: 'external_reference_image_download_http' });
  const declaredLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw externalError('Reference image exceeds the maximum size', { status: res.status, endpoint: imageUrl, parserStage: 'external_reference_image_download_size' });
  }
  const mimeType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    throw externalError(`Reference image returned invalid Content-Type: ${mimeType || 'missing'}`, { status: res.status, endpoint: imageUrl, parserStage: 'external_reference_image_download_content_type' });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw externalError('Reference image exceeds the maximum size', { status: res.status, endpoint: imageUrl, parserStage: 'external_reference_image_download_size' });
  }
  const validMagic = mimeType === 'image/png'
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mimeType === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!validMagic || bytes.length < 1024) {
    throw externalError('Reference image did not contain a valid image payload', { status: res.status, endpoint: imageUrl, parserStage: 'external_reference_image_download_validation' });
  }
  return { base64: bytes.toString('base64'), mimeType };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS) {
  const controller = new AbortController();
  const upstream = options.signal;
  let timer;
  const abortFromUpstream = () => controller.abort(upstream?.reason || new Error('upstream abort'));
  if (upstream?.aborted) abortFromUpstream();
  else if (upstream) upstream.addEventListener('abort', abortFromUpstream, { once: true });
  timer = setTimeout(() => controller.abort(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    // Keep the timeout and upstream listener alive while streaming/reading the
    // body. Clearing here would protect only the response headers.
    const cleanup = () => {
      clearTimeout(timer);
      if (upstream) upstream.removeEventListener('abort', abortFromUpstream);
    };
    if (!res.body) {
      cleanup();
      return res;
    }
    const reader = res.body.getReader();
    const body = new ReadableStream({
      async pull(streamController) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            cleanup();
            streamController.close();
          } else {
            streamController.enqueue(value);
          }
        } catch (err) {
          cleanup();
          streamController.error(err);
        }
      },
      async cancel(reason) {
        cleanup();
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (err) {
    clearTimeout(timer);
    if (upstream) upstream.removeEventListener('abort', abortFromUpstream);
    throw err;
  }
}

function isAbortLike(err) {
  return err?.name === 'AbortError' || /abort|timeout/i.test(String(err?.message || ''));
}

function shouldRetryImageAttempt({ status, err, reason }, attempt) {
  if (attempt >= IMAGE_MAX_ATTEMPTS - 1) return false;
  if (isAbortLike(err)) return true;
  if ([500, 502, 503, 504].includes(Number(status))) return true;
  return /image_missing|no downloadable image link|no image data uri|no base64 images|empty response|invalid response|non-json|fetch failed|socket|gateway/i.test(String(reason || err?.message || ''));
}

export function isRetryableExternalAiFailure(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (isAbortLike(err)) return true;
  return /timeout|timed out|abort|fetch failed|network|socket|gateway|temporar|overload|rate limit|quota|econnreset|eai_again/i.test(String(err?.message || err || ''));
}

async function generateWithOneExternalProvider(config, systemPrompt, userPrompt, model = '', options = {}, providerIndex = 0) {
  const url = buildProviderUrl(config.baseUrl, config.textPath);
  const timeoutMs = normalizedTimeoutMs(
    config.textTimeoutMs || process.env.EXTERNAL_AI_TIMEOUT_MS || process.env.OMNIROUTE_TEXT_TIMEOUT_MS || process.env.OMNIROUTE_TIMEOUT_MS,
    DEFAULT_TEXT_TIMEOUT_MS,
  );
  const selectedModel = providerIndex === 0 && options?.preferRequestedModel === true && String(model || '').trim()
    ? String(model).trim()
    : config.textModel || model || MODEL.external;
  const requestedMaxTokens = Number(options?.maxTokens);
  const maxTokens = Number.isFinite(requestedMaxTokens)
    ? Math.max(512, Math.min(32_000, Math.round(requestedMaxTokens)))
    : null;
  const requestedTemperature = Number(options?.temperature);
  const temperature = Number.isFinite(requestedTemperature)
    ? Math.max(0, Math.min(2, requestedTemperature))
    : 0.7;
  const responseFormat = options?.responseFormat === 'json_object'
    ? { type: 'json_object' }
    : null;
  const structuredOutputToolName = options?.structuredOutput === true
    ? 'submit_structured_result'
    : '';
  const structuredOutputSchema = options?.structuredOutputSchema
    && typeof options.structuredOutputSchema === 'object'
    && !Array.isArray(options.structuredOutputSchema)
    ? options.structuredOutputSchema
    : { type: 'object', additionalProperties: true };
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        // The provider chain changes only transport/model identity. System and
        // user contracts remain exactly the same for every external provider.
        model: selectedModel,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(responseFormat && !structuredOutputToolName ? { response_format: responseFormat } : {}),
        ...(structuredOutputToolName ? {
          tools: [{
            type: 'function',
            function: {
              name: structuredOutputToolName,
              description: 'Submit the complete structured JSON object required by the system and user prompts.',
              parameters: structuredOutputSchema,
            },
          }],
          tool_choice: { type: 'function', function: { name: structuredOutputToolName } },
        } : {}),
      }),
    }, timeoutMs);
  } catch (err) {
    if (isAbortLike(err)) throw externalError(`External AI timed out after ${Math.round(timeoutMs / 1000)}s`, { endpoint: url, parserStage: 'external_text_timeout' });
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw externalError(data.error?.message || data.message || `External AI ${res.status}`, { status: res.status, endpoint: url, data, parserStage: 'external_text_http_error' });
  if (typeof options.onUsage === 'function') {
    const usage = data?.usage && typeof data.usage === 'object' ? data.usage : {};
    options.onUsage({
      provider_id: config.id,
      model: selectedModel,
      prompt_tokens: Number(usage.prompt_tokens ?? usage.input_tokens) || null,
      completion_tokens: Number(usage.completion_tokens ?? usage.output_tokens) || null,
      total_tokens: Number(usage.total_tokens) || null,
    });
  }
  if (structuredOutputToolName) {
    const toolCall = (data?.choices?.[0]?.message?.tool_calls || [])
      .find(call => call?.function?.name === structuredOutputToolName);
    if (toolCall) {
      const args = typeof toolCall.function.arguments === 'string'
        ? parseJsonish(toolCall.function.arguments)
        : toolCall.function.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw externalError('External AI returned invalid structured tool arguments', {
          status: 502,
          endpoint: url,
          data,
          parserStage: 'external_text_tool_arguments_invalid',
        });
      }
      options.onProviderSuccess?.({ id: config.id, model: selectedModel, capability: 'text' });
      return args;
    }
  }
  const text = extractText(data);
  if (!text) {
    const choice = data?.choices?.[0] || {};
    const message = choice.message || {};
    throw externalError(`External AI: empty response (finish_reason=${choice.finish_reason || 'unknown'}, message_keys=${Object.keys(message).join(',') || 'none'})`, { endpoint: url, data, parserStage: 'external_text_empty_response' });
  }
  options.onProviderSuccess?.({ id: config.id, model: selectedModel, capability: 'text' });
  return parseJsonish(text) ?? text;
}

export async function generateWithExternalAi(systemPrompt, userPrompt, model = '', options = {}) {
  let providers = await getExternalAiProviderChain('text');
  if (!providers.length) throw new Error('No external text AI provider is configured');
  const preferredModelOrder = Array.isArray(options?.preferredModelOrder)
    ? options.preferredModelOrder
      .map(value => String(value || '').trim())
      .filter(Boolean)
    : [];
  if (preferredModelOrder.length) {
    const rank = new Map(
      preferredModelOrder.map((value, index) => [value, index]),
    );
    providers = providers
      .map((provider, index) => ({ provider, index }))
      .sort((left, right) => (
        (rank.get(left.provider.textModel) ?? Number.MAX_SAFE_INTEGER)
        - (rank.get(right.provider.textModel) ?? Number.MAX_SAFE_INTEGER)
        || left.index - right.index
      ))
      .map(item => item.provider);
  }
  let lastError = null;
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    try {
      const validateResult = typeof options?.validateResult === 'function'
        ? options.validateResult
        : null;
      const attemptOptions = validateResult
        ? { ...options, onProviderSuccess: undefined }
        : options;
      const rawResult = await generateWithOneExternalProvider(
        provider,
        systemPrompt,
        userPrompt,
        model,
        attemptOptions,
        index,
      );
      if (!validateResult) return rawResult;
      let validatedResult;
      try {
        validatedResult = await validateResult(rawResult, provider);
      } catch (validationCause) {
        const validationError = new Error(
          validationCause?.message || 'External AI output validation failed',
          { cause: validationCause },
        );
        validationError.status = 502;
        validationError.code = 'EXTERNAL_AI_OUTPUT_VALIDATION_FAILED';
        throw validationError;
      }
      options.onProviderSuccess?.({
        id: provider.id,
        model: provider.textModel,
        capability: 'text',
      });
      return validatedResult;
    } catch (err) {
      lastError = err;
      if (!isRetryableExternalAiFailure(err) || index === providers.length - 1) throw err;
      console.warn('[external text] retryable provider failure; trying configured fallback', { provider: provider.id, status: err?.status || 0 });
    }
  }
  throw lastError || new Error('All external text AI providers failed');
}

function buildExternalImagePrompt(prompt, aspectRatio, referencePolicy = '') {
  const imagePrompt = `${prompt}${aspectRatio ? ` Aspect ratio: ${aspectRatio}.` : ''}`;
  const policy = String(referencePolicy || '').trim();
  const referenceRules = policy
    ? ` Reference image policy: ${policy}`
    : ' If a reference image is attached, use it as the exact product/design source.';
  return `Generate an image using the image_generation tool. Do not answer with instructions, code, SVG, Pillow scripts, or a text-only explanation. Return the generated PNG image only as a markdown data URI.${referenceRules} Do not redraw, reinterpret, replace, or invent the referenced artwork/design; place the exact referenced design into the requested scene/mockup. Image prompt: ${imagePrompt}`;
}

function referenceImageToMessageUrl(referenceImage) {
  if (!referenceImage) return '';
  if (typeof referenceImage === 'string') return /^https?:\/\//i.test(referenceImage) || /^data:image\//i.test(referenceImage) ? referenceImage : '';
  const url = referenceImage.url || referenceImage.image_url;
  if (typeof url === 'string' && (/^https?:\/\//i.test(url) || /^data:image\//i.test(url))) return url;
  if (referenceImage.base64 && referenceImage.mimeType) return `data:${referenceImage.mimeType};base64,${referenceImage.base64}`;
  if (referenceImage.base64 && referenceImage.mime_type) return `data:${referenceImage.mime_type};base64,${referenceImage.base64}`;
  return '';
}

function buildExternalImageMessageContent(prompt, aspectRatio, referenceImage, referencePolicy = '') {
  const text = buildExternalImagePrompt(prompt, aspectRatio, referencePolicy);
  const referenceUrl = referenceImageToMessageUrl(referenceImage);
  if (!referenceUrl) return text;
  return [
    { type: 'text', text: `${text} Use the attached reference image pixels as the product/design source. The generated image must preserve the exact referenced design identity and must not create a lookalike or alternate design.` },
    { type: 'image_url', image_url: { url: referenceUrl } },
  ];
}

function externalImageSlotTimeoutMs(config) {
  const configured = normalizedTimeoutMs(process.env.EXTERNAL_IMAGE_SLOT_TIMEOUT_MS || config.imageSlotTimeoutMs, 120_000, 300_000);
  return Math.min(externalImageTimeoutMs(config), configured);
}

async function runWithSlotSignal(parentSignal, timeoutMs, fn) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', abortFromParent);
  }
}

function normalizeImage(item) {
  const base64 = item?.b64_json || item?.base64 || item?.image?.base64;
  if (base64) return validatedBase64Image(base64, item.mimeType || item.mime_type || 'image/png');
  const dataUrl = item?.url || item?.image_url;
  const match = typeof dataUrl === 'string' ? dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/) : null;
  return match ? validatedBase64Image(match[2], match[1]) : null;
}

async function generateImageViaChatCompletions(config, url, { prompt, aspectRatio, count, model, referenceImage, referencePolicy, signal }) {
  const timeoutMs = externalImageTimeoutMs(config);
  const resolvedReferenceImage = await downloadReferenceImage(referenceImage, signal, timeoutMs);

  async function generateOne(numberedPrompt, index = 0, total = 1, requestSignal = signal) {
    const messageContent = buildExternalImageMessageContent(numberedPrompt, aspectRatio, resolvedReferenceImage || referenceImage, referencePolicy);
    let image = null;
    let lastError = null;
    for (let attempt = 0; attempt < IMAGE_MAX_ATTEMPTS; attempt++) {
      let res;
      let data;
      try {
        const selectedModel = model || config.imageModel;
        const stream = Boolean(config.imageStream);
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: authHeaders(config, stream ? { Accept: 'text/event-stream' } : {}),
          signal: requestSignal,
          body: JSON.stringify({
            model: selectedModel,
            stream,
            max_tokens: 2000,
            messages: [{ role: 'user', content: messageContent }],
          }),
        }, timeoutMs);
        if (stream) {
          if (!res.ok) {
            const raw = await res.text();
            data = { message: raw.slice(0, 500) };
          } else {
            const streamedText = await readOpenAiEventStream(res);
            data = { choices: [{ message: { content: streamedText } }] };
          }
        } else {
          data = await readJsonWithDiagnostics(res, url, 'external_chat_image_response_json_parse');
        }
      } catch (err) {
        lastError = isAbortLike(err) ? `External image AI timed out after ${Math.round(timeoutMs / 1000)}s` : (err?.message || 'External image AI request failed');
        if (shouldRetryImageAttempt({ err, reason: lastError }, attempt)) {
          await sleep(imageRetryDelayMs());
          continue;
        }
        throw externalError(lastError, { endpoint: url, parserStage: isAbortLike(err) ? 'external_chat_image_timeout' : 'external_chat_image_request_error' });
      }
      if (!res.ok) {
        lastError = data.error?.message || data.message || `External image AI ${res.status}`;
        if (shouldRetryImageAttempt({ status: res.status, reason: lastError }, attempt)) {
          await sleep(imageRetryDelayMs());
          continue;
        }
        throw externalError(lastError, { status: res.status, endpoint: url, data, parserStage: 'external_chat_image_http_error' });
      }
      const responseText = extractText(data);
      try {
        image = await normalizeExternalChatImage(config, responseText, requestSignal, timeoutMs);
      } catch (err) {
        lastError = err?.message || 'External image AI returned an invalid image URL';
        if (shouldRetryImageAttempt({ status: res.status, err, reason: lastError }, attempt)) {
          await sleep(imageRetryDelayMs());
          continue;
        }
        throw err;
      }
      if (image) break;
      lastError = 'External image AI: image_missing — no downloadable image link or data URI returned';
      if (shouldRetryImageAttempt({ status: res.status, reason: lastError }, attempt)) {
        await sleep(imageRetryDelayMs());
        continue;
      }
      throw externalError(lastError, { status: res.status, endpoint: url, data, parserStage: 'external_chat_image_data_uri_extract' });
    }
    if (!image) throw externalError(lastError || `External image AI: image ${index + 1}/${total} missing`, { endpoint: url, parserStage: 'external_chat_image_missing' });
    return image;
  }

  const prompts = Array.isArray(prompt)
    ? prompt.map(p => String(p || '').trim()).filter(Boolean).slice(0, count)
    : Array.from({ length: count }, (_, i) => count > 1
      ? `${prompt}\n\nCreate image ${i + 1} of ${count}. Make this composition visually distinct while preserving the product and constraints.`
      : prompt);
  const slotTimeoutMs = externalImageSlotTimeoutMs(config);
  const results = await Promise.allSettled(prompts.map((p, i) =>
    runWithSlotSignal(signal, slotTimeoutMs, slotSignal => generateOne(p, i, prompts.length, slotSignal))
  ));
  const images = [];
  let lastError = null;
  const failedIndexes = [];
  for (let idx = 0; idx < results.length; idx++) {
    const result = results[idx];
    if (result.status === 'fulfilled') images.push(result.value);
    else {
      failedIndexes.push(idx);
      lastError = result.reason?.message || String(result.reason || 'External image AI request failed');
    }
  }

  if (!images.length) throw new Error(lastError || 'External image AI: no base64 images returned');
  if (failedIndexes.length) {
    Object.defineProperty(images, 'failedIndexes', { value: failedIndexes, enumerable: false });
    Object.defineProperty(images, 'lastError', { value: lastError, enumerable: false });
  }
  return images;
}

async function generateViaOpenAiImageEndpoint(config, { prompt, aspectRatio, count, model, referenceImage, referencePolicy, signal }) {
  const resolvedReferenceImage = await downloadReferenceImage(referenceImage, signal, externalImageTimeoutMs(config));
  const generationPath = config.imagePath || '/v1/images/generations';
  const editPath = /\/images\/generations\/?$/i.test(generationPath)
    ? generationPath.replace(/\/images\/generations\/?$/i, '/images/edits')
    : '/v1/images/edits';
  const jsonImageAdapter = config.imageAdapter === 'openai_images_json';
  const url = buildProviderUrl(config.baseUrl, jsonImageAdapter || !resolvedReferenceImage ? generationPath : editPath);
  async function generateOne(singlePrompt, requestSignal = signal) {
    const imagePrompt = `${singlePrompt}${aspectRatio ? ` AR ${aspectRatio}` : ''}${referencePolicy ? ` Reference policy: ${referencePolicy}` : ''}`;
    let body;
    let headers;
    if (jsonImageAdapter) {
      const input = {
        model: model || config.imageModel,
        prompt: imagePrompt,
        n: 1,
        size: config.imageSize || '1024x1024',
        // OmniRoute's OpenAI-compatible Images API uses b64_json. The app's
        // older base64_json setting remains an internal normalization label.
        response_format: config.imageResponseFormat === 'base64_json' ? 'b64_json' : (config.imageResponseFormat || 'b64_json'),
      };
      if (aspectRatio) input.aspect_ratio = aspectRatio;
      if (config.imageGenerationSize) input.image_size = config.imageGenerationSize;
      if (resolvedReferenceImage?.base64 && resolvedReferenceImage?.mimeType) {
        input[config.imageReferenceField || 'input_image'] = `data:${resolvedReferenceImage.mimeType};base64,${resolvedReferenceImage.base64}`;
      }
      body = JSON.stringify(input);
      headers = authHeaders(config);
    } else if (resolvedReferenceImage?.base64 && resolvedReferenceImage?.mimeType) {
      body = new FormData();
      body.append('model', model || config.imageModel);
      body.append('prompt', imagePrompt);
      body.append('n', '1');
      body.append('response_format', 'b64_json');
      body.append('image', new Blob([Buffer.from(resolvedReferenceImage.base64, 'base64')], { type: resolvedReferenceImage.mimeType }), `reference.${resolvedReferenceImage.mimeType === 'image/jpeg' ? 'jpg' : resolvedReferenceImage.mimeType.split('/')[1] || 'png'}`);
      headers = { Authorization: `Bearer ${config.apiKey}` };
    } else {
      body = JSON.stringify({
        model: model || config.imageModel,
        prompt: imagePrompt,
        n: 1,
        response_format: 'b64_json',
      });
      headers = authHeaders(config);
    }
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      signal: requestSignal,
      body,
    }, externalImageTimeoutMs(config));
    const data = await readJsonWithDiagnostics(res, url, 'external_image_response_json_parse');
    if (!res.ok) throw externalError(data.error?.message || data.message || `External image AI ${res.status}`, { status: res.status, endpoint: url, data, parserStage: 'external_image_http_error' });
    const rawImages = Array.isArray(data.data) ? data.data : Array.isArray(data.images) ? data.images : [];
    const images = (await Promise.all(rawImages.map(item => normalizeImageOutput(normalizeImage(item), config)))).filter(Boolean);
    if (!images.length) throw externalError('External image AI: no base64 images returned', { status: res.status, endpoint: url, data, parserStage: 'external_image_normalize' });
    return images[0];
  }
  const prompts = Array.isArray(prompt)
    ? prompt.map(p => String(p || '').trim()).filter(Boolean).slice(0, count)
    : Array.from({ length: count }, (_, i) => count > 1 ? `${prompt}\n\nCreate image ${i + 1} of ${count}.` : prompt);
  const slotTimeoutMs = externalImageSlotTimeoutMs(config);
  const results = await Promise.allSettled(prompts.map(prompt =>
    runWithSlotSignal(signal, slotTimeoutMs, slotSignal => generateOne(prompt, slotSignal))
  ));
  const images = [];
  let lastError = null;
  let lastFailure = null;
  const failedIndexes = [];
  for (let idx = 0; idx < results.length; idx++) {
    const result = results[idx];
    if (result.status === 'fulfilled') images.push(result.value);
    else {
      failedIndexes.push(idx);
      lastFailure = result.reason;
      lastError = result.reason?.message || String(result.reason || 'External image AI request failed');
    }
  }
  if (!images.length) throw lastFailure || externalError(lastError || 'External image AI: no base64 images returned', { endpoint: url, parserStage: 'external_image_parallel' });
  if (failedIndexes.length) {
    Object.defineProperty(images, 'failedIndexes', { value: failedIndexes, enumerable: false });
    Object.defineProperty(images, 'lastError', { value: lastError, enumerable: false });
  }
  return images;
}

function normalizeOpenAiResponsesImage(data) {
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (item?.type !== 'image_generation_call' || typeof item.result !== 'string') continue;
    const match = item.result.match(/^data:(image\/[^;]+);base64,(.+)$/s);
    const mimeType = match?.[1] || 'image/png';
    const base64 = match?.[2] || item.result;
    try {
      return validatedBase64Image(base64, mimeType);
    } catch {
      continue;
    }
  }
  return null;
}

async function generateViaOpenAiResponses(config, { prompt, aspectRatio, count, model, referenceImage, referencePolicy, signal }) {
  const url = buildProviderUrl(config.baseUrl, config.imagePath || '/v1/responses');
  const resolvedReferenceImage = await downloadReferenceImage(referenceImage, signal, externalImageTimeoutMs(config));
  async function generateOne(singlePrompt, requestSignal = signal) {
    const imagePrompt = `${singlePrompt}${aspectRatio ? ` AR ${aspectRatio}` : ''}${referencePolicy ? ` Reference policy: ${referencePolicy}` : ''}`;
    const content = [{ type: 'input_text', text: imagePrompt }];
    if (resolvedReferenceImage?.base64 && resolvedReferenceImage?.mimeType) {
      content.push({
        type: 'input_image',
        image_url: `data:${resolvedReferenceImage.mimeType};base64,${resolvedReferenceImage.base64}`,
      });
    }
    let lastError = null;
    for (let attempt = 0; attempt < IMAGE_MAX_ATTEMPTS; attempt++) {
      let res;
      let data;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: authHeaders(config),
          signal: requestSignal,
          body: JSON.stringify({
            model: model || config.imageModel,
            instructions: 'You must call the image_generation tool exactly once to fulfill the user request. Do not add narration.',
            input: [{ role: 'user', content }],
            tools: [{ type: 'image_generation', output_format: 'png' }],
            stream: false,
            store: false,
          }),
        }, externalImageTimeoutMs(config));
        data = await readJsonWithDiagnostics(res, url, 'external_responses_image_json_parse');
      } catch (err) {
        lastError = isAbortLike(err)
          ? `External Responses image AI timed out after ${Math.round(externalImageTimeoutMs(config) / 1000)}s`
          : (err?.message || 'External Responses image AI request failed');
        if (shouldRetryImageAttempt({ err, reason: lastError }, attempt)) {
          await sleep(imageRetryDelayMs());
          continue;
        }
        throw externalError(lastError, { endpoint: url, parserStage: isAbortLike(err) ? 'external_responses_image_timeout' : 'external_responses_image_request_error' });
      }
      if (!res.ok) {
        lastError = data.error?.message || data.message || `External Responses image AI ${res.status}`;
        if (shouldRetryImageAttempt({ status: res.status, reason: lastError }, attempt)) {
          await sleep(imageRetryDelayMs());
          continue;
        }
        throw externalError(lastError, { status: res.status, endpoint: url, data, parserStage: 'external_responses_image_http_error' });
      }
      const image = normalizeOpenAiResponsesImage(data);
      if (image) return image;
      lastError = 'External Responses image AI returned no valid image_generation_call result';
      if (shouldRetryImageAttempt({ status: res.status, reason: lastError }, attempt)) {
        await sleep(imageRetryDelayMs());
        continue;
      }
      throw externalError(lastError, { status: res.status, endpoint: url, data, parserStage: 'external_responses_image_normalize' });
    }
    throw externalError(lastError || 'External Responses image AI request failed', { endpoint: url, parserStage: 'external_responses_image_retry_exhausted' });
  }
  const prompts = Array.isArray(prompt)
    ? prompt.map(item => String(item || '').trim()).filter(Boolean).slice(0, count)
    : Array.from({ length: count }, (_, index) => count > 1 ? `${prompt}\n\nCreate image ${index + 1} of ${count}.` : prompt);
  const results = await Promise.allSettled(prompts.map(item =>
    runWithSlotSignal(signal, externalImageSlotTimeoutMs(config), slotSignal => generateOne(item, slotSignal))
  ));
  const images = [];
  const failedIndexes = [];
  let lastError = null;
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === 'fulfilled') images.push(result.value);
    else {
      failedIndexes.push(index);
      lastError = result.reason?.message || String(result.reason || 'External Responses image AI request failed');
    }
  }
  if (!images.length) throw externalError(lastError || 'External Responses image AI returned no images', { endpoint: url, parserStage: 'external_responses_image_parallel' });
  if (failedIndexes.length) {
    Object.defineProperty(images, 'failedIndexes', { value: failedIndexes, enumerable: false });
    Object.defineProperty(images, 'lastError', { value: lastError, enumerable: false });
  }
  return images;
}

async function generateImagesWithOneExternalProvider(config, { prompt, prompts, aspectRatio = '1:1', count, model, referenceImage, referencePolicy, signal }, useRequestedModel = false) {
  config = requireExternalImageConfig(config);
  if (referenceImage && config.imageReferenceMode === 'unsupported') {
    throw externalError('The configured image provider does not support preserving an external reference image. Re-plan with listing media or a reference-free generated frame.', {
      parserStage: 'external_image_reference_capability',
    });
  }
  const imageConfig = {
    ...config,
    baseUrl: config.imageBaseUrl || config.baseUrl,
    apiKey: config.imageApiKey || config.apiKey,
  };
  const promptInput = Array.isArray(prompts) && prompts.length ? prompts : prompt;
  const requestedCount = Array.isArray(promptInput) ? Math.min(promptInput.length, Math.max(parseInt(count, 10) || promptInput.length, 1)) : Math.max(parseInt(count, 10) || 1, 1);
  const requestedModel = String(model || '').trim();
  const selectedModel = useRequestedModel && requestedModel
    ? requestedModel
    : imageConfig.imageModel;
  let images;
  if (imageConfig.imageAdapter === 'openai_images' || imageConfig.imageAdapter === 'openai_images_json') {
    images = await generateViaOpenAiImageEndpoint(imageConfig, { prompt: promptInput, aspectRatio, count: requestedCount, model: selectedModel, referenceImage, referencePolicy, signal });
  } else if (imageConfig.imageAdapter === 'openai_responses') {
    images = await generateViaOpenAiResponses(imageConfig, { prompt: promptInput, aspectRatio, count: requestedCount, model: selectedModel, referenceImage, referencePolicy, signal });
  } else if (imageConfig.imageAdapter === 'chat_data_uri') {
    const primaryUrl = buildProviderUrl(imageConfig.baseUrl, imageConfig.imagePath);
    images = await generateImageViaChatCompletions(imageConfig, primaryUrl, { prompt: promptInput, aspectRatio, count: requestedCount, model: selectedModel, referenceImage, referencePolicy, signal });
  } else {
    throw new Error(`Unsupported EXTERNAL_IMAGE_ADAPTER: ${imageConfig.imageAdapter}`);
  }
  const enriched = images.map(image => {
    const output = { ...image };
    // Keep provider identity available to server orchestration without changing
    // the long-standing public image object contract.
    Object.defineProperties(output, {
      external_provider_id: { value: config.id, enumerable: false },
      external_provider_endpoint: { value: buildProviderUrl(imageConfig.baseUrl, imageConfig.imagePath), enumerable: false },
      model: { value: selectedModel, enumerable: false },
    });
    return output;
  });
  for (const key of ['failedIndexes', 'lastError']) {
    if (images[key] !== undefined) Object.defineProperty(enriched, key, { value: images[key], enumerable: false });
  }
  return enriched;
}

export async function generateImagesWithExternalAi(args = {}) {
  const providers = await getExternalAiProviderChain('image');
  if (!providers.length) {
    const legacy = await getExternalAiConfigAsync();
    if (legacy.baseUrl && legacy.apiKey) requireExternalImageConfig(legacy);
    throw new Error('No external image AI provider is configured');
  }
  const requiresReference = Boolean(args.referenceImage);
  const requestedModel = String(args.model || '').trim();
  const capabilityCandidates = providers
    .map((provider, originalIndex) => ({ provider, originalIndex }))
    .filter(({ provider }) => !requiresReference || provider.imageReferenceMode !== 'unsupported');
  const exactModelConfigured = requestedModel
    ? providers.some(provider => provider.imageModel === requestedModel)
    : false;
  const exactCapabilityCandidates = requestedModel
    ? capabilityCandidates.filter(({ provider }) => provider.imageModel === requestedModel)
    : [];
  const candidates = (exactCapabilityCandidates.length ? exactCapabilityCandidates : capabilityCandidates)
    .map(candidate => ({
      ...candidate,
      useRequestedModel: exactCapabilityCandidates.length > 0
        || (!exactModelConfigured && candidate.originalIndex === 0),
    }));
  if (!candidates.length) {
    throw externalError('No configured external image provider supports the required reference image.', {
      parserStage: 'external_image_reference_provider_selection',
    });
  }
  let lastError = null;
  const attempts = [];
  for (let index = 0; index < candidates.length; index++) {
    const { provider, useRequestedModel } = candidates[index];
    try {
      const images = await generateImagesWithOneExternalProvider(provider, args, useRequestedModel);
      Object.defineProperty(images, 'providerAttempts', { value: attempts.concat([{ id: provider.id, model: provider.imageModel, success: true }]), enumerable: false });
      return images;
    } catch (err) {
      lastError = err;
      attempts.push({ id: provider.id, success: false, retryable: isRetryableExternalAiFailure(err) });
      if (!isRetryableExternalAiFailure(err) || index === candidates.length - 1) throw err;
      console.warn('[external image] retryable provider failure; trying configured fallback', { provider: provider.id, status: err?.status || 0 });
    }
  }
  throw lastError || new Error('All external image AI providers failed');
}
