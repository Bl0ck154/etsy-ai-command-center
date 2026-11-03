const SUPPORTED_PLATFORMS = new Set(['instagram', 'facebook', 'pinterest', 'tiktok']);

function text(value) {
  return String(value ?? '').trim();
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Deterministic input contract for the autonomous creativePlan stage.
 * Opportunity/listing/platform choices are already owned by upstream AI. This
 * function binds those exact choices to the production planning requirements;
 * it never chooses a replacement listing, platform, campaign context, or
 * research claim.
 */
export function buildSocialOwnerReviewCreativePlanInput({
  listing = {},
  opportunity = {},
  configuredPlatforms = [],
  currentResearch = {},
  queueAccounting = {},
  queueRecordsCreated = 0,
  queueRecordDeficit = 0,
  ownerFeedbackMemory = {},
} = {}) {
  const listingId = text(listing?.listing_id || listing?.id);
  if (!listingId) {
    throw codedError('SOCIAL_OWNER_REVIEW_LISTING_REQUIRED', 'AI-selected opportunity requires an exact listing id.');
  }
  const title = text(listing?.title || 'Custom digital service');
  const campaignLabel = text(opportunity?.moment || opportunity?.type || 'ai-selected campaign');
  const campaignContext = text(opportunity?.campaign_context || opportunity?.reason);
  if (!campaignContext) {
    throw codedError(
      'SOCIAL_OWNER_REVIEW_CAMPAIGN_CONTEXT_REQUIRED',
      'AI-selected opportunity is missing campaign_context/reason; producer will not invent one.',
    );
  }

  const configured = new Set((Array.isArray(configuredPlatforms) ? configuredPlatforms : [])
    .map(platform => text(platform).toLowerCase())
    .filter(platform => SUPPORTED_PLATFORMS.has(platform)));
  const campaignPlatforms = [...new Set((Array.isArray(opportunity?.suggested_platforms) ? opportunity.suggested_platforms : [])
    .map(platform => text(platform).toLowerCase())
    .filter(platform => configured.has(platform)))];
  if (!campaignPlatforms.length) {
    throw codedError(
      'SOCIAL_OWNER_REVIEW_CAMPAIGN_PLATFORM_REQUIRED',
      'AI-selected opportunity has no configured suggested platforms; producer will not default to every platform.',
    );
  }

  const verifiedCurrentResearch = opportunity?.research_basis === 'verified_current_research'
    && currentResearch?.external_research_used === true
      ? currentResearch
      : null;
  const accounting = plainObject(queueAccounting) || {};
  const createdCount = Math.max(0, Number.parseInt(queueRecordsCreated, 10) || 0);
  const deficit = Math.max(0, Number.parseInt(queueRecordDeficit, 10) || 0);
  const context = {
    audience: opportunity?.audience || '',
    occasion: opportunity?.occasion || opportunity?.moment || '',
    campaign_context: campaignContext,
    current_research: verifiedCurrentResearch,
    source_opportunity_type: opportunity?.type || '',
    ai_opportunity_reason: opportunity?.reason || '',
    social_factory_path: true,
    require_vision_for_social_hero: true,
    require_ai_caption_quality_review: true,
    require_campaign_visual_quality_review: true,
    require_current_listing_facts: true,
    factory_path: 'social_autonomous_content_factory',
    contextual_scene: false,
    queue_accounting: {
      ...accounting,
      created_this_run: createdCount,
      remaining_capacity: Math.max(0, deficit - createdCount),
      whole_campaign_overflow_allowed: true,
    },
    owner_feedback_memory: plainObject(ownerFeedbackMemory) || {},
  };
  if (plainObject(opportunity?.selected_review)) context.selected_review = opportunity.selected_review;

  return {
    listing_id: listingId,
    campaign_label: campaignLabel,
    campaign_context: campaignContext,
    platforms: campaignPlatforms,
    body: {
      listing: {
        ...listing,
        listing_id: listingId,
        title,
        ...(plainObject(opportunity?.listing_campaign_fit)
          ? { listing_campaign_fit: opportunity.listing_campaign_fit }
          : {}),
        ...(plainObject(opportunity?.listing_understanding)
          ? { listing_understanding: opportunity.listing_understanding }
          : {}),
      },
      context,
      platforms: campaignPlatforms,
      generated_media: [],
    },
  };
}

/**
 * Carry only server-returned factual/AI state into a bounded creativePlan
 * replan. This mirrors the active Python producer and does not create a local
 * repair decision.
 */
export function applySocialOwnerReviewCreativePlanRefresh(planBody = {}, plan = {}) {
  if (!plainObject(planBody) || !plainObject(plan)) return planBody;
  if (plainObject(plan.visual_analysis)) planBody.visual_analysis = plan.visual_analysis;
  if (plainObject(plan.listing_understanding)) {
    planBody.listing = plainObject(planBody.listing) || {};
    planBody.listing.listing_understanding = plan.listing_understanding;
  }
  if (plainObject(plan.current_listing_availability)) {
    planBody.listing = plainObject(planBody.listing) || {};
    planBody.listing.current_availability = plan.current_listing_availability;
  }
  return planBody;
}
