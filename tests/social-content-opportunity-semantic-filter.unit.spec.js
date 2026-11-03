import { expect, test } from '@playwright/test';

import { createSocialContentOpportunitySemanticFilter } from '../api/modules/social/index.js';

const STRONG_FIT = Object.freeze({
  decision: 'strong_fit',
  should_use_listing: true,
  confidence: 0.92,
  rationale: 'The supplied listing facts directly support this buyer-facing angle.',
  natural_connection: 'direct listing spotlight',
  safer_angle: 'stay factual',
  risks: [],
  evidence: ['listing facts'],
});

function normalizeCampaignFit(value, source = 'unit') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!['strong_fit', 'acceptable_fit', 'weak_fit', 'mismatch'].includes(value.decision)) return null;
  if (typeof value.should_use_listing !== 'boolean') return null;
  return { ...value, source: value.source || source };
}

function normalizeListingUnderstanding(value, source = 'unit') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.what_is_sold) return null;
  return { ...value, source: value.source || source };
}

function listing(id, overrides = {}) {
  return {
    listing_id: id,
    title: `Listing ${id}`,
    description: `Factual description for ${id}.`,
    url: `https://www.etsy.com/listing/${id}`,
    views: 100,
    num_favorers: 12,
    recent_orders: 2,
    media_items: [{ url: `https://img.example.test/${id}.jpg`, width: 1600, height: 2000 }],
    ...overrides,
  };
}

function suggestions(listings, overrides = {}) {
  return {
    status: 'ready',
    configured_platforms: ['instagram'],
    opportunities: [{
      id: 'signal-1',
      type: 'listing_signal',
      moment: 'Raw operational moment',
      reason: 'Recent shop evidence deserves semantic review.',
      context: { campaign_context: 'Choose a truthful buyer-facing listing spotlight.' },
      listing_candidates: listings,
    }],
    review_evidence: [],
    ...overrides,
  };
}

function selection(overrides = {}) {
  const listingId = overrides.listing_id || 'listing-1';
  const includeFit = overrides.include_fit !== false;
  return {
    source_opportunity_id: 'signal-1',
    type: 'evergreen_listing_spotlight',
    moment: 'AI-selected buyer story',
    reason: 'The listing facts support a useful evergreen spotlight.',
    audience: 'Etsy buyers',
    campaign_context: 'Show one truthful buyer result from the supplied listing.',
    platforms: ['instagram'],
    platform_decisions: {
      instagram: { decision: 'include', rationale: 'The supplied media supports a visual post.' },
    },
    listing_ids: [listingId],
    priority: 90,
    evidence: ['listing facts'],
    risks: [],
    research_basis: 'evergreen',
    research_source_ids: [],
    ...(includeFit ? { listing_campaign_fit_by_id: { [listingId]: { ...STRONG_FIT } } } : {}),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['listing_id', 'include_fit'].includes(key))),
  };
}

function selectedResponse(item = selection(), overrides = {}) {
  return {
    status: 'selected',
    confidence: 0.91,
    rationale: 'AI selected the strongest supplied opportunity.',
    selected_opportunities: [item],
    rejected_signals: [],
    ...overrides,
  };
}

function semanticHarness({ responses = {}, buildFit = async () => ({ ...STRONG_FIT }) } = {}) {
  const calls = [];
  const queues = Object.fromEntries(Object.entries(responses).map(([task, values]) => [
    task,
    Array.isArray(values) ? [...values] : [values],
  ]));
  let fitCalls = 0;
  const filter = createSocialContentOpportunitySemanticFilter({
    generateWithAi: async (system, user, schema, options = {}) => {
      const call = { system, payload: JSON.parse(user), schema, task: options.task || '' };
      calls.push(call);
      const queue = queues[call.task] || [];
      if (!queue.length) throw new Error(`No AI response configured for ${call.task}`);
      const next = queue.shift();
      return typeof next === 'function' ? next(call) : next;
    },
    isAiConfigured: async () => true,
    normalizeListingUnderstanding,
    normalizeListingCampaignFit: normalizeCampaignFit,
    normalizeOwnerFeedbackMemory: value => value || { schema_version: 1, items: [] },
    buildListingCampaignFit: async input => {
      fitCalls += 1;
      return buildFit(input);
    },
  });
  return { calls, filter, fitCallCount: () => fitCalls };
}

test('semantic filter reuses AI-supplied campaign fit without a second fit call', async () => {
  const sourceListings = [listing('listing-1')];
  const { calls, filter, fitCallCount } = semanticHarness({
    responses: { opportunity_final_selection: selectedResponse() },
  });

  const result = await filter.applySemanticFit({
    suggestions: suggestions(sourceListings),
    sourceListings,
    now: '2026-08-09T12:00:00.000Z',
  });

  expect(result.status).toBe('ready');
  expect(result.opportunities[0].listing_candidates[0].listing_campaign_fit).toMatchObject(STRONG_FIT);
  expect(result.ai_semantic_selection).toMatchObject({ applied: true, evaluated_candidates: 1, rejected_candidates: 0 });
  expect(fitCallCount()).toBe(0);
  expect(calls.map(call => call.task)).toEqual(['opportunity_final_selection']);
});

test('semantic filter rejects an AI-selected listing when the owning fit dependency returns mismatch', async () => {
  const sourceListings = [listing('listing-1')];
  const { filter, fitCallCount } = semanticHarness({
    responses: { opportunity_final_selection: selectedResponse(selection({ include_fit: false })) },
    buildFit: async () => ({
      ...STRONG_FIT,
      decision: 'mismatch',
      should_use_listing: false,
      rationale: 'The campaign moment is not naturally connected to this listing.',
    }),
  });

  const result = await filter.applySemanticFit({ suggestions: suggestions(sourceListings), sourceListings });

  expect(result.status).toBe('blocked_no_ai_semantic_fit');
  expect(result.opportunities).toEqual([]);
  expect(result.ai_semantic_selection.rejected[0]).toMatchObject({
    listing_id: 'listing-1',
    decision: 'mismatch',
  });
  expect(fitCallCount()).toBe(1);
});

test('semantic selection repair rebinds an unknown listing id to an exact supplied candidate', async () => {
  const sourceListings = [listing('listing-1')];
  const { calls, filter } = semanticHarness({
    responses: {
      opportunity_final_selection: selectedResponse(selection({ listing_id: 'invented-listing' })),
      opportunity_final_selection_repair: selectedResponse(selection({ listing_id: 'listing-1' })),
    },
  });

  const result = await filter.applySemanticFit({ suggestions: suggestions(sourceListings), sourceListings });

  expect(result.status).toBe('ready');
  expect(result.opportunities[0].listing_candidates[0].listing_id).toBe('listing-1');
  expect(result.ai_opportunity_selection).toMatchObject({ repair_used: true, selected_count: 1 });
  expect(calls.map(call => call.task)).toEqual([
    'opportunity_final_selection',
    'opportunity_final_selection_repair',
  ]);
  expect(calls[1].payload.repair_trigger).toBe('selection_identity_validation');
  expect(calls[1].payload.validation_errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'UNKNOWN_LISTING_IDS', unknown_listing_ids: ['invented-listing'] }),
  ]));
});

test('semantic selection fails closed when repair keeps an unknown listing id', async () => {
  const sourceListings = [listing('listing-1')];
  const { filter } = semanticHarness({
    responses: {
      opportunity_final_selection: selectedResponse(selection({ listing_id: 'invented-listing' })),
      opportunity_final_selection_repair: selectedResponse(selection({ listing_id: 'still-invented' })),
    },
  });

  const result = await filter.applySemanticFit({ suggestions: suggestions(sourceListings), sourceListings });

  expect(result.status).toBe('blocked_ai_selection_identity');
  expect(result.opportunities).toEqual([]);
  expect(result.ai_opportunity_selection.diagnostics.selection_identity_validation_errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_LISTING_IDS' })]),
  );
});

test('semantic selection repairs malformed prose into a strict opportunity decision', async () => {
  const sourceListings = [listing('listing-1')];
  const { calls, filter } = semanticHarness({
    responses: {
      opportunity_final_selection: 'I would feature listing-1 because the evidence looks strong.',
      opportunity_final_selection_repair: selectedResponse(),
    },
  });

  const result = await filter.applySemanticFit({ suggestions: suggestions(sourceListings), sourceListings });

  expect(result.status).toBe('ready');
  expect(result.ai_opportunity_selection.repair_used).toBe(true);
  expect(calls[1].payload.repair_trigger).toBe('invalid_schema');
  expect(calls[1].payload.previous_response).toContain('feature listing-1');
});

test('semantic selection keeps the AI-selected public angle instead of the raw signal moment', async () => {
  const sourceListings = [listing('listing-1')];
  const { filter } = semanticHarness({
    responses: {
      opportunity_final_selection: selectedResponse(selection({
        moment: 'Useful evergreen care guide',
        reason: 'A non-calendar educational angle is more truthful for this listing.',
      })),
    },
  });

  const result = await filter.applySemanticFit({ suggestions: suggestions(sourceListings), sourceListings });

  expect(result.opportunities[0].moment).toBe('Useful evergreen care guide');
  expect(result.opportunities[0].moment).not.toBe('Raw operational moment');
});

test('semantic selection accepts array-shaped recommendation aliases without local winner selection', async () => {
  const sourceListings = [listing('listing-1'), listing('listing-2')];
  const { filter, fitCallCount } = semanticHarness({
    responses: {
      opportunity_final_selection: [[{
        selected: true,
        opportunity_id: 'signal-1',
        priority: 88,
        type: 'listing_signal',
        primary_listing_ids: ['listing-2'],
        research_basis: 'shop_evidence',
        research_source_ids: [],
        best_listing_to_feature: {
          listing_id: 'listing-2',
          reason: 'The second listing has the clearest supplied buyer evidence.',
        },
        angle: 'Focused shop spotlight',
        why_this_is_natural: 'The supplied facts support it.',
        buyer_facing_angle: 'Show the buyer result.',
      }]],
    },
  });

  const result = await filter.applySemanticFit({ suggestions: suggestions(sourceListings), sourceListings });

  expect(result.status).toBe('ready');
  expect(result.opportunities[0].listing_candidates[0].listing_id).toBe('listing-2');
  expect(fitCallCount()).toBe(1);
});

test('semantic selection repairs an empty decision into explicit readable rejection diagnostics', async () => {
  const sourceListings = [listing('listing-1')];
  const { calls, filter } = semanticHarness({
    responses: {
      opportunity_final_selection: {
        status: 'blocked',
        rationale: '',
        selected_opportunities: [],
        rejected_signals: [],
      },
      opportunity_final_selection_repair: {
        status: 'blocked_no_natural_fit',
        confidence: 0.86,
        rationale: 'The supplied listing evidence does not support a useful public angle yet.',
        selected_opportunities: [],
        rejected_signals: [{ id: 'signal-1', reason: 'No natural buyer-facing connection.' }],
      },
    },
  });

  const result = await filter.applySemanticFit({ suggestions: suggestions(sourceListings), sourceListings });

  expect(result.status).toBe('blocked_no_natural_fit');
  expect(result.opportunities).toEqual([]);
  expect(result.ai_opportunity_selection).toMatchObject({
    source: 'external_ai_repair',
    rejected_signals: [expect.objectContaining({ id: 'signal-1' })],
  });
  expect(calls[1].payload.repair_trigger).toBe('empty_without_rationale');
});

test('research evidence blocks noisy current-event claims without a domain blacklist', () => {
  const { filter } = semanticHarness();
  const currentResearch = {
    status: 'researched',
    sources: [
      { id: 'market-home', title: 'Marketplace homepage', url: 'https://market.example.test/' },
      { id: 'finance-page', title: 'Company quote', url: 'https://finance.example.test/company' },
    ],
  };
  const result = filter.evaluateResearchEvidence({
    status: 'selected',
    rationale: 'The pages do not verify a buyer trend.',
    research_evidence: {
      status: 'rejected',
      rationale: 'The supplied pages are generic and unrelated.',
      accepted_source_ids: [],
      rejected_sources: [
        { id: 'market-home', reason: 'Generic homepage.' },
        { id: 'finance-page', reason: 'Stock data is not buyer evidence.' },
      ],
    },
    selected_opportunities: [selection({
      research_basis: 'verified_current_research',
      research_source_ids: ['market-home', 'finance-page'],
    })],
  }, currentResearch, [{ id: 'signal-1', type: 'web_trend', candidate_listing_ids: ['listing-1'] }]);

  expect(result.status).toBe('blocked_unverified_research');
  expect(result.selections).toEqual([]);
  expect(result.research_evidence).toMatchObject({ usable_for_current_event_claims: false, accepted_source_ids: [] });
  expect(result.reviewed_current_research.sources).toEqual([]);
});

test('research evidence preserves only cited independent sources for a timely opportunity', () => {
  const { filter } = semanticHarness();
  const currentResearch = {
    status: 'researched',
    sources: [
      { id: 'official-event', title: 'Official event', url: 'https://official.example.test/event' },
      { id: 'industry-report', title: 'Industry report', url: 'https://research.example.test/report' },
      { id: 'unrelated', title: 'Unrelated page', url: 'https://example.test/other' },
    ],
  };
  const result = filter.evaluateResearchEvidence({
    status: 'selected',
    research_evidence: {
      status: 'verified',
      rationale: 'Two independent sources support the timely moment.',
      accepted_source_ids: ['official-event', 'industry-report'],
      rejected_sources: [{ id: 'unrelated', reason: 'Does not support the claim.' }],
    },
    selected_opportunities: [selection({
      research_basis: 'verified_current_research',
      research_source_ids: ['official-event', 'industry-report'],
    })],
  }, currentResearch, [{ id: 'signal-1', type: 'current_event', candidate_listing_ids: ['listing-1'] }]);

  expect(result.selections).toHaveLength(1);
  expect(result.research_evidence.usable_for_current_event_claims).toBe(true);
  expect(result.reviewed_current_research.sources.map(source => source.id)).toEqual(['official-event', 'industry-report']);
});

test('verified research basis still requires two accepted citations for a holiday-labeled signal', () => {
  const { filter } = semanticHarness();
  const result = filter.evaluateResearchEvidence({
    status: 'selected',
    research_evidence: {
      status: 'verified',
      rationale: 'Only one supplied source was accepted.',
      accepted_source_ids: ['official-event'],
    },
    selected_opportunities: [selection({
      type: 'holiday',
      research_basis: 'verified_current_research',
      research_source_ids: ['official-event'],
    })],
  }, {
    status: 'researched',
    sources: [
      { id: 'official-event', title: 'Official event', url: 'https://official.example.test/event' },
      { id: 'independent-report', title: 'Report', url: 'https://research.example.test/report' },
    ],
  }, [{ id: 'signal-1', type: 'holiday', candidate_listing_ids: ['listing-1'] }]);

  expect(result.status).toBe('blocked_unverified_research');
  expect(result.selections).toEqual([]);
  expect(result.rejected_signals).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'signal-1', code: 'blocked_unverified_research' }),
  ]));
});

test('semantic retrieval covers the complete inventory and binds exact review evidence', async () => {
  const sourceListings = Array.from({ length: 41 }, (_, index) => listing(`listing-${index + 1}`));
  const exactQuote = 'The finished keepsake looked beautiful.';
  const retrievalResponse = call => ({
    status: 'selected',
    rationale: 'Keep one supplied candidate for final semantic reasoning.',
    selected_opportunities: [{
      source_opportunity_id: call.payload.local_raw_signals[0].id,
      listing_ids: [call.payload.listing_operational_signals.at(-1).listing_id],
      reason: 'Supplied facts justify deeper review.',
      evidence: ['listing facts'],
    }],
    rejected_signals: [],
  });
  const { calls, filter } = semanticHarness({
    responses: {
      opportunity_inventory_retrieval: [retrievalResponse, retrievalResponse],
      opportunity_final_selection: call => selectedResponse(selection({
        listing_id: call.payload.listing_operational_signals.at(-1).listing_id,
        review_id: 'review-1',
        review_quote: exactQuote,
      })),
    },
  });
  const inputSuggestions = suggestions(sourceListings, {
    review_evidence: [{
      review_id: 'review-1',
      listing_id: 'listing-41',
      text: `Buyer wrote: ${exactQuote} Thank you.`,
      rating: 5,
    }],
  });

  const result = await filter.applySemanticFit({ suggestions: inputSuggestions, sourceListings });

  expect(result.status).toBe('ready');
  expect(calls.filter(call => call.task === 'opportunity_inventory_retrieval')).toHaveLength(2);
  expect(result.ai_opportunity_selection.diagnostics).toMatchObject({
    complete_inventory_candidate_count: 41,
    ai_retrieval_rounds: 1,
  });
  expect(result.opportunities[0].context.selected_review).toMatchObject({
    review_id: 'review-1',
    exact_quote: exactQuote,
  });
});

test('semantic retrieval asks AI to repair malformed batches instead of selecting locally', async () => {
  const sourceListings = Array.from({ length: 41 }, (_, index) => listing(`listing-${index + 1}`));
  const retrievalRepair = call => ({
    status: 'selected',
    rationale: 'The repaired AI decision keeps one supplied candidate.',
    selected_opportunities: [{
      source_opportunity_id: call.payload.retrieval_payload.local_raw_signals[0].id,
      listing_ids: [call.payload.retrieval_payload.listing_operational_signals.at(-1).listing_id],
      reason: 'Supplied facts justify deeper review.',
      evidence: ['listing facts'],
    }],
    rejected_signals: [],
  });
  const { calls, filter } = semanticHarness({
    responses: {
      opportunity_inventory_retrieval: ['not-json', 'still not json'],
      opportunity_inventory_retrieval_repair: [retrievalRepair, retrievalRepair],
      opportunity_final_selection: call => selectedResponse(selection({
        listing_id: call.payload.listing_operational_signals.at(-1).listing_id,
      })),
    },
  });

  const result = await filter.applySemanticFit({ suggestions: suggestions(sourceListings), sourceListings });

  expect(result.status).toBe('ready');
  expect(calls.filter(call => call.task === 'opportunity_inventory_retrieval')).toHaveLength(2);
  expect(calls.filter(call => call.task === 'opportunity_inventory_retrieval_repair')).toHaveLength(2);
  expect(result.ai_opportunity_selection.diagnostics.ai_retrieval_batches).toEqual([
    expect.objectContaining({ repair_used: true, selected_count: 1, status: 'selected' }),
    expect.objectContaining({ repair_used: true, selected_count: 1, status: 'selected' }),
  ]);
});
