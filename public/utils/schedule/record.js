function usableMediaUrl(value) {
  const url = String(value || '').trim();
  if (!url || /^(null|undefined|about:blank)$/i.test(url)) return '';
  return url;
}

function mediaTypeFor(url, fallback = 'image') {
  return /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(url) ? 'video' : fallback;
}

function pushMediaItem(items, item, fallbackType = 'image', source = '') {
  if (Array.isArray(item)) {
    item.forEach(child => pushMediaItem(items, child, fallbackType, source));
    return;
  }
  if (item && typeof item === 'object') {
    const nested = item.media_items || item.items || item.media || item.images;
    if (Array.isArray(nested)) nested.forEach(child => pushMediaItem(items, child, item.type || fallbackType, source));
    const url = usableMediaUrl(item.url || item.src || item.image_url || item.imageUrl || item.secure_url || item.thumbnail_url || item.preview_url);
    if (!url || items.some(existing => existing.url === url)) return;
    items.push({ ...item, url, type: item.type || mediaTypeFor(url, fallbackType), source: item.source || source || item.source_field || undefined });
    return;
  }
  const url = usableMediaUrl(item);
  if (!url || items.some(existing => existing.url === url)) return;
  items.push({ url, type: mediaTypeFor(url, fallbackType), source: source || undefined });
}

export function normalizeScheduledPost(post = {}) {
  const record = { ...post };
  const items = [];
  pushMediaItem(items, record.media_items, 'image', 'media_items');
  pushMediaItem(items, record.custom_image_url, 'image', 'custom_image_url');
  pushMediaItem(items, record.generated_image_url, 'image', 'generated_image_url');
  pushMediaItem(items, record.listing_image_url, 'image', 'listing_image_url');
  record.media_items = items;
  record.custom_image_url = usableMediaUrl(record.custom_image_url) || items[0]?.url || null;
  record.generated_image_url = usableMediaUrl(record.generated_image_url) || null;
  record.listing_image_url = usableMediaUrl(record.listing_image_url) || null;
  return record;
}

export function normalizeScheduledPosts(posts) {
  const seen = new Set();
  return (Array.isArray(posts) ? posts : [])
    .map(normalizeScheduledPost)
    .filter(post => {
      const id = String(post?.id || '').trim();
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function changesIncludeMedia(changes = {}) {
  return Object.prototype.hasOwnProperty.call(changes, 'media_items')
    || Object.prototype.hasOwnProperty.call(changes, 'custom_image_url')
    || Object.prototype.hasOwnProperty.call(changes, 'generated_image_url')
    || Object.prototype.hasOwnProperty.call(changes, 'listing_image_url');
}

export const APPROVAL_CLEAR_FIELDS = Object.freeze([
  'status', 'caption', 'platform', 'listing_id', 'listing_title', 'listing_image_url',
  'custom_image_url', 'generated_image_url', 'media_items', 'scheduled_at',
]);

export function shouldClearApproval(changes = {}) {
  return APPROVAL_CLEAR_FIELDS.some(field => Object.prototype.hasOwnProperty.call(changes, field));
}

export function withoutApproval(record = {}) {
  return {
    ...record,
    approved_for_publish: false,
    approved_by: null,
    approved_at: null,
    approval_note: null,
    approval_source: null,
  };
}
