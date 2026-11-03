import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { createSocialCaptionReviewContracts } from '../api/modules/social/domain/caption-review-contracts.js';

function normalizeText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeCaption(value, max = 1600) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function makeContracts() {
  return createSocialCaptionReviewContracts({ normalizeText, normalizeCaption });
}

test('caption review output schema preserves one strict keyed review per requested platform', () => {
  const contracts = makeContracts();
  const schema = contracts.outputSchema([' Instagram ', 'facebook', 'instagram']);

  expect(schema.properties.platform_caption_reviews.required).toEqual(['instagram', 'facebook']);
  expect(schema.properties.platform_caption_reviews.additionalProperties).toBe(false);
  expect(schema.properties.platform_caption_reviews.properties.instagram.required).toEqual([
    'approved',
    'decision',
    'reviewed_caption',
    'rationale',
    'factual_grounding',
    'platform_fit',
    'cta_destination',
    'cta_compliant',
    'required_listing_url_present',
    'risks',
  ]);
  expect(schema.properties.platform_caption_reviews.properties.facebook.properties.cta_destination.enum).toEqual([
    'etsy_listing',
    'etsy_link_in_bio',
    'social_direct_message',
    'email',
    'none',
    'other',
  ]);
});

test('caption review normalization preserves legacy exact-caption approval semantics', () => {
  const contracts = makeContracts();
  const captions = { instagram: 'Exact caption\nwith normalized spacing' };
  const normalized = contracts.normalizeReviews({
    instagram: {
      approved: true,
      decision: 'approve',
      reviewed_caption: ' Exact caption \r\n with normalized spacing ',
      rationale: 'Grounded.',
      factual_grounding: 'Supported.',
      platform_fit: 'Fits.',
      cta_destination: 'etsy_link_in_bio',
      cta_compliant: true,
      required_listing_url_present: false,
      risks: ['  none  '],
    },
  }, captions);

  expect(normalized.instagram).toMatchObject({
    approved: true,
    decision: 'approve',
    reviewed_caption: 'Exact caption\nwith normalized spacing',
    rationale: 'Grounded.',
    risks: ['none'],
  });

  const changed = contracts.normalizeReviews({
    instagram: {
      approved: true,
      decision: 'approve',
      reviewed_caption: 'Different caption',
    },
  }, captions);
  expect(changed.instagram.approved).toBe(false);
  // Preserve the pre-extraction contract: approval is fail-closed on an exact-caption
  // mismatch, while the normalized raw verdict remains visible for later policy checks.
  expect(changed.instagram.decision).toBe('approve');
});

test('caption route policy preserves Etsy-only platform handoff rules', () => {
  const contracts = makeContracts();
  const listingUrl = 'https://etsy.test/listing/42';
  const reviews = {
    instagram: { approved: true, decision: 'approve', cta_destination: 'etsy_link_in_bio', cta_compliant: true, risks: [] },
    facebook: { approved: true, decision: 'approve', cta_destination: 'etsy_listing', cta_compliant: true, risks: [] },
    pinterest: { approved: true, decision: 'approve', cta_destination: 'social_direct_message', cta_compliant: false, risks: [] },
  };
  const captions = {
    instagram: `See it here ${listingUrl}`,
    facebook: 'A Facebook caption without the required URL.',
    pinterest: `Pinterest caption ${listingUrl}`,
  };

  contracts.enforceRoutePolicy(reviews, captions, ['instagram', 'facebook', 'pinterest'], listingUrl);

  expect(reviews.instagram).toMatchObject({ approved: false, decision: 'revise', required_listing_url_present: true });
  expect(reviews.instagram.risks).toContain('Raw Etsy listing URL is not suitable for the Instagram caption; use the Etsy link in bio instead.');
  expect(reviews.facebook).toMatchObject({ approved: false, decision: 'revise', required_listing_url_present: false });
  expect(reviews.facebook.risks).toContain('Exact Etsy listing URL is missing for this platform.');
  expect(reviews.pinterest).toMatchObject({ approved: false, decision: 'revise', required_listing_url_present: true });
  expect(reviews.pinterest.risks).toContain('CTA routes the buyer outside the required Etsy handoff.');
});

test('caption validity preserves supported-platform length and critic metadata requirements', () => {
  const contracts = makeContracts();
  const exactCaption = 'This is a sufficiently long grounded caption for Instagram review.';
  const understanding = {
    platform_captions: { instagram: exactCaption },
    platform_caption_reviews: {
      instagram: {
        approved: true,
        decision: 'approve',
        reviewed_caption: exactCaption,
        rationale: 'Grounded and platform appropriate.',
      },
    },
    caption_review_source: 'external_ai_caption_critic',
  };

  expect(contracts.validPlatformCaptions(understanding, ['instagram'])).toBe(true);
  expect(contracts.validReviews(understanding, ['instagram'])).toBe(true);
  expect(contracts.validPlatformCaptions(understanding, [])).toBe(false);

  understanding.caption_review_source = 'caller_supplied';
  expect(contracts.validReviews(understanding, ['instagram'])).toBe(false);
});

test('caption review contracts own no AI transport, queue, publish, approval or HTTP behavior', () => {
  const source = readFileSync(new URL('../api/modules/social/domain/caption-review-contracts.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(30_000);
  expect(source).not.toMatch(/generateWithExternalAi|generateWithSocialAi|getScheduledPosts|saveScheduledPost|publishSocialHermes|approveScheduledPost|AUTOPUBLISH|REAL_PUBLISH_RELEASE_APPROVED|express|\breq\b|\bres\b/);
});
