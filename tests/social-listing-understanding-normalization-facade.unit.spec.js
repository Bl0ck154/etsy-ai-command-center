import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('social facade delegates listing-understanding normalization to one Social domain owner', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');

  expect(source).toContain('createSocialListingUnderstandingNormalizer,');
  expect(source).toContain('const socialListingUnderstandingNormalizer = createSocialListingUnderstandingNormalizer({');
  expect(source).toContain('return socialListingUnderstandingNormalizer.normalizePlatformVariants(raw);');
  expect(source).toContain('return socialListingUnderstandingNormalizer.normalizeAcceptedAssetDecisions(raw);');
  expect(source).toContain('return socialListingUnderstandingNormalizer.normalizeOfferFactReview(raw);');
  expect(source).toContain('return socialListingUnderstandingNormalizer.normalizeMediaStrategy(raw);');
  expect(source).toContain('return socialListingUnderstandingNormalizer.normalize(raw, source);');

  expect(source).not.toContain("const platformCaptions = Object.fromEntries(['instagram', 'facebook', 'pinterest', 'tiktok']");
  expect(source).not.toContain('const framesRaw = Array.isArray(raw.frames) ? raw.frames : [];');
  expect(source).not.toContain('current_inventory_applied: source.current_inventory_applied === true');
  expect(source).not.toContain("hashtags: socialAiStringList(raw.hashtags, 8, 40).map(tag => tag.startsWith('#')");
});
