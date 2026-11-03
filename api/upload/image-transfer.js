import { ETSY_BASE, API_KEY_FULL, getShopId } from '../_etsy.js';
import { listingImagePath, validateListingImageAltText } from '../_listing-image-alt-text.js';

const SHOP_ID = getShopId();
export const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;
export const REMOTE_IMAGE_TIMEOUT_MS = 15_000;
const ALLOWED_REMOTE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export async function uploadImageAction({
  action = 'uploadImage',
  listing_id,
  imageBase64,
  imageUrl,
  contentType,
  rank,
  overwrite,
  altText,
  alt_text,
}, {
  token,
  remoteFetchImpl = fetch,
  uploadFetchImpl = fetch,
  shopId = SHOP_ID,
  timeoutMs = REMOTE_IMAGE_TIMEOUT_MS,
  maxBytes = MAX_REMOTE_IMAGE_BYTES,
} = {}) {
  if (!listing_id || (!imageBase64 && !imageUrl)) {
    throw uploadError('listing_id and imageBase64 or imageUrl required', 400);
  }
  if (imageBase64 && imageUrl) throw uploadError('Provide only one of imageBase64 or imageUrl', 400);
  if (action === 'uploadImageFromUrl' && !imageUrl) {
    throw uploadError('listing_id and imageUrl required', 400);
  }

  let imageBuffer;
  let mimeType;
  if (imageUrl) {
    const downloaded = await downloadEtsyListingImage(imageUrl, {
      fetchImpl: remoteFetchImpl,
      timeoutMs,
      maxBytes,
    });
    imageBuffer = downloaded.buffer;
    mimeType = downloaded.mimeType;
  } else {
    const base64Data = imageBase64.replace(/^data:[^;]+;base64,/, '');
    imageBuffer = Buffer.from(base64Data, 'base64');
    mimeType = normalizeImageMimeType(contentType || detectMimeType(base64Data));
  }

  return uploadListingImageBuffer({
    token,
    listingId: listing_id,
    imageBuffer,
    mimeType,
    rank,
    overwrite,
    altText: altText ?? alt_text,
    shopId,
    fetchImpl: uploadFetchImpl,
  });
}

export function isAllowedEtsyImageUrl(value) {
  try {
    const raw = String(value || '').trim();
    if (/\/(?:\.\.)(?:\/|$)/.test(raw) || /%(?:25)*(?:2e|2f|5c)/i.test(raw)) return false;
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'i.etsystatic.com') return false;
    if (url.username || url.password || url.port || url.hash) return false;
    let decodedPath;
    try { decodedPath = decodeURIComponent(url.pathname); } catch { return false; }
    return decodedPath.startsWith('/') && !decodedPath.includes('\\') && !decodedPath.split('/').includes('..');
  } catch {
    return false;
  }
}

export async function downloadEtsyListingImage(imageUrl, {
  fetchImpl = fetch,
  timeoutMs = REMOTE_IMAGE_TIMEOUT_MS,
  maxBytes = MAX_REMOTE_IMAGE_BYTES,
} = {}) {
  if (!isAllowedEtsyImageUrl(imageUrl)) {
    throw uploadError('Only HTTPS images from i.etsystatic.com are allowed', 400);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(String(imageUrl), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'image/jpeg,image/png,image/gif,image/webp' },
    });
    if (!response.ok) throw uploadError(`Etsy image download failed with HTTP ${response.status}`, 502);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw uploadError('Etsy image exceeds the maximum allowed size', 413);
    }
    const mimeType = normalizeImageMimeType(response.headers.get('content-type'));
    if (!ALLOWED_REMOTE_IMAGE_MIME_TYPES.has(mimeType)) {
      throw uploadError('Etsy image returned an unsupported content type', 415);
    }
    const buffer = await readBodyWithLimit(response, maxBytes);
    if (!hasMatchingImageSignature(buffer, mimeType)) {
      throw uploadError('Etsy image payload does not match its content type', 415);
    }
    return { buffer, mimeType };
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw uploadError('Etsy image download timed out', 504);
    }
    if (err?.status) throw err;
    throw uploadError('Etsy image download failed', 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function uploadListingImageBuffer({
  token,
  listingId,
  imageBuffer,
  mimeType,
  rank,
  overwrite,
  altText,
  shopId = SHOP_ID,
  fetchImpl = fetch,
  timeoutMs = 20_000,
}) {
  const safeMimeType = normalizeImageMimeType(mimeType);
  if (!ALLOWED_REMOTE_IMAGE_MIME_TYPES.has(safeMimeType)) {
    throw uploadError('Unsupported listing image content type', 415);
  }
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    throw uploadError('Listing image is empty', 400);
  }

  const boundary = `----FormBoundary${Date.now()}`;
  const filename = `listing_image_${Date.now()}.${imageExtension(safeMimeType)}`;
  const fields = [];
  if (rank !== undefined) {
    const safeRank = Number(rank);
    if (!Number.isInteger(safeRank) || safeRank < 1 || safeRank > 20) {
      throw uploadError('rank must be an integer from 1 to 20', 400);
    }
    fields.push(['rank', String(safeRank)]);
  }
  if (overwrite !== undefined) {
    fields.push(['overwrite', overwrite === true || overwrite === 'true' ? 'true' : 'false']);
  }
  if (altText !== undefined && String(altText || '').trim()) {
    fields.push(['alt_text', validateListingImageAltText(altText)]);
  }

  const opening = Buffer.from(
    `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n`
      + `Content-Type: ${safeMimeType}\r\n\r\n`,
    'utf8',
  );
  const closing = Buffer.from(
    fields.map(([name, value]) => (
      `\r\n--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
      + value
    )).join('') + `\r\n--${boundary}--\r\n`,
    'utf8',
  );
  const body = Buffer.concat([opening, imageBuffer, closing]);
  const path = listingImagePath(listingId, null, shopId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${ETSY_BASE}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': API_KEY_FULL,
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw uploadError('Etsy image upload timed out', 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw uploadError(data.error_description || data.error || `Upload failed: ${response.status}`, response.status);
  }
  return data;
}

async function readBodyWithLimit(response, maxBytes) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw uploadError('Etsy image is empty', 415);
    if (buffer.length > maxBytes) throw uploadError('Etsy image exceeds the maximum allowed size', 413);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw uploadError('Etsy image exceeds the maximum allowed size', 413);
    }
    chunks.push(chunk);
  }
  if (!total) throw uploadError('Etsy image is empty', 415);
  return Buffer.concat(chunks, total);
}

function normalizeImageMimeType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
}

function hasMatchingImageSignature(buffer, mimeType) {
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function imageExtension(mimeType) {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[mimeType] || 'jpg';
}

function uploadError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function detectMimeType(base64) {
  const sig = base64.slice(0, 4);
  if (sig.startsWith('/9j/')) return 'image/jpeg';
  if (sig.startsWith('iVBO')) return 'image/png';
  if (sig.startsWith('R0lG')) return 'image/gif';
  if (sig.startsWith('UklG')) return 'image/webp';
  return 'image/jpeg';
}
