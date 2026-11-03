import { socialAspectRatioFitsPlatform } from '../../_social-platform-capabilities.js';
import { normalizeSocialReviewCardDesign } from '../../_social-review-card.js';
import { createSocialOwnerReviewCampaignRecordBuilder } from './application/build-owner-review-campaign-records.js';
import { createSocialOwnerReviewCampaignPreparationCoordinator } from './application/coordinate-owner-review-campaign-preparation.js';
import { createSocialOwnerReviewCampaignPreparationService } from './application/prepare-owner-review-campaign.js';
import { createSocialOwnerReviewPlanValidator } from './application/validate-owner-review-plan.js';
import { createSocialMediaStrategyValidationRules } from './domain/media-strategy-validation.js';

function normalizeText(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Worker-independent production composition for one owner-review campaign.
 * Service instances are injected so importing this module starts no producer,
 * queue write, notification, timer, or publication action.
 */
export function createSocialOwnerReviewCampaignComposition({
  creativePlanService,
  mediaGenerationService,
  validationRules = createSocialMediaStrategyValidationRules({
    normalizeText,
    aspectRatioFitsPlatform: socialAspectRatioFitsPlatform,
    normalizeReviewCardDesign: normalizeSocialReviewCardDesign,
  }),
  planValidator = createSocialOwnerReviewPlanValidator({ validationRules }),
  campaignRecordBuilder = createSocialOwnerReviewCampaignRecordBuilder(),
  coordinatorOptions = {},
} = {}) {
  const coordinator = createSocialOwnerReviewCampaignPreparationCoordinator({
    creativePlanService,
    mediaGenerationService,
    planValidator,
    ...coordinatorOptions,
  });
  return createSocialOwnerReviewCampaignPreparationService({ coordinator, campaignRecordBuilder });
}
