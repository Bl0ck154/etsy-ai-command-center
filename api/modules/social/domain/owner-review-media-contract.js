const PERSISTENT_CHECKSUM_RE = /^[a-fA-F0-9]{64}$/;
const URL_RE = /^https?:\/\//;
const ALLOWED_MEDIA_SOURCES = new Set(['listing_image', 'generated_image', 'review_card']);

export function socialOwnerReviewGeneratedMediaIsPersistent(item = {}) {
  const url = String(item?.url || '').trim();
  const checksum = String(item?.checksum_sha256 || '').trim();
  return URL_RE.test(url)
    && item?.permanent === true
    && PERSISTENT_CHECKSUM_RE.test(checksum);
}

export function socialOwnerReviewCanonicalVariantFormat(variant = {}, platform = '', mediaCount = null) {
  const explicit = String(variant?.format || variant?.media_format || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (variant?.carousel === true) return 'carousel';
  const count = mediaCount == null
    ? (Array.isArray(variant?.media_items) ? variant.media_items.length : 0)
    : Number(mediaCount);
  if (count > 1) return platform === 'instagram' ? 'carousel' : 'multi_image';
  return 'single';
}

export function socialOwnerReviewPrimaryMediaFields(mediaItems = []) {
  const primary = Array.isArray(mediaItems) && mediaItems[0] && typeof mediaItems[0] === 'object'
    ? mediaItems[0]
    : {};
  const url = String(primary.url || '').trim();
  const source = String(primary.source || '').trim();
  return {
    listing_image_url: source === 'listing_image' ? url : '',
    generated_image_url: source === 'generated_image' ? url : '',
    custom_image_url: url,
  };
}

/**
 * Exact deterministic counterpart of the active Python factory's
 * build_media_payloads_from_plan(). It preserves the AI-selected media order
 * and fails the whole platform variant if any selected frame cannot be used.
 * It never substitutes another listing image or changes the media count.
 */
export function resolveSocialOwnerReviewVariantMedia({
  variant = {},
  listing = {},
  platform = '',
  blockedMedia = new Set(),
} = {}) {
  const plannedMedia = variant?.media_items;
  if (!Array.isArray(plannedMedia) || !plannedMedia.length) return [];

  const blocked = blockedMedia instanceof Set ? blockedMedia : new Set(blockedMedia || []);
  const mediaItems = [];
  const seen = new Set();

  for (const item of plannedMedia) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const url = String(item.url || '').trim();
    if (!url || blocked.has(url) || seen.has(url)) return [];
    const source = String(item.source || '').trim();
    if (!ALLOWED_MEDIA_SOURCES.has(source)) return [];
    if ((source === 'generated_image' || source === 'review_card')
      && !socialOwnerReviewGeneratedMediaIsPersistent(item)) return [];

    const alt = String(item.alt || item.description || '').trim()
      || `${platform} social image for ${String(listing?.title || 'custom digital service').slice(0, 180)}`;
    const payload = {
      url,
      type: item.type || 'image',
      alt,
      source,
    };
    for (const key of [
      'id',
      'brief_id',
      'prompt',
      'provider',
      'model',
      'aspect_ratio',
      'checksum_sha256',
      'permanent',
      'generated_via',
      'image_model_tier',
      'quality_review',
    ]) {
      if (item[key] !== null && item[key] !== undefined && item[key] !== '') payload[key] = item[key];
    }
    seen.add(url);
    mediaItems.push(payload);
  }

  const variantFormat = socialOwnerReviewCanonicalVariantFormat(variant, platform, mediaItems.length);
  if (platform === 'pinterest' && mediaItems.length !== 1) return [];
  if (variantFormat === 'single' && mediaItems.length !== 1) return [];
  if ((variantFormat === 'carousel' || variantFormat === 'multi_image') && mediaItems.length < 2) return [];
  return mediaItems;
}
