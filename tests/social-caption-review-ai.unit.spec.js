import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import {
  createSocialCaptionReviewAiStrategy,
  SOCIAL_CAPTION_CRITIC_REPAIR_SYSTEM_PROMPT,
  SOCIAL_CAPTION_CRITIC_SYSTEM_PROMPT,
} from '../api/modules/social/index.js';

function makeStrategy(overrides = {}) {
  const calls = [];
  const normalizeReviews = (raw, captions) => Object.fromEntries(Object.entries(raw || {}).map(([platform, review]) => [platform, {
    approved: review.approved === true,
    decision: review.approved === true ? 'approve' : 'revise',
    reviewed_caption: String(review.reviewed_caption || ''),
    rationale: String(review.rationale || ''),
    factual_grounding: String(review.factual_grounding || ''),
    platform_fit: String(review.platform_fit || ''),
    cta_destination: String(review.cta_destination || ''),
    cta_compliant: review.cta_compliant ?? null,
    required_listing_url_present: review.required_listing_url_present ?? null,
    risks: Array.isArray(review.risks) ? review.risks : [],
    actual_caption: captions[platform],
  }]));
  const strategy = createSocialCaptionReviewAiStrategy({
    normalizeText: (value, max = 1000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max),
    compactListing: listing => ({ listing_id: String(listing.listing_id || '') }),
    compactCampaignContext: context => ({ moment: context.moment || '' }),
    outputSchema: platforms => ({ platforms }),
    generateWithAi: async (...args) => {
      calls.push(args);
      const payload = JSON.parse(args[1]);
      return {
        platform_caption_reviews: Object.fromEntries(payload.requested_platforms.map(platform => [platform, {
          approved: true,
          reviewed_caption: payload.platform_captions[platform],
          rationale: 'Grounded and platform appropriate.',
          factual_grounding: 'Supported.',
          platform_fit: 'Good fit.',
          cta_destination: platform === 'instagram' ? 'etsy_link_in_bio' : 'etsy_listing',
          cta_compliant: true,
          required_listing_url_present: platform !== 'instagram',
          risks: [],
        }]))
      };
    },
    getRuntimeConfig: async () => ({ textModel: 'critic-model' }),
    normalizeReviews,
    enforceRoutePolicy: reviews => reviews,
    createRunId: () => 'caption_critic_test',
    now: () => '2026-08-11T12:00:00.000Z',
    ...overrides,
  });
  return { strategy, calls };
}

test('caption critic reviews each requested supported platform with one primary AI call', async () => {
  const { strategy, calls } = makeStrategy();
  const result = await strategy.review({
    listing: { listing_id: '44', url: 'https://etsy.test/listing/44' },
    context: { platforms: [' Instagram ', 'facebook', 'instagram'], moment: 'Family history' },
    understanding: {
      what_is_sold: 'Photo restoration',
      platform_captions: {
        instagram: 'A grounded Instagram caption that is long enough for review.',
        facebook: 'A grounded Facebook caption with the Etsy listing handoff.',
      },
    },
  });

  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe(SOCIAL_CAPTION_CRITIC_SYSTEM_PROMPT);
  expect(calls[0][3]).toEqual({ task: 'caption_critic', maxTokens: 5_000 });
  const payload = JSON.parse(calls[0][1]);
  expect(payload.requested_platforms).toEqual(['instagram', 'facebook']);
  expect(payload.listing).toEqual({ listing_id: '44' });
  expect(payload.campaign_context).toEqual({ moment: 'Family history' });
  expect(result).toMatchObject({
    caption_review_source: 'external_ai_caption_critic',
    caption_review_model: 'critic-model',
    caption_review_run_id: 'caption_critic_test',
    caption_reviewed_at: '2026-08-11T12:00:00.000Z',
  });
  expect(result.platform_caption_reviews.instagram).toMatchObject({
    approved: true,
    critic_source: 'external_ai_caption_critic',
    critic_model: 'critic-model',
    critic_run_id: 'caption_critic_test',
  });
});

test('caption critic performs one repair when primary output omits a requested reviewed caption', async () => {
  let attempt = 0;
  const { strategy, calls } = makeStrategy({
    generateWithAi: async (...args) => {
      calls.push(args);
      attempt += 1;
      const payload = JSON.parse(args[1]);
      if (attempt === 1) return { platform_caption_reviews: { instagram: { approved: false, reviewed_caption: '' } } };
      const criticPayload = payload.critic_payload;
      return {
        platform_caption_reviews: {
          instagram: {
            approved: true,
            reviewed_caption: criticPayload.platform_captions.instagram,
            rationale: 'Re-evaluated.',
            factual_grounding: 'Supported.',
            platform_fit: 'Good.',
            cta_destination: 'etsy_link_in_bio',
            cta_compliant: true,
            required_listing_url_present: true,
            risks: [],
          },
        },
      };
    },
  });

  const result = await strategy.review({
    context: { platforms: ['instagram'] },
    understanding: { platform_captions: { instagram: 'An exact Instagram caption that needs review.' } },
  });

  expect(calls).toHaveLength(2);
  expect(calls[1][0]).toBe(SOCIAL_CAPTION_CRITIC_REPAIR_SYSTEM_PROMPT);
  expect(calls[1][3]).toEqual({ task: 'caption_critic_repair', maxTokens: 5_000 });
  expect(JSON.parse(calls[1][1]).schema_error).toBe('Expected keyed reviews for: instagram');
  expect(result.caption_review_source).toBe('external_ai_caption_critic');
});

test('caption critic exposes provider failures as explicit critic error state', async () => {
  const { strategy } = makeStrategy({
    generateWithAi: async () => { throw new Error('critic provider timeout'); },
  });
  const result = await strategy.review({
    context: { platforms: ['instagram'] },
    understanding: { platform_captions: { instagram: 'Caption' } },
  });
  expect(result).toMatchObject({
    platform_caption_reviews: {},
    caption_review_source: 'external_ai_caption_critic_error',
    caption_review_error: 'critic provider timeout',
  });
});

test('caption critic prompt contracts preserve Etsy-only handoff and exact-caption review rules', () => {
  expect(SOCIAL_CAPTION_CRITIC_SYSTEM_PROMPT).toContain('Instagram must omit the raw Etsy listing URL');
  expect(SOCIAL_CAPTION_CRITIC_SYSTEM_PROMPT).toContain('reviewed_caption copied exactly');
  expect(SOCIAL_CAPTION_CRITIC_REPAIR_SYSTEM_PROMPT).toContain('Facebook and Pinterest cannot be approved without the exact Etsy listing URL');
  expect(SOCIAL_CAPTION_CRITIC_REPAIR_SYSTEM_PROMPT).toContain('reviewed_caption copied byte-for-byte');
});

test('caption critic adapter owns no queue, publish, approval or route-handler behavior', () => {
  const source = readFileSync(new URL('../api/modules/social/infrastructure/caption-review-ai.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(50_000);
  expect(source).not.toMatch(/express|\breq\b|\bres\b|getScheduledPosts|saveScheduledPost|publishSocialHermes|approveScheduledPost|AUTOPUBLISH|REAL_PUBLISH_RELEASE_APPROVED/);
});
