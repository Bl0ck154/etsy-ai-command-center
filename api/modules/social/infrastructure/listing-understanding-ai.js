function requiredFunction(name, value) {
  if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  return value;
}

/**
 * Bounded listing-understanding AI state machine.
 *
 * All domain policy, normalization, prompt/schema construction, caption review and
 * transport are injected. This adapter owns only the orchestration semantics that
 * historically lived in api/social.js: supplied fast-path reuse, one primary AI
 * attempt, at most two schema/policy repairs, and explicit invalid/error outcomes.
 */
export function createSocialListingUnderstandingAiStrategy({
  normalizeText,
  responsePreview,
  normalizeUnderstanding,
  compactListing,
  isAiConfigured,
  generateWithAi,
  buildOutputSchema,
  buildPrimaryPrompt,
  buildRepairPrompt,
  reviewCaptions,
  isUsable,
  validationProblems,
} = {}) {
  const text = requiredFunction('normalizeText', normalizeText);
  const preview = requiredFunction('responsePreview', responsePreview);
  const normalize = requiredFunction('normalizeUnderstanding', normalizeUnderstanding);
  const compact = requiredFunction('compactListing', compactListing);
  const configured = requiredFunction('isAiConfigured', isAiConfigured);
  const generate = requiredFunction('generateWithAi', generateWithAi);
  const outputSchema = requiredFunction('buildOutputSchema', buildOutputSchema);
  const primaryPrompt = requiredFunction('buildPrimaryPrompt', buildPrimaryPrompt);
  const repairPrompt = requiredFunction('buildRepairPrompt', buildRepairPrompt);
  const review = requiredFunction('reviewCaptions', reviewCaptions);
  const usable = requiredFunction('isUsable', isUsable);
  const problems = requiredFunction('validationProblems', validationProblems);

  async function understand({ listing = {}, context = {}, visualAnalysis = null } = {}) {
    const supplied = normalize(
      context.listing_understanding || listing.listing_understanding,
      'caller_supplied',
    );
    const visionAvailable = visualAnalysis?.available === true
      && Array.isArray(visualAnalysis.images)
      && visualAnalysis.images.length > 0;
    const ownerRevision = text(
      context.owner_revision || context.owner_feedback || context.revision_request,
      1800,
    );
    const ownerRevisionPresent = Boolean(ownerRevision);
    const mediaQualityFeedbackPresent = Array.isArray(context.media_quality_feedback)
      ? context.media_quality_feedback.length > 0
      : Boolean(context.media_quality_feedback && typeof context.media_quality_feedback === 'object');
    const attachVisionProof = understanding => visionAvailable
      ? {
        ...understanding,
        visual_analysis: {
          applied: true,
          provider: text(visualAnalysis.provider, 160),
          image_count: visualAnalysis.images.length,
        },
      }
      : understanding;
    const captionReviewRequired = context.require_ai_caption_quality_review === true;
    const suppliedStrategyValid = usable(
      supplied,
      context,
      captionReviewRequired,
      visualAnalysis,
    );
    if (suppliedStrategyValid
      && !mediaQualityFeedbackPresent
      && !ownerRevisionPresent
      && (!visionAvailable || supplied.visual_analysis?.applied === true)) {
      return supplied;
    }

    const aiConfigured = await configured().catch(() => false);
    if (!aiConfigured) {
      return {
        available: false,
        source: 'ai_unavailable',
        reason: 'External text AI is not configured.',
      };
    }

    const payload = compact(listing, visualAnalysis);
    const promptContext = { ...context };
    delete promptContext.listing_understanding;
    if (!payload.title && !payload.description && !payload.tags.length) {
      return {
        available: false,
        source: 'insufficient_listing_context',
        reason: 'Listing title/description/tags are missing.',
      };
    }

    const system = primaryPrompt();
    const user = JSON.stringify({
      listing: payload,
      campaign_context: promptContext,
      existing_listing_understanding: supplied || null,
    }, null, 2);
    const acceptedAssetIds = [...new Set(
      (Array.isArray(context?.media_generation_resolution?.accepted_assets)
        ? context.media_generation_resolution.accepted_assets
        : [])
        .map(item => text(item?.brief_id, 80))
        .filter(Boolean),
    )];
    const inspectedListingMediaRanks = [...new Set(
      (Array.isArray(payload.media) ? payload.media : [])
        .map(item => Number(item?.rank))
        .filter(rank => Number.isInteger(rank) && rank > 0),
    )];
    const understandingOutputSchema = outputSchema(
      context.platforms || [],
      acceptedAssetIds,
      inspectedListingMediaRanks,
    );

    try {
      const raw = await generate(
        system,
        user,
        understandingOutputSchema,
        { task: 'creative_listing_understanding', maxTokens: 12_000 },
      );
      const normalized = normalize(raw, 'external_ai');
      const reviewedNormalized = normalized && captionReviewRequired
        ? await review({ listing, context, understanding: normalized })
        : normalized;
      if (usable(reviewedNormalized, context, captionReviewRequired, visualAnalysis)) {
        return attachVisionProof(reviewedNormalized);
      }

      let validationIssues = problems(
        reviewedNormalized,
        context,
        captionReviewRequired,
        visualAnalysis,
      );
      const repairSystem = repairPrompt();
      let previousRaw = raw;
      let previousNormalized = reviewedNormalized;
      let repairedRaw = null;

      for (let repairAttempt = 1; repairAttempt <= 2; repairAttempt += 1) {
        repairedRaw = await generate(
          repairSystem,
          JSON.stringify({
            listing: payload,
            campaign_context: promptContext,
            previous_response: previousRaw,
            validation_errors: validationIssues,
            caption_review_feedback: previousNormalized?.platform_caption_reviews || {},
            repair_attempt: repairAttempt,
            repairs_remaining_including_this_one: 3 - repairAttempt,
          }, null, 2),
          understandingOutputSchema,
          { task: `creative_listing_repair_${repairAttempt}`, maxTokens: 12_000 },
        );
        const repaired = normalize(repairedRaw, `external_ai_repair_${repairAttempt}`);
        const reviewedRepaired = repaired && captionReviewRequired
          ? await review({ listing, context, understanding: repaired })
          : repaired;
        if (usable(reviewedRepaired, context, captionReviewRequired, visualAnalysis)) {
          return {
            ...attachVisionProof(reviewedRepaired),
            repair_used: true,
            repair_attempts: repairAttempt,
            raw_preview: preview(raw, 600),
            repair_response_preview: preview(repairedRaw, 600),
          };
        }
        validationIssues = problems(
          reviewedRepaired,
          context,
          captionReviewRequired,
          visualAnalysis,
        );
        previousRaw = repairedRaw;
        previousNormalized = reviewedRepaired;
      }

      return {
        available: false,
        source: 'ai_invalid_response',
        reason: `External AI did not return a usable listing understanding after 2 repair attempts: ${validationIssues.join('; ') || 'unknown schema mismatch'}`,
        validation_problems: validationIssues,
        media_strategy: previousNormalized?.media_strategy || null,
        platform_captions: previousNormalized?.platform_captions || {},
        platform_caption_reviews: previousNormalized?.platform_caption_reviews || {},
        caption_review_source: previousNormalized?.caption_review_source || '',
        raw_preview: preview(raw, 600),
        repair_response_preview: preview(repairedRaw, 600),
      };
    } catch (error) {
      return {
        available: false,
        source: 'ai_error',
        reason: text(error?.message || error, 240),
      };
    }
  }

  return Object.freeze({ understand });
}
