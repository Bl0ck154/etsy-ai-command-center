import { classifyScheduledPost } from '../../../_scheduler.js';
import { scheduledPostMediaSafetyError } from '../../../_social-media-safety.js';
import {
  SOCIAL_REVIEW_CONTRACT_VERSION,
  socialHermesReviewContentDigest,
} from './review-artifacts.js';
import {
  normalizeSocialHermesPlatformId,
  resolveSocialHermesPublishRoute,
  summarizeSocialHermesSocialConfigs,
} from '../domain/platform-resolution.js';

const SOCIAL_IMAGE_URL_RE = /^https?:\/\//i;
const TERMINAL_PUBLISH_STATUSES = new Set(['published', 'publishing', 'queued', 'queued_external', 'failed']);

export function socialHermesRecordHasForbiddenFallbackMedia(record = {}) {
  const mediaItems = Array.isArray(record.media_items) ? record.media_items : [];
  return mediaItems.some(item => /generated_fallback|fallback_png|e2e_only/i.test(String(item?.source || item?.generated_via || item?.provider || '')));
}

export function socialHermesCaptionQualityProblem(record = {}) {
  const caption = String(record.caption || '').trim();
  if (!caption) return { code: 'CAPTION_REQUIRED', message: 'caption is required' };
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  if (metadata.ai_caption_quality_review_required === true) {
    const review = metadata.ai_caption_quality_review;
    const approved = review && typeof review === 'object' && !Array.isArray(review)
      && review.approved === true
      && String(review.decision || '').toLowerCase() === 'approve'
      && String(review.reviewed_caption || '').trim() === caption
      && Boolean(String(review.rationale || '').trim());
    if (!approved) {
      return {
        code: 'AI_CAPTION_REVIEW_REQUIRED',
        message: 'The autonomous caption must carry an approving AI quality review for this exact platform text.',
      };
    }
  }
  return null;
}

function autonomousSocialCampaignRecord(record = {}) {
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  const identity = `${record.id || ''} ${record.source || ''} ${record.created_by || ''}`.toLowerCase();
  return identity.includes('agent-autonomy')
    || identity.includes('social_autonomous_content_factory')
    || String(record.source || '').toLowerCase() === 'social_hermes'
    || metadata.owner_review_required === true;
}

function autonomousSocialMediaStrategyIsCurrent(record = {}, metadata = {}) {
  const strategy = metadata.media_strategy;
  const platform = normalizeSocialHermesPlatformId(record.platform || '');
  if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy) || !platform || platform === 'all') return false;
  const frames = Array.isArray(strategy.frames) ? strategy.frames : [];
  const variant = strategy.platform_variants?.[platform];
  const frameIds = Array.isArray(variant?.frame_ids)
    ? variant.frame_ids.map(id => String(id || '').trim()).filter(Boolean)
    : [];
  const mediaItems = Array.isArray(record.media_items)
    ? record.media_items.filter(item => SOCIAL_IMAGE_URL_RE.test(String(item?.url || item || '')))
    : [];
  if (!frameIds.length || frameIds.length !== mediaItems.length || new Set(frameIds).size !== frameIds.length) return false;

  const framesById = new Map(frames
    .filter(frame => frame && typeof frame === 'object' && !Array.isArray(frame) && String(frame.id || '').trim())
    .map(frame => [String(frame.id).trim(), frame]));
  return frameIds.every((frameId, index) => {
    const frame = framesById.get(frameId);
    const expectedSource = String(frame?.source || '').trim().toLowerCase();
    const actualSource = String(mediaItems[index]?.source || '').trim().toLowerCase();
    return ['listing_image', 'generated_image', 'review_card'].includes(expectedSource)
      && expectedSource === actualSource;
  });
}

function autonomousSocialReviewBlockers(record = {}, { required = false } = {}) {
  if (!required && !autonomousSocialCampaignRecord(record)) return [];
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  const blockers = [];
  if (Number(metadata.ai_review_contract_version) !== SOCIAL_REVIEW_CONTRACT_VERSION) {
    blockers.push({
      code: 'AI_REVIEW_CONTRACT_OBSOLETE',
      message: 'Autonomous posts require a fresh AI review under the current visual quality contract.',
    });
  }
  if (metadata.ai_caption_quality_review_required !== true) {
    blockers.push({
      code: 'AI_CAPTION_REVIEW_REQUIRED',
      message: 'Autonomous posts require an approving AI review for the exact final platform caption.',
    });
  }
  const campaignReview = metadata.ai_campaign_visual_quality_review;
  const platform = normalizeSocialHermesPlatformId(record.platform || '');
  const platformReview = Array.isArray(campaignReview?.platform_reviews)
    ? campaignReview.platform_reviews.find(item => normalizeSocialHermesPlatformId(item?.platform || '') === platform)
    : null;
  const campaignReviewApproved = metadata.ai_campaign_visual_quality_review_required === true
    && campaignReview && typeof campaignReview === 'object' && !Array.isArray(campaignReview)
    && campaignReview.approved === true
    && String(campaignReview.decision || '').toLowerCase() === 'approve'
    && platformReview
    && String(platformReview.decision || '').toLowerCase() === 'approve'
    && Boolean(String(platformReview.rationale || '').trim());
  if (!campaignReviewApproved) {
    blockers.push({
      code: 'AI_CAMPAIGN_VISUAL_REVIEW_REQUIRED',
      message: 'Autonomous posts require an approving campaign-level AI vision review for the exact platform media sequence.',
    });
  }
  const reviewedContentDigest = String(metadata.ai_review_content_digest || '').trim().toLowerCase();
  const currentContentDigest = socialHermesReviewContentDigest(record);
  if (!/^[a-f0-9]{64}$/.test(reviewedContentDigest) || reviewedContentDigest !== currentContentDigest) {
    blockers.push({
      code: 'AI_REVIEW_CONTENT_CHANGED',
      message: 'The approved AI review is not bound to the current platform caption and ordered media. Generate a fresh AI review.',
    });
  }
  if (!autonomousSocialMediaStrategyIsCurrent(record, metadata)) {
    blockers.push({
      code: 'AI_MEDIA_PROVENANCE_REQUIRED',
      message: 'Autonomous posts require current AI media-plan provenance before publish approval.',
    });
  }
  return blockers;
}

export function socialHermesRecordHasPublicMedia(record = {}) {
  if (SOCIAL_IMAGE_URL_RE.test(String(record.custom_image_url || ''))) return true;
  if (SOCIAL_IMAGE_URL_RE.test(String(record.listing_image_url || ''))) return true;
  return (Array.isArray(record.media_items) ? record.media_items : []).some(item => SOCIAL_IMAGE_URL_RE.test(String(item?.url || item || '')));
}

export function socialHermesCarouselMediaReadinessError(record = {}) {
  const mediaItems = Array.isArray(record.media_items) ? record.media_items : [];
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  const expectsCarousel = record.platform === 'instagram' && (
    metadata.instagram_carousel === true
    || metadata.carousel === true
    || metadata.carousel_storyboard === true
    || mediaItems.length > 1
  );
  if (!expectsCarousel) return null;
  const urls = mediaItems.map(item => String(item?.url || item || '').trim()).filter(Boolean);
  const distinctUrls = new Set(urls);
  if (urls.length < 2 || distinctUrls.size < 2) {
    return {
      code: 'CAROUSEL_MEDIA_NOT_DISTINCT',
      message: 'Instagram carousel schedules require at least two distinct valid media items; no duplicate/first-image filler is allowed.',
    };
  }
  return null;
}

export function socialHermesCanaryReadinessForPost(post = {}, {
  now = new Date(),
  minLeadMinutes = 5,
  socialConfigs = {},
  make = { url: '' },
  governance = {},
  phase = 'approval',
} = {}) {
  const classified = classifyScheduledPost(post, now);
  const platform = normalizeSocialHermesPlatformId(post.platform || '');
  const blockers = [];
  const addBlocker = (code, message) => blockers.push({ code, message });
  const status = String(post.status || '').toLowerCase();
  const route = resolveSocialHermesPublishRoute(platform, socialConfigs, { makeWebhookUrl: make?.url || '' });
  const scheduleMs = classified.scheduled_at_ms;
  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const minLeadMs = Math.max(0, Number(minLeadMinutes) || 0) * 60_000;

  if (!platform) addBlocker('PLATFORM_REQUIRED', 'A concrete platform is required.');
  if (platform === 'all') addBlocker('PLATFORM_ALL_NOT_ALLOWED', 'platform=all must be expanded into concrete scheduled records before canary approval.');
  if (TERMINAL_PUBLISH_STATUSES.has(status)) addBlocker('TERMINAL_STATUS', 'Published, publishing, queued_external, or failed posts cannot be used as a canary candidate.');
  if (!post.scheduled_at) addBlocker('SCHEDULE_REQUIRED', 'scheduled_at is required before owner can approve a canary.');
  else if (scheduleMs === null) addBlocker('SCHEDULE_INVALID', 'scheduled_at is invalid.');
  else if (phase === 'publish' && scheduleMs > nowMs) addBlocker('SCHEDULE_NOT_DUE', 'The scheduled post is not due yet.');
  else if (phase !== 'publish' && scheduleMs <= nowMs + minLeadMs) addBlocker('SCHEDULE_TOO_SOON', `Canary approval requires a schedule at least ${Math.round(minLeadMs / 60_000)} minutes in the future.`);
  if (!route.configured) addBlocker('PUBLISH_ROUTE_NOT_CONFIGURED', route.reason);

  for (const blocker of autonomousSocialReviewBlockers(post, { required: phase === 'publish' })) addBlocker(blocker.code, blocker.message);

  const captionProblem = socialHermesCaptionQualityProblem({ ...post, platform });
  if (captionProblem) addBlocker(captionProblem.code, captionProblem.message);
  if (socialHermesRecordHasForbiddenFallbackMedia(post)) addBlocker('FALLBACK_MEDIA_NOT_ALLOWED', 'Synthetic fallback media cannot be used for canary publishing.');
  const mediaSafety = scheduledPostMediaSafetyError(post);
  if (mediaSafety) addBlocker(mediaSafety.code || 'MEDIA_SAFETY_ERROR', mediaSafety.message || 'Media is not safe to publish.');
  if (['instagram', 'pinterest', 'tiktok'].includes(platform) && !socialHermesRecordHasPublicMedia(post)) {
    addBlocker('MEDIA_REQUIRED', `${platform} canary publishing requires at least one public media URL.`);
  }
  const carouselProblem = socialHermesCarouselMediaReadinessError({ ...post, platform });
  if (carouselProblem) addBlocker(carouselProblem.code, carouselProblem.message);

  const ready = blockers.length === 0;
  const ownerApprovalRequired = ready && post.approved_for_publish !== true;
  const verdict = !ready
    ? 'blocked'
    : classified.is_publish_approved
      ? 'approved_waiting_for_due'
      : 'ready_for_owner_approval';
  const mediaPreview = [
    ...(Array.isArray(post.media_items) ? post.media_items.map(item => ({
      url: String(item?.url || item || ''),
      type: item?.type || 'image',
      source: item?.source || item?.source_field || '',
      alt: item?.alt || '',
    })) : []),
    post.custom_image_url ? { url: String(post.custom_image_url), type: 'image', source: 'custom_image_url', alt: '' } : null,
    post.generated_image_url ? { url: String(post.generated_image_url), type: 'image', source: 'generated_image_url', alt: '' } : null,
    post.listing_image_url ? { url: String(post.listing_image_url), type: 'image', source: 'listing_image_url', alt: '' } : null,
  ].filter(item => item?.url);

  return {
    id: post.id || '',
    platform,
    scheduled_at: post.scheduled_at || null,
    listing_id: post.listing_id || null,
    listing_title: post.listing_title || '',
    status: post.status || 'draft',
    queue_state: classified.queue_state,
    verdict,
    ready_for_canary_approval: ready && ownerApprovalRequired,
    ready_for_publish: phase === 'publish' && ready && classified.is_publish_approved,
    ready_for_publish_when_due: ready && classified.is_publish_approved,
    owner_approval_required: ownerApprovalRequired,
    publish_route: route.route || null,
    publish_governance: {
      autopublish_enabled: governance.autopublish_enabled,
      publish_now_available: governance.publish_now_available,
      note: governance.autopublish_enabled
        ? 'Real publish is enabled; only owner-approved due posts may publish.'
        : 'Autopublish is disabled; canary readiness is approval planning only and will not publish.',
    },
    media_count: [
      ...(Array.isArray(post.media_items) ? post.media_items.map(item => item?.url || item) : []),
      post.custom_image_url,
      post.generated_image_url,
      post.listing_image_url,
    ].filter(Boolean).length,
    preview: {
      caption: String(post.caption || ''),
      media_items: mediaPreview.slice(0, 8),
      listing_url: post.listing_id ? `https://www.etsy.com/listing/${post.listing_id}` : '',
      campaign_id: post.metadata?.campaign_id || null,
      creative_concept: post.metadata?.creative_concept || '',
      creative_hook: post.metadata?.creative_hook || '',
    },
    blockers,
  };
}

export function socialHermesRecordEligibleForAutoArm(record = {}) {
  const metadata = record?.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata
    : {};
  return record?.source === 'social_hermes'
    && metadata.owner_review_required === true
    && metadata.auto_publish_after_review_window === true
    && !record.published
    && !['paused', 'cancelled', 'deleted', 'published', 'approved_scheduled'].includes(String(record.status || '').toLowerCase());
}

export function createSocialPublishReadinessService({
  loadSocialConfigs,
  loadMakeRoute,
  getPublishGovernance,
  getScheduledPosts,
  saveScheduledPost,
  runPublishDueScheduled,
  autoPublishOptInEnabled,
  autoPublishLeadMinutes,
  readinessForPost = socialHermesCanaryReadinessForPost,
  clock = () => new Date(),
} = {}) {
  const loadReadinessContext = async () => {
    const [socialConfigs, make] = await Promise.all([
      Promise.resolve().then(() => loadSocialConfigs?.()).catch(() => ({})),
      Promise.resolve().then(() => loadMakeRoute?.()).catch(() => ({ url: '', source: null })),
    ]);
    return {
      socialConfigs: socialConfigs || {},
      make: make || { url: '', source: null },
      governance: getPublishGovernance?.() || {},
    };
  };

  const evaluatePost = async (post, options = {}) => {
    const context = await loadReadinessContext();
    return readinessForPost(post, {
      now: options.now || clock(),
      minLeadMinutes: options.minLeadMinutes ?? 5,
      phase: options.phase || 'approval',
      ...context,
    });
  };

  const armAutoPublishRecord = async (record = {}) => {
    const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata
      : {};
    if (metadata.auto_publish_after_review_window !== true) return record;
    if (autoPublishOptInEnabled?.() !== true) {
      const error = new Error('Owner opt-in for autonomous publishing is not enabled.');
      error.code = 'AUTO_PUBLISH_OWNER_OPT_IN_REQUIRED';
      throw error;
    }

    const minLeadMinutes = autoPublishLeadMinutes?.() ?? 12 * 60;
    const readiness = await evaluatePost(record, { now: clock(), minLeadMinutes });
    if (readiness.verdict === 'blocked' || readiness.ready_for_canary_approval !== true) {
      const error = new Error(`Autonomous publish readiness is blocked: ${readiness.blockers.map(item => item.code).join(', ') || 'unknown blocker'}`);
      error.code = 'AUTO_PUBLISH_READINESS_REQUIRED';
      error.readiness = readiness;
      throw error;
    }

    const approvedAt = clock().toISOString();
    return {
      ...record,
      status: 'approved_scheduled',
      approved_for_publish: true,
      approved_by: 'owner-opt-in:auto-schedule',
      approved_at: approvedAt,
      approval_source: 'owner_opt_in_auto_schedule',
      approval_note: `Automatic publish armed after at least ${Math.round(minLeadMinutes / 60)} hours of owner review time.`,
      metadata: {
        ...metadata,
        auto_publish_armed: true,
        auto_publish_armed_at: approvedAt,
        auto_publish_cancel_until: record.scheduled_at,
        auto_publish_policy: 'owner_opt_in_review_window_v1',
      },
    };
  };

  const armExistingQueue = async () => {
    const records = await getScheduledPosts();
    const results = [];
    for (const record of records) {
      if (!socialHermesRecordEligibleForAutoArm(record)) {
        results.push({ id: record?.id || null, status: 'skipped', reason: 'not_ai_ready_owner_review_record' });
        continue;
      }
      const metadata = record.metadata;
      try {
        const armed = await armAutoPublishRecord({
          ...record,
          metadata: { ...metadata, auto_publish_after_review_window: true },
        });
        await saveScheduledPost(armed);
        results.push({ id: record.id, status: 'armed', scheduled_at: armed.scheduled_at });
      } catch (error) {
        results.push({ id: record?.id || null, status: 'blocked', code: error?.code || 'ARM_FAILED', reason: error?.message || 'readiness check failed' });
      }
    }
    return {
      success: true,
      action: 'armExistingQueue',
      armed_count: results.filter(item => item.status === 'armed').length,
      blocked_count: results.filter(item => item.status === 'blocked').length,
      skipped_count: results.filter(item => item.status === 'skipped').length,
      results,
    };
  };

  const getCanaryReadiness = async (body = {}, { probeCandidateMedia } = {}) => {
    const [scheduledPosts, context] = await Promise.all([
      Promise.resolve().then(() => getScheduledPosts()).catch(() => []),
      loadReadinessContext(),
    ]);
    const requestedId = String(body.id || body.post_id || body.scheduled_post_id || '').trim();
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 12, 1), 50);
    const now = body.now ? new Date(body.now) : clock();
    const minLeadMinutes = body.min_lead_minutes ?? body.minLeadMinutes ?? 5;
    const probeMedia = body.probe_media === true || body.probeMedia === true;
    const candidates = scheduledPosts
      .filter(post => !requestedId || String(post.id || '') === requestedId)
      .map(post => readinessForPost(post, { now, minLeadMinutes, ...context }))
      .sort((a, b) => {
        const ar = a.verdict === 'ready_for_owner_approval' ? 0 : a.verdict === 'approved_waiting_for_due' ? 1 : 2;
        const br = b.verdict === 'ready_for_owner_approval' ? 0 : b.verdict === 'approved_waiting_for_due' ? 1 : 2;
        return ar - br || String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || ''));
      })
      .slice(0, requestedId ? 1 : limit);
    if (probeMedia && typeof probeCandidateMedia === 'function') {
      for (const candidate of candidates) await probeCandidateMedia(candidate);
    }
    return {
      checked_at: clock().toISOString(),
      requested_id: requestedId || null,
      min_lead_minutes: Number(minLeadMinutes) || 0,
      summary: {
        total_checked: candidates.length,
        ready_for_owner_approval: candidates.filter(item => item.verdict === 'ready_for_owner_approval').length,
        approved_waiting_for_due: candidates.filter(item => item.verdict === 'approved_waiting_for_due').length,
        blocked: candidates.filter(item => item.verdict === 'blocked').length,
        autopublish_enabled: context.governance.autopublish_enabled,
      },
      connector_summary: summarizeSocialHermesSocialConfigs(context.socialConfigs),
      candidates,
      next_action: candidates.some(item => item.verdict === 'ready_for_owner_approval')
        ? 'Ask the owner to approve exactly one ready candidate through the admin approval flow; do not publish from Hermes.'
        : 'Fix blockers or generate/schedule a media-ready candidate before asking for canary approval.',
    };
  };

  const publishDue = async (input = {}) => {
    const autoArm = input.dryRun === true || autoPublishOptInEnabled?.() !== true
      ? null
      : await armExistingQueue();
    const result = await runPublishDueScheduled({
      dryRun: input.dryRun,
      limit: input.limit,
      now: input.now,
      canaryId: input.canaryId,
      readinessCheck: (post, options = {}) => evaluatePost(post, {
        now: options.now || clock(),
        minLeadMinutes: 0,
        phase: 'publish',
      }),
    });
    if (autoArm) result.auto_arm = {
      armed_count: autoArm.armed_count,
      blocked_count: autoArm.blocked_count,
      skipped_count: autoArm.skipped_count,
    };
    return result;
  };

  return {
    armAutoPublishRecord,
    armExistingQueue,
    evaluatePost,
    getCanaryReadiness,
    loadReadinessContext,
    publishDueScheduled: publishDue,
  };
}
