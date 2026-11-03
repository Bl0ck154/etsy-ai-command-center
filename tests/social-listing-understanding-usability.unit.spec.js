import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { createSocialListingUnderstandingUsabilityService } from '../api/modules/social/application/evaluate-listing-understanding-usability.js';

function makeService(overrides = {}) {
  const calls = [];
  const dependency = (name, result) => (...args) => {
    calls.push([name, ...args]);
    return typeof result === 'function' ? result(...args) : result;
  };
  const service = createSocialListingUnderstandingUsabilityService({
    requiresMediaStrategy: dependency('requiresMediaStrategy', true),
    validMediaStrategy: dependency('validMediaStrategy', true),
    visionSelectionProblems: dependency('visionSelectionProblems', []),
    capabilityProblems: dependency('capabilityProblems', []),
    platformRatioProblems: dependency('platformRatioProblems', []),
    acceptedAssetDecisionProblems: dependency('acceptedAssetDecisionProblems', []),
    buyerEvidenceProblems: dependency('buyerEvidenceProblems', []),
    validPlatformCaptions: dependency('validPlatformCaptions', true),
    validCaptionReviews: dependency('validCaptionReviews', true),
    ...overrides,
  });
  return { service, calls };
}

test('usability returns false for a missing normalized understanding without invoking rule dependencies', () => {
  const { service, calls } = makeService();
  expect(service.isUsable(null, { platforms: ['instagram'] }, true, { available: true })).toBe(false);
  expect(calls).toEqual([]);
});

test('usability preserves the legacy no-media-strategy fast path', () => {
  const { service, calls } = makeService({
    requiresMediaStrategy: context => context.require_ai_media_strategy === true,
  });
  const understanding = { available: true, platform_captions: {} };
  expect(service.isUsable(understanding, { require_ai_media_strategy: false }, true, null)).toBe(true);
  expect(calls).toEqual([]);
});

test('usability preserves the exact media and caption rule chain for autonomous planning', () => {
  const { service, calls } = makeService();
  const strategy = { id: 'strategy' };
  const understanding = { available: true, media_strategy: strategy };
  const context = { platforms: ['instagram'], marker: 'context' };
  const visualAnalysis = { available: true, images: [{ rank: 1 }] };

  expect(service.isUsable(understanding, context, true, visualAnalysis)).toBe(true);
  expect(calls.map(([name]) => name)).toEqual([
    'requiresMediaStrategy',
    'validMediaStrategy',
    'visionSelectionProblems',
    'capabilityProblems',
    'platformRatioProblems',
    'acceptedAssetDecisionProblems',
    'buyerEvidenceProblems',
    'validPlatformCaptions',
    'validCaptionReviews',
  ]);
  expect(calls.find(([name]) => name === 'visionSelectionProblems').slice(1)).toEqual([strategy, visualAnalysis]);
  expect(calls.find(([name]) => name === 'capabilityProblems').slice(1)).toEqual([strategy, context]);
});

test('usability short-circuits on the same first failing rule and skips critic validity when review is optional', () => {
  const { service, calls } = makeService({
    capabilityProblems: () => ['provider capability mismatch'],
  });
  const understanding = { available: true, media_strategy: {} };
  expect(service.isUsable(understanding, { platforms: ['instagram'] }, true, null)).toBe(false);
  expect(calls.map(([name]) => name)).toEqual([
    'requiresMediaStrategy',
    'validMediaStrategy',
    'visionSelectionProblems',
  ]);

  const optional = [];
  const optionalService = createSocialListingUnderstandingUsabilityService({
    requiresMediaStrategy: () => true,
    validMediaStrategy: () => true,
    visionSelectionProblems: () => [],
    capabilityProblems: () => [],
    platformRatioProblems: () => [],
    acceptedAssetDecisionProblems: () => [],
    buyerEvidenceProblems: () => [],
    validPlatformCaptions: () => true,
    validCaptionReviews: () => { optional.push('critic'); return false; },
  });
  expect(optionalService.isUsable(understanding, { platforms: ['instagram'] }, false, null)).toBe(true);
  expect(optional).toEqual([]);
});

test('usability intentionally does not substitute aggregate validation-problem semantics', () => {
  const source = readFileSync(new URL('../api/modules/social/application/evaluate-listing-understanding-usability.js', import.meta.url), 'utf8');
  expect(source).not.toContain('listingUnderstandingValidationProblems');
  expect(source).not.toContain('current_inventory_applied');
  expect(source).not.toContain('offer_fact_review');
  expect(source).not.toMatch(/generateWithExternalAi|generateWithSocialAi|getScheduledPosts|saveScheduledPost|publishSocialHermes|approveScheduledPost|AUTOPUBLISH|REAL_PUBLISH_RELEASE_APPROVED|express|\breq\b|\bres\b/);
});
