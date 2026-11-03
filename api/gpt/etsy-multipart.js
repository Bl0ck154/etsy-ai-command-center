import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { getValidToken, refreshAccessToken } from '../auth.js';
import { API_KEY_FULL, ETSY_BASE } from '../_etsy.js';

export const MAX_DIGITAL_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_LISTING_VIDEO_BYTES = 100 * 1024 * 1024;
export const DEFAULT_ETSY_UPLOAD_TIMEOUT_MS = 20_000;
export const DEFAULT_ETSY_VIDEO_UPLOAD_TIMEOUT_MS = 90_000;

function multipartError(message, status = 400, code = 'INVALID_MULTIPART_UPLOAD') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function positiveId(value, name) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw multipartError(`${name} must be a positive integer`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) throw multipartError(`${name} must be a positive integer`);
  return text;
}

function safeRank(value, max = 20) {
  const number = Number(value ?? 1);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw multipartError(`rank must be an integer from 1 to ${max}`);
  }
  return number;
}

function safeFilename(value, fallback) {
  const name = String(value || fallback || 'upload.bin')
    .replace(/[\\/\r\n\0"]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return fallback || 'upload.bin';
  return name.slice(0, 240);
}

function safeMimeType(value, fallback = 'application/octet-stream') {
  const mime = String(value || fallback).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : fallback;
}

function requiredBuffer(value, name, maxBytes) {
  const buffer = Buffer.isBuffer(value) ? value : null;
  if (!buffer?.length) throw multipartError(`${name} must be a non-empty Buffer`);
  if (buffer.length > maxBytes) throw multipartError(`${name} exceeds the maximum allowed size`, 413, 'UPLOAD_TOO_LARGE');
  return buffer;
}

function boundedTimeout(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), minimum), maximum) : fallback;
}

export function configuredEtsyVideoUploadTimeoutMs(env = process.env) {
  return boundedTimeout(env.GPT_ETSY_VIDEO_UPLOAD_TIMEOUT_MS, DEFAULT_ETSY_VIDEO_UPLOAD_TIMEOUT_MS, 30_000, 180_000);
}

export function buildMultipartPayload(fields, file = null) {
  const boundary = `----EtsyManager${crypto.randomBytes(18).toString('hex')}`;
  const chunks = [];
  for (const [name, rawValue] of Object.entries(fields || {})) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue).replace(/\r|\n/g, ' ');
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    ));
  }
  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
        + `Content-Type: ${file.mimeType}\r\n\r\n`,
      'utf8',
    ));
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    boundary,
    contentLength: chunks.reduce((total, chunk) => total + chunk.length, 0),
    createBody: () => Readable.from(chunks, { objectMode: false }),
  };
}

async function postMultipart(path, fields, file = null, {
  retried = false,
  timeoutMs = DEFAULT_ETSY_UPLOAD_TIMEOUT_MS,
} = {}) {
  if (!API_KEY_FULL) throw multipartError('ETSY_API_KEY is not configured', 500, 'ETSY_NOT_CONFIGURED');
  const token = await getValidToken();
  const { boundary, contentLength, createBody } = buildMultipartPayload(fields, file);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${ETSY_BASE}${path}`, {
      method: 'POST',
      duplex: 'half',
      signal: controller.signal,
      headers: {
        'x-api-key': API_KEY_FULL,
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(contentLength),
      },
      body: createBody(),
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw multipartError('Etsy upload timed out', 504, 'ETSY_UPLOAD_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 && !retried) {
    await refreshAccessToken();
    return postMultipart(path, fields, file, { retried: true, timeoutMs });
  }
  if (response.status === 204) return { success: true };
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = multipartError(
      data.error_description || data.error || `Etsy upload failed with HTTP ${response.status}`,
      response.status,
      'ETSY_MULTIPART_UPLOAD_FAILED',
    );
    error.data = data;
    throw error;
  }
  return data;
}

export async function associateListingImageMultipart({ shopId, listingId, listingImageId, rank, altText }) {
  const shop = positiveId(shopId, 'shop_id');
  const listing = positiveId(listingId, 'listing_id');
  const image = positiveId(listingImageId, 'listing_image_id');
  return postMultipart(`/shops/${shop}/listings/${listing}/images`, {
    listing_image_id: image,
    rank: safeRank(rank),
    ...(altText ? { alt_text: altText } : {}),
  });
}

export async function updateListingImageAltTextMultipart({ shopId, listingId, listingImageId, altText }) {
  const shop = positiveId(shopId, 'shop_id');
  const listing = positiveId(listingId, 'listing_id');
  const image = positiveId(listingImageId, 'listing_image_id');
  return postMultipart(`/shops/${shop}/listings/${listing}/images`, {
    listing_image_id: image,
    alt_text: altText,
  });
}

export async function uploadListingVideoMultipart({ shopId, listingId, buffer, name, mimeType }) {
  const shop = positiveId(shopId, 'shop_id');
  const listing = positiveId(listingId, 'listing_id');
  const video = requiredBuffer(buffer, 'video buffer', MAX_LISTING_VIDEO_BYTES);
  const filename = safeFilename(name, 'listing-video.mp4');
  return postMultipart(`/shops/${shop}/listings/${listing}/videos`, { name: filename }, {
    field: 'video',
    filename,
    mimeType: safeMimeType(mimeType, 'video/mp4'),
    buffer: video,
  }, { timeoutMs: configuredEtsyVideoUploadTimeoutMs() });
}

export async function associateListingVideoMultipart({ shopId, listingId, videoId }) {
  const shop = positiveId(shopId, 'shop_id');
  const listing = positiveId(listingId, 'listing_id');
  const video = positiveId(videoId, 'video_id');
  return postMultipart(`/shops/${shop}/listings/${listing}/videos`, { video_id: video });
}

export async function uploadDigitalListingFileMultipart({ shopId, listingId, buffer, name, mimeType, rank }) {
  const shop = positiveId(shopId, 'shop_id');
  const listing = positiveId(listingId, 'listing_id');
  const file = requiredBuffer(buffer, 'digital file buffer', MAX_DIGITAL_FILE_BYTES);
  const filename = safeFilename(name, 'digital-download.bin');
  return postMultipart(`/shops/${shop}/listings/${listing}/files`, {
    name: filename,
    rank: safeRank(rank, 5),
  }, {
    field: 'file',
    filename,
    mimeType: safeMimeType(mimeType),
    buffer: file,
  });
}

export async function associateDigitalListingFileMultipart({ shopId, listingId, listingFileId, rank }) {
  const shop = positiveId(shopId, 'shop_id');
  const listing = positiveId(listingId, 'listing_id');
  const file = positiveId(listingFileId, 'listing_file_id');
  return postMultipart(`/shops/${shop}/listings/${listing}/files`, {
    listing_file_id: file,
    rank: safeRank(rank, 5),
  });
}
