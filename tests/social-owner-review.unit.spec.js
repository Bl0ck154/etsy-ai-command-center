import { expect, test } from '@playwright/test';

import {
  buildSocialOwnerReviewNotificationMessage,
  createSocialOwnerReviewService,
  socialHermesReviewContentDigest,
  withServerSocialOwnerReviewDigest,
} from '../api/modules/social/index.js';
import {
  socialHermesOwnerNotificationMessage as facadeOwnerNotificationMessage,
} from '../api/social.js';

const FIXED_NOW = new Date('2026-08-09T12:00:00.000Z');

test('owner notification explains the AI-selected frame count per platform', () => {
  const records = [{
    id: 'frame-count-review',
    platform: 'instagram',
    caption: 'A concise Instagram caption.',
    scheduled_at: '2026-07-28T16:00:00.000Z',
    media_items: [
      { url: 'https://img.example.test/hero.jpg', source: 'generated_image' },
      { url: 'https://img.example.test/proof.jpg', source: 'listing_image' },
    ],
    metadata: {
      campaign_id: 'frame-count-campaign',
      media_strategy: {
        frame_count_rationale: 'Two frames complete this specific story: one hook and one visible proof; a third would be filler.',
        frames: [
          { id: 'hero', source: 'generated_image' },
          { id: 'proof', source: 'listing_image' },
        ],
        platform_variants: {
          instagram: { format: 'carousel', frame_ids: ['hero', 'proof'] },
        },
      },
    },
  }];
  const message = buildSocialOwnerReviewNotificationMessage(records);

  expect(facadeOwnerNotificationMessage(records)).toBe(message);
  expect(message).toContain('<b>Кадри:</b>');
  expect(message).toContain('instagram: 2 кадри · carousel');
  expect(message).toContain('<b>Чому саме стільки кадрів:</b>');
  expect(message).toContain('Two frames complete this specific story');
});

test('owner notification explains why a configured platform was excluded', () => {
  const message = buildSocialOwnerReviewNotificationMessage([{
    id: 'platform-decision-review',
    platform: 'instagram',
    caption: 'A concise Instagram caption.',
    scheduled_at: '2026-07-28T16:00:00.000Z',
    media_items: [{ url: 'https://img.example.test/hero.jpg', source: 'generated_image' }],
    metadata: {
      campaign_id: 'platform-decision-campaign',
      platform_decisions: {
        instagram: { decision: 'include', rationale: 'The transformation supports a swipe story.' },
        pinterest: { decision: 'exclude', rationale: 'No truthful standalone discovery asset was available.' },
      },
      media_strategy: {
        platform_variants: {
          instagram: { format: 'single', frame_ids: ['hero'] },
        },
      },
    },
  }]);

  expect(message).toContain('<b>Не включено:</b>');
  expect(message).toContain('pinterest: No truthful standalone discovery asset was available.');
});

test('owner notification formats Kyiv and US audience time and exposes rejected previews', () => {
  const message = buildSocialOwnerReviewNotificationMessage([{
    id: 'diagnostic-review',
    platform: 'instagram',
    caption: 'A concise Instagram caption.',
    scheduled_at: '2026-08-09T22:00:00.000Z',
    media_items: [{ url: 'https://img.example.test/hero.jpg', source: 'listing_image' }],
    metadata: {
      campaign_id: 'diagnostic-campaign',
      audience_timezone: 'America/New_York',
      media_strategy: {
        frame_count_rationale: 'One exceptional hero is sufficient.',
        platform_variants: {
          instagram: { format: 'single', frame_ids: ['hero'] },
        },
      },
      generation_diagnostics: [{
        frame_role: 'Instagram transformation hero',
        rejected_previews: [{
          id: 'rejected-one',
          url: 'https://manager.example.test/api/social?action=mediaAsset&id=rejected-one',
          owner_summary_uk: 'Телефон виглядає як статичне фото, а не як готове відео.',
          issues: ['The phone reads as a static photo instead of the advertised finished video.'],
          publishable: false,
        }],
      }],
    },
  }]);

  expect(message).toContain('10 серпня, 01:00 (Київ)');
  expect(message).toContain('9 серпня, 18:00 (US-аудиторія)');
  expect(message).toContain('<b>Що AI відхилив під час підготовки:</b>');
  expect(message).toContain('Телефон виглядає як статичне фото');
  expect(message).toContain('>переглянути</a>');
  expect(message).toContain('не входять у пост і не будуть опубліковані');
});

test('owner-review application saves drafts with server trust only and never grants publish approval', async () => {
  const savedBatches = [];
  let consumedMetadata = null;
  const service = createSocialOwnerReviewService({
    consumeReviewArtifact: async (_record, metadata) => {
      consumedMetadata = metadata;
      return { verified: false, metadata };
    },
    loadSocialConfigs: async () => ({}),
    saveScheduledPostBatch: async records => { savedBatches.push(records); return records; },
    saveScheduledPost: async record => record,
    getScheduledPosts: async () => [],
    updateScheduledPost: async () => null,
    notificationGateway: { isDisabled: () => false, deliver: async () => ({}) },
    getOwnerId: () => 'owner-1',
    autoPublishOptInEnabled: () => true,
    autoPublishLeadMinutes: () => 12 * 60,
    clock: () => FIXED_NOW,
  });
  const result = await service.saveReviewDrafts([{
    id: 'review-draft',
    source: 'social_hermes',
    platform: 'facebook',
    caption: 'Exact reviewed caption.',
    scheduled_at: '2026-08-11T12:00:00.000Z',
    media_items: [{ url: 'https://img.example.test/review.jpg', source: 'listing_image' }],
    metadata: {
      campaign_id: 'campaign-1',
      owner_notification_sent_at: 'forged',
      owner_notification_text_message_id: 999,
    },
  }], { validateRecord: () => null });

  expect(consumedMetadata).toEqual({ campaign_id: 'campaign-1' });
  expect(savedBatches).toHaveLength(1);
  expect(result.saved[0]).toMatchObject({
    id: 'review-draft',
    status: 'draft',
    scheduled_at: null,
    approved_for_publish: false,
    approved_by: null,
    approved_at: null,
    approval_source: 'owner_review_required',
    metadata: {
      owner_review_required: true,
      owner_notification_required: true,
      publish_approval_granted: false,
      auto_publish_after_review_window: false,
      requested_scheduled_at: '2026-08-11T12:00:00.000Z',
      ai_review_content_digest_source: 'etsy_manager_server',
      ai_review_content_digest_issued_at: FIXED_NOW.toISOString(),
    },
  });
  expect(result.saved[0].metadata.ai_review_content_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.saved[0].metadata.owner_notification_sent_at).toBeUndefined();
});

test('owner-review application delivery records verified provenance before enabling the review-window schedule', async () => {
  const base = withServerSocialOwnerReviewDigest({
    id: 'verified-owner-review',
    source: 'social_hermes',
    platform: 'facebook',
    caption: 'Exact reviewed caption.',
    scheduled_at: null,
    media_items: [{ url: 'https://img.example.test/review.jpg', source: 'listing_image' }],
    metadata: {
      campaign_id: 'campaign-1',
      requested_scheduled_at: '2026-08-11T12:00:00.000Z',
      owner_review_required: true,
      owner_notification_required: true,
      ai_caption_quality_review_required: true,
      ai_caption_quality_review: { approved: true, decision: 'approve', reviewed_caption: 'Exact reviewed caption.' },
      ai_campaign_visual_quality_review_required: true,
      ai_campaign_visual_quality_review: {
        approved: true,
        decision: 'approve',
        platform_reviews: [{ platform: 'facebook', decision: 'approve' }],
      },
      media_strategy: { platform_variants: { facebook: { format: 'single', frame_ids: ['proof'] } } },
    },
  }, { clock: () => FIXED_NOW });
  expect(base.metadata.ai_review_content_digest).toBe(socialHermesReviewContentDigest(base));
  const updates = [];
  let notification = null;
  const service = createSocialOwnerReviewService({
    consumeReviewArtifact: async (_record, metadata) => ({ metadata }),
    loadSocialConfigs: async () => ({}),
    saveScheduledPostBatch: async records => records,
    saveScheduledPost: async record => record,
    getScheduledPosts: async () => [base],
    updateScheduledPost: async (id, changes) => {
      updates.push({ id, changes });
      return { ...base, ...changes, metadata: changes.metadata };
    },
    notificationGateway: {
      isDisabled: () => false,
      deliver: async input => {
        notification = input;
        return { textMessageId: 101, textChatId: 'owner-1', mediaMessageIds: [102], deliveredMediaCount: 1 };
      },
    },
    getOwnerId: () => 'owner-1',
    getPublicBaseUrl: () => 'https://manager.example.test',
    autoPublishOptInEnabled: () => true,
    autoPublishLeadMinutes: () => 12 * 60,
    clock: () => FIXED_NOW,
    wait: async () => {},
  });

  const result = await service.deliverReviewNotification(['verified-owner-review']);

  expect(notification).toMatchObject({
    ownerId: 'owner-1',
    mediaUrls: ['https://img.example.test/review.jpg'],
  });
  expect(notification.text).toContain('Переглянути й відредагувати в Etsy AI Command Center');
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    id: 'verified-owner-review',
    changes: {
      status: 'scheduled',
      scheduled_at: '2026-08-11T12:00:00.000Z',
      metadata: {
        owner_notification_delivery: 'etsy_manager_telegram_bot_api',
        owner_notification_chat_id: 'owner-1',
        owner_notification_text_message_id: 101,
        owner_notification_media_message_ids: [102],
        owner_notification_sent_at: FIXED_NOW.toISOString(),
        auto_publish_after_review_window: true,
        owner_review_min_hours: 12,
      },
    },
  });
  expect(result.records[0].approved_for_publish).toBeFalsy();
});

test('owner-requested schedule application strips publish trust and preserves validation errors', async () => {
  const writes = [];
  const service = createSocialOwnerReviewService({
    consumeReviewArtifact: async (_record, metadata) => ({ metadata }),
    loadSocialConfigs: async () => ({}),
    saveScheduledPostBatch: async records => records,
    saveScheduledPost: async record => { writes.push(record); return record; },
    getScheduledPosts: async () => [],
    updateScheduledPost: async () => null,
    notificationGateway: { isDisabled: () => false, deliver: async () => ({}) },
    getOwnerId: () => 'owner-1',
    clock: () => FIXED_NOW,
  });

  const forged = await service.saveOwnerRequestedSchedule([{
    id: 'forged', platform: 'facebook', caption: 'Caption', scheduled_at: '2026-08-11T12:00:00.000Z',
    metadata: { ai_caption_quality_review_required: true },
  }], { validateRecord: () => null });
  expect(forged.validation_problem).toMatchObject({ code: 'AI_REVIEW_ARTIFACT_REQUIRED' });
  expect(writes).toEqual([]);

  const valid = await service.saveOwnerRequestedSchedule([{
    id: 'owner-scheduled', platform: 'facebook', caption: 'Caption', scheduled_at: '2026-08-11T12:00:00.000Z',
    metadata: { retained_fact: true },
  }], { validateRecord: () => null });
  expect(valid.saved[0]).toMatchObject({
    status: 'scheduled',
    approved_for_publish: false,
    approved_by: null,
    approved_at: null,
    approval_source: 'owner_requested_schedule',
    metadata: { retained_fact: true, auto_publish_after_review_window: false, auto_publish_armed: false },
  });
});
