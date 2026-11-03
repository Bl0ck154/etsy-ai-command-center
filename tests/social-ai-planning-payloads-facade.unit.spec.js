import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('social facade delegates shared AI planning payload builders to one Social domain owner', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');
  const strategySource = readFileSync(
    new URL('../api/modules/social/infrastructure/listing-understanding-ai.js', import.meta.url),
    'utf8',
  );

  expect(source).toContain('createSocialAiPlanningPayloadBuilder,');
  expect(source).toContain('const socialAiPlanningPayloadBuilder = createSocialAiPlanningPayloadBuilder({');
  expect(source).toContain('return socialAiPlanningPayloadBuilder.compactCampaignContext(context);');
  expect(source).toContain('return socialAiPlanningPayloadBuilder.compactListingForUnderstanding(listing, visualAnalysis);');

  expect(source).not.toContain("const sourceOpportunity = context.source_opportunity && typeof context.source_opportunity === 'object'");
  expect(source).not.toContain('const mediaItems = Array.isArray(listing.media_items)');
  expect(source).not.toContain('concept_relevance_score: item.concept_relevance_score ?? null');

  // Keep the compatibility names because campaign-fit and caption-critic adapters
  // still receive them as callbacks while the listing-understanding state machine
  // continues to call the same facade function.
  expect(source).toContain('compactCampaignContext: compactCampaignContextForAi,');
  expect(source).toContain('compactListing: compactListingForAiUnderstanding,');
  expect(strategySource).toContain('const payload = compact(listing, visualAnalysis);');
});
