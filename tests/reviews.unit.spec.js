import { test, expect } from '@playwright/test';

test.describe('reviews presentation', () => {
  test('collects official and compatible attachment fields without duplicates', async () => {
    const { reviewMediaUrls } = await import(`../public/pages/reviews-data.js?ts=${Date.now()}_media`);
    expect(reviewMediaUrls({
      image_url_fullxfull: 'https://img.example/review.jpg',
      review_image_url: 'https://img.example/review.jpg',
      attachments: [{ url: 'https://img.example/attachment.png' }, { url: 'javascript:alert(1)' }],
    })).toEqual([
      'https://img.example/review.jpg',
      'https://img.example/attachment.png',
    ]);
  });

  test('prefers an authoritative seller reply over a manual marker', async () => {
    const { reviewResponseStatus } = await import(`../public/pages/reviews-data.js?ts=${Date.now()}_reply`);
    expect(reviewResponseStatus({
      transaction_id: 42,
      seller_response: { text: 'Thank you for your kind review!' },
    }, new Set())).toEqual({
      known: true,
      responded: true,
      source: 'etsy',
      text: 'Thank you for your kind review!',
    });
  });

  test('does not classify every unmarked review as unanswered', async () => {
    const { reviewResponseSummary } = await import(`../public/pages/reviews-data.js?ts=${Date.now()}_summary`);
    expect(reviewResponseSummary([
      { transaction_id: 1 },
      { transaction_id: 2 },
      { transaction_id: 3 },
    ], new Set([2]))).toEqual({
      total: 3,
      authoritative: 0,
      authoritativeResponded: 0,
      manualResponded: 1,
      responded: 1,
      known: 1,
      unknown: 2,
    });
  });
});
