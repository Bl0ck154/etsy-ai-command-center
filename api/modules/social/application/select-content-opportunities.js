import {
  buildSocialCreativePatternContext,
  suggestSocialContentOpportunities,
} from '../../../_social-creative-planner.js';
import {
  resolveSocialHermesPublishCapablePlatforms,
  resolveSocialHermesRequestedPlatforms,
} from '../domain/platform-resolution.js';

export { createSocialContentOpportunitySemanticFilter } from './select-content-opportunities-ai.js';

function socialText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeSocialOwnerFeedbackMemory(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const items = (Array.isArray(source.items) ? source.items : [])
    .filter(item => item && typeof item === 'object' && item.active !== false)
    .map(item => ({
      id: socialText(item.id, 80),
      scope: ['listing', 'shop'].includes(socialText(item.scope, 40).toLowerCase())
        ? socialText(item.scope, 40).toLowerCase()
        : '',
      listing_id: socialText(item.listing_id, 100),
      preferences: Array.isArray(item.preferences)
        ? item.preferences.map(preference => socialText(preference, 300)).filter(Boolean).slice(0, 12)
        : [],
      rationale: socialText(item.rationale, 600),
      source_preview_id: socialText(item.source_preview_id, 160),
      recorded_at: socialText(item.recorded_at, 80),
      active: true,
    }))
    .filter(item => item.id && item.scope && item.preferences.length && (item.scope !== 'listing' || item.listing_id))
    .slice(-50);
  return {
    schema_version: 1,
    items,
    updated_at: socialText(source.updated_at, 80) || null,
  };
}

/**
 * Plain-data content-opportunity stage used by the Social HTTP facade today
 * and intended for the direct producer composition. The semanticFilter is the
 * AI decision boundary: deterministic suggestion code only supplies facts and
 * must never be substituted for it.
 */
export function createSocialContentOpportunityService({
  getScheduledPosts,
  loadValue,
  semanticFilter,
  getAutonomousContextMemory = () => null,
  normalizeOwnerFeedbackMemory = normalizeSocialOwnerFeedbackMemory,
  suggestOpportunities = suggestSocialContentOpportunities,
  buildCreativePatternContext = buildSocialCreativePatternContext,
  resolvePublishCapablePlatforms = resolveSocialHermesPublishCapablePlatforms,
  resolveRequestedPlatforms = resolveSocialHermesRequestedPlatforms,
} = {}) {
  for (const [name, dependency] of Object.entries({ getScheduledPosts, loadValue, semanticFilter })) {
    if (typeof dependency !== 'function') throw new TypeError(`${name} dependency is required`);
  }

  const selectContentOpportunities = async (body = {}) => {
    const [scheduledPosts, socialConfigs, savedMemory, savedAutonomousContext, savedOwnerFeedbackMemory] = await Promise.all([
      getScheduledPosts().catch(() => []),
      loadValue('social_configs').catch(() => ({})),
      loadValue('social_creative_cooldown_memory').catch(() => ({})),
      loadValue('social_autonomous_context').catch(() => null),
      loadValue('social_owner_feedback_memory').catch(() => null),
    ]);
    const configuredPlatforms = resolvePublishCapablePlatforms(socialConfigs || {});
    const platforms = resolveRequestedPlatforms(body.platforms || [], configuredPlatforms);
    const autonomousContext = body.autonomous_context
      || body.shop_context
      || savedAutonomousContext
      || getAutonomousContextMemory()
      || {};
    const callerSuppliedContext = Array.isArray(body.listings)
      || Array.isArray(body.reviews)
      || Array.isArray(body.discounts)
      || body.autonomous_context
      || body.shop_context;
    const excludedListingIds = new Set([
      ...(Array.isArray(body.excluded_listing_ids) ? body.excluded_listing_ids : []),
      ...(Array.isArray(body.cooldown_excluded_listing_ids) ? body.cooldown_excluded_listing_ids : []),
    ].map(id => socialText(id, 100)).filter(Boolean));
    const sourceListings = Array.isArray(body.listings)
      ? body.listings
      : (Array.isArray(autonomousContext.listings) ? autonomousContext.listings : []);
    const availableListings = excludedListingIds.size
      ? sourceListings.filter(listing => !excludedListingIds.has(socialText(listing?.listing_id || listing?.id, 100)))
      : sourceListings;
    const opportunityContext = {
      ...autonomousContext,
      listings: availableListings,
      reviews: Array.isArray(body.reviews) ? body.reviews : autonomousContext.reviews,
      discounts: Array.isArray(body.discounts) ? body.discounts : autonomousContext.discounts,
    };
    const suggestions = suggestOpportunities({
      autonomousContext: opportunityContext,
      records: scheduledPosts,
      cooldownMemory: savedMemory || {},
      platforms: platforms.length ? platforms : configuredPlatforms,
      now: body.now || Date.now(),
      windowDays: body.window_days || body.windowDays || 30,
      limit: body.limit || 5,
      sourceBasis: callerSuppliedContext ? 'caller_supplied_unverified' : 'stored_shop_context',
    });
    suggestions.require_listing_understanding = Boolean(body.require_listing_understanding || body.requireListingUnderstanding);
    suggestions.selection_objective = socialText(body.selection_objective || body.selectionObjective, 600);
    suggestions.configured_platforms = platforms.length ? platforms : configuredPlatforms;
    suggestions.owner_feedback_memory = normalizeOwnerFeedbackMemory(
      body.owner_feedback_memory || savedOwnerFeedbackMemory,
    );
    suggestions.recent_content_patterns = buildCreativePatternContext(scheduledPosts);
    return semanticFilter({
      suggestions,
      sourceListings: availableListings,
      visualAnalysis: body.visual_analysis || null,
      currentResearch: body.current_research || body.research_context || body.web_research || null,
      now: body.now || Date.now(),
      aiCandidateLimit: body.ai_candidate_limit || body.aiCandidateLimit || 12,
      maxOpportunities: body.max_opportunities
        || body.maxOpportunities
        || Math.max(1, Math.min(2, Number(body.limit) || 2)),
    });
  };

  return { selectContentOpportunities };
}
