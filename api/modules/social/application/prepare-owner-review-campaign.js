import { buildSocialOwnerReviewCreativePlanInput } from './build-owner-review-plan-input.js';

function text(value) {
  return String(value ?? '').trim();
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function requireMethod(owner, method, name) {
  if (!owner || typeof owner[method] !== 'function') throw new TypeError(`${name} dependency is required`);
  return (...args) => owner[method](...args);
}

function exactListing({ listing, opportunity, context }) {
  if (plainObject(listing)) return listing;
  if (plainObject(opportunity?.listing)) return opportunity.listing;
  const candidates = (Array.isArray(opportunity?.listing_candidates) ? opportunity.listing_candidates : [])
    .filter(candidate => plainObject(candidate));
  if (candidates.length === 1) return candidates[0];
  const selectedId = text(opportunity?.listing_id || opportunity?.selected_listing_id);
  if (selectedId) {
    const matches = (Array.isArray(context?.listings) ? context.listings : [])
      .filter(candidate => text(candidate?.listing_id || candidate?.id) === selectedId);
    if (matches.length === 1) return matches[0];
  }
  throw codedError(
    'SOCIAL_OWNER_REVIEW_EXACT_LISTING_REQUIRED',
    'Owner-review campaign preparation requires exactly one AI-selected listing; it will not rank or choose candidates locally.',
    { candidate_count: candidates.length, selected_listing_id: selectedId },
  );
}

/**
 * Worker-independent composition of exact opportunity/listing input, bounded
 * planning/generation, and complete owner-review record materialization.
 */
export function createSocialOwnerReviewCampaignPreparationService({
  coordinator,
  campaignRecordBuilder,
  buildPlanInput = buildSocialOwnerReviewCreativePlanInput,
} = {}) {
  const coordinate = requireMethod(coordinator, 'prepare', 'coordinator.prepare');
  const buildRecords = requireMethod(campaignRecordBuilder, 'build', 'campaignRecordBuilder.build');
  if (typeof buildPlanInput !== 'function') throw new TypeError('buildPlanInput dependency is required');

  const prepareOwnerReviewCampaign = async ({
    input = {},
    context = {},
    opportunity = {},
    listing,
    configuredPlatforms,
    currentResearch,
    queueAccounting,
    queueRecordsCreated,
    queueRecordDeficit,
    ownerFeedbackMemory,
    blockedMedia,
    existingIds,
    signal,
    deadline_at: deadlineAt,
    publicBaseUrl = '',
  } = {}) => {
    const selectedListing = exactListing({ listing, opportunity, context });
    const exactInput = buildPlanInput({
      listing: selectedListing,
      opportunity,
      configuredPlatforms: configuredPlatforms || input.platforms || context.configured_platforms || [],
      currentResearch: currentResearch || input.current_research || context.current_research || {},
      queueAccounting: queueAccounting || input.queue_accounting || context.queue_accounting || {},
      queueRecordsCreated: queueRecordsCreated ?? input.queue_records_created ?? 0,
      queueRecordDeficit: queueRecordDeficit ?? input.queue_record_deficit ?? 0,
      ownerFeedbackMemory: ownerFeedbackMemory || input.owner_feedback_memory || context.owner_feedback_memory || {},
    });
    const coordinated = await coordinate({
      planBody: exactInput.body,
      listing: selectedListing,
      opportunity,
      platforms: exactInput.platforms,
      signal,
      deadline_at: deadlineAt,
      publicBaseUrl,
    });
    const packageResult = await buildRecords({
      plan: coordinated.plan,
      listing: selectedListing,
      opportunity,
      platforms: exactInput.platforms,
      blockedMedia: blockedMedia instanceof Set
        ? blockedMedia
        : new Set(Array.isArray(input.blocked_media) ? input.blocked_media : []),
      existingIds: existingIds instanceof Set
        ? existingIds
        : new Set(Array.isArray(input.existing_ids) ? input.existing_ids : []),
      generationDiagnostics: coordinated.generation_diagnostics,
    });
    return {
      ...packageResult,
      status: 'ready_for_review',
      plan: coordinated.plan,
      generated_media: coordinated.generated_media,
      generation_diagnostics: coordinated.generation_diagnostics,
      generation_rounds: coordinated.generation_rounds,
      published: false,
    };
  };

  return { prepareOwnerReviewCampaign };
}
