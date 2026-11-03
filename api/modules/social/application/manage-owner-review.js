import {
  socialHermesArtifactHash,
  socialHermesReviewContentDigest,
  withoutCallerSuppliedSocialReviewTrust,
} from './review-artifacts.js';
import {
  captionForSocialHermesPlatform,
  normalizeSocialHermesPlatformId,
  resolveSocialHermesPublishCapablePlatforms,
} from '../domain/platform-resolution.js';

const IMAGE_URL_RE = /^https?:\/\//i;
const OWNER_NOTIFICATION_FIELDS = Object.freeze([
  'owner_notification_sent_at',
  'owner_notification_media_count',
  'owner_notification_delivery',
  'owner_notification_chat_id',
  'owner_notification_text_message_id',
  'owner_notification_media_message_ids',
  'owner_notification_campaign_digest',
  'owner_notification_record_digest',
]);

function metadataOf(record = {}) {
  return record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata
    : {};
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clockDate(clock) {
  const value = clock?.() ?? new Date();
  return value instanceof Date ? value : new Date(value);
}

function stripCallerNotificationTrust(metadata = {}) {
  const safe = { ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}) };
  for (const key of OWNER_NOTIFICATION_FIELDS) delete safe[key];
  return safe;
}

export function withServerSocialOwnerReviewDigest(record = {}, { clock = () => new Date() } = {}) {
  return {
    ...record,
    metadata: {
      ...metadataOf(record),
      ai_review_content_digest: socialHermesReviewContentDigest(record),
      ai_review_content_digest_issued_at: clockDate(clock).toISOString(),
      ai_review_content_digest_source: 'etsy_manager_server',
    },
  };
}

export function socialOwnerReviewNotificationRecordDigest(record = {}) {
  return socialHermesArtifactHash({
    id: String(record.id || ''),
    platform: normalizeSocialHermesPlatformId(record.platform || ''),
    scheduled_at: String(record.metadata?.requested_scheduled_at || record.scheduled_at || ''),
    content_digest: socialHermesReviewContentDigest(record),
  });
}

export function socialOwnerReviewNotificationCampaignDigest(records = []) {
  return socialHermesArtifactHash(records.map(record => ({
    id: String(record.id || ''),
    digest: socialOwnerReviewNotificationRecordDigest(record),
  })));
}

export function socialOwnerReviewNotificationReady(record = {}, {
  ownerId = '',
} = {}) {
  const metadata = metadataOf(record);
  const messageId = Number(metadata.owner_notification_text_message_id);
  return metadata.owner_notification_required === true
    && metadata.owner_notification_delivery === 'etsy_manager_telegram_bot_api'
    && String(metadata.owner_notification_chat_id || '') === String(ownerId)
    && Number.isInteger(messageId) && messageId > 0
    && /^[a-f0-9]{64}$/.test(String(metadata.owner_notification_campaign_digest || ''))
    && String(metadata.owner_notification_record_digest || '') === socialOwnerReviewNotificationRecordDigest(record)
    && Boolean(metadata.owner_notification_sent_at);
}

export function socialOwnerReviewAutoSchedule(record = {}, {
  ownerId = '',
  autoPublishOptInEnabled = false,
  autoPublishLeadMinutes = 12 * 60,
  clock = () => new Date(),
} = {}) {
  if (!autoPublishOptInEnabled || !record.scheduled_at) return null;
  const metadata = metadataOf(record);
  const review = metadata.ai_caption_quality_review;
  const caption = String(record.caption || '').trim();
  const exactCaptionApproved = metadata.ai_caption_quality_review_required === true
    && review && typeof review === 'object' && !Array.isArray(review)
    && review.approved === true
    && String(review.decision || '').toLowerCase() === 'approve'
    && String(review.reviewed_caption || '').trim() === caption;
  const hasAiMediaStrategy = metadata.media_strategy
    && typeof metadata.media_strategy === 'object'
    && !Array.isArray(metadata.media_strategy);
  const campaignReview = metadata.ai_campaign_visual_quality_review;
  const platform = normalizeSocialHermesPlatformId(record.platform || '');
  const platformReview = Array.isArray(campaignReview?.platform_reviews)
    ? campaignReview.platform_reviews.find(item => normalizeSocialHermesPlatformId(item?.platform || '') === platform)
    : null;
  const campaignVisualApproved = metadata.ai_campaign_visual_quality_review_required === true
    && campaignReview?.approved === true
    && String(campaignReview?.decision || '').toLowerCase() === 'approve'
    && String(platformReview?.decision || '').toLowerCase() === 'approve';
  const reviewContentCurrent = String(metadata.ai_review_content_digest || '').trim().toLowerCase()
    === socialHermesReviewContentDigest(record);
  if (!exactCaptionApproved
    || !hasAiMediaStrategy
    || !campaignVisualApproved
    || !reviewContentCurrent
    || !socialOwnerReviewNotificationReady(record, { ownerId })) return null;

  const requestedMs = new Date(record.scheduled_at).getTime();
  if (!Number.isFinite(requestedMs)) return null;
  const minimumMs = clockDate(clock).getTime() + Number(autoPublishLeadMinutes || 0) * 60_000;
  const dayMs = 24 * 60 * 60_000;
  const dayJumps = requestedMs < minimumMs ? Math.ceil((minimumMs - requestedMs) / dayMs) : 0;
  return {
    requested_at: record.scheduled_at,
    scheduled_at: new Date(requestedMs + dayJumps * dayMs).toISOString(),
  };
}

export async function expandSocialOwnerReviewRecord(record = {}, {
  loadSocialConfigs,
  generateId = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
  if (normalizeSocialHermesPlatformId(record.platform) !== 'all') return [record];
  const socialConfigs = await Promise.resolve().then(() => loadSocialConfigs?.()).catch(() => ({}));
  const targets = resolveSocialHermesPublishCapablePlatforms(socialConfigs || {})
    .filter(platform => ['instagram', 'facebook', 'pinterest', 'tiktok'].includes(platform));
  if (!targets.length) {
    throw codedError('ALL_PLATFORM_TARGET_EMPTY', 'platform=all requires at least one configured Etsy AI Command Center social channel.');
  }
  const baseId = String(record.id || generateId('all')).slice(0, 120);
  return targets.map(platform => ({
    ...record,
    id: targets.length === 1 ? baseId : `${baseId}-${platform}`,
    platform,
    caption: captionForSocialHermesPlatform(record, platform),
    metadata: {
      ...metadataOf(record),
      expanded_from_platform: 'all',
      all_platform_target: targets,
    },
  }));
}

function hasCallerSuppliedPublishTrust(metadata = {}) {
  return [
    'ai_caption_quality_review_required',
    'ai_caption_quality_review',
    'ai_campaign_visual_quality_review_required',
    'ai_campaign_visual_quality_review',
    'ai_review_artifact',
    'ai_review_artifact_id',
    'ai_review_contract_version',
    'ai_review_artifact_verified_at',
    'auto_publish_after_review_window',
    'auto_publish_armed',
  ].some(key => Object.prototype.hasOwnProperty.call(metadata, key));
}

function escapeTelegramHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function scheduleDateParts(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('uk-UA', {
      timeZone,
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value || '';
    const day = part('day');
    const month = part('month');
    const hour = part('hour');
    const minute = part('minute');
    if (!day || !month || !hour || !minute) return null;
    return `${day} ${month}, ${hour}:${minute}`;
  } catch {
    return null;
  }
}

function ownerScheduleLabel(value, audienceTimeZone = '') {
  const kyiv = scheduleDateParts(value, 'Europe/Kyiv');
  if (!kyiv) return String(value || '');
  const audience = audienceTimeZone && audienceTimeZone !== 'Europe/Kyiv'
    ? scheduleDateParts(value, audienceTimeZone)
    : null;
  return audience
    ? `${kyiv} (Київ) · ${audience} (US-аудиторія)`
    : `${kyiv} (Київ)`;
}

function ownerRejectedPreviewLines(records = []) {
  const seen = new Set();
  const lines = [];
  for (const record of records) {
    const diagnostics = Array.isArray(record?.metadata?.generation_diagnostics)
      ? record.metadata.generation_diagnostics
      : [];
    for (const diagnostic of diagnostics) {
      const role = String(diagnostic?.frame_role || 'варіант кадру').trim();
      for (const preview of (Array.isArray(diagnostic?.rejected_previews) ? diagnostic.rejected_previews : [])) {
        const url = String(preview?.url || '').trim();
        const identity = String(preview?.id || url).trim();
        if (!identity || seen.has(identity)) continue;
        seen.add(identity);
        const reason = String(
          preview?.owner_summary_uk
            || (Array.isArray(preview?.issues) && preview.issues[0])
            || preview?.rationale
            || diagnostic?.error
            || 'Кадр не пройшов AI-перевірку якості.',
        ).replace(/\s+/g, ' ').trim().slice(0, 260);
        const previewLink = IMAGE_URL_RE.test(url)
          ? ` · <a href="${escapeTelegramHtml(url)}">переглянути</a>`
          : '';
        lines.push(`• ${escapeTelegramHtml(role)}: ${escapeTelegramHtml(reason)}${previewLink}`);
        if (lines.length >= 3) return lines;
      }
    }
  }
  return lines;
}

function ownerExcludedPlatformLines(metadata = {}) {
  const decisions = metadata.platform_decisions && typeof metadata.platform_decisions === 'object'
    && !Array.isArray(metadata.platform_decisions)
    ? metadata.platform_decisions
    : {};
  return Object.entries(decisions).flatMap(([platform, value]) => {
    if (!value || typeof value !== 'object' || String(value.decision || '').toLowerCase() !== 'exclude') return [];
    const rationale = String(value.rationale || '').replace(/\s+/g, ' ').trim().slice(0, 260);
    return [`• ${escapeTelegramHtml(platform)}: ${escapeTelegramHtml(rationale || 'AI не знайшов чесної нативної адаптації для цієї ідеї.')}`];
  });
}

export function buildSocialOwnerReviewNotificationMessage(records = [], {
  publicBaseUrl = '',
} = {}) {
  const first = records[0] || {};
  const metadata = metadataOf(first);
  const listingId = String(first.listing_id || '').trim();
  const listingTitle = String(first.listing_title || 'Etsy listing').trim();
  const listingUrl = listingId ? `https://www.etsy.com/listing/${encodeURIComponent(listingId)}` : '';
  const reviewId = String(metadata.campaign_id || first.id || '').trim();
  const baseUrl = String(publicBaseUrl || '').trim().replace(/\/$/, '');
  const reviewUrl = baseUrl && reviewId ? `${baseUrl}/schedule?preview_id=${encodeURIComponent(reviewId)}` : '';
  const platforms = records.map(record => String(record.platform || '')).filter(Boolean).join(', ');
  const excludedPlatformLines = ownerExcludedPlatformLines(metadata);
  const excludedPlatformBlock = excludedPlatformLines.length
    ? `\n\n<b>Не включено:</b>\n${excludedPlatformLines.join('\n')}`
    : '';
  const scheduleLines = records.map(record => {
    const when = record.metadata?.requested_scheduled_at || record.scheduled_at || '';
    const audienceTimeZone = String(record.metadata?.audience_timezone || metadata.audience_timezone || '').trim();
    return `• ${escapeTelegramHtml(record.platform || '')}: ${escapeTelegramHtml(ownerScheduleLabel(when, audienceTimeZone))}`;
  }).join('\n');
  const mediaStrategy = metadata.media_strategy && typeof metadata.media_strategy === 'object'
    ? metadata.media_strategy
    : {};
  const mediaLines = records.map(record => {
    const platform = String(record.platform || '').toLowerCase();
    const variant = mediaStrategy.platform_variants?.[platform] || {};
    const count = Array.isArray(variant.frame_ids)
      ? variant.frame_ids.length
      : (Array.isArray(record.media_items) ? record.media_items.length : 0);
    const format = String(variant.format || (count > 1 ? 'multi-image' : 'single'));
    return `• ${escapeTelegramHtml(platform)}: ${count} ${count === 1 ? 'кадр' : 'кадри'} · ${escapeTelegramHtml(format)}`;
  }).join('\n');
  const frameCountRationale = String(metadata.frame_count_rationale || mediaStrategy.frame_count_rationale || '').trim();
  const visualLogic = frameCountRationale
    ? `\n\n<b>Чому саме стільки кадрів:</b>\n${escapeTelegramHtml(frameCountRationale)}`
    : '';
  const rejectedPreviewLines = ownerRejectedPreviewLines(records);
  const rejectedPreviewBlock = rejectedPreviewLines.length
    ? `\n\n<b>Що AI відхилив під час підготовки:</b>\n${rejectedPreviewLines.join('\n')}\n<i>Ці варіанти не входять у пост і не будуть опубліковані.</i>`
    : '';
  const captionLines = records.map(record => (
    `<b>${escapeTelegramHtml(String(record.platform || '').toUpperCase())}</b>\n${escapeTelegramHtml(String(record.caption || '').slice(0, 650))}`
  )).join('\n\n');
  const listingLine = listingUrl
    ? `<a href="${listingUrl}">${escapeTelegramHtml(listingTitle)}</a>`
    : escapeTelegramHtml(listingTitle);
  const reviewLine = reviewUrl ? `\n\n<a href="${reviewUrl}">Переглянути й відредагувати в Etsy AI Command Center</a>` : '';
  return [
    '<b>Підготував новий пост на перевірку</b>',
    'Він уже запланований із часом на перевірку. Якщо треба скасувати або переробити, просто напиши мені.',
    '',
    `<b>Платформи:</b> ${escapeTelegramHtml(platforms)}${excludedPlatformBlock}`,
    `<b>Лістинг:</b> ${listingLine}`,
    '',
    `<b>Час:</b>\n${scheduleLines}`,
    '',
    `<b>Кадри:</b>\n${mediaLines}${visualLogic}${rejectedPreviewBlock}`,
    '',
    captionLines,
    reviewLine,
  ].join('\n').slice(0, 3900);
}

export function createSocialOwnerReviewService({
  getScheduledPosts,
  saveScheduledPost,
  saveScheduledPostBatch,
  updateScheduledPost,
  consumeReviewArtifact,
  loadSocialConfigs,
  notificationGateway,
  getOwnerId,
  getPublicBaseUrl = () => '',
  autoPublishOptInEnabled = () => false,
  autoPublishLeadMinutes = () => 12 * 60,
  clock = () => new Date(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  generateId,
} = {}) {
  const ownerReviewAutoSchedule = record => socialOwnerReviewAutoSchedule(record, {
    ownerId: getOwnerId?.() || '',
    autoPublishOptInEnabled: autoPublishOptInEnabled?.() === true,
    autoPublishLeadMinutes: autoPublishLeadMinutes?.(),
    clock,
  });

  const expand = record => expandSocialOwnerReviewRecord(record, { loadSocialConfigs, generateId });

  const saveReviewDrafts = async (records = [], { validateRecord } = {}) => {
    const prepared = [];
    for (const record of records) {
      for (const concreteRecord of await expand(record)) {
        const clientMetadata = stripCallerNotificationTrust(metadataOf(concreteRecord));
        const reviewTrust = await consumeReviewArtifact(concreteRecord, clientMetadata);
        const reviewedRecord = withServerSocialOwnerReviewDigest({
          ...concreteRecord,
          metadata: reviewTrust.metadata,
        }, { clock });
        const autoSchedule = ownerReviewAutoSchedule(reviewedRecord);
        prepared.push({
          ...reviewedRecord,
          status: autoSchedule ? 'scheduled' : 'draft',
          scheduled_at: autoSchedule?.scheduled_at || null,
          approved_for_publish: false,
          approved_by: null,
          approved_at: null,
          approval_note: null,
          approval_source: 'owner_review_required',
          metadata: {
            ...reviewedRecord.metadata,
            owner_review_required: true,
            owner_notification_required: true,
            publish_approval_granted: false,
            auto_publish_after_review_window: Boolean(autoSchedule),
            ...(reviewedRecord.scheduled_at ? { requested_scheduled_at: reviewedRecord.scheduled_at } : {}),
            ...(autoSchedule ? { owner_review_min_hours: Math.round(autoPublishLeadMinutes() / 60) } : {}),
          },
        });
      }
    }
    for (const record of prepared) {
      const problem = validateRecord?.(record, { requireSchedule: false }) || null;
      if (problem) return { records: prepared, saved: [], validation_problem: problem };
    }
    const saved = await saveScheduledPostBatch(prepared);
    return { records: prepared, saved, validation_problem: null };
  };

  const saveOwnerRequestedSchedule = async (records = [], { validateRecord } = {}) => {
    const prepared = [];
    for (const record of records) {
      const concreteRecords = await expand(record);
      if (concreteRecords.some(concreteRecord => hasCallerSuppliedPublishTrust(metadataOf(concreteRecord)))) {
        return {
          records: [],
          saved: [],
          validation_problem: {
            code: 'AI_REVIEW_ARTIFACT_REQUIRED',
            message: 'The schedule action cannot accept caller-supplied AI review or autopublish trust. Use creativePlan review artifacts with saveReviewDraft.',
          },
        };
      }
      prepared.push(...concreteRecords.map(concreteRecord => ({
        ...concreteRecord,
        status: 'scheduled',
        approved_for_publish: false,
        approved_by: null,
        approved_at: null,
        approval_source: 'owner_requested_schedule',
        metadata: {
          ...withoutCallerSuppliedSocialReviewTrust(metadataOf(concreteRecord)),
          auto_publish_after_review_window: false,
          auto_publish_armed: false,
        },
      })));
    }
    for (const record of prepared) {
      const problem = validateRecord?.(record, { requireSchedule: true }) || null;
      if (problem) return { records: prepared, saved: [], validation_problem: problem };
    }
    const saved = [];
    for (const record of prepared) saved.push(await saveScheduledPost(record));
    return { records: prepared, saved, validation_problem: null };
  };

  const deliverReviewNotification = async (ids = []) => {
    if (notificationGateway?.isDisabled?.()) {
      throw codedError('OWNER_NOTIFICATION_DISABLED', 'Owner notifications are disabled; autonomous scheduling remains blocked.');
    }
    const ownerId = String(getOwnerId?.() || '');
    let records = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const posts = await getScheduledPosts();
      const byId = new Map(posts.map(post => [String(post?.id || ''), post]));
      records = ids.map(id => byId.get(id));
      if (records.every(Boolean)) break;
      if (attempt < 5) await wait(250);
    }
    if (records.some(record => !record)) {
      throw codedError('REVIEW_RECORD_NOT_FOUND', 'One or more saved owner-review records were not found.');
    }
    if (records.some(record => record.source !== 'social_hermes' || record.metadata?.owner_review_required !== true)) {
      throw codedError('OWNER_REVIEW_RECORD_REQUIRED', 'Every notification target must be a saved Social Hermes owner-review record.');
    }
    const campaignIds = new Set(records.map(record => String(record.metadata?.campaign_id || record.id || '')));
    if (campaignIds.size !== 1) {
      throw codedError('OWNER_NOTIFICATION_CAMPAIGN_MISMATCH', 'A Telegram owner review notification may contain only one campaign.');
    }
    const mediaUrls = [];
    for (const record of records) {
      for (const item of (Array.isArray(record.media_items) ? record.media_items : [])) {
        const url = String(item?.url || item || '').trim();
        if (IMAGE_URL_RE.test(url) && !mediaUrls.includes(url)) mediaUrls.push(url);
      }
    }
    const delivery = await notificationGateway.deliver({
      ownerId,
      text: buildSocialOwnerReviewNotificationMessage(records, { publicBaseUrl: getPublicBaseUrl?.() || '' }),
      mediaUrls,
    });
    const sentAt = clockDate(clock).toISOString();
    const campaignDigest = socialOwnerReviewNotificationCampaignDigest(records);
    const updated = [];
    for (const record of records) {
      const notifiedRecord = {
        ...record,
        scheduled_at: record.metadata?.requested_scheduled_at || record.scheduled_at || null,
        metadata: {
          ...metadataOf(record),
          owner_notification_sent_at: sentAt,
          owner_notification_media_count: delivery.deliveredMediaCount,
          owner_notification_delivery: 'etsy_manager_telegram_bot_api',
          owner_notification_chat_id: delivery.textChatId,
          owner_notification_text_message_id: delivery.textMessageId,
          owner_notification_media_message_ids: delivery.mediaMessageIds,
          owner_notification_campaign_digest: campaignDigest,
          owner_notification_record_digest: socialOwnerReviewNotificationRecordDigest(record),
        },
      };
      const autoSchedule = ownerReviewAutoSchedule(notifiedRecord);
      updated.push(await updateScheduledPost(record.id, {
        status: autoSchedule ? 'scheduled' : 'draft',
        scheduled_at: autoSchedule?.scheduled_at || null,
        metadata: {
          ...notifiedRecord.metadata,
          auto_publish_after_review_window: Boolean(autoSchedule),
          ...(autoSchedule ? {
            requested_scheduled_at: autoSchedule.requested_at,
            owner_review_min_hours: Math.round(autoPublishLeadMinutes() / 60),
          } : {}),
        },
      }));
    }
    return { records: updated, count: updated.length };
  };

  return {
    deliverReviewNotification,
    expandRecord: expand,
    saveOwnerRequestedSchedule,
    saveReviewDrafts,
  };
}
