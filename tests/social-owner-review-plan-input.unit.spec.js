import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import {
  applySocialOwnerReviewCreativePlanRefresh,
  buildSocialOwnerReviewCreativePlanInput,
} from '../api/modules/social/application/build-owner-review-plan-input.js';

function captureError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return null;
}

test('owner-review plan input binds the exact AI-selected listing, platform and campaign context', () => {
  const research = {
    external_research_used: true,
    status: 'researched',
    sources: [{ id: 'source-1' }],
  };
  const result = buildSocialOwnerReviewCreativePlanInput({
    listing: { listing_id: 'listing-1', title: 'Custom portrait', state: 'active' },
    opportunity: {
      moment: 'Back-to-school gift',
      type: 'seasonal',
      campaign_context: 'Use the verified school-season angle without inventing claims.',
      audience: 'US gift buyers',
      occasion: 'back to school',
      research_basis: 'verified_current_research',
      suggested_platforms: ['instagram', 'pinterest', 'facebook'],
      listing_campaign_fit: { decision: 'strong_fit' },
      listing_understanding: { available: true, product_summary: 'A custom portrait.' },
      selected_review: { review_id: 'review-1', exact_quote: 'Looks amazing' },
    },
    configuredPlatforms: ['instagram', 'facebook'],
    currentResearch: research,
    queueAccounting: { target: 24, deficit: 4 },
    queueRecordsCreated: 1,
    queueRecordDeficit: 4,
    ownerFeedbackMemory: { avoid: ['generic hooks'] },
  });

  expect(result).toMatchObject({
    listing_id: 'listing-1',
    campaign_label: 'Back-to-school gift',
    campaign_context: 'Use the verified school-season angle without inventing claims.',
    platforms: ['instagram', 'facebook'],
    body: {
      listing: {
        listing_id: 'listing-1',
        title: 'Custom portrait',
        listing_campaign_fit: { decision: 'strong_fit' },
        listing_understanding: { available: true, product_summary: 'A custom portrait.' },
      },
      platforms: ['instagram', 'facebook'],
      generated_media: [],
      context: {
        audience: 'US gift buyers',
        occasion: 'back to school',
        campaign_context: 'Use the verified school-season angle without inventing claims.',
        current_research: research,
        social_factory_path: true,
        require_vision_for_social_hero: true,
        require_ai_caption_quality_review: true,
        require_campaign_visual_quality_review: true,
        require_current_listing_facts: true,
        factory_path: 'social_autonomous_content_factory',
        contextual_scene: false,
        queue_accounting: {
          target: 24,
          deficit: 4,
          created_this_run: 1,
          remaining_capacity: 3,
          whole_campaign_overflow_allowed: true,
        },
        owner_feedback_memory: { avoid: ['generic hooks'] },
        selected_review: { review_id: 'review-1', exact_quote: 'Looks amazing' },
      },
    },
  });
});

test('owner-review plan input does not attach unverified current research', () => {
  const result = buildSocialOwnerReviewCreativePlanInput({
    listing: { listing_id: 'listing-1', title: 'Custom portrait' },
    opportunity: {
      reason: 'Evergreen shop-evidence angle.',
      research_basis: 'shop_evidence',
      suggested_platforms: ['instagram'],
    },
    configuredPlatforms: ['instagram'],
    currentResearch: { external_research_used: true, status: 'researched', sources: [{ id: 'source-1' }] },
  });

  expect(result.body.context.current_research).toBeNull();
});

test('owner-review plan input fails closed when AI omitted campaign context or configured suggested platforms', () => {
  const missingContext = captureError(() => buildSocialOwnerReviewCreativePlanInput({
    listing: { listing_id: 'listing-1' },
    opportunity: { suggested_platforms: ['instagram'] },
    configuredPlatforms: ['instagram'],
  }));
  expect(missingContext).toMatchObject({ code: 'SOCIAL_OWNER_REVIEW_CAMPAIGN_CONTEXT_REQUIRED' });

  const missingPlatform = captureError(() => buildSocialOwnerReviewCreativePlanInput({
    listing: { listing_id: 'listing-1' },
    opportunity: { reason: 'AI reason', suggested_platforms: ['pinterest'] },
    configuredPlatforms: ['instagram', 'facebook'],
  }));
  expect(missingPlatform).toMatchObject({ code: 'SOCIAL_OWNER_REVIEW_CAMPAIGN_PLATFORM_REQUIRED' });
});

test('owner-review creative replan carries only server-returned visual, understanding and availability state', () => {
  const body = {
    listing: { listing_id: 'listing-1', listing_understanding: { available: true, old: true } },
    context: { campaign_context: 'Keep this.' },
    generated_media: [],
  };
  const result = applySocialOwnerReviewCreativePlanRefresh(body, {
    visual_analysis: { source: 'server-ai' },
    listing_understanding: { available: true, refined: true },
    current_listing_availability: { active: true, quantity: 5 },
    unrelated_local_repair: { should_not_copy: true },
  });

  expect(result).toEqual({
    listing: {
      listing_id: 'listing-1',
      listing_understanding: { available: true, refined: true },
      current_availability: { active: true, quantity: 5 },
    },
    context: { campaign_context: 'Keep this.' },
    generated_media: [],
    visual_analysis: { source: 'server-ai' },
  });
});

test('owner-review plan input has no AI call, HTTP, queue, worker or publisher dependency', () => {
  const source = readFileSync(new URL('../api/modules/social/application/build-owner-review-plan-input.js', import.meta.url), 'utf8');
  expect(source).not.toMatch(/generateWith|external-ai|fetch\s*\(|api\/social|queue\.js|workers\/|publishDue|social-publisher/i);
});
