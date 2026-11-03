import { createSocialContentOpportunityContracts } from '../domain/content-opportunity-contracts.js';
import { createSocialContentOpportunityFitFilter } from './apply-content-opportunity-fit.js';
import { createSocialContentOpportunityAiSelector } from './select-content-opportunities-with-ai.js';

export function createSocialContentOpportunitySemanticFilter({
  generateWithAi,
  isAiConfigured,
  normalizeListingUnderstanding,
  normalizeListingCampaignFit,
  normalizeOwnerFeedbackMemory,
  buildListingCampaignFit,
} = {}) {
  const contracts = createSocialContentOpportunityContracts({
    normalizeListingUnderstanding,
    normalizeListingCampaignFit,
  });
  const selectContentOpportunities = createSocialContentOpportunityAiSelector({
    contracts,
    generateWithAi,
    isAiConfigured,
    normalizeOwnerFeedbackMemory,
  });
  const applySemanticFit = createSocialContentOpportunityFitFilter({
    contracts,
    selectContentOpportunities,
    isAiConfigured,
    buildListingCampaignFit,
  });
  return {
    applySemanticFit,
    evaluateResearchEvidence: contracts.evaluateSocialResearchEvidenceForTest,
  };
}
