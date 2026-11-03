import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('Social facade delegates listing-understanding validation to one application coordinator', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');
  expect(source).toContain('createSocialListingUnderstandingValidationService,');
  expect(source).toContain('const socialListingUnderstandingValidationService = createSocialListingUnderstandingValidationService({');
  expect(source).toContain('return socialListingUnderstandingValidationService.problems(');
  expect(source).not.toContain("if (!understanding || understanding.available === false) return ['listing_understanding_not_normalized'];");
});
