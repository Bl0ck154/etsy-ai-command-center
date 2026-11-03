import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('social facade delegates caption review policy to one Social domain contract owner', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');

  expect(source).toContain('createSocialCaptionReviewContracts,');
  expect(source).toContain('const socialCaptionReviewContracts = createSocialCaptionReviewContracts({');
  expect(source).toContain('return socialCaptionReviewContracts.validPlatformCaptions(understanding, platforms);');
  expect(source).toContain('return socialCaptionReviewContracts.normalizeReviews(raw, captions);');
  expect(source).toContain('return socialCaptionReviewContracts.enforceRoutePolicy(reviews, captions, platforms, listingUrl);');
  expect(source).toContain('return socialCaptionReviewContracts.validReviews(understanding, platforms);');
  expect(source).toContain('return socialCaptionReviewContracts.outputSchema(platforms);');

  expect(source).not.toContain('const exactListingUrl = socialAiText(listingUrl, 1000);');
  expect(source).not.toContain("understanding.caption_review_source !== 'external_ai_caption_critic'");
  expect(source).not.toContain('CTA routes the buyer outside the required Etsy handoff.');
  expect(source).not.toContain('Exact Etsy listing URL is missing for this platform.');
  expect(source).not.toContain('Raw Etsy listing URL is not suitable for the Instagram caption; use the Etsy link in bio instead.');
});
