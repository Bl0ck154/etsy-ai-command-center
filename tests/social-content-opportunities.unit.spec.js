import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { createSocialContentOpportunityService } from '../api/modules/social/index.js';

function serviceHarness(overrides = {}) {
  const calls = { loads: [], suggestions: [], semantic: [] };
  const values = {
    social_configs: { instagram: { enabled: true } },
    social_creative_cooldown_memory: { listings: {} },
    social_autonomous_context: {
      listings: [{ listing_id: 'stored-one', title: 'Stored listing' }],
      reviews: [{ review_id: 'review-one', text: 'Great work' }],
    },
    social_owner_feedback_memory: { schema_version: 1, items: [{ id: 'preference-one' }] },
  };
  const dependencies = {
    getScheduledPosts: async () => [{ id: 'scheduled-one' }],
    loadValue: async key => {
      calls.loads.push(key);
      return values[key];
    },
    resolvePublishCapablePlatforms: () => ['instagram', 'facebook'],
    resolveRequestedPlatforms: requested => requested.filter(value => value !== 'all'),
    normalizeOwnerFeedbackMemory: value => value || { schema_version: 1, items: [] },
    buildCreativePatternContext: records => ({ record_ids: records.map(record => record.id) }),
    suggestOpportunities: input => {
      calls.suggestions.push(input);
      return {
        status: 'ready',
        opportunities: [{ id: 'raw-signal-one', listing_candidates: input.autonomousContext.listings }],
      };
    },
    semanticFilter: async input => {
      calls.semantic.push(input);
      return { ...input.suggestions, semantic_filter_applied: true };
    },
    ...overrides,
  };
  return {
    calls,
    service: createSocialContentOpportunityService(dependencies),
  };
}

test('contentOpportunities blocks autonomous shop-aware ideas when external AI is unavailable', async () => {
  const { service } = serviceHarness({
    semanticFilter: async ({ suggestions }) => ({
      ...suggestions,
      status: 'blocked_ai_required',
      opportunities: [],
      external_research_used: false,
      research_owner: 'social_hermes',
      ai_semantic_selection: {
        available: false,
        required: true,
        applied: false,
        source: 'ai_unavailable',
      },
      honesty_note: 'Autonomous social post selection requires external AI semantic reasoning.',
      recommended_next_action: 'Configure external text AI and run contentOpportunities again.',
    }),
  });

  const opportunities = await service.selectContentOpportunities({
    now: '2026-06-17T12:00:00.000Z',
    window_days: 21,
    platforms: ['instagram', 'facebook', 'all'],
    listings: [{ listing_id: '4517826856', title: 'Family Generations Portrait' }],
  });

  expect(opportunities).toMatchObject({
    status: 'blocked_ai_required',
    opportunities: [],
    external_research_used: false,
    ai_semantic_selection: {
      available: false,
      required: true,
      applied: false,
      source: 'ai_unavailable',
    },
  });
  expect(opportunities.honesty_note).toContain('requires external AI semantic reasoning');
  expect(opportunities.recommended_next_action).toContain('Configure external text AI');
});

test('content opportunity application loads stored facts and passes them to AI without local selection', async () => {
  const { calls, service } = serviceHarness();

  const result = await service.selectContentOpportunities({
    now: '2026-08-09T12:00:00.000Z',
    platforms: ['instagram', 'facebook'],
    selection_objective: 'Choose by semantic fit only.',
    require_listing_understanding: true,
    max_opportunities: 1,
  });

  expect(calls.loads).toEqual([
    'social_configs',
    'social_creative_cooldown_memory',
    'social_autonomous_context',
    'social_owner_feedback_memory',
  ]);
  expect(calls.suggestions[0]).toMatchObject({
    autonomousContext: { listings: [{ listing_id: 'stored-one', title: 'Stored listing' }] },
    records: [{ id: 'scheduled-one' }],
    platforms: ['instagram', 'facebook'],
    sourceBasis: 'stored_shop_context',
  });
  expect(calls.semantic[0]).toMatchObject({
    sourceListings: [{ listing_id: 'stored-one', title: 'Stored listing' }],
    now: '2026-08-09T12:00:00.000Z',
    aiCandidateLimit: 12,
    maxOpportunities: 1,
    suggestions: {
      require_listing_understanding: true,
      selection_objective: 'Choose by semantic fit only.',
      configured_platforms: ['instagram', 'facebook'],
      owner_feedback_memory: { schema_version: 1, items: [{ id: 'preference-one' }] },
      recent_content_patterns: { record_ids: ['scheduled-one'] },
    },
  });
  expect(result.semantic_filter_applied).toBe(true);
});

test('content opportunity application removes excluded listings before deterministic facts reach AI', async () => {
  const { calls, service } = serviceHarness();

  await service.selectContentOpportunities({
    listings: [
      { listing_id: 'blocked-one', title: 'Blocked listing' },
      { listing_id: 'available-one', title: 'Available listing' },
    ],
    reviews: [],
    excluded_listing_ids: ['blocked-one'],
    aiCandidateLimit: 5,
    maxOpportunities: 2,
  });

  expect(calls.suggestions[0].sourceBasis).toBe('caller_supplied_unverified');
  expect(calls.suggestions[0].autonomousContext.listings).toEqual([
    { listing_id: 'available-one', title: 'Available listing' },
  ]);
  expect(calls.semantic[0].sourceListings).toEqual([
    { listing_id: 'available-one', title: 'Available listing' },
  ]);
  expect(calls.semantic[0].aiCandidateLimit).toBe(5);
  expect(calls.semantic[0].maxOpportunities).toBe(2);
});

test('content opportunity application tolerates unavailable stored evidence but still delegates fail-closed AI', async () => {
  const semanticCalls = [];
  const service = createSocialContentOpportunityService({
    getScheduledPosts: async () => { throw new Error('queue unavailable'); },
    loadValue: async () => { throw new Error('KV unavailable'); },
    semanticFilter: async input => {
      semanticCalls.push(input);
      return { status: 'blocked_ai_required', opportunities: [] };
    },
  });

  const result = await service.selectContentOpportunities({ now: '2026-08-09T12:00:00.000Z' });

  expect(result).toEqual({ status: 'blocked_ai_required', opportunities: [] });
  expect(semanticCalls).toHaveLength(1);
  expect(semanticCalls[0].sourceListings).toEqual([]);
});

test('content opportunity application has no Express, browser, or HTTP dependency', () => {
  const source = readFileSync(new URL('../api/modules/social/application/select-content-opportunities.js', import.meta.url), 'utf8');
  expect(source).not.toMatch(/api\/social|express|\breq\b|\bres\b|public\/pages|fetch\s*\(/i);
});

test('content opportunity internals stay focused below the production size trigger without facade imports', () => {
  const paths = [
    '../api/modules/social/domain/content-opportunity-contracts.js',
    '../api/modules/social/application/select-content-opportunities-with-ai.js',
    '../api/modules/social/application/apply-content-opportunity-fit.js',
    '../api/modules/social/application/select-content-opportunities-ai.js',
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(Buffer.byteLength(source, 'utf8'), path).toBeLessThan(50_000);
    expect(source, path).not.toMatch(/api\/social|express|\breq\b|\bres\b|public\/pages/i);
  }
  const contracts = readFileSync(new URL(paths[0], import.meta.url), 'utf8');
  const selector = readFileSync(new URL(paths[1], import.meta.url), 'utf8');
  const fitFilter = readFileSync(new URL(paths[2], import.meta.url), 'utf8');
  expect(contracts).not.toMatch(/application\//);
  expect(selector).not.toMatch(/apply-content-opportunity-fit/);
  expect(fitFilter).not.toMatch(/select-content-opportunities-with-ai/);
});
