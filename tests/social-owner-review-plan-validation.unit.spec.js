import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { createSocialOwnerReviewPlanValidator } from '../api/modules/social/application/validate-owner-review-plan.js';

function rules(overrides = {}) {
  return {
    structuralProblems: () => [],
    visionSelectionProblems: () => [],
    capabilityProblems: () => [],
    platformRatioProblems: () => [],
    acceptedAssetDecisionProblems: () => [],
    buyerEvidenceProblems: () => [],
    ...overrides,
  };
}

test('aggregate plan validator delegates to existing focused strategy owners and reports every problem', () => {
  const calls = [];
  const validationRules = rules({
    structuralProblems: (strategy, platforms) => {
      calls.push(['structural', strategy, platforms]);
      return ['instagram platform_variant missing'];
    },
    capabilityProblems: (_strategy, context) => {
      calls.push(['capability', context]);
      return ['hero: image_model is not configured'];
    },
  });
  const validator = createSocialOwnerReviewPlanValidator({ validationRules });
  const result = validator.validate({
    plan: { media_strategy: { frames: [] }, visual_analysis: { available: true } },
    platforms: ['instagram'],
    planBody: { context: { image_provider_capabilities: { available_models: [] } } },
  });

  expect(result).toEqual({
    valid: false,
    problem: 'AI media strategy is incomplete: instagram platform_variant missing; hero: image_model is not configured',
    problems: ['instagram platform_variant missing', 'hero: image_model is not configured'],
  });
  expect(calls[0][0]).toBe('structural');
  expect(calls[1][0]).toBe('capability');
});

test('aggregate plan validator fails closed for invalid plan, unavailable understanding, or missing strategy', () => {
  const validator = createSocialOwnerReviewPlanValidator({ validationRules: rules() });
  expect(validator.validate({ plan: null }).valid).toBe(false);
  expect(validator.validate({ plan: {
    listing_understanding: { available: false, reason: 'AI provider unavailable' },
    media_strategy: {},
  } }).problem).toContain('AI provider unavailable');
  expect(validator.validate({ plan: {} }).problem).toContain('no AI media strategy');
});

test('aggregate validator is a thin seam with no parallel strategy implementation or side-effect dependency', () => {
  const source = readFileSync(
    new URL('../api/modules/social/application/validate-owner-review-plan.js', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(/platform_variants\?\.|frame_ids|target_media_count|queue\.js|telegram|publishDue|fetch\s*\(/i);
});
