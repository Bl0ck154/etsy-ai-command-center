import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('social facade delegates listing-understanding AI orchestration to one focused strategy owner', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');

  expect(source).toContain('createSocialListingUnderstandingAiStrategy,');
  expect(source).toContain('const socialListingUnderstandingAiStrategy = createSocialListingUnderstandingAiStrategy({');
  expect(source).toContain('normalizeUnderstanding: normalizeListingUnderstanding,');
  expect(source).toContain('compactListing: compactListingForAiUnderstanding,');
  expect(source).toContain('isAiConfigured: hasExternalAiConfigAsync,');
  expect(source).toContain('generateWithAi: generateWithSocialAi,');
  expect(source).toContain('buildOutputSchema: buildSocialListingUnderstandingOutputSchema,');
  expect(source).toContain('buildPrimaryPrompt: buildSocialListingUnderstandingSystemPrompt,');
  expect(source).toContain('buildRepairPrompt: buildSocialListingUnderstandingRepairPrompt,');
  expect(source).toContain('reviewCaptions: reviewPlatformCaptionsWithAi,');
  expect(source).toContain('isUsable: isUsableListingUnderstanding,');
  expect(source).toContain('validationProblems: listingUnderstandingValidationProblems,');
  expect(source).toContain('return socialListingUnderstandingAiStrategy.understand({ listing, context, visualAnalysis });');

  expect(source).not.toContain("{ task: 'creative_listing_understanding', maxTokens: 12_000 }");
  expect(source).not.toContain('for (let repairAttempt = 1; repairAttempt <= 2; repairAttempt += 1)');
  expect(source).not.toContain('repairs_remaining_including_this_one: 3 - repairAttempt');

  // creativePlan still consumes the same compatibility callback while the owning
  // implementation has moved out of the HTTP facade.
  expect(source).toContain('buildListingUnderstanding: buildListingUnderstandingWithAi,');
});
