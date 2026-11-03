import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('Social facade delegates caption review to one AI adapter', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');
  expect(source).toContain('createSocialCaptionReviewAiStrategy,');
  expect(source).toContain('const socialCaptionReviewAiStrategy = createSocialCaptionReviewAiStrategy({');
  expect(source).toContain('return socialCaptionReviewAiStrategy.review(input);');
  expect(source).not.toContain("const system = [\n    'You are the independent quality critic for autonomous Etsy social captions.'");
  expect(source).not.toContain("const repairSystem = [\n        'You repair an independent Etsy social caption critic response into strict JSON");
});
