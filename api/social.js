// api/social.js — Social media cross-posting
import { requireAuth, requireSocialHermesAuth } from './_auth.js';
import { sendPublicError } from './_errors.js';
import {
  applyMakeCallback,
  approveScheduledPost,
  classifyScheduledPost,
  getSchedulerStatus,
  publishGovernanceStatus,
  recoverQueuedExternalPostToDraft,
  restoreScheduledPostToDraft,
  unapproveScheduledPost,
} from './_scheduler.js';
import {
  armSocialHermesExistingQueue,
  buildSocialHermesSnapshotFacts,
  buildSocialListingUnderstandingOutputSchema,
  buildSocialListingUnderstandingRepairPrompt,
  buildSocialListingUnderstandingSystemPrompt,
  collectSocialHermesEtsyPages,
  consumeSocialHermesReviewArtifact,
  createSocialContentOpportunityService,
  createSocialContentOpportunitySemanticFilter,
  createSocialCampaignFitAiStrategy,
  createSocialCaptionReviewAiStrategy,
  createSocialCaptionReviewContracts,
  createSocialCreativePlanProductionService,
  createSocialListingUnderstandingValidationService,
  createSocialListingUnderstandingUsabilityService,
  createSocialListingUnderstandingNormalizer,
  createSocialAiPlanningPayloadBuilder,
  createSocialListingUnderstandingAiStrategy,
  createSocialMediaStrategyValidationRules,
  deleteScheduledPost,
  deliverSocialHermesOwnerReviewNotification,
  expandSocialHermesOwnerReviewRecord,
  getScheduledPosts,
  getSafeSocialHermesContext,
  getSocialHermesAutonomousContextMemory,
  getSocialHermesCanaryReadiness as getSocialHermesCanaryReadinessFromModule,
  getSocialHermesListingMedia,
  generateSocialHermesMedia,
  issueSocialHermesReviewArtifact,
  loadSocialHermesMakeRoute as getMakeWebhookUrl,
  normalizeSocialHermesPlatformCaptionVariants,
  normalizeSocialHermesPlatformId,
  normalizeSocialHermesPlatformToken,
  normalizeSocialHermesListingImage,
  normalizeSocialOwnerFeedbackMemory,
  normalizeSocialMediaMimeType as normalizeImageMimeType,
  publishSocialHermesDueScheduled,
  readPersistentSocialMediaAsset as readSocialMediaAssetFromStore,
  refreshSocialHermesShopContext,
  resolveSocialHermesConfiguredPlatforms,
  resolveSocialHermesMetricoolPlatformsFromConfig,
  resolveSocialHermesPublishCapablePlatforms,
  resolveSocialHermesPublishRoute,
  resolveSocialHermesRequestedPlatforms,
  SOCIAL_HERMES_ACTION_NAMES,
  normalizeGeneratedSocialImageGeometry,
  saveScheduledPost,
  saveSocialHermesOwnerRequestedSchedule,
  saveSocialHermesOwnerReviewDrafts,
  safeSocialHermesContextPayload,
  socialHermesCanaryReadinessForPost,
  socialHermesCaptionQualityProblem,
  socialHermesCarouselMediaReadinessError,
  socialHermesRecordEligibleForAutoArm,
  socialHermesRecordHasForbiddenFallbackMedia,
  socialHermesRecordHasPublicMedia,
  socialHermesReviewContentDigest,
  socialHermesOwnerNotificationMessage,
  socialMediaExtensionForMimeType as extensionForMimeType,
  storePersistentSocialMediaAsset as storeSocialMediaAssetInStore,
  socialHermesUiPlatformCapabilityContext,
  summarizeSocialHermesReview,
  summarizeSocialHermesSocialConfigs,
  updateScheduledPost,
  evaluateSocialHermesPublishReadiness,
  mergeSocialHermesSourceSnapshots,
} from './modules/social/index.js';
import { kvGet, kvSet } from './kv.js';
import { etsyFetch, getListingWithInventory, getShopId } from './_etsy.js';
import { generateWithExternalAi, getExternalImageCapabilities, hasExternalAiConfigAsync, getExternalAiRuntimeConfig } from './_external-ai.js';
import crypto from 'crypto';
import {
  socialAspectRatioFitsPlatform,
  socialPlatformMediaContracts,
} from './_social-platform-capabilities.js';
import { scheduledPostMediaSafetyError } from './_social-media-safety.js';
import {
  normalizeSocialReviewCardDesign,
} from './_social-review-card.js';
import { analyzeSocialListingImages, reviewSocialCampaignMedia } from './_social-media-quality.js';

export {
  resolveSocialHermesConfiguredPlatforms,
  resolveSocialHermesPublishCapablePlatforms,
  buildSocialHermesSnapshotFacts,
  collectSocialHermesEtsyPages,
  getSafeSocialHermesContext,
  mergeSocialHermesSourceSnapshots,
  refreshSocialHermesShopContext,
  safeSocialHermesContextPayload,
  socialHermesCanaryReadinessForPost,
  socialHermesOwnerNotificationMessage,
  socialHermesReviewContentDigest,
  socialHermesUiPlatformCapabilityContext,
  summarizeSocialHermesReview,
  summarizeSocialHermesSocialConfigs,
  normalizeGeneratedSocialImageGeometry,
};
// Strategy: Instagram/Facebook publish through Etsy AI Command Center using the saved Meta settings.
// Pinterest uses the Make.com webhook bridge because direct Pinterest API access is not viable here.
// TikTok remains Buffer/Metricool/manual-only.

export const maxDuration = 45;
process.on('unhandledRejection', (err) => console.error('[social]', err?.message));

function generateWithSocialAi(systemPrompt, userPrompt, structuredOutputSchema = null, taskOptions = {}) {
  const model = String(process.env.SOCIAL_AI_MODEL || '').trim();
  const configuredMaxTokens = Number(process.env.SOCIAL_AI_MAX_TOKENS);
  const requestedMaxTokens = Number(taskOptions.maxTokens);
  const maxTokens = Number.isFinite(requestedMaxTokens)
    ? Math.max(1_000, Math.min(32_000, Math.round(requestedMaxTokens)))
    : Number.isFinite(configuredMaxTokens)
    ? Math.max(4_000, Math.min(32_000, Math.round(configuredMaxTokens)))
    : 12_000;
  const task = socialAiText(taskOptions.task || 'social_ai', 80);
  return generateWithExternalAi(systemPrompt, userPrompt, model, {
    preferRequestedModel: Boolean(model),
    maxTokens,
    temperature: 0.2,
    structuredOutput: true,
    ...(structuredOutputSchema ? { structuredOutputSchema } : {}),
    onUsage: usage => console.info('[social-ai-usage]', JSON.stringify({
      task,
      max_tokens: maxTokens,
      system_prompt_chars: String(systemPrompt || '').length,
      user_prompt_chars: String(userPrompt || '').length,
      schema_chars: structuredOutputSchema ? JSON.stringify(structuredOutputSchema).length : 0,
      ...usage,
    })),
  });
}

function socialAiText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function socialOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function aiResponsePreview(value, max = 700) {
  if (typeof value === 'string') return socialAiText(value, max);
  try {
    return socialAiText(JSON.stringify(value), max);
  } catch {
    return socialAiText(value, max);
  }
}

function socialAiCaption(value, max = 1600) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function socialAiStringList(value, maxItems = 8, maxChars = 120) {
  return (Array.isArray(value) ? value : [])
    .map(item => socialAiText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function socialCampaignQualityBlockingSummary(review = {}) {
  const reasons = socialAiStringList(review.blocking_reasons, 12, 500);
  if (reasons.length) return socialAiText(`Campaign visual quality blocked: ${reasons.join('; ')}`, 4000);
  return socialAiText(
    review.rationale || 'Campaign-level AI vision review did not approve the media package.',
    4000,
  );
}

export function buildSocialListingAvailabilitySnapshot(listing = {}) {
  const products = Array.isArray(listing?.inventory?.products) ? listing.inventory.products : [];
  const activeByProperty = new Map();
  const allByProperty = new Map();
  const activeCombinations = [];
  let activeOfferingCount = 0;
  let inactiveOfferingCount = 0;
  const addValue = (target, propertyName, value) => {
    const name = socialAiText(propertyName || 'Variation', 120);
    const clean = socialAiText(value, 160);
    if (!name || !clean) return;
    if (!target.has(name)) target.set(name, new Set());
    target.get(name).add(clean);
  };
  for (const product of products) {
    const propertyValues = (Array.isArray(product?.property_values) ? product.property_values : [])
      .flatMap(property => (Array.isArray(property?.values) ? property.values : []).map(value => ({
        property: socialAiText(property?.property_name || property?.property_id, 120),
        value: socialAiText(value, 160),
      })))
      .filter(item => item.property && item.value);
    propertyValues.forEach(item => addValue(allByProperty, item.property, item.value));
    const activeOfferings = (Array.isArray(product?.offerings) ? product.offerings : [])
      .filter(offering => offering?.is_enabled === true && offering?.is_deleted !== true);
    const inactiveOfferings = (Array.isArray(product?.offerings) ? product.offerings : [])
      .filter(offering => offering?.is_enabled !== true || offering?.is_deleted === true);
    activeOfferingCount += activeOfferings.length;
    inactiveOfferingCount += inactiveOfferings.length;
    if (!activeOfferings.length) continue;
    propertyValues.forEach(item => addValue(activeByProperty, item.property, item.value));
    if (activeCombinations.length < 40) {
      activeCombinations.push(Object.fromEntries(propertyValues.map(item => [item.property, item.value])));
    }
  }
  const variationAvailability = [...allByProperty.entries()].map(([property, allValues]) => {
    const activeValues = activeByProperty.get(property) || new Set();
    return {
      property,
      active_values: [...activeValues].slice(0, 40),
      inactive_only_values: [...allValues].filter(value => !activeValues.has(value)).slice(0, 40),
    };
  });
  return {
    source: 'live_etsy_inventory',
    listing_id: socialAiText(listing.listing_id || listing.id, 80),
    active_offering_count: activeOfferingCount,
    inactive_offering_count: inactiveOfferingCount,
    active_variation_combinations: activeCombinations,
    variation_availability: variationAvailability,
    shipping_profile_present: Boolean(listing.shipping_profile_id),
    processing_min_days: Number.isFinite(Number(listing.processing_min)) ? Number(listing.processing_min) : null,
    processing_max_days: Number.isFinite(Number(listing.processing_max)) ? Number(listing.processing_max) : null,
  };
}

async function hydrateCurrentSocialListingFacts(listing = {}) {
  const listingId = Number(listing.listing_id || listing.id);
  if (!Number.isSafeInteger(listingId) || listingId <= 0) {
    throw new Error('A numeric Etsy listing_id is required for current listing facts.');
  }
  const current = await getListingWithInventory(listingId, ['images']);
  return {
    ...listing,
    ...current,
    listing_id: String(listingId),
    current_availability: buildSocialListingAvailabilitySnapshot(current),
  };
}

export function buildSocialMediaGenerationResolution(resolution = null, generatedMedia = []) {
  const supplied = resolution && typeof resolution === 'object' && !Array.isArray(resolution)
    ? resolution
    : {};
  const acceptedAssets = (Array.isArray(generatedMedia) ? generatedMedia : [])
    .filter(item => item && typeof item === 'object')
    .slice(0, 7)
    .map(item => ({
      id: socialAiText(item.id, 120),
      brief_id: socialAiText(item.brief_id, 160),
      source: socialAiText(item.source, 80),
      url: socialAiText(item.url, 1000),
      permanent: item.permanent === true,
      quality_approved: item.source === 'review_card' || item.quality_review?.approved === true,
      quality_rationale: socialAiText(item.quality_review?.rationale, 500),
      review_id: socialAiText(item.review_id || item.review_evidence?.review_id, 120) || null,
      context_note: socialAiText(item.context_note, 180),
      review_card_design: normalizeSocialReviewCardDesign(item.review_card_design),
      aspect_ratio: socialAiText(item.aspect_ratio || item.requested_aspect_ratio, 20) || null,
      render_spec_sha256: /^[a-f0-9]{64}$/i.test(String(item.render_spec_sha256 || ''))
        ? String(item.render_spec_sha256).toLowerCase()
        : null,
    }))
    .filter(item => item.url);
  const hasSuppliedFacts = Object.keys(supplied).length > 0;
  if (!hasSuppliedFacts && !acceptedAssets.length) return null;
  return {
    ...supplied,
    phase: socialAiText(supplied.phase || 'post_generation_replan', 80),
    accepted_assets: acceptedAssets.length
      ? acceptedAssets
      : (Array.isArray(supplied.accepted_assets) ? supplied.accepted_assets : []),
  };
}

const socialListingUnderstandingNormalizer = createSocialListingUnderstandingNormalizer({
  normalizeText: socialAiText,
  normalizeCaption: socialAiCaption,
  normalizeStringList: socialAiStringList,
  normalizeReviewCardDesign: normalizeSocialReviewCardDesign,
  normalizeCaptionReviews: normalizeAiPlatformCaptionReviews,
});

function normalizeAiPlatformVariants(raw = {}) {
  return socialListingUnderstandingNormalizer.normalizePlatformVariants(raw);
}

function normalizeAiAcceptedAssetDecisions(raw = []) {
  return socialListingUnderstandingNormalizer.normalizeAcceptedAssetDecisions(raw);
}

function normalizeOfferFactReview(raw = {}) {
  return socialListingUnderstandingNormalizer.normalizeOfferFactReview(raw);
}

function normalizeAiMediaStrategy(raw = {}) {
  return socialListingUnderstandingNormalizer.normalizeMediaStrategy(raw);
}

const socialMediaStrategyValidationRules = createSocialMediaStrategyValidationRules({
  normalizeText: socialAiText,
  aspectRatioFitsPlatform: socialAspectRatioFitsPlatform,
  normalizeReviewCardDesign: normalizeSocialReviewCardDesign,
});

function validAiMediaStrategy(strategy, platforms = []) {
  return socialMediaStrategyValidationRules.valid(strategy, platforms);
}

function aiMediaStrategyValidationProblems(strategy, platforms = []) {
  return socialMediaStrategyValidationRules.structuralProblems(strategy, platforms);
}

function aiMediaStrategyVisionSelectionProblems(strategy, visualAnalysis = null) {
  return socialMediaStrategyValidationRules.visionSelectionProblems(strategy, visualAnalysis);
}

function aiMediaStrategyCapabilityProblems(strategy, context = {}) {
  return socialMediaStrategyValidationRules.capabilityProblems(strategy, context);
}

function aiMediaStrategyPlatformRatioProblems(strategy, platforms = []) {
  return socialMediaStrategyValidationRules.platformRatioProblems(strategy, platforms);
}

function aiMediaStrategyAcceptedAssetDecisionProblems(strategy, context = {}) {
  return socialMediaStrategyValidationRules.acceptedAssetDecisionProblems(strategy, context);
}

function aiMediaStrategyBuyerEvidenceProblems(strategy, context = {}) {
  return socialMediaStrategyValidationRules.buyerEvidenceProblems(strategy, context);
}

export function aiMediaStrategyPlatformRatioProblemsForTest(strategy, platforms = []) {
  return aiMediaStrategyPlatformRatioProblems(strategy, platforms);
}

export function aiMediaStrategyAcceptedAssetDecisionProblemsForTest(strategy, context = {}) {
  return aiMediaStrategyAcceptedAssetDecisionProblems(strategy, context);
}

export function aiMediaStrategyCapabilityProblemsForTest(strategy, context = {}) {
  return aiMediaStrategyCapabilityProblems(strategy, context);
}

const socialCaptionReviewContracts = createSocialCaptionReviewContracts({
  normalizeText: socialAiText,
  normalizeCaption: socialAiCaption,
});

function validAiPlatformCaptions(understanding = {}, platforms = []) {
  return socialCaptionReviewContracts.validPlatformCaptions(understanding, platforms);
}

function normalizeAiPlatformCaptionReviews(raw = {}, captions = {}) {
  return socialCaptionReviewContracts.normalizeReviews(raw, captions);
}

function enforcePlatformCaptionRoutePolicy(reviews = {}, captions = {}, platforms = [], listingUrl = '') {
  return socialCaptionReviewContracts.enforceRoutePolicy(reviews, captions, platforms, listingUrl);
}

export function enforcePlatformCaptionRoutePolicyForTest(reviews = {}, captions = {}, platforms = [], listingUrl = '') {
  return enforcePlatformCaptionRoutePolicy(reviews, captions, platforms, listingUrl);
}

function validAiPlatformCaptionReviews(understanding = {}, platforms = []) {
  return socialCaptionReviewContracts.validReviews(understanding, platforms);
}

const socialListingUnderstandingValidationService = createSocialListingUnderstandingValidationService({
  requiresMediaStrategy: socialContextRequiresAiMediaStrategy,
  validMediaStrategy: validAiMediaStrategy,
  mediaStrategyValidationProblems: aiMediaStrategyValidationProblems,
  visionSelectionProblems: aiMediaStrategyVisionSelectionProblems,
  capabilityProblems: aiMediaStrategyCapabilityProblems,
  platformRatioProblems: aiMediaStrategyPlatformRatioProblems,
  acceptedAssetDecisionProblems: aiMediaStrategyAcceptedAssetDecisionProblems,
  buyerEvidenceProblems: aiMediaStrategyBuyerEvidenceProblems,
  normalizeCaption: socialAiCaption,
  validCaptionReviews: validAiPlatformCaptionReviews,
});

const socialListingUnderstandingUsabilityService = createSocialListingUnderstandingUsabilityService({
  requiresMediaStrategy: socialContextRequiresAiMediaStrategy,
  validMediaStrategy: validAiMediaStrategy,
  visionSelectionProblems: aiMediaStrategyVisionSelectionProblems,
  capabilityProblems: aiMediaStrategyCapabilityProblems,
  platformRatioProblems: aiMediaStrategyPlatformRatioProblems,
  acceptedAssetDecisionProblems: aiMediaStrategyAcceptedAssetDecisionProblems,
  buyerEvidenceProblems: aiMediaStrategyBuyerEvidenceProblems,
  validPlatformCaptions: validAiPlatformCaptions,
  validCaptionReviews: validAiPlatformCaptionReviews,
});

function isUsableListingUnderstanding(understanding, context = {}, captionReviewRequired = false, visualAnalysis = null) {
  return socialListingUnderstandingUsabilityService.isUsable(
    understanding,
    context,
    captionReviewRequired,
    visualAnalysis,
  );
}

export function listingUnderstandingValidationProblems(understanding, context = {}, captionReviewRequired = false, visualAnalysis = null) {
  return socialListingUnderstandingValidationService.problems(
    understanding,
    context,
    captionReviewRequired,
    visualAnalysis,
  );
}

const socialCaptionReviewAiStrategy = createSocialCaptionReviewAiStrategy({
  normalizeText: socialAiText,
  compactListing: compactListingForAiUnderstanding,
  compactCampaignContext: compactCampaignContextForAi,
  outputSchema: platformCaptionReviewOutputSchema,
  generateWithAi: generateWithSocialAi,
  getRuntimeConfig: getExternalAiRuntimeConfig,
  normalizeReviews: normalizeAiPlatformCaptionReviews,
  enforceRoutePolicy: enforcePlatformCaptionRoutePolicy,
});

async function reviewPlatformCaptionsWithAi(input = {}) {
  return socialCaptionReviewAiStrategy.review(input);
}

function socialCurrentDateContext(value = Date.now()) {
  const date = new Date(value || Date.now());
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  return {
    current_date: valid.toISOString().slice(0, 10),
    current_year: valid.getUTCFullYear(),
    current_iso: valid.toISOString(),
  };
}

function normalizeListingUnderstanding(raw = {}, source = 'ai') {
  return socialListingUnderstandingNormalizer.normalize(raw, source);
}

function socialContextRequiresAiMediaStrategy(context = {}) {
  return context.require_ai_media_strategy === true
    || context.ai_media_strategy_required === true
    || context.social_media_strategy_required === true
    || context.social_factory_path === true
    || socialAiText(context.factory_path, 160) === 'social_autonomous_content_factory';
}

function normalizeListingCampaignFit(raw = {}, source = 'ai') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const decision = socialAiText(raw.decision, 80).toLowerCase();
  if (!['strong_fit', 'acceptable_fit', 'weak_fit', 'mismatch'].includes(decision)) return null;
  if (typeof raw.should_use_listing !== 'boolean') return null;
  const shouldUseListing = ['strong_fit', 'acceptable_fit'].includes(decision);
  if (raw.should_use_listing !== shouldUseListing) return null;
  const rationale = socialAiText(raw.rationale, 420);
  if (!rationale) return null;
  const confidence = Number(raw.confidence);
  return {
    available: true,
    source,
    decision,
    should_use_listing: shouldUseListing,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    rationale,
    natural_connection: socialAiText(raw.natural_connection, 260),
    safer_angle: socialAiText(raw.safer_angle, 260),
    risks: socialAiStringList(raw.risks, 8, 160),
    evidence: socialAiStringList(raw.evidence, 8, 180),
  };
}

const socialAiPlanningPayloadBuilder = createSocialAiPlanningPayloadBuilder({
  normalizeText: socialAiText,
  normalizeStringList: socialAiStringList,
});

function compactCampaignContextForAi(context = {}) {
  return socialAiPlanningPayloadBuilder.compactCampaignContext(context);
}

function compactListingForAiUnderstanding(listing = {}, visualAnalysis = null) {
  return socialAiPlanningPayloadBuilder.compactListingForUnderstanding(listing, visualAnalysis);
}

const socialListingUnderstandingAiStrategy = createSocialListingUnderstandingAiStrategy({
  normalizeText: socialAiText,
  responsePreview: aiResponsePreview,
  normalizeUnderstanding: normalizeListingUnderstanding,
  compactListing: compactListingForAiUnderstanding,
  isAiConfigured: hasExternalAiConfigAsync,
  generateWithAi: generateWithSocialAi,
  buildOutputSchema: buildSocialListingUnderstandingOutputSchema,
  buildPrimaryPrompt: buildSocialListingUnderstandingSystemPrompt,
  buildRepairPrompt: buildSocialListingUnderstandingRepairPrompt,
  reviewCaptions: reviewPlatformCaptionsWithAi,
  isUsable: isUsableListingUnderstanding,
  validationProblems: listingUnderstandingValidationProblems,
});

async function buildListingUnderstandingWithAi({ listing = {}, context = {}, visualAnalysis = null } = {}) {
  return socialListingUnderstandingAiStrategy.understand({ listing, context, visualAnalysis });
}

async function planSocialOwnerFollowupWithAi({ ownerFeedback = '', currentPreview = null } = {}) {
  const feedback = socialAiText(ownerFeedback, 2400);
  if (!feedback) return { available: false, code: 'OWNER_FEEDBACK_REQUIRED', reason: 'owner_feedback is required.' };
  const configured = await hasExternalAiConfigAsync().catch(() => false);
  if (!configured) return { available: false, code: 'AI_REQUIRED', reason: 'External text AI is required to interpret conversational owner feedback.' };
  const system = [
    'You classify a Telegram owner follow-up to the current Etsy social owner-review preview.',
    'Use semantic reasoning over the complete feedback and preview context. Do not use keyword rules or a fixed product taxonomy.',
    'intent must be exactly one of revision, status, approve, schedule, cancel, question, new_request, other.',
    'Choose revision when the owner asks to change, remove, replace, regenerate, re-order, strengthen, or reconsider any creative choice, including naturally worded criticism that never says regenerate.',
    'Choose approve or schedule only when the owner affirmatively asks for that action. A negated action such as "do not schedule" is never approval or scheduling intent. cancel includes either an explicit cancellation request or a natural rejection of the whole current proposal such as "I do not need this post", "this idea is not needed", "таке не треба", or an equivalent statement when it contains no request for a replacement or modification. Treat rejection of one frame, caption, platform choice, or other part as revision only when the owner asks to remove/change that part or otherwise continue the proposal.',
    'Resolve the scope of demonstratives from the supplied conversation. A short rejection such as "not this", "I do not need that", "таке не треба", or "це не потрібно" with no named frame/caption/platform and no requested replacement refers to the whole current_preview and MUST be intent=cancel. Do not invent a revision goal such as simplify, improve, regenerate, or try another version. intent=revision requires positive evidence that the owner wants the proposal to continue: a named part to change/remove, a requested replacement, or a concrete desired outcome.',
    'Choose new_request only when the owner clearly starts a separate post/research request rather than changing the current preview. Set new_request_kind to create_content or research_opportunity.',
    'For revision, preserve the exact listing identity and convert every owner concern into a concise revision_brief for the downstream creative AI. Identify affected creative areas semantically, such as hero, frame set/order, caption, or platform coverage, without inventing changes the owner did not request. Return required_revision_outcomes for concrete results the owner expects and rejected_creative_functions for the semantic purposes the owner rejected, so downstream planning cannot reintroduce the same unwanted idea under another frame name.',
    'Return required_platforms for platforms the owner explicitly adds or requires. Return requested_platforms/requested_format only for a separate new request. schedule_text must contain only the owner-supplied scheduling phrase, or be empty.',
    'Revision feedback is not approval to save, schedule, publish, or enable autopublish.',
    'Decide whether any owner correction is a reusable future creative preference. future_preference_scope must be none for a one-off frame correction, listing when the principle should apply to future campaigns for this exact listing, or shop when it is a durable shop-wide creative preference. Put only reusable semantic constraints in future_creative_preferences; do not turn every edit into a permanent rule.',
    'Return ONLY valid JSON with keys: intent, rationale, revision_brief, affected_areas, platform_questions, required_revision_outcomes, rejected_creative_functions, required_platforms, new_request_kind, requested_platforms, requested_format, schedule_text, future_preference_scope, future_creative_preferences, publish_authorized.',
    'affected_areas, platform_questions, required_revision_outcomes, and rejected_creative_functions must be arrays of short natural-language strings. Platform arrays may contain only instagram, facebook, pinterest, or tiktok. requested_format must be single, carousel, ai_decide, or empty. publish_authorized must always be false.',
  ].join(' ');
  const followupOutputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'rationale', 'revision_brief', 'affected_areas', 'platform_questions', 'required_revision_outcomes', 'rejected_creative_functions', 'required_platforms', 'new_request_kind', 'requested_platforms', 'requested_format', 'schedule_text', 'future_preference_scope', 'future_creative_preferences', 'publish_authorized'],
    properties: {
      intent: {
        type: 'string',
        enum: ['revision', 'status', 'approve', 'schedule', 'cancel', 'question', 'new_request', 'other'],
        description: 'Scope-sensitive owner intent. Use cancel for rejection of the whole current preview when no replacement or modification is requested, including short demonstratives such as "not this" or "таке не треба". Use revision only with positive evidence that the owner wants the current proposal to continue after a named or concrete change.',
      },
      rationale: { type: 'string' },
      revision_brief: { type: 'string', description: 'Concrete requested changes only. Must be empty for cancel; never invent simplify, improve, regenerate, or replacement instructions from a whole-preview rejection.' },
      affected_areas: { type: 'array', items: { type: 'string' } },
      platform_questions: { type: 'array', items: { type: 'string' } },
      required_revision_outcomes: { type: 'array', items: { type: 'string' } },
      rejected_creative_functions: { type: 'array', items: { type: 'string' } },
      required_platforms: { type: 'array', items: { type: 'string', enum: ['instagram', 'facebook', 'pinterest', 'tiktok'] } },
      new_request_kind: { type: 'string', enum: ['', 'create_content', 'research_opportunity'] },
      requested_platforms: { type: 'array', items: { type: 'string', enum: ['instagram', 'facebook', 'pinterest', 'tiktok'] } },
      requested_format: { type: 'string', enum: ['', 'single', 'carousel', 'ai_decide'] },
      schedule_text: { type: 'string' },
      future_preference_scope: { type: 'string', enum: ['none', 'listing', 'shop'] },
      future_creative_preferences: { type: 'array', items: { type: 'string' } },
      publish_authorized: { type: 'boolean', enum: [false] },
    },
  };
  try {
    const raw = await generateWithSocialAi(
      system,
      JSON.stringify({
        owner_feedback: feedback,
        current_preview: currentPreview && typeof currentPreview === 'object' ? currentPreview : null,
      }, null, 2),
      followupOutputSchema,
      { task: 'owner_followup_intent', maxTokens: 4_000 },
    );
    const intent = socialAiText(raw?.intent, 40).toLowerCase();
    if (!['revision', 'status', 'approve', 'schedule', 'cancel', 'question', 'new_request', 'other'].includes(intent)) {
      return { available: false, code: 'AI_INVALID_RESPONSE', reason: 'External AI did not return a valid follow-up intent.' };
    }
    const allowedPlatforms = new Set(['instagram', 'facebook', 'pinterest', 'tiktok']);
    const normalizePlatforms = value => Array.isArray(value)
      ? [...new Set(value.map(item => socialAiText(item, 40).toLowerCase()).filter(item => allowedPlatforms.has(item)))].slice(0, 4)
      : [];
    const newRequestKind = ['create_content', 'research_opportunity'].includes(socialAiText(raw?.new_request_kind, 40).toLowerCase())
      ? socialAiText(raw?.new_request_kind, 40).toLowerCase()
      : '';
    const requestedFormat = ['single', 'carousel', 'ai_decide'].includes(socialAiText(raw?.requested_format, 40).toLowerCase())
      ? socialAiText(raw?.requested_format, 40).toLowerCase()
      : '';
    return {
      available: true,
      intent,
      rationale: socialAiText(raw?.rationale, 900),
      revision_brief: socialAiText(raw?.revision_brief, 1800),
      affected_areas: Array.isArray(raw?.affected_areas) ? raw.affected_areas.map(item => socialAiText(item, 120)).filter(Boolean).slice(0, 12) : [],
      platform_questions: Array.isArray(raw?.platform_questions) ? raw.platform_questions.map(item => socialAiText(item, 120)).filter(Boolean).slice(0, 8) : [],
      required_revision_outcomes: Array.isArray(raw?.required_revision_outcomes) ? raw.required_revision_outcomes.map(item => socialAiText(item, 240)).filter(Boolean).slice(0, 12) : [],
      rejected_creative_functions: Array.isArray(raw?.rejected_creative_functions) ? raw.rejected_creative_functions.map(item => socialAiText(item, 240)).filter(Boolean).slice(0, 12) : [],
      required_platforms: normalizePlatforms(raw?.required_platforms),
      new_request_kind: newRequestKind,
      requested_platforms: normalizePlatforms(raw?.requested_platforms),
      requested_format: requestedFormat,
      schedule_text: socialAiText(raw?.schedule_text, 240),
      future_preference_scope: ['none', 'listing', 'shop'].includes(socialAiText(raw?.future_preference_scope, 40).toLowerCase())
        ? socialAiText(raw?.future_preference_scope, 40).toLowerCase()
        : 'none',
      future_creative_preferences: Array.isArray(raw?.future_creative_preferences)
        ? raw.future_creative_preferences.map(item => socialAiText(item, 300)).filter(Boolean).slice(0, 12)
        : [],
      owner_feedback: feedback,
      publish_authorized: false,
    };
  } catch (err) {
    return { available: false, code: 'AI_ERROR', reason: socialAiText(err?.message || err, 400) };
  }
}

async function recordSocialOwnerFeedbackMemory({ ownerFeedback = '', currentPreview = null, revisionPlan = null } = {}) {
  const feedback = socialAiText(ownerFeedback, 2400);
  const preview = currentPreview && typeof currentPreview === 'object' && !Array.isArray(currentPreview)
    ? currentPreview
    : {};
  const plan = revisionPlan && typeof revisionPlan === 'object' && !Array.isArray(revisionPlan)
    ? revisionPlan
    : {};
  const scope = ['none', 'listing', 'shop'].includes(socialAiText(plan.future_preference_scope, 40).toLowerCase())
    ? socialAiText(plan.future_preference_scope, 40).toLowerCase()
    : 'none';
  const preferences = Array.isArray(plan.future_creative_preferences)
    ? plan.future_creative_preferences.map(value => socialAiText(value, 300)).filter(Boolean).slice(0, 12)
    : [];
  const listingId = socialAiText(
    preview.listing_id
      || preview.mapped_listing_id
      || preview.business_context?.listing_id,
    100,
  );
  if (socialAiText(plan.intent, 40).toLowerCase() !== 'revision' || !feedback) {
    const error = new Error('Only an AI-classified owner revision can update creative preference memory.');
    error.code = 'OWNER_REVISION_REQUIRED';
    throw error;
  }
  if (scope === 'none' || !preferences.length) {
    return { stored: false, scope: 'none', reason: 'AI classified this correction as preview-specific.' };
  }
  if (scope === 'listing' && !listingId) {
    const error = new Error('Listing-scoped owner preference requires an exact listing identity.');
    error.code = 'LISTING_ID_REQUIRED';
    throw error;
  }
  const now = new Date().toISOString();
  const id = crypto.createHash('sha256')
    .update(`${scope}\0${scope === 'listing' ? listingId : ''}\0${preferences.join('\0')}`)
    .digest('hex')
    .slice(0, 24);
  const existing = normalizeSocialOwnerFeedbackMemory(
    await kvGet('social_owner_feedback_memory').catch(() => null),
  );
  const item = {
    id: `owner_pref_${id}`,
    scope,
    listing_id: scope === 'listing' ? listingId : '',
    preferences,
    rationale: socialAiText(plan.rationale, 600),
    source_preview_id: socialAiText(preview.id || preview.etsy_manager_preview_id, 160),
    recorded_at: now,
    active: true,
  };
  const withoutDuplicate = existing.items.filter(entry => entry.id !== item.id);
  const memory = normalizeSocialOwnerFeedbackMemory({
    schema_version: 1,
    items: [...withoutDuplicate, item],
    updated_at: now,
  });
  memory.updated_at = now;
  await kvSet('social_owner_feedback_memory', memory);
  return { stored: true, item, memory_count: memory.items.length };
}

const socialCampaignFitAiStrategy = createSocialCampaignFitAiStrategy({
  normalizeListingCampaignFit,
  compactCampaignContext: compactCampaignContextForAi,
  compactListing: compactListingForAiUnderstanding,
  isAiConfigured: hasExternalAiConfigAsync,
  generateWithAi: generateWithSocialAi,
  responsePreview: aiResponsePreview,
  text: socialAiText,
});

async function buildListingCampaignFitWithAi(input = {}) {
  return socialCampaignFitAiStrategy.evaluate(input);
}


function normalizeSocialResearchPlan(raw = {}, source = 'external_ai') {
  if (Array.isArray(raw)) raw = { queries: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const querySource = Array.isArray(raw.queries)
    ? raw.queries
    : Array.isArray(raw.search_queries)
      ? raw.search_queries
      : Array.isArray(raw.research_queries)
        ? raw.research_queries
        : [];
  const queries = querySource.slice(0, 6).map((item, index) => {
    if (typeof item === 'string') return { id: `query_${index + 1}`, query: socialAiText(item, 240), purpose: '' };
    if (!item || typeof item !== 'object') return null;
    return {
      id: socialAiText(item.id || `query_${index + 1}`, 80),
      query: socialAiText(item.query || item.search_query || item.q, 240),
      purpose: socialAiText(item.purpose || item.reason || item.question, 420),
      freshness: socialAiText(item.freshness || item.time_window, 80),
      preferred_sources: socialAiStringList(item.preferred_sources || item.source_types, 6, 120),
    };
  }).filter(item => item?.query);
  if (!queries.length) return null;
  return {
    status: 'ready',
    source,
    rationale: socialAiText(raw.rationale || raw.reason, 700),
    queries,
    evidence_requirements: {
      minimum_distinct_sources: 2,
      source_pages_must_be_read: true,
      snippets_alone_are_insufficient: true,
    },
  };
}

async function buildSocialResearchPlanWithAi({ seedOpportunities = [], shopContext = {}, now = Date.now() } = {}) {
  const configured = await hasExternalAiConfigAsync().catch(() => false);
  if (!configured) return { status: 'blocked_ai_required', source: 'ai_unavailable', queries: [], reason: 'External text AI is not configured.' };
  const opportunities = (Array.isArray(seedOpportunities) ? seedOpportunities : []).slice(0, 8).map(item => ({
    type: socialAiText(item?.type, 100),
    moment: socialAiText(item?.moment, 220),
    reason: socialAiText(item?.reason, 700),
    campaign_context: socialAiText(item?.context?.campaign_context || item?.campaign_context, 900),
    selected_review: item?.context?.selected_review || null,
    listings: (Array.isArray(item?.listing_candidates) ? item.listing_candidates : []).slice(0, 8).map(listing => ({
      listing_id: socialAiText(listing?.listing_id || listing?.id, 100),
      title: socialAiText(listing?.title, 180),
      what_is_sold: socialAiText(listing?.listing_understanding?.what_is_sold, 240),
      buyer_use_case: socialAiText(listing?.listing_understanding?.buyer_use_case, 280),
    })),
  }));
  const listings = (Array.isArray(shopContext.listings) ? shopContext.listings : []).slice(0, 24).map(item => ({
    listing_id: socialAiText(item?.listing_id || item?.id, 100),
    title: socialAiText(item?.title, 240),
    description: socialAiText(item?.description, 240),
    tags: socialAiStringList(item?.tags, 6, 80),
    views: socialOptionalNumber(item?.views),
    favorites: socialOptionalNumber(item?.favorites),
    orders_90d: socialOptionalNumber(item?.orders_90d),
  })).filter(item => item.listing_id && (item.title || item.description));
  const reviews = (Array.isArray(shopContext.reviews) ? shopContext.reviews : []).slice(0, 16).map(item => ({
    review_id: socialAiText(item?.review_id || item?.id, 120),
    listing_id: socialAiText(item?.listing_id, 100),
    rating: socialOptionalNumber(item?.rating),
    text: socialAiText(item?.text || item?.review, 900),
    created_at: socialAiText(item?.created_at, 80),
  })).filter(item => item.review_id && item.text);
  const payload = {
    ...socialCurrentDateContext(now),
    ai_selected_shop_opportunities: opportunities,
    shop_context: {
      shop_totals: shopContext.shop_totals || shopContext.snapshot_facts || {},
      factual_changes: shopContext.factual_changes || null,
      listings,
      reviews,
      owner_feedback_memory: normalizeSocialOwnerFeedbackMemory(shopContext.owner_feedback_memory),
    },
    instruction: opportunities.length
      ? 'Plan web searches that can verify or reject timely external angles for the AI-selected shop opportunities. Queries must be specific enough to find current evidence, not generic social-media advice.'
      : 'Infer several plausible research directions from the supplied shop listings, reviews, performance facts, and current date, then plan searches that can discover or reject relevant current events, buyer moments, or trends. This is research planning, not final content or listing selection.',
  };
  const system = [
    'You are the web-research planner for an AI-first Etsy social agent.',
    'Use the supplied shop context and any AI-selected opportunities to decide what current external facts, events, buyer moments, or trends should be researched before final content selection.',
    'When no preselected opportunities are supplied, infer research directions semantically from listing descriptions, reviews, performance facts, factual changes, and the current date. Do not select the final campaign or listing; a later AI stage will do that after research.',
    'Do not use fixed holidays, keyword templates, or a fixed product taxonomy. Do not assume a trend exists.',
    'Create 2-6 precise web search queries. Each query needs a purpose, freshness expectation, and preferred authoritative source types.',
    'Research may discover that an evergreen shop/review story is better than a current-event hook.',
    'Return ONLY JSON with keys: rationale, queries. Each query item has: id, query, purpose, freshness, preferred_sources.',
  ].join(' ');
  const researchPlanOutputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['rationale', 'queries'],
    properties: {
      rationale: { type: 'string' },
      queries: {
        type: 'array',
        minItems: 2,
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'query', 'purpose', 'freshness', 'preferred_sources'],
          properties: {
            id: { type: 'string' },
            query: { type: 'string' },
            purpose: { type: 'string' },
            freshness: { type: 'string' },
            preferred_sources: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
  try {
    const raw = await generateWithSocialAi(
      system,
      JSON.stringify(payload, null, 2),
      researchPlanOutputSchema,
      { task: 'web_research_plan', maxTokens: 4_000 },
    );
    const normalized = normalizeSocialResearchPlan(raw, 'external_ai');
    if (normalized) return normalized;
    const repairSystem = [
      'Repair the supplied web research plan into strict JSON using only planning_payload and previous_response.',
      'Return ONLY JSON with keys rationale and queries. Each query item has id, query, purpose, freshness, preferred_sources.',
      'Keep 2-6 precise queries and do not invent shop facts or claim a trend already exists.',
    ].join(' ');
    const repairedRaw = await generateWithSocialAi(
      repairSystem,
      JSON.stringify({ planning_payload: payload, previous_response: raw }, null, 2),
      researchPlanOutputSchema,
      { task: 'web_research_plan_repair', maxTokens: 4_000 },
    );
    const repaired = normalizeSocialResearchPlan(repairedRaw, 'external_ai_repair');
    return repaired || { status: 'blocked_ai_invalid_response', source: 'ai_invalid_response', queries: [], reason: 'External AI did not return a usable research plan.' };
  } catch (err) {
    return { status: 'blocked_ai_error', source: 'ai_error', queries: [], reason: socialAiText(err?.message || err, 420) };
  }
}


const socialContentOpportunitySemanticFilter = createSocialContentOpportunitySemanticFilter({
  generateWithAi: generateWithSocialAi,
  isAiConfigured: hasExternalAiConfigAsync,
  normalizeListingUnderstanding,
  normalizeListingCampaignFit,
  normalizeOwnerFeedbackMemory: normalizeSocialOwnerFeedbackMemory,
  buildListingCampaignFit: buildListingCampaignFitWithAi,
});

export function evaluateSocialResearchEvidenceForTest(raw = {}, currentResearch = {}, rawSignals = []) {
  return socialContentOpportunitySemanticFilter.evaluateResearchEvidence(raw, currentResearch, rawSignals);
}

const socialContentOpportunityService = createSocialContentOpportunityService({
  getScheduledPosts,
  loadValue: kvGet,
  getAutonomousContextMemory: getSocialHermesAutonomousContextMemory,
  semanticFilter: socialContentOpportunitySemanticFilter.applySemanticFit,
  normalizeOwnerFeedbackMemory: normalizeSocialOwnerFeedbackMemory,
});

const socialCreativePlanService = createSocialCreativePlanProductionService({
  buildListingUnderstanding: buildListingUnderstandingWithAi,
  buildListingCampaignFit: buildListingCampaignFitWithAi,
});

function normalizeMediaUrls(body) {
  const urls = [];
  const add = (url) => { if (url && typeof url === 'string' && !urls.includes(url)) urls.push(url); };
  add(body.imageUrl);
  for (const url of (Array.isArray(body.imageUrls) ? body.imageUrls : [])) add(url);
  for (const item of (Array.isArray(body.media_items) ? body.media_items : [])) add(item?.url || item);
  return urls;
}

function hasCronSecret(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const secret = req.query?.secret || req.body?.secret || '';
  return bearer === expected || secret === expected;
}

function hasMakeCallbackSecret(req, body = {}) {
  const expected = process.env.MAKE_CALLBACK_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return bearer === expected || body.secret === expected || body.callbackSecret === expected;
}

// ── Social Ops Hermes Phase 2A safe bridge ─────────────────────
// Kept inside the existing /api/social function so the VPS admin and service
// bridge share one route. SOCIAL_HERMES_API_TOKEN is scoped to these bridge
// actions only; it never grants access to legacy direct social publish actions.
const SOCIAL_HERMES_ACTIONS = new Set(SOCIAL_HERMES_ACTION_NAMES);
const CRON_SOCIAL_ACTIONS = new Set(['schedulerStatus', 'publishDueScheduled']);
const RETIRED_DIRECT_PUBLISH_ACTIONS = new Set([
  'postBuffer',
  'postMake',
  'postZapier',
  'postMetricool',
  'postInstagram',
  'postInstagramCarousel',
  'postFacebook',
  'postPinterest',
  'smartPost',
  'sendToBuffer',
  'sendToMetricool',
  'sendToMake',
  'sendToZapier',
]);
const SOCIAL_HERMES_SCHEDULED_FIELDS = [
  'id',
  'caption',
  'platform',
  'listing_id',
  'listing_title',
  'listing_image_url',
  'generated_image_url',
  'custom_image_url',
  'media_items',
  'platform_caption_variants',
  'scheduled_at',
  'status',
  'source',
  'created_by',
  'metadata',
  'approval_source',
  'created_at',
  'updated_at',
  'publish_method',
  'post_url',
  'publish_result',
  'last_error',
  'approved_for_publish',
  'approved_by',
  'approved_at',
  'queue_state',
  'is_overdue',
  'is_stale',
  'is_active_queue',
  'overdue_ms',
  'scheduled_at_ms',
];
const SOCIAL_HERMES_SECRET_KEY_RE = /(token|secret|password|cookie|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)/i;
const SOCIAL_HERMES_SECRET_VALUE_RE = /([?&](access_)?token=|[?&](api[_-]?key|secret|signature|sig)=|\bBearer\s+)/i;
const SOCIAL_HERMES_MUTABLE_STATUSES = new Set(['draft', 'scheduled', 'paused']);

const SOCIAL_HERMES_IMAGE_URL_RE = /^https?:\/\//i;
const SOCIAL_HERMES_DATA_IMAGE_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/i;

export function resolveSocialHermesRequestedPlatformsForTest(requestedPlatforms = [], publishCapablePlatforms = []) {
  return resolveSocialHermesRequestedPlatforms(requestedPlatforms, publishCapablePlatforms);
}

async function resolveSocialHermesMetricoolPlatforms(platform, socialConfigsOverride) {
  const explicitPlatforms = resolveSocialHermesMetricoolPlatformsFromConfig(platform, {});
  if (explicitPlatforms.length) return explicitPlatforms;
  const socialConfigs = socialConfigsOverride ?? await kvGet('social_configs').catch(() => ({}));
  return resolveSocialHermesMetricoolPlatformsFromConfig(platform, socialConfigs);
}

export async function resolveSocialHermesMetricoolPlatformsForTest(platform, socialConfigsOverride) {
  return resolveSocialHermesMetricoolPlatforms(platform, socialConfigsOverride);
}

function publicBaseUrl(req) {
  const explicit = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const proto = req.headers?.['x-forwarded-proto'] || 'https';
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').trim();
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  return !isLocalHost && host ? `${proto}://${host}`.replace(/\/$/, '') : (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:3010' : '');
}

function socialHermesKvCreds() {
  const url = (process.env.KV_REST_API_URL || '').replace(/^["']|["']$/g, '').replace(/\/$/, '');
  const token = (process.env.KV_REST_API_TOKEN || '').replace(/^["']|["']$/g, '');
  return { url, token };
}

function socialHermesKvShopId() {
  return process.env.ETSY_SHOP_ID || 'default';
}

function socialHermesShape(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') return `object(${Object.keys(value).slice(0, 8).join(',')})`;
  return typeof value;
}

async function socialHermesKvPost(command, ...args) {
  const { url, token } = socialHermesKvCreds();
  if (!url || !token) throw new Error('KV_REST_API_URL or KV_REST_API_TOKEN not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([command, ...args]),
  });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (err) {
    const e = new Error(`KV ${command} returned non-JSON response (status=${res.status}, parse=${err?.message || 'JSON parse failed'}, preview=${raw.slice(0, 80)})`);
    e.status = res.status;
    e.endpoint = 'kv_rest_api';
    e.response_shape = 'non_json_text';
    e.parser_stage = `kv_${String(command || '').toLowerCase()}_response_json_parse`;
    throw e;
  }
  if (!res.ok || data.error) {
    const e = new Error(data.error || `KV ${command} failed with HTTP ${res.status}`);
    e.status = res.status;
    e.endpoint = 'kv_rest_api';
    e.response_shape = socialHermesShape(data);
    e.parser_stage = `kv_${String(command || '').toLowerCase()}_response`;
    throw e;
  }
  return data.result;
}

async function socialHermesKvCall(command, ...args) {
  // Use POST command body instead of URL-path commands. This is critical for
  // generated image assets: base64 JSON can be very large, and URL-path SET can
  // produce malformed/non-JSON KV responses in production.
  return socialHermesKvPost(command, ...args);
}

async function socialHermesKvSetRaw(key, value, exSeconds) {
  const fullKey = `${socialHermesKvShopId()}:${key}`;
  const commandArgs = ['SET', fullKey, value];
  if (exSeconds) commandArgs.push('EX', String(exSeconds));
  return socialHermesKvPost(...commandArgs);
}

async function socialHermesKvGetRaw(key) {
  return socialHermesKvPost('GET', `${socialHermesKvShopId()}:${key}`);
}

async function socialHermesKvSetJson(key, value, exSeconds) {
  return socialHermesKvSetRaw(key, encodeURIComponent(JSON.stringify(value)), exSeconds);
}

async function socialHermesKvGetJson(key) {
  const raw = await socialHermesKvGetRaw(key);
  if (!raw) return null;
  return JSON.parse(decodeURIComponent(raw));
}

function decodeSocialHermesRecord(raw) {
  try { return JSON.parse(decodeURIComponent(raw)); } catch { return null; }
}

function platformCaptionReviewOutputSchema(platforms = []) {
  return socialCaptionReviewContracts.outputSchema(platforms);
}

export function storeSocialHermesMediaAsset({ req, ...asset }) {
  return storeSocialMediaAssetInStore({
    ...asset,
    publicBaseUrl: publicBaseUrl(req),
  });
}

export function readPermanentSocialHermesMediaAsset(id) {
  return readSocialMediaAssetFromStore(id);
}

function permanentSocialMediaAssetId(value) {
  try {
    const url = new URL(String(value || ''), 'https://etsy-manager.invalid');
    const id = String(url.searchParams.get('id') || '').trim();
    return /^shmedia_[a-f0-9]{24}$/i.test(id) ? id : '';
  } catch {
    return '';
  }
}

async function hydrateCampaignQualityVariants(variants = []) {
  const hydratedAssets = new Map();
  const hydrateMedia = async item => {
    if (!item || typeof item !== 'object') return item;
    if (!['generated_image', 'review_card'].includes(String(item.source || ''))) return { ...item };
    const id = permanentSocialMediaAssetId(item.url || item.id);
    if (!id) throw new Error('Campaign quality review requires persistent Etsy AI Command Center media for generated frames.');
    if (!hydratedAssets.has(id)) hydratedAssets.set(id, readPermanentSocialHermesMediaAsset(id));
    const asset = await hydratedAssets.get(id);
    return {
      ...item,
      id,
      mimeType: normalizeImageMimeType(asset.mime_type || asset.mimeType),
      base64: asset.bytes.toString('base64'),
    };
  };
  return Promise.all((Array.isArray(variants) ? variants : []).map(async variant => ({
    ...variant,
    media_items: await Promise.all((Array.isArray(variant?.media_items) ? variant.media_items : []).map(hydrateMedia)),
  })));
}

async function handleSocialHermesMediaAsset(req, res) {
  const id = String(req.query?.id || req.body?.id || '').trim();
  const permanentId = /^shmedia_[a-f0-9]{24}$/i.test(id);
  if (!permanentId) return socialHermesJsonError(res, 404, 'MEDIA_ASSET_NOT_FOUND', 'Media asset not found.');
  try {
    let asset;
    try {
      asset = await readPermanentSocialHermesMediaAsset(id);
    } catch (diskErr) {
      if (diskErr?.code === 'ENOENT') return socialHermesJsonError(res, 404, 'MEDIA_ASSET_NOT_FOUND', 'Media asset not found.');
      throw diskErr;
    }
    const mime = normalizeImageMimeType(asset.mime_type || asset.mimeType);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', `inline; filename="${id}.${extensionForMimeType(mime)}"`);
    return res.status(200).end(asset.bytes);
  } catch (err) {
    console.error('[social-hermes-media-asset]', err?.message || err);
    return socialHermesJsonError(res, 500, 'MEDIA_ASSET_ERROR', 'Could not load Social Hermes media asset.');
  }
}

async function getSocialHermesCatalogListingMedia(limit = 12) {
  const shopId = getShopId();
  if (!shopId) return { listings: [], media_items: [], error: 'ETSY_SHOP_ID is not configured' };
  try {
    const data = await etsyFetch(`/shops/${shopId}/listings/active?limit=${Math.max(1, Math.min(limit, 12))}&includes=Images`);
    const listings = Array.isArray(data.results) ? data.results : [];
    const mediaItems = [];
    const safeListings = [];
    for (const listing of listings) {
      const listingId = listing.listing_id ? String(listing.listing_id) : '';
      const title = listing.title || '';
      const images = Array.isArray(listing.images) ? listing.images : Array.isArray(listing.Images) ? listing.Images : [];
      const normalized = images.map(normalizeSocialHermesListingImage).filter(Boolean).map(item => ({
        ...item,
        listing_id: listingId,
        listing_title: title,
        listing_url: listing.url || '',
      }));
      if (normalized.length) {
        safeListings.push({ listing_id: listingId, title, state: listing.state || '', url: listing.url || '', media_count: normalized.length });
        mediaItems.push(...normalized);
      }
    }
    return { listings: safeListings, media_items: mediaItems.slice(0, 20), error: null };
  } catch (err) {
    return { listings: [], media_items: [], error: err?.message || 'Catalog listing media lookup failed' };
  }
}

async function getSocialHermesPortfolioMedia(limit = 12) {
  try {
    const shopId = getShopId() || process.env.ETSY_SHOP_ID || 'default';
    const raw = await socialHermesKvCall('LRANGE', `${shopId}:gallery:meta`, '0', String(Math.max(0, limit - 1)));
    return (raw || []).map(decodeSocialHermesRecord).filter(Boolean).map((item, idx) => ({
      id: item.id || `portfolio_${idx + 1}`,
      source: 'portfolio_gallery',
      type: 'image',
      prompt: item.prompt || '',
      slotLabel: item.slotLabel || '',
      listingTitle: item.listingTitle || '',
      mime_type: item.mimeType || 'image/png',
      created_at: item.createdAt || null,
      // Existing gallery stores binary in browser IndexedDB; bridge exposes safe metadata only.
      url: item.url || '',
      recommendation: item.url ? '' : 'Portfolio image metadata exists, but no server-public image URL is stored; use as a recommendation unless the owner provides/approves the asset URL.',
    }));
  } catch {
    return [];
  }
}

async function getSocialHermesMediaCapabilities() {
  const imageCapabilities = await getExternalImageCapabilities().catch(() => ({
    generatedImageAvailable: false,
    referenceImageSupported: false,
    referenceMode: 'unsupported',
  }));
  const hasExternal = imageCapabilities.generatedImageAvailable === true;
  return {
    available_sources: ['existing_listing_image', 'approved_portfolio_image', 'generated_image'],
    existing_listing_images_available: true,
    approved_portfolio_gallery_available: true,
    generated_image_available: hasExternal,
    generated_image_provider: hasExternal ? 'external_ai' : 'unconfigured',
    generated_image_reference_supported: imageCapabilities.referenceImageSupported === true,
    generated_image_reference_mode: imageCapabilities.referenceMode,
    generated_image_note: hasExternal
      ? 'Social Hermes can generate images only through the configured external provider; generated assets must be downloaded, validated, and persisted as Etsy AI Command Center mediaAsset URLs before save/schedule.'
      : 'No external image provider is configured for Social Hermes generation; use listing/portfolio images or skip image generation.',
    telegram_preview_available: true,
    text_only_fallback_available: false,
  };
}

async function getSafeSocialHermesMediaOptions(body = {}) {
  const listingId = valueFromSocialHermesBody(body, 'listing_id') || body.listingId || '';
  const [listingMedia, portfolioMedia, capabilities] = await Promise.all([
    getSocialHermesListingMedia(listingId),
    getSocialHermesPortfolioMedia(12),
    getSocialHermesMediaCapabilities(),
  ]);
  const listingItems = listingId && Array.isArray(listingMedia.media_items) ? listingMedia.media_items : [];
  return {
    capabilities,
    listing: listingMedia.listing,
    catalog_listings: [],
    listing_media_items: listingItems,
    listing_media_error: listingMedia.error,
    approved_portfolio_media_items: portfolioMedia,
    selection_policy: 'Candidate facts only. AI creativePlan vision/media strategy must choose source, order, and count.',
  };
}

function socialHermesCanaryProbeAllowedUrl(urlValue = '') {
  try {
    const url = new URL(String(urlValue || ''));
    if (!/^https?:$/i.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
    const private172 = host.match(/^172\.(\d+)\./);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

async function socialHermesProbeMediaUrl(url, timeoutMs = 8000) {
  if (!socialHermesCanaryProbeAllowedUrl(url)) {
    return { url, ok: false, status: 0, content_type: '', error: 'Media URL is not an allowed public HTTP(S) URL.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchOnce = async (method) => {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: method === 'GET' ? { Range: 'bytes=0-2047' } : undefined,
    });
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    return { status: res.status, ok: res.ok, content_type: contentType };
  };
  try {
    let result = await fetchOnce('HEAD').catch(() => null);
    if (!result || result.status === 405 || result.status === 403 || !result.content_type) result = await fetchOnce('GET');
    const mediaLike = /^(image|video)\//i.test(result.content_type) || result.content_type === 'application/octet-stream';
    return {
      url,
      ...result,
      ok: Boolean(result.ok && mediaLike),
      error: result.ok && !mediaLike ? `Media URL returned non-media content-type: ${result.content_type || 'unknown'}` : '',
    };
  } catch (err) {
    return { url, ok: false, status: 0, content_type: '', error: err?.name === 'AbortError' ? 'Media URL probe timed out.' : (err?.message || 'Media URL probe failed.') };
  } finally {
    clearTimeout(timer);
  }
}

async function attachSocialHermesCanaryMediaProbe(candidate, { limit = 8 } = {}) {
  const mediaItems = Array.isArray(candidate?.preview?.media_items) ? candidate.preview.media_items : [];
  const urls = [...new Set(mediaItems.map(item => String(item?.url || item || '').trim()).filter(Boolean))].slice(0, limit);
  const results = [];
  for (const url of urls) results.push(await socialHermesProbeMediaUrl(url));
  candidate.media_probe = {
    checked: results.length,
    ok: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results: results.map(item => ({
      url: item.url,
      ok: item.ok,
      status: item.status,
      content_type: item.content_type,
      error: item.error || '',
    })),
  };
  for (const item of results.filter(result => !result.ok)) {
    candidate.blockers.push({
      code: 'MEDIA_URL_PROBE_FAILED',
      message: item.error || `Media URL did not return a usable image/video response: ${item.status || 'no status'}`,
    });
  }
  if (candidate.blockers.length) {
    candidate.verdict = 'blocked';
    candidate.ready_for_canary_approval = false;
    candidate.ready_for_publish_when_due = false;
    candidate.owner_approval_required = false;
  }
  return candidate;
}

function socialHermesJsonError(res, status, code, message) {
  return res.status(status).json({ success: false, code, error: message, saved: false, published: false });
}

function normalizeInstagramPermalink(value = '') {
  const permalink = String(value || '').trim();
  if (!permalink) return null;
  if (/^https?:\/\//i.test(permalink)) return permalink;
  return `https://www.instagram.com${permalink.startsWith('/') ? '' : '/'}${permalink}`;
}

function blockExternalPublishByGovernance(res, action) {
  const publishGovernance = publishGovernanceStatus();
  return res.status(403).json({
    success: false,
    code: 'PUBLISH_GOVERNANCE_BLOCKED',
    error: `External publish action ${action} is blocked by VPS publish governance.`,
    publish_governance: publishGovernance,
    published: false,
  });
}

function socialHermesBearerToken(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

function hasSocialHermesBearer(req) {
  const expected = (process.env.SOCIAL_HERMES_API_TOKEN || '').trim();
  return !!expected && socialHermesBearerToken(req) === expected;
}

function isSocialHermesBridgeRequest(req, action) {
  return SOCIAL_HERMES_ACTIONS.has(action) || hasSocialHermesBearer(req);
}

function getSocialHermesOwnerTelegramUserId() {
  return (process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID || '').trim();
}

function requireSocialHermesOwnerTelegramConfig(res) {
  const ownerTelegramUserId = getSocialHermesOwnerTelegramUserId();
  if (!ownerTelegramUserId) {
    socialHermesJsonError(res, 503, 'SOCIAL_HERMES_OWNER_NOT_CONFIGURED', 'Social Hermes Telegram owner is not configured.');
    return null;
  }
  return ownerTelegramUserId;
}

function socialHermesNowMs() {
  return Date.now();
}

function valueFromSocialHermesBody(body, key) {
  if (body?.post && Object.prototype.hasOwnProperty.call(body.post, key)) return body.post[key];
  if (body?.draft && Object.prototype.hasOwnProperty.call(body.draft, key)) return body.draft[key];
  return body?.[key];
}

function generateSocialHermesId(prefix = 'sh') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function redactSocialHermesSecrets(value) {
  if (typeof value === 'string') return SOCIAL_HERMES_SECRET_VALUE_RE.test(value) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(redactSocialHermesSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SOCIAL_HERMES_SECRET_KEY_RE.test(key) ? '[redacted]' : redactSocialHermesSecrets(item),
  ]));
}

function normalizeSocialHermesMediaItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (!item) return null;
      if (typeof item === 'string') return { url: item, type: 'image' };
      if (!item.url) return null;
      return {
        url: String(item.url),
        type: item.type || 'image',
        alt: item.alt || item.description || '',
        source: item.source || item.source_field || '',
        id: item.id || '',
        brief_id: item.brief_id || item.frame_id || '',
        prompt: String(item.prompt || '').slice(0, 1800),
        provider: String(item.provider || '').slice(0, 120),
        model: String(item.model || '').slice(0, 160),
        checksum_sha256: String(item.checksum_sha256 || '').slice(0, 64),
        permanent: item.permanent === true,
        generated_via: String(item.generated_via || '').slice(0, 120),
        image_model_tier: String(item.image_model_tier || '').slice(0, 80),
        width: Number(item.width) || null,
        height: Number(item.height) || null,
        requested_aspect_ratio: String(item.requested_aspect_ratio || '').slice(0, 20),
        actual_aspect_ratio: Number(item.actual_aspect_ratio) || null,
        original_width: Number(item.original_width) || null,
        original_height: Number(item.original_height) || null,
        original_aspect_ratio: Number(item.original_aspect_ratio) || null,
        aspect_ratio_normalized: item.aspect_ratio_normalized === true,
        quality_review: item.quality_review && typeof item.quality_review === 'object'
          ? redactSocialHermesSecrets(item.quality_review)
          : null,
      };
    })
    .filter(Boolean)
    .slice(0, 10);
}

function socialHermesRecordHasGeneratedMedia(record = {}) {
  const mediaItems = Array.isArray(record.media_items) ? record.media_items : [];
  return mediaItems.some(item => String(item?.source || item?.generated_via || item?.provider || '').toLowerCase() === 'generated_image');
}

function socialHermesMediaSafetyJsonError(res, record = {}) {
  const problem = scheduledPostMediaSafetyError(record);
  if (!problem) return false;
  socialHermesJsonError(res, 400, problem.code || 'MEDIA_SAFETY_ERROR', problem.message || 'Generated media is not safe to save.');
  return true;
}

async function attachSocialHermesReviewArtifacts(plan = {}) {
  if (!Array.isArray(plan.variants) || plan.status !== 'ready_for_review') return plan;
  const variants = [];
  for (const variant of plan.variants) {
    try {
      const artifact = await issueSocialHermesReviewArtifact(plan, variant);
      variants.push(artifact ? { ...variant, ai_review_artifact: artifact } : variant);
    } catch (error) {
      variants.push({
        ...variant,
        ai_review_artifact_status: 'unavailable',
        ai_review_artifact_error: socialAiText(error?.message || error, 300),
      });
    }
  }
  return { ...plan, variants };
}

export async function issueSocialHermesReviewArtifactForTest(plan, variant) {
  return issueSocialHermesReviewArtifact(plan, variant);
}

export async function consumeSocialHermesReviewArtifactForTest(record, metadata) {
  return consumeSocialHermesReviewArtifact(record, metadata);
}

function socialHermesCaptionQualityJsonError(res, record = {}) {
  const problem = socialHermesCaptionQualityProblem(record);
  if (!problem) return false;
  socialHermesJsonError(res, 400, problem.code, problem.message);
  return true;
}

export function socialHermesPlatformMediaContractProblem(record = {}) {
  const platform = normalizeSocialHermesPlatformId(record.platform || '');
  if (platform !== 'pinterest') return null;
  const urls = [];
  const add = value => {
    const url = String(value || '').trim();
    if (SOCIAL_HERMES_IMAGE_URL_RE.test(url) && !urls.includes(url)) urls.push(url);
  };
  for (const item of (Array.isArray(record.media_items) ? record.media_items : [])) add(item?.url || item);
  add(record.custom_image_url);
  add(record.generated_image_url);
  add(record.listing_image_url);
  if (urls.length === 1) return null;
  return {
    code: 'PINTEREST_SINGLE_PIN_MEDIA_REQUIRED',
    message: `Pinterest publishing through the configured Make route requires exactly one AI-selected image; received ${urls.length}.`,
  };
}

function socialHermesPlatformMediaContractJsonError(res, record = {}) {
  const problem = socialHermesPlatformMediaContractProblem(record);
  if (!problem) return false;
  socialHermesJsonError(res, 400, problem.code, problem.message);
  return true;
}

function socialHermesCarouselMediaReadinessJsonError(res, record = {}) {
  const problem = socialHermesCarouselMediaReadinessError(record);
  if (!problem) return false;
  socialHermesJsonError(res, 400, problem.code, problem.message);
  return true;
}

export function resolveSocialHermesPublishRouteForTest(platform, socialConfigs = {}, options = {}) {
  return resolveSocialHermesPublishRoute(platform, socialConfigs, options);
}

export function socialHermesRecordEligibleForAutoArmForTest(record = {}) {
  return socialHermesRecordEligibleForAutoArm(record);
}

async function getSocialHermesCanaryReadiness(body = {}) {
  return getSocialHermesCanaryReadinessFromModule(body, {
    probeCandidateMedia: attachSocialHermesCanaryMediaProbe,
  });
}

function normalizeSocialHermesScheduledPost(body, mode) {
  const createdAt = valueFromSocialHermesBody(body, 'created_at') || socialHermesNowMs();
  const scheduledAt = mode === 'schedule' ? valueFromSocialHermesBody(body, 'scheduled_at') : null;
  const mediaItems = normalizeSocialHermesMediaItems(valueFromSocialHermesBody(body, 'media_items'));
  const customImageUrl = valueFromSocialHermesBody(body, 'custom_image_url') || mediaItems[0]?.url || null;
  const generatedImageUrl = valueFromSocialHermesBody(body, 'generated_image_url') || mediaItems.find(item => item.source === 'generated_image')?.url || null;
  const platformCaptionVariants = normalizeSocialHermesPlatformCaptionVariants(
    valueFromSocialHermesBody(body, 'platform_caption_variants')
    || valueFromSocialHermesBody(body, 'caption_variants')
    || valueFromSocialHermesBody(body, 'platform_captions')
  );
  // Social Hermes owner approval authorizes writing a draft/scheduled record into
  // Etsy AI Command Center. It must not also approve the post for future autopublish; that
  // requires the separate admin-only approveScheduledPost action.
  const publishApproved = false;
  const requestedPlatform = normalizeSocialHermesPlatformId(valueFromSocialHermesBody(body, 'platform') || '');
  const record = {
    id: valueFromSocialHermesBody(body, 'id') || generateSocialHermesId(mode === 'schedule' ? 'sched' : 'draft'),
    caption: String(valueFromSocialHermesBody(body, 'caption') || valueFromSocialHermesBody(body, 'text') || '').trim(),
    platform: requestedPlatform || '',
    listing_id: valueFromSocialHermesBody(body, 'listing_id') || null,
    listing_title: valueFromSocialHermesBody(body, 'listing_title') || '',
    listing_image_url: valueFromSocialHermesBody(body, 'listing_image_url') || '',
    generated_image_url: generatedImageUrl,
    custom_image_url: customImageUrl,
    media_items: mediaItems,
    platform_caption_variants: platformCaptionVariants,
    scheduled_at: scheduledAt || null,
    status: publishApproved ? 'approved_scheduled' : (mode === 'schedule' ? 'scheduled' : 'draft'),
    source: String(valueFromSocialHermesBody(body, 'source') || 'social_hermes').slice(0, 80),
    created_by: String(valueFromSocialHermesBody(body, 'created_by') || valueFromSocialHermesBody(body, 'agent') || 'social_hermes').slice(0, 80),
    metadata: redactSocialHermesSecrets(valueFromSocialHermesBody(body, 'metadata') || {}),
    approval_source: String(body?.approval_source || body?.approval?.source || valueFromSocialHermesBody(body, 'approval_source') || '').slice(0, 160),
    approved_for_publish: publishApproved,
    approved_by: publishApproved ? (approvedBy || null) : null,
    approved_at: publishApproved ? approvedAt : null,
    approval_note: publishApproved ? String(body?.approval_note || body?.approval?.note || '').slice(0, 500) || null : null,
    created_at: createdAt,
    publish_method: null,
    post_url: null,
    publish_result: null,
    last_error: null,
  };
  return Object.fromEntries(SOCIAL_HERMES_SCHEDULED_FIELDS.map(key => [key, record[key]]));
}

function normalizeSocialHermesScheduledPostBatch(body, mode) {
  const items = Array.isArray(body.posts)
    ? body.posts
    : Array.isArray(body.records)
      ? body.records
      : Array.isArray(body.scheduled_posts)
        ? body.scheduled_posts
        : null;
  if (!items) return [normalizeSocialHermesScheduledPost(body, mode)];
  return items
    .filter(item => item && typeof item === 'object')
    .map((item, index) => normalizeSocialHermesScheduledPost({
      ...body,
      ...item,
      id: item.id || `${valueFromSocialHermesBody(body, 'id') || generateSocialHermesId(mode)}-${index + 1}`,
      post: item,
      draft: item,
    }, mode));
}

async function expandSocialHermesAllPlatformRecord(record = {}) {
  return expandSocialHermesOwnerReviewRecord(record);
}

function socialHermesBridgeRecordValidationProblem(record = {}, { requireSchedule = false } = {}) {
  if (!record.platform) return { code: 'PLATFORM_REQUIRED', message: 'A concrete platform or platform=all is required for Social Hermes scheduling.' };
  if (!record.caption) return { code: 'CAPTION_REQUIRED', message: 'caption is required' };
  if (requireSchedule && !record.scheduled_at) return { code: 'SCHEDULED_AT_REQUIRED', message: 'scheduled_at is required' };
  const captionProblem = socialHermesCaptionQualityProblem(record);
  if (captionProblem) return { code: captionProblem.code, message: captionProblem.message };
  if (socialHermesRecordHasForbiddenFallbackMedia(record)) {
    return { code: 'FALLBACK_MEDIA_NOT_ALLOWED', message: 'Synthetic E2E fallback media cannot be scheduled as live social media.' };
  }
  const mediaSafetyProblem = scheduledPostMediaSafetyError(record);
  if (mediaSafetyProblem) return { code: mediaSafetyProblem.code || 'MEDIA_SAFETY_ERROR', message: mediaSafetyProblem.message || 'Generated media is not safe to save.' };
  if (record.platform === 'instagram' && !socialHermesRecordHasPublicMedia(record)) {
    return { code: 'MEDIA_REQUIRED_FOR_INSTAGRAM', message: 'Instagram scheduled posts require media_items/custom_image_url/listing_image_url with a public URL.' };
  }
  const platformProblem = socialHermesPlatformMediaContractProblem(record);
  if (platformProblem) return platformProblem;
  const carouselProblem = socialHermesCarouselMediaReadinessError(record);
  if (carouselProblem) return carouselProblem;
  return null;
}

function socialHermesBridgeRecordValidationJsonError(res, record = {}, options = {}) {
  const problem = socialHermesBridgeRecordValidationProblem(record, options);
  if (!problem) return false;
  socialHermesJsonError(res, 400, problem.code, problem.message);
  return true;
}

function assertSocialHermesApproved(body, res, action, ownerTelegramUserId) {
  const approved = body?.approved === true || body?.approval?.approved === true;
  const approvedBy = String(body?.approved_by || body?.approval?.approved_by || body?.telegram_user_id || '');
  if (!approved) {
    socialHermesJsonError(res, 400, 'APPROVAL_REQUIRED', `${action} requires explicit Telegram owner approval.`);
    return false;
  }
  if (approvedBy !== ownerTelegramUserId) {
    socialHermesJsonError(res, 403, 'APPROVER_NOT_ALLOWED', 'Approval must come from the configured Telegram owner.');
    return false;
  }
  return true;
}

function safeSocialHermesScheduledPost(post) {
  const safe = {};
  for (const key of SOCIAL_HERMES_SCHEDULED_FIELDS) safe[key] = post?.[key] ?? null;
  return { ...safe, ...classifyScheduledPost(post) };
}

function normalizeSocialHermesMutableStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return SOCIAL_HERMES_MUTABLE_STATUSES.has(status) ? status : null;
}

export function applySocialHermesSafeMutableStatus(existing = {}, changes = {}, {
  ownerRevisionInProgress = false,
  now = new Date(),
} = {}) {
  if (!['draft', 'paused'].includes(changes.status)) return changes;
  const existingMetadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
    ? existing.metadata
    : {};
  const changedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    ...changes,
    approved_for_publish: false,
    approved_by: null,
    approved_at: null,
    approval_source: ownerRevisionInProgress ? 'owner_revision_in_progress' : 'owner_safe_status_change',
    approval_note: null,
    metadata: {
      ...existingMetadata,
      auto_publish_after_review_window: false,
      auto_publish_armed: false,
      auto_publish_disarmed_at: changedAt,
      ...(ownerRevisionInProgress ? {
        owner_revision_in_progress: true,
        owner_revision_requested_at: changedAt,
      } : {}),
    },
  };
}

async function handleSocialHermesBridge(req, res, body, action) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return socialHermesJsonError(res, 405, 'METHOD_NOT_ALLOWED', 'GET/POST only');
  }
  if (!requireSocialHermesAuth(req, res)) return;
  const ownerTelegramUserId = requireSocialHermesOwnerTelegramConfig(res);
  if (!ownerTelegramUserId) return;

  if (!SOCIAL_HERMES_ACTIONS.has(action)) {
    return socialHermesJsonError(res, 400, 'UNSUPPORTED_ACTION', `Unsupported Phase 2C action: ${action}`);
  }

  try {
    switch (action) {
      case 'context': {
        const context = await getSafeSocialHermesContext(ownerTelegramUserId);
        return res.json({ success: true, action, data: context });
      }

      case 'refreshShopContext': {
        const context = await refreshSocialHermesShopContext();
        return res.json({ success: true, action, data: context, published: false });
      }

      case 'researchPlan': {
        const seedResponse = body.seed_opportunities_response || body.opportunities_response || {};
        const seedOpportunities = Array.isArray(body.seed_opportunities)
          ? body.seed_opportunities
          : Array.isArray(seedResponse?.data?.opportunities)
            ? seedResponse.data.opportunities
            : Array.isArray(seedResponse?.opportunities)
              ? seedResponse.opportunities
              : [];
        const shopContext = body.autonomous_context || body.shop_context || {};
        const plan = await buildSocialResearchPlanWithAi({
          seedOpportunities,
          shopContext,
          now: body.now || Date.now(),
        });
        return res.json({
          success: plan.status === 'ready',
          action,
          data: plan,
          saved: false,
          published: false,
          note: 'Read-only AI research planning. Etsy AI Command Center did not search, save, schedule, or publish anything.',
        });
      }

      case 'contentOpportunities': {
        const aiFilteredSuggestions = await socialContentOpportunityService.selectContentOpportunities(body);
        return res.json({
          success: true,
          action,
          data: redactSocialHermesSecrets(aiFilteredSuggestions),
          saved: false,
          published: false,
          note: 'Shop-signal discovery is read-only and AI-required. Local signals are collected as facts; external text AI must semantically filter campaign/listing fit before Social Hermes uses an opportunity as input to creativePlan.',
        });
      }

      case 'mediaOptions': {
        const options = await getSafeSocialHermesMediaOptions(body);
        return res.json({ success: true, action, data: options, published: false });
      }

      case 'revisionPlan': {
        const savedOwnerFeedbackMemory = await kvGet('social_owner_feedback_memory').catch(() => null);
        const currentPreview = body.current_preview || body.preview || null;
        const planned = await planSocialOwnerFollowupWithAi({
          ownerFeedback: body.owner_feedback || body.feedback || body.command_text,
          currentPreview: currentPreview && typeof currentPreview === 'object' && !Array.isArray(currentPreview)
            ? {
              ...currentPreview,
              owner_feedback_memory: normalizeSocialOwnerFeedbackMemory(savedOwnerFeedbackMemory),
            }
            : currentPreview,
        });
        if (!planned.available) {
          return socialHermesJsonError(
            res,
            planned.code === 'OWNER_FEEDBACK_REQUIRED' ? 400 : 503,
            planned.code || 'AI_REQUIRED',
            planned.reason || 'AI follow-up reasoning is unavailable.',
          );
        }
        return res.json({
          success: true,
          action,
          data: redactSocialHermesSecrets(planned),
          saved: false,
          scheduled: false,
          published: false,
          note: 'AI semantic follow-up planning only. Revision feedback never grants save, schedule, publish, or autopublish approval.',
        });
      }

      case 'recordOwnerFeedback': {
        const recorded = await recordSocialOwnerFeedbackMemory({
          ownerFeedback: body.owner_feedback || body.feedback || body.command_text,
          currentPreview: body.current_preview || body.preview || null,
          revisionPlan: body.revision_plan || body.plan || null,
        });
        return res.json({
          success: true,
          action,
          data: redactSocialHermesSecrets(recorded),
          saved: recorded.stored === true,
          scheduled: false,
          published: false,
          note: 'Owner creative preference memory only. This action never saves, schedules, approves, or publishes social content.',
        });
      }

      case 'creativePlan': {
        let plan;
        try {
          plan = await socialCreativePlanService.planCreativeCampaign(body, {
            publicBaseUrl: publicBaseUrl(req),
          });
        } catch (error) {
          if (error?.socialCreativePlanError === true) {
            return socialHermesJsonError(res, error.httpStatus, error.code, error.message);
          }
          throw error;
        }
        return res.json({
          success: true,
          action,
          data: redactSocialHermesSecrets(plan),
          saved: false,
          published: false,
          note: 'Planning is read-only. Generate pending briefs through generateMedia, then re-plan with persistent generated_media URLs before owner review/save.',
        });
      }

      case 'generateMedia': {
        const generated = await generateSocialHermesMedia(body, {
          publicBaseUrl: publicBaseUrl(req),
        });
        if (!generated.success && generated.code === 'PROMPT_REQUIRED') {
          return socialHermesJsonError(res, 400, generated.code, generated.error || 'Media generation failed');
        }
        return res.json({ success: Boolean(generated.success), action, data: generated, code: generated.code, error: generated.error, published: false });
      }

      case 'ideaPreview': {
        const mode = body.scheduled_at || body.post?.scheduled_at || body.draft?.scheduled_at ? 'schedule' : 'draft';
        const preview = normalizeSocialHermesScheduledPost(body, mode);
        return res.json({
          success: true,
          action,
          data: {
            preview: safeSocialHermesScheduledPost(preview),
            mode,
            requires_approval_for_save: true,
            saved: false,
            published: false,
          },
          published: false,
        });
      }

      case 'canaryReadiness': {
        const readiness = await getSocialHermesCanaryReadiness(body);
        return res.json({
          success: true,
          action,
          data: redactSocialHermesSecrets(readiness),
          saved: false,
          published: false,
          note: 'Read-only canary readiness diagnostics. This does not approve, schedule, publish, or enable autopublish.',
        });
      }

      case 'saveReviewDraft': {
        const records = normalizeSocialHermesScheduledPostBatch(body, 'schedule');
        const result = await saveSocialHermesOwnerReviewDrafts(records, {
          validateRecord: (record, options) => socialHermesBridgeRecordValidationProblem(record, options),
        });
        if (result.validation_problem) {
          return socialHermesJsonError(res, 400, result.validation_problem.code, result.validation_problem.message);
        }
        const saved = result.saved;
        return res.json({
          success: true,
          action,
          data: saved.length === 1
            ? safeSocialHermesScheduledPost(saved[0])
            : { records: saved.map(safeSocialHermesScheduledPost), count: saved.length },
          saved: true,
          published: false,
          note: result.records.some(record => record.scheduled_at)
            ? 'Saved for owner review with a future schedule. Publish approval remains false until the separate scheduler readiness pass arms the record.'
            : 'Saved as an unscheduled draft for owner review only. No publish approval was granted.',
        });
      }

      case 'deliverReviewNotification': {
        const requestedIds = [
          ...(Array.isArray(body.ids) ? body.ids : []),
          ...(Array.isArray(body.post_ids) ? body.post_ids : []),
          body.id,
          body.post_id,
        ].map(value => String(value || '').trim()).filter(Boolean);
        const ids = [...new Set(requestedIds)].slice(0, 12);
        if (!ids.length) return socialHermesJsonError(res, 400, 'ID_REQUIRED', 'At least one saved owner-review record id is required.');
        const delivered = await deliverSocialHermesOwnerReviewNotification(ids);
        return res.json({
          success: true,
          action,
          data: { records: delivered.records.map(safeSocialHermesScheduledPost), count: delivered.count },
          saved: true,
          published: false,
          note: 'Etsy AI Command Center delivered the owner review through Telegram Bot API and recorded server-verified message provenance.',
        });
      }

      case 'confirmReviewNotification': {
        return socialHermesJsonError(res, 410, 'CALLER_NOTIFICATION_CONFIRMATION_RETIRED', 'Caller-confirmed Telegram delivery is retired. Use deliverReviewNotification so Etsy AI Command Center performs and verifies the delivery.');
      }

      case 'saveDraft': {
        if (!assertSocialHermesApproved(body, res, action, ownerTelegramUserId)) return;
        const records = normalizeSocialHermesScheduledPostBatch(body, 'draft');
        const expanded = [];
        for (const record of records) expanded.push(...await expandSocialHermesAllPlatformRecord(record));
        for (const record of expanded) {
          if (socialHermesBridgeRecordValidationJsonError(res, record)) return;
        }
        const saved = [];
        for (const record of expanded) saved.push(await saveScheduledPost(record));
        return res.json({
          success: true,
          action,
          data: saved.length === 1
            ? safeSocialHermesScheduledPost(saved[0])
            : { records: saved.map(safeSocialHermesScheduledPost), count: saved.length },
          published: false,
        });
      }

      case 'schedule': {
        if (!assertSocialHermesApproved(body, res, action, ownerTelegramUserId)) return;
        const records = normalizeSocialHermesScheduledPostBatch(body, 'schedule');
        const result = await saveSocialHermesOwnerRequestedSchedule(records, {
          validateRecord: (record, options) => socialHermesBridgeRecordValidationProblem(record, options),
        });
        if (result.validation_problem) {
          return socialHermesJsonError(res, 400, result.validation_problem.code, result.validation_problem.message);
        }
        const saved = result.saved;
        return res.json({
          success: true,
          action,
          data: saved.length === 1
            ? safeSocialHermesScheduledPost(saved[0])
            : { records: saved.map(safeSocialHermesScheduledPost), count: saved.length },
          published: false,
        });
      }

      case 'armExistingQueue': {
        return res.json(await armSocialHermesExistingQueue());
      }

      case 'updateScheduled': {
        if (!assertSocialHermesApproved(body, res, action, ownerTelegramUserId)) return;
        const id = body.id || body.post_id || body.scheduled_post_id;
        if (!id) return socialHermesJsonError(res, 400, 'ID_REQUIRED', 'id is required');
        let changes = { id };
        const setIfPresent = (field, target = field) => {
          const value = valueFromSocialHermesBody(body, field);
          if (value !== undefined) changes[target] = value;
        };
        setIfPresent('caption');
        setIfPresent('text', 'caption');
        const platformRaw = valueFromSocialHermesBody(body, 'platform');
        if (platformRaw !== undefined) {
          const platform = normalizeSocialHermesPlatformId(platformRaw);
          if (!platform || platform === 'all') return socialHermesJsonError(res, 400, 'PLATFORM_REQUIRED', 'A concrete platform is required; platform=all is not allowed for Social Hermes scheduling.');
          changes.platform = platform;
        }
        setIfPresent('listing_id');
        setIfPresent('listing_title');
        setIfPresent('listing_image_url');
        setIfPresent('generated_image_url');
        setIfPresent('scheduled_at');
        const statusRaw = valueFromSocialHermesBody(body, 'status');
        if (statusRaw !== undefined) {
          const safeStatus = normalizeSocialHermesMutableStatus(statusRaw);
          if (!safeStatus) {
            return socialHermesJsonError(res, 400, 'STATUS_NOT_ALLOWED', 'Social Hermes may only set draft, scheduled, or paused status through the safe bridge.');
          }
          changes.status = safeStatus;
        }
        const mediaItemsRaw = valueFromSocialHermesBody(body, 'media_items');
        if (mediaItemsRaw !== undefined) changes.media_items = normalizeSocialHermesMediaItems(mediaItemsRaw);
        const customImageUrl = valueFromSocialHermesBody(body, 'custom_image_url');
        if (customImageUrl !== undefined) changes.custom_image_url = customImageUrl || changes.media_items?.[0]?.url || null;
        if (socialHermesRecordHasForbiddenFallbackMedia(changes)) return socialHermesJsonError(res, 400, 'FALLBACK_MEDIA_NOT_ALLOWED', 'Synthetic E2E fallback media cannot be attached to live social media.');
        const existing = (await getScheduledPosts()).find(post => String(post?.id || '') === String(id)) || {};
        changes = applySocialHermesSafeMutableStatus(existing, changes, {
          ownerRevisionInProgress: body.owner_revision_in_progress === true,
        });
        const candidate = { ...existing, ...changes, id };
        if (Object.prototype.hasOwnProperty.call(changes, 'caption') && socialHermesCaptionQualityJsonError(res, candidate)) return;
        if (socialHermesMediaSafetyJsonError(res, candidate)) return;
        if (socialHermesPlatformMediaContractJsonError(res, candidate)) return;
        if (socialHermesCarouselMediaReadinessJsonError(res, candidate)) return;
        const updated = await updateScheduledPost(id, changes);
        return res.json({ success: true, action, data: safeSocialHermesScheduledPost(updated), published: false });
      }

      case 'deleteScheduled': {
        if (!assertSocialHermesApproved(body, res, action, ownerTelegramUserId)) return;
        const id = body.id || body.post_id || body.scheduled_post_id;
        if (!id) return socialHermesJsonError(res, 400, 'ID_REQUIRED', 'id is required');
        const result = await deleteScheduledPost(id);
        return res.json({ success: true, action, data: { id, ...result }, published: false });
      }
    }
  } catch (err) {
    if (['AUTO_PUBLISH_OWNER_OPT_IN_REQUIRED', 'AUTO_PUBLISH_READINESS_REQUIRED'].includes(err?.code)) {
      return socialHermesJsonError(res, 409, err.code, err.message);
    }
    if (['OWNER_NOTIFICATION_DISABLED', 'OWNER_NOTIFICATION_NOT_CONFIGURED', 'OWNER_NOTIFICATION_DELIVERY_FAILED', 'OWNER_NOTIFICATION_CAMPAIGN_MISMATCH', 'OWNER_REVIEW_RECORD_REQUIRED'].includes(err?.code)) {
      return socialHermesJsonError(res, 409, err.code, err.message);
    }
    if (err?.code === 'REVIEW_RECORD_NOT_FOUND') {
      return socialHermesJsonError(res, 404, err.code, err.message);
    }
    const message = err?.message?.includes('KV_REST_API')
      ? 'KV storage is not configured for the Social Hermes bridge.'
      : 'Social Hermes bridge request failed.';
    console.error('[social-hermes-bridge]', err?.message || err);
    return socialHermesJsonError(res, 500, 'SOCIAL_AGENT_ERROR', message);
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST/GET only' });

  const body = req.method === 'GET' ? req.query : { ...(req.query || {}), ...(req.body || {}) };
  const action = String(body.action || (hasSocialHermesBearer(req) ? 'context' : ''));
  if (action === 'mediaAsset' && req.method === 'GET') return handleSocialHermesMediaAsset(req, res);
  if (isSocialHermesBridgeRequest(req, action)) return handleSocialHermesBridge(req, res, body, action);

  const isMakeCallback = action === 'makeCallback';
  const cronAuthorized = CRON_SOCIAL_ACTIONS.has(action) && hasCronSecret(req);
  const makeCallbackAuthorized = isMakeCallback && hasMakeCallbackSecret(req, body);
  let adminAuthorized = false;
  if (!cronAuthorized && !makeCallbackAuthorized) {
    adminAuthorized = requireAuth(req, res);
    if (!adminAuthorized) return;
  }

  try {
    if (RETIRED_DIRECT_PUBLISH_ACTIONS.has(action)) {
      return res.status(410).json({
        success: false,
        code: 'DIRECT_PUBLISH_ROUTE_RETIRED',
        error: `Direct publish action ${action} is retired. Publishing is available only through an AI-reviewed scheduled record and the due scheduler.`,
        publish_governance: publishGovernanceStatus(),
        published: false,
      });
    }

    let result;
    switch (action) {

      case 'adminAutopilotContext': {
        const context = await refreshSocialHermesShopContext();
        return res.json({ success: true, action, data: context, published: false });
      }

      case 'adminGenerateMedia': {
        const generated = await generateSocialHermesMedia({
          ...body,
          require_visual_quality_review: true,
        }, {
          publicBaseUrl: publicBaseUrl(req),
        });
        if (!generated.success && generated.code === 'PROMPT_REQUIRED') {
          return res.status(400).json({ success: false, action, code: generated.code, error: generated.error || 'Media generation failed', published: false });
        }
        return res.json({ success: Boolean(generated.success), action, data: generated, code: generated.code, error: generated.error, published: false });
      }

      // ── BUFFER (primary cross-posting path) ────────────────
      case 'postBuffer': {
        const token = process.env.BUFFER_ACCESS_TOKEN;
        const profileIds = (process.env.BUFFER_PROFILE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!token) return res.status(400).json({ error: 'BUFFER_ACCESS_TOKEN not set' });
        if (!profileIds.length) return res.status(400).json({ error: 'BUFFER_PROFILE_IDS not set' });

        const { text, imageUrl, link, scheduleAt } = body;

        // Post to each profile
        const results = [];
        for (const profileId of profileIds) {
          const payload = {
            profile_ids: [profileId],
            text: text || '',
            ...(imageUrl ? { media: { photo: imageUrl } } : {}),
            ...(link ? { media: { link } } : {}),
            ...(scheduleAt ? { scheduled_at: scheduleAt } : {}),
          };

          const r = await fetch('https://api.bufferapp.com/1/updates/create.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(payload),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || d.message || `Buffer returned ${r.status}`);
          results.push({ profileId, success: r.ok, data: d });
        }
        result = { success: true, published: false, queued: true, publish_status: 'queued_external', results };
        break;
      }

      // ── MAKE.COM Pinterest bridge ──────────────────────────
      case 'postMake': {
        const platform = String(body.platform || 'pinterest').toLowerCase();
        if (platform !== 'pinterest') {
          return res.status(400).json({
            success: false,
            error: 'Make.com is configured as the Pinterest bridge only. Instagram/Facebook publish through Etsy AI Command Center using the saved Meta settings.',
            expected_route: 'instagram/facebook=direct_api, pinterest=make',
          });
        }
        const make = await getMakeWebhookUrl(body.webhookUrl || body.webhook_url);
        if (!make.url) return res.status(400).json({ error: 'Make.com Pinterest webhook URL not configured — add it in Settings → Cross-posting' });

        const mediaUrls = normalizeMediaUrls(body);
        if (mediaUrls.length !== 1) {
          return res.status(400).json({
            success: false,
            code: 'PINTEREST_SINGLE_PIN_MEDIA_REQUIRED',
            error: `Pinterest publishing through Make requires exactly one image; received ${mediaUrls.length}.`,
          });
        }
        const baseUrl = publicBaseUrl(req);
        const payload = {
          action: body.makeAction || 'postMake',
          platform: 'pinterest',
          title: body.title || '',
          text: body.text || '',
          imageUrl: mediaUrls[0],
          imageUrls: [mediaUrls[0]],
          media_items: [{ url: mediaUrls[0], type: 'image' }],
          link: body.link || '',
          tags: body.tags || [],
          scheduleAt: body.scheduleAt || null,
          listing_id: body.listing_id || null,
          scheduled_post_id: body.scheduled_post_id || body.id || null,
          callbackUrl: baseUrl ? `${baseUrl}/api/social?action=makeCallback` : '',
          callbackSecret: process.env.MAKE_CALLBACK_SECRET || '',
          timestamp: new Date().toISOString(),
        };

        const r = await fetch(make.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(`Make.com returned ${r.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
        }
        result = { success: true, published: false, queued: true, publish_status: 'queued_external', status: r.status, source: make.source, message: 'Sent to Make.com; waiting for publish confirmation' };
        break;
      }

      // ── ZAPIER webhook ─────────────────────────────────────
      case 'postZapier': {
        const url = process.env.ZAPIER_WEBHOOK_URL;
        if (!url) return res.status(400).json({ error: 'ZAPIER_WEBHOOK_URL not set' });

        const payload = {
          platform: body.platform || 'all',
          title: body.title || '',
          caption: body.text || '',
          imageUrl: body.imageUrl || '',
          link: body.link || '',
          scheduleAt: body.scheduleAt || null,
          listing_id: body.listing_id || null,
          timestamp: new Date().toISOString(),
        };

        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(`Zapier returned ${r.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
        }
        result = { success: true, published: false, queued: true, publish_status: 'queued_external', status: r.status, message: 'Sent to Zapier; waiting for publish confirmation' };
        break;
      }

      // ── METRICOOL ──────────────────────────────────────────
      case 'postMetricool': {
        const apiKey = process.env.METRICOOL_API_KEY;
        const brandId = process.env.METRICOOL_BRAND_ID;
        if (!apiKey || !brandId) return res.status(400).json({ error: 'METRICOOL_API_KEY or METRICOOL_BRAND_ID not set' });

        const { text, imageUrl, platform, scheduleAt } = body;

        const platforms = await resolveSocialHermesMetricoolPlatforms(platform);
        if (!platforms.length) {
          return res.status(400).json({
            success: false,
            error: 'No configured social platforms found for Metricool all-platform publish. Configure Social settings or pass an explicit platform.',
          });
        }

        // Metricool API v2
        const payload = {
          brand_id: brandId,
          platforms,
          content: text || '',
          ...(imageUrl ? { media: [{ url: imageUrl, type: 'image' }] } : {}),
          ...(scheduleAt ? { scheduled_at: scheduleAt } : {}),
        };

        const r = await fetch('https://app.metricool.com/api/v2/posts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || d.message || `Metricool returned ${r.status}`);
        result = { success: true, published: false, queued: true, publish_status: 'queued_external', status: r.status, data: d };
        break;
      }

      // ── INSTAGRAM single image ─────────────────────────────
      case 'postInstagram': {
        const token = body.token || process.env.INSTAGRAM_ACCESS_TOKEN;
        const userId = body.userId || process.env.INSTAGRAM_USER_ID;
        if (!token || !userId) return res.status(400).json({ error: 'Instagram not configured — go to Settings → Social → Instagram and connect your account' });

        const { caption, imageUrl } = body;

        // Step 1: create media container
        const createRes = await fetch(
          `https://graph.facebook.com/v25.0/${userId}/media?image_url=${encodeURIComponent(imageUrl)}&caption=${encodeURIComponent(caption || '')}&access_token=${token}`,
          { method: 'POST' }
        );
        const create = await createRes.json();
        if (!createRes.ok || create.error) throw new Error(create.error?.message || 'Instagram container failed');

        // Step 2: poll until container is ready (status = FINISHED)
        const containerId = create.id;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const statusRes = await fetch(`https://graph.facebook.com/v25.0/${containerId}?fields=status_code&access_token=${token}`);
          const status = await statusRes.json();
          if (status.status_code === 'FINISHED') break;
          if (status.status_code === 'ERROR') throw new Error('Instagram media processing failed — try a different image');
        }

        // Step 3: publish
        const pubRes = await fetch(
          `https://graph.facebook.com/v25.0/${userId}/media_publish?creation_id=${containerId}&access_token=${token}`,
          { method: 'POST' }
        );
        const pub = await pubRes.json();
        if (!pubRes.ok || pub.error) throw new Error(pub.error?.message || 'Instagram publish failed');

        // Step 4: get permalink
        let permalink = null;
        try {
          const linkRes = await fetch(`https://graph.facebook.com/v25.0/${pub.id}?fields=permalink&access_token=${token}`);
          const linkData = await linkRes.json();
          permalink = normalizeInstagramPermalink(linkData.permalink);
        } catch {}

        result = { success: true, media_id: pub.id, post_url: permalink };
        break;
      }

      // ── INSTAGRAM carousel (multiple images) ───────────────
      case 'postInstagramCarousel': {
        const token = body.token || process.env.INSTAGRAM_ACCESS_TOKEN;
        const userId = body.userId || process.env.INSTAGRAM_USER_ID;
        if (!token || !userId) return res.status(400).json({ error: 'Instagram not configured — go to Settings → Social → Instagram and connect your account' });

        const { caption, imageUrls } = body;
        if (!Array.isArray(imageUrls) || imageUrls.length < 2) {
          return res.status(400).json({ error: 'imageUrls array with 2-10 images required for carousel' });
        }

        // Step 1: create a container for each image (no caption on individual items)
        const itemIds = [];
        for (const imgUrl of imageUrls.slice(0, 10)) {
          const r = await fetch(
            `https://graph.facebook.com/v25.0/${userId}/media?image_url=${encodeURIComponent(imgUrl)}&is_carousel_item=true&access_token=${token}`,
            { method: 'POST' }
          );
          const d = await r.json();
          if (!r.ok || d.error) throw new Error(d.error?.message || `Failed to create container for ${imgUrl}`);
          itemIds.push(d.id);
        }

        // Step 2: create carousel container
        const carouselRes = await fetch(
          `https://graph.facebook.com/v25.0/${userId}/media?media_type=CAROUSEL&children=${itemIds.join(',')}&caption=${encodeURIComponent(caption || '')}&access_token=${token}`,
          { method: 'POST' }
        );
        const carousel = await carouselRes.json();
        if (!carouselRes.ok || carousel.error) throw new Error(carousel.error?.message || 'Carousel container failed');

        // Step 3: poll until carousel container is ready
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const statusRes = await fetch(`https://graph.facebook.com/v25.0/${carousel.id}?fields=status_code&access_token=${token}`);
          const status = await statusRes.json();
          if (status.status_code === 'FINISHED') break;
          if (status.status_code === 'ERROR') throw new Error('Instagram carousel processing failed');
        }

        // Step 4: publish
        const pubRes = await fetch(
          `https://graph.facebook.com/v25.0/${userId}/media_publish?creation_id=${carousel.id}&access_token=${token}`,
          { method: 'POST' }
        );
        const pub = await pubRes.json();
        if (!pubRes.ok || pub.error) throw new Error(pub.error?.message || 'Carousel publish failed');

        // Step 5: get permalink
        let permalink = null;
        try {
          const linkRes = await fetch(`https://graph.facebook.com/v25.0/${pub.id}?fields=permalink&access_token=${token}`);
          const linkData = await linkRes.json();
          permalink = normalizeInstagramPermalink(linkData.permalink);
        } catch {}

        result = { success: true, media_id: pub.id, post_url: permalink, images: itemIds.length };
        break;
      }

      // ── FACEBOOK direct ────────────────────────────────────
      case 'postFacebook': {
        const token = body.token || body.pageToken || body.page_token || process.env.FACEBOOK_PAGE_TOKEN;
        const pageId = body.pageId || body.page_id || process.env.FACEBOOK_PAGE_ID;
        if (!token || !pageId) return res.status(400).json({ error: 'Facebook posts not configured — connect Facebook in Settings or set FACEBOOK_PAGE_TOKEN / FACEBOOK_PAGE_ID' });

        const { text, link, imageUrl } = body;
        const params = new URLSearchParams({ access_token: token });
        if (text) params.set('message', text);
        if (link) params.set('link', link);

        let endpoint = `https://graph.facebook.com/v25.0/${pageId}/feed`;
        if (imageUrl) endpoint = `https://graph.facebook.com/v25.0/${pageId}/photos`;
        if (imageUrl) params.set('url', imageUrl);

        const r = await fetch(`${endpoint}?${params}`, { method: 'POST' });
        const d = await r.json().catch(() => ({}));
        if (d.error) throw new Error(d.error.message);
        if (!r.ok) throw new Error(d.message || `Facebook returned ${r.status}`);
        result = { success: true, published: true, post_id: d.id };
        break;
      }

      // ── PINTEREST ───────────────────────────────────
      // Note: Pinterest API requires business account approval + review
      // Recommend using Buffer or Make.com webhook instead
      case 'postPinterest': {
        const token = body.token || process.env.PINTEREST_ACCESS_TOKEN;
        if (!token) return res.status(400).json({
          error: 'Pinterest publishing requires business account approval. Use Buffer or Make.com instead.',
          suggestion: 'Set BUFFER_ACCESS_TOKEN and configure your Buffer Pinterest board, or use MAKE_WEBHOOK_URL.',
        });

        const { title, link, imageUrl } = body;
        const description = body.description || body.caption || body.text || '';
        const board_id = body.board_id || body.boardId;
        if (!board_id) return res.status(400).json({ error: 'board_id required for Pinterest' });

        const payload = {
          board_id,
          title: title || '',
          description: description || '',
          link: link || '',
          media_source: imageUrl ? { source_type: 'image_url', url: imageUrl } : undefined,
        };

        const r = await fetch('https://api.pinterest.com/v5/pins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (d.code) throw new Error(d.message || 'Pinterest API error');
        result = { success: true, published: true, pin_id: d.id };
        break;
      }

      // ── GET Pinterest boards ────────────────────────────────
      case 'getPinterestBoards': {
        const token = process.env.PINTEREST_ACCESS_TOKEN;
        if (!token) return res.json({ success: true, boards: [], note: 'No Pinterest token — configure via Buffer' });

        const r = await fetch('https://api.pinterest.com/v5/boards?page_size=50', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const d = await r.json();
        result = { success: true, boards: d.items || [] };
        break;
      }

      // ── GET Facebook pages ─────────────────────────────────
      case 'getFacebookPages': {
        const token = process.env.FACEBOOK_PAGE_TOKEN;
        if (!token) return res.json({ success: true, pages: [], note: 'No Facebook token configured' });

        const r = await fetch(`https://graph.facebook.com/v25.0/me/accounts?access_token=${token}`);
        const d = await r.json();
        result = { success: true, pages: d.data || [] };
        break;
      }

      // ── SMART CROSSPOST (platform-specific routing) ─────────
      case 'smartPost': {
        const { text, imageUrl, imageUrls, media_items, link, platform, scheduleAt, listing_id, title, scheduled_post_id } = body;
        const platformKey = String(platform || '').toLowerCase();
        const make = await getMakeWebhookUrl();
        const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
        let method = null;
        let r;

        // Do not use Make as a generic router. In this shop Make is the Pinterest bridge.
        // Instagram/Facebook publish through Etsy AI Command Center using the saved Meta settings.
        if (platformKey === 'instagram') {
          method = 'Etsy AI Command Center Instagram publisher';
          const action = urls.length > 1 || (Array.isArray(media_items) && media_items.length > 1)
            ? 'postInstagramCarousel'
            : 'postInstagram';
          r = await handler({ method: 'POST', headers: req.headers, body: { action, caption: text, imageUrl, imageUrls: urls, media_items, listing_id, scheduled_post_id } }, { json: (d) => d, status: () => ({ json: (d) => d }) });
        } else if (platformKey === 'facebook') {
          method = 'Etsy AI Command Center Facebook publisher';
          r = await handler({ method: 'POST', headers: req.headers, body: { action: 'postFacebook', text, imageUrl, link, listing_id, scheduled_post_id } }, { json: (d) => d, status: () => ({ json: (d) => d }) });
        } else if (platformKey === 'pinterest') {
          method = 'Make.com Pinterest bridge';
          if (!make.url) return res.status(400).json({ error: 'Pinterest is configured through Make.com, but the Make webhook URL is missing.' });
          r = await handler({ method: 'POST', headers: req.headers, body: { action: 'postMake', platform: 'pinterest', text, imageUrl, imageUrls: urls, media_items, link, title, listing_id, scheduleAt, scheduled_post_id } }, { json: (d) => d, status: () => ({ json: (d) => d }) });
        } else if (platformKey === 'tiktok') {
          if (process.env.BUFFER_ACCESS_TOKEN) {
            method = 'Buffer';
            r = await handler({ method: 'POST', headers: req.headers, body: { action: 'postBuffer', text, imageUrl, link, scheduleAt } }, { json: (d) => d, status: () => ({ json: (d) => d }) });
          } else if (process.env.METRICOOL_API_KEY && process.env.METRICOOL_BRAND_ID) {
            method = 'Metricool';
            r = await handler({ method: 'POST', headers: req.headers, body: { action: 'postMetricool', text, imageUrl, platform, scheduleAt } }, { json: (d) => d, status: () => ({ json: (d) => d }) });
          } else {
            return res.status(400).json({ error: 'TikTok publishing is not wired here. Configure Buffer/Metricool or keep TikTok manual.' });
          }
        } else {
          return res.status(400).json({
            error: 'Choose one explicit platform for publishing: instagram, facebook, pinterest, or tiktok.',
            hint: 'Instagram/Facebook publish through Etsy AI Command Center settings; Pinterest uses Make.com; TikTok uses Buffer/Metricool/manual.',
          });
        }

        if (r?.error) throw new Error(`${method}: ${r.error}`);
        result = { success: true, method, published: r?.published === true, queued: r?.published !== true, data: r };
        break;
      }

      // ── Action aliases (frontend uses these names) ─────────
      case 'sendToBuffer':
        return handler({ method: 'POST', body: { ...body, action: 'postBuffer' } }, res);
      case 'sendToMetricool':
        return handler({ method: 'POST', body: { ...body, action: 'postMetricool' } }, res);
      case 'sendToMake':
        return handler({ method: 'POST', body: { ...body, action: 'postMake' } }, res);
      case 'sendToZapier':
        return handler({ method: 'POST', body: { ...body, action: 'postZapier' } }, res);

      // ── TikTok (use Buffer/Metricool) ──────
      case 'postTikTok':
        return res.status(400).json({
          error: 'TikTok publishing is not supported here. Use Buffer or Metricool to post TikTok captions.',
          suggestion: 'Set BUFFER_ACCESS_TOKEN in .env and connect your TikTok account in Buffer.',
        });

      // ── GET Buffer profiles ─────────────────────────────────
      case 'getBufferProfiles': {
        const token = body.token || process.env.BUFFER_ACCESS_TOKEN;
        if (!token) return res.status(400).json({ error: 'No token provided' });
        const r = await fetch(`https://api.bufferapp.com/1/profiles.json?access_token=${token}`);
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Buffer API error');
        result = { profiles: (Array.isArray(d) ? d : []).map(p => ({ id: p.id, service: p.service, name: p.formatted_service_type || p.service })) };
        break;
      }

      // ── CHECK which services are configured ────────────────
      case 'checkConfig': {
        const make = await getMakeWebhookUrl();
        const socialConfigs = await kvGet('social_configs').catch(() => ({}));
        const socialConfigSummary = summarizeSocialHermesSocialConfigs(socialConfigs || {});
        const platformCapabilityContext = socialHermesUiPlatformCapabilityContext(socialConfigSummary);
        return res.json({
          hasBuffer: !!process.env.BUFFER_ACCESS_TOKEN,
          hasMake: platformCapabilityContext.hasMake,
          makeSource: make.source,
          hasZapier: !!process.env.ZAPIER_WEBHOOK_URL,
          hasMetricool: !!(process.env.METRICOOL_API_KEY && process.env.METRICOOL_BRAND_ID),
          hasFacebook: platformCapabilityContext.hasFacebook,
          hasInstagram: platformCapabilityContext.hasInstagram,
          hasPinterest: platformCapabilityContext.hasPinterest,
          configured_platforms: socialConfigSummary.configured_platforms,
          all_platform_target: socialConfigSummary.all_platform_target,
          connector_states: socialConfigSummary.connector_states,
          social_config_summary: socialConfigSummary,
        });
      }

      // ── Scheduled post publisher (manual/cron-safe action) ─────
      case 'schedulerStatus': {
        result = await getSchedulerStatus();
        break;
      }

      case 'adminCanaryReadiness': {
        if (!adminAuthorized) return res.status(403).json({ error: 'Admin session required to review canary readiness', code: 'ADMIN_CANARY_READINESS_REQUIRED' });
        const readiness = await getSocialHermesCanaryReadiness(body);
        result = {
          data: redactSocialHermesSecrets(readiness),
          saved: false,
          published: false,
          note: 'Admin-only read-only canary readiness diagnostics. This does not approve, schedule, publish, or enable autopublish.',
        };
        break;
      }

      case 'publishDueScheduled': {
        result = await publishSocialHermesDueScheduled({
          dryRun: body.dryRun,
          limit: body.limit,
          now: body.now,
          canaryId: body.canary_id || body.canaryId,
        });
        break;
      }

      case 'approveScheduledPost': {
        if (!adminAuthorized) return res.status(403).json({ error: 'Admin session required to approve autopublish', code: 'ADMIN_APPROVAL_REQUIRED' });
        const id = body.id || body.post_id || body.scheduled_post_id;
        if (!id) return res.status(400).json({ error: 'id required' });
        const updated = await approveScheduledPost(id, {
          approvedBy: body.approved_by || 'admin-ui',
          note: body.note || body.approval_note || '',
          minLeadMinutes: body.min_lead_minutes ?? 5,
          readinessCheck: (post, options = {}) => evaluateSocialHermesPublishReadiness(post, {
              now: options.now || new Date(),
              minLeadMinutes: options.minLeadMinutes ?? 5,
          }),
        });
        result = { success: true, data: { ...updated, ...classifyScheduledPost(updated) }, published: false };
        break;
      }

      case 'restoreScheduledPostToDraft': {
        if (!adminAuthorized) return res.status(403).json({ error: 'Admin session required to restore a scheduled post', code: 'ADMIN_SCHEDULE_UPDATE_REQUIRED' });
        const id = body.id || body.post_id || body.scheduled_post_id;
        if (!id) return res.status(400).json({ error: 'id required' });
        const restored = await restoreScheduledPostToDraft(id, body.snapshot || body.post || {});
        result = {
          success: true,
          data: {
            ...restored,
            record: { ...restored.record, ...classifyScheduledPost(restored.record) },
          },
          published: false,
        };
        break;
      }

      case 'recoverQueuedExternalPostToDraft': {
        if (!adminAuthorized) return res.status(403).json({ error: 'Admin session required to recover an externally queued post', code: 'ADMIN_SCHEDULE_UPDATE_REQUIRED' });
        const id = body.id || body.post_id || body.scheduled_post_id;
        if (!id) return res.status(400).json({ error: 'id required' });
        const recovered = await recoverQueuedExternalPostToDraft(id);
        result = {
          success: true,
          data: {
            record: { ...recovered.record, ...classifyScheduledPost(recovered.record) },
            original: { ...recovered.original, ...classifyScheduledPost(recovered.original) },
          },
          published: false,
        };
        break;
      }

      case 'unapproveScheduledPost': {
        if (!adminAuthorized) return res.status(403).json({ error: 'Admin session required to change autopublish approval', code: 'ADMIN_APPROVAL_REQUIRED' });
        const id = body.id || body.post_id || body.scheduled_post_id;
        if (!id) return res.status(400).json({ error: 'id required' });
        const updated = await unapproveScheduledPost(id, {
          unapprovedBy: body.unapproved_by || 'admin-ui',
          reason: body.reason || '',
        });
        result = { success: true, data: { ...updated, ...classifyScheduledPost(updated) }, published: false };
        break;
      }

      case 'makeCallback': {
        if (!hasMakeCallbackSecret(req, body)) return res.status(401).json({ error: 'Invalid Make callback secret' });
        result = await applyMakeCallback(body);
        break;
      }

      // ── FACEBOOK — exchange short-lived token for long-lived (60 days) ─
      case 'extendFacebookToken': {
        const appId = process.env.FACEBOOK_APP_ID;
        const appSecret = process.env.FACEBOOK_APP_SECRET;
        const token = body.token;
        if (!appId || !appSecret) return res.status(400).json({ error: 'FACEBOOK_APP_ID / FACEBOOK_APP_SECRET not set' });
        if (!token) return res.status(400).json({ error: 'token required' });

        const r = await fetch(`https://graph.facebook.com/v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${token}`);
        const d = await r.json();
        if (d.error) throw new Error(d.error.message);

        // Also get a Page Token from the long-lived user token (page tokens from long-lived = permanent)
        const pageId = body.page_id || process.env.FACEBOOK_PAGE_ID;
        let pageToken = null;
        if (pageId) {
          const pr = await fetch(`https://graph.facebook.com/v25.0/${pageId}?fields=access_token&access_token=${d.access_token}`);
          const pd = await pr.json();
          if (!pd.error) pageToken = pd.access_token;
        }

        result = {
          success: true,
          access_token: d.access_token,       // long-lived user token (60 days)
          page_token: pageToken,               // page token (never expires if from long-lived)
          expires_in: d.expires_in || 5184000, // seconds (~60 days)
          token_type: d.token_type,
        };
        break;
      }

      // ── INSTAGRAM — fetch business account from token ────────
      case 'getMyInstagram': {
        const token = body.token;
        if (!token) return res.status(400).json({ error: 'token required' });

        // Verify token first. User objects do not expose `category`; requesting it breaks valid User Tokens.
        const meRes = await fetch(`https://graph.facebook.com/v25.0/me?fields=id,name&access_token=${token}`);
        const me = await meRes.json();
        if (me.error) throw new Error(me.error.message + ' — потрібен User Token з Graph API Explorer, не Page Token');

        // Get Facebook Pages with linked Instagram Business Accounts.
        // `connected_instagram_account` helps diagnose Page links that exist but are not Business/Creator API-ready.
        const r = await fetch(`https://graph.facebook.com/v25.0/me/accounts?fields=name,id,connected_instagram_account{id,username},instagram_business_account{id,username,profile_picture_url}&access_token=${token}`);
        const d = await r.json();
        if (d.error) {
          if (d.error.code === 100) throw new Error('Невірний тип токена. Потрібен User Access Token (не Page Token). Відкрий Graph API Explorer → Generate User Access Token з правами: instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement.');
          throw new Error(d.error.message);
        }

        const pages = d.data || [];
        const accounts = pages
          .filter(p => p.instagram_business_account)
          .map(p => ({
            page_id: p.id,
            page_name: p.name,
            ig_id: p.instagram_business_account.id,
            ig_username: p.instagram_business_account.username,
            ig_picture: p.instagram_business_account.profile_picture_url,
          }));

        if (!accounts.length && pages.length > 0) {
          const pageSummary = pages.slice(0, 5).map(p => {
            const connected = p.connected_instagram_account?.username ? `IG linked: @${p.connected_instagram_account.username}, but not Business API-ready` : 'no IG link';
            return `${p.name} (${connected})`;
          }).join('; ');
          throw new Error(`Facebook Pages знайдено, але жодна не повертає instagram_business_account. Pages: ${pageSummary}. Для публікації Instagram має бути Professional (Business/Creator) і прив'язаний до цієї Facebook Page в Page Settings або Meta Business Suite, не лише в Accounts Center.`);
        }

        result = { success: true, accounts };
        break;
      }

      // ── INSTAGRAM — refresh long-lived token ──────────────────
      case 'verifyInstagramDirect': {
        const token = body.token;
        const igId = body.igId || body.ig_id || body.userId;
        if (!token) return res.status(400).json({ error: 'token required' });
        if (!igId) return res.status(400).json({ error: 'Instagram Business ID required' });

        const r = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(igId)}?fields=id,username,profile_picture_url&access_token=${encodeURIComponent(token)}`);
        const d = await r.json();
        if (d.error) throw new Error(d.error.message);
        result = {
          success: true,
          ig_id: d.id || igId,
          ig_username: d.username || '',
          ig_picture: d.profile_picture_url || '',
        };
        break;
      }

      case 'refreshInstagramToken': {
        const token = body.token;
        if (!token) return res.status(400).json({ error: 'token required' });

        // Works for Instagram Basic Display API long-lived tokens
        const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refreshing_token&access_token=${token}`);
        const d = await r.json();
        if (d.error) throw new Error(d.error.message);
        result = { success: true, access_token: d.access_token, expires_in: d.expires_in };
        break;
      }

      // ── FACEBOOK — fetch pages + catalogs for a given token ─
      case 'getMyFacebook': {
        const token = body.token;
        if (!token) return res.status(400).json({ error: 'token required' });

        const [pagesRes, bizRes] = await Promise.all([
          fetch(`https://graph.facebook.com/v25.0/me/accounts?access_token=${token}`),
          fetch(`https://graph.facebook.com/v25.0/me/businesses?access_token=${token}`),
        ]);
        const [pagesData, bizData] = await Promise.all([pagesRes.json(), bizRes.json()]);
        if (pagesData.error) throw new Error(pagesData.error.message);
        if (bizData.error) throw new Error(bizData.error.message);

        // Fetch catalogs for each business
        const businesses = bizData.data || [];
        const catalogsByBiz = await Promise.all(
          businesses.map(async (biz) => {
            const r = await fetch(`https://graph.facebook.com/v25.0/${biz.id}/owned_product_catalogs?access_token=${token}`);
            const d = await r.json();
            return { business_id: biz.id, business_name: biz.name, catalogs: d.data || [] };
          })
        );
        result = { success: true, pages: pagesData.data || [], businesses: catalogsByBiz };
        break;
      }

      // ── FACEBOOK — create catalog for a business ───────────
      case 'createFacebookCatalog': {
        const token = body.token || process.env.FACEBOOK_PAGE_TOKEN;
        const { business_id, name } = body;
        if (!token || !business_id) return res.status(400).json({ error: 'token and business_id required' });

        const r = await fetch(`https://graph.facebook.com/v25.0/${business_id}/owned_product_catalogs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: token, name: name || 'My Shop Catalog', vertical: 'commerce' }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message);
        result = { success: true, catalog_id: d.id };
        break;
      }

      // ── FACEBOOK SHOPS — Product Catalog sync ─────────────
      // Token/catalogId can come from body (localStorage config) or env vars
      case 'syncFacebookShop': {
        // Prefer body token (localStorage) but fall back to env if body token is expired/invalid
        const tokenCandidates = [body.token, process.env.FACEBOOK_PAGE_TOKEN].filter(Boolean);
        if (!tokenCandidates.length) return res.status(400).json({ error: 'FACEBOOK_PAGE_TOKEN not set' });
        const token = tokenCandidates[0]; // will retry with next if auth error
        const catalogId = body.catalog_id || process.env.FACEBOOK_CATALOG_ID;
        if (!token) return res.status(400).json({ error: 'FACEBOOK_PAGE_TOKEN not set' });
        if (!catalogId) return res.status(400).json({ error: 'FACEBOOK_CATALOG_ID not set' });

        const { listing_id, name, description, price_amount, currency, image_urls, checkout_url } = body;
        if (!listing_id || !name || !checkout_url) {
          return res.status(400).json({ error: 'listing_id, name, checkout_url are required' });
        }

        // Price must be "9.99 USD" string format (not cents integer)
        const priceStr = `${parseFloat(price_amount || 0).toFixed(2)} ${currency || 'USD'}`;
        const images = Array.isArray(image_urls) ? image_urls.filter(Boolean) : (image_urls ? [image_urls] : []);

        const data = {
          id: `etsy_${listing_id}`,
          title: name,
          description: description || '',
          price: priceStr,
          link: checkout_url,
          availability: 'in stock',
          condition: 'new',
          brand: body.brand || 'Etsy',
        };
        if (images[0]) data.image_link = images[0];
        if (images.length > 1) data.additional_image_link = images.slice(1, 10);

        const batchPost = async (method, tok) => {
          const r = await fetch(`https://graph.facebook.com/v25.0/${catalogId}/items_batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              access_token: tok,
              item_type: 'PRODUCT_ITEM',
              requests: [{ method, retailer_id: `etsy_${listing_id}`, data }],
            }),
          });
          return r.json();
        };

        // Try each token candidate — falls back to env token if localStorage one is expired
        let activeToken = token;
        let d = await batchPost('CREATE', activeToken);
        if (d.error?.code === 190 && tokenCandidates.length > 1) {
          // Auth error — retry with env token
          activeToken = tokenCandidates[1];
          d = await batchPost('CREATE', activeToken);
        }
        if (d.error) throw new Error(d.error.message);
        let valErrors = (d.validation_status || []).flatMap(s => s.errors || []);

        // If CREATE failed (item already exists), retry with UPDATE
        if (valErrors.length) {
          d = await batchPost('UPDATE', activeToken);
          if (d.error) throw new Error(d.error.message);
          valErrors = (d.validation_status || []).flatMap(s => s.errors || []);
          if (valErrors.length) throw new Error(valErrors[0].message);
        }

        result = { success: true, retailer_id: `etsy_${listing_id}`, handles: d.handles };
        break;
      }

      case 'unsyncFacebookShop': {
        const token = body.token || process.env.FACEBOOK_PAGE_TOKEN;
        const catalogId = body.catalog_id || process.env.FACEBOOK_CATALOG_ID;
        if (!token) return res.status(400).json({ error: 'FACEBOOK_PAGE_TOKEN not set' });
        if (!catalogId) return res.status(400).json({ error: 'FACEBOOK_CATALOG_ID not set' });

        const { listing_id } = body;
        if (!listing_id) return res.status(400).json({ error: 'listing_id required' });

        const r = await fetch(`https://graph.facebook.com/v25.0/${catalogId}/items_batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            access_token: token,
            item_type: 'PRODUCT_ITEM',
            requests: [{ method: 'DELETE', retailer_id: `etsy_${listing_id}` }],
          }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message);
        result = { success: true };
        break;
      }

      // ── FACEBOOK CATALOG — read existing products ──────────
      case 'getFacebookCatalogProducts': {
        const token = body.token || process.env.FACEBOOK_PAGE_TOKEN;
        const catalogId = body.catalog_id || process.env.FACEBOOK_CATALOG_ID;
        if (!token) return res.status(400).json({ error: 'FACEBOOK_PAGE_TOKEN not set' });
        if (!catalogId) return res.status(400).json({ error: 'FACEBOOK_CATALOG_ID not set' });

        // Paginate through all products in the catalog
        const all = [];
        let url = `https://graph.facebook.com/v25.0/${catalogId}/products?fields=id,retailer_id,name,availability&limit=200&access_token=${token}`;
        let pages = 0;
        while (url && pages < 20) {
          const r = await fetch(url);
          const d = await r.json();
          if (d.error) throw new Error(d.error.message || 'FB API error');
          if (d.data) all.push(...d.data);
          url = d.paging?.next || null;
          pages++;
        }
        return res.json({ success: true, products: all });
      }

      case 'checkFacebookShopConfig': {
        const hasEnvToken = !!process.env.FACEBOOK_PAGE_TOKEN;
        const hasEnvCatalog = !!process.env.FACEBOOK_CATALOG_ID;
        // Also accept config from body (localStorage-sourced)
        const hasBodyToken = !!body.token;
        const hasBodyCatalog = !!body.catalog_id;
        return res.json({
          hasToken: hasEnvToken || hasBodyToken,
          hasCatalogId: hasEnvCatalog || hasBodyCatalog,
          pageId: process.env.FACEBOOK_PAGE_ID || null,
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    return res.json({ success: true, ...result });

  } catch (err) {
    console.error('[social]', action, err.message);
    if (['approveScheduledPost', 'unapproveScheduledPost', 'restoreScheduledPostToDraft', 'recoverQueuedExternalPostToDraft'].includes(action) && err?.code) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    return sendPublicError(res, err);
  }
}
