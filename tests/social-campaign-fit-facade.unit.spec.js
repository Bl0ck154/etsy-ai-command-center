import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('Social facade delegates campaign-fit AI strategy instead of owning its prompts', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');

  expect(source).toContain('createSocialCampaignFitAiStrategy,');
  expect(source).toContain('const socialCampaignFitAiStrategy = createSocialCampaignFitAiStrategy({');
  expect(source).toContain('return socialCampaignFitAiStrategy.evaluate(input);');
  expect(source).not.toContain('You are an Etsy social marketing strategist.');
  expect(source).not.toContain('You repair an Etsy campaign/listing fit response into strict JSON.');
});
