import { test, expect } from '@playwright/test';
import fs from 'node:fs';

import {
  __etsyGuidanceStatefulForTest,
} from '../api/etsy-guidance/stateful-service.js';

const httpRoute = fs.readFileSync(new URL('../api/etsy-guidance.js', import.meta.url), 'utf8');
const refreshScript = fs.readFileSync(new URL('../scripts/refresh-etsy-guidance.mjs', import.meta.url), 'utf8');
const repositorySource = fs.readFileSync(new URL('../api/etsy-guidance/guidance-repository.js', import.meta.url), 'utf8');

test('HTTP and monthly refresh use the aggregate stateful writer owner', () => {
  expect(httpRoute).toContain("from './etsy-guidance/stateful-service.js'");
  expect(httpRoute).toContain('refreshEtsyGuidanceV2');
  expect(httpRoute).toContain('approveEtsyGuidanceCandidateV2');
  expect(httpRoute).not.toContain("from './_etsy-guidance.js'");

  expect(refreshScript).toContain("from '../api/etsy-guidance/stateful-service.js'");
  expect(refreshScript).toContain('refreshEtsyGuidanceV2');
  expect(refreshScript).not.toContain("from '../api/_etsy-guidance.js'");
});

test('aggregate repository commits canonical state and four compatibility views in one key-locked Lua script', () => {
  expect(repositorySource).toContain('#!lua flags=allow-key-locking');
  expect(repositorySource).toContain("redis.call('SET', KEYS[1], ARGV[2])");
  expect(repositorySource).toContain("redis.call('SET', KEYS[2], ARGV[3])");
  expect(repositorySource).toContain("redis.call('SET', KEYS[3], ARGV[4])");
  expect(repositorySource).toContain("redis.call('SET', KEYS[4], ARGV[5])");
  expect(repositorySource).toContain("redis.call('SET', KEYS[5], ARGV[6])");
  expect(repositorySource).toContain("'5',");
});

test('stateful snapshot validation rejects tampered official refresh candidates', () => {
  const { candidateDigest, validateStoredSnapshot } = __etsyGuidanceStatefulForTest;
  const candidate = {
    schemaVersion: 1,
    id: 'candidate-1',
    status: 'candidate',
    origin: 'official-source-refresh',
    reviewedAt: 'August 2026',
    rules: {
      title: ['Use clear factual title wording for the item.', 'Keep the title concise and easy to scan for buyers.'],
      discovery: ['Use accurate phrases that describe the actual product.', 'Use varied relevant search phrases without unsupported claims.'],
      description: ['Describe what the buyer receives using supported facts.', 'Explain ordering and delivery details clearly for the buyer.'],
      photos: ['Use clear product imagery that represents the delivered item.', 'Keep image choices relevant to the exact listing offer.'],
    },
    evidence: [],
    sources: [],
  };
  candidate.digest = candidateDigest(candidate);
  expect(validateStoredSnapshot(candidate, 'candidate')).not.toBeNull();
  expect(validateStoredSnapshot({ ...candidate, reviewedAt: 'Tampered' }, 'candidate')).toBeNull();
});

test('bundled baseline remains the active fallback contract', () => {
  const baseline = __etsyGuidanceStatefulForTest.baselineSnapshot();
  expect(baseline).toMatchObject({
    schemaVersion: 1,
    id: 'bundled-july-2026',
    status: 'active',
    origin: 'bundled',
    activatedAt: null,
  });
  expect(baseline.sources.length).toBeGreaterThan(0);
});
