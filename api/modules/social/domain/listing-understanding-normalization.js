const SOCIAL_CAPTION_PLATFORMS = ['instagram', 'facebook', 'pinterest', 'tiktok'];

export function createSocialListingUnderstandingNormalizer({
  normalizeText,
  normalizeCaption,
  normalizeStringList,
  normalizeReviewCardDesign,
  normalizeCaptionReviews,
} = {}) {
  const dependencies = {
    normalizeText,
    normalizeCaption,
    normalizeStringList,
    normalizeReviewCardDesign,
    normalizeCaptionReviews,
  };
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency !== 'function') throw new TypeError(`${name} is required`);
  }

  const text = (value, max = 1000) => normalizeText(value, max);
  const caption = (value, max = 1600) => normalizeCaption(value, max);
  const stringList = (value, maxItems = 8, maxChars = 120) => normalizeStringList(value, maxItems, maxChars);

  function normalizePlatformVariants(raw = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const platform of SOCIAL_CAPTION_PLATFORMS) {
      const value = source[platform];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      out[platform] = {
        format: text(value.format, 40).toLowerCase(),
        frame_ids: stringList(value.frame_ids, 12, 80),
        buyer_evidence_frame_ids: stringList(value.buyer_evidence_frame_ids, 12, 80),
      };
    }
    return out;
  }

  function normalizeAcceptedAssetDecisions(raw = []) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 12).map(item => ({
      brief_id: text(item?.brief_id || item?.frame_id, 80),
      decision: text(item?.decision, 40).toLowerCase(),
      rationale: text(item?.rationale, 420),
    })).filter(item => item.brief_id);
  }

  function normalizeOfferFactReview(raw = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      current_inventory_applied: source.current_inventory_applied === true,
      current_offer_summary: text(source.current_offer_summary, 700),
      claims: (Array.isArray(source.claims) ? source.claims : []).slice(0, 24).map(item => ({
        claim: text(item?.claim, 300),
        status: text(item?.status, 40).toLowerCase(),
        source_ids: stringList(item?.source_ids, 8, 180),
        rationale: text(item?.rationale, 500),
      })).filter(item => item.claim),
      conflicts: stringList(source.conflicts, 12, 400),
    };
  }

  function normalizeMediaStrategy(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const framesRaw = Array.isArray(raw.frames) ? raw.frames : [];
    const frames = framesRaw.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return {};
      const rank = Number(item.reference_media_rank);
      return {
        id: text(item.id, 80),
        role: text(item.role, 120),
        communication_goal: text(item.communication_goal, 420),
        visible_buyer_evidence: text(item.visible_buyer_evidence, 500),
        evidence_strength: text(item.evidence_strength, 40).toLowerCase(),
        source: text(item.source, 80).toLowerCase(),
        image_model: text(item.image_model || item.model, 180),
        prompt: text(item.prompt, 1800),
        rationale: text(item.rationale, 420),
        reference_policy: text(item.reference_policy, 180),
        reference_required: typeof item.reference_required === 'boolean' ? item.reference_required : null,
        reference_media_rank: Number.isInteger(rank) && rank > 0 ? rank : null,
        review_id: text(item.review_id, 120) || null,
        context_note: text(item.context_note, 180),
        review_card_design: normalizeReviewCardDesign(item.review_card_design),
        aspect_ratio: text(item.aspect_ratio, 20),
        crop_focus: text(item.crop_focus, 20).toLowerCase(),
      };
    });
    const count = Number(raw.target_media_count);
    const out = {
      format: text(raw.format, 80).toLowerCase(),
      target_media_count: Number.isInteger(count) ? count : null,
      listing_media_policy: text(raw.listing_media_policy, 220),
      listing_media_decisions: (Array.isArray(raw.listing_media_decisions)
        ? raw.listing_media_decisions
        : []).slice(0, 12).map(item => ({
        rank: Number.isInteger(Number(item?.rank)) && Number(item.rank) > 0
          ? Number(item.rank)
          : null,
        decision: text(item?.decision, 40).toLowerCase(),
        social_role: text(item?.social_role, 160),
        rationale: text(item?.rationale, 500),
      })).filter(item => item.rank),
      reference_policy: text(raw.reference_policy, 220),
      campaign_offer_focus: text(raw.campaign_offer_focus, 700),
      lead_proof_plan: text(raw.lead_proof_plan, 900),
      required_visible_evidence: text(raw.required_visible_evidence, 700),
      frame_count_rationale: text(raw.frame_count_rationale, 700),
      rationale: text(raw.rationale, 700),
      frames,
      platform_variants: normalizePlatformVariants(raw.platform_variants),
      accepted_asset_decisions: normalizeAcceptedAssetDecisions(raw.accepted_asset_decisions),
    };
    if (!out.format && !out.target_media_count && !out.frames.length && !out.listing_media_policy && !out.reference_policy) return null;
    return out;
  }

  function normalize(raw = {}, source = 'ai') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const confidence = Number(raw.confidence);
    const platformCaptions = Object.fromEntries(SOCIAL_CAPTION_PLATFORMS
      .map(platform => [platform, caption(raw.platform_captions?.[platform] || raw.captions?.[platform], 1600)])
      .filter(([, value]) => value));
    const out = {
      available: true,
      source,
      what_is_sold: text(raw.what_is_sold || raw.product || raw.item || raw.listing_summary || raw.summary, 280),
      product_category: text(raw.product_category || raw.category || raw.product_type || raw.kind, 140),
      fulfillment: text(raw.fulfillment, 120),
      buyer_use_case: text(raw.buyer_use_case || raw.use_case || raw.buyer_context || raw.customer_use_case, 300),
      target_buyer: text(raw.target_buyer || raw.audience || raw.customer || raw.ideal_buyer, 220),
      marketing_angle: text(raw.marketing_angle || raw.angle || raw.selling_angle || raw.promo_angle, 260),
      caption_body: text(raw.caption_body || raw.caption || raw.caption_draft || raw.public_copy, 700),
      platform_captions: platformCaptions,
      platform_caption_reviews: normalizeCaptionReviews(
        raw.platform_caption_reviews || raw.caption_quality_reviews || raw.platform_reviews,
        platformCaptions,
      ),
      caption_review_source: text(raw.caption_review_source || raw.captionReviewSource, 120),
      caption_review_model: text(raw.caption_review_model || raw.captionReviewModel, 160),
      caption_review_run_id: text(raw.caption_review_run_id || raw.captionReviewRunId, 120),
      caption_reviewed_at: text(raw.caption_reviewed_at || raw.captionReviewedAt, 80),
      visual_brief: text(raw.visual_brief || raw.image_brief || raw.media_brief || raw.mockup_brief, 700),
      media_strategy: normalizeMediaStrategy(raw.media_strategy),
      visual_analysis: raw.visual_analysis?.applied === true
        ? {
          applied: true,
          provider: text(raw.visual_analysis.provider, 160),
          image_count: Math.max(0, Math.min(10, Number(raw.visual_analysis.image_count) || 0)),
        }
        : null,
      platforms: stringList(raw.platforms, 6, 40),
      hashtags: stringList(raw.hashtags, 8, 40).map(tag => tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`),
      unsupported_claims_to_avoid: stringList(raw.unsupported_claims_to_avoid || raw.claims_to_avoid, 10, 160),
      offer_fact_review: normalizeOfferFactReview(raw.offer_fact_review),
      evidence: stringList(raw.evidence, 10, 180),
      unknowns: stringList(raw.unknowns, 10, 160),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    };
    if (!out.what_is_sold && !out.buyer_use_case && !out.marketing_angle && !out.caption_body) return null;
    return out;
  }

  return Object.freeze({
    normalize,
    normalizeAcceptedAssetDecisions,
    normalizeMediaStrategy,
    normalizeOfferFactReview,
    normalizePlatformVariants,
  });
}
