import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { createSocialMediaStrategyValidationRules } from '../api/modules/social/domain/media-strategy-validation.js';

function normalizeText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeRules(overrides = {}) {
  return createSocialMediaStrategyValidationRules({
    normalizeText,
    aspectRatioFitsPlatform: () => true,
    normalizeReviewCardDesign: value => value && typeof value === 'object' ? value : null,
    ...overrides,
  });
}

function listingSingleStrategy() {
  return {
    format: 'single',
    target_media_count: 1,
    frames: [{
      id: 'hero',
      role: 'hero',
      rationale: 'Use the exact listing image.',
      source: 'listing_image',
      reference_media_rank: 1,
      communication_goal: 'Show the product clearly.',
      visible_buyer_evidence: 'The finished product is visible.',
      evidence_strength: 'primary',
    }],
    platform_variants: {
      instagram: {
        format: 'single',
        frame_ids: ['hero'],
        buyer_evidence_frame_ids: ['hero'],
      },
    },
    listing_media_decisions: [{ rank: 1, decision: 'use_exact' }],
    required_visible_evidence: 'Show the finished product.',
  };
}

test('media strategy validator accepts the existing valid single-listing-image contract', () => {
  const rules = makeRules();
  const strategy = listingSingleStrategy();

  expect(rules.valid(strategy, [' Instagram ', 'instagram'])).toBe(true);
  expect(rules.structuralProblems(strategy, ['instagram'])).toEqual([]);
  expect(rules.buyerEvidenceProblems(strategy, { require_campaign_visual_quality_review: true })).toEqual([]);
});

test('structural validator preserves platform-specific format and unused-frame errors', () => {
  const rules = makeRules();
  const strategy = {
    format: 'carousel',
    target_media_count: 2,
    frames: [
      { id: 'a', role: 'a', rationale: 'A', source: 'listing_image', reference_media_rank: 1 },
      { id: 'b', role: 'b', rationale: 'B', source: 'listing_image', reference_media_rank: 2 },
    ],
    platform_variants: {
      pinterest: { format: 'carousel', frame_ids: ['a', 'b'] },
    },
  };

  expect(rules.structuralProblems(strategy, ['pinterest'])).toEqual(expect.arrayContaining([
    'pinterest: the configured Make pin route requires format=single with exactly 1 frame_id',
  ]));
  strategy.platform_variants.pinterest = { format: 'single', frame_ids: ['a'] };
  expect(rules.structuralProblems(strategy, ['pinterest'])).toContain(
    'master frames must all be selected by at least one requested platform variant; unused: b',
  );
});

test('vision validator preserves editorial-decision and hero-selection rules', () => {
  const rules = makeRules();
  const strategy = listingSingleStrategy();
  const visualAnalysis = {
    available: true,
    images: [{ rank: 1, social_use_decision: 'supporting' }],
  };

  expect(rules.visionSelectionProblems(strategy, visualAnalysis)).toContain(
    'instagram: lead frame hero uses listing image rank 1, but AI vision approved it only as supporting',
  );

  strategy.listing_media_decisions = [{ rank: 1, decision: 'exclude' }];
  expect(rules.visionSelectionProblems(strategy, visualAnalysis)).toContain(
    'listing media rank 1 is marked exclude but the media strategy still uses it',
  );
});

test('capability and aspect-ratio validators preserve fail-closed generated-frame checks', () => {
  const rules = makeRules({ aspectRatioFitsPlatform: () => false });
  const strategy = {
    format: 'single',
    target_media_count: 1,
    frames: [{
      id: 'generated',
      role: 'hero',
      rationale: 'Generate a contextual frame.',
      source: 'generated_image',
      prompt: 'Generate a grounded scene.',
      reference_required: true,
      reference_media_rank: 1,
      aspect_ratio: '4:5',
      image_model: 'model-a',
    }],
    platform_variants: {
      instagram: { format: 'single', frame_ids: ['generated'] },
    },
  };

  expect(rules.platformRatioProblems(strategy, ['instagram'])).toEqual([
    'instagram: frame generated aspect_ratio 4:5 is incompatible with the configured instagram publishing surface; create a platform-suitable frame or select another compatible frame',
  ]);
  expect(rules.capabilityProblems(strategy, {
    image_provider_capabilities: {
      available_models: [{ model: 'model-a', reference_image_supported: false }],
    },
  })).toEqual([
    'generated: selected image model cannot preserve external reference pixels; choose a reference-capable model, the original listing_image, or a reference-free conceptual frame',
  ]);
});

test('accepted completed generated assets keep the existing exact-brief reuse shortcut', () => {
  const rules = makeRules();
  const strategy = {
    frames: [{ id: 'generated', source: 'generated_image' }],
    accepted_asset_decisions: [],
  };
  const context = {
    media_generation_resolution: {
      accepted_assets: [{
        brief_id: 'generated',
        source: 'generated_image',
        permanent: true,
        quality_approved: true,
      }],
    },
  };

  expect(rules.acceptedAssetDecisionProblems(strategy, context)).toEqual([]);

  context.media_generation_resolution.accepted_assets[0].quality_approved = false;
  expect(rules.acceptedAssetDecisionProblems(strategy, context)).toEqual([
    'accepted asset generated: explicit reuse/discard decision missing',
  ]);
});

test('accepted review-card reuse preserves immutable render identity checks', () => {
  const rules = makeRules();
  const design = { layout: 'quote' };
  const strategy = {
    frames: [{
      id: 'card',
      source: 'review_card',
      review_id: 'review-1',
      context_note: 'Verified review context',
      aspect_ratio: '4:5',
      review_card_design: design,
    }],
    accepted_asset_decisions: [{ brief_id: 'card', decision: 'reuse', rationale: 'Keep the approved render.' }],
  };
  const context = {
    media_generation_resolution: {
      accepted_assets: [{
        brief_id: 'card',
        source: 'review_card',
        permanent: true,
        quality_approved: true,
        render_spec_sha256: 'a'.repeat(64),
        review_id: 'review-1',
        context_note: 'Different context',
        aspect_ratio: '4:5',
        review_card_design: design,
      }],
    },
  };

  expect(rules.acceptedAssetDecisionProblems(strategy, context)).toEqual([
    'accepted review-card card: reuse cannot change review_id, context_note, aspect_ratio, or art direction; discard it and use a new frame id',
  ]);
});

test('media strategy validation module owns no AI, queue, publish, approval or HTTP behavior', () => {
  const source = readFileSync(new URL('../api/modules/social/domain/media-strategy-validation.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(50_000);
  expect(source).not.toMatch(/generateWithExternalAi|generateWithSocialAi|getScheduledPosts|saveScheduledPost|publishSocialHermes|approveScheduledPost|AUTOPUBLISH|REAL_PUBLISH_RELEASE_APPROVED|express|\breq\b|\bres\b/);
});
