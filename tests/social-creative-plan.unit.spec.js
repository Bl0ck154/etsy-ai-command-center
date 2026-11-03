import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { createSocialCreativePlanService } from '../api/modules/social/index.js';

function creativePlanHarness(overrides = {}) {
  const calls = [];
  const values = {
    social_configs: { instagram: { enabled: true } },
    social_creative_cooldown_memory: { previous: true },
    social_owner_feedback_memory: { schema_version: 1, items: [{ id: 'stored-owner-rule' }] },
  };
  const dependencies = {
    getScheduledPosts: async () => [{ id: 'scheduled-one' }],
    loadValue: async key => values[key],
    saveValue: async (key, value) => calls.push(['save', key, value]),
    getImageCapabilities: async () => ({
      generatedImageAvailable: true,
      referenceImageSupported: true,
      referenceMode: 'input_image',
      models: [{ providerId: 'primary', model: 'image-model', referenceImageSupported: true, referenceMode: 'input_image' }],
    }),
    getReviewCardShopName: () => 'Studio Test',
    buildMediaGenerationResolution: (resolution, generatedMedia) => ({ resolution, accepted_count: generatedMedia.length }),
    normalizeOwnerFeedbackMemory: value => value || { schema_version: 1, items: [] },
    currentDateContext: now => ({ current_iso: String(now) }),
    platformMediaContracts: platforms => Object.fromEntries(platforms.map(platform => [platform, { platform }])),
    hydrateCurrentListingFacts: async listing => ({
      ...listing,
      title: 'Current title',
      current_availability: { source: 'live_etsy_inventory', active_offering_count: 1 },
    }),
    analyzeListingImages: async input => {
      calls.push(['vision', input]);
      return { available: true, images: [{ rank: 1 }] };
    },
    buildListingUnderstanding: async input => {
      calls.push(['understanding', input]);
      return { available: true, source: 'external_ai', summary: 'AI-understood listing' };
    },
    buildListingCampaignFit: async input => {
      calls.push(['fit', input]);
      return { decision: 'strong_fit', should_use_listing: true };
    },
    hydrateQualityVariants: async variants => variants.map(variant => ({ ...variant, hydrated: true })),
    reviewCampaignMedia: async input => {
      calls.push(['quality', input]);
      return { approved: true, decision: 'approve', rationale: 'Visible buyer evidence is clear.' };
    },
    campaignQualityBlockingSummary: review => review.rationale || 'blocked',
    attachReviewArtifacts: async plan => ({ ...plan, artifacts_attached: true }),
    buildCooldownMemory: () => ({ previous: true, refreshed: true }),
    buildCreativePatternContext: records => ({ record_ids: records.map(record => record.id) }),
    planCreativeCampaignForCandidates: input => {
      calls.push(['plan', input]);
      return {
        status: 'ready_for_review',
        listing_id: String(input.listing?.listing_id || input.listingCandidates[0]?.listing_id || ''),
        concept: { hook: 'AI hook' },
        media_strategy: { source: 'ai' },
        variants: [{ platform: 'instagram', media_items: [] }],
        generation_decision: { status: 'ready' },
      };
    },
    resolvePublishCapablePlatforms: () => ['instagram'],
    resolveRequestedPlatforms: requested => requested.filter(platform => platform !== 'all'),
    ...overrides,
  };
  return {
    calls,
    dependencies,
    service: createSocialCreativePlanService(dependencies),
  };
}

test('creativePlan public application interface orchestrates current facts, AI planning, QA, artifacts and cooldown memory', async () => {
  const { calls, service } = creativePlanHarness();

  const plan = await service.planCreativeCampaign({
    now: '2026-08-11T12:00:00.000Z',
    platforms: ['instagram'],
    post: { listing_id: 'listing-one' },
    generated_media: [{ id: 'generated-one' }],
    context: {
      require_current_listing_facts: true,
      require_vision_for_social_hero: true,
      require_campaign_visual_quality_review: true,
      media_generation_resolution: { phase: 'post_generation_replan' },
      owner_feedback_memory: { schema_version: 1, items: [{ id: 'caller-rule' }] },
    },
  }, { publicBaseUrl: 'https://manager.example.test' });

  const plannerInput = calls.find(call => call[0] === 'plan')[1];
  expect(plannerInput).toMatchObject({
    listing: {
      listing_id: 'listing-one',
      title: 'Current title',
      listing_understanding: { available: true, source: 'external_ai', summary: 'AI-understood listing' },
      listing_campaign_fit: { decision: 'strong_fit', should_use_listing: true },
    },
    platforms: ['instagram'],
    providerConfigured: true,
    generatedMedia: [{ id: 'generated-one' }],
    publicBaseUrl: 'https://manager.example.test',
    records: [{ id: 'scheduled-one' }],
    context: {
      require_ai_listing_understanding: true,
      require_ai_media_strategy: true,
      require_vision_for_social_hero: true,
      review_card_shop_name: 'Studio Test',
      recent_content_patterns: { record_ids: ['scheduled-one'] },
      owner_feedback_memory: { schema_version: 1, items: [{ id: 'stored-owner-rule' }] },
      media_generation_resolution: {
        resolution: { phase: 'post_generation_replan' },
        accepted_count: 1,
      },
    },
  });
  expect(calls.find(call => call[0] === 'quality')[1].variants[0].hydrated).toBe(true);
  expect(calls.find(call => call[0] === 'save')).toEqual([
    'save',
    'social_creative_cooldown_memory',
    { previous: true, refreshed: true },
  ]);
  expect(plan).toMatchObject({
    status: 'ready_for_review',
    artifacts_attached: true,
    campaign_quality_review_required: true,
    campaign_quality_review: { approved: true, decision: 'approve' },
    visual_analysis: { available: true, images: [{ rank: 1 }] },
    current_listing_availability: { source: 'live_etsy_inventory', active_offering_count: 1 },
  });
});

test('creativePlan public application interface preserves known validation error contracts', async () => {
  const { service } = creativePlanHarness();
  await expect(service.planCreativeCampaign({})).rejects.toMatchObject({
    socialCreativePlanError: true,
    httpStatus: 400,
    code: 'LISTING_REQUIRED',
  });

  const noPlatforms = creativePlanHarness({
    resolvePublishCapablePlatforms: () => [],
    resolveRequestedPlatforms: () => [],
  }).service;
  await expect(noPlatforms.planCreativeCampaign({ listing_id: 'listing-one' })).rejects.toMatchObject({
    socialCreativePlanError: true,
    httpStatus: 409,
    code: 'NO_CONFIGURED_PLATFORMS',
  });

  const unavailableFacts = creativePlanHarness({
    hydrateCurrentListingFacts: async () => { throw new Error('Etsy inventory unavailable'); },
  }).service;
  await expect(unavailableFacts.planCreativeCampaign({
    listing_id: 'listing-one',
    context: { require_current_listing_facts: true },
  })).rejects.toMatchObject({
    socialCreativePlanError: true,
    httpStatus: 503,
    code: 'CURRENT_LISTING_FACTS_UNAVAILABLE',
    message: expect.stringContaining('Etsy inventory unavailable'),
  });
});

test('creativePlan public application interface asks AI to repair planner selection issues without local media fallback', async () => {
  let plannerCall = 0;
  const { calls, service } = creativePlanHarness({
    planCreativeCampaignForCandidates: input => {
      calls.push(['plan', input]);
      plannerCall += 1;
      if (plannerCall === 1) return {
        status: 'blocked_ai_media_selection',
        listing_id: 'listing-one',
        listing_understanding: { summary: 'Initial understanding' },
        media_strategy_selection_issues: ['AI selected an unavailable frame.'],
        variants: [],
      };
      return { status: 'needs_generation', listing_id: 'listing-one', variants: [] };
    },
  });

  const plan = await service.planCreativeCampaign({ listing_id: 'listing-one' });

  const repairCall = calls.filter(call => call[0] === 'understanding').at(-1)[1];
  expect(repairCall.context.media_quality_feedback).toEqual({
    source: 'creative_plan_selection_validation',
    issues: ['AI selected an unavailable frame.'],
    instruction: 'Rebuild the AI media strategy so every listed planner selection issue is resolved without local fallback media.',
  });
  expect(plan.media_strategy_selection_repair).toEqual({
    attempted: true,
    source: 'external_ai',
    original_issues: ['AI selected an unavailable frame.'],
    resolved: true,
  });
});

test('creativePlan public application interface performs one AI quality replan and re-reviews the repaired campaign', async () => {
  let plannerCall = 0;
  let qualityCall = 0;
  const { calls, service } = creativePlanHarness({
    planCreativeCampaignForCandidates: input => {
      calls.push(['plan', input]);
      plannerCall += 1;
      return {
        status: 'ready_for_review',
        listing_id: 'listing-one',
        concept: { hook: plannerCall === 1 ? 'Initial hook' : 'Repaired hook' },
        media_strategy: { source: 'ai' },
        variants: [{ platform: 'instagram', media_items: [{ id: `frame-${plannerCall}` }] }],
        generation_decision: { status: 'ready' },
      };
    },
    reviewCampaignMedia: async input => {
      calls.push(['quality', input]);
      qualityCall += 1;
      return qualityCall === 1
        ? {
          approved: false,
          decision: 'replan',
          rationale: 'Lead frame lacks buyer evidence.',
          issues: ['weak lead'],
          required_changes: ['replace lead'],
          blocking_reasons: ['buyer evidence missing'],
        }
        : { approved: true, decision: 'approve', rationale: 'Repaired evidence is visible.' };
    },
  });

  const plan = await service.planCreativeCampaign({
    listing_id: 'listing-one',
    context: { require_campaign_visual_quality_review: true },
  });

  expect(plannerCall).toBe(2);
  expect(qualityCall).toBe(2);
  expect(calls.filter(call => call[0] === 'understanding').at(-1)[1].context.media_quality_feedback)
    .toMatchObject({ source: 'campaign_visual_quality_review', decision: 'replan', issues: ['weak lead'] });
  expect(plan).toMatchObject({
    status: 'ready_for_review',
    campaign_quality_review: { approved: true, decision: 'approve' },
    campaign_quality_repair: { attempted: true, resolved: true },
  });
});

test('creativePlan public application interface fails closed when campaign visual QA is unavailable', async () => {
  const { service } = creativePlanHarness({
    reviewCampaignMedia: async () => { throw new Error('vision provider unavailable'); },
  });

  const plan = await service.planCreativeCampaign({
    listing_id: 'listing-one',
    context: { require_campaign_visual_quality_review: true },
  });

  expect(plan).toMatchObject({
    status: 'blocked_campaign_visual_quality_unavailable',
    campaign_quality_review_required: true,
    campaign_quality_review: {
      approved: false,
      decision: 'unavailable',
      rationale: 'vision provider unavailable',
    },
    generation_decision: {
      status: 'blocked_campaign_visual_quality_unavailable',
      rationale: 'vision provider unavailable',
    },
  });
  expect(plan.variants[0].readiness).toBe('blocked_campaign_visual_quality_unavailable');
});

test('creativePlan public application boundary stays focused and has no Express, browser or HTTP-facade dependency', () => {
  const source = readFileSync(new URL('../api/modules/social/application/plan-creative-campaign.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(50_000);
  expect(source).not.toMatch(/api\/social|express|\breq\b|\bres\b|public\/pages|fetch\s*\(/i);

  const facade = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');
  const actionBlock = facade.match(/case 'creativePlan': \{[\s\S]*?case 'generateMedia': \{/i)?.[0] || '';
  expect(actionBlock).toContain('socialCreativePlanService.planCreativeCampaign');
  expect(actionBlock).toContain('socialHermesJsonError');
  expect(actionBlock).not.toMatch(/buildListingUnderstandingWithAi|planSocialCreativeCampaignForCandidates|reviewSocialCampaignMedia|\bkvGet\b|\bkvSet\b/);
});
