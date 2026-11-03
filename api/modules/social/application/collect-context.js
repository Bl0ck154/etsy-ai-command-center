import { classifyScheduledPost } from '../../../_scheduler.js';
import { summarizeSocialHermesSocialConfigs } from '../domain/platform-resolution.js';

export const SOCIAL_HERMES_CONTEXT_CACHE_TTL_SECONDS = 6 * 60 * 60;

export const SOCIAL_HERMES_ACTION_NAMES = Object.freeze(['context', 'refreshShopContext', 'researchPlan', 'contentOpportunities', 'revisionPlan', 'recordOwnerFeedback', 'mediaOptions', 'creativePlan', 'generateMedia', 'ideaPreview', 'canaryReadiness', 'saveReviewDraft', 'deliverReviewNotification', 'confirmReviewNotification', 'saveDraft', 'schedule', 'armExistingQueue', 'updateScheduled', 'deleteScheduled']);
const SCHEDULED_FIELDS = [
  'id', 'caption', 'platform', 'listing_id', 'listing_title', 'listing_image_url',
  'generated_image_url', 'custom_image_url', 'media_items', 'platform_caption_variants',
  'scheduled_at', 'status', 'source', 'created_by', 'metadata', 'approval_source',
  'created_at', 'updated_at', 'publish_method', 'post_url', 'publish_result',
  'last_error', 'approved_for_publish', 'approved_by', 'approved_at', 'queue_state',
  'is_overdue', 'is_stale', 'is_active_queue', 'overdue_ms', 'scheduled_at_ms',
];
const SECRET_KEY_RE = /(token|secret|password|cookie|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)/i;
const SECRET_VALUE_RE = /([?&](access_)?token=|[?&](api[_-]?key|secret|signature|sig)=|\bBearer\s+)/i;
const SOURCE_FIELDS = Object.freeze({
  listings: ['listings'],
  receipts: ['receipt_signals', 'stats'],
  reviews: ['reviews'],
});

function boundedText(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function redactSecrets(value) {
  if (typeof value === 'string') return SECRET_VALUE_RE.test(value) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY_RE.test(key) ? '[redacted]' : redactSecrets(item),
  ]));
}

function pendingSourceProvenance(source) {
  return {
    source,
    status: 'pending',
    current_fetch_complete: false,
    truncated: null,
    data_complete: false,
    data_truncated: null,
    data_available: false,
    used_last_known_good: false,
    fetched_at: null,
    data_observed_at: null,
  };
}

function contextHasSourceData(context = {}, source) {
  if (context?.source_provenance?.[source]?.data_complete === true) return true;
  if (context?.collection_diagnostics?.[source]?.truncated === false) return true;
  if (source === 'receipts') {
    return (Array.isArray(context.receipt_signals) && context.receipt_signals.length > 0)
      || context.stats !== null && context.stats !== undefined
      || (Array.isArray(context.listings) && context.listings.some(item => (
        item?.recent_orders !== undefined
        || item?.recent_units !== undefined
        || item?.recent_revenue_usd !== undefined
        || item?.last_order_at
      )));
  }
  const fields = SOURCE_FIELDS[source] || [];
  return fields.some(field => Array.isArray(context[field]) ? context[field].length > 0 : context[field] != null);
}

function receiptSignalsFromContext(context = {}) {
  if (Array.isArray(context.receipt_signals)) return context.receipt_signals;
  return (Array.isArray(context.listings) ? context.listings : []).map(item => ({
    listing_id: String(item?.listing_id || ''),
    recent_orders: item?.recent_orders ?? item?.performance_signals?.recent_orders_90d ?? null,
    recent_units: item?.recent_units ?? item?.performance_signals?.recent_units_90d ?? null,
    recent_revenue_usd: item?.recent_revenue_usd ?? item?.performance_signals?.recent_revenue_usd_90d ?? null,
    last_order_at: item?.last_order_at ?? item?.performance_signals?.last_order_at ?? null,
  })).filter(item => item.listing_id);
}

function applyReceiptSignals(listings = [], receiptSignals = [], receiptDataAvailable = false, missingSignalIsZero = false) {
  const signalsByListing = new Map((Array.isArray(receiptSignals) ? receiptSignals : [])
    .map(item => [String(item?.listing_id || ''), item])
    .filter(([listingId]) => listingId));
  return (Array.isArray(listings) ? listings : []).map(listing => {
    const signal = signalsByListing.get(String(listing?.listing_id || '')) || null;
    const signalAvailable = receiptDataAvailable && (Boolean(signal) || missingSignalIsZero);
    const recentOrders = signalAvailable ? Number(signal?.recent_orders || 0) : null;
    const recentUnits = signalAvailable ? Number(signal?.recent_units || 0) : null;
    const recentRevenue = signalAvailable ? Number(Number(signal?.recent_revenue_usd || 0).toFixed(2)) : null;
    const lastOrderAt = signalAvailable ? signal?.last_order_at || null : null;
    return {
      ...listing,
      recent_orders: recentOrders,
      recent_units: recentUnits,
      recent_revenue_usd: recentRevenue,
      last_order_at: lastOrderAt,
      performance_signals: {
        ...(listing?.performance_signals || {}),
        views: Number(listing?.views || 0),
        favorites: Number(listing?.num_favorers || 0),
        recent_orders_90d: recentOrders,
        recent_units_90d: recentUnits,
        recent_revenue_usd_90d: recentRevenue,
        last_order_at: lastOrderAt,
        receipts_data_complete: false,
        receipts_current_fetch_complete: false,
        receipts_data_observed_at: null,
      },
    };
  });
}

function sourceDataIsComplete(context = {}, source) {
  const provenance = context?.source_provenance?.[source];
  return provenance?.data_complete === true && provenance?.data_truncated === false;
}

function previousSourceDataIsComplete(context = {}, source) {
  if (sourceDataIsComplete(context, source)) return true;
  return !context?.source_provenance?.[source]
    && context?.collection_diagnostics?.[source]?.truncated === false;
}

function sourceComparisonReady(previous = {}, current = {}, source) {
  const provenance = current?.source_provenance?.[source];
  return provenance?.current_fetch_complete === true
    && provenance?.truncated === false
    && sourceDataIsComplete(current, source)
    && sourceDataIsComplete(previous, source);
}

export function mergeSocialHermesSourceSnapshots(previous = null, current = {}) {
  const merged = {
    ...current,
    source_provenance: { ...(current?.source_provenance || {}) },
  };
  for (const [source, fields] of Object.entries(SOURCE_FIELDS)) {
    const attempt = current?.source_provenance?.[source] || pendingSourceProvenance(source);
    if (attempt.current_fetch_complete === true && attempt.truncated === false) {
      merged.source_provenance[source] = {
        ...attempt,
        data_complete: true,
        data_truncated: false,
        data_available: true,
        used_last_known_good: false,
        data_observed_at: current.generated_at || attempt.fetched_at || new Date().toISOString(),
      };
      continue;
    }

    if (previous && contextHasSourceData(previous, source)) {
      for (const field of fields) {
        if (source === 'receipts' && field === 'receipt_signals') merged.receipt_signals = receiptSignalsFromContext(previous);
        else merged[field] = previous[field];
      }
      const previousProvenance = previous?.source_provenance?.[source] || {};
      const previousDataComplete = previousSourceDataIsComplete(previous, source);
      merged.source_provenance[source] = {
        ...attempt,
        data_complete: previousDataComplete,
        data_truncated: previousDataComplete ? false : null,
        data_available: true,
        used_last_known_good: true,
        data_observed_at: previousProvenance.data_observed_at || previous.generated_at || null,
        last_known_good_verified: previousDataComplete,
      };
    } else {
      for (const field of fields) merged[field] = Array.isArray(current?.[field]) ? [] : null;
      merged.source_provenance[source] = {
        ...attempt,
        data_complete: false,
        data_truncated: attempt.truncated === true ? true : null,
        data_available: false,
        used_last_known_good: false,
      };
    }
  }

  const receiptsComplete = sourceDataIsComplete(merged, 'receipts');
  const receiptsAvailable = merged?.source_provenance?.receipts?.data_available === true;
  const missingReceiptSignalIsZero = merged?.source_provenance?.receipts?.current_fetch_complete === true
    || merged?.source_provenance?.listings?.used_last_known_good === true;
  merged.receipt_signals = receiptSignalsFromContext(merged);
  merged.listings = applyReceiptSignals(merged.listings, merged.receipt_signals, receiptsAvailable, missingReceiptSignalIsZero);
  for (const listing of merged.listings) {
    if (!listing?.performance_signals) continue;
    listing.performance_signals.receipts_data_complete = receiptsComplete;
    listing.performance_signals.receipts_current_fetch_complete = merged?.source_provenance?.receipts?.current_fetch_complete === true;
    listing.performance_signals.receipts_data_observed_at = merged?.source_provenance?.receipts?.data_observed_at || null;
  }
  return merged;
}

function shopTotals(context = {}) {
  const listings = Array.isArray(context.listings) ? context.listings : [];
  const reviews = Array.isArray(context.reviews) ? context.reviews : [];
  return {
    active_listings: listings.length,
    favorites: listings.reduce((sum, item) => sum + (Number(item.num_favorers) || 0), 0),
    views: listings.reduce((sum, item) => sum + (Number(item.views) || 0), 0),
    recent_orders_90d: listings.reduce((sum, item) => sum + (Number(item.recent_orders) || 0), 0),
    recent_units_90d: listings.reduce((sum, item) => sum + (Number(item.recent_units) || 0), 0),
    recent_revenue_usd_90d: Number(listings.reduce((sum, item) => sum + (Number(item.recent_revenue_usd) || 0), 0).toFixed(2)),
    reviews_collected: reviews.length,
    five_star_reviews_collected: reviews.filter(item => Number(item.rating) === 5).length,
    reviews_with_photos: reviews.filter(item => item.has_photo).length,
  };
}

function numericDelta(current, previous) {
  const value = Number(current || 0) - Number(previous || 0);
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
}

export function buildSocialHermesSnapshotFacts(previous = null, current = {}) {
  const currentListings = Array.isArray(current?.listings) ? current.listings : [];
  const currentReviews = Array.isArray(current?.reviews) ? current.reviews : [];
  const previousListings = Array.isArray(previous?.listings) ? previous.listings : [];
  const previousReviews = Array.isArray(previous?.reviews) ? previous.reviews : [];
  const totals = shopTotals(current);
  if (!previous || !previous.generated_at) {
    const completeBaselineSources = ['listings', 'receipts', 'reviews']
      .filter(source => sourceDataIsComplete(current, source) && current?.source_provenance?.[source]?.current_fetch_complete === true);
    const baselineComplete = completeBaselineSources.length === 3;
    return {
      status: baselineComplete ? 'baseline_created' : 'baseline_incomplete',
      compared_to: null,
      totals,
      totals_delta: null,
      new_listings: [],
      updated_listings: [],
      listing_performance_changes: [],
      new_reviews: [],
      comparison_provenance: { listings: false, receipts: false, reviews: false },
      note: baselineComplete
        ? 'First complete factual snapshot only; no change claims are available yet.'
        : 'No previous snapshot exists and at least one current source is incomplete; no change claims are available.',
    };
  }
  const comparable = {
    listings: sourceComparisonReady(previous, current, 'listings'),
    receipts: sourceComparisonReady(previous, current, 'receipts'),
    reviews: sourceComparisonReady(previous, current, 'reviews'),
  };
  const priorByListing = new Map(previousListings.map(item => [String(item.listing_id || ''), item]).filter(([id]) => id));
  const priorReviewIds = new Set(previousReviews.map(item => String(item.review_id || '')).filter(Boolean));
  const newListings = [];
  const updatedListings = [];
  const performanceChanges = [];
  for (const listing of currentListings) {
    const id = String(listing.listing_id || '');
    if (!id) continue;
    const prior = priorByListing.get(id);
    if (!prior && comparable.listings) {
      newListings.push({ listing_id: id, title: listing.title || '', created_at: listing.created_at || null, updated_at: listing.updated_at || null });
      continue;
    }
    if (!prior) continue;
    if (comparable.listings && listing.updated_at && prior.updated_at && listing.updated_at !== prior.updated_at) {
      updatedListings.push({ listing_id: id, title: listing.title || '', previous_updated_at: prior.updated_at, updated_at: listing.updated_at });
    }
    const delta = {};
    if (comparable.listings) {
      delta.views = numericDelta(listing.views, prior.views);
      delta.favorites = numericDelta(listing.num_favorers, prior.num_favorers);
    }
    if (comparable.listings && comparable.receipts) {
      delta.recent_orders_90d = numericDelta(listing.recent_orders, prior.recent_orders);
      delta.recent_units_90d = numericDelta(listing.recent_units, prior.recent_units);
      delta.recent_revenue_usd_90d = numericDelta(listing.recent_revenue_usd, prior.recent_revenue_usd);
    }
    if (Object.values(delta).some(value => value !== 0)) performanceChanges.push({ listing_id: id, title: listing.title || '', delta });
  }
  const previousTotals = shopTotals(previous);
  const totalsSources = {
    active_listings: 'listings', favorites: 'listings', views: 'listings',
    recent_orders_90d: 'receipts', recent_units_90d: 'receipts', recent_revenue_usd_90d: 'receipts',
    reviews_collected: 'reviews', five_star_reviews_collected: 'reviews', reviews_with_photos: 'reviews',
  };
  const comparableCount = Object.values(comparable).filter(Boolean).length;
  return {
    status: comparableCount === 3 ? 'compared' : comparableCount > 0 ? 'partial_comparison' : 'comparison_unavailable',
    compared_to: previous.generated_at,
    totals,
    totals_delta: Object.fromEntries(Object.keys(totals).map(key => {
      const source = totalsSources[key];
      const ready = source === 'receipts' ? comparable.receipts && comparable.listings : comparable[source];
      return [key, ready ? numericDelta(totals[key], previousTotals[key]) : null];
    })),
    new_listings: newListings.slice(0, 200),
    updated_listings: updatedListings.slice(0, 200),
    listing_performance_changes: performanceChanges.slice(0, 500),
    new_reviews: comparable.reviews
      ? currentReviews.filter(review => !priorReviewIds.has(String(review.review_id || ''))).slice(0, 200)
      : [],
    comparison_provenance: comparable,
    note: comparableCount > 0
      ? 'Only complete, non-truncated source snapshots were compared. AI decides whether any verified fact is worth a social post.'
      : 'No source had two complete, non-truncated snapshots; factual deltas and new-item claims are unavailable.',
  };
}

function safeScheduledPost(post) {
  const safe = {};
  for (const key of SCHEDULED_FIELDS) safe[key] = post?.[key] ?? null;
  return { ...safe, ...classifyScheduledPost(post) };
}

export function buildSafeSocialHermesContextPayload({
  scheduledPosts = [],
  shopContext = null,
  socialConfigs = null,
  ownerTelegramUserId,
  publishGovernance = {},
} = {}) {
  const safeScheduledPosts = scheduledPosts.map(safeScheduledPost);
  const activeQueue = safeScheduledPosts.filter(post => post.is_active_queue);
  const staleOverdue = safeScheduledPosts.filter(post => post.is_stale);
  const drafts = safeScheduledPosts.filter(post => post.queue_state === 'draft');
  return {
    owner: { telegram_user_id: ownerTelegramUserId, approval_channel: 'telegram_dm' },
    bridge: {
      profile: 'social',
      assistant_name: 'Social Ops Hermes',
      phase: '2C',
      publish_governance: publishGovernance,
      publish_mode: publishGovernance.mode,
      autopublish_enabled: publishGovernance.autopublish_enabled,
      autopublish_env_enabled: publishGovernance.autopublish_env_enabled,
      real_publish_enabled: publishGovernance.real_publish_enabled,
      admin_approval_required: true,
      publish_now_available: publishGovernance.publish_now_available,
      direct_etsy_messages_available: false,
      direct_meta_write_available: false,
      browser_admin_automation_available: false,
      safe_actions: [...SOCIAL_HERMES_ACTION_NAMES],
      media_workflow_available: true,
      media_actions: ['mediaOptions', 'generateMedia', 'ideaPreview'],
      media_priority: ['existing_listing_image', 'approved_portfolio_image', 'generated_image', 'text_only'],
      telegram_preview_available: true,
    },
    shop_context: redactSecrets(shopContext) || null,
    social_config_summary: socialConfigs ? summarizeSocialHermesSocialConfigs(socialConfigs) : null,
    queue_summary: {
      active_queue: activeQueue.length,
      stale_overdue: staleOverdue.length,
      drafts: drafts.length,
      total_visible: safeScheduledPosts.length,
      autopublish_enabled: publishGovernance.autopublish_enabled,
      note: publishGovernance.autopublish_enabled
        ? 'Past scheduled draft/scheduled posts are stale_overdue, not active_queue; unapproved or legacy records remain inert until they pass the current AI readiness and owner opt-in gates.'
        : 'Past scheduled draft/scheduled posts are stale_overdue, not active_queue; autopublish is disabled, so they remain saved and unpublished until explicitly updated or deleted.',
    },
    active_queue_posts: activeQueue,
    stale_overdue_posts: staleOverdue,
    scheduled_posts: safeScheduledPosts,
  };
}

function normalizeOwnerFeedbackMemory(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const items = (Array.isArray(source.items) ? source.items : [])
    .filter(item => item && typeof item === 'object' && item.active !== false)
    .map(item => ({
      id: boundedText(item.id, 80),
      scope: ['listing', 'shop'].includes(boundedText(item.scope, 40).toLowerCase()) ? boundedText(item.scope, 40).toLowerCase() : '',
      listing_id: boundedText(item.listing_id, 100),
      preferences: Array.isArray(item.preferences) ? item.preferences.map(entry => boundedText(entry, 300)).filter(Boolean).slice(0, 12) : [],
      rationale: boundedText(item.rationale, 600),
      source_preview_id: boundedText(item.source_preview_id, 160),
      recorded_at: boundedText(item.recorded_at, 80),
      active: true,
    }))
    .filter(item => item.id && item.scope && item.preferences.length && (item.scope !== 'listing' || item.listing_id))
    .slice(-50);
  return { schema_version: 1, items, updated_at: boundedText(source.updated_at, 80) || null };
}

export function createSocialContextService({
  collectFactualContext,
  getScheduledPosts,
  loadValue,
  saveValue,
  getPublishGovernance,
  logger = console,
} = {}) {
  let memory = null;

  const refreshShopContext = async () => {
    const previous = await Promise.resolve().then(() => loadValue('social_autonomous_context')).catch(() => null);
    const fetched = await collectFactualContext();
    const context = mergeSocialHermesSourceSnapshots(previous, fetched);
    context.factual_changes = buildSocialHermesSnapshotFacts(previous, context);
    const safe = redactSecrets(context);
    memory = safe;
    await Promise.resolve()
      .then(() => saveValue('social_autonomous_context', safe, SOCIAL_HERMES_CONTEXT_CACHE_TTL_SECONDS))
      .catch(error => logger?.warn?.('[social-hermes-bridge] social_autonomous_context KV cache failed:', error?.message || error));
    return safe;
  };

  const getSafeContext = async ownerTelegramUserId => {
    const [scheduledPosts, shopContext, socialConfigs, autonomousContext, ownerFeedbackMemory] = await Promise.all([
      Promise.resolve().then(() => getScheduledPosts()).catch(() => []),
      Promise.resolve().then(() => loadValue('shop_operating_context')).catch(() => null),
      Promise.resolve().then(() => loadValue('social_configs')).catch(() => null),
      Promise.resolve().then(() => loadValue('social_autonomous_context')).catch(() => null),
      Promise.resolve().then(() => loadValue('social_owner_feedback_memory')).catch(() => null),
    ]);
    const payload = buildSafeSocialHermesContextPayload({
      scheduledPosts,
      shopContext,
      socialConfigs,
      ownerTelegramUserId,
      publishGovernance: getPublishGovernance?.() || {},
    });
    return {
      ...payload,
      autonomous_context: redactSecrets(autonomousContext || memory) || null,
      owner_feedback_memory: redactSecrets(normalizeOwnerFeedbackMemory(ownerFeedbackMemory)),
    };
  };

  return {
    getAutonomousContextMemory: () => memory,
    getSafeContext,
    refreshShopContext,
  };
}
