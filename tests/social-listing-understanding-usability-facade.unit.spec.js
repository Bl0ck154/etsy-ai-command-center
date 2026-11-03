import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('social facade wires one listing-understanding usability decision into the extracted AI strategy', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');

  expect(source).toContain('createSocialListingUnderstandingUsabilityService,');
  expect(source).toContain('const socialListingUnderstandingUsabilityService = createSocialListingUnderstandingUsabilityService({');
  expect(source).toContain('return socialListingUnderstandingUsabilityService.isUsable(');

  expect(source).toContain('const socialListingUnderstandingAiStrategy = createSocialListingUnderstandingAiStrategy({');
  expect(source).toContain('isUsable: isUsableListingUnderstanding,');
  expect(source).toContain('validationProblems: listingUnderstandingValidationProblems,');
  expect(source).toContain('return socialListingUnderstandingAiStrategy.understand({ listing, context, visualAnalysis });');

  // Runtime supplied/primary/repair usability checks now belong to the focused
  // listing-understanding AI strategy instead of the HTTP facade.
  expect(source.split('isUsableListingUnderstanding(')).toHaveLength(2); // definition + split tail
  expect(source).not.toContain('const suppliedStrategyValid = isUsableListingUnderstanding(');
  expect(source).not.toContain('let validationProblems = listingUnderstandingValidationProblems(');
  expect(source).not.toContain('for (let repairAttempt = 1; repairAttempt <= 2; repairAttempt += 1)');

  expect(source).not.toContain('const suppliedVisionSelectionProblems =');
  expect(source).not.toContain('const suppliedCapabilityProblems =');
  expect(source).not.toContain('const suppliedPlatformRatioProblems =');
});
