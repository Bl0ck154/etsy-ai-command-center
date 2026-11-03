import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import {
  resolveSocialOwnerReviewVariantMedia,
  socialOwnerReviewCanonicalVariantFormat,
  socialOwnerReviewPrimaryMediaFields,
} from '../api/modules/social/domain/owner-review-media-contract.js';

const listing = {
  title: 'Custom Pet Portrait',
  image_url: 'https://img.example.test/first-listing-image.jpg',
};

function persistentGenerated(overrides = {}) {
  return {
    url: 'https://manager.example.test/media/generated-context.jpg',
    source: 'generated_image',
    permanent: true,
    checksum_sha256: 'a'.repeat(64),
    ...overrides,
  };
}

test('owner-review media contract preserves the exact AI-selected two-frame order', () => {
  const media = resolveSocialOwnerReviewVariantMedia({
    variant: {
      carousel: true,
      media_items: [
        { url: 'https://img.example.test/listing-example.jpg', source: 'listing_image' },
        persistentGenerated(),
      ],
    },
    listing,
    platform: 'instagram',
  });

  expect(media).toHaveLength(2);
  expect(media.map(item => item.source)).toEqual(['listing_image', 'generated_image']);
  expect(media.map(item => item.url)).toEqual([
    'https://img.example.test/listing-example.jpg',
    'https://manager.example.test/media/generated-context.jpg',
  ]);
});

test('owner-review media contract never falls back to the listing first image', () => {
  expect(resolveSocialOwnerReviewVariantMedia({
    variant: { media_items: [] },
    listing,
    platform: 'facebook',
  })).toEqual([]);
  expect(resolveSocialOwnerReviewVariantMedia({
    variant: {},
    listing,
    platform: 'facebook',
  })).toEqual([]);
});

test('owner-review media contract fails the whole variant if any selected frame is blocked or duplicated', () => {
  const first = { url: 'https://img.example.test/one.jpg', source: 'listing_image' };
  const second = { url: 'https://img.example.test/two.jpg', source: 'listing_image' };

  expect(resolveSocialOwnerReviewVariantMedia({
    variant: { format: 'carousel', media_items: [first, second] },
    listing,
    platform: 'instagram',
    blockedMedia: new Set([second.url]),
  })).toEqual([]);
  expect(resolveSocialOwnerReviewVariantMedia({
    variant: { format: 'carousel', media_items: [first, first] },
    listing,
    platform: 'instagram',
  })).toEqual([]);
});

test('owner-review media contract requires generated and review-card assets to be persistent with sha256', () => {
  expect(resolveSocialOwnerReviewVariantMedia({
    variant: { format: 'single', media_items: [persistentGenerated({ permanent: false })] },
    listing,
    platform: 'facebook',
  })).toEqual([]);
  expect(resolveSocialOwnerReviewVariantMedia({
    variant: { format: 'single', media_items: [persistentGenerated({ checksum_sha256: 'bad' })] },
    listing,
    platform: 'facebook',
  })).toEqual([]);
  expect(resolveSocialOwnerReviewVariantMedia({
    variant: {
      format: 'single',
      media_items: [{
        url: 'https://manager.example.test/media/review-card.jpg',
        source: 'review_card',
        permanent: true,
        checksum_sha256: 'b'.repeat(64),
      }],
    },
    listing,
    platform: 'facebook',
  })).toHaveLength(1);
});

test('owner-review media contract preserves provider and AI quality evidence', () => {
  const qualityReview = {
    decision: 'approve',
    approved: true,
    rationale: 'The generated pixels faithfully support the selected campaign.',
    model: 'vision-review-model',
    run_id: 'vision-run-1',
  };
  const media = resolveSocialOwnerReviewVariantMedia({
    variant: {
      format: 'single',
      media_items: [persistentGenerated({
        quality_review: qualityReview,
        generated_via: 'external_ai',
        image_model_tier: 'standard',
        provider: 'openai',
        model: 'image-model',
      })],
    },
    listing,
    platform: 'facebook',
  });

  expect(media[0]).toMatchObject({
    quality_review: qualityReview,
    generated_via: 'external_ai',
    image_model_tier: 'standard',
    provider: 'openai',
    model: 'image-model',
  });
});

test('owner-review media contract enforces exact platform count/format without local repair', () => {
  const twoListingImages = [
    { url: 'https://img.example.test/one.jpg', source: 'listing_image' },
    { url: 'https://img.example.test/two.jpg', source: 'listing_image' },
  ];
  expect(resolveSocialOwnerReviewVariantMedia({
    variant: { format: 'carousel', media_items: twoListingImages },
    listing,
    platform: 'pinterest',
  })).toEqual([]);
  expect(resolveSocialOwnerReviewVariantMedia({
    variant: { format: 'single', media_items: twoListingImages },
    listing,
    platform: 'facebook',
  })).toEqual([]);
  expect(resolveSocialOwnerReviewVariantMedia({
    variant: { format: 'carousel', media_items: [twoListingImages[0]] },
    listing,
    platform: 'instagram',
  })).toEqual([]);
});

test('owner-review variant format preserves current and legacy plan aliases', () => {
  expect(socialOwnerReviewCanonicalVariantFormat({ format: 'carousel' }, 'instagram')).toBe('carousel');
  expect(socialOwnerReviewCanonicalVariantFormat({ media_format: 'multi_image' }, 'facebook')).toBe('multi_image');
  expect(socialOwnerReviewCanonicalVariantFormat({ carousel: true }, 'instagram')).toBe('carousel');
  expect(socialOwnerReviewCanonicalVariantFormat({ media_items: [{}, {}] }, 'facebook')).toBe('multi_image');
  expect(socialOwnerReviewCanonicalVariantFormat({ media_items: [{}] }, 'facebook')).toBe('single');
});

test('owner-review primary media fields mirror only the AI-selected first media', () => {
  expect(socialOwnerReviewPrimaryMediaFields([
    { url: 'https://img.example.test/listing.jpg', source: 'listing_image' },
  ])).toEqual({
    listing_image_url: 'https://img.example.test/listing.jpg',
    generated_image_url: '',
    custom_image_url: 'https://img.example.test/listing.jpg',
  });
  expect(socialOwnerReviewPrimaryMediaFields([
    persistentGenerated({ url: 'https://manager.example.test/media/generated.jpg' }),
  ])).toEqual({
    listing_image_url: '',
    generated_image_url: 'https://manager.example.test/media/generated.jpg',
    custom_image_url: 'https://manager.example.test/media/generated.jpg',
  });
});

test('owner-review media contract has no AI, provider, HTTP, queue or publisher dependency', () => {
  const source = readFileSync(new URL('../api/modules/social/domain/owner-review-media-contract.js', import.meta.url), 'utf8');
  expect(source).not.toMatch(/generateWith|external-ai|fetch\s*\(|api\/social|queue|publishDue|social-publisher/i);
});
