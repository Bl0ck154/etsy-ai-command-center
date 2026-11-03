import crypto from 'crypto';
import { normalizeSocialReviewCardDesign, socialReviewCardRenderSpecSha256 } from './_social-review-card.js';
import { socialAspectRatioFitsPlatform } from './_social-platform-capabilities.js';

export const SOCIAL_CREATIVE_COOLDOWN_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERSISTENT_MEDIA_PATH_RE = /^\/api\/social\?action=mediaAsset&id=shmedia_[a-f0-9]{24}$/i;

function cleanText(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanCaptionText(value, max = 1600) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function titleCaseMoment(value) {
  return cleanText(value, 80)
    .toLowerCase()
    .replace(/(^|[\s-])[a-z]/g, match => match.toUpperCase())
    .replace(/’S\b/g, '’s');
}

function normalizeMarketingMoment(context = {}, title = '') {
  return cleanText(
    context.source_opportunity?.moment
      || context.ai_opportunity_selection?.moment
      || context.ai_opportunity_moment,
    220,
  );
}

function conceptNameForMoment(occasion = '') {
  return `${titleCaseMoment(occasion)} Inspiration`;
}

function imageUrl(item = {}) {
  return cleanText(item.url || item.url_fullxfull || item.url_570xN || item.url_300x300, 2000);
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function withinCooldown(value, nowMs, days = SOCIAL_CREATIVE_COOLDOWN_DAYS) {
  const usedAt = timestamp(value);
  // Future scheduled uses must reserve the listing/media too. Ignoring them lets
  // a second plan repeat content that is already in the upcoming queue.
  return usedAt > 0 && (usedAt > nowMs || nowMs - usedAt < days * DAY_MS);
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function revisionMatchesListing(context = {}, listingId = '') {
  const campaignId = cleanText(
    context.revision_campaign_id
      || context.current_campaign_id
      || context.revision_of_preview_id,
    160,
  );
  const revisionListingId = cleanText(
    context.revision_listing_id
      || context.current_listing_id
      || context.previous_listing_id,
    100,
  );
  return Boolean(campaignId && revisionListingId && revisionListingId === cleanText(listingId, 100));
}

const COOLDOWN_RECORD_STATUSES = new Set(['published', 'scheduled', 'approved_scheduled', 'publishing', 'queued']);
const EXTERNAL_QUEUE_RECORD_STATUSES = new Set(['queued_external']);
const STALE_COOLDOWN_SKIP_STATUSES = new Set(['scheduled', 'draft']);

function recordCountsForCooldown(record = {}, nowMs = Date.now()) {
  const status = cleanText(record.status, 80).toLowerCase();
  const scheduledMs = timestamp(record.scheduled_at);
  const approved = status === 'approved_scheduled' || record.approved_for_publish === true;
  if (EXTERNAL_QUEUE_RECORD_STATUSES.has(status)) return false;
  if (scheduledMs > 0 && scheduledMs <= nowMs && !approved && STALE_COOLDOWN_SKIP_STATUSES.has(status)) return false;
  if (COOLDOWN_RECORD_STATUSES.has(status)) return true;
  if (approved) return true;
  // Legacy cooldown-history fixtures/records may predate explicit queue statuses.
  // Treat timestamped records without a status as historical uses, while modern
  // draft/scheduled records remain governed by their explicit status above.
  if (!status && (record.published_at || record.scheduled_at || record.created_at || record.updated_at)) return true;
  return false;
}

function normalizeMemory(memory = {}, records = [], now = Date.now()) {
  const referenceNowMs = timestamp(now) || Date.now();
  const listingUses = new Map();
  const mediaUses = new Map();
  const liveCooldownIds = new Set((Array.isArray(records) ? records : [])
    .filter(record => recordCountsForCooldown(record, referenceNowMs))
    .map(record => cleanText(record.id, 160))
    .filter(Boolean));
  const addListing = (id, usedAt) => {
    const key = cleanText(id, 100);
    const time = timestamp(usedAt);
    if (key && time > (listingUses.get(key) || 0)) listingUses.set(key, time);
  };
  const addMedia = (url, usedAt) => {
    const key = imageUrl({ url });
    const time = timestamp(usedAt);
    if (key && time > (mediaUses.get(key) || 0)) mediaUses.set(key, time);
  };
  const memoryEntryCounts = (item = {}) => {
    const status = cleanText(item.status, 80).toLowerCase();
    if (EXTERNAL_QUEUE_RECORD_STATUSES.has(status)) return false;
    if (COOLDOWN_RECORD_STATUSES.has(status)) return true;
    const postId = cleanText(item.post_id || item.record_id || item.id, 160);
    if (postId) {
      if (liveCooldownIds.has(postId)) return true;
      const usedAt = timestamp(item.used_at || item.created_at);
      return usedAt > 0 && usedAt <= referenceNowMs;
    }
    // Legacy memory without a post id predates cleanup metadata. Preserve past
    // uses as real history, but ignore orphaned future reservations: those came
    // from removed/test factory plans and otherwise block every candidate even
    // after the queue record has been deleted.
    const usedAt = timestamp(item.used_at || item.created_at);
    return usedAt > 0 && usedAt <= referenceNowMs;
  };

  for (const item of Array.isArray(memory.listings) ? memory.listings : []) {
    if (memoryEntryCounts(item)) addListing(item.listing_id || item.id, item.used_at || item.created_at);
  }
  for (const item of Array.isArray(memory.media) ? memory.media : []) {
    if (memoryEntryCounts(item)) addMedia(item.url, item.used_at || item.created_at);
  }
  for (const record of Array.isArray(records) ? records : []) {
    if (!recordCountsForCooldown(record, referenceNowMs)) continue;
    const usedAt = record.published_at || record.scheduled_at || record.created_at || record.updated_at;
    addListing(record.listing_id || record.metadata?.listing_id, usedAt);
    addMedia(record.listing_image_url, usedAt);
    addMedia(record.custom_image_url, usedAt);
    for (const item of Array.isArray(record.media_items) ? record.media_items : []) addMedia(item?.url || item, usedAt);
    for (const url of Array.isArray(record.metadata?.media_urls) ? record.metadata.media_urls : []) addMedia(url, usedAt);
  }
  return { listingUses, mediaUses };
}

export function buildSocialCreativeCooldownMemory(records = [], previous = {}, now = Date.now()) {
  const normalized = normalizeMemory(previous, records, now);
  return {
    version: 1,
    cooldown_days: SOCIAL_CREATIVE_COOLDOWN_DAYS,
    listings: [...normalized.listingUses].map(([listing_id, used_at]) => ({ listing_id, used_at: new Date(used_at).toISOString() })),
    media: [...normalized.mediaUses].map(([url, used_at]) => ({ url, used_at: new Date(used_at).toISOString() })),
  };
}
function trustworthyVisualSignal(visualAnalysis, url) {
  if (!visualAnalysis || visualAnalysis.available !== true || !cleanText(visualAnalysis.provider, 120)) return null;
  const signal = (Array.isArray(visualAnalysis.images) ? visualAnalysis.images : []).find(item => imageUrl(item) === url);
  if (!signal) return null;
  const quality = Number(signal.quality_score);
  const relevance = Number(signal.concept_relevance_score);
  if (!Number.isFinite(quality) && !Number.isFinite(relevance)) return null;
  return {
    quality: Number.isFinite(quality) ? Math.max(0, Math.min(100, quality)) : 50,
    relevance: Number.isFinite(relevance) ? Math.max(0, Math.min(100, relevance)) : 50,
    decision: cleanText(signal.social_use_decision, 40).toLowerCase(),
    rationale: cleanText(signal.rationale, 240),
    provider: cleanText(visualAnalysis.provider, 120),
  };
}

function requiresVisionBackedSocialHero(context = {}) {
  return context.require_vision_for_social_hero === true
    || context.social_hero_policy === 'vision_required'
    || context.hero_policy === 'vision_required';
}

export function rankSocialListingMedia({ listing = {}, concept = {}, cooldownMemory = {}, records = [], visualAnalysis = null, context = {}, now = Date.now() } = {}) {
  const nowMs = timestamp(now) || Date.now();
  const normalizedMemory = normalizeMemory(cooldownMemory, records, now);
  const revisingCurrentListing = revisionMatchesListing(context, listingIdentity(listing));
  const requireVisionBackedHero = requiresVisionBackedSocialHero(context);
  const rawImages = (Array.isArray(listing.media_items) && listing.media_items.length
    ? listing.media_items
    : (Array.isArray(listing.images) ? listing.images : []).concat((listing.image_urls || []).map(url => ({ url }))))
    .slice();
  if (listing.image_url && !rawImages.some(item => imageUrl(item) === listing.image_url)) {
    rawImages.unshift({
      id: 'listing_image_primary',
      url: listing.image_url,
      alt: listing.title || listing.listing_title || 'Etsy listing image',
      rank: 1,
    });
  }
  const seen = new Set();
  const ranked = [];

  for (const [index, raw] of rawImages.entries()) {
    const url = imageUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const width = Number(raw.width || raw.full_width) || null;
    const height = Number(raw.height || raw.full_height) || null;
    const pixels = width && height ? width * height : 0;
    const ratio = width && height ? width / height : null;
    const alt = cleanText(raw.alt || raw.alt_text, 240);
    const sourceRank = Number(raw.rank) || index + 1;
    const lastUsed = normalizedMemory.mediaUses.get(url) || 0;
    const cooldownBlocked = !revisingCurrentListing && withinCooldown(lastUsed, nowMs);
    const visual = trustworthyVisualSignal(visualAnalysis, url);
    const heroEligible = !cooldownBlocked && (!requireVisionBackedHero || visual?.decision === 'hero');
    const supportEligible = !cooldownBlocked && (!requireVisionBackedHero || ['hero', 'support'].includes(visual?.decision));
    let score = 0;
    const reasons = [];

    if (pixels >= 2_000_000) { score += 24; reasons.push('high-resolution source'); }
    else if (pixels >= 1_000_000) { score += 18; reasons.push('adequate social resolution'); }
    else if (pixels > 0) { score += 7; reasons.push('known but limited resolution'); }
    else reasons.push('dimensions unavailable');

    if (ratio && ratio >= 0.72 && ratio <= 0.86) { score += 20; reasons.push('portrait crop is close to 4:5'); }
    else if (ratio && ratio >= 0.9 && ratio <= 1.1) { score += 14; reasons.push('square crop is broadly reusable'); }
    else if (ratio) { score += 5; reasons.push('crop may need platform adaptation'); }
    else reasons.push('aspect ratio unavailable');

    if (alt.length >= 24) { score += 13; reasons.push('descriptive listing alt metadata'); }
    else if (alt) { score += 6; reasons.push('limited listing alt metadata'); }
    else reasons.push('no descriptive alt metadata');

    // Etsy rank is a weak merchandising signal, never the selection algorithm.
    const rankSignal = Math.max(0, 5 - Math.min(sourceRank, 5));
    score += rankSignal;
    if (rankSignal) reasons.push('seller ordering used as a weak signal');

    if (visual) {
      score += Math.round(visual.quality * 0.22 + visual.relevance * 0.28);
      reasons.push(visual.rationale || 'real visual-analysis quality and concept relevance');
    }
    if (requireVisionBackedHero && !visual) {
      reasons.push('not eligible as autonomous social hero until AI visual analysis exists or a persistent generated hero is used');
    }
    if (cooldownBlocked) reasons.push(`excluded: concrete media URL used within ${SOCIAL_CREATIVE_COOLDOWN_DAYS} days`);

    ranked.push({
      id: cleanText(raw.id || raw.listing_image_id || `listing_image_${index + 1}`, 120),
      url,
      source: 'listing_image',
      source_rank: sourceRank,
      width,
      height,
      alt,
      score,
      eligible: !cooldownBlocked,
      social_hero_eligible: heroEligible,
      social_support_eligible: supportEligible,
      last_used_at: lastUsed ? new Date(lastUsed).toISOString() : null,
      rationale: reasons,
      visual_analysis: visual ? { used: true, provider: visual.provider } : { used: false },
    });
  }

  ranked.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.url.localeCompare(b.url));
  return {
    confidence: ranked.some(item => item.visual_analysis.used) ? 'visual_analysis_supported' : 'metadata_only_low',
    visual_analysis_used: ranked.some(item => item.visual_analysis.used),
    honesty_note: ranked.some(item => item.visual_analysis.used)
      ? 'Ranking combines declared visual-analysis output with listing metadata.'
      : 'Pixels were not analyzed. Ranking uses only dimensions, aspect ratio, alt text, seller rank as a weak signal, and cooldown history.',
    concept: cleanText(concept.name || concept.hook, 200),
    social_hero_policy: requireVisionBackedHero ? 'vision_analysis_or_persistent_generated_hero_required' : 'metadata_allowed_with_honesty_note',
    ranked,
  };
}

export function isPersistentSocialMediaUrl(value, publicBaseUrl = '') {
  try {
    const url = new URL(String(value || ''), publicBaseUrl || 'https://etsy-manager.invalid');
    if (publicBaseUrl && url.origin !== new URL(publicBaseUrl).origin) return false;
    return PERSISTENT_MEDIA_PATH_RE.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

function listingIdentity(listing = {}) {
  return cleanText(listing.listing_id || listing.id, 100);
}

function listingTitle(listing = {}) {
  return cleanText(listing.title || listing.listing_title || '', 180);
}

function safeAiCopy(value = '', _listing = {}, max = 220) {
  return cleanText(value, max);
}

function listingMediaCount(listing = {}) {
  if (Array.isArray(listing.media_items)) return listing.media_items.filter(item => imageUrl(item)).length;
  if (Array.isArray(listing.images)) return listing.images.filter(item => imageUrl(item)).length;
  if (Array.isArray(listing.image_urls)) return listing.image_urls.filter(Boolean).length;
  return listing.image_url ? 1 : 0;
}

function validListingUnderstanding(value = {}) {
  return value
    && typeof value === 'object'
    && value.available !== false
    && [
      value.what_is_sold,
      value.buyer_use_case,
      value.marketing_angle,
      value.caption_body,
      value.visual_brief,
    ].some(item => cleanText(item, 40));
}

function listingUnderstandingFor(listing = {}, context = {}) {
  if (validListingUnderstanding(context.listing_understanding)) return context.listing_understanding;
  if (validListingUnderstanding(listing.listing_understanding)) return listing.listing_understanding;
  return null;
}

function campaignFitFor(listing = {}) {
  const fit = listing.listing_campaign_fit || listing.campaign_fit;
  return fit && typeof fit === 'object' ? fit : null;
}

function campaignFitAllowsSelection(listing = {}) {
  const fit = campaignFitFor(listing);
  if (!fit) return false;
  const decision = cleanText(fit.decision || fit.fit || fit.status, 80).toLowerCase();
  if (fit.should_use_listing === false) return false;
  return ['strong_fit', 'acceptable_fit'].includes(decision);
}
function requiresAiListingUnderstanding(context = {}) {
  return context.require_ai_listing_understanding === true
    || context.ai_listing_understanding_required === true
    || context.social_factory_path === true
    || cleanText(context.factory_path, 120) === 'social_autonomous_content_factory';
}

function requiresAiMediaStrategy(context = {}) {
  return context.require_ai_media_strategy === true
    || context.ai_media_strategy_required === true
    || context.social_media_strategy_required === true
    || requiresAiListingUnderstanding(context);
}

function normalizePlatformMediaVariants(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const platform of ['instagram', 'facebook', 'pinterest', 'tiktok']) {
    const value = source[platform];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    out[platform] = {
      format: cleanText(value.format, 40).toLowerCase(),
      frame_ids: understandingList(value.frame_ids, 12, 80),
      buyer_evidence_frame_ids: understandingList(value.buyer_evidence_frame_ids, 12, 80),
    };
  }
  return out;
}

export function buildSocialCreativePatternContext(records = [], { limit = 8 } = {}) {
  const campaigns = new Map();
  const source = (Array.isArray(records) ? records : [])
    .filter(record => {
      const provenance = `${record?.source || ''} ${record?.created_by || ''}`.toLowerCase();
      return provenance.includes('social_hermes') || provenance.includes('autonomous_content_factory');
    })
    .sort((a, b) => timestamp(b.created_at || b.updated_at) - timestamp(a.created_at || a.updated_at));
  for (const record of source) {
    const metadata = record?.metadata && typeof record.metadata === 'object' ? record.metadata : {};
    const campaignId = cleanText(metadata.campaign_id || metadata.variant_of || record.id, 160);
    if (!campaignId) continue;
    if (!campaigns.has(campaignId)) {
      campaigns.set(campaignId, {
        campaign_id: campaignId,
        created_at: record.created_at || record.updated_at || null,
        creative_concept: cleanText(metadata.creative_concept, 180),
        variants: [],
      });
    }
    const strategy = metadata.media_strategy && typeof metadata.media_strategy === 'object'
      ? metadata.media_strategy
      : {};
    const platform = cleanText(record.platform, 40).toLowerCase();
    const variant = strategy.platform_variants?.[platform] || {};
    const frameById = new Map((Array.isArray(strategy.frames) ? strategy.frames : [])
      .map(frame => [cleanText(frame?.id, 80), frame])
      .filter(([id]) => id));
    const selectedFrameIds = Array.isArray(variant.frame_ids) ? variant.frame_ids : [];
    const selectedFrames = selectedFrameIds
      .map(id => frameById.get(cleanText(id, 80)))
      .filter(Boolean);
    const orderedFrames = selectedFrames.map((frame, index) => ({
      position: index + 1,
      frame_id: cleanText(frame?.id, 80),
      source: cleanText(frame?.source, 40).toLowerCase(),
      role: cleanText(frame?.role, 120),
      communication_goal: cleanText(frame?.communication_goal, 240),
    }));
    campaigns.get(campaignId).variants.push({
      platform,
      format: cleanText(variant.format || (record.metadata?.instagram_carousel ? 'carousel' : ((record.media_items || []).length > 1 ? 'multi_image' : 'single')), 40),
      media_count: Array.isArray(record.media_items) ? record.media_items.length : 0,
      selected_frame_count: selectedFrameIds.length || null,
      selected_frame_roles: [...new Set(selectedFrames.map(frame => cleanText(frame?.role, 120)).filter(Boolean))],
      selected_communication_goals: [...new Set(selectedFrames.map(frame => cleanText(frame?.communication_goal, 240)).filter(Boolean))],
      ordered_frames: orderedFrames,
      source_sequence: orderedFrames.map(frame => frame.source).filter(Boolean),
      review_card_positions: orderedFrames
        .filter(frame => frame.source === 'review_card')
        .map(frame => frame.position),
      aspect_ratios: [...new Set(selectedFrameIds
        .map(id => cleanText(frameById.get(cleanText(id, 80))?.aspect_ratio, 20))
        .filter(Boolean))],
    });
    if (campaigns.size >= Math.max(1, Math.min(20, Number(limit) || 8))) {
      const complete = [...campaigns.values()].filter(item => item.variants.length >= 2);
      if (complete.length >= Math.max(1, Math.min(20, Number(limit) || 8))) break;
    }
  }
  return {
    source: 'saved_social_hermes_queue_facts',
    recent_campaigns: [...campaigns.values()].slice(0, Math.max(1, Math.min(20, Number(limit) || 8))),
  };
}

function normalizeAcceptedAssetDecisions(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).map(item => ({
    brief_id: cleanText(item?.brief_id || item?.frame_id, 80),
    decision: cleanText(item?.decision, 40).toLowerCase(),
    rationale: cleanText(item?.rationale, 500),
  })).filter(item => item.brief_id);
}

function normalizeMediaStrategy(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const framesRaw = Array.isArray(raw.frames) ? raw.frames : [];
  const frames = framesRaw.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return {};
    const rank = Number(item.reference_media_rank);
    return {
      id: cleanText(item.id, 80),
      role: cleanText(item.role, 120),
      communication_goal: cleanText(item.communication_goal, 420),
      visible_buyer_evidence: cleanText(item.visible_buyer_evidence, 500),
      evidence_strength: cleanText(item.evidence_strength, 40).toLowerCase(),
      source: cleanText(item.source, 80).toLowerCase(),
      image_model: cleanText(item.image_model || item.model, 180),
      prompt: cleanText(item.prompt, 1800),
      rationale: cleanText(item.rationale, 500),
      reference_policy: cleanText(item.reference_policy, 220),
      reference_required: typeof item.reference_required === 'boolean' ? item.reference_required : null,
      reference_media_rank: Number.isInteger(rank) && rank > 0 ? rank : null,
      review_id: cleanText(item.review_id, 120) || null,
      context_note: cleanText(item.context_note, 180),
      review_card_design: normalizeSocialReviewCardDesign(item.review_card_design),
      aspect_ratio: cleanText(item.aspect_ratio, 20),
      crop_focus: cleanText(item.crop_focus, 20).toLowerCase(),
    };
  });
  const count = Number(raw.target_media_count);
  const out = {
    format: cleanText(raw.format, 80).toLowerCase(),
    target_media_count: Number.isInteger(count) ? count : null,
    listing_media_policy: cleanText(raw.listing_media_policy, 260),
    reference_policy: cleanText(raw.reference_policy, 260),
    campaign_offer_focus: cleanText(raw.campaign_offer_focus, 700),
    lead_proof_plan: cleanText(raw.lead_proof_plan, 900),
    required_visible_evidence: cleanText(raw.required_visible_evidence, 700),
    frame_count_rationale: cleanText(raw.frame_count_rationale, 700),
    rationale: cleanText(raw.rationale, 900),
    frames,
    platform_variants: normalizePlatformMediaVariants(raw.platform_variants),
    accepted_asset_decisions: normalizeAcceptedAssetDecisions(raw.accepted_asset_decisions),
  };
  if (!out.format && !out.target_media_count && !out.frames.length && !out.listing_media_policy && !out.reference_policy) return null;
  return out;
}

function validMediaStrategy(strategy, platforms = []) {
  if (!strategy || !Array.isArray(strategy.frames) || strategy.frames.length < 1 || strategy.frames.length > 7) return false;
  if (strategy.format === 'single' && strategy.frames.length !== 1) return false;
  if (strategy.format === 'carousel' && strategy.frames.length < 2) return false;
  if (strategy.format === 'multi_image' && strategy.frames.length < 2) return false;
  if (!['single', 'carousel', 'multi_image'].includes(strategy.format)) return false;
  if (!Number.isInteger(strategy.target_media_count) || strategy.target_media_count !== strategy.frames.length) return false;
  const ids = strategy.frames.map(frame => frame?.id).filter(Boolean);
  if (ids.length !== strategy.frames.length || new Set(ids).size !== ids.length) return false;
  const framesValid = strategy.frames.every(frame => {
    if (!frame?.id || !frame.role || !frame.rationale) return false;
    if (frame.source === 'listing_image') return Number.isInteger(frame.reference_media_rank) && frame.reference_media_rank > 0;
    if (frame.source === 'review_card') return Boolean(frame.review_id)
      && Boolean(frame.context_note)
      && Boolean(frame.review_card_design)
      && ['1:1', '4:5', '2:3', '3:4', '9:16', '16:9'].includes(frame.aspect_ratio);
    if (frame.source !== 'generated_image' || !frame.prompt || typeof frame.reference_required !== 'boolean' || !['1:1', '4:5', '2:3', '3:4', '9:16', '16:9'].includes(frame.aspect_ratio)) return false;
    return frame.reference_required === false || (Number.isInteger(frame.reference_media_rank) && frame.reference_media_rank > 0);
  });
  if (!framesValid) return false;
  const requiredPlatforms = [...new Set((platforms || []).map(item => cleanText(item, 40).toLowerCase()).filter(item => ['instagram', 'facebook', 'pinterest', 'tiktok'].includes(item)))];
  const frameIds = new Set(strategy.frames.map(frame => frame.id));
  const variantsValid = requiredPlatforms.every(platform => {
    const variant = strategy.platform_variants?.[platform];
    if (!variant || !variant.frame_ids?.length || !variant.frame_ids.every(id => frameIds.has(id))) return false;
    if (new Set(variant.frame_ids).size !== variant.frame_ids.length) return false;
    if (platform === 'pinterest') return variant.format === 'single' && variant.frame_ids.length === 1;
    if (platform === 'instagram') {
      return variant.format === 'single'
        ? variant.frame_ids.length === 1
        : variant.format === 'carousel' && variant.frame_ids.length >= 2;
    }
    if (platform === 'facebook') {
      return variant.format === 'single'
        ? variant.frame_ids.length === 1
        : variant.format === 'multi_image' && variant.frame_ids.length >= 2;
    }
    return variant.format === 'single' && variant.frame_ids.length === 1;
  });
  if (!variantsValid) return false;
  const selectedFrameIds = new Set(requiredPlatforms.flatMap(platform => strategy.platform_variants[platform].frame_ids));
  return strategy.frames.every(frame => selectedFrameIds.has(frame.id));
}

function mediaStrategyFor(context = {}, concept = {}) {
  return normalizeMediaStrategy(
    context.media_strategy
      || context.social_media_strategy
      || context.visual_media_strategy
      || concept.listing_understanding?.media_strategy
      || concept.listing_understanding?.social_media_strategy
      || concept.listing_understanding?.visual_media_strategy,
  );
}

function requiredStoryMediaCount(context = {}, concept = {}, platform = '') {
  const explicit = Number(context.minimum_story_media_count || context.min_story_media_count || 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.min(7, Math.round(explicit)));
  const strategy = mediaStrategyFor(context, concept);
  const platformVariant = platform ? strategy?.platform_variants?.[platform] : null;
  if (platformVariant?.format === 'carousel') return Math.max(2, Math.min(7, platformVariant.frame_ids.length));
  if (platformVariant?.format === 'single') return 1;
  if (platformVariant?.format === 'multi_image') return Math.max(2, Math.min(7, platformVariant.frame_ids.length));
  if (strategy?.format === 'carousel') {
    return Math.max(2, Math.min(7, strategy.frames.length || strategy.target_media_count || 2));
  }
  return 0;
}

function understandingList(value, limit = 8, max = 80) {
  return (Array.isArray(value) ? value : [])
    .map(item => cleanText(item, max))
    .filter(Boolean)
    .slice(0, limit);
}

function compactListingCandidate(listing = {}) {
  const mediaItems = Array.isArray(listing.media_items)
    ? listing.media_items
    : (Array.isArray(listing.images) ? listing.images : []).concat((listing.image_urls || []).map(url => ({ url })));
  return {
    listing_id: listingIdentity(listing),
    title: listingTitle(listing),
    description: cleanText(listing.description || listing.description_plain || listing.summary, 4000),
    url: cleanText(listing.url || listing.listing_url, 1000),
    image_url: imageUrl({ url: listing.image_url || imageUrl(mediaItems[0] || {}) }),
    media_items: mediaItems.slice(0, 10),
    tags: Array.isArray(listing.tags) ? listing.tags.slice(0, 13).map(tag => cleanText(tag, 60)).filter(Boolean) : [],
    listing_type: cleanText(listing.listing_type, 80),
    taxonomy_id: listing.taxonomy_id || null,
    quantity: listing.quantity ?? null,
    created_at: cleanText(listing.created_at, 80) || null,
    updated_at: cleanText(listing.updated_at, 80) || null,
    num_favorers: Number(listing.num_favorers || listing.favorers || 0) || 0,
    views: Number(listing.views || listing.view_count || 0) || 0,
    recent_orders: nullableNumber(listing.recent_orders ?? listing.recent_order_count ?? listing.orders_90d ?? listing.performance_signals?.recent_orders_90d),
    recent_units: nullableNumber(listing.recent_units ?? listing.units_90d ?? listing.performance_signals?.recent_units_90d),
    recent_revenue_usd: nullableNumber(listing.recent_revenue_usd ?? listing.revenue_90d ?? listing.performance_signals?.recent_revenue_usd_90d),
    last_order_at: cleanText(listing.last_order_at || listing.performance_signals?.last_order_at, 80) || null,
    performance_signals: listing.performance_signals && typeof listing.performance_signals === 'object'
      ? {
        views: Number(listing.performance_signals.views || listing.views || 0) || 0,
        favorites: Number(listing.performance_signals.favorites || listing.num_favorers || 0) || 0,
        recent_orders_90d: nullableNumber(listing.performance_signals.recent_orders_90d ?? listing.recent_orders),
        recent_units_90d: nullableNumber(listing.performance_signals.recent_units_90d ?? listing.recent_units),
        recent_revenue_usd_90d: nullableNumber(listing.performance_signals.recent_revenue_usd_90d ?? listing.recent_revenue_usd),
        last_order_at: cleanText(listing.performance_signals.last_order_at || listing.last_order_at, 80) || null,
        receipts_data_complete: listing.performance_signals.receipts_data_complete === true,
        receipts_current_fetch_complete: listing.performance_signals.receipts_current_fetch_complete === true,
        receipts_data_observed_at: cleanText(listing.performance_signals.receipts_data_observed_at, 80) || null,
      }
      : null,
  };
}

function compactReviewEvidence(review = {}) {
  const reviewId = cleanText(review.review_id || review.id, 120);
  const listingId = cleanText(review.listing_id, 100);
  const text = cleanText(review.text || review.review || review.text_preview, 2000);
  return {
    review_id: reviewId,
    listing_id: listingId || null,
    rating: Number(review.rating || review.stars) || null,
    text,
    text_preview: cleanText(review.text_preview || text, 220),
    has_photo: Boolean(review.has_photo || review.review_image_url || review.image_url),
    review_image_url: cleanText(review.review_image_url || review.image_url, 1000) || null,
    created_at: cleanText(review.created_at, 80) || null,
  };
}

function queueHasCurrentFuture(records = [], nowMs) {
  return (Array.isArray(records) ? records : []).some(record => {
    const status = cleanText(record.status, 80).toLowerCase();
    if (!['draft', 'scheduled', 'approved_scheduled', 'publishing', 'queued', 'queued_external'].includes(status)) return false;
    const scheduledAt = timestamp(record.scheduled_at || record.created_at || record.updated_at);
    return !scheduledAt || scheduledAt >= nowMs - DAY_MS;
  });
}

export function suggestSocialContentOpportunities({
  autonomousContext = {},
  listings = null,
  reviews = null,
  discounts = null,
  records = [],
  cooldownMemory = {},
  platforms = [],
  now = Date.now(),
  windowDays = 30,
  limit = 5,
  sourceBasis = 'stored_shop_context',
} = {}) {
  const nowMs = timestamp(now) || Date.now();
  const normalizedMemory = normalizeMemory(cooldownMemory, records, nowMs);
  const sourceListings = Array.isArray(listings) ? listings : (Array.isArray(autonomousContext.listings) ? autonomousContext.listings : []);
  const sourceReviews = Array.isArray(reviews) ? reviews : (Array.isArray(autonomousContext.reviews) ? autonomousContext.reviews : []);
  const sourceDiscounts = Array.isArray(discounts) ? discounts : (Array.isArray(autonomousContext.discounts) ? autonomousContext.discounts : []);
  const safePlatforms = [...new Set((platforms || []).map(item => cleanText(item, 40).toLowerCase()).filter(Boolean))].filter(platform => platform !== 'all');
  const excludedByCooldown = [];
  const listingCandidates = sourceListings.flatMap(listing => {
    const listingId = listingIdentity(listing);
    if (!listingId) return [];
    const lastUsed = normalizedMemory.listingUses.get(listingId) || 0;
    if (withinCooldown(lastUsed, nowMs)) {
      excludedByCooldown.push({ listing_id: listingId, last_used_at: new Date(lastUsed).toISOString() });
      return [];
    }
    return [{
      ...compactListingCandidate(listing),
      last_used_at: lastUsed ? new Date(lastUsed).toISOString() : null,
      operational_facts: {
        media_count: listingMediaCount(listing),
        cooldown_blocked: false,
      },
    }];
  });
  const reviewEvidence = sourceReviews
    .map(compactReviewEvidence)
    .filter(review => review.review_id && (review.text || review.has_photo));
  const hasCurrentQueue = queueHasCurrentFuture(records, nowMs);
  const opportunities = listingCandidates.length
    ? [{
      id: `opportunity_${crypto.createHash('sha256').update(`shop_facts\0${listingCandidates.map(item => item.listing_id).join(',')}`).digest('hex').slice(0, 12)}`,
      type: 'shop_facts_for_ai_review',
      priority: 0,
      moment: '',
      reason: 'Unranked Etsy shop facts for AI semantic opportunity selection.',
      suggested_platforms: safePlatforms,
      guardrails: [
        'Read-only facts. AI must decide whether any listing, review, performance change, queue gap, researched event, or evergreen angle deserves a post.',
        'Do not save, schedule, generate, or publish until creativePlan and owner review succeed.',
      ],
      context: {
        occasion: '',
        audience: '',
        campaign_context: '',
        source_opportunity_type: 'shop_facts_for_ai_review',
      },
      listing_candidates: listingCandidates,
    }]
    : [];

  return {
    schema_version: 1,
    generated_at: new Date(nowMs).toISOString(),
    status: opportunities.length ? 'ready' : 'blocked_no_opportunities',
    external_research_used: false,
    research_owner: 'social_hermes',
    source_basis: cleanText(sourceBasis, 80) || 'stored_shop_context',
    configured_platforms: safePlatforms,
    honesty_note: 'These are unranked Etsy AI Command Center facts only. External AI must decide what is post-worthy and may use supplied web research; local code made no marketing match or product choice.',
    window_days: windowDays,
    source_counts: {
      listings: sourceListings.length,
      reviews: sourceReviews.length,
      scheduled_records: Array.isArray(records) ? records.length : 0,
      discounts_available_not_used: sourceDiscounts.length,
    },
    source_provenance: autonomousContext.source_provenance && typeof autonomousContext.source_provenance === 'object'
      ? autonomousContext.source_provenance
      : null,
    review_evidence: reviewEvidence,
    factual_changes: autonomousContext.factual_changes && typeof autonomousContext.factual_changes === 'object'
      ? autonomousContext.factual_changes
      : null,
    operational_exclusions: {
      cooldown_days: SOCIAL_CREATIVE_COOLDOWN_DAYS,
      cooldown_blocked_listings: excludedByCooldown,
    },
    queue: {
      has_current_or_future_item: hasCurrentQueue,
      note: 'This is only a planning signal; queue mutations still require schedule/save actions and owner approval.',
    },
    opportunities,
    recommended_next_action: 'External AI must select a grounded opportunity from these complete facts, then Social Hermes should call creativePlan, generate/persist any required media, and request owner review.',
  };
}

function makeConcept(listing, context = {}) {
  const title = cleanText(listing.title || listing.listing_title || 'this Etsy creation', 100);
  const understanding = listingUnderstandingFor(listing, context);
  if (understanding) {
    const what = cleanText(understanding.what_is_sold || title, 160);
    const angle = safeAiCopy(understanding.marketing_angle, listing, 160)
      || safeAiCopy(understanding.product_category, listing, 160)
      || safeAiCopy(what, listing, 160)
      || 'listing-aware product story';
    const hook = safeAiCopy(understanding.marketing_angle, listing, 220)
      || safeAiCopy(understanding.buyer_use_case, listing, 220)
      || safeAiCopy(what, listing, 220)
      || `A useful way to show this Etsy listing in the buyer's real context`;
    return {
      name: angle,
      hook,
      audience: cleanText(understanding.target_buyer || context.audience || 'people likely to want this Etsy listing', 180),
      occasion: normalizeMarketingMoment(context, title) || null,
      title,
      objective: 'Write a useful social post based on AI listing understanding, without unsupported listing claims.',
      listing_understanding: {
        ...understanding,
        hashtags: understandingList(understanding.hashtags, 8, 40),
        unsupported_claims_to_avoid: understandingList(understanding.unsupported_claims_to_avoid, 10, 160),
        unknowns: understandingList(understanding.unknowns, 10, 160),
      },
    };
  }
  const occasion = normalizeMarketingMoment(context, title);
  const audience = cleanText(context.audience || 'people looking for a thoughtful, creative option', 160);
  const contextAngle = cleanText(context.ai_opportunity_reason || context.campaign_context || context.reason, 180);
  const angle = occasion ? conceptNameForMoment(occasion) : (contextAngle || 'AI-required Etsy listing story');
  const hook = contextAngle || (occasion
    ? `${titleCaseMoment(occasion)} campaign copy needs AI listing understanding before scheduling`
    : 'This listing needs AI understanding before autonomous campaign copy is created');
  return {
    name: angle,
    hook,
    audience,
    occasion: occasion || null,
    title,
    objective: 'Write a useful social post about the buyer moment, not a copied listing title.',
  };
}

function generationDecision(ranking, providerConfigured, context = {}, concept = {}) {
  const mediaStrategy = mediaStrategyFor(context, concept);
  const strategyFrames = Array.isArray(mediaStrategy?.frames) ? mediaStrategy.frames : [];
  if (!strategyFrames.length) return {
    use_generation: false,
    materially_improves: false,
    status: 'blocked_ai_media_strategy_required',
    rationale: 'AI media strategy is required before deciding whether to use listing, generated, or rendered media.',
  };
  const generatedFrames = strategyFrames.filter(frame => frame.source === 'generated_image');
  const renderedFrames = strategyFrames.filter(frame => frame.source === 'review_card');
  if (generatedFrames.length && !providerConfigured) return {
    use_generation: false,
    materially_improves: true,
    status: 'blocked_provider_unconfigured',
    rationale: `AI media strategy selected ${generatedFrames.length} generated frame${generatedFrames.length === 1 ? '' : 's'}, but no compatible image provider is configured.`,
  };
  const plannedCreationCount = generatedFrames.length + renderedFrames.length;
  return {
    use_generation: plannedCreationCount > 0,
    materially_improves: plannedCreationCount > 0,
    status: plannedCreationCount > 0 ? 'briefs_required' : 'not_needed',
    rationale: plannedCreationCount > 0
      ? `AI media strategy selected ${generatedFrames.length} generated and ${renderedFrames.length} server-rendered frame${plannedCreationCount === 1 ? '' : 's'}; local code does not add optional media.`
      : 'AI media strategy selected listing media only; local code does not add generated support frames.',
  };
}

function referenceImageForFrame(frame = {}, ranking = {}, listing = {}) {
  if (frame.reference_required !== true) return '';
  const ranked = Array.isArray(ranking.ranked) ? ranking.ranked : [];
  const eligible = ranked.filter(item => item.eligible);
  if (frame.reference_media_rank) {
    const byRank = eligible.find(item => Number(item.source_rank) === Number(frame.reference_media_rank))
      || ranked.find(item => Number(item.source_rank) === Number(frame.reference_media_rank));
    const rankedUrl = imageUrl(byRank || {});
    if (rankedUrl) return rankedUrl;
  }
  return '';
}

function generatedBriefsFromStrategy(mediaStrategy, concept, listing, ranking = {}, context = {}) {
  const frames = Array.isArray(mediaStrategy?.frames) ? mediaStrategy.frames : [];
  if (!frames.length) return [];
  const identity = cleanText(listing.title || listing.listing_title, 140);
  const understanding = concept.listing_understanding || {};
  const visualBrief = cleanText(understanding.visual_brief, 700);
  const unsupported = understandingList(understanding.unsupported_claims_to_avoid, 8, 140);
  return frames.flatMap((frame, index) => {
    if (frame.source === 'review_card') {
      const selectedReview = context.selected_review && typeof context.selected_review === 'object'
        ? context.selected_review
        : null;
      if (!selectedReview || cleanText(selectedReview.review_id, 120) !== frame.review_id) return [];
      const shopName = cleanText(context.review_card_shop_name, 80);
      const reviewCardDesign = normalizeSocialReviewCardDesign(frame.review_card_design);
      if (!reviewCardDesign) return [];
      const heading = reviewCardDesign.heading;
      return [{
        id: cleanText(frame.id || `review_card_${index + 1}`, 80),
        role: cleanText(frame.role || 'customer_review', 120),
        aspect_ratio: frame.aspect_ratio,
        renderer: 'review_card',
        context_note: cleanText(frame.context_note, 180),
        shop_name: shopName,
        heading,
        review_card_design: reviewCardDesign,
        render_spec_sha256: socialReviewCardRenderSpecSha256({
          review: {
            review_id: frame.review_id,
            listing_id: cleanText(selectedReview.listing_id, 100) || null,
            exact_quote: cleanText(selectedReview.exact_quote, 900),
            rating: Number(selectedReview.rating) || null,
            listing_title: identity,
          },
          shopName,
          heading,
          contextNote: cleanText(frame.context_note, 180),
          aspectRatio: frame.aspect_ratio,
          design: reviewCardDesign,
        }),
        review_evidence: {
          review_id: frame.review_id,
          listing_id: cleanText(selectedReview.listing_id, 100) || null,
          exact_quote: cleanText(selectedReview.exact_quote, 900),
          rating: Number(selectedReview.rating) || null,
          listing_title: identity,
        },
        prompt: `Render the exact anonymous customer review selected by AI for ${identity}.`,
        reference_required: false,
        reference_image_url: null,
        reference_policy: 'No image-model reference is used; Etsy AI Command Center renders supplied review evidence deterministically.',
        factual_constraints: [
          'Use the exact supplied review quote',
          'Do not expose buyer identity or order details',
          'Do not imitate Etsy interface chrome',
          'Must be persisted by Etsy AI Command Center before use',
        ],
      }];
    }
    if (frame.source !== 'generated_image') return [];
      const referenceImageUrl = referenceImageForFrame(frame, ranking, listing);
      const prompt = cleanText(frame.prompt, 1600)
        || (visualBrief
          ? `Create ${frame.role || 'a social image'} for ${identity}. Use this AI listing understanding as the creative brief: ${visualBrief}.`
          : `Create ${frame.role || 'a social image'} for ${identity}, staying faithful to the supplied listing facts.`);
      return [{
        id: cleanText(frame.id || `generated_frame_${index + 1}`, 80),
        role: cleanText(frame.role || 'ai_planned_frame', 120),
        image_model: cleanText(frame.image_model, 180),
        aspect_ratio: frame.aspect_ratio,
        crop_focus: cleanText(frame.crop_focus, 20).toLowerCase() || 'attention',
        prompt: `${prompt} Treat the required evidence and factual constraints as fixed, but use your own strongest art direction for lighting, depth, perspective, texture, color rhythm, and supporting detail. Prefer an arresting campaign-specific composition over a sterile centered template or evenly spaced grid. No prices, discounts, reviews, fake product features, unsupported text, or unrelated alternate products/designs.`,
        reference_image_url: referenceImageUrl || null,
        reference_required: frame.reference_required === true,
        reference_policy: referenceImageUrl
          ? cleanText(frame.reference_policy || mediaStrategy.reference_policy || 'Use the selected Etsy listing image as a reference when preserving the sold product/design matters.', 260)
          : cleanText(frame.reference_policy || mediaStrategy.reference_policy || 'No reference image was selected by the AI media strategy; generated media requires owner review.', 260),
        factual_constraints: [
          'No fabricated product capability',
          'No fake review or customer result',
          'No unverified discount',
          'Do not present a digital item as shipped or a physical item as instant download unless listing facts say so',
          'Must be persisted by Etsy AI Command Center before use',
          ...unsupported.map(item => `Avoid unsupported claim: ${item}`),
        ],
      }];
    });
}

function generatedBriefs(decision, concept, listing, _eligibleCount, ranking = {}, context = {}) {
  if (!decision.materially_improves) return [];
  const mediaStrategy = mediaStrategyFor(context, concept);
  return generatedBriefsFromStrategy(mediaStrategy, concept, listing, ranking, context);
}

function normalizeGeneratedMedia(items = [], publicBaseUrl = '', context = {}) {
  const requireAiQuality = requiresAiListingUnderstanding(context) || context.require_visual_quality_review === true;
  return (Array.isArray(items) ? items : []).map(item => ({
    id: cleanText(item.id, 120),
    brief_id: cleanText(item.brief_id || item.frame_id, 120),
    url: imageUrl(item),
    type: 'image',
    source: item.source === 'review_card' ? 'review_card' : 'generated_image',
    context_note: cleanText(item.context_note, 180),
    review_card_design: normalizeSocialReviewCardDesign(item.review_card_design),
    render_spec_sha256: /^[a-f0-9]{64}$/i.test(String(item.render_spec_sha256 || ''))
      ? String(item.render_spec_sha256).toLowerCase()
      : null,
    prompt: cleanText(item.prompt, 1000),
    provider: cleanText(item.provider, 120),
    model: cleanText(item.model, 160),
    checksum_sha256: /^[a-f0-9]{64}$/i.test(String(item.checksum_sha256 || '')) ? String(item.checksum_sha256).toLowerCase() : null,
    permanent: item.permanent === true,
    quality_review: item.quality_review && typeof item.quality_review === 'object' ? item.quality_review : null,
  })).filter(item => item.url
    && item.permanent === true
    && item.checksum_sha256
    && isPersistentSocialMediaUrl(item.url, publicBaseUrl)
    && (!requireAiQuality || item.source === 'review_card' || (item.quality_review?.decision === 'approve' && item.quality_review?.approved === true)));
}

function listingMediaForStrategyFrame(frame = {}, eligible = [], usedListingUrls = new Set()) {
  if (frame.reference_media_rank) {
    const byRank = eligible.find(item => Number(item.source_rank) === Number(frame.reference_media_rank) && !usedListingUrls.has(item.url));
    if (byRank) return byRank;
  }
  return null;
}

function mediaStrategySelectionIssues(mediaStrategy, ranking, context = {}) {
  const ranked = Array.isArray(ranking?.ranked) ? ranking.ranked : [];
  const eligible = ranked.filter(item => item.eligible);
  const frameIssues = (mediaStrategy?.frames || []).flatMap((frame, frameIndex) => {
    if (frame.source === 'generated_image'
      && frame.reference_required === true
      && context.image_provider_capabilities?.reference_image_supported === false) {
      return [`${frame.id || frame.role}: configured image provider cannot preserve external reference pixels; AI must use the exact listing image or a reference-free conceptual frame`];
    }
    if (frame.source === 'review_card') {
      const selectedReview = context.selected_review && typeof context.selected_review === 'object' ? context.selected_review : null;
      if (!selectedReview) return [`${frame.id || frame.role}: review_card requires AI-selected review evidence`];
      if (cleanText(selectedReview.review_id, 120) !== frame.review_id) return [`${frame.id || frame.role}: review_id does not match AI-selected review evidence`];
      if (!cleanText(selectedReview.exact_quote, 900) || !Number(selectedReview.rating)) return [`${frame.id || frame.role}: selected review is missing exact quote or rating evidence`];
      if (!cleanText(frame.context_note, 180)) return [`${frame.id || frame.role}: review_card requires an AI-authored factual context_note`];
      if (!frame.review_card_design) return [`${frame.id || frame.role}: review_card requires AI-authored art direction`];
      const highlight = cleanText(frame.review_card_design.highlight_phrase, 100).toLocaleLowerCase();
      if (highlight && !cleanText(selectedReview.exact_quote, 900).toLocaleLowerCase().includes(highlight)) {
        return [`${frame.id || frame.role}: review-card highlight_phrase must be an exact substring of the selected review`];
      }
      if (!['1:1', '4:5', '2:3', '3:4', '9:16', '16:9'].includes(frame.aspect_ratio)) return [`${frame.id || frame.role}: AI review-card frame did not choose a supported aspect ratio`];
      return [];
    }
    const selectedRank = frame.reference_media_rank;
    const needsSelectedMedia = frame.source === 'listing_image' || (frame.source === 'generated_image' && frame.reference_required === true);
    if (!needsSelectedMedia) return [];
    const selected = eligible.find(item => Number(item.source_rank) === Number(selectedRank));
    if (!selected) return [`${frame.id || frame.role}: selected Etsy media rank ${selectedRank || 'missing'} is unavailable or cooldown-blocked`];
    if (frame.source === 'listing_image' && requiresVisionBackedSocialHero(context)) {
      const visuallyEligible = frameIndex === 0 ? selected.social_hero_eligible === true : selected.social_support_eligible === true;
      if (!visuallyEligible) return [`${frame.id || frame.role}: selected Etsy media rank ${selectedRank} was not approved by AI vision for this ${frameIndex === 0 ? 'lead' : 'support'} role`];
    }
    return [];
  });
  const frameById = new Map((mediaStrategy?.frames || []).map(frame => [frame?.id, frame]).filter(([id]) => id));
  const ratioIssues = Object.entries(mediaStrategy?.platform_variants || {}).flatMap(([platform, variant]) => (
    (Array.isArray(variant?.frame_ids) ? variant.frame_ids : []).flatMap(frameId => {
      const frame = frameById.get(frameId);
      if (!frame || !['generated_image', 'review_card'].includes(frame.source) || !frame.aspect_ratio) return [];
      return socialAspectRatioFitsPlatform(platform, frame.aspect_ratio)
        ? []
        : [`${platform}: frame ${frameId} aspect_ratio ${frame.aspect_ratio} is incompatible with the configured publishing surface`];
    })
  ));
  return [...new Set([...frameIssues, ...ratioIssues])];
}

function buildStrategyStoryboard(mediaStrategy, ranking, briefs, generatedMedia, context = {}) {
  const frames = Array.isArray(mediaStrategy?.frames) ? mediaStrategy.frames : [];
  if (!frames.length) return null;
  const eligible = ranking.ranked.filter(item => item.eligible);
  const usedListingUrls = new Set();
  const generatedByBrief = new Map(generatedMedia.map(item => [cleanText(item.brief_id || item.id, 100), item]));
  const briefById = new Map(briefs.map(item => [cleanText(item.id, 100), item]));
  const briefIds = new Set(briefs.map(item => item.id));
  const storyboard = [];
  for (const frame of frames.slice(0, 7)) {
    if (frame.source === 'listing_image') {
      const item = listingMediaForStrategyFrame(frame, eligible, usedListingUrls);
      if (!item) continue;
      if (requiresVisionBackedSocialHero(context)) {
        const visuallyEligible = storyboard.length === 0 ? item.social_hero_eligible === true : item.social_support_eligible === true;
        if (!visuallyEligible) continue;
      }
      usedListingUrls.add(item.url);
      storyboard.push({
        frame_id: frame.id,
        role: frame.role || (storyboard.length ? 'product_evidence' : 'hook'),
        communication_goal: frame.communication_goal,
        visible_buyer_evidence: frame.visible_buyer_evidence,
        evidence_strength: frame.evidence_strength,
        status: 'ready',
        media: { id: item.id, url: item.url, type: 'image', source: 'listing_image', alt: item.alt },
        rationale: frame.rationale || item.rationale.join('; '),
      });
      continue;
    }
    if (frame.source === 'generated_image' || briefIds.has(frame.id)) {
      const candidateMedia = generatedByBrief.get(frame.id);
      const expectedBrief = briefById.get(frame.id);
      const media = frame.source === 'review_card'
        && candidateMedia
        && candidateMedia.render_spec_sha256 !== expectedBrief?.render_spec_sha256
        ? null
        : candidateMedia;
      storyboard.push(media
        ? {
          frame_id: frame.id,
          role: frame.role || 'ai_planned_frame',
          communication_goal: frame.communication_goal,
          visible_buyer_evidence: frame.visible_buyer_evidence,
          evidence_strength: frame.evidence_strength,
          status: 'ready',
          media,
          rationale: frame.rationale || 'AI-planned generated frame persisted by Etsy AI Command Center.',
        }
        : {
          frame_id: frame.id,
          role: frame.role || 'ai_planned_frame',
          communication_goal: frame.communication_goal,
          visible_buyer_evidence: frame.visible_buyer_evidence,
          evidence_strength: frame.evidence_strength,
          status: 'pending_generation',
          brief_id: frame.id,
          rationale: frame.rationale || 'AI media strategy requires this generated frame before owner review.',
        });
    }
  }
  return storyboard.map((frame, index) => ({ order: index + 1, ...frame }));
}

function buildStoryboard(ranking, briefs, generatedMedia, context = {}, concept = {}) {
  return buildStrategyStoryboard(mediaStrategyFor(context, concept), ranking, briefs, generatedMedia, context) || [];
}

function platformCaption(platform, concept) {
  return cleanCaptionText(concept.listing_understanding?.platform_captions?.[platform], 1600);
}

function platformCaptionReview(platform, caption, concept = {}) {
  const raw = concept.listing_understanding?.platform_caption_reviews?.[platform];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const reviewedCaption = cleanCaptionText(raw.reviewed_caption || raw.caption, 1600);
  const decision = cleanText(raw.decision || raw.verdict || raw.status, 40).toLowerCase();
  const approved = raw.approved === true && decision === 'approve' && reviewedCaption === caption;
  return {
    approved,
    decision: approved ? 'approve' : (decision || 'revise'),
    reviewed_caption: reviewedCaption,
    rationale: cleanText(raw.rationale || raw.reason, 600),
    factual_grounding: cleanText(raw.factual_grounding || raw.grounding, 420),
    platform_fit: cleanText(raw.platform_fit || raw.platform_reason, 420),
    cta_destination: cleanText(raw.cta_destination, 60).toLowerCase(),
    cta_compliant: typeof raw.cta_compliant === 'boolean' ? raw.cta_compliant : null,
    required_listing_url_present: typeof raw.required_listing_url_present === 'boolean'
      ? raw.required_listing_url_present
      : null,
    risks: understandingList(raw.risks, 8, 160),
    critic_source: cleanText(raw.critic_source || concept.listing_understanding?.caption_review_source, 120),
    critic_model: cleanText(raw.critic_model || concept.listing_understanding?.caption_review_model, 160),
    critic_run_id: cleanText(raw.critic_run_id || concept.listing_understanding?.caption_review_run_id, 120),
    reviewed_at: cleanText(raw.reviewed_at || concept.listing_understanding?.caption_reviewed_at, 80),
  };
}

function buildVariants(platforms, campaignId, concept, listing, storyboard, context = {}) {
  const listingUrl = cleanText(listing.url || listing.listing_url, 1000);
  const strategy = mediaStrategyFor(context, concept);
  const storyboardById = new Map(storyboard.map(frame => [cleanText(frame.frame_id || frame.brief_id, 80), frame]).filter(([id]) => id));
  return [...new Set((platforms || []).map(item => cleanText(item, 40).toLowerCase()).filter(Boolean))].map(platform => {
    const platformVariant = strategy?.platform_variants?.[platform] || null;
    const platformFrames = platformVariant
      ? platformVariant.frame_ids.map(id => storyboardById.get(id)).filter(Boolean)
      : storyboard;
    const platformPlanComplete = !platformVariant
      || (platformFrames.length === platformVariant.frame_ids.length && platformFrames.every(frame => frame.status === 'ready' && frame.media?.url));
    const readyMedia = platformFrames.filter(frame => frame.status === 'ready' && frame.media?.url).map(frame => frame.media);
    const platformMedia = readyMedia.filter((item, index, all) => all.findIndex(candidate => candidate.url === item.url) === index);
    const minimumStoryMedia = requiredStoryMediaCount(context, concept, platform);
    const wantsCarousel = platform === 'instagram' && (platformVariant?.format || strategy?.format) === 'carousel' && platformMedia.length >= 2;
    const distinctPlatformMedia = new Set(platformMedia.map(item => item.url)).size;
    const caption = platformCaption(platform, concept);
    const readiness = caption.length < 40
      ? 'blocked_ai_caption_required'
      : !platformPlanComplete
      ? 'blocked_pending_generation'
      : platform === 'facebook' && !listingUrl
      ? 'blocked_missing_listing_url'
      : minimumStoryMedia > 0 && distinctPlatformMedia < minimumStoryMedia
        ? 'blocked_insufficient_story_media'
      : platform === 'instagram' && platformMedia.length < 1
        ? 'blocked_missing_media'
        : platformMedia.length ? 'media_ready' : 'blocked_missing_media';
    return {
      platform,
      variant_of: campaignId,
      caption,
      caption_quality_review: platformCaptionReview(platform, caption, concept),
      link_policy: platform === 'instagram' ? 'link_in_bio_no_raw_caption_url' : platform === 'facebook' ? 'raw_etsy_listing_url_required' : 'platform_link_supported',
      media_items: platformMedia,
      carousel: wantsCarousel,
      format: platformVariant?.format || strategy?.format || (platformMedia.length > 1 ? 'multi_image' : 'single'),
      selected_frame_ids: platformVariant?.frame_ids || storyboard.map(frame => frame.frame_id || frame.brief_id).filter(Boolean),
      buyer_evidence_frame_ids: platformVariant?.buyer_evidence_frame_ids || [],
      carousel_minimum_distinct_media: wantsCarousel ? 2 : null,
      media_readiness: {
        status: readiness,
        valid_media_count: platformMedia.length,
        distinct_media_count: distinctPlatformMedia,
        minimum_story_media_count: minimumStoryMedia || null,
        instagram_media_required: platform === 'instagram',
        generated_media_persistent: platformMedia.filter(item => item.source === 'generated_image').every(item => item.permanent === true && isPersistentSocialMediaUrl(item.url)),
        note: wantsCarousel
          ? 'Carousel is enabled because the AI platform variant selected it and at least two distinct ready media URLs are available.'
          : 'This platform uses only the ordered frame IDs selected by AI; no local first-image fallback or count truncation is applied.',
      },
      readiness,
    };
  });
}

export function planSocialCreativeCampaign({
  listing = {},
  context = {},
  platforms = [],
  providerConfigured = false,
  generatedMedia = [],
  publicBaseUrl = '',
  cooldownMemory = {},
  records = [],
  visualAnalysis = null,
  now = Date.now(),
} = {}) {
  const listingId = listingIdentity(listing);
  if (!listingId) throw new Error('listing_id is required for a creative campaign');
  const nowMs = timestamp(now) || Date.now();
  const memory = normalizeMemory(cooldownMemory, records, nowMs);
  const listingLastUsed = memory.listingUses.get(listingId) || 0;
  const listingBlocked = !revisionMatchesListing(context, listingId) && withinCooldown(listingLastUsed, nowMs);
  const concept = makeConcept(listing, context);
  if (requiresAiListingUnderstanding(context) && !validListingUnderstanding(concept.listing_understanding)) {
    return {
      schema_version: 1,
      campaign_id: '',
      listing_id: listingId,
      status: 'blocked_ai_listing_understanding_required',
      cooldown: {
        days: SOCIAL_CREATIVE_COOLDOWN_DAYS,
        listing_eligible: !listingBlocked,
        listing_last_used_at: listingLastUsed ? new Date(listingLastUsed).toISOString() : null,
        excluded_media_urls: [],
      },
      concept,
      listing_understanding: context.listing_understanding || listing.listing_understanding || null,
      image_selection: {
        confidence: 'none',
        visual_analysis_used: false,
        honesty_note: 'Autonomous creative planning requires AI listing understanding before campaign copy/media planning.',
        concept: cleanText(concept.name || concept.hook, 200),
        ranked: [],
      },
      selected_originals: [],
      selected_original_media: [],
      generation_decision: {
        use_generation: false,
        materially_improves: false,
        status: 'blocked_ai_listing_understanding_required',
        rationale: 'AI listing understanding is unavailable or invalid; autonomous planner will not create title-keyword campaign copy or pretend local metadata is semantic reasoning.',
      },
      generated_frame_briefs: [],
      generated_media: [],
      rejected_generated_media_count: Array.isArray(generatedMedia) ? generatedMedia.length : 0,
      storyboard: [],
      carousel_storyboard: [],
      variants: [],
      factual_safety_notes: [
        'Autonomous social content requires AI listing understanding.',
        'Local deterministic code may collect facts and enforce safety, but it must not create campaign/listing semantic copy.',
      ],
      provenance: {
        planner: 'etsy_manager_quality_social_creative_v1',
        planned_at: new Date(nowMs).toISOString(),
        listing_source: cleanText(listing.source || 'etsy_listing_context', 100),
        listing_understanding_source: cleanText(concept.listing_understanding?.source || context.listing_understanding?.source || 'none', 80),
        listing_understanding_confidence: concept.listing_understanding?.confidence ?? context.listing_understanding?.confidence ?? null,
        ranking_signal_mode: 'none',
        generated_provider_configured: Boolean(providerConfigured),
        generated_prompts: [],
        media_urls: [],
      },
    };
  }
  const mediaStrategy = mediaStrategyFor(context, concept);
  if (requiresAiMediaStrategy(context) && !validMediaStrategy(mediaStrategy, platforms)) {
    return {
      schema_version: 1,
      campaign_id: '',
      listing_id: listingId,
      status: 'blocked_ai_media_strategy_required',
      cooldown: {
        days: SOCIAL_CREATIVE_COOLDOWN_DAYS,
        listing_eligible: !listingBlocked,
        listing_last_used_at: listingLastUsed ? new Date(listingLastUsed).toISOString() : null,
        excluded_media_urls: [],
      },
      concept,
      listing_understanding: context.listing_understanding || listing.listing_understanding || null,
      media_strategy: mediaStrategy || null,
      image_selection: {
        confidence: 'none',
        visual_analysis_used: false,
        honesty_note: 'Autonomous creative planning requires AI media strategy before deciding image count, source order, or reference policy.',
        concept: cleanText(concept.name || concept.hook, 200),
        ranked: [],
      },
      selected_originals: [],
      selected_original_media: [],
      generation_decision: {
        use_generation: false,
        materially_improves: false,
        status: 'blocked_ai_media_strategy_required',
        rationale: 'AI media strategy is unavailable or structurally incomplete; autonomous planner will not use a hardcoded first-listing-image-plus-generated-mockups template.',
      },
      generated_frame_briefs: [],
      generated_media: [],
      rejected_generated_media_count: Array.isArray(generatedMedia) ? generatedMedia.length : 0,
      storyboard: [],
      carousel_storyboard: [],
      variants: [],
      factual_safety_notes: [
        'Autonomous social content requires AI media strategy for image count, source choice, and reference policy.',
        'Local deterministic code may enforce safety and platform rules, but it must not choose a marketing storyboard template.',
      ],
      provenance: {
        planner: 'etsy_manager_quality_social_creative_v1',
        planned_at: new Date(nowMs).toISOString(),
        listing_source: cleanText(listing.source || 'etsy_listing_context', 100),
        listing_understanding_source: cleanText(concept.listing_understanding?.source || context.listing_understanding?.source || 'none', 80),
        listing_understanding_confidence: concept.listing_understanding?.confidence ?? context.listing_understanding?.confidence ?? null,
        ranking_signal_mode: 'none',
        generated_provider_configured: Boolean(providerConfigured),
        generated_prompts: [],
        media_urls: [],
      },
    };
  }
  const ranking = rankSocialListingMedia({ listing, concept, cooldownMemory, records, visualAnalysis, context, now: nowMs });
  const strategySelectionIssues = mediaStrategySelectionIssues(mediaStrategy, ranking, context);
  const decision = generationDecision(ranking, providerConfigured, context, concept);
  const briefs = strategySelectionIssues.length
    ? []
    : generatedBriefs(decision, concept, listing, ranking.ranked.filter(item => item.eligible).length, ranking, context);
  const persistentGenerated = normalizeGeneratedMedia(generatedMedia, publicBaseUrl, context);
  const storyboard = listingBlocked ? [] : buildStoryboard(ranking, briefs, persistentGenerated, context, concept);
  const campaignId = `campaign_${crypto.createHash('sha256').update(`${listingId}\0${concept.name}\0${new Date(nowMs).toISOString().slice(0, 10)}`).digest('hex').slice(0, 16)}`;
  const variants = listingBlocked || storyboard.length < 1 ? [] : buildVariants(platforms, campaignId, concept, listing, storyboard, context);
  const pending = storyboard.filter(frame => frame.status !== 'ready').length;
  if (strategySelectionIssues.length) for (const variant of variants) variant.readiness = 'blocked_ai_media_selection';
  if (pending) for (const variant of variants) {
    if (variant.readiness !== 'blocked_missing_listing_url') variant.readiness = 'blocked_pending_generation';
  }
  const readyVariants = variants.filter(variant => variant.readiness === 'media_ready');
  const captionsMissing = variants.some(variant => variant.readiness === 'blocked_ai_caption_required');

  return {
    schema_version: 1,
    campaign_id: campaignId,
    listing_id: listingId,
    status: listingBlocked
      ? 'blocked_listing_cooldown'
      : strategySelectionIssues.length
        ? 'blocked_ai_media_selection'
      : pending && decision.status === 'blocked_provider_unconfigured'
        ? 'blocked_generation_provider'
       : pending
          ? 'needs_generation'
          : captionsMissing
            ? 'blocked_ai_caption_required'
          : readyVariants.length
            ? 'ready_for_review'
            : decision.status === 'blocked_ai_media_strategy_required'
              ? 'blocked_ai_media_strategy_required'
            : requiredStoryMediaCount(context, concept) > 0
              ? 'blocked_insufficient_story_media'
              : 'blocked_missing_media',
    cooldown: {
      days: SOCIAL_CREATIVE_COOLDOWN_DAYS,
      listing_eligible: !listingBlocked,
      listing_last_used_at: listingLastUsed ? new Date(listingLastUsed).toISOString() : null,
      excluded_media_urls: ranking.ranked.filter(item => !item.eligible).map(item => item.url),
    },
    concept,
    listing_understanding: concept.listing_understanding || context.listing_understanding || null,
    media_strategy: mediaStrategy,
    media_strategy_selection_issues: strategySelectionIssues,
    image_selection: ranking,
    listing_media_ranking_rationale: ranking.ranked.map(item => ({
      id: item.id,
      url: item.url,
      score: item.score,
      eligible: item.eligible,
      social_hero_eligible: item.social_hero_eligible,
      source_rank: item.source_rank,
      visual_analysis_used: item.visual_analysis?.used === true,
      rationale: item.rationale,
    })),
    selected_originals: ranking.ranked.filter(item => storyboard.some(frame => frame.media?.source === 'listing_image' && frame.media.url === item.url)),
    selected_original_media: storyboard
      .filter(frame => frame.media?.source === 'listing_image')
      .map(frame => ({ order: frame.order, role: frame.role, ...frame.media, rationale: frame.rationale })),
    generation_decision: decision,
    generated_frame_briefs: briefs,
    generated_media: persistentGenerated,
    rejected_generated_media_count: Math.max(0, (Array.isArray(generatedMedia) ? generatedMedia.length : 0) - persistentGenerated.length),
    storyboard,
    carousel_storyboard: storyboard.map(frame => ({
      order: frame.order,
      role: frame.role,
      status: frame.status,
      media_url: frame.media?.url || null,
      source: frame.media?.source || null,
      brief_id: frame.brief_id || frame.media?.brief_id || null,
      rationale: frame.rationale,
    })),
    variants,
    factual_safety_notes: [
      'Use only listing/context facts supplied to the planner.',
      'No fake review, sale, outcome, scarcity, bestseller, or physical-product claim.',
      concept.listing_understanding
        ? 'AI listing understanding is advisory and must not override missing listing facts or owner approval.'
        : 'No AI listing understanding was available; copy falls back to conservative metadata-only planning.',
      'Metadata-only ranking is explicitly low confidence and does not claim pixel analysis.',
      'Generated media is campaign-ready only at a persistent same-origin Etsy AI Command Center mediaAsset URL.',
      ...(requiresVisionBackedSocialHero(context) ? ['Autonomous social heroes require AI visual analysis of the original image or a persistent generated hero.'] : []),
    ],
    provenance: {
      planner: 'etsy_manager_quality_social_creative_v1',
      planned_at: new Date(nowMs).toISOString(),
      listing_source: cleanText(listing.source || 'etsy_listing_context', 100),
      listing_understanding_source: cleanText(concept.listing_understanding?.source || context.listing_understanding?.source || 'none', 80),
      listing_understanding_confidence: concept.listing_understanding?.confidence ?? context.listing_understanding?.confidence ?? null,
      ranking_signal_mode: ranking.visual_analysis_used ? 'declared_visual_analysis_plus_metadata' : 'metadata_only',
      generated_provider_configured: Boolean(providerConfigured),
      generated_prompts: briefs.map(item => ({ brief_id: item.id, prompt: item.prompt })),
      media_urls: storyboard.filter(frame => frame.media?.url).map(frame => frame.media.url),
    },
  };
}

function normalizeCandidateListings({ listing = null, listings = [], listingCandidates = [] } = {}) {
  const raw = [];
  if (listing && typeof listing === 'object' && listingIdentity(listing)) raw.push(listing);
  if (Array.isArray(listings)) raw.push(...listings);
  if (Array.isArray(listingCandidates)) raw.push(...listingCandidates);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = listingIdentity(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...item, listing_id: id });
  }
  return out;
}

function planHasUsablePlatformVariant(plan = {}) {
  if (plan?.status !== 'ready_for_review') return false;
  const pendingFrames = (Array.isArray(plan.storyboard) ? plan.storyboard : [])
    .some(frame => frame?.status !== 'ready');
  if (pendingFrames) return false;
  return (Array.isArray(plan.variants) ? plan.variants : [])
    .some(variant => variant
      && variant.platform
      && variant.platform !== 'all'
      && variant.readiness === 'media_ready'
      && Array.isArray(variant.media_items)
      && variant.media_items.length > 0
      && (!variant.carousel || new Set(variant.media_items.map(item => item.url)).size >= 2));
}

function candidateAttemptSummary(plan = {}, listing = {}) {
  const variants = Array.isArray(plan.variants) ? plan.variants : [];
  const fit = campaignFitFor(listing);
  const understanding = plan.listing_understanding && typeof plan.listing_understanding === 'object'
    ? plan.listing_understanding
    : null;
  return {
    listing_id: listingIdentity(listing) || plan.listing_id || '',
    listing_title: cleanText(listing.title || listing.listing_title, 140),
    status: cleanText(plan.status, 80),
    listing_eligible: plan.cooldown?.listing_eligible ?? null,
    listing_last_used_at: plan.cooldown?.listing_last_used_at || null,
    variants: variants.length,
    media_ready_variants: variants.filter(variant => variant.readiness === 'media_ready' && Array.isArray(variant.media_items) && variant.media_items.length > 0).length,
    pending_generation_frames: (Array.isArray(plan.storyboard) ? plan.storyboard : []).filter(frame => frame.status !== 'ready').length,
    campaign_fit_decision: cleanText(fit?.decision || fit?.fit || fit?.status, 80),
    campaign_fit_confidence: fit?.confidence ?? null,
    campaign_fit_rationale: cleanText(fit?.rationale || fit?.reason, 220),
    listing_understanding_source: cleanText(understanding?.source, 100),
    listing_understanding_reason: cleanText(understanding?.reason, 240),
  };
}

export function planSocialCreativeCampaignForCandidates({
  listing = null,
  listings = [],
  listingCandidates = [],
  context = {},
  platforms = [],
  providerConfigured = false,
  generatedMedia = [],
  publicBaseUrl = '',
  cooldownMemory = {},
  records = [],
  visualAnalysis = null,
  now = Date.now(),
} = {}) {
  const candidates = normalizeCandidateListings({ listing, listings, listingCandidates });
  const candidatePlatforms = [...new Set((platforms || [])
    .map(item => cleanText(item, 40).toLowerCase())
    .filter(platform => ['instagram', 'facebook', 'pinterest', 'tiktok'].includes(platform)))];
  const safePlatforms = candidatePlatforms;
  if (!safePlatforms.length) {
    return {
      schema_version: 1,
      campaign_id: '',
      listing_id: '',
      status: 'blocked_no_configured_platforms',
      cooldown: { days: SOCIAL_CREATIVE_COOLDOWN_DAYS, listing_eligible: false, listing_last_used_at: null, excluded_media_urls: [] },
      concept: {},
      image_selection: { confidence: 'none', visual_analysis_used: false, honesty_note: 'No configured platform route was supplied; the planner will not invent Instagram or Facebook defaults.', concept: '', ranked: [] },
      selected_originals: [],
      generation_decision: { use_generation: false, materially_improves: false, status: 'blocked_no_configured_platforms', rationale: 'Configure at least one platform route in Etsy AI Command Center before creative planning.' },
      generated_frame_briefs: [],
      generated_media: [],
      rejected_generated_media_count: 0,
      storyboard: [],
      variants: [],
      factual_safety_notes: ['Platform selection must come from configured Etsy AI Command Center routes and the AI-selected campaign subset.'],
      provenance: { planner: 'etsy_manager_quality_social_creative_v1', planned_at: new Date(timestamp(now) || Date.now()).toISOString(), listing_source: '', ranking_signal_mode: 'none', generated_provider_configured: Boolean(providerConfigured), generated_prompts: [], media_urls: [] },
      candidate_selection: {
        mode: 'blocked_no_configured_platforms',
        selected_listing_id: '',
        selected_attempt_index: -1,
        total_candidates: candidates.length,
        skipped_before_selection: 0,
        attempts: [],
        note: 'No configured platform route was supplied. No creative variant was created.',
      },
    };
  }
  const attempts = [];
  let firstPlan = null;
  let firstGenerationTarget = null;
  for (const candidate of candidates) {
    if (!campaignFitAllowsSelection(candidate)) {
      attempts.push({
        listing_id: listingIdentity(candidate),
        listing_title: listingTitle(candidate),
        status: 'blocked_campaign_mismatch',
        listing_eligible: null,
        listing_last_used_at: null,
        variants: 0,
        media_ready_variants: 0,
        pending_generation_frames: 0,
        campaign_fit_decision: cleanText(campaignFitFor(candidate)?.decision || campaignFitFor(candidate)?.fit || campaignFitFor(candidate)?.status, 80),
        campaign_fit_confidence: campaignFitFor(candidate)?.confidence ?? null,
        campaign_fit_rationale: cleanText(campaignFitFor(candidate)?.rationale || campaignFitFor(candidate)?.reason, 220),
      });
      continue;
    }
    const plan = planSocialCreativeCampaign({
      listing: candidate,
      context,
      platforms: safePlatforms,
      providerConfigured,
      generatedMedia,
      publicBaseUrl,
      cooldownMemory,
      records,
      visualAnalysis,
      now,
    });
    if (!firstPlan) firstPlan = plan;
    attempts.push(candidateAttemptSummary(plan, candidate));
    const variants = Array.isArray(plan.variants) ? plan.variants : [];
    const listingEligible = plan.cooldown?.listing_eligible !== false;
    const hasAiGenerationBriefs = (Array.isArray(plan.generated_frame_briefs) ? plan.generated_frame_briefs : [])
      .some(brief => brief && cleanText(brief.prompt, 1800));
    if (!firstGenerationTarget && listingEligible && plan.status === 'needs_generation' && hasAiGenerationBriefs) {
      firstGenerationTarget = { plan, attemptIndex: attempts.length - 1 };
    }
    const singleExplicitListing = candidates.length === 1 && listing && listingIdentity(listing) === listingIdentity(candidate);
    if (planHasUsablePlatformVariant(plan) || (singleExplicitListing && listingEligible && variants.length > 0)) {
      return {
        ...plan,
        candidate_selection: {
          mode: 'scanned_listing_candidates',
          selected_listing_id: plan.listing_id,
          selected_attempt_index: attempts.length - 1,
          total_candidates: candidates.length,
          skipped_before_selection: attempts.length - 1,
          attempts,
          note: 'Planner scanned listing candidates until it found a cooldown-eligible listing with platform-specific media-ready variants.',
        },
      };
    }
  }
  if (attempts.length && !firstPlan) {
    return {
      schema_version: 1,
      campaign_id: '',
      listing_id: '',
      status: 'blocked_no_campaign_fit_candidate',
      cooldown: { days: SOCIAL_CREATIVE_COOLDOWN_DAYS, listing_eligible: false, listing_last_used_at: null, excluded_media_urls: [] },
      concept: {},
      image_selection: { confidence: 'none', visual_analysis_used: false, honesty_note: 'No listing candidate semantically matched the campaign context.', concept: '', ranked: [] },
      selected_originals: [],
      generation_decision: { use_generation: false, materially_improves: false, status: 'blocked_no_campaign_fit_candidate', rationale: 'Campaign/listing semantic fit gate rejected all supplied candidates.' },
      generated_frame_briefs: [],
      generated_media: [],
      rejected_generated_media_count: 0,
      storyboard: [],
      variants: [],
      factual_safety_notes: ['No listing was selected because campaign/listing semantic fit was not strong enough.'],
      provenance: { planner: 'etsy_manager_quality_social_creative_v1', planned_at: new Date(timestamp(now) || Date.now()).toISOString(), listing_source: '', ranking_signal_mode: 'none', generated_provider_configured: Boolean(providerConfigured), generated_prompts: [], media_urls: [] },
      candidate_selection: {
        mode: 'blocked_no_campaign_fit_candidate',
        selected_listing_id: '',
        selected_attempt_index: -1,
        total_candidates: candidates.length,
        skipped_before_selection: attempts.length,
        attempts,
        note: 'Planner rejected candidates whose AI semantic campaign-fit assessment said they were weak or mismatched for the campaign context.',
      },
    };
  }
  if (firstGenerationTarget) {
    const { plan, attemptIndex } = firstGenerationTarget;
    return {
      ...plan,
      candidate_selection: {
        mode: 'scanned_listing_candidates_generation_target',
        selected_listing_id: plan.listing_id,
        selected_attempt_index: attemptIndex,
        total_candidates: candidates.length,
        skipped_before_selection: attemptIndex,
        attempts,
        note: 'No candidate was media-ready yet. The first AI-ordered, cooldown-eligible candidate with AI-authored generation briefs was selected as the explicit media generation target.',
      },
    };
  }
  if (firstPlan) {
    return {
      ...firstPlan,
      candidate_selection: {
        mode: 'scanned_listing_candidates_no_media_ready_selection',
        selected_listing_id: '',
        selected_attempt_index: -1,
        total_candidates: candidates.length,
        skipped_before_selection: attempts.length,
        attempts,
        note: 'No candidate produced a media-ready, platform-specific variant. Nothing should be saved/scheduled until generation or listing context makes a candidate ready.',
      },
      status: 'blocked_no_media_ready_candidate',
      storyboard: [],
      variants: [],
    };
  }
  return {
    schema_version: 1,
    campaign_id: '',
    listing_id: '',
    status: 'blocked_no_listing_candidates',
    cooldown: { days: SOCIAL_CREATIVE_COOLDOWN_DAYS, listing_eligible: false, listing_last_used_at: null, excluded_media_urls: [] },
    concept: {},
    image_selection: { confidence: 'none', visual_analysis_used: false, honesty_note: 'No listing candidates were supplied.', concept: '', ranked: [] },
    selected_originals: [],
    generation_decision: { use_generation: false, materially_improves: false, status: 'blocked_no_listing_candidates', rationale: 'No listing candidates were supplied.' },
    generated_frame_briefs: [],
    generated_media: [],
    rejected_generated_media_count: 0,
    storyboard: [],
    variants: [],
    factual_safety_notes: [],
    provenance: { planner: 'etsy_manager_quality_social_creative_v1', planned_at: new Date(timestamp(now) || Date.now()).toISOString(), listing_source: '', ranking_signal_mode: 'none', generated_provider_configured: Boolean(providerConfigured), generated_prompts: [], media_urls: [] },
    candidate_selection: {
      mode: 'scanned_listing_candidates_empty',
      selected_listing_id: '',
      selected_attempt_index: -1,
      total_candidates: 0,
      skipped_before_selection: 0,
      attempts: [],
      note: 'No listing candidates were supplied.',
    },
  };
}
