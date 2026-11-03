import {
  resolveSocialOwnerReviewVariantMedia,
  socialOwnerReviewCanonicalVariantFormat,
  socialOwnerReviewPrimaryMediaFields,
} from '../domain/owner-review-media-contract.js';

const SUPPORTED_PLATFORMS = new Set(['instagram', 'facebook', 'pinterest', 'tiktok']);

function text(value) {
  return String(value ?? '').trim();
}

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function uniquePlatforms(value = []) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(platform => text(platform).toLowerCase())
    .filter(platform => SUPPORTED_PLATFORMS.has(platform)))];
}

function validIsoInstant(value) {
  const valueText = text(value);
  return valueText && Number.isFinite(new Date(valueText).getTime()) ? valueText : '';
}

function slug(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 46) || 'post';
}

function captionQualityProblem(variant = {}) {
  const caption = String(variant.caption || '').trim();
  if (!caption) return 'empty caption';
  const review = variant.caption_quality_review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    return 'AI caption quality review is missing';
  }
  if (review.approved !== true || text(review.decision).toLowerCase() !== 'approve') {
    return text(review.rationale) || 'AI caption quality review requested revision';
  }
  if (String(review.reviewed_caption || '').trim() !== caption) {
    return 'AI caption quality review does not match the final platform caption';
  }
  if (!String(review.rationale || '').trim()) {
    return 'AI caption quality review rationale is missing';
  }
  return '';
}

/**
 * Materializes one complete owner-review campaign package from an AI plan that
 * has already reached ready_for_review.
 *
 * Creative decisions remain upstream: this builder never chooses a platform,
 * frame, caption, schedule, or fallback media. The default media resolver is a
 * deterministic port of the active Python producer contract and preserves only
 * the exact ordered media already selected by creativePlan.
 */
export function createSocialOwnerReviewCampaignRecordBuilder({
  resolveVariantMedia = resolveSocialOwnerReviewVariantMedia,
  primaryMediaFields = socialOwnerReviewPrimaryMediaFields,
  clock = () => new Date(),
  idPrefix = 'agent-autonomy',
  listingCooldownDays = 21,
  createdBy = 'social_autonomous_content_factory_v5_creative_plan',
} = {}) {
  if (typeof resolveVariantMedia !== 'function') {
    throw new TypeError('resolveVariantMedia dependency is required');
  }
  if (typeof primaryMediaFields !== 'function') {
    throw new TypeError('primaryMediaFields dependency is required');
  }

  const build = async ({
    plan = {},
    listing = {},
    opportunity = {},
    platforms = [],
    blockedMedia = new Set(),
    existingIds = new Set(),
    generationDiagnostics = [],
  } = {}) => {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.status !== 'ready_for_review') {
      throw codedError(
        'SOCIAL_OWNER_REVIEW_PLAN_NOT_READY',
        'Owner-review records require a creative plan with status=ready_for_review.',
      );
    }
    const requestedPlatforms = uniquePlatforms(platforms);
    if (!requestedPlatforms.length) {
      throw codedError(
        'SOCIAL_OWNER_REVIEW_PLATFORM_REQUIRED',
        'The AI-selected campaign has no supported configured platform.',
      );
    }

    const listingId = text(listing.listing_id || listing.id);
    if (!listingId) {
      throw codedError('SOCIAL_OWNER_REVIEW_LISTING_REQUIRED', 'Owner-review campaign requires an exact listing id.');
    }
    const listingTitle = String(listing.title || '').trim();
    const concept = plan.concept && typeof plan.concept === 'object' && !Array.isArray(plan.concept)
      ? plan.concept
      : {};
    const campaignSignal = text(opportunity.moment || opportunity.type || 'ai-selected campaign');
    const campaignId = text(plan.campaign_id)
      || `campaign-${listingId}-${slug(campaignSignal)}`;
    const variants = Array.isArray(plan.variants) ? plan.variants : [];
    const timing = opportunity.timing && typeof opportunity.timing === 'object' && !Array.isArray(opportunity.timing)
      ? opportunity.timing
      : {};
    const scheduledByPlatform = timing.scheduled_at_by_platform
      && typeof timing.scheduled_at_by_platform === 'object'
      && !Array.isArray(timing.scheduled_at_by_platform)
      ? timing.scheduled_at_by_platform
      : {};
    const nowValue = clock();
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
    if (!Number.isFinite(now.getTime())) {
      throw codedError('SOCIAL_OWNER_REVIEW_CLOCK_INVALID', 'Owner-review record builder clock is invalid.');
    }
    const dateKey = now.toISOString().slice(0, 10).replaceAll('-', '');
    const records = [];
    const blockers = [];

    for (const platform of requestedPlatforms) {
      const matches = variants.filter(variant => text(variant?.platform).toLowerCase() === platform);
      if (matches.length !== 1) {
        blockers.push({
          platform,
          reason: matches.length
            ? 'creative planner returned duplicate ready variants for this platform'
            : 'creative planner did not return a ready variant for this platform',
        });
        continue;
      }
      const variant = matches[0];
      const mediaItems = await resolveVariantMedia({
        variant,
        listing,
        platform,
        blockedMedia,
        plan,
        opportunity,
      });
      if (!Array.isArray(mediaItems) || !mediaItems.length) {
        blockers.push({ platform, reason: 'creative planner returned no ready media for this platform' });
        continue;
      }

      const scheduledAt = validIsoInstant(scheduledByPlatform[platform]);
      if (!scheduledAt) {
        blockers.push({
          platform,
          reason: 'AI opportunity did not provide a valid ISO-8601 publication time for this platform',
        });
        continue;
      }
      const qualityProblem = captionQualityProblem(variant);
      if (qualityProblem) {
        blockers.push({
          platform,
          reason: `${qualityProblem}; producer will not synthesize a replacement caption`,
        });
        continue;
      }

      const postId = `${text(idPrefix) || 'agent-autonomy'}-${dateKey}-${platform}-${listingId}-${slug(campaignId)}`;
      if (existingIds instanceof Set && existingIds.has(postId)) {
        blockers.push({ platform, reason: `post id already exists: ${postId}` });
        continue;
      }
      const caption = String(variant.caption || '').trim();
      const mediaStrategy = plan.media_strategy && typeof plan.media_strategy === 'object'
        ? plan.media_strategy
        : {};
      const listingUnderstanding = plan.listing_understanding && typeof plan.listing_understanding === 'object'
        ? plan.listing_understanding
        : {};
      const format = socialOwnerReviewCanonicalVariantFormat(variant, platform, mediaItems.length);
      records.push({
        id: postId,
        caption,
        platform,
        scheduled_at: scheduledAt,
        listing_id: listingId,
        listing_title: listingTitle,
        ...primaryMediaFields(mediaItems),
        media_items: mediaItems,
        source: 'social_hermes',
        created_by: createdBy,
        metadata: {
          campaign_id: campaignId,
          variant_of: variant.variant_of || campaignId,
          variant_index: variants.indexOf(variant),
          variant_count: variants.length,
          creative_concept: concept.name || '',
          creative_hook: concept.hook || '',
          ai_campaign_signal: campaignSignal,
          ai_campaign_reason: opportunity.reason || '',
          platform_decisions: opportunity.platform_decisions && typeof opportunity.platform_decisions === 'object'
            ? opportunity.platform_decisions
            : {},
          listing_id: listingId,
          media_policy: 'creative_planner_ready_media_only_no_synthetic_fallback',
          storyboard_roles: (Array.isArray(plan.storyboard) ? plan.storyboard : [])
            .map(frame => frame?.role)
            .filter(Boolean),
          listing_cooldown_days: Number(listingCooldownDays),
          media_urls: mediaItems.map(item => item?.url).filter(Boolean),
          generated_media_count: mediaItems.filter(item => item?.source === 'generated_image').length,
          review_card_count: mediaItems.filter(item => item?.source === 'review_card').length,
          media_format: format,
          instagram_carousel: platform === 'instagram' && format === 'carousel',
          plan_status: plan.status,
          generation_decision: plan.generation_decision?.status,
          media_strategy: plan.media_strategy,
          frame_count_rationale: mediaStrategy.frame_count_rationale,
          generation_diagnostics: Array.isArray(generationDiagnostics) ? generationDiagnostics : [],
          audience_timezone: text(timing.audience_timezone),
          timing_rationale: text(timing.rationale),
          ai_caption_quality_review_required: true,
          ai_caption_quality_review: variant.caption_quality_review,
          ai_caption_review_source: listingUnderstanding.caption_review_source,
          ai_caption_review_model: listingUnderstanding.caption_review_model,
          ai_caption_review_run_id: listingUnderstanding.caption_review_run_id,
          ai_caption_reviewed_at: listingUnderstanding.caption_reviewed_at,
          ai_campaign_visual_quality_review_required: true,
          ai_campaign_visual_quality_review: plan.campaign_quality_review,
          ai_review_artifact: variant.ai_review_artifact,
          owner_notification_required: true,
          publish_approval_granted: false,
          auto_publish_armed: false,
        },
        approved: false,
        approved_for_publish: false,
        approved_by: null,
        approved_at: null,
        approval_source: 'owner_review_required',
      });
    }

    if (blockers.length || records.length !== requestedPlatforms.length) {
      throw codedError(
        'SOCIAL_OWNER_REVIEW_CAMPAIGN_INCOMPLETE',
        'Owner-review campaign package is incomplete; partial platform packages are not allowed.',
        { blockers, requested_platforms: requestedPlatforms, prepared_platforms: records.map(record => record.platform) },
      );
    }

    return {
      campaign_id: campaignId,
      records,
      platform_count: records.length,
      published: false,
    };
  };

  return { build };
}
