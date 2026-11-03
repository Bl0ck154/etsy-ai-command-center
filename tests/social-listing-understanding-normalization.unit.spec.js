import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { createSocialListingUnderstandingNormalizer } from '../api/modules/social/domain/listing-understanding-normalization.js';

function normalizeText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeCaption(value, max = 1600) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function normalizeStringList(value, maxItems = 8, maxChars = 120) {
  return (Array.isArray(value) ? value : [])
    .map(item => normalizeText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function makeNormalizer(overrides = {}) {
  return createSocialListingUnderstandingNormalizer({
    normalizeText,
    normalizeCaption,
    normalizeStringList,
    normalizeReviewCardDesign: value => value && typeof value === 'object' ? { ...value, normalized: true } : null,
    normalizeCaptionReviews: (raw, captions) => ({ marker: raw?.marker || '', captions }),
    ...overrides,
  });
}

test('listing understanding normalization preserves legacy aliases, bounds and hashtag handling', () => {
  const normalizer = makeNormalizer();
  const result = normalizer.normalize({
    summary: '  Custom family portrait  ',
    category: 'Portrait',
    customer_use_case: 'Memorial gift',
    audience: 'Families',
    angle: 'Preserve a memory',
    caption_draft: 'A grounded caption body',
    captions: {
      instagram: ' First line \r\n second line ',
      facebook: ' Facebook caption ',
    },
    caption_quality_reviews: { marker: 'critic' },
    captionReviewSource: 'external_ai_caption_critic',
    captionReviewModel: 'model-a',
    captionReviewRunId: 'run-1',
    captionReviewedAt: '2026-08-11T12:00:00.000Z',
    image_brief: 'Show the finished portrait.',
    platforms: [' instagram ', 'facebook'],
    hashtags: ['memories', '#family'],
    claims_to_avoid: ['Same-day delivery'],
    evidence: ['Listing photo'],
    unknowns: ['Exact delivery date'],
    confidence: 1.5,
  }, 'external_ai');

  expect(result).toMatchObject({
    available: true,
    source: 'external_ai',
    what_is_sold: 'Custom family portrait',
    product_category: 'Portrait',
    buyer_use_case: 'Memorial gift',
    target_buyer: 'Families',
    marketing_angle: 'Preserve a memory',
    caption_body: 'A grounded caption body',
    platform_captions: {
      instagram: 'First line\nsecond line',
      facebook: 'Facebook caption',
    },
    caption_review_source: 'external_ai_caption_critic',
    caption_review_model: 'model-a',
    caption_review_run_id: 'run-1',
    caption_reviewed_at: '2026-08-11T12:00:00.000Z',
    visual_brief: 'Show the finished portrait.',
    platforms: ['instagram', 'facebook'],
    hashtags: ['#memories', '#family'],
    unsupported_claims_to_avoid: ['Same-day delivery'],
    evidence: ['Listing photo'],
    unknowns: ['Exact delivery date'],
    confidence: 1,
  });
  expect(result.platform_caption_reviews).toEqual({
    marker: 'critic',
    captions: result.platform_captions,
  });
});

test('media strategy normalization preserves exact frame, audit, variant and accepted-asset shapes', () => {
  const normalizer = makeNormalizer();
  const result = normalizer.normalizeMediaStrategy({
    format: ' Carousel ',
    target_media_count: '2',
    listing_media_policy: 'Audit each listing image.',
    listing_media_decisions: [
      { rank: '1', decision: ' USE_EXACT ', social_role: 'hero', rationale: 'Strong evidence.' },
      { rank: 0, decision: 'exclude' },
    ],
    reference_policy: 'Use references only when needed.',
    campaign_offer_focus: 'Show the custom result.',
    lead_proof_plan: 'Lead with finished work.',
    required_visible_evidence: 'Finished portrait visible.',
    frame_count_rationale: 'Two frames are enough.',
    rationale: 'Concise carousel.',
    frames: [
      {
        id: ' hero ',
        role: 'Hero',
        communication_goal: 'Show result',
        visible_buyer_evidence: 'Finished portrait',
        evidence_strength: ' PRIMARY ',
        source: ' LISTING_IMAGE ',
        rationale: 'Strongest proof',
        reference_media_rank: '1',
        aspect_ratio: '4:5',
      },
      {
        id: 'card',
        role: 'Review card',
        source: 'review_card',
        review_id: 'review-1',
        context_note: 'Verified review',
        review_card_design: { layout: 'quote' },
        aspect_ratio: '4:5',
        rationale: 'Buyer proof',
      },
    ],
    platform_variants: {
      instagram: { format: ' CAROUSEL ', frame_ids: ['hero', 'card'], buyer_evidence_frame_ids: ['hero'] },
      unknown: { format: 'single', frame_ids: ['hero'] },
    },
    accepted_asset_decisions: [
      { frame_id: 'card', decision: ' REUSE ', rationale: 'Already approved.' },
    ],
  });

  expect(result).toMatchObject({
    format: 'carousel',
    target_media_count: 2,
    listing_media_decisions: [{ rank: 1, decision: 'use_exact', social_role: 'hero', rationale: 'Strong evidence.' }],
    frames: [
      expect.objectContaining({ id: 'hero', source: 'listing_image', reference_media_rank: 1, evidence_strength: 'primary' }),
      expect.objectContaining({
        id: 'card',
        source: 'review_card',
        review_id: 'review-1',
        review_card_design: { layout: 'quote', normalized: true },
      }),
    ],
    platform_variants: {
      instagram: { format: 'carousel', frame_ids: ['hero', 'card'], buyer_evidence_frame_ids: ['hero'] },
    },
    accepted_asset_decisions: [{ brief_id: 'card', decision: 'reuse', rationale: 'Already approved.' }],
  });
  expect(result.platform_variants.unknown).toBeUndefined();
});

test('offer-fact and visual-analysis normalization preserve fail-closed booleans and bounds', () => {
  const normalizer = makeNormalizer();
  const result = normalizer.normalize({
    what_is_sold: 'Portrait',
    offer_fact_review: {
      current_inventory_applied: 1,
      current_offer_summary: 'Current offer',
      claims: [{ claim: 'Blue option available', status: ' SUPPORTED ', source_ids: ['inventory'], rationale: 'Live option.' }],
      conflicts: ['Old copy says red'],
    },
    visual_analysis: { applied: true, provider: 'vision-a', image_count: 999 },
  });

  expect(result.offer_fact_review).toEqual({
    current_inventory_applied: false,
    current_offer_summary: 'Current offer',
    claims: [{ claim: 'Blue option available', status: 'supported', source_ids: ['inventory'], rationale: 'Live option.' }],
    conflicts: ['Old copy says red'],
  });
  expect(result.visual_analysis).toEqual({ applied: true, provider: 'vision-a', image_count: 10 });
});

test('normalization rejects non-object or semantically empty understanding and empty media strategy', () => {
  const normalizer = makeNormalizer();
  expect(normalizer.normalize(null)).toBeNull();
  expect(normalizer.normalize([])).toBeNull();
  expect(normalizer.normalize({ product_category: 'Portrait' })).toBeNull();
  expect(normalizer.normalizeMediaStrategy({})).toBeNull();
});

test('listing understanding normalizer owns no AI transport, queue, publish, approval or HTTP behavior', () => {
  const source = readFileSync(new URL('../api/modules/social/domain/listing-understanding-normalization.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(40_000);
  expect(source).not.toMatch(/generateWithExternalAi|generateWithSocialAi|getScheduledPosts|saveScheduledPost|publishSocialHermes|approveScheduledPost|AUTOPUBLISH|REAL_PUBLISH_RELEASE_APPROVED|express|\breq\b|\bres\b/);
});
