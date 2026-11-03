const SUPPORTED_SOCIAL_PLATFORMS = ['instagram', 'facebook', 'pinterest', 'tiktok'];

export function createSocialCaptionReviewContracts({
  normalizeText,
  normalizeCaption,
} = {}) {
  if (typeof normalizeText !== 'function') throw new TypeError('normalizeText is required');
  if (typeof normalizeCaption !== 'function') throw new TypeError('normalizeCaption is required');

  const text = (value, max = 1000) => normalizeText(value, max);
  const caption = (value, max = 1600) => normalizeCaption(value, max);
  const stringList = (value, maxItems = 8, maxChars = 120) => (Array.isArray(value) ? value : [])
    .map(item => text(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
  const requestedSupportedPlatforms = (platforms = []) => [...new Set((platforms || [])
    .map(item => text(item, 40).toLowerCase())
    .filter(item => SUPPORTED_SOCIAL_PLATFORMS.includes(item)))];

  function outputSchema(platforms = []) {
    const requested = [...new Set((platforms || []).map(item => text(item, 40).toLowerCase()).filter(Boolean))];
    const properties = Object.fromEntries(requested.map(platform => [platform, {
      type: 'object',
      additionalProperties: false,
      required: ['approved', 'decision', 'reviewed_caption', 'rationale', 'factual_grounding', 'platform_fit', 'cta_destination', 'cta_compliant', 'required_listing_url_present', 'risks'],
      properties: {
        approved: { type: 'boolean' },
        decision: { type: 'string', enum: ['approve', 'revise'] },
        reviewed_caption: { type: 'string' },
        rationale: { type: 'string' },
        factual_grounding: { type: 'string' },
        platform_fit: { type: 'string' },
        cta_destination: { type: 'string', enum: ['etsy_listing', 'etsy_link_in_bio', 'social_direct_message', 'email', 'none', 'other'] },
        cta_compliant: { type: 'boolean' },
        required_listing_url_present: { type: 'boolean' },
        risks: { type: 'array', items: { type: 'string' } },
      },
    }]));
    return {
      type: 'object',
      additionalProperties: false,
      required: ['platform_caption_reviews'],
      properties: {
        platform_caption_reviews: {
          type: 'object',
          additionalProperties: false,
          required: requested,
          properties,
        },
      },
    };
  }

  function validPlatformCaptions(understanding = {}, platforms = []) {
    const requiredPlatforms = requestedSupportedPlatforms(platforms);
    if (!requiredPlatforms.length) return false;
    return requiredPlatforms.every(platform => caption(understanding?.platform_captions?.[platform], 1600).length >= 40);
  }

  function normalizeReviews(raw = {}, captions = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return Object.fromEntries(SUPPORTED_SOCIAL_PLATFORMS.flatMap(platform => {
      const review = source[platform];
      if (!review || typeof review !== 'object' || Array.isArray(review)) return [];
      const reviewedCaption = caption(review.reviewed_caption || review.caption, 1600);
      const actualCaption = caption(captions[platform], 1600);
      const decision = text(review.decision || review.verdict || review.status, 40).toLowerCase();
      const approved = review.approved === true && decision === 'approve' && reviewedCaption === actualCaption;
      return [[platform, {
        approved,
        decision: approved ? 'approve' : (decision || 'revise'),
        reviewed_caption: reviewedCaption,
        rationale: text(review.rationale || review.reason, 600),
        factual_grounding: text(review.factual_grounding || review.grounding, 420),
        platform_fit: text(review.platform_fit || review.platform_reason, 420),
        cta_destination: text(review.cta_destination, 60).toLowerCase(),
        cta_compliant: typeof review.cta_compliant === 'boolean' ? review.cta_compliant : null,
        required_listing_url_present: typeof review.required_listing_url_present === 'boolean'
          ? review.required_listing_url_present
          : null,
        risks: stringList(review.risks, 8, 160),
        critic_source: text(review.critic_source || review.source, 120),
        critic_model: text(review.critic_model || review.model, 160),
        critic_run_id: text(review.critic_run_id || review.run_id, 120),
        reviewed_at: text(review.reviewed_at, 80),
      }]];
    }));
  }

  function enforceRoutePolicy(reviews = {}, captions = {}, platforms = [], listingUrl = '') {
    const exactListingUrl = text(listingUrl, 1000);
    for (const platform of platforms) {
      const review = reviews[platform];
      if (!review) continue;
      const actualCaption = caption(captions[platform], 1600);
      const requiresExactUrl = ['facebook', 'pinterest'].includes(platform);
      const exactUrlPresent = !requiresExactUrl || Boolean(exactListingUrl && actualCaption.includes(exactListingUrl));
      const forbidsRawListingUrl = platform === 'instagram';
      const forbiddenRawUrlPresent = Boolean(forbidsRawListingUrl && exactListingUrl && actualCaption.includes(exactListingUrl));
      const semanticAuditPresent = review.cta_compliant !== null || Boolean(review.cta_destination);
      const semanticRouteAllowed = !semanticAuditPresent || (
        review.cta_compliant === true
        && (platform === 'instagram'
          ? ['etsy_link_in_bio', 'none'].includes(review.cta_destination)
          : review.cta_destination === 'etsy_listing')
      );
      review.required_listing_url_present = exactUrlPresent;
      if (semanticRouteAllowed && exactUrlPresent && !forbiddenRawUrlPresent) continue;
      review.approved = false;
      review.decision = 'revise';
      if (!semanticRouteAllowed) review.risks = [...new Set([...(review.risks || []), 'CTA routes the buyer outside the required Etsy handoff.'])];
      if (!exactUrlPresent) review.risks = [...new Set([...(review.risks || []), 'Exact Etsy listing URL is missing for this platform.'])];
      if (forbiddenRawUrlPresent) review.risks = [...new Set([...(review.risks || []), 'Raw Etsy listing URL is not suitable for the Instagram caption; use the Etsy link in bio instead.'])];
    }
    return reviews;
  }

  function validReviews(understanding = {}, platforms = []) {
    const requiredPlatforms = requestedSupportedPlatforms(platforms);
    if (understanding.caption_review_source !== 'external_ai_caption_critic') return false;
    return requiredPlatforms.every(platform => {
      const review = understanding?.platform_caption_reviews?.[platform];
      return review?.approved === true
        && review.decision === 'approve'
        && review.reviewed_caption === caption(understanding?.platform_captions?.[platform], 1600)
        && Boolean(review.rationale);
    });
  }

  return Object.freeze({
    enforceRoutePolicy,
    normalizeReviews,
    outputSchema,
    validPlatformCaptions,
    validReviews,
  });
}
