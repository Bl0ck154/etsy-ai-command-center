const GENERATED_MARKER_RE = /generated|ai[_ -]?image|image[_ -]?generation|omniroute|chatgpt-web|gemini[_ -]?image|pollinations/i;
const PERMANENT_MEDIA_PATH_RE = /^\/api\/social\?[^#]*\baction=mediaAsset\b[^#]*\bid=shmedia_[a-f0-9]{24}\b/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const TEMPORARY_GENERATED_URL_RE = /\/v1\/chatgpt-web\/image\/|pollinations(?:\.ai|[-_/]url)|\/generated(?:[-_/](?:preview|runtime|temp))?\//i;

function mediaUrl(item) {
  return String(typeof item === 'string' ? item : item?.url || '').trim();
}

function canonicalMediaAssetOrigin() {
  return String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
}

export function isPermanentSocialMediaAssetUrl(value, expectedOrigin = canonicalMediaAssetOrigin()) {
  try {
    const url = new URL(String(value || ''));
    if (!/^https?:$/.test(url.protocol) || !PERMANENT_MEDIA_PATH_RE.test(`${url.pathname}${url.search}`)) return false;
    if (!expectedOrigin) return true;
    return url.origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}

export function isGeneratedSocialMediaItem(item = {}) {
  if (!item || typeof item !== 'object') return false;
  if (item.permanent === true || item.checksum_sha256 || item.brief_id || item.prompt || item.model || item.provider) return true;
  return GENERATED_MARKER_RE.test(String(item.source || item.source_field || item.generated_via || ''));
}

export function scheduledPostMediaSafetyError(record = {}) {
  const directUrls = [record.generated_image_url, record.custom_image_url]
    .concat((Array.isArray(record.media_items) ? record.media_items : []).map(mediaUrl))
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (directUrls.some(url => TEMPORARY_GENERATED_URL_RE.test(url))) {
    return {
      code: 'GENERATED_MEDIA_NOT_PERMANENT',
      message: 'Provider/runtime generated image URLs cannot be saved; persist the bytes as an Etsy AI Command Center mediaAsset first.',
    };
  }

  const generatedImageUrl = String(record.generated_image_url || '').trim();
  if (generatedImageUrl && !isPermanentSocialMediaAssetUrl(generatedImageUrl)) {
    return {
      code: 'GENERATED_MEDIA_NOT_PERMANENT',
      message: 'generated_image_url must point to a permanent Etsy AI Command Center mediaAsset, not a provider/runtime URL.',
    };
  }

  const items = Array.isArray(record.media_items) ? record.media_items : [];
  for (const item of items) {
    if (!isGeneratedSocialMediaItem(item)) continue;
    const url = mediaUrl(item);
    if (item?.permanent !== true || !SHA256_RE.test(String(item?.checksum_sha256 || '')) || !isPermanentSocialMediaAssetUrl(url)) {
      return {
        code: 'GENERATED_MEDIA_NOT_PERMANENT',
        message: 'Generated media_items require permanent=true, a SHA-256 checksum, and an Etsy AI Command Center mediaAsset URL.',
      };
    }
  }
  return null;
}

export function assertScheduledPostMediaSafety(record = {}) {
  const problem = scheduledPostMediaSafetyError(record);
  if (!problem) return record;
  const error = new Error(problem.message);
  error.code = problem.code;
  throw error;
}
