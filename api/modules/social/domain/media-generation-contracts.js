const SOCIAL_MEDIA_HTTP_URL_RE = /^https?:\/\//i;
const SOCIAL_MEDIA_ASPECT_RATIO_RE = /^(1:1|4:5|2:3|3:4|9:16|16:9)$/;
const SOCIAL_MEDIA_CROP_FOCUS = new Set(['attention', 'center', 'north', 'south', 'east', 'west']);

export function socialMediaText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function valueFromSocialMediaBody(body, key) {
  if (body?.post && Object.prototype.hasOwnProperty.call(body.post, key)) return body.post[key];
  if (body?.draft && Object.prototype.hasOwnProperty.call(body.draft, key)) return body.draft[key];
  return body?.[key];
}

export function supportedSocialMediaAspectRatio(value) {
  const ratio = String(value || '').trim();
  return SOCIAL_MEDIA_ASPECT_RATIO_RE.test(ratio) ? ratio : '';
}

export function normalizeSocialMediaAspectRatio(value) {
  return supportedSocialMediaAspectRatio(value) || '1:1';
}

export function normalizeSocialMediaCropFocus(value) {
  const focus = String(value || '').toLowerCase();
  return SOCIAL_MEDIA_CROP_FOCUS.has(focus) ? focus : 'attention';
}

export function normalizeSocialMediaImageTier(value = 'cheap', allowHigh = false) {
  const tier = String(value || 'cheap').trim().toLowerCase();
  if (tier === 'high') return allowHigh ? 'high' : 'standard';
  if (tier === 'standard') return 'standard';
  return 'cheap';
}

export function normalizeSocialMediaReferenceImage(body = {}) {
  const candidate = body.referenceImage
    || body.reference_image
    || body.reference_image_url
    || body.referenceImageUrl;
  if (!candidate) return undefined;
  if (typeof candidate === 'string') {
    return SOCIAL_MEDIA_HTTP_URL_RE.test(candidate) ? { url: candidate } : undefined;
  }
  if (typeof candidate !== 'object') return undefined;
  const url = candidate.url || candidate.image_url;
  if (typeof url === 'string' && SOCIAL_MEDIA_HTTP_URL_RE.test(url)) return { ...candidate, url };
  if (candidate.base64 && (candidate.mimeType || candidate.mime_type)) return candidate;
  return undefined;
}

export function normalizeSocialMediaGenerationRequest(body = {}) {
  const qualityContext = body.quality_context && typeof body.quality_context === 'object'
    ? body.quality_context
    : body.qualityContext && typeof body.qualityContext === 'object'
      ? body.qualityContext
      : {};
  const allowHigh = body.allow_high_model === true
    || body.allowHighModel === true
    || body.high_approved === true;
  const requestedTier = body.image_model_tier || body.model_tier || body.tier || 'cheap';
  const referenceRequired = body.reference_required === true || qualityContext.reference_required === true;
  return {
    renderer: String(valueFromSocialMediaBody(body, 'renderer') || body.render_mode || body.renderMode || '')
      .trim()
      .toLowerCase(),
    dryRun: body.dry_run === true || body.dryRun === true,
    prompt: String(valueFromSocialMediaBody(body, 'prompt') || body.image_prompt || '').trim(),
    aspectRatio: normalizeSocialMediaAspectRatio(body.aspectRatio || body.aspect_ratio),
    cropFocus: normalizeSocialMediaCropFocus(body.crop_focus || body.cropFocus),
    fallbackRequested: body.allow_fallback === true
      || body.allowFallback === true
      || body.e2e === true
      || body.force_fallback === true
      || body.forceFallback === true,
    allowHigh,
    requestedTier,
    imageModelTier: normalizeSocialMediaImageTier(requestedTier, allowHigh),
    requestedModel: body.model || body.image_model || '',
    requestedCount: Math.max(1, Math.min(Number(body.count || body.n) || 1, 6)),
    requireVisualQualityReview: body.require_visual_quality_review === true
      || body.requireVisualQualityReview === true,
    qualityContext,
    referenceRequired,
    referenceImage: referenceRequired ? normalizeSocialMediaReferenceImage(body) : undefined,
    referencePolicy: String(body.reference_policy || body.referencePolicy || '').trim(),
  };
}
