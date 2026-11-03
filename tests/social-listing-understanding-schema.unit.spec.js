import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { buildSocialListingUnderstandingOutputSchema } from '../api/modules/social/index.js';

test('listing-understanding schema pins requested platforms, inspected media ranks and accepted asset decisions', () => {
  const schema = buildSocialListingUnderstandingOutputSchema(
    [' Instagram ', 'facebook', 'pinterest', 'instagram'],
    [' frame_1 ', 'frame_2', 'frame_1'],
    [3, 1, 3, 0, '2'],
  );

  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.platform_captions.required).toEqual(['instagram', 'facebook', 'pinterest']);
  expect(schema.properties.media_strategy.properties.platform_variants.required).toEqual(['instagram', 'facebook', 'pinterest']);
  expect(schema.properties.media_strategy.properties.platform_variants.properties.instagram.properties.format.enum)
    .toEqual(['single', 'carousel']);
  expect(schema.properties.media_strategy.properties.platform_variants.properties.facebook.properties.format.enum)
    .toEqual(['single', 'multi_image']);
  expect(schema.properties.media_strategy.properties.platform_variants.properties.pinterest.properties.format.enum)
    .toEqual(['single']);

  const mediaDecisions = schema.properties.media_strategy.properties.listing_media_decisions;
  expect(mediaDecisions.minItems).toBe(3);
  expect(mediaDecisions.maxItems).toBe(3);
  expect(mediaDecisions.items.properties.rank.enum).toEqual([3, 1, 2]);

  const accepted = schema.properties.media_strategy.properties.accepted_asset_decisions;
  expect(schema.properties.media_strategy.required).toContain('accepted_asset_decisions');
  expect(accepted.minItems).toBe(2);
  expect(accepted.maxItems).toBe(2);
  expect(accepted.items.properties.brief_id.enum).toEqual(['frame_1', 'frame_2']);
});

test('listing-understanding schema does not require accepted-asset decisions when there are no accepted assets', () => {
  const schema = buildSocialListingUnderstandingOutputSchema(['tiktok'], [], []);
  const mediaStrategy = schema.properties.media_strategy;
  expect(mediaStrategy.required).not.toContain('accepted_asset_decisions');
  expect(mediaStrategy.properties.listing_media_decisions).toMatchObject({ minItems: 0, maxItems: 0 });
  expect(mediaStrategy.properties.listing_media_decisions.items.properties.rank).toEqual({ type: 'integer', minimum: 1 });
  expect(mediaStrategy.properties.platform_variants.properties.tiktok.properties.format.enum).toEqual(['single']);
  expect(mediaStrategy.properties.accepted_asset_decisions).toMatchObject({ minItems: 0, maxItems: 0 });
});

test('listing-understanding schema preserves buyer-evidence, offer-grounding and generated-frame constraints', () => {
  const schema = buildSocialListingUnderstandingOutputSchema(['instagram'], ['approved_frame'], [1]);
  const strategy = schema.properties.media_strategy;
  const frame = strategy.properties.frames.items;
  const claim = schema.properties.offer_fact_review.properties.claims.items;

  expect(schema.required).toEqual(expect.arrayContaining([
    'what_is_sold', 'platform_captions', 'media_strategy', 'offer_fact_review', 'confidence',
  ]));
  expect(strategy.required).toEqual(expect.arrayContaining([
    'campaign_offer_focus', 'lead_proof_plan', 'required_visible_evidence',
    'frame_count_rationale', 'listing_media_decisions', 'frames', 'platform_variants',
  ]));
  expect(frame.required).toEqual(expect.arrayContaining([
    'id', 'role', 'source', 'rationale', 'communication_goal', 'visible_buyer_evidence', 'evidence_strength',
  ]));
  expect(frame.properties.source.enum).toEqual(['listing_image', 'generated_image', 'review_card']);
  expect(frame.properties.evidence_strength.enum).toEqual(['primary', 'supporting', 'none']);
  expect(frame.properties.aspect_ratio.enum).toEqual(['1:1', '4:5', '2:3', '3:4', '9:16', '16:9']);
  expect(frame.properties.crop_focus.enum).toEqual(['attention', 'center', 'north', 'south', 'east', 'west']);
  expect(claim.properties.status.enum).toEqual(['current_available', 'inactive', 'unknown']);
  expect(claim.properties.source_ids.minItems).toBe(1);
});

test('listing-understanding schema module is pure contract code', () => {
  const source = readFileSync(new URL('../api/modules/social/infrastructure/listing-understanding-output-schema.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(50_000);
  expect(source).not.toMatch(/from ['"][^'"]*(?:_etsy|\/kv|_scheduler|api\/social)|\bfetch\s*\(|generateWith[A-Z]|publishSocialHermes|approveScheduledPost|AUTOPUBLISH|REAL_PUBLISH_RELEASE_APPROVED/);
  expect(source).toContain('buildSocialListingUnderstandingOutputSchema');
});

test('Social facade delegates listing-understanding schema construction to the Social module', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');
  const strategySource = readFileSync(
    new URL('../api/modules/social/infrastructure/listing-understanding-ai.js', import.meta.url),
    'utf8',
  );
  expect(source).toContain('buildSocialListingUnderstandingOutputSchema,');
  expect(source).toContain('buildOutputSchema: buildSocialListingUnderstandingOutputSchema,');
  expect(strategySource).toContain('const understandingOutputSchema = outputSchema(');
  expect(source).not.toContain('function listingUnderstandingOutputSchema(');
});
