import { expect, test } from '@playwright/test';

import {
  reviewMessageDraftQuality,
  validateDraftQualityReview,
} from '../api/messages/draft-quality.js';

test('quality review fails closed on every required dimension', () => {
  expect(validateDraftQualityReview({
    decision: 'approve',
    answers_question_directly: false,
    uses_available_context: true,
    asks_irrelevant_question: true,
    greeting_appropriate: false,
    fabricates_internal_process: false,
    unnecessarily_defers_answer: false,
    natural_and_decisive: true,
    unsupported_claims: [],
    confidence: 0.99,
    rationale: 'The reply asks a different question.',
  })).toMatchObject({
    approved: false,
    confidence: 0.99,
  });
});

test('independent reviewer sees exact Sample Buyer question and proposed reply', async () => {
  let payload;
  const review = await reviewMessageDraftQuality({
    scenario: 'how_to_send_files',
    sourceMessageId: '7482075658',
    conversation: {
      participant: 'Sample Buyer',
      messages: [{
        source_id: '7482075658',
        direction: 'incoming',
        sender: 'Sample Buyer',
        body: 'Hey can I send you the photos for my order on here?',
      }],
    },
    replyBody: (
      'Hi Sample Buyer, yes, you can send the photos here in this Etsy conversation.'
    ),
    verifiedFacts: {
      order: {
        linked: true,
        receipt_id: '4130532997',
        checked_at: '2026-07-30T01:43:00Z',
      },
    },
    shopContext: {
      summary: 'Custom digital portrait workflow.',
      workflow: ['Buyer feedback can lead to revisions.'],
    },
    sellerStyleReference: {
      available: true,
      priority: 'strong',
      corpus_message_count: 456,
      unique_message_count: 427,
      conversation_count: 60,
      profile: { average_chars: 95 },
      recurring_replies: [{ text: 'Thank you!', count: 12 }],
      examples: [{ body: 'This raw example should not be duplicated into the review payload.' }],
    },
    generate: async (_system, input) => {
      payload = JSON.parse(input);
      return {
        decision: 'approve',
        answers_question_directly: true,
        uses_available_context: true,
        asks_irrelevant_question: false,
        greeting_appropriate: true,
        fabricates_internal_process: false,
        unnecessarily_defers_answer: false,
        natural_and_decisive: true,
        unsupported_claims: [],
        confidence: 0.94,
        rationale: 'Direct, grounded, and appropriately greeted.',
      };
    },
  });

  expect(payload.triggering_source_message_id).toBe('7482075658');
  expect(payload.proposed_reply).toContain('yes, you can send the photos here');
  expect(payload.shop_context.summary).toContain('portrait');
  expect(payload.seller_style_reference).toMatchObject({
    available: true,
    priority: 'strong',
    corpus_message_count: 456,
  });
  expect(payload.seller_style_reference.examples).toBeUndefined();
  expect(review).toMatchObject({ approved: true, confidence: 0.94 });
});


test('semantic approval is not blocked by an arbitrary confidence threshold', () => {
  const review = validateDraftQualityReview({
    decision: 'approve',
    answers_question_directly: true,
    uses_available_context: true,
    asks_irrelevant_question: false,
    greeting_appropriate: true,
    fabricates_internal_process: false,
    unnecessarily_defers_answer: false,
    natural_and_decisive: true,
    unsupported_claims: [],
    confidence: 0.62,
    rationale: 'The response is grounded and directly useful; confidence is advisory metadata.',
  });

  expect(review).toMatchObject({ approved: true, confidence: 0.62 });
});
