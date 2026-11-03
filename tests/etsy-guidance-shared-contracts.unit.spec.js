import fs from 'node:fs';
import { expect, test } from '@playwright/test';

import {
  ETSY_GUIDANCE_RULE_GROUPS,
  normalizeEtsyGuidanceRules,
  validateEtsyGuidanceRules,
} from '../api/etsy-guidance/rule-contracts.js';
import { baselineSnapshot, sourceArrayFromMap } from '../api/etsy-guidance/source-contracts.js';
import { candidateDigest, validateStoredSnapshot } from '../api/etsy-guidance/snapshot-contracts.js';
import { buildEtsyGuidanceEvidenceIndex } from '../api/etsy-guidance/candidate-generator.js';

const validRules = {
  title: ['Use clear factual title wording for the item.', 'Keep the title concise and easy to scan for buyers.'],
  discovery: ['Use accurate phrases that describe the actual product.', 'Use varied relevant search phrases without unsupported claims.'],
  description: ['Describe what the buyer receives using supported facts.', 'Explain ordering and delivery details clearly for the buyer.'],
  photos: ['Use clear product imagery that represents the delivered item.', 'Keep image choices relevant to the exact listing offer.'],
};

test('shared guidance rule contract preserves groups and validation policy', () => {
  expect(ETSY_GUIDANCE_RULE_GROUPS).toEqual(['title', 'discovery', 'description', 'photos']);
  expect(validateEtsyGuidanceRules(validRules)).toEqual(validRules);
  expect(() => validateEtsyGuidanceRules({ ...validRules, title: ['too short', validRules.title[1]] })).toThrow('too short');
  expect(() => validateEtsyGuidanceRules({ ...validRules, title: ['This guarantees top 1 ranking for every listing.', validRules.title[1]] })).toThrow('unsafe or unsupported claim');
  expect(normalizeEtsyGuidanceRules({ ...validRules, title: [...validRules.title, ...Array(10).fill(validRules.title[0])] }).title).toHaveLength(8);
});

test('shared snapshot digest fences tampered official candidates', () => {
  const candidate = {
    ...baselineSnapshot(),
    id: 'candidate-shared-1',
    status: 'candidate',
    origin: 'official-source-refresh',
    reviewedAt: 'August 2026',
    rules: validRules,
    evidence: [],
  };
  candidate.digest = candidateDigest(candidate);
  expect(validateStoredSnapshot(candidate, 'candidate')).not.toBeNull();
  expect(validateStoredSnapshot({ ...candidate, reviewedAt: 'Tampered' }, 'candidate')).toBeNull();
});

test('evidence index remains stable and source-scoped', () => {
  const sources = sourceArrayFromMap().slice(0, 1).map(source => ({
    ...source,
    text: 'First useful Etsy guidance excerpt for buyers.\nSecond useful Etsy guidance excerpt for listings.',
  }));
  const evidence = buildEtsyGuidanceEvidenceIndex(sources);
  expect(evidence).toHaveLength(2);
  expect(evidence[0]).toMatchObject({ id: `${sources[0].id}:1`, sourceId: sources[0].id });
  expect(evidence[1]).toMatchObject({ id: `${sources[0].id}:2`, sourceId: sources[0].id });
});

test('stateful and legacy guidance owners reuse shared contracts instead of duplicating them', () => {
  const legacy = fs.readFileSync(new URL('../api/_etsy-guidance.js', import.meta.url), 'utf8');
  const stateful = fs.readFileSync(new URL('../api/etsy-guidance/stateful-service.js', import.meta.url), 'utf8');
  expect(legacy).toContain("./etsy-guidance/snapshot-contracts.js");
  expect(legacy).toContain("./etsy-guidance/candidate-generator.js");
  expect(legacy).not.toContain("from 'cheerio'");
  expect(legacy).not.toContain('function candidateDigest(');
  expect(stateful).toContain("from './snapshot-contracts.js'");
  expect(stateful).toContain("from './candidate-generator.js'");
  expect(stateful).not.toContain('function candidateDigest(');
  expect(stateful).not.toContain('function candidatePrompt(');
  expect(stateful).not.toContain('function validateStoredSnapshot(');
});
