import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { createSocialOwnerReviewCampaignComposition } from '../api/modules/social/index.js';

const DEADLINE = '2026-08-13T10:20:00.000Z';

function persistentMedia() {
  return {
    id: 'asset-hero',
    brief_id: 'hero',
    url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_aaaaaaaaaaaaaaaaaaaaaaaa',
    source: 'generated_image',
    permanent: true,
    checksum_sha256: 'a'.repeat(64),
    quality_review: { decision: 'approve', approved: true, rationale: 'Clear result.' },
  };
}

function readyPlan({ includeFacebook = false } = {}) {
  const media = persistentMedia();
  const variants = [{
    platform: 'instagram',
    caption: 'Exact Instagram caption',
    format: 'single',
    media_items: [media],
    caption_quality_review: {
      approved: true,
      decision: 'approve',
      reviewed_caption: 'Exact Instagram caption',
      rationale: 'Accurate and native.',
    },
    ai_review_artifact: { id: 'artifact-instagram' },
  }];
  if (includeFacebook) variants.push({
    platform: 'facebook',
    caption: 'Exact Facebook caption',
    format: 'single',
    media_items: [media],
    caption_quality_review: {
      approved: true,
      decision: 'approve',
      reviewed_caption: 'Exact Facebook caption',
      rationale: 'Accurate and native.',
    },
  });
  return {
    status: 'ready_for_review',
    campaign_id: 'campaign-1',
    concept: { name: 'Exact concept', hook: 'Exact hook' },
    storyboard: [{ frame_id: 'hero', role: 'hero result', status: 'ready', media }],
    media_strategy: {
      format: 'single',
      target_media_count: 1,
      required_visible_evidence: 'Finished result.',
      frame_count_rationale: 'One frame is sufficient.',
      frames: [{
        id: 'hero',
        role: 'hero result',
        rationale: 'AI selected the exact result.',
        source: 'generated_image',
        prompt: 'Show exact result.',
        image_model: 'model-one',
        aspect_ratio: '4:5',
        reference_required: false,
        communication_goal: 'Show the finished result.',
        visible_buyer_evidence: 'Finished result.',
        evidence_strength: 'primary',
      }],
      platform_variants: {
        instagram: { format: 'single', frame_ids: ['hero'], buyer_evidence_frame_ids: ['hero'] },
        ...(includeFacebook
          ? { facebook: { format: 'single', frame_ids: ['hero'], buyer_evidence_frame_ids: ['hero'] } }
          : {}),
      },
    },
    campaign_quality_review: { approved: true, decision: 'approve' },
    listing_understanding: {
      caption_review_source: 'external_ai',
      caption_review_model: 'model-one',
      caption_review_run_id: 'caption-run-1',
      caption_reviewed_at: '2026-08-13T09:55:00.000Z',
    },
    variants,
  };
}

function opportunity(platforms = ['instagram']) {
  return {
    id: 'opportunity-1',
    type: 'shop_evidence',
    moment: 'AI-selected evergreen campaign',
    reason: 'Current shop evidence supports this campaign.',
    campaign_context: 'Show the exact custom result.',
    suggested_platforms: platforms,
    listing_candidates: [{
      listing_id: 'listing-1',
      title: 'Custom portrait',
      listing_understanding: { available: true },
      listing_campaign_fit: { decision: 'strong_fit' },
    }],
    timing: {
      scheduled_at_by_platform: {
        instagram: '2026-08-15T12:00:00.000Z',
        facebook: '2026-08-15T13:00:00.000Z',
      },
      audience_timezone: 'America/New_York',
      rationale: 'AI-selected audience window.',
    },
  };
}

function composition(plan, { planValidator } = {}) {
  const calls = [];
  const service = createSocialOwnerReviewCampaignComposition({
    creativePlanService: {
      planCreativeCampaign: async (body, execution) => {
        calls.push(['creativePlan', structuredClone(body), execution]);
        return structuredClone(plan);
      },
    },
    mediaGenerationService: {
      generateMedia: async payload => {
        calls.push(['generateMedia', payload]);
        throw new Error('Generation must not run for an already-ready plan.');
      },
    },
    ...(planValidator ? { planValidator } : {}),
    coordinatorOptions: { clock: () => new Date('2026-08-13T10:00:00.000Z') },
  });
  return { calls, service };
}

test('real prepareOwnerReviewCampaign dependency builds complete owner-review-only records without side effects', async () => {
  const { calls, service } = composition(readyPlan());
  const result = await service.prepareOwnerReviewCampaign({
    input: { platforms: ['instagram'] },
    context: {},
    opportunity: opportunity(),
    signal: new AbortController().signal,
    deadline_at: DEADLINE,
  });

  expect(result).toMatchObject({
    status: 'ready_for_review',
    campaign_id: 'campaign-1',
    platform_count: 1,
    generation_rounds: 0,
    published: false,
  });
  expect(calls.map(call => call[0])).toEqual(['creativePlan']);
  expect(calls[0][1]).toMatchObject({
    listing: { listing_id: 'listing-1', title: 'Custom portrait' },
    platforms: ['instagram'],
    generated_media: [],
    context: {
      campaign_context: 'Show the exact custom result.',
      social_factory_path: true,
      require_campaign_visual_quality_review: true,
    },
  });
  expect(result.records).toEqual([expect.objectContaining({
    platform: 'instagram',
    approved: false,
    approved_for_publish: false,
    approved_by: null,
    approval_source: 'owner_review_required',
    metadata: expect.objectContaining({
      owner_notification_required: true,
      publish_approval_granted: false,
      auto_publish_armed: false,
    }),
  })]);
});

test('incomplete final platform package fails closed instead of returning partial records', async () => {
  const { service } = composition(readyPlan(), {
    planValidator: { validate: () => ({ valid: true }) },
  });
  await expect(service.prepareOwnerReviewCampaign({
    input: { platforms: ['instagram', 'facebook'] },
    context: {},
    opportunity: opportunity(['instagram', 'facebook']),
    deadline_at: DEADLINE,
  })).rejects.toMatchObject({
    code: 'SOCIAL_OWNER_REVIEW_CAMPAIGN_INCOMPLETE',
    details: {
      requested_platforms: ['instagram', 'facebook'],
      prepared_platforms: ['instagram'],
    },
  });
});

test('campaign preparation refuses to choose among multiple listing candidates locally', async () => {
  const { service } = composition(readyPlan());
  const ambiguous = opportunity();
  ambiguous.listing_candidates.push({ listing_id: 'listing-2', title: 'Another listing' });
  await expect(service.prepareOwnerReviewCampaign({
    input: { platforms: ['instagram'] },
    context: {},
    opportunity: ambiguous,
    deadline_at: DEADLINE,
  })).rejects.toMatchObject({ code: 'SOCIAL_OWNER_REVIEW_EXACT_LISTING_REQUIRED' });
});

test('campaign preparation modules have no queue, Telegram, publisher, worker, or Express dependency', () => {
  const files = [
    '../api/modules/social/application/prepare-owner-review-campaign.js',
    '../api/modules/social/owner-review-campaign-composition.js',
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).not.toMatch(/queue\.js|telegram|publishDue|social-publisher|express|\breq\b|\bres\b|workers\//i);
  }
});
