import crypto from 'node:crypto';

export function createSocialContentOpportunityFitFilter({
  contracts,
  selectContentOpportunities,
  isAiConfigured,
  buildListingCampaignFit,
} = {}) {
  for (const [name, dependency] of Object.entries({ selectContentOpportunities, isAiConfigured, buildListingCampaignFit })) {
    if (typeof dependency !== 'function') throw new TypeError(`${name} dependency is required`);
  }
  if (!contracts || typeof contracts !== 'object') throw new TypeError('contracts dependency is required');
  const {
    compactCurrentResearchForAi,
    normalizeListingCampaignFit,
    normalizeListingUnderstanding,
    researchReviewedContext,
    socialAiText,
    socialCurrentDateContext,
    socialHermesCampaignFitAllowsSelection,
  } = contracts;
  const hasExternalAiConfigAsync = isAiConfigured;
  const selectContentOpportunitiesWithAi = selectContentOpportunities;
  const buildListingCampaignFitWithAi = buildListingCampaignFit;

function sourceListingById(listings = []) {
  const map = new Map();
  for (const listing of Array.isArray(listings) ? listings : []) {
    const id = socialAiText(listing?.listing_id || listing?.id, 100);
    if (id && !map.has(id)) map.set(id, listing);
  }
  return map;
}

async function applyAiSemanticFitToContentOpportunities({
  suggestions = {},
  sourceListings = [],
  visualAnalysis = null,
  currentResearch = null,
  now = Date.now(),
  aiCandidateLimit = 12,
  maxOpportunities = 2,
} = {}) {
  const configured = await hasExternalAiConfigAsync().catch(() => false);
  const baseMeta = {
    available: configured,
    applied: false,
    source: configured ? 'external_ai' : 'ai_unavailable',
    evaluated_candidates: 0,
    rejected_candidates: 0,
    note: configured
      ? 'AI semantic campaign/listing fit is available.'
      : 'External text AI is required for autonomous contentOpportunities. Local shop signals are facts only, not post decisions.',
  };
  if (!configured) return {
    ...suggestions,
    status: 'blocked_ai_required',
    opportunities: [],
    external_ai_semantic_fit_used: false,
    ai_semantic_selection: {
      ...baseMeta,
      required: true,
      applied: false,
    },
    honesty_note: 'Autonomous social post selection requires external AI semantic reasoning. Etsy AI Command Center collected local shop signals, but did not return post candidates because AI was unavailable.',
    recommended_next_action: 'Configure external text AI and run contentOpportunities again. Do not use local keyword/scoring output as an autonomous post idea.',
  };

  const listingsById = sourceListingById(sourceListings);
  const dateContext = socialCurrentDateContext(now);
  const researchContext = compactCurrentResearchForAi(currentResearch || {});
  const opportunitySelection = await selectContentOpportunitiesWithAi({
    suggestions,
    sourceListings,
    currentResearch,
    now,
    maxOpportunities,
  });
  const reviewedResearchContext = opportunitySelection.reviewed_current_research
    || researchReviewedContext(researchContext, opportunitySelection.research_evidence);
  const researchAvailable = Boolean(reviewedResearchContext.summary || reviewedResearchContext.sources.length || reviewedResearchContext.signals.length);
  if (!opportunitySelection.available || !opportunitySelection.selections?.length) {
    return {
      ...suggestions,
      status: opportunitySelection.status || 'blocked_no_ai_opportunity_selection',
      opportunities: [],
      external_research_used: researchAvailable,
      external_ai_semantic_fit_used: false,
      ai_opportunity_selection: {
        required: true,
        applied: Boolean(opportunitySelection.available),
        source: opportunitySelection.source,
        status: opportunitySelection.status,
        reason: opportunitySelection.reason || opportunitySelection.rationale || '',
        selected_count: 0,
        rejected_signals: opportunitySelection.rejected_signals || [],
        diagnostics: opportunitySelection.diagnostics || null,
        research_evidence: opportunitySelection.research_evidence || null,
      },
      ai_semantic_selection: {
        ...baseMeta,
        required: true,
        applied: false,
      },
      honesty_note: 'Autonomous social opportunity selection requires external AI reasoning. Etsy AI Command Center collected shop/queue signals, but did not return post candidates because AI did not select a usable opportunity.',
      recommended_next_action: opportunitySelection.source === 'ai_unavailable'
        ? 'Configure external text AI and run contentOpportunities again. Do not use local keyword/scoring output as an autonomous post idea.'
        : 'Retry with stronger current research/shop context or ask Social Hermes for a different angle; local signals were not promoted into a post idea.',
    };
  }
  const rawOpportunitiesById = new Map((Array.isArray(suggestions.opportunities) ? suggestions.opportunities : [])
    .map(opportunity => [socialAiText(opportunity.id, 160), opportunity]));
  // Resolve AI-selected IDs against the complete Etsy inventory supplied to
  // the model. Raw opportunity groups are campaign evidence, not a second,
  // narrower inventory boundary.
  const candidateById = sourceListingById(sourceListings);
  for (const opportunity of Array.isArray(suggestions.opportunities) ? suggestions.opportunities : []) {
    for (const candidate of Array.isArray(opportunity.listing_candidates) ? opportunity.listing_candidates : []) {
      const id = socialAiText(candidate.listing_id || candidate.id, 100);
      if (id && !candidateById.has(id)) candidateById.set(id, candidate);
    }
  }
  const reviewById = new Map((Array.isArray(suggestions.review_evidence) ? suggestions.review_evidence : [])
    .map(review => [socialAiText(review?.review_id || review?.id, 120), review])
    .filter(([id]) => Boolean(id)));
  const aiSelectedOpportunities = opportunitySelection.selections.map((selection, index) => {
    const rawOpportunity = rawOpportunitiesById.get(selection.source_opportunity_id) || {};
    const selectedMoment = selection.moment
      || selection.campaign_context
      || selection.reason
      || 'AI-selected shop opportunity';
    const selectedReason = selection.reason;
    const selectedCampaignContext = selection.campaign_context
      || selection.reason;
    const selectedCandidates = selection.listing_ids
      .map(id => candidateById.get(id))
      .filter(Boolean);
    const selectedReview = selection.review_id ? reviewById.get(selection.review_id) : null;
    const selectedReviewText = socialAiText(selectedReview?.text || selectedReview?.review || selectedReview?.text_preview, 2000);
    const selectedReviewQuote = socialAiText(selection.review_quote, 900);
    // The model chooses the review evidence by stable ID. Bind the public
    // excerpt only when it is present verbatim in the Etsy review.
    const exactReviewQuote = selection.review_id
      && selectedReviewText
      && selectedReviewQuote
      && selectedReviewText.includes(selectedReviewQuote)
      ? selectedReviewQuote
      : null;
    const reviewEvidenceValid = !selection.review_id || Boolean(selectedReview && exactReviewQuote);
    return {
      ...rawOpportunity,
      id: `ai_${crypto.createHash('sha256').update(`${selection.source_opportunity_id || index}\0${selectedMoment}\0${selection.listing_ids.join(',')}`).digest('hex').slice(0, 12)}`,
      type: selection.type || rawOpportunity.type || 'ai_selected_opportunity',
      priority: selection.priority || rawOpportunity.priority || 50,
      moment: selectedMoment,
      reason: selectedReason || opportunitySelection.rationale || '',
      research_basis: selection.research_basis,
      research_source_ids: selection.research_source_ids,
      timing: selection.timing,
      suggested_platforms: selection.platforms,
      platform_decisions: selection.platform_decisions,
      context: {
        ...(rawOpportunity.context || {}),
        occasion: selectedMoment || rawOpportunity.context?.occasion || '',
        audience: selection.audience || rawOpportunity.context?.audience || '',
        campaign_context: selectedCampaignContext,
        research_basis: selection.research_basis,
        research_source_ids: selection.research_source_ids,
        timing: selection.timing,
        source_opportunity_type: selection.type || rawOpportunity.type || 'ai_selected_opportunity',
        selected_review: selectedReview && exactReviewQuote
          ? {
            review_id: selection.review_id,
            listing_id: socialAiText(selectedReview.listing_id, 100),
            rating: Number(selectedReview.rating) || null,
            exact_quote: exactReviewQuote,
            has_photo: Boolean(selectedReview.has_photo || selectedReview.review_image_url),
            review_image_url: socialAiText(selectedReview.review_image_url, 1000) || null,
            created_at: socialAiText(selectedReview.created_at, 80) || null,
          }
          : null,
        ai_opportunity_selection: {
          source: opportunitySelection.source,
          confidence: opportunitySelection.confidence,
          rationale: opportunitySelection.rationale,
          evidence: selection.evidence,
          risks: selection.risks,
        },
      },
      ai_opportunity_selection: {
        source: opportunitySelection.source,
        source_opportunity_id: selection.source_opportunity_id,
        confidence: opportunitySelection.confidence,
        rationale: opportunitySelection.rationale,
        selection_reason: selection.reason,
        evidence: selection.evidence,
        risks: selection.risks,
      },
      ai_selected_listing_understanding_by_id: selection.listing_understanding_by_id || {},
      ai_selected_listing_campaign_fit_by_id: selection.listing_campaign_fit_by_id || {},
      review_evidence_valid: reviewEvidenceValid,
      listing_candidates: selectedCandidates,
    };
  }).filter(opportunity => opportunity.listing_candidates.length && opportunity.review_evidence_valid);
  if (!aiSelectedOpportunities.length) {
    const unresolvedListingIds = [...new Set(opportunitySelection.selections
      .flatMap(selection => selection.listing_ids || [])
      .filter(id => !candidateById.has(id)))];
    const selectionResolution = opportunitySelection.selections.map(selection => {
      const selectedReview = selection.review_id ? reviewById.get(selection.review_id) : null;
      const reviewText = socialAiText(selectedReview?.text || selectedReview?.review || selectedReview?.text_preview, 2000);
      return {
        source_opportunity_id: selection.source_opportunity_id,
        listing_ids: selection.listing_ids,
        resolved_listing_count: selection.listing_ids.filter(id => candidateById.has(id)).length,
        review_id: selection.review_id,
        review_exists: Boolean(selectedReview),
        exact_review_quote_match: Boolean(!selection.review_id || (reviewText && selection.review_quote && reviewText.includes(selection.review_quote))),
        exact_review_text_bound_by_id: Boolean(selection.review_id && reviewText),
      };
    });
    const hasInvalidReviewEvidence = selectionResolution.some(item => item.review_id && !item.exact_review_quote_match);
    const resolutionStatus = hasInvalidReviewEvidence
      ? 'blocked_ai_selection_review_evidence'
      : 'blocked_ai_selection_missing_candidates';
    return {
      ...suggestions,
      status: resolutionStatus,
      opportunities: [],
      external_research_used: researchAvailable,
      external_ai_semantic_fit_used: false,
      ai_opportunity_selection: {
        required: true,
        applied: true,
        source: opportunitySelection.source,
        status: resolutionStatus,
        selected_count: opportunitySelection.selections.length,
        reason: hasInvalidReviewEvidence
          ? 'AI selected review evidence but its quote was not an exact excerpt of the Etsy review.'
          : 'AI selected opportunity ids that are not present in the returned shop candidate set.',
        diagnostics: {
          ...(opportunitySelection.diagnostics || {}),
          unresolved_listing_ids: unresolvedListingIds,
          available_listing_count: candidateById.size,
          selection_resolution: selectionResolution,
        },
      },
      ai_semantic_selection: {
        ...baseMeta,
        required: true,
        applied: false,
      },
      honesty_note: hasInvalidReviewEvidence
        ? 'External AI selected a review opportunity, but the proposed quote was not an exact Etsy review excerpt.'
        : 'External AI selected an opportunity, but no selected listing candidates could be resolved from Etsy AI Command Center facts.',
      recommended_next_action: hasInvalidReviewEvidence
        ? 'Retry AI opportunity selection with the exact supplied review text; paraphrased or fabricated review quotes are not used.'
        : 'Refresh shop context and retry contentOpportunities; unresolved AI selections are not used for autonomous posting.',
    };
  }
  const maxEvaluations = Math.max(1, Math.min(40, Number(aiCandidateLimit) || 12));
  const desiredOpportunities = Math.max(1, Math.min(8, Number(maxOpportunities) || 2));
  const requireListingUnderstanding = Boolean(suggestions.require_listing_understanding || suggestions.requireListingUnderstanding);
  let evaluated = 0;
  let rejected = 0;
  const opportunities = [];
  const allRejectedCandidates = [];

  for (const opportunity of aiSelectedOpportunities) {
    if (opportunities.length >= desiredOpportunities) break;
    const enrichedCandidates = [];
    const rejectedCandidates = [];
    const campaignContext = {
      ...dateContext,
      ...(opportunity.context || {}),
      moment: opportunity.moment,
      reason: opportunity.reason,
      current_research: researchAvailable && opportunity.research_basis === 'verified_current_research'
        ? reviewedResearchContext
        : null,
      source_opportunity: {
        type: opportunity.type,
        moment: opportunity.moment,
        reason: opportunity.reason,
        label: opportunity.moment,
        source: 'etsy_manager_content_opportunities',
      },
    };

    for (const candidate of Array.isArray(opportunity.listing_candidates) ? opportunity.listing_candidates : []) {
      if (evaluated >= maxEvaluations) {
        rejectedCandidates.push({
          listing_id: socialAiText(candidate.listing_id || candidate.id, 100),
          title: socialAiText(candidate.title, 180),
          decision: 'not_evaluated_limit',
          confidence: null,
          rationale: `AI semantic fit limit reached after ${maxEvaluations} candidates; unevaluated candidates are not returned for autonomous posting.`,
        });
        continue;
      }
      const listingId = socialAiText(candidate.listing_id || candidate.id, 100);
      const fullListing = listingsById.get(listingId) || candidate;
      let listingUnderstanding = normalizeListingUnderstanding(
        fullListing.listing_understanding
          || candidate.listing_understanding
          || opportunity.ai_selected_listing_understanding_by_id?.[listingId],
        'candidate_supplied',
      );
      let campaignFit = normalizeListingCampaignFit(
        fullListing.listing_campaign_fit
          || candidate.listing_campaign_fit
          || fullListing.campaign_fit
          || candidate.campaign_fit
          || opportunity.ai_selected_listing_campaign_fit_by_id?.[listingId],
        'candidate_supplied',
      );
      if (requireListingUnderstanding && !listingUnderstanding) {
        evaluated += 1;
        rejected += 1;
        rejectedCandidates.push({
          listing_id: listingId,
          title: socialAiText(candidate.title, 180),
          decision: 'unverified_listing_understanding',
          confidence: null,
          rationale: 'AI opportunity selection did not provide a usable listing understanding; autonomous factory will not pass this candidate to creativePlan.',
        });
        continue;
      }
      const listingForFit = listingUnderstanding
        ? { ...fullListing, listing_understanding: listingUnderstanding }
        : fullListing;
      if (!campaignFit) {
        campaignFit = await buildListingCampaignFitWithAi({
          listing: listingForFit,
          listingUnderstanding,
          context: campaignContext,
        });
      }
      evaluated += 1;

      const enrichedCandidate = {
        // Return the complete Etsy AI Command Center listing facts to downstream
        // creativePlan. The AI selector's compact candidate identifies the
        // choice, but must not discard description/gallery/performance context.
        ...fullListing,
        ...candidate,
        ...(listingUnderstanding ? { listing_understanding: listingUnderstanding } : {}),
        ...(campaignFit ? { listing_campaign_fit: campaignFit, ai_semantic_fit: campaignFit } : {}),
      };
      if (socialHermesCampaignFitAllowsSelection(campaignFit)) {
        enrichedCandidates.push(enrichedCandidate);
        break;
      }
      else {
        rejected += 1;
        rejectedCandidates.push({
          listing_id: listingId,
          title: socialAiText(candidate.title, 180),
          decision: socialAiText(campaignFit?.decision || campaignFit?.fit || campaignFit?.status, 80),
          confidence: campaignFit?.confidence ?? null,
          rationale: socialAiText(
            campaignFit?.raw_preview && campaignFit?.reason === 'External AI did not return a usable campaign-fit decision.'
              ? `${campaignFit.reason} raw_preview=${campaignFit.raw_preview}`
              : (campaignFit?.rationale || campaignFit?.reason || campaignFit?.raw_preview),
            900,
          ),
        });
      }
    }
    allRejectedCandidates.push(...rejectedCandidates);

    if (enrichedCandidates.length) {
      opportunities.push({
        ...opportunity,
        listing_candidates: enrichedCandidates,
        ai_semantic_selection: {
          source: 'external_ai',
          evaluated_candidates: Math.min(evaluated, maxEvaluations),
          rejected_candidates: rejectedCandidates.length,
          rejected: rejectedCandidates,
          note: 'Candidates were filtered by AI semantic campaign/listing fit before being returned to Social Hermes.',
        },
      });
    }
  }

  return {
    ...suggestions,
    status: opportunities.length ? suggestions.status : 'blocked_no_ai_semantic_fit',
    opportunities,
    external_research_used: researchAvailable,
    external_ai_semantic_fit_used: true,
    ai_opportunity_selection: {
      required: true,
      applied: true,
      source: opportunitySelection.source,
      status: opportunitySelection.status,
      confidence: opportunitySelection.confidence,
      rationale: opportunitySelection.rationale,
      selected_count: aiSelectedOpportunities.length,
      rejected_signals: opportunitySelection.rejected_signals || [],
      diagnostics: opportunitySelection.diagnostics || null,
      research_evidence: opportunitySelection.research_evidence || null,
      repair_used: opportunitySelection.repair_used === true,
      repair_note: opportunitySelection.repair_note || '',
      note: 'External AI selected campaign opportunities from Etsy AI Command Center raw shop/queue signals before per-listing campaign-fit checks ran.',
    },
    ai_semantic_selection: {
      ...baseMeta,
      applied: true,
      evaluated_candidates: evaluated,
      rejected_candidates: rejected,
      rejected: allRejectedCandidates.slice(0, 20),
      note: 'External AI selected contentOpportunities by semantic campaign/listing fit from unranked shop facts and operational constraints.',
    },
    honesty_note: researchAvailable
      ? 'These are Etsy AI Command Center shop/queue signals filtered by external AI semantic campaign/listing fit with supplied current research context.'
      : 'These are Etsy AI Command Center shop/queue signals filtered by external AI semantic campaign/listing fit. No live web/current-event research context was supplied.',
    recommended_next_action: 'Social Hermes should use an AI-filtered opportunity as input to creativePlan, then generate/persist media if required and get owner approval before save/schedule.',
  };
}

  return applyAiSemanticFitToContentOpportunities;
}
