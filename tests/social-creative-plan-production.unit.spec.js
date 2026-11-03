import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import {
  buildSocialListingAvailabilitySnapshot,
  buildSocialMediaGenerationResolution,
  createSocialCreativePlanProductionService,
} from '../api/modules/social/index.js';

test('creativePlan production composition makes the two remaining legacy AI strategies explicit', () => {
  expect(() => createSocialCreativePlanProductionService()).toThrow('buildListingUnderstanding dependency is required');
  expect(() => createSocialCreativePlanProductionService({
    buildListingUnderstanding: async () => ({}),
  })).toThrow('buildListingCampaignFit dependency is required');
});

test('creativePlan production composition uses injected AI strategy while owning the rest of the application wiring', async () => {
  const calls = [];
  const service = createSocialCreativePlanProductionService({
    buildListingUnderstanding: async input => {
      calls.push(['understanding', input]);
      return { available: true, source: 'legacy_ai_strategy', summary: 'understood' };
    },
    buildListingCampaignFit: async input => {
      calls.push(['fit', input]);
      return { decision: 'strong_fit', should_use_listing: true };
    },
    adapters: {
      getScheduledPosts: async () => [],
      loadValue: async key => key === 'social_configs' ? { instagram: { enabled: true } } : {},
      saveValue: async () => {},
      getImageCapabilities: async () => ({
        generatedImageAvailable: true,
        referenceImageSupported: false,
        referenceMode: 'unsupported',
        models: [],
      }),
      getReviewCardShopName: () => 'Composition Test',
      hydrateCurrentListingFacts: async listing => listing,
      analyzeListingImages: async () => null,
      hydrateQualityVariants: async variants => variants,
      reviewCampaignMedia: async () => ({ approved: true, blocking_reasons: [] }),
      attachReviewArtifacts: async plan => plan,
      buildCooldownMemory: () => ({ schema_version: 1 }),
      buildCreativePatternContext: () => ({ recent: [] }),
      planCreativeCampaignForCandidates: input => {
        calls.push(['plan', input]);
        return {
          status: 'needs_generation',
          listing_id: String(input.listing?.listing_id || ''),
          media_strategy: { source: 'ai' },
          variants: [],
          generation_decision: { status: 'needs_generation' },
        };
      },
      resolvePublishCapablePlatforms: () => ['instagram'],
      resolveRequestedPlatforms: () => ['instagram'],
    },
  });

  const plan = await service.planCreativeCampaign({ listing_id: '12345' });
  const plannerInput = calls.find(call => call[0] === 'plan')[1];

  expect(plannerInput.listing).toMatchObject({
    listing_id: '12345',
    listing_understanding: { source: 'legacy_ai_strategy', summary: 'understood' },
    listing_campaign_fit: { decision: 'strong_fit', should_use_listing: true },
  });
  expect(calls.map(call => call[0])).toEqual(expect.arrayContaining(['understanding', 'fit', 'plan']));
  expect(plan).toMatchObject({
    status: 'needs_generation',
    listing_id: '12345',
    generation_decision: { status: 'needs_generation' },
  });
});

test('creativePlan production listing facts distinguish active and inactive-only variation values', () => {
  const snapshot = buildSocialListingAvailabilitySnapshot({
    listing_id: 42,
    shipping_profile_id: 9,
    processing_min: 1,
    processing_max: 3,
    inventory: {
      products: [
        {
          property_values: [{ property_name: 'Size', values: ['Small'] }],
          offerings: [{ is_enabled: true, is_deleted: false }],
        },
        {
          property_values: [{ property_name: 'Size', values: ['Large'] }],
          offerings: [{ is_enabled: false, is_deleted: false }],
        },
      ],
    },
  });

  expect(snapshot).toMatchObject({
    source: 'live_etsy_inventory',
    listing_id: '42',
    active_offering_count: 1,
    inactive_offering_count: 1,
    shipping_profile_present: true,
    processing_min_days: 1,
    processing_max_days: 3,
  });
  expect(snapshot.variation_availability).toEqual([{
    property: 'Size',
    active_values: ['Small'],
    inactive_only_values: ['Large'],
  }]);
});

test('creativePlan production media resolution preserves accepted immutable asset identity', () => {
  const resolution = buildSocialMediaGenerationResolution(
    { phase: 'post_generation_replan', attempt: 2 },
    [{
      id: 'asset-one',
      brief_id: 'frame-one',
      source: 'review_card',
      url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_0123456789abcdef01234567',
      permanent: true,
      review_id: 'review-1',
      context_note: 'Exact buyer quote',
      aspect_ratio: '4:5',
      render_spec_sha256: 'a'.repeat(64),
      review_card_design: {
        style: 'bold_editorial',
        heading: 'Buyer note',
        highlight_phrase: '',
        background_color: '#FFFFFF',
        surface_color: '#F4F4F4',
        text_color: '#111111',
        accent_color: '#FF6600',
      },
    }],
  );

  expect(resolution).toMatchObject({
    phase: 'post_generation_replan',
    attempt: 2,
    accepted_assets: [{
      brief_id: 'frame-one',
      source: 'review_card',
      permanent: true,
      quality_approved: true,
      review_id: 'review-1',
      context_note: 'Exact buyer quote',
      aspect_ratio: '4:5',
      render_spec_sha256: 'a'.repeat(64),
    }],
  });
});

test('creativePlan production composition stays inside the Social module and cannot publish', () => {
  const source = readFileSync(new URL('../api/modules/social/creative-plan-production.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(50_000);
  expect(source).not.toMatch(/api\/social|express|\breq\b|\bres\b|public\/pages/i);
  expect(source).not.toMatch(/publishSocialHermesDueScheduled|approveScheduledPost|AUTOPUBLISH|REAL_PUBLISH_RELEASE_APPROVED/);
  expect(source).toContain('createSocialCreativePlanService');
  expect(source).toContain('readPersistentSocialMediaAsset');
  expect(source).toContain('createSocialReviewArtifactService');
});

test('Social compatibility facade uses the module-owned creativePlan production composition', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');
  expect(source).toContain('createSocialCreativePlanProductionService,');
  expect(source).toContain('const socialCreativePlanService = createSocialCreativePlanProductionService({');
  expect(source).toContain('buildListingUnderstanding: buildListingUnderstandingWithAi');
  expect(source).toContain('buildListingCampaignFit: buildListingCampaignFitWithAi');
  expect(source).not.toContain('const socialCreativePlanService = createSocialCreativePlanService({');
});
