import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { createSocialOwnerReviewCampaignRecordBuilder } from '../api/modules/social/application/build-owner-review-campaign-records.js';

const FIXED_NOW = new Date('2026-08-13T10:00:00.000Z');

function readyPlan(overrides = {}) {
  return {
    status: 'ready_for_review',
    campaign_id: 'campaign-ready-1',
    concept: { name: 'Transformation proof', hook: 'See the finished result' },
    storyboard: [{ id: 'hero', role: 'hero proof' }],
    generation_decision: { status: 'ready' },
    media_strategy: {
      format: 'single',
      frame_count_rationale: 'One strong proof frame is enough.',
      platform_variants: {
        instagram: { format: 'single', frame_ids: ['hero'] },
        facebook: { format: 'single', frame_ids: ['hero'] },
      },
    },
    campaign_quality_review: {
      approved: true,
      decision: 'approve',
      platform_reviews: [
        { platform: 'instagram', decision: 'approve' },
        { platform: 'facebook', decision: 'approve' },
      ],
    },
    listing_understanding: {
      caption_review_source: 'external_ai',
      caption_review_model: 'model-one',
      caption_review_run_id: 'review-run-1',
      caption_reviewed_at: '2026-08-13T09:55:00.000Z',
    },
    variants: [
      {
        platform: 'instagram',
        caption: 'Instagram exact caption',
        format: 'single',
        caption_quality_review: {
          approved: true,
          decision: 'approve',
          reviewed_caption: 'Instagram exact caption',
          rationale: 'Accurate and native.',
        },
        ai_review_artifact: { id: 'artifact-instagram' },
      },
      {
        platform: 'facebook',
        caption: 'Facebook exact caption',
        format: 'single',
        caption_quality_review: {
          approved: true,
          decision: 'approve',
          reviewed_caption: 'Facebook exact caption',
          rationale: 'Accurate and native.',
        },
        ai_review_artifact: { id: 'artifact-facebook' },
      },
    ],
    ...overrides,
  };
}

function opportunity(overrides = {}) {
  return {
    moment: 'AI-selected campaign',
    reason: 'Verified shop evidence supports this angle.',
    platform_decisions: {
      instagram: { decision: 'include', rationale: 'Strong visual proof.' },
      facebook: { decision: 'include', rationale: 'Strong visual proof.' },
    },
    timing: {
      scheduled_at_by_platform: {
        instagram: '2026-08-15T12:00:00.000Z',
        facebook: '2026-08-15T13:00:00.000Z',
      },
      audience_timezone: 'America/New_York',
      rationale: 'AI-selected audience window.',
    },
    ...overrides,
  };
}

function builder(overrides = {}) {
  const calls = [];
  const instance = createSocialOwnerReviewCampaignRecordBuilder({
    clock: () => FIXED_NOW,
    resolveVariantMedia: async input => {
      calls.push(input);
      return [{
        id: `media-${input.platform}`,
        url: `https://manager.example.test/media/${input.platform}.jpg`,
        source: 'generated_image',
      }];
    },
    ...overrides,
  });
  return { calls, instance };
}

test('owner-review campaign record builder preserves an entire AI-selected platform package and publish approval stays false', async () => {
  const { calls, instance } = builder();
  const result = await instance.build({
    plan: readyPlan(),
    listing: { listing_id: '12345', title: 'Custom video listing' },
    opportunity: opportunity(),
    platforms: ['instagram', 'facebook'],
    blockedMedia: new Set(['https://old.example.test/reused.jpg']),
    generationDiagnostics: [{ brief_id: 'hero', outcome: 'approved' }],
  });

  expect(result).toMatchObject({ campaign_id: 'campaign-ready-1', platform_count: 2, published: false });
  expect(result.records.map(record => record.platform)).toEqual(['instagram', 'facebook']);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    platform: 'instagram',
    blockedMedia: expect.any(Set),
    plan: expect.objectContaining({ status: 'ready_for_review' }),
  });
  for (const record of result.records) {
    expect(record).toMatchObject({
      source: 'social_hermes',
      approved: false,
      approved_for_publish: false,
      approved_by: null,
      approved_at: null,
      approval_source: 'owner_review_required',
      metadata: expect.objectContaining({
        campaign_id: 'campaign-ready-1',
        media_policy: 'creative_planner_ready_media_only_no_synthetic_fallback',
        owner_notification_required: true,
        publish_approval_granted: false,
        auto_publish_armed: false,
        ai_caption_quality_review_required: true,
        ai_campaign_visual_quality_review_required: true,
      }),
    });
    expect(record.id).toMatch(/^agent-autonomy-20260813-/);
    expect(record.media_items).toHaveLength(1);
  }
  expect(result.records[0].metadata.ai_review_artifact).toEqual({ id: 'artifact-instagram' });
  expect(result.records[0].metadata.generation_diagnostics).toEqual([{ brief_id: 'hero', outcome: 'approved' }]);
});

test('owner-review campaign record builder fails closed instead of saving a partial platform package', async () => {
  const { instance } = builder({
    resolveVariantMedia: async ({ platform }) => platform === 'instagram'
      ? [{ url: 'https://manager.example.test/media/instagram.jpg', source: 'generated_image' }]
      : [],
  });

  await expect(instance.build({
    plan: readyPlan(),
    listing: { listing_id: '12345', title: 'Custom video listing' },
    opportunity: opportunity(),
    platforms: ['instagram', 'facebook'],
  })).rejects.toMatchObject({
    code: 'SOCIAL_OWNER_REVIEW_CAMPAIGN_INCOMPLETE',
    details: {
      prepared_platforms: ['instagram'],
      blockers: [expect.objectContaining({ platform: 'facebook', reason: expect.stringContaining('no ready media') })],
    },
  });
});

test('owner-review campaign record builder rejects missing AI timing and never invents a schedule', async () => {
  const { instance } = builder();
  const inputOpportunity = opportunity({
    timing: {
      scheduled_at_by_platform: { instagram: 'not-a-date' },
      audience_timezone: 'America/New_York',
    },
  });

  await expect(instance.build({
    plan: readyPlan({ variants: [readyPlan().variants[0]] }),
    listing: { listing_id: '12345', title: 'Custom video listing' },
    opportunity: inputOpportunity,
    platforms: ['instagram'],
  })).rejects.toMatchObject({
    code: 'SOCIAL_OWNER_REVIEW_CAMPAIGN_INCOMPLETE',
    details: {
      blockers: [expect.objectContaining({
        platform: 'instagram',
        reason: expect.stringContaining('valid ISO-8601 publication time'),
      })],
    },
  });
});

test('owner-review campaign record builder rejects a caption not covered by the exact AI caption review', async () => {
  const plan = readyPlan({
    variants: [{
      ...readyPlan().variants[0],
      caption: 'Changed after review',
    }],
  });
  const { instance } = builder();

  await expect(instance.build({
    plan,
    listing: { listing_id: '12345', title: 'Custom video listing' },
    opportunity: opportunity(),
    platforms: ['instagram'],
  })).rejects.toMatchObject({
    code: 'SOCIAL_OWNER_REVIEW_CAMPAIGN_INCOMPLETE',
    details: {
      blockers: [expect.objectContaining({
        platform: 'instagram',
        reason: expect.stringContaining('does not match the final platform caption'),
      })],
    },
  });
});

test('owner-review campaign record builder does not default missing platforms or duplicate variants', async () => {
  const { instance } = builder();
  await expect(instance.build({
    plan: readyPlan(),
    listing: { listing_id: '12345', title: 'Custom video listing' },
    opportunity: opportunity(),
    platforms: [],
  })).rejects.toMatchObject({ code: 'SOCIAL_OWNER_REVIEW_PLATFORM_REQUIRED' });

  const duplicateInstagram = readyPlan({
    variants: [readyPlan().variants[0], { ...readyPlan().variants[0] }],
  });
  await expect(instance.build({
    plan: duplicateInstagram,
    listing: { listing_id: '12345', title: 'Custom video listing' },
    opportunity: opportunity(),
    platforms: ['instagram'],
  })).rejects.toMatchObject({
    code: 'SOCIAL_OWNER_REVIEW_CAMPAIGN_INCOMPLETE',
    details: { blockers: [expect.objectContaining({ reason: expect.stringContaining('duplicate ready variants') })] },
  });
});

test('owner-review campaign record builder rejects anything before ready_for_review', async () => {
  const { instance } = builder();
  await expect(instance.build({
    plan: readyPlan({ status: 'needs_generation' }),
    listing: { listing_id: '12345' },
    opportunity: opportunity(),
    platforms: ['instagram'],
  })).rejects.toMatchObject({ code: 'SOCIAL_OWNER_REVIEW_PLAN_NOT_READY' });
});

test('owner-review campaign record builder has no HTTP, Express, publisher, provider or AI dependency', () => {
  const source = readFileSync(new URL('../api/modules/social/application/build-owner-review-campaign-records.js', import.meta.url), 'utf8');
  expect(source).not.toMatch(/api\/social|express|\breq\b|\bres\b|fetch\s*\(|generateWith|publishDue|social-publisher|external-ai/i);
});
