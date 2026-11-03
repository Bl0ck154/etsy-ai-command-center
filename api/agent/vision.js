// api/agent/vision.js — AI Vision and Image Generation helpers
import { generateWithExternalAi, hasExternalAiConfigAsync, getExternalAiRuntimeConfig, buildProviderUrl } from '../_external-ai.js';
import { MODEL } from '../_config.js';
import { clampEtsyTitle } from '../_listing-body.js';
import { getShopId } from '../_etsy.js';
import { hasCyrillic, listingContentHasCyrillic, fallbackEnglishDuplicateTitle, fallbackEnglishDuplicateDescription, englishFileUploadQuestions, latestUserText } from './listing-language.js';

const SHOP_ID = getShopId();

export const LISTING_IMAGE_VISION_MAX_IMAGES = 10;
export const LISTING_IMAGE_VISION_MAX_BYTES = 8 * 1024 * 1024;
export const LISTING_IMAGE_VISION_TIMEOUT_MS = 20_000;
export const LISTING_IMAGE_VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function normalizeImageRef(img = {}, idx = 0) {
  const parsedRank = parseInt(img.rank, 10);
  return {
    listing_image_id: img.listing_image_id || img.id || null,
    url: img.url || img.url_570xN || img.url_fullxfull || img.url_170x135 || img.image_url || '',
    rank: Number.isFinite(parsedRank) ? parsedRank : idx + 1,
  };
}

export function listingAgentUrl(listing = {}) {
  if (!listing.listing_id) return listing.etsy_url || listing.url || null;
  const state = String(listing.state || listing.listing_state || '').toLowerCase();
  if (state && state !== 'active') return `https://www.etsy.com/your/shops/me/listing-editor/edit/${listing.listing_id}#item-details`;
  return listing.etsy_url || listing.url || `https://www.etsy.com/listing/${listing.listing_id}`;
}

export function listingAgentImageUrl(listing = {}) {
  return listing.image_url
    || listing.listing_image_url
    || listing.source_image_url
    || listing.MainImage?.url_570xN
    || listing.MainImage?.url_170x135
    || listing.images?.[0]?.url_570xN
    || listing.images?.[0]?.url_170x135
    || listing.images?.[0]?.url_fullxfull
    || listing.images?.[0]?.url
    || null;
}

export function selectedImagesFromInput(input = {}, currentImages = []) {
  const selected = [];
  const addSelected = (ref) => {
    const normalized = normalizeImageRef(ref);
    const current = currentImages.find(img => (
      (normalized.listing_image_id && String(img.listing_image_id) === String(normalized.listing_image_id))
      || (!normalized.listing_image_id && normalized.rank && img.rank === normalized.rank)
    ));
    const next = current ? { ...normalized, ...current } : normalized;
    if (!next.url && !next.listing_image_id) return;
    if (!selected.some(img => (
      (next.listing_image_id && String(img.listing_image_id) === String(next.listing_image_id))
      || (!next.listing_image_id && next.rank && img.rank === next.rank)
    ))) selected.push(next);
  };
  if (Array.isArray(input.selected_images)) input.selected_images.forEach(addSelected);
  const selectedIds = new Set((input.selected_image_ids || []).map(id => String(id)));
  const selectedRanks = new Set((input.selected_image_ranks || []).map(rank => parseInt(rank, 10)).filter(Number.isFinite));
  for (const img of currentImages) {
    if ((img.listing_image_id && selectedIds.has(String(img.listing_image_id))) || selectedRanks.has(parseInt(img.rank, 10))) {
      addSelected(img);
    }
  }
  return selected;
}

export function stripEmbeddedImagePayloads(value = '') {
  return String(value || '')
    .replace(/!\[[^\]\n]*\]\(\s*data:image\/[^)\s]+[^)]*\)/gi, '[image omitted]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]{80,}/gi, '[image data omitted]')
    .replace(/!\[[^\]\n]*\]\(\s*\[image data omitted\]\s*\)?/gi, '[image omitted]')
    .replace(/!\[[^\]\n]*\]\(\s*\[image omitted\]\s*\)?/gi, '[image omitted]')
    .replace(/!\[[^\]\n]*\]\(\s*blob:[^)]+\)/gi, '[image omitted]')
    .replace(/!\[[^\]\n]*\]\(\s*https?:\/\/[^)]+\)/gi, '[image omitted]')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function sanitizeImagePromptText(value = '', max = 4000) {
  return stripEmbeddedImagePayloads(value)
    .replace(/\[image omitted\](?:\s*\[image omitted\])+/gi, '[image omitted]')
    .replace(/\[image data omitted\]/gi, '[image omitted]')
    .slice(0, max)
    .trim();
}

export function sanitizeVisionText(value = '', max = 600) {
  const text = sanitizeImagePromptText(value, max)
    .replace(/\[image omitted\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return /[a-zа-яієїґ]/i.test(text) ? text : '';
}

export function normalizeListingImageProposal(input = {}) {
  const validModes = ['add', 'replace_cover', 'replace_all', 'delete_selected', 'replace_selected'];
  const mode = validModes.includes(input.mode) ? input.mode : 'add';
  const aspectRatio = String(input.aspect_ratio || input.aspectRatio || '1:1').trim() || '1:1';
  const currentImages = Array.isArray(input.current_images) ? input.current_images.slice(0, 20).map(normalizeImageRef).filter(img => img.url || img.listing_image_id) : [];
  const selectedImages = selectedImagesFromInput(input, currentImages);
  const hasRequestedCount = input.count !== undefined && input.count !== null && input.count !== '';
  const requestedCount = parseInt(input.count, 10);
  const defaultCount = mode === 'delete_selected'
    ? 0
    : mode === 'replace_cover'
      ? 1
      : mode === 'replace_selected' && selectedImages.length
        ? selectedImages.length
        : mode === 'replace_all' && currentImages.length
          ? currentImages.length
          : 4;
  const count = mode === 'delete_selected'
    ? 0
    : mode === 'replace_selected' && selectedImages.length
      ? selectedImages.length
      : Math.max(1, Math.min(10, hasRequestedCount && Number.isFinite(requestedCount) ? requestedCount : defaultCount));
  const rawSlots = Array.isArray(input.slots) ? input.slots : [];
  const slots = mode === 'delete_selected' ? [] : Array.from({ length: count }, (_, idx) => {
    const slot = rawSlots[idx] || {};
    const coverHook = String(slot.cover_hook || '').replace(/\s+/g, ' ').trim();
    const hookWordCount = coverHook ? coverHook.split(' ').filter(Boolean).length : 0;
    return {
      purpose: String(slot.purpose || `Listing image ${idx + 1}`).replace(/\s+/g, ' ').trim().slice(0, 160),
      visual_prompt: sanitizeImagePromptText(slot.visual_prompt || input.prompt || '', 4000),
      ...(hookWordCount >= 2 && hookWordCount <= 5 ? { cover_hook: coverHook } : {}),
      alt_text: sanitizeImagePromptText(slot.alt_text || '', 250),
    };
  });
  const generatedImages = Array.isArray(input.generated_images) ? input.generated_images.map((img, idx) => ({
    id: img.id || img.image_id || '',
    mimeType: img.mimeType || img.mime_type || 'image/jpeg',
    rank: img.rank || idx + 1,
    ...(slots[idx] ? { slot: slots[idx] } : {}),
  })).filter(img => img.id) : [];
  return {
      listing_id: input.listing_id,
      listing_title: input.listing_title || input.title || `Listing ${input.listing_id || ''}`.trim(),
      prompt: sanitizeImagePromptText(input.prompt || '', 4000),
    mode,
    count,
    aspect_ratio: aspectRatio,
    current_images: currentImages,
    selected_images: selectedImages,
    selected_image_ids: Array.isArray(input.selected_image_ids) ? input.selected_image_ids.map(String) : selectedImages.map(img => img.listing_image_id).filter(Boolean).map(String),
    selected_image_ranks: Array.isArray(input.selected_image_ranks) ? input.selected_image_ranks.map(rank => parseInt(rank, 10)).filter(Number.isFinite) : selectedImages.map(img => img.rank).filter(Number.isFinite),
    generated_images: generatedImages,
    slots,
    uploaded_generated_ids: Array.isArray(input.uploaded_generated_ids) ? input.uploaded_generated_ids.map(String) : [],
    uploaded_listing_image_ids: Array.isArray(input.uploaded_listing_image_ids) ? input.uploaded_listing_image_ids.map(String) : [],
    target_old_image_ids: Array.isArray(input.target_old_image_ids) ? input.target_old_image_ids.map(String) : [],
    deleted_old_image_ids: Array.isArray(input.deleted_old_image_ids) ? input.deleted_old_image_ids.map(String) : [],
    reference_image: input.reference_image || input.referenceImage || null,
    status: input.status || (generatedImages.length ? 'generated' : 'pending'),
    ...(input.ui_copy && typeof input.ui_copy === 'object' ? { ui_copy: input.ui_copy } : {}),
    ...(input.generated_at ? { generated_at: input.generated_at } : {}),
    ...(input.visual_analysis ? { visual_analysis: input.visual_analysis } : {}),
    summary: input.summary || (mode === 'replace_all' ? 'Generate and replace all listing images' : mode === 'replace_cover' ? 'Generate and replace cover image' : mode === 'replace_selected' ? 'Generate and replace selected listing images' : mode === 'delete_selected' ? 'Delete selected listing images' : 'Generate and add listing images'),
  };
}

export function referenceImageForListingPlan(plan = {}, imageIndex = 0) {
  if (plan.reference_image || plan.referenceImage) return plan.reference_image || plan.referenceImage;
  const selected = plan.selected_images?.[imageIndex] || plan.selected_images?.[0];
  const current = plan.current_images?.[imageIndex] || plan.current_images?.[0];
  const ref = selected || current;
  return ref?.url ? { url: ref.url } : null;
}

export function extractRequestedImageRanks(text = '') {
  const raw = String(text).toLowerCase();
  const ranks = new Set();
  if (/(cover|main|thumbnail|головн|обклад)/i.test(raw)) ranks.add(1);
  const hasImageWord = /(image|images|photo|photos|picture|pictures|картин|фото|зображен)/i.test(raw);
  if (hasImageWord) {
    for (const match of raw.matchAll(/(\d{1,2}(?:\s*(?:,|and|і|та)\s*\d{1,2})+)\s*(?:images?|photos?|pictures?|картин(?:ку|ки|ок|а|и)?|фото|зображенн(?:я|і))/gi)) {
      for (const rank of match[1].match(/\d{1,2}/g) || []) ranks.add(Number(rank));
    }
    for (const match of raw.matchAll(/(?:image|photo|picture|картин(?:ку|ки|ок|а|и)?|фото|зображенн(?:я|і))\s*(?:#|№|no\.?\s*)?(\d{1,2})/gi)) ranks.add(Number(match[1]));
    for (const match of raw.matchAll(/(\d{1,2})(?:st|nd|rd|th|[- ]?(?:е|є|й|я|го|та))?\s*(?:image|photo|picture|картин(?:ку|ки|ок|а|и)?|фото|зображенн(?:я|і))/gi)) ranks.add(Number(match[1]));
    const ordinalWords = [
      [1, /(?:first|перш\p{L}*|перв\p{L}*)/iu],
      [2, /(?:second|друг\p{L}*|втор\p{L}*)/iu],
      [3, /(?:third|трет\p{L}*|треть\p{L}*)/iu],
      [4, /(?:fourth|четверт\p{L}*)/iu],
      [5, /(?:fifth|п['’]?ят\p{L}*|пят\p{L}*)/iu],
      [6, /(?:sixth|шост\p{L}*|шест\p{L}*)/iu],
      [7, /(?:seventh|сьом\p{L}*|седьм\p{L}*)/iu],
      [8, /(?:eighth|восьм\p{L}*)/iu],
      [9, /(?:ninth|дев['’]?ят\p{L}*|девят\p{L}*)/iu],
      [10, /(?:tenth|десят\p{L}*)/iu],
    ];
    const imageWordRe = /(?:images?|photos?|pictures?|картин(?:ку|ки|ок|а|и)?|фото|зображенн(?:я|і))/iu;
    const words = raw.split(/[^\p{L}\p{N}'’]+/u).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (!imageWordRe.test(words[i])) continue;
      const nearby = [words[i - 2], words[i - 1], words[i + 1], words[i + 2]].filter(Boolean).join(' ');
      for (const [rank, re] of ordinalWords) {
        if (re.test(nearby)) ranks.add(rank);
      }
    }
  }
  return [...ranks].filter(rank => rank >= 1 && rank <= 20).sort((a, b) => a - b);
}

export function isTrustedListingImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (
        host === 'etsy.com'
        || host.endsWith('.etsy.com')
        || host === 'etsystatic.com'
        || host.endsWith('.etsystatic.com')
      );
  } catch {
    return false;
  }
}

export function validImageMagic(bytes, mimeType) {
  if (!bytes?.length) return false;
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

export async function fetchListingImageForVision(image = {}) {
  const url = String(image.url || image.url_fullxfull || image.url_570xN || '').trim();
  if (!isTrustedListingImageUrl(url)) throw new Error(`Untrusted listing image URL for rank ${image.rank || '?'}; only Etsy HTTPS image URLs can be analyzed.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LISTING_IMAGE_VISION_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to fetch listing image rank ${image.rank || '?'}: HTTP ${res.status}`);
    if (res.url && !isTrustedListingImageUrl(res.url)) throw new Error(`Listing image rank ${image.rank || '?'} redirected to an untrusted host.`);
    const declaredLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > LISTING_IMAGE_VISION_MAX_BYTES) throw new Error(`Listing image rank ${image.rank || '?'} exceeds the ${Math.round(LISTING_IMAGE_VISION_MAX_BYTES / 1024 / 1024)}MB analysis limit.`);
    const mimeType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
    if (!LISTING_IMAGE_VISION_MIME_TYPES.has(mimeType)) throw new Error(`Listing image rank ${image.rank || '?'} returned unsupported Content-Type: ${mimeType || 'missing'}.`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > LISTING_IMAGE_VISION_MAX_BYTES) throw new Error(`Listing image rank ${image.rank || '?'} exceeds the analysis size limit.`);
    if (!validImageMagic(bytes, mimeType)) throw new Error(`Listing image rank ${image.rank || '?'} did not contain a valid ${mimeType} payload.`);
    return { ...image, url, mimeType, base64: bytes.toString('base64'), bytes: bytes.length };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Timed out fetching listing image rank ${image.rank || '?'} for analysis.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function parseVisionJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  if (!cleaned) return null;
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return { summary: cleaned };
}

export function normalizeVisionAnalysisPayload(payload = {}, fallback = {}) {
  const sourceImages = Array.isArray(fallback.images) ? fallback.images : [];
  const byRank = new Map(sourceImages.map(img => [Number(img.rank), img]));
  const rawImages = Array.isArray(payload.images) ? payload.images : [];
  const images = rawImages.map((item, idx) => {
    const rank = Number(item.rank || item.image_rank || sourceImages[idx]?.rank || idx + 1);
    const original = byRank.get(rank) || sourceImages[idx] || {};
    return {
      rank,
      listing_image_id: original.listing_image_id || item.listing_image_id || null,
      url: original.url || item.url || '',
      summary: String(item.summary || item.description || item.visual_summary || '').slice(0, 1000),
      strengths: Array.isArray(item.strengths) ? item.strengths.map(v => String(v).slice(0, 240)).slice(0, 8) : [],
      issues: Array.isArray(item.issues) ? item.issues.map(v => String(v).slice(0, 240)).slice(0, 8) : [],
      suggestions: Array.isArray(item.suggestions) ? item.suggestions.map(v => String(v).slice(0, 240)).slice(0, 8) : [],
      quality_score: Number.isFinite(Number(item.quality_score)) ? Math.max(0, Math.min(100, Number(item.quality_score))) : null,
      role: String(item.role || item.recommended_role || '').slice(0, 120),
    };
  });
  if (!images.length && payload.summary) {
    images.push(...sourceImages.map(img => ({
      rank: img.rank,
      listing_image_id: img.listing_image_id || null,
      url: img.url,
      summary: String(payload.summary || '').slice(0, 1000),
      strengths: [],
      issues: [],
      suggestions: [],
      quality_score: null,
      role: '',
    })));
  }
  return {
    provider: fallback.provider || payload.provider || '',
    listing_id: fallback.listing_id || payload.listing_id || null,
    listing_title: fallback.listing_title || payload.listing_title || '',
    image_count: sourceImages.length,
    analyzed_count: images.length,
    images,
    cover_feedback: String(payload.cover_feedback || '').slice(0, 1000),
    missing_shots: Array.isArray(payload.missing_shots) ? payload.missing_shots.map(v => String(v).slice(0, 240)).slice(0, 12) : [],
    recommended_new_slots: Array.isArray(payload.recommended_new_slots) ? payload.recommended_new_slots.map(v => String(v).slice(0, 240)).slice(0, 12) : [],
    overall_summary: String(payload.overall_summary || payload.summary || '').slice(0, 1200),
  };
}

export function buildListingVisionPrompt({ listing = {}, images = [], question = '' } = {}) {
  return [
    'Analyze the actual pixels of these current Etsy listing images. This is read-only visual analysis; do not propose or perform any Etsy write action.',
    'Return ONLY valid JSON with this exact shape:',
    '{"overall_summary":"...","cover_feedback":"...","missing_shots":["..."],"recommended_new_slots":["..."],"images":[{"rank":1,"summary":"...","strengths":["..."],"issues":["..."],"suggestions":["..."],"quality_score":0,"role":"cover/support/detail/etc"}]}',
    'Focus on what is visible: product/result clarity, composition, text overlays, trust signals, buyer objections, Etsy cover suitability, and what additional listing images would improve conversion.',
    'Do not invent facts that are not visible. If text is unreadable, say so. If an image appears instructional or overloaded, say so.',
    `Listing ID: ${listing.listing_id || ''}`,
    `Listing title: ${listing.title || listing.listing_title || ''}`,
    listing.description ? `Listing description excerpt: ${String(listing.description).slice(0, 1200)}` : '',
    question ? `Shop owner's question: ${question}` : '',
    `Images supplied by rank: ${images.map(img => img.rank).join(', ')}`,
  ].filter(Boolean).join('\n');
}

export async function callExternalVision({ prompt, images }) {
  const config = await getExternalAiRuntimeConfig();
  const model = config.visionModel || config.textModel || MODEL.external;
  if (!model) throw new Error('External AI vision model is not configured (set EXTERNAL_VISION_MODEL or EXTERNAL_AI_MODEL).');
  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    content.push({ type: 'text', text: `Image rank ${img.rank}${img.listing_image_id ? `, Etsy listing_image_id ${img.listing_image_id}` : ''}:` });
    content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
  }
  const res = await fetch(buildProviderUrl(config.baseUrl, config.textPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.message || `External vision ${res.status}`);
  const contentText = data.choices?.[0]?.message?.content || data.output_text || data.text || '';
  const text = Array.isArray(contentText) ? contentText.map(part => part?.text || part?.content || '').join('') : contentText;
  if (!text) throw new Error('External vision returned an empty response.');
  return parseVisionJson(text);
}

export async function callGeminiVision({ prompt, images }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const parts = [{ text: prompt }];
  for (const img of images) {
    parts.push({ text: `Image rank ${img.rank}${img.listing_image_id ? `, Etsy listing_image_id ${img.listing_image_id}` : ''}:` });
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL.gemini}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: 4096, responseMimeType: 'application/json' } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Gemini vision ${res.status}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
  if (!text) throw new Error('Gemini vision returned an empty response.');
  return parseVisionJson(text);
}

export async function callClaudeVision({ prompt, images }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    content.push({ type: 'text', text: `Image rank ${img.rank}${img.listing_image_id ? `, Etsy listing_image_id ${img.listing_image_id}` : ''}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64 } });
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL.claudeFast, max_tokens: 4096, messages: [{ role: 'user', content }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Claude vision ${res.status}`);
  const text = (data.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('');
  if (!text) throw new Error('Claude vision returned an empty response.');
  return parseVisionJson(text);
}

async function loadListingDetailsForVision(listingId, context) {
  const { executeTool } = await import('./tools-dispatch.js');
  return executeTool('get_listing_details', { listing_id: listingId }, context);
}

export async function analyzeListingImages(input = {}, context = {}) {
  const listingId = Number(input.listing_id || context.last_target_listing?.listing_id);
  if (!Number.isFinite(listingId) || listingId <= 0) return { available: false, error: 'listing_id is required for listing image analysis.' };

  const cached = context.listing_details?.[listingId] || context.listing_details?.[String(listingId)] || null;
  const listing = cached || await loadListingDetailsForVision(listingId, context);
  if (listing?.error) return { available: false, listing_id: listingId, error: listing.error };
  let images = (Array.isArray(listing.images) ? listing.images : []).map(normalizeImageRef).filter(img => img.url);
  const requestedRanks = new Set((input.image_ranks || input.selected_image_ranks || []).map(rank => Number(rank)).filter(Number.isFinite));
  if (requestedRanks.size) images = images.filter(img => requestedRanks.has(Number(img.rank)));
  images = images.slice(0, LISTING_IMAGE_VISION_MAX_IMAGES);
  if (!images.length) return { available: false, listing_id: listingId, listing_title: listing.title || '', error: 'No listing images are available to analyze for the requested ranks.' };

  const attempts = [];
  const hasExternal = await hasExternalAiConfigAsync().catch(() => false);
  if (hasExternal) attempts.push(['external', callExternalVision]);
  if (process.env.GEMINI_API_KEY) attempts.push(['gemini', callGeminiVision]);
  if (process.env.ANTHROPIC_API_KEY) attempts.push(['claude', callClaudeVision]);
  if (!attempts.length) return { available: false, listing_id: listingId, listing_title: listing.title || '', image_count: images.length, error: 'No vision-capable AI provider is configured. Configure GEMINI_API_KEY, ANTHROPIC_API_KEY, or an OpenAI-compatible external model that supports image input.', read_only: true, writes_performed: false };

  let downloaded;
  try {
    downloaded = await Promise.all(images.map(fetchListingImageForVision));
  } catch (err) {
    return { available: false, listing_id: listingId, listing_title: listing.title || '', image_count: images.length, error: err.message };
  }

  const prompt = buildListingVisionPrompt({ listing, images: downloaded, question: input.question || latestUserText(context.messages || []) });
  const errors = [];
  for (const [provider, fn] of attempts) {
    try {
      const payload = await fn({ prompt, images: downloaded });
      return {
        available: true,
        ...normalizeVisionAnalysisPayload(payload, { provider, listing_id: listingId, listing_title: listing.title || listing.listing_title || '', images: downloaded }),
        read_only: true,
        writes_performed: false,
      };
    } catch (err) {
      errors.push(`${provider}: ${err.message}`);
    }
  }
  return { available: false, listing_id: listingId, listing_title: listing.title || '', image_count: images.length, error: `Vision analysis failed: ${errors.join(' | ')}`, read_only: true, writes_performed: false };
}

export function summarizeVisionForImagePrompt(analysis = {}) {
  if (!analysis || analysis.available !== true) return analysis?.error ? `Vision analysis unavailable: ${analysis.error}` : '';
  const lines = [];
  const overall = sanitizeVisionText(analysis.overall_summary, 600);
  const cover = sanitizeVisionText(analysis.cover_feedback, 500);
  const missing = analysis.missing_shots?.map(x => sanitizeVisionText(x, 180)).filter(Boolean) || [];
  const recommended = analysis.recommended_new_slots?.map(x => sanitizeVisionText(x, 180)).filter(Boolean) || [];
  if (overall) lines.push(`Overall visual analysis: ${overall}`);
  if (cover) lines.push(`Cover feedback: ${cover}`);
  if (missing.length) lines.push(`Missing shots to consider: ${missing.join('; ')}`);
  if (recommended.length) lines.push(`Recommended new image slots: ${recommended.join('; ')}`);
  for (const img of (analysis.images || []).slice(0, 6)) {
    const summary = sanitizeVisionText(img.summary || '', 360);
    const strengths = img.strengths?.map(x => sanitizeVisionText(x, 120)).filter(Boolean) || [];
    const issues = img.issues?.map(x => sanitizeVisionText(x, 120)).filter(Boolean) || [];
    const suggestions = img.suggestions?.map(x => sanitizeVisionText(x, 120)).filter(Boolean) || [];
    const parts = [
      summary ? `summary: ${summary}` : '',
      strengths.length ? `strengths: ${strengths.join(', ')}` : '',
      issues.length ? `issues: ${issues.join(', ')}` : '',
      suggestions.length ? `suggestions: ${suggestions.join(', ')}` : '',
    ].filter(Boolean).join(' | ');
    if (parts) lines.push(`Image ${img.rank}: ${parts}`);
  }
  return sanitizeImagePromptText(lines.join('\n'), 2400);
}

export async function enrichListingImagePlanWithVision(planInput = {}, listing = {}, messages = [], context = {}) {
  const plan = normalizeListingImageProposal(planInput);
  if (plan.mode === 'delete_selected' || plan.visual_analysis || !plan.current_images?.length) return plan;
  const userText = latestUserText(messages || []);
  const ranks = plan.mode === 'replace_selected'
    ? plan.selected_image_ranks
    : plan.mode === 'replace_cover'
      ? [1]
      : [];
  const analysis = await analyzeListingImages({ listing_id: plan.listing_id, image_ranks: ranks, question: userText }, {
    ...context,
    messages,
    listing_details: {
      ...(context.listing_details || {}),
      [plan.listing_id]: {
        ...listing,
        listing_id: plan.listing_id,
        title: listing.title || plan.listing_title,
        listing_title: listing.listing_title || plan.listing_title,
        images: plan.current_images,
      },
    },
  });
  const visionPrompt = summarizeVisionForImagePrompt(analysis);
  const nextPrompt = visionPrompt && plan.prompt
    ? `${plan.prompt}\n\nUse this vision analysis of the current Etsy images before planning the new visuals:\n${visionPrompt}`.slice(0, 4000)
    : plan.prompt;
  return {
    ...plan,
    prompt: nextPrompt,
    slots: plan.slots?.length && visionPrompt
      ? plan.slots.map(slot => ({
        ...slot,
        visual_prompt: `${slot.visual_prompt || plan.prompt}\n\nUse this vision analysis of the current Etsy images before generating this slot:\n${visionPrompt}`.slice(0, 4000),
      }))
      : plan.slots,
    visual_analysis: analysis,
  };
}

export function isImageGenerationRequest(messages = []) {
  return false;
}

export function isCreateListingRequest(messages = [], context = {}) {
  return false;
}

export function createListingDraftFromRequest(messages = [], context = {}) {
  const page = context.page_context || {};
  return {
    description: '',
    listing_type: page.listing_type || 'download',
    price: page.price || '',
    extra: '',
    product_type: 'New Etsy listing',
    shop_context: '',
  };
}

export function imageIntentFromText(text = '', currentImages = []) {
  return null;
}

export function isPreparedImagePlanFollowUp(messages = []) {
  return false;
}

export function isCurrentDraftImageRequest(messages = [], context = {}) {
  return false;
}

export function preparedImagePlanFollowUpAction(text = '') {
  return { wantsCancel: false, wantsRegenerate: false, wantsApply: false, wantsModeChange: false };
}

export function adjustPreparedListingImagePlanForFollowUp(planInput = {}, messages = []) {
  return null;
}

export function adjustPreparedListingImagePlanForFollowUpForTest(plan, messages) {
  return adjustPreparedListingImagePlanForFollowUp(plan, messages);
}

export function buildFallbackImagePrompt(listing, userText = '') {
  const title = listing?.title || listing?.listing_title || 'Etsy product';
  const desc = String(listing?.description || '').slice(0, 900);
  const tags = Array.isArray(listing?.tags) && listing.tags.length ? listing.tags.slice(0, 13).join(', ') : '';
  return [
    `Create Etsy listing images for this exact product/listing: ${title}.`,
    desc ? `Product facts from the listing description: ${desc}` : '',
    tags ? `Listing tags/keywords for product context only: ${tags}` : '',
    userText ? `User instructions: ${userText}` : '',
    'Use the current/selected listing image as the visual reference when provided. Preserve the actual product, artwork, design, colors, and buyer intent. Do not invent a different occasion, niche, year, product type, or theme.',
    'Create clean commercial Etsy product photography/mockups with realistic lighting and high detail. Do not specify exact hex colors. No watermarks, UI screenshots, or fake review badges.',
  ].filter(Boolean).join('\n');
}
