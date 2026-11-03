function requiredFunction(name, value) {
  if (typeof value !== 'function') throw new TypeError(`${name} dependency is required`);
  return value;
}

/**
 * Plain-data validation coordinator for normalized listing-understanding output.
 * Media/caption rule implementations remain injected so this application seam
 * cannot become a second planner, AI transport, publisher or route adapter.
 */
export function createSocialListingUnderstandingValidationService({
  requiresMediaStrategy,
  validMediaStrategy,
  mediaStrategyValidationProblems,
  visionSelectionProblems,
  capabilityProblems,
  platformRatioProblems,
  acceptedAssetDecisionProblems,
  buyerEvidenceProblems,
  normalizeCaption,
  validCaptionReviews,
} = {}) {
  const requiresMedia = requiredFunction('requiresMediaStrategy', requiresMediaStrategy);
  const validMedia = requiredFunction('validMediaStrategy', validMediaStrategy);
  const mediaProblems = requiredFunction('mediaStrategyValidationProblems', mediaStrategyValidationProblems);
  const visionProblems = requiredFunction('visionSelectionProblems', visionSelectionProblems);
  const capabilityRuleProblems = requiredFunction('capabilityProblems', capabilityProblems);
  const ratioProblems = requiredFunction('platformRatioProblems', platformRatioProblems);
  const acceptedAssetProblems = requiredFunction('acceptedAssetDecisionProblems', acceptedAssetDecisionProblems);
  const evidenceProblems = requiredFunction('buyerEvidenceProblems', buyerEvidenceProblems);
  const caption = requiredFunction('normalizeCaption', normalizeCaption);
  const captionReviewsValid = requiredFunction('validCaptionReviews', validCaptionReviews);

  function problems(understanding, context = {}, captionReviewRequired = false, visualAnalysis = null) {
    if (!understanding || understanding.available === false) return ['listing_understanding_not_normalized'];
    const platforms = context.platforms || [];
    const out = [];
    const mediaRequired = requiresMedia(context);

    if (mediaRequired && !validMedia(understanding.media_strategy, platforms)) {
      out.push(`media_strategy_invalid_or_missing: ${mediaProblems(understanding.media_strategy, platforms).join(' | ')}`);
    }
    if (mediaRequired) {
      out.push(...visionProblems(understanding.media_strategy, visualAnalysis));
      out.push(...capabilityRuleProblems(understanding.media_strategy, context));
      out.push(...ratioProblems(understanding.media_strategy, platforms));
      out.push(...acceptedAssetProblems(understanding.media_strategy, context));
      out.push(...evidenceProblems(understanding.media_strategy, context));
    }

    if (context.require_current_listing_facts === true) {
      const factReview = understanding.offer_fact_review;
      if (context.current_listing_availability?.source !== 'live_etsy_inventory') {
        out.push('current_listing_availability_missing');
      }
      if (factReview?.current_inventory_applied !== true || !factReview.current_offer_summary) {
        out.push('offer_fact_review_did_not_apply_current_inventory');
      }
      const invalidClaims = (Array.isArray(factReview?.claims) ? factReview.claims : [])
        .filter(item => !['current_available', 'inactive', 'unknown'].includes(item.status)
          || !item.source_ids.length
          || !item.rationale);
      if (invalidClaims.length) out.push('offer_fact_review_contains_ungrounded_claims');
    }

    const missingCaptions = platforms.filter(platform => {
      const normalized = caption(understanding?.platform_captions?.[platform], 1600);
      return !normalized || normalized.length < 40;
    });
    if (missingCaptions.length) out.push(`platform_captions_missing_or_too_short: ${missingCaptions.join(', ')}`);

    if (captionReviewRequired && !captionReviewsValid(understanding, platforms)) {
      const missingReviews = platforms.filter(platform => understanding?.platform_caption_reviews?.[platform]?.approved !== true);
      out.push(`platform_caption_reviews_not_approved: ${missingReviews.join(', ') || 'critic metadata or exact reviewed_caption mismatch'}`);
    }
    return out;
  }

  return Object.freeze({ problems });
}
