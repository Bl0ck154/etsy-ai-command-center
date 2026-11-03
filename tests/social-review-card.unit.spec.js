import { test, expect } from '@playwright/test';
import {
  buildSocialReviewCardHtml,
  normalizeSocialReviewCardDesign,
  normalizeSocialReviewCardEvidence,
  renderSocialReviewCardPng,
  socialReviewCardRenderSpecSha256,
  socialReviewCardGeometry,
} from '../api/_social-review-card.js';
import sharp from 'sharp';

const review = {
  review_id: 'review-42',
  listing_id: 'listing-42',
  listing_title: 'Custom family photo composition',
  exact_quote: 'The result looked natural and the details were handled with care.',
  rating: 5,
  buyer_name: 'Private Buyer',
  transaction_id: 'private-order-123',
};

const design = {
  style: 'scrapbook_note',
  heading: 'A note from an Etsy buyer',
  highlight_phrase: 'looked natural',
  background_color: '#DCEFE5',
  surface_color: '#FFF8EF',
  text_color: '#173129',
  accent_color: '#E9573F',
};

test('review evidence keeps exact public proof fields and drops identity/order data', () => {
  expect(normalizeSocialReviewCardEvidence(review)).toEqual({
    review_id: 'review-42',
    listing_id: 'listing-42',
    listing_title: 'Custom family photo composition',
    exact_quote: 'The result looked natural and the details were handled with care.',
    rating: 5,
  });
});

test('review card HTML is clearly attributed to Etsy without inventing a reviewer name', () => {
  const html = buildSocialReviewCardHtml({
    review,
    contextNote: 'Custom digital photo composition service',
    aspectRatio: '4:5',
  });
  expect(html).toContain('What an Etsy buyer said');
  expect(html).toContain(review.exact_quote);
  expect(html).toContain('Custom digital photo composition service');
  expect(html).toContain('Buyer identity is not displayed');
  expect(html).not.toContain('Private Buyer');
  expect(html).not.toContain('private-order-123');
  expect(html).not.toContain(review.listing_title);
  expect(html).not.toContain('Zivker Art');
  expect(html).not.toContain('etsy.com');
});

test('review card omits an absent context note instead of inventing one locally', () => {
  const html = buildSocialReviewCardHtml({ review, aspectRatio: '1:1' });
  expect(html).not.toContain('class="context"');
  expect(html).not.toContain('Feedback from a completed Etsy order');
});

test('review card balances the quote body and labels shop attribution unambiguously', () => {
  const html = buildSocialReviewCardHtml({
    review,
    shopName: 'Zivker Art',
    contextNote: 'Custom digital photo composition service',
    aspectRatio: '4:5',
  });
  expect(html).toContain('grid-template-rows: auto 1fr auto');
  expect(html).toContain('class="review-body"');
  expect(html).toContain('class="review-footer"');
  expect(html).toContain('Review received by Zivker Art on Etsy.');
  expect(html).not.toContain('Etsy shop: Zivker Art');
});

test('AI review-card art direction is normalized and rendered without changing the exact quote', () => {
  expect(normalizeSocialReviewCardDesign(design)).toEqual({
    ...design,
    background_color: '#DCEFE5',
    surface_color: '#FFF8EF',
    text_color: '#173129',
    accent_color: '#E9573F',
  });
  const html = buildSocialReviewCardHtml({
    review,
    contextNote: 'Custom digital photo composition service',
    aspectRatio: '4:5',
    design,
  });
  expect(html).toContain('data-style="scrapbook_note"');
  expect(html).toContain('A note from an Etsy buyer');
  expect(html).toContain('<mark>looked natural</mark>');
  expect(html).toContain('The result ');
  expect(html).toContain(' and the details were handled with care.');
  expect(html).toContain('data-quote-size="short"');
  expect(html).toContain('.review-card > * { position: relative; z-index: 1; }');
});

test('review card render fingerprint changes when the AI factual note changes', () => {
  const first = socialReviewCardRenderSpecSha256({
    review,
    contextNote: 'Custom digital family photo composition service',
    aspectRatio: '1:1',
  });
  const second = socialReviewCardRenderSpecSha256({
    review,
    contextNote: 'Custom digital memorial photo composition service',
    aspectRatio: '1:1',
  });

  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(second).toMatch(/^[a-f0-9]{64}$/);
  expect(second).not.toBe(first);
});

test('review card render fingerprint changes when AI art direction changes', () => {
  const first = socialReviewCardRenderSpecSha256({ review, aspectRatio: '4:5', design });
  const second = socialReviewCardRenderSpecSha256({
    review,
    aspectRatio: '4:5',
    design: { ...design, style: 'modern_poster', accent_color: '#2878FF' },
  });
  expect(second).not.toBe(first);
});

test('review card renderer preserves the AI-selected 4:5 geometry', async () => {
  const png = await renderSocialReviewCardPng({ review, aspectRatio: '4:5', design });
  expect(Buffer.isBuffer(png)).toBe(true);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.length).toBeGreaterThan(20_000);
  await expect(sharp(png).metadata()).resolves.toMatchObject({ width: 1080, height: 1350 });
});

test('review card renderer supports a square platform frame without a portrait fallback', async () => {
  const png = await renderSocialReviewCardPng({ review, aspectRatio: '1:1' });
  await expect(sharp(png).metadata()).resolves.toMatchObject({ width: 1080, height: 1080 });
});

test('review card geometry fails closed when the AI omitted its ratio', () => {
  expect(() => socialReviewCardGeometry('')).toThrow(/missing/);
});
