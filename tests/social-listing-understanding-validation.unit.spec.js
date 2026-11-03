import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { createSocialListingUnderstandingValidationService } from '../api/modules/social/index.js';

function makeService(overrides = {}) {
  const calls = [];
  const mark = (name, result) => (...args) => {
    calls.push([name, ...args]);
    return typeof result === 'function' ? result(...args) : result;
  };
  const service = createSocialListingUnderstandingValidationService({
    requiresMediaStrategy: mark('requiresMedia', true),
    validMediaStrategy: mark('validMedia', true),
    mediaStrategyValidationProblems: mark('mediaProblems', []),
    visionSelectionProblems: mark('visionProblems', []),
    capabilityProblems: mark('capabilityProblems', []),
    platformRatioProblems: mark('ratioProblems', []),
    acceptedAssetDecisionProblems: mark('acceptedAssetProblems', []),
    buyerEvidenceProblems: mark('evidenceProblems', []),
    normalizeCaption: mark('caption', value => String(value || '').trim()),
    validCaptionReviews: mark('captionReviewsValid', true),
    ...overrides,
  });
  return { service, calls };
}

test('validation coordinator rejects non-normalized listing understanding before calling rule dependencies', () => {
  const { service, calls } = makeService();
  expect(service.problems(null)).toEqual(['listing_understanding_not_normalized']);
  expect(service.problems({ available: false })).toEqual(['listing_understanding_not_normalized']);
  expect(calls).toHaveLength(0);
});

test('validation coordinator preserves media problem ordering and the aggregate invalid-strategy message', () => {
  const { service, calls } = makeService({
    validMediaStrategy: () => false,
    mediaStrategyValidationProblems: () => ['missing frames', 'wrong count'],
    visionSelectionProblems: () => ['vision_problem'],
    capabilityProblems: () => ['capability_problem'],
    platformRatioProblems: () => ['ratio_problem'],
    acceptedAssetDecisionProblems: () => ['accepted_asset_problem'],
    buyerEvidenceProblems: () => ['buyer_evidence_problem'],
  });

  expect(service.problems({
    available: true,
    media_strategy: { frames: [] },
    platform_captions: { instagram: 'A sufficiently long Instagram caption that is clearly over forty characters.' },
  }, { platforms: ['instagram'] })).toEqual([
    'media_strategy_invalid_or_missing: missing frames | wrong count',
    'vision_problem',
    'capability_problem',
    'ratio_problem',
    'accepted_asset_problem',
    'buyer_evidence_problem',
  ]);
  expect(calls.find(([name]) => name === 'requiresMedia')).toBeTruthy();
});

test('validation coordinator preserves current-listing fact grounding errors', () => {
  const { service } = makeService({ requiresMediaStrategy: () => false });
  const result = service.problems({
    available: true,
    offer_fact_review: {
      current_inventory_applied: false,
      current_offer_summary: '',
      claims: [{ claim: 'Fast delivery', status: 'unsupported', source_ids: [], rationale: '' }],
    },
    platform_captions: {},
  }, {
    require_current_listing_facts: true,
    platforms: [],
  });

  expect(result).toEqual([
    'current_listing_availability_missing',
    'offer_fact_review_did_not_apply_current_inventory',
    'offer_fact_review_contains_ungrounded_claims',
  ]);
});

test('validation coordinator preserves caption length and critic approval errors', () => {
  const { service } = makeService({
    requiresMediaStrategy: () => false,
    validCaptionReviews: () => false,
  });
  const result = service.problems({
    available: true,
    platform_captions: {
      instagram: 'too short',
      facebook: 'This Facebook caption is deliberately long enough to pass the forty character minimum.',
    },
    platform_caption_reviews: {
      instagram: { approved: false },
      facebook: { approved: true },
    },
  }, { platforms: ['instagram', 'facebook'] }, true);

  expect(result).toEqual([
    'platform_captions_missing_or_too_short: instagram',
    'platform_caption_reviews_not_approved: instagram',
  ]);
});

test('validation coordinator keeps the critic metadata fallback message when reviews look approved but fail exact validation', () => {
  const { service } = makeService({
    requiresMediaStrategy: () => false,
    validCaptionReviews: () => false,
  });
  const result = service.problems({
    available: true,
    platform_captions: {
      instagram: 'This Instagram caption is deliberately long enough to pass the validation threshold.',
    },
    platform_caption_reviews: {
      instagram: { approved: true },
    },
  }, { platforms: ['instagram'] }, true);

  expect(result).toEqual([
    'platform_caption_reviews_not_approved: critic metadata or exact reviewed_caption mismatch',
  ]);
});

test('listing-understanding validation module has no AI transport, route, queue or publishing ownership', () => {
  const source = readFileSync(new URL('../api/modules/social/application/validate-listing-understanding.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(50_000);
  expect(source).not.toMatch(/from ['"][^'"]*(?:_etsy|\/kv|_scheduler|api\/social)|\bfetch\s*\(|\bgenerateWith[A-Z]\w*\s*\(|\bpublishSocialHermes\w*\s*\(|\bapproveScheduledPost\s*\(/);
  expect(source).toContain('createSocialListingUnderstandingValidationService');
});
