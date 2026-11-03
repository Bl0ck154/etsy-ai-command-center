function socialAiText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function socialAiStringList(value, maxItems = 8, maxChars = 120) {
  const input = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return [...new Set(input.map(item => socialAiText(item, maxChars)).filter(Boolean))].slice(0, maxItems);
}

function socialCurrentDateContext(value = Date.now()) {
  const date = new Date(value || Date.now());
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  return {
    current_date: valid.toISOString().slice(0, 10),
    current_year: valid.getUTCFullYear(),
    current_iso: valid.toISOString(),
  };
}

function compactCurrentResearchForAi(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const sources = Array.isArray(input.sources) ? input.sources : [];
  const signals = Array.isArray(input.signals) ? input.signals : [];
  return {
    status: socialAiText(input.status || input.research_status, 80),
    summary: socialAiText(input.summary || input.findings || input.reasoning, 1200),
    researched_at: socialAiText(input.researched_at || input.generated_at, 80),
    sources: sources.slice(0, 8).map((item, index) => ({
      id: socialAiText(item?.id || item?.source_id || `research_source_${index + 1}`, 80),
      title: socialAiText(item?.title || item?.name, 180),
      url: socialAiText(item?.url, 1000),
      publisher: socialAiText(item?.publisher || item?.source, 120),
      published_at: socialAiText(item?.published_at || item?.date, 80),
      query: socialAiText(item?.query, 240),
      purpose: socialAiText(item?.purpose, 320),
      note: socialAiText(item?.note || item?.snippet || item?.excerpt || item?.description || item?.content, 700),
    })),
    signals: signals.slice(0, 12).map(item => socialAiText(item, 220)).filter(Boolean),
  };
}

function opportunitySelectionOutputSchema(requireListingUnderstanding = false, configuredPlatforms = []) {
  const stringArray = { type: 'array', items: { type: 'string' } };
  const timingPlatforms = [...new Set(configuredPlatforms.map(item => socialAiText(item, 40).toLowerCase()).filter(Boolean))];
  const platformDecisionProperties = Object.fromEntries(timingPlatforms.map(platform => [platform, {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'rationale'],
    properties: {
      decision: { type: 'string', enum: ['include', 'exclude'] },
      rationale: { type: 'string', minLength: 1 },
    },
  }]));
  const scheduledAtProperties = Object.fromEntries(timingPlatforms.map(platform => [platform, {
    type: 'string',
    description: 'ISO-8601 UTC publication time selected for this platform and US audience.',
  }]));
  const selectionRequired = [
    'source_opportunity_id', 'type', 'moment', 'reason', 'audience', 'campaign_context',
    'platforms', 'platform_decisions', 'listing_ids', 'priority', 'evidence', 'risks',
    'research_basis', 'research_source_ids', 'listing_campaign_fit_by_id', 'timing',
  ];
  if (requireListingUnderstanding) selectionRequired.push('listing_understanding_by_id');
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'confidence', 'rationale', 'research_evidence', 'selected_opportunities', 'rejected_signals'],
    properties: {
      status: { type: 'string', enum: ['selected', 'blocked'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      rationale: { type: 'string' },
      research_evidence: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'rationale', 'accepted_source_ids', 'rejected_sources'],
        properties: {
          status: { type: 'string' },
          rationale: { type: 'string' },
          accepted_source_ids: stringArray,
          rejected_sources: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['id', 'reason'],
              properties: { id: { type: 'string' }, reason: { type: 'string' } },
            },
          },
        },
      },
      selected_opportunities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          required: selectionRequired,
          properties: {
            source_opportunity_id: { type: 'string' },
            type: { type: 'string' },
            moment: { type: 'string' },
            reason: { type: 'string' },
            audience: { type: 'string' },
            campaign_context: { type: 'string' },
            platforms: {
              type: 'array',
              minItems: 1,
              maxItems: timingPlatforms.length,
              uniqueItems: true,
              items: { type: 'string', enum: timingPlatforms },
              description: 'Must contain exactly the configured platforms whose platform_decisions entry is include.',
            },
            platform_decisions: {
              type: 'object',
              additionalProperties: false,
              required: timingPlatforms,
              properties: platformDecisionProperties,
            },
            listing_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
            priority: { type: 'number', minimum: 1, maximum: 100 },
            evidence: stringArray,
            risks: stringArray,
            research_basis: { type: 'string', enum: ['verified_current_research', 'shop_evidence', 'evergreen'] },
            research_source_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Use at least two accepted source IDs only for verified_current_research. Must be the exact empty array for shop_evidence or evergreen.',
            },
            timing: {
              type: 'object',
              additionalProperties: false,
              required: ['audience_timezone', 'rationale', 'scheduled_at_by_platform'],
              properties: {
                audience_timezone: { type: 'string' },
                rationale: { type: 'string' },
                scheduled_at_by_platform: {
                  type: 'object',
                  additionalProperties: false,
                  required: timingPlatforms,
                  properties: scheduledAtProperties,
                },
              },
            },
            listing_campaign_fit_by_id: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                additionalProperties: false,
                required: ['decision', 'should_use_listing', 'confidence', 'rationale', 'natural_connection', 'safer_angle', 'risks', 'evidence'],
                properties: {
                  decision: { type: 'string', enum: ['strong_fit', 'acceptable_fit', 'weak_fit', 'mismatch'] },
                  should_use_listing: { type: 'boolean' },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                  rationale: { type: 'string' },
                  natural_connection: { type: 'string' },
                  safer_angle: { type: 'string' },
                  risks: stringArray,
                  evidence: stringArray,
                },
              },
            },
            listing_understanding_by_id: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                additionalProperties: true,
                required: ['what_is_sold', 'product_category', 'fulfillment', 'buyer_use_case', 'target_buyer', 'marketing_angle', 'caption_body', 'visual_brief', 'evidence', 'unknowns', 'confidence'],
                properties: {
                  what_is_sold: { type: 'string' }, product_category: { type: 'string' }, fulfillment: { type: 'string' },
                  buyer_use_case: { type: 'string' }, target_buyer: { type: 'string' }, marketing_angle: { type: 'string' },
                  caption_body: { type: 'string' }, visual_brief: { type: 'string' }, evidence: stringArray,
                  unknowns: stringArray, confidence: { type: 'number', minimum: 0, maximum: 1 },
                },
              },
            },
            review_id: { type: 'string' },
            review_quote: { type: 'string' },
          },
        },
      },
      rejected_signals: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'reason'],
          properties: { id: { type: 'string' }, reason: { type: 'string' } },
        },
      },
    },
  };
}

export function createSocialContentOpportunityContracts({
  normalizeListingUnderstanding,
  normalizeListingCampaignFit,
} = {}) {
  for (const [name, dependency] of Object.entries({ normalizeListingUnderstanding, normalizeListingCampaignFit })) {
    if (typeof dependency !== 'function') throw new TypeError(`${name} dependency is required`);
  }

function socialHermesCampaignFitAllowsSelection(fit = {}) {
  if (!fit || typeof fit !== 'object') return false;
  const decision = socialAiText(fit.decision || fit.fit || fit.status, 80).toLowerCase();
  if (fit.should_use_listing === false) return false;
  return ['strong_fit', 'acceptable_fit'].includes(decision);
}

function normalizeAiResearchEvidence(raw = {}, researchContext = null) {
  const sources = Array.isArray(researchContext?.sources) ? researchContext.sources : [];
  if (!sources.length) return {
    status: 'not_supplied',
    usable_for_current_event_claims: false,
    accepted_source_ids: [],
    rejected_sources: [],
    rationale: '',
  };
  const evidence = raw.research_evidence || raw.researchEvidence || raw.source_evaluation || raw.sourceEvaluation;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return {
    status: 'unverified',
    usable_for_current_event_claims: false,
    accepted_source_ids: [],
    rejected_sources: [],
    rationale: 'AI did not return a research evidence verdict.',
  };
  const allowedIds = new Set(sources.map(item => item.id).filter(Boolean));
  const acceptedSourceIds = [...new Set(socialAiStringList(
    evidence.accepted_source_ids || evidence.acceptedSourceIds || evidence.verified_source_ids || evidence.verifiedSourceIds,
    8,
    80,
  ).filter(id => allowedIds.has(id)))];
  const rawStatus = socialAiText(evidence.status || evidence.verdict || evidence.decision, 80).toLowerCase();
  const usable = ['verified', 'usable', 'supported'].includes(rawStatus) && acceptedSourceIds.length >= 2;
  const rejected = Array.isArray(evidence.rejected_sources)
    ? evidence.rejected_sources
    : Array.isArray(evidence.rejectedSources)
      ? evidence.rejectedSources
      : [];
  return {
    status: usable ? 'verified' : (rawStatus || 'unverified'),
    usable_for_current_event_claims: usable,
    accepted_source_ids: acceptedSourceIds,
    rejected_sources: rejected.slice(0, 8).map(item => ({
      id: socialAiText(item?.id || item?.source_id, 80),
      reason: socialAiText(item?.reason || item?.rationale, 420),
    })).filter(item => item.id || item.reason),
    rationale: socialAiText(evidence.rationale || evidence.reason || evidence.summary, 900),
  };
}

function normalizeAiOpportunitySelection(raw = {}, source = 'external_ai', researchContext = null) {
  if (Array.isArray(raw)) raw = { status: raw.length ? 'selected' : 'blocked_no_selection', selected_opportunities: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const confidence = Number(raw.confidence);
  const singleSelectionListingIds = [
    raw.primary_listing_id,
    raw.primaryListingId,
    raw.primary_listing_ids,
    raw.primaryListingIds,
    raw.recommended_listing_id,
    raw.recommendedListingId,
    raw.best_listing_to_feature?.listing_id,
    raw.bestListingToFeature?.listing_id,
    raw.bestListingToFeature?.listingId,
    raw.listing_id,
    raw.listingId,
    raw.listing?.listing_id,
    raw.listing?.id,
    raw.listing_ids,
    raw.listingIds,
    raw.candidate_listing_ids,
    raw.candidateListingIds,
    raw.supporting_listing_ids,
    raw.supportingListingIds,
  ].flatMap(value => Array.isArray(value) ? value : [value]);
  const looksLikeSingleSelection = singleSelectionListingIds.some(Boolean)
    && !Array.isArray(raw.selected_opportunities)
    && !Array.isArray(raw.opportunities)
    && !Array.isArray(raw.selected)
    && !Array.isArray(raw.campaigns)
    && !Array.isArray(raw.recommendations)
    && !raw.selection
    && !['reject', 'rejected', 'blocked', 'mismatch'].includes(socialAiText(raw.decision || raw.status, 80).toLowerCase());
  const selectionSource = Array.isArray(raw.selected_opportunities)
    ? raw.selected_opportunities
    : Array.isArray(raw.opportunities)
      ? raw.opportunities
      : Array.isArray(raw.selected)
        ? raw.selected
        : Array.isArray(raw.campaigns)
          ? raw.campaigns
          : Array.isArray(raw.recommendations)
            ? raw.recommendations
            : Array.isArray(raw.selection)
              ? raw.selection
              : raw.selection && typeof raw.selection === 'object'
                ? [raw.selection]
            : looksLikeSingleSelection
              ? [raw]
              : [];
  const selections = selectionSource
    .map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const listingIdSources = [
        item.primary_listing_id,
        item.primaryListingId,
        item.primary_listing_ids,
        item.primaryListingIds,
        item.recommended_listing_id,
        item.recommendedListingId,
        item.best_listing_to_feature?.listing_id,
        item.bestListingToFeature?.listing_id,
        item.bestListingToFeature?.listingId,
        item.listing_id,
        item.listingId,
        item.listing?.listing_id,
        item.listing?.id,
        item.listing_ids,
        item.listingIds,
        item.candidate_listing_ids,
        item.candidateListingIds,
        item.supporting_listing_ids,
        item.supportingListingIds,
        item.candidates,
      ];
      const listingIds = [...new Set(socialAiStringList(listingIdSources.flatMap(value => Array.isArray(value) ? value : [value]), 12, 120))].slice(0, 8);
      const decision = socialAiText(item.decision || item.status || 'selected', 80).toLowerCase();
      const campaignContext = item.context && typeof item.context === 'object' && !Array.isArray(item.context)
        ? item.context
        : {};
      const listingUnderstandingById = {};
      const indexedUnderstandings = item.listing_understanding_by_id || item.listingUnderstandingById || item.listing_understandings || item.listingUnderstandings;
      if (indexedUnderstandings && typeof indexedUnderstandings === 'object' && !Array.isArray(indexedUnderstandings)) {
        for (const [id, understanding] of Object.entries(indexedUnderstandings)) {
          const normalized = normalizeListingUnderstanding(understanding, 'external_ai_selection');
          const listingId = socialAiText(id, 100);
          if (listingId && normalized) listingUnderstandingById[listingId] = normalized;
        }
      }
      const singleUnderstanding = normalizeListingUnderstanding(
        item.listing_understanding || item.listingUnderstanding || item.best_listing_to_feature?.listing_understanding || item.bestListingToFeature?.listingUnderstanding,
        'external_ai_selection',
      );
      if (singleUnderstanding && listingIds.length === 1 && !listingUnderstandingById[listingIds[0]]) {
        listingUnderstandingById[listingIds[0]] = singleUnderstanding;
      }
      const listingCampaignFitById = {};
      const indexedCampaignFits = item.listing_campaign_fit_by_id
        || item.listingCampaignFitById
        || item.campaign_fit_by_id
        || item.campaignFitById
        || item.listing_campaign_fits
        || item.listingCampaignFits;
      if (indexedCampaignFits && typeof indexedCampaignFits === 'object' && !Array.isArray(indexedCampaignFits)) {
        for (const [id, fit] of Object.entries(indexedCampaignFits)) {
          const normalized = normalizeListingCampaignFit(fit, 'external_ai_selection');
          const listingId = socialAiText(id, 100);
          if (listingId && normalized) listingCampaignFitById[listingId] = normalized;
        }
      }
      const singleCampaignFit = normalizeListingCampaignFit(
        item.listing_campaign_fit || item.listingCampaignFit || item.campaign_fit || item.campaignFit || item.best_listing_to_feature?.listing_campaign_fit || item.bestListingToFeature?.listingCampaignFit,
        'external_ai_selection',
      );
      if (singleCampaignFit && listingIds.length === 1 && !listingCampaignFitById[listingIds[0]]) {
        listingCampaignFitById[listingIds[0]] = singleCampaignFit;
      }
      const timingRaw = item.timing || item.publish_timing || item.publishTiming;
      const scheduledAtByPlatform = timingRaw?.scheduled_at_by_platform || timingRaw?.scheduledAtByPlatform || {};
      const priority = Number(item.priority);
      return {
        id: socialAiText(item.id || item.opportunity_id || `ai_selected_${index + 1}`, 120),
        source_opportunity_id: socialAiText(item.source_opportunity_id || item.sourceOpportunityId || item.source_id || item.raw_signal_id || item.rawSignalId, 160),
        decision: decision || 'selected',
        type: socialAiText(item.type || item.opportunity_type || item.opportunityType || campaignContext.source_opportunity_type || 'ai_selected_opportunity', 100),
        priority: Number.isFinite(priority) && priority >= 1 && priority <= 100
          ? priority
          : null,
        moment: socialAiText(item.moment || item.topic || item.campaign_moment || item.angle || item.recommended_angle || item.recommendedAngle || item.title, 220),
        reason: socialAiText(item.reason || item.reasoning || item.rationale || item.why_it_fits || item.whyItFits || item.why_this_is_natural || item.whyThisIsNatural || item.best_listing_to_feature?.reason || item.bestListingToFeature?.reason, 700),
        audience: socialAiText(item.audience || campaignContext.audience, 260),
        campaign_context: socialAiText(item.campaign_context || item.context_summary || item.recommended_angle || item.recommendedAngle || item.post_angle || item.postAngle || item.post_concept || item.postConcept || item.buyer_facing_angle || item.buyerFacingAngle || campaignContext.campaign_context, 900),
        platforms: socialAiStringList(item.platforms || item.recommended_platforms || item.recommendedPlatforms || item.suggested_platforms || item.suggestedPlatforms, 6, 40)
          .map(platform => platform.toLowerCase())
          .filter(platform => ['instagram', 'facebook', 'pinterest', 'tiktok'].includes(platform)),
        platform_decisions: Object.fromEntries(Object.entries(
          item.platform_decisions && typeof item.platform_decisions === 'object' && !Array.isArray(item.platform_decisions)
            ? item.platform_decisions
            : {},
        ).map(([platform, value]) => {
          const decision = value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : { decision: value };
          return [socialAiText(platform, 40).toLowerCase(), {
            decision: socialAiText(decision.decision || decision.status, 40).toLowerCase(),
            rationale: socialAiText(decision.rationale || decision.reason, 420),
          }];
        }).filter(([platform]) => ['instagram', 'facebook', 'pinterest', 'tiktok'].includes(platform))),
        listing_ids: listingIds,
        review_id: socialAiText(item.review_id || item.reviewId || item.selected_review_id || item.selectedReviewId, 120) || null,
        review_quote: socialAiText(item.review_quote || item.reviewQuote || item.exact_review_quote || item.exactReviewQuote, 900) || null,
        research_basis: socialAiText(item.research_basis, 80).toLowerCase(),
        research_source_ids: socialAiStringList(item.research_source_ids, 8, 80),
        listing_understanding_by_id: listingUnderstandingById,
        listing_campaign_fit_by_id: listingCampaignFitById,
        timing: timingRaw && typeof timingRaw === 'object' && !Array.isArray(timingRaw)
          ? {
            audience_timezone: socialAiText(timingRaw.audience_timezone || timingRaw.audienceTimezone, 100),
            rationale: socialAiText(timingRaw.rationale || timingRaw.reason, 500),
            scheduled_at_by_platform: Object.fromEntries(Object.entries(scheduledAtByPlatform)
              .map(([platform, value]) => [socialAiText(platform, 40).toLowerCase(), socialAiText(value, 80)])
              .filter(([platform, value]) => ['instagram', 'facebook', 'pinterest', 'tiktok'].includes(platform) && value)),
          }
          : null,
        risks: socialAiStringList(item.risks, 8, 160),
        evidence: socialAiStringList(item.evidence, 8, 180),
      };
    })
    .filter(item => item && item.listing_ids.length && !['reject', 'rejected', 'blocked', 'mismatch'].includes(item.decision));
  const rawStatus = socialAiText(raw.status || raw.decision || '', 80).toLowerCase();
  const emptyStatus = rawStatus.startsWith('blocked') || rawStatus.startsWith('no_')
    ? rawStatus
    : 'blocked_no_ai_selected_opportunities';
  return {
    source,
    status: selections.length ? 'selected' : emptyStatus,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    rationale: socialAiText(raw.rationale || raw.reason, 900),
    rejected_signals: (Array.isArray(raw.rejected_signals) ? raw.rejected_signals : [])
      .slice(0, 12)
      .map(item => ({
        id: socialAiText(item?.id || item?.source_opportunity_id || item?.raw_signal_id, 160),
        reason: socialAiText(item?.reason || item?.rationale, 420),
      }))
      .filter(item => item.id || item.reason),
    research_evidence: normalizeAiResearchEvidence(raw, researchContext),
    selections,
  };
}

function aiResponsePreview(value, max = 700) {
  if (typeof value === 'string') return socialAiText(value, max);
  try {
    return socialAiText(JSON.stringify(value), max);
  } catch {
    return socialAiText(value, max);
  }
}

function aiOpportunitySelectionIdentityErrors(
  selections = [],
  rawSignals = [],
  listingSignals = [],
  reviewEvidence = [],
) {
  const allowedListingIds = new Set(listingSignals.map(listing => socialAiText(listing?.listing_id, 100)).filter(Boolean));
  const reviewsById = new Map((Array.isArray(reviewEvidence) ? reviewEvidence : [])
    .map(review => [
      socialAiText(review?.review_id || review?.id, 120),
      socialAiText(review?.text || review?.review || review?.text_preview, 1600),
    ])
    .filter(([reviewId, reviewText]) => Boolean(reviewId && reviewText)));
  const errors = [];
  for (const selection of Array.isArray(selections) ? selections : []) {
    const sourceOpportunityId = socialAiText(selection?.source_opportunity_id, 160);
    const unknownListingIds = (Array.isArray(selection?.listing_ids) ? selection.listing_ids : [])
      .map(id => socialAiText(id, 100))
      .filter(id => id && !allowedListingIds.has(id));
    if (unknownListingIds.length) {
      errors.push({
        code: 'UNKNOWN_LISTING_IDS',
        source_opportunity_id: sourceOpportunityId || null,
        unknown_listing_ids: unknownListingIds,
        allowed_listing_ids: [...allowedListingIds],
      });
    }
    if (!Number.isFinite(Number(selection?.priority))) {
      errors.push({
        code: 'INVALID_AI_PRIORITY',
        source_opportunity_id: sourceOpportunityId || null,
        reason: 'Final AI opportunity priority must be an explicit number from 1 through 100.',
      });
    }
    const reviewId = socialAiText(selection?.review_id, 120);
    if (reviewId) {
      const reviewText = reviewsById.get(reviewId) || '';
      const reviewQuote = socialAiText(selection?.review_quote, 900);
      if (!reviewText) {
        errors.push({
          code: 'UNKNOWN_REVIEW_ID',
          source_opportunity_id: sourceOpportunityId || null,
          review_id: reviewId,
          reason: 'The selected review_id is not present in planning_payload.review_evidence.',
        });
      } else if (!reviewQuote || !reviewText.includes(reviewQuote)) {
        errors.push({
          code: 'INVALID_REVIEW_QUOTE',
          source_opportunity_id: sourceOpportunityId || null,
          review_id: reviewId,
          reason: 'review_quote must be a concise exact substring copied verbatim from the matching review text.',
        });
      }
    }
  }
  return errors;
}

function fallbackAiOpportunityRejections(rawSignals = []) {
  return rawSignals.slice(0, 12).map(signal => ({
    id: signal.id,
    reason: socialAiText(
      `External AI selected no opportunity and did not provide a rejection rationale for ${signal.type || 'raw signal'}: ${signal.moment || signal.id}.`,
      420,
    ),
  }));
}

function researchReviewedContext(researchContext = {}, evidence = {}) {
  if (!evidence?.usable_for_current_event_claims) return {
    status: evidence?.status || 'unverified',
    summary: '',
    researched_at: researchContext.researched_at || '',
    sources: [],
    signals: [],
  };
  const accepted = new Set(evidence.accepted_source_ids || []);
  return {
    ...researchContext,
    status: 'verified',
    summary: evidence.rationale || researchContext.summary || '',
    sources: (researchContext.sources || []).filter(item => accepted.has(item.id)),
  };
}

function socialOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function enforceAiResearchEvidence(normalized = {}, rawSignals = [], researchContext = {}) {
  const evidence = normalized.research_evidence || normalizeAiResearchEvidence({}, researchContext);
  const accepted = new Set(evidence.accepted_source_ids || []);
  const blocked = [];
  const selections = (normalized.selections || []).filter(selection => {
    const basis = socialAiText(selection.research_basis, 80).toLowerCase();
    if (!['verified_current_research', 'shop_evidence', 'evergreen'].includes(basis)) {
      blocked.push({
        id: selection.source_opportunity_id || selection.id,
        reason: 'AI selection is missing the required research_basis decision.',
        code: 'blocked_ai_research_basis',
      });
      return false;
    }
    const cited = [...new Set(selection.research_source_ids || [])];
    if (basis !== 'verified_current_research') {
      if (!cited.length) return true;
      blocked.push({
        id: selection.source_opportunity_id || selection.id,
        reason: `AI marked this selection as ${basis} but attached current-research citations. The evidence basis is inconsistent.`,
        code: 'blocked_ai_research_basis',
      });
      return false;
    }
    const validCitations = cited.filter(id => accepted.has(id));
    if (evidence.usable_for_current_event_claims && validCitations.length >= 2) return true;
    blocked.push({
      id: selection.source_opportunity_id || selection.id,
      reason: evidence.rationale || 'AI did not verify at least two independent research sources for this current-event/trend opportunity.',
      code: 'blocked_unverified_research',
    });
    return false;
  });
  const blockedForResearch = blocked.some(item => item.code === 'blocked_unverified_research');
  return {
    ...normalized,
    selections,
    status: selections.length ? normalized.status : (blocked.length ? (blockedForResearch ? 'blocked_unverified_research' : 'blocked_ai_research_basis') : normalized.status),
    rejected_signals: [...(normalized.rejected_signals || []), ...blocked].slice(0, 12),
    reviewed_current_research: researchReviewedContext(researchContext, evidence),
  };
}

function evaluateSocialResearchEvidenceForTest(raw = {}, currentResearch = {}, rawSignals = []) {
  const researchContext = compactCurrentResearchForAi(currentResearch);
  const normalized = normalizeAiOpportunitySelection(raw, 'unit_ai', researchContext);
  return normalized ? enforceAiResearchEvidence(normalized, rawSignals, researchContext) : null;
}

function listingOperationalSignalsForAi(listing = {}) {
  const mediaItems = Array.isArray(listing.media_items)
    ? listing.media_items
    : (Array.isArray(listing.images) ? listing.images : []).concat((listing.image_urls || []).map(url => ({ url })));
  return {
    listing_id: socialAiText(listing.listing_id || listing.id, 100),
    title: socialAiText(listing.title || listing.listing_title, 180),
    description: socialAiText(listing.description || listing.description_plain || listing.body, 900),
    tags: socialAiStringList(listing.tags, 12, 80),
    taxonomy: socialAiText(listing.taxonomy_path || listing.category || listing.taxonomy || listing.section, 220),
    listing_type: socialAiText(listing.listing_type || listing.type, 80),
    price: socialAiText(listing.price || listing.amount, 40),
    url: socialAiText(listing.url || listing.listing_url, 1000),
    media_count: mediaItems.length || (listing.image_url ? 1 : 0),
    media_hints: mediaItems.slice(0, 5).map((item, index) => ({
      rank: item.rank || index + 1,
      alt: socialAiText(item.alt || item.alt_text || item.title || item.caption || item.description, 180),
      source: socialAiText(item.source || item.role || item.kind, 80),
      width: item.width || item.full_width || null,
      height: item.height || item.full_height || null,
    })),
    views: Number(listing.views || listing.view_count || listing.performance_signals?.views || 0) || 0,
    favorites: Number(listing.num_favorers || listing.favorites || listing.favorers || listing.performance_signals?.favorites || 0) || 0,
    recent_orders_90d: socialOptionalNumber(listing.recent_orders ?? listing.recent_order_count ?? listing.orders_90d ?? listing.performance_signals?.recent_orders_90d),
    recent_units_90d: socialOptionalNumber(listing.recent_units ?? listing.units_90d ?? listing.performance_signals?.recent_units_90d),
    recent_revenue_usd_90d: socialOptionalNumber(listing.recent_revenue_usd ?? listing.revenue_90d ?? listing.performance_signals?.recent_revenue_usd_90d),
    last_order_at: socialAiText(listing.last_order_at || listing.performance_signals?.last_order_at, 80),
    receipts_data_complete: listing.performance_signals?.receipts_data_complete === true,
    receipts_current_fetch_complete: listing.performance_signals?.receipts_current_fetch_complete === true,
    receipts_data_observed_at: socialAiText(listing.performance_signals?.receipts_data_observed_at, 80) || null,
    listing_understanding: listing.listing_understanding && typeof listing.listing_understanding === 'object'
      ? {
        what_is_sold: socialAiText(listing.listing_understanding.what_is_sold, 220),
        buyer_use_case: socialAiText(listing.listing_understanding.buyer_use_case, 260),
        marketing_angle: socialAiText(listing.listing_understanding.marketing_angle, 260),
        target_buyer: socialAiText(listing.listing_understanding.target_buyer, 180),
      }
      : null,
  };
}

function compactListingForOpportunityRetrieval(listing = {}) {
  return {
    listing_id: socialAiText(listing.listing_id, 100),
    title: socialAiText(listing.title, 180),
    description: socialAiText(listing.description, 220),
    tags: socialAiStringList(listing.tags, 6, 60),
    taxonomy: socialAiText(listing.taxonomy, 120),
    listing_type: socialAiText(listing.listing_type, 60),
    price: socialAiText(listing.price, 40),
    media_count: Number(listing.media_count) || 0,
    media_hints: (listing.media_hints || []).slice(0, 2).map(item => ({
      rank: Number(item?.rank) || null,
      alt: socialAiText(item?.alt, 120),
      source: socialAiText(item?.source, 60),
    })),
    views: socialOptionalNumber(listing.views),
    favorites: socialOptionalNumber(listing.favorites),
    recent_orders_90d: socialOptionalNumber(listing.recent_orders_90d),
    recent_units_90d: socialOptionalNumber(listing.recent_units_90d),
    recent_revenue_usd_90d: socialOptionalNumber(listing.recent_revenue_usd_90d),
    last_order_at: socialAiText(listing.last_order_at, 80) || null,
    receipts_data_complete: listing.receipts_data_complete === true,
    receipts_current_fetch_complete: listing.receipts_current_fetch_complete === true,
    listing_understanding: listing.listing_understanding
      ? {
        what_is_sold: socialAiText(listing.listing_understanding.what_is_sold, 180),
        buyer_use_case: socialAiText(listing.listing_understanding.buyer_use_case, 180),
        target_buyer: socialAiText(listing.listing_understanding.target_buyer, 140),
      }
      : null,
  };
}

function opportunityRawSignalForAi(opportunity = {}) {
  return {
    id: socialAiText(opportunity.id, 160),
    type: socialAiText(opportunity.type, 100),
    priority: Number(opportunity.priority) || 0,
    moment: socialAiText(opportunity.moment, 220),
    reason: socialAiText(opportunity.reason, 700),
    timing: opportunity.timing && typeof opportunity.timing === 'object' ? opportunity.timing : null,
    context: {
      occasion: socialAiText(opportunity.context?.occasion, 220),
      audience: socialAiText(opportunity.context?.audience, 260),
      campaign_context: socialAiText(opportunity.context?.campaign_context, 900),
      source_opportunity_type: socialAiText(opportunity.context?.source_opportunity_type, 100),
    },
    candidate_listing_ids: (Array.isArray(opportunity.listing_candidates) ? opportunity.listing_candidates : [])
      .map(item => socialAiText(item?.listing_id || item?.id, 100))
      .filter(Boolean)
      .slice(0, 5000),
  };
}

function compactReviewEvidenceForAi(review = {}) {
  return {
    review_id: socialAiText(review.review_id || review.id, 120),
    listing_id: socialAiText(review.listing_id, 100),
    rating: Number(review.rating || review.stars) || null,
    text: socialAiText(review.text || review.review || review.text_preview, 1600),
    has_photo: Boolean(review.has_photo || review.review_image_url || review.image_url),
    review_image_url: socialAiText(review.review_image_url || review.image_url, 1000) || null,
    created_at: socialAiText(review.created_at, 80) || null,
  };
}

function rawSignalsForListingIds(rawSignals = [], listingIds = new Set()) {
  return rawSignals.map(signal => ({
    ...signal,
    candidate_listing_ids: signal.candidate_listing_ids.filter(id => listingIds.has(id)),
  })).filter(signal => signal.candidate_listing_ids.length);
}

  return {
    aiOpportunitySelectionIdentityErrors,
    aiResponsePreview,
    compactCurrentResearchForAi,
    compactListingForOpportunityRetrieval,
    compactReviewEvidenceForAi,
    enforceAiResearchEvidence,
    evaluateSocialResearchEvidenceForTest,
    fallbackAiOpportunityRejections,
    listingOperationalSignalsForAi,
    normalizeAiOpportunitySelection,
    normalizeListingCampaignFit,
    normalizeListingUnderstanding,
    opportunityRawSignalForAi,
    opportunitySelectionOutputSchema,
    rawSignalsForListingIds,
    researchReviewedContext,
    socialAiStringList,
    socialAiText,
    socialCurrentDateContext,
    socialHermesCampaignFitAllowsSelection,
  };
}
