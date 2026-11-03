import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import {
  buildSocialListingUnderstandingRepairPrompt,
  buildSocialListingUnderstandingSystemPrompt,
} from '../api/modules/social/index.js';

const contract = JSON.parse(readFileSync(
  new URL('./fixtures/social-listing-understanding-prompt-contract.json', import.meta.url),
  'utf8',
));

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

test('listing-understanding primary prompt exactly matches the pre-extraction runtime contract', () => {
  const prompt = buildSocialListingUnderstandingSystemPrompt();
  expect(prompt).toHaveLength(contract.primary.chars);
  expect(sha256(prompt)).toBe(contract.primary.sha256);
});

test('listing-understanding repair prompt exactly matches the pre-extraction runtime contract', () => {
  const prompt = buildSocialListingUnderstandingRepairPrompt();
  expect(prompt).toHaveLength(contract.repair.chars);
  expect(sha256(prompt)).toBe(contract.repair.sha256);
});

test('listing-understanding prompt module owns prompt text only and has no runtime side effects', () => {
  const source = readFileSync(
    new URL('../api/modules/social/infrastructure/listing-understanding-prompts.js', import.meta.url),
    'utf8',
  );
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(50_000);
  expect(source).toContain("from '../../../_social-creative-standards.js'");
  expect(source).not.toMatch(/from ['"][^'"]*(?:_etsy|\/kv|_scheduler|api\/social)|\bfetch\s*\(|\bgenerateWith[A-Z]\w*\s*\(|\bkv(?:Get|Set)\s*\(|\bpublishSocialHermes\w*\s*\(|\bapproveScheduledPost\s*\(/);
});

test('Social facade delegates both listing-understanding prompts to the Social module', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');
  const strategySource = readFileSync(
    new URL('../api/modules/social/infrastructure/listing-understanding-ai.js', import.meta.url),
    'utf8',
  );
  expect(source).toContain('buildSocialListingUnderstandingSystemPrompt,');
  expect(source).toContain('buildSocialListingUnderstandingRepairPrompt,');
  expect(source).toContain('buildPrimaryPrompt: buildSocialListingUnderstandingSystemPrompt,');
  expect(source).toContain('buildRepairPrompt: buildSocialListingUnderstandingRepairPrompt,');
  expect(strategySource).toContain('const system = primaryPrompt();');
  expect(strategySource).toContain('const repairSystem = repairPrompt();');
  expect(source).not.toContain("import { SOCIAL_CREATIVE_SHARED_STANDARDS }");
  expect(source).not.toContain("const system = [\n    'You are an Etsy social marketing analyst.'");
  expect(source).not.toContain("const repairSystem = [\n      'You repair an Etsy listing understanding response into strict JSON.'");
});
