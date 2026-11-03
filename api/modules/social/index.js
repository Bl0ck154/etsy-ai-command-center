import {
  createSocialReviewArtifactService,
  SOCIAL_REVIEW_ARTIFACT_TTL_SECONDS,
  SOCIAL_REVIEW_CONTRACT_VERSION,
  socialHermesArtifactHash,
  socialHermesReviewContentDigest,
  withoutCallerSuppliedSocialReviewTrust,
} from './application/review-artifacts.js';
import {
  createSocialPublishReadinessService,
  socialHermesCanaryReadinessForPost,
} from './application/publish-readiness.js';
import {
  buildSafeSocialHermesContextPayload,
  createSocialContextService,
} from './application/collect-context.js';
import {
  buildSocialOwnerReviewNotificationMessage,
  createSocialOwnerReviewService,
} from './application/manage-owner-review.js';
import {
  asSocialOwnerReviewOnlyRecord,
  createSocialOwnerReviewProducerApplication,
  SOCIAL_OWNER_REVIEW_PRODUCER_DEFAULT_RUN_BUDGET_MS,
  SOCIAL_OWNER_REVIEW_PRODUCER_MAX_RUN_BUDGET_MS,
} from './application/produce-owner-review.js';
import {
  createSocialContentOpportunityService,
  createSocialContentOpportunitySemanticFilter,
  normalizeSocialOwnerFeedbackMemory,
} from './application/select-content-opportunities.js';
import { createSocialCreativePlanService } from './application/plan-creative-campaign.js';
import { createSocialMediaGenerationService } from './application/generate-media.js';
import {
  publishDueScheduled as runSchedulerPublishDueScheduled,
  publishGovernanceStatus,
} from '../../_scheduler.js';
import {
  buildProviderUrl,
  generateImagesWithExternalAi,
  getExternalAiRuntimeConfig,
  hasExternalImageConfigAsync,
} from '../../_external-ai.js';
import {
  normalizeSocialReviewCardDesign,
  normalizeSocialReviewCardEvidence,
  renderSocialReviewCardPng,
  socialReviewCardRenderSpecSha256,
} from '../../_social-review-card.js';
import { reviewGeneratedSocialImage } from '../../_social-media-quality.js';
import { kvGet, kvSet } from '../../kv.js';
import { socialReviewArtifactRepository } from './infrastructure/review-artifact-repository.js';
import {
  getScheduledPosts as getSocialScheduledPosts,
  saveScheduledPost as saveSocialScheduledPost,
  saveScheduledPostBatch as saveSocialScheduledPostBatch,
  updateScheduledPost as updateSocialScheduledPost,
} from './queue.js';
import { socialPublishConfigAdapter } from './infrastructure/publish-config.js';
import { socialContextSources } from './infrastructure/context-sources.js';
import { socialOwnerReviewNotificationGateway } from './infrastructure/owner-review-notifications.js';
import { createSocialProducerRunRepository } from './infrastructure/producer-run-repository.js';
import { normalizeGeneratedSocialImageGeometry } from './infrastructure/media-geometry.js';
import { createSocialMediaProviderRouter } from './infrastructure/media-provider-routing.js';
import { storePersistentSocialMediaAsset } from './infrastructure/media-store.js';

export {
  deleteScheduledPost,
  getScheduledPosts,
  saveScheduledPost,
  saveScheduledPostBatch,
  updateScheduledPost,
} from './queue.js';

export {
  createSocialReviewArtifactService,
  SOCIAL_REVIEW_ARTIFACT_TTL_SECONDS,
  SOCIAL_REVIEW_CONTRACT_VERSION,
  socialHermesArtifactHash,
  socialHermesReviewContentDigest,
  withoutCallerSuppliedSocialReviewTrust,
};

export {
  createSocialPublishReadinessService,
  socialHermesCanaryReadinessForPost,
  socialHermesCaptionQualityProblem,
  socialHermesCarouselMediaReadinessError,
  socialHermesRecordEligibleForAutoArm,
  socialHermesRecordHasForbiddenFallbackMedia,
  socialHermesRecordHasPublicMedia,
} from './application/publish-readiness.js';

export {
  buildSocialHermesSnapshotFacts,
  createSocialContextService,
  mergeSocialHermesSourceSnapshots,
  SOCIAL_HERMES_CONTEXT_CACHE_TTL_SECONDS,
  SOCIAL_HERMES_ACTION_NAMES,
} from './application/collect-context.js';

export {
  buildSocialOwnerReviewNotificationMessage,
  createSocialOwnerReviewService,
  expandSocialOwnerReviewRecord,
  socialOwnerReviewAutoSchedule,
  socialOwnerReviewNotificationCampaignDigest,
  socialOwnerReviewNotificationReady,
  socialOwnerReviewNotificationRecordDigest,
  withServerSocialOwnerReviewDigest,
} from './application/manage-owner-review.js';

export {
  asSocialOwnerReviewOnlyRecord,
  createSocialOwnerReviewProducerApplication,
  SOCIAL_OWNER_REVIEW_PRODUCER_DEFAULT_RUN_BUDGET_MS,
  SOCIAL_OWNER_REVIEW_PRODUCER_MAX_RUN_BUDGET_MS,
};

export { createSocialOwnerReviewProducerComposition } from './owner-review-producer-composition.js';

export { createSocialOwnerReviewCampaignComposition } from './owner-review-campaign-composition.js';

export {
  createSocialOwnerReviewCampaignPreparationCoordinator,
  SOCIAL_OWNER_REVIEW_CREATIVE_PLAN_TIMEOUT_MS,
  SOCIAL_OWNER_REVIEW_GENERATE_MEDIA_TIMEOUT_MS,
  SOCIAL_OWNER_REVIEW_GENERATION_CONCURRENCY,
  SOCIAL_OWNER_REVIEW_GENERATION_ROUND_LIMIT,
  SOCIAL_OWNER_REVIEW_MIN_PROVIDER_BUDGET_MS,
  SOCIAL_OWNER_REVIEW_MIN_REPLAN_BUDGET_MS,
} from './application/coordinate-owner-review-campaign-preparation.js';

export { createSocialOwnerReviewCampaignPreparationService } from './application/prepare-owner-review-campaign.js';
export { createSocialOwnerReviewPlanValidator } from './application/validate-owner-review-plan.js';

export {
  createSocialContentOpportunityService,
  createSocialContentOpportunitySemanticFilter,
  normalizeSocialOwnerFeedbackMemory,
};

export { createSocialCreativePlanService };

export {
  createSocialListingUnderstandingValidationService,
} from './application/validate-listing-understanding.js';
export { createSocialListingUnderstandingUsabilityService } from './application/evaluate-listing-understanding-usability.js';
export { createSocialMediaStrategyValidationRules } from './domain/media-strategy-validation.js';
export { createSocialCaptionReviewContracts } from './domain/caption-review-contracts.js';
export { createSocialListingUnderstandingNormalizer } from './domain/listing-understanding-normalization.js';
export { createSocialAiPlanningPayloadBuilder } from './domain/ai-planning-payloads.js';

export {
  attachSocialCreativePlanReviewArtifacts,
  buildSocialListingAvailabilitySnapshot,
  buildSocialMediaGenerationResolution,
  createSocialCreativePlanProductionService,
  hydrateCurrentSocialListingFacts,
  hydrateSocialCampaignQualityVariants,
  socialCampaignQualityBlockingSummary,
  socialCreativePlanCurrentDateContext,
} from './creative-plan-production.js';

export { createSocialMediaGenerationService };

export {
  normalizeSocialMediaAspectRatio,
  normalizeSocialMediaCropFocus,
  normalizeSocialMediaGenerationRequest,
  normalizeSocialMediaImageTier,
  normalizeSocialMediaReferenceImage,
  supportedSocialMediaAspectRatio,
  valueFromSocialMediaBody,
} from './domain/media-generation-contracts.js';

export { normalizeGeneratedSocialImageGeometry };

export {
  buildSocialListingUnderstandingOutputSchema,
} from './infrastructure/listing-understanding-output-schema.js';

export {
  buildSocialListingUnderstandingRepairPrompt,
  buildSocialListingUnderstandingSystemPrompt,
} from './infrastructure/listing-understanding-prompts.js';

export {
  createSocialCaptionReviewAiStrategy,
  SOCIAL_CAPTION_CRITIC_REPAIR_SYSTEM_PROMPT,
  SOCIAL_CAPTION_CRITIC_SYSTEM_PROMPT,
} from './infrastructure/caption-review-ai.js';

export {
  createSocialCampaignFitAiStrategy,
  SOCIAL_CAMPAIGN_FIT_OUTPUT_SCHEMA,
  SOCIAL_CAMPAIGN_FIT_REPAIR_SYSTEM_PROMPT,
  SOCIAL_CAMPAIGN_FIT_SYSTEM_PROMPT,
} from './infrastructure/campaign-fit-ai.js';

export { createSocialListingUnderstandingAiStrategy } from './infrastructure/listing-understanding-ai.js';

export {
  createSocialMediaProviderRouter,
  socialMediaImageModelsForTier,
  socialMediaProviderErrorDiagnostics,
  socialMediaSafeProviderEndpoint,
  socialMediaTimeoutForTier,
} from './infrastructure/media-provider-routing.js';

export {
  collectSocialHermesEtsyPages,
  createSocialContextSources,
  getSocialHermesListingMedia,
  normalizeSocialHermesListingImage,
  summarizeSocialHermesReview,
} from './infrastructure/context-sources.js';

export {
  createSocialPublishConfigAdapter,
} from './infrastructure/publish-config.js';

export {
  createSocialOwnerReviewNotificationGateway,
} from './infrastructure/owner-review-notifications.js';

export {
  createSocialProducerRunRepository,
  SOCIAL_PRODUCER_LEASE_RECORD_TYPE,
  SOCIAL_PRODUCER_LEASE_SCHEMA_VERSION,
  SOCIAL_PRODUCER_STATUS_RECORD_TYPE,
  SOCIAL_PRODUCER_STATUS_SCHEMA_VERSION,
} from './infrastructure/producer-run-repository.js';

export {
  createSocialReviewArtifactRepository,
} from './infrastructure/review-artifact-repository.js';

export {
  createSocialMediaStore,
  normalizeSocialMediaMimeType,
  readPersistentSocialMediaAsset,
  SOCIAL_HERMES_MAX_MEDIA_ASSET_BYTES,
  socialMediaExtensionForMimeType,
  storePersistentSocialMediaAsset,
} from './infrastructure/media-store.js';

export {
  captionForSocialHermesPlatform,
  normalizeSocialHermesPlatformCaptionVariants,
  normalizeSocialHermesPlatformId,
  normalizeSocialHermesPlatformToken,
  resolveSocialHermesConfiguredPlatforms,
  resolveSocialHermesMetricoolPlatformsFromConfig,
  resolveSocialHermesPublishCapablePlatforms,
  resolveSocialHermesPublishRoute,
  resolveSocialHermesRequestedPlatforms,
  socialHermesUiPlatformCapabilityContext,
  summarizeSocialHermesSocialConfigs,
} from './domain/platform-resolution.js';

const defaultSocialReviewArtifactService = createSocialReviewArtifactService({
  repository: socialReviewArtifactRepository,
});

const defaultSocialPublishReadinessService = createSocialPublishReadinessService({
  loadSocialConfigs: () => socialPublishConfigAdapter.loadSocialConfigs(),
  loadMakeRoute: () => socialPublishConfigAdapter.loadMakeRoute(),
  getPublishGovernance: publishGovernanceStatus,
  getScheduledPosts: getSocialScheduledPosts,
  saveScheduledPost: saveSocialScheduledPost,
  runPublishDueScheduled: runSchedulerPublishDueScheduled,
  autoPublishOptInEnabled: () => socialPublishConfigAdapter.autoPublishOptInEnabled(),
  autoPublishLeadMinutes: () => socialPublishConfigAdapter.autoPublishLeadMinutes(),
  readinessForPost: socialHermesCanaryReadinessForPost,
});

const defaultSocialContextService = createSocialContextService({
  collectFactualContext: () => socialContextSources.collect(),
  getScheduledPosts: getSocialScheduledPosts,
  loadValue: kvGet,
  saveValue: kvSet,
  getPublishGovernance: publishGovernanceStatus,
});

const defaultSocialOwnerReviewService = createSocialOwnerReviewService({
  getScheduledPosts: getSocialScheduledPosts,
  saveScheduledPost: saveSocialScheduledPost,
  saveScheduledPostBatch: saveSocialScheduledPostBatch,
  updateScheduledPost: updateSocialScheduledPost,
  consumeReviewArtifact: (record, metadata) => defaultSocialReviewArtifactService.consume(record, metadata),
  loadSocialConfigs: () => socialPublishConfigAdapter.loadSocialConfigs(),
  notificationGateway: socialOwnerReviewNotificationGateway,
  getOwnerId: () => String(process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID || '').trim(),
  getPublicBaseUrl: () => String(process.env.PUBLIC_BASE_URL || '').trim(),
  autoPublishOptInEnabled: () => socialPublishConfigAdapter.autoPublishOptInEnabled(),
  autoPublishLeadMinutes: () => socialPublishConfigAdapter.autoPublishLeadMinutes(),
});

const defaultSocialProducerRunRepository = createSocialProducerRunRepository();

const defaultSocialMediaProviderRouter = createSocialMediaProviderRouter({
  hasImageConfig: hasExternalImageConfigAsync,
  getRuntimeConfig: getExternalAiRuntimeConfig,
  buildProviderUrl,
  generateImages: generateImagesWithExternalAi,
});

const defaultSocialMediaGenerationService = createSocialMediaGenerationService({
  normalizeReviewCardEvidence: normalizeSocialReviewCardEvidence,
  normalizeReviewCardDesign: normalizeSocialReviewCardDesign,
  renderReviewCard: renderSocialReviewCardPng,
  reviewCardRenderSpecSha256: socialReviewCardRenderSpecSha256,
  providerRouter: defaultSocialMediaProviderRouter,
  normalizeGeneratedGeometry: normalizeGeneratedSocialImageGeometry,
  reviewGeneratedImage: reviewGeneratedSocialImage,
  storeMediaAsset: storePersistentSocialMediaAsset,
  getReviewCardShopName: () => process.env.SOCIAL_HERMES_REVIEW_CARD_SHOP_NAME,
});

export function issueSocialHermesReviewArtifact(plan, variant) {
  return defaultSocialReviewArtifactService.issue(plan, variant);
}

export function consumeSocialHermesReviewArtifact(record, metadata) {
  return defaultSocialReviewArtifactService.consume(record, metadata);
}

export function loadSocialHermesMakeRoute(overrideUrl = '') {
  return socialPublishConfigAdapter.loadMakeRoute(overrideUrl);
}

export function socialHermesAutoPublishOptInEnabled() {
  return socialPublishConfigAdapter.autoPublishOptInEnabled();
}

export function socialHermesAutoPublishLeadMinutes() {
  return socialPublishConfigAdapter.autoPublishLeadMinutes();
}

export function evaluateSocialHermesPublishReadiness(post, options = {}) {
  return defaultSocialPublishReadinessService.evaluatePost(post, options);
}

export function getSocialHermesCanaryReadiness(body = {}, options = {}) {
  return defaultSocialPublishReadinessService.getCanaryReadiness(body, options);
}

export function armSocialHermesAutoPublishRecord(record = {}) {
  return defaultSocialPublishReadinessService.armAutoPublishRecord(record);
}

export function armSocialHermesExistingQueue() {
  return defaultSocialPublishReadinessService.armExistingQueue();
}

export function publishSocialHermesDueScheduled(input = {}) {
  return defaultSocialPublishReadinessService.publishDueScheduled(input);
}

export function safeSocialHermesContextPayload(input = {}) {
  return buildSafeSocialHermesContextPayload({
    ...input,
    publishGovernance: publishGovernanceStatus(),
  });
}

export function refreshSocialHermesShopContext() {
  return defaultSocialContextService.refreshShopContext();
}

export function getSafeSocialHermesContext(ownerTelegramUserId) {
  return defaultSocialContextService.getSafeContext(ownerTelegramUserId);
}

export function getSocialHermesAutonomousContextMemory() {
  return defaultSocialContextService.getAutonomousContextMemory();
}

export function socialHermesOwnerNotificationMessage(records = []) {
  return buildSocialOwnerReviewNotificationMessage(records, {
    publicBaseUrl: String(process.env.PUBLIC_BASE_URL || '').trim(),
  });
}

export function expandSocialHermesOwnerReviewRecord(record = {}) {
  return defaultSocialOwnerReviewService.expandRecord(record);
}

export function saveSocialHermesOwnerReviewDrafts(records = [], options = {}) {
  return defaultSocialOwnerReviewService.saveReviewDrafts(records, options);
}

export function saveSocialHermesOwnerRequestedSchedule(records = [], options = {}) {
  return defaultSocialOwnerReviewService.saveOwnerRequestedSchedule(records, options);
}

export function deliverSocialHermesOwnerReviewNotification(ids = []) {
  return defaultSocialOwnerReviewService.deliverReviewNotification(ids);
}

export function socialOwnerReviewProducerPersistence() {
  return defaultSocialProducerRunRepository;
}

export function getSocialOwnerReviewProducerStatus() {
  return defaultSocialProducerRunRepository.status.read();
}

export function generateSocialHermesMedia(body = {}, options = {}) {
  const publicBaseUrl = Object.prototype.hasOwnProperty.call(options, 'publicBaseUrl')
    ? String(options.publicBaseUrl || '')
    : String(process.env.PUBLIC_BASE_URL || '').trim();
  return defaultSocialMediaGenerationService.generateMedia(body, { publicBaseUrl });
}
