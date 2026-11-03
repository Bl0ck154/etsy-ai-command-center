// Media URL normalization helpers shared by listing preview UI.

/**
 * Return a browser-safe URL from the URL field variants used by Etsy and
 * older cached listing responses. Protocol-relative Etsy CDN URLs are common.
 */
export function normalizeMediaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
  return '';
}

/** Keep persistent Etsy AI Command Center media assets on the active app origin. */
export function currentOriginMediaAssetUrl(value, origin = typeof window !== 'undefined' ? window.location.origin : '') {
  const candidate = String(value || '').trim();
  const raw = normalizeMediaUrl(candidate) || (candidate.startsWith('/') ? candidate : '');
  if (!raw || !origin) return raw;
  try {
    const parsed = new URL(raw, origin);
    if (!/^\/api\/social$/i.test(parsed.pathname) || parsed.searchParams.get('action') !== 'mediaAsset') return raw;
    const active = new URL(origin);
    parsed.protocol = active.protocol;
    parsed.host = active.host;
    return parsed.toString();
  } catch { return raw; }
}

/** Resolve an Etsy listing video response into its playable URL. */
export function listingVideoUrl(video = {}) {
  return normalizeMediaUrl(
    video.video_url
      || video.url_fullxfull
      || video.url
      || video.videoUrl
      || video.sources?.[0]?.url
  );
}
