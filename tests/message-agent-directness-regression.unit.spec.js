import { expect, test } from '@playwright/test';

import { generateMessageDraft } from '../api/messages/draft-agent.js';
import { DEFAULT_MESSAGE_PLAYBOOK } from '../api/messages/playbook.js';

function approvedReview() {
  return {
    approved: true,
    decision: 'approve',
    answers_question_directly: true,
    uses_available_context: true,
    asks_irrelevant_question: false,
    greeting_appropriate: true,
    fabricates_internal_process: false,
    unnecessarily_defers_answer: false,
    natural_and_decisive: true,
    unsupported_claims: [],
    confidence: 0.95,
    rationale: 'Direct, grounded, and natural.',
  };
}

function ready(replyBody) {
  return {
    status: 'ready',
    scenario: 'freeform',
    reply_body: replyBody,
    language: 'English',
    confidence: 0.93,
    rationale: 'Answers the buyer.',
    facts_used: [],
    warnings: [],
    requires_human_approval: true,
    block_reason: '',
  };
}

test('freeform reviewer rewrites a fabricated check into a grounded direct reply', async () => {
  const generatedReplies = [
    ready('I am checking on the update now and will let you know shortly whether it can be completed today. If not, we can absolutely keep the second photo as it is.'),
    ready("I’ll do my best to have the updated version ready today."),
  ];
  let generationCalls = 0;
  let reviewCalls = 0;
  const conversation = {
    source_id: '1685759866',
    participant: 'Buyer',
    messages: [
      { source_id: 'm1', direction: 'incoming', body: 'I feel like the second one looks the best' },
      { source_id: 'm2', direction: 'outgoing', body: 'Just to confirm the changes you would like us to make to Option 2.' },
      { source_id: 'm3', direction: 'incoming', body: 'Yeah' },
      { source_id: 'm4', direction: 'incoming', body: 'Will it still be done today or if not I can do the second photo' },
    ],
  };

  const result = await generateMessageDraft({
    scenario: 'freeform',
    conversation,
    sourceMessageId: 'm4',
    playbook: DEFAULT_MESSAGE_PLAYBOOK,
    verifiedFacts: {},
    generate: async () => generatedReplies[generationCalls++],
    reviewDraft: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return {
          ...approvedReview(),
          approved: false,
          decision: 'block',
          fabricates_internal_process: true,
          unnecessarily_defers_answer: true,
          natural_and_decisive: false,
          confidence: 0.98,
          rationale: 'The draft invents a seller-side check and postpones a question that can be answered more directly.',
        };
      }
      return approvedReview();
    },
  });

  expect(generationCalls).toBe(2);
  expect(reviewCalls).toBe(2);
  expect(result).toMatchObject({
    status: 'ready',
    scenario: 'freeform',
    requires_human_approval: true,
  });
  expect(result.reply_body).toContain('do my best');
  expect(result.reply_body.toLowerCase()).not.toContain('checking');
  expect(result.reply_body.toLowerCase()).not.toContain('let you know shortly');
});

test('conversation context keeps chronology around the trigger instead of only a fixed tail', async () => {
  const messages = Array.from({ length: 90 }, (_, index) => ({
    source_id: `m${index + 1}`,
    direction: index % 2 === 0 ? 'incoming' : 'outgoing',
    body: `Message ${index + 1} ${'context '.repeat(20)}`,
  }));
  let suppliedPrompt;

  const result = await generateMessageDraft({
    scenario: 'freeform',
    conversation: {
      source_id: 'long-conversation',
      participant: 'Buyer',
      messages,
    },
    sourceMessageId: 'm20',
    playbook: DEFAULT_MESSAGE_PLAYBOOK,
    verifiedFacts: {},
    generate: async (_system, userPrompt) => {
      suppliedPrompt = JSON.parse(userPrompt);
      return ready('Thanks, I understand what you mean.');
    },
    reviewDraft: async () => approvedReview(),
  });

  expect(result.status).toBe('ready');
  expect(suppliedPrompt.conversation.context_coverage).toMatchObject({
    total_message_count: 90,
    complete: false,
  });
  const ids = suppliedPrompt.conversation.messages.map(message => message.source_message_id);
  expect(ids).toContain('m1');
  expect(ids).toContain('m20');
  expect(ids).toContain('m90');
  expect(ids.length).toBeLessThanOrEqual(80);
});


test('freeform reviewer trims unnecessary customer-service padding while preserving the answer', async () => {
  const generatedReplies = [
    ready('No worries at all, thank you for sending it. We can work with this photo and will do our best to create a beautiful result for you.'),
    ready('No worries, we can work with this photo. Thank you for sending it.'),
  ];
  let generationCalls = 0;
  let reviewCalls = 0;
  const conversation = {
    source_id: 'cropped-photo-conversation',
    participant: 'Buyer',
    messages: [
      { source_id: 'm1', direction: 'outgoing', body: 'Could you please send me the original photo instead of a screenshot for a better final result.' },
      { source_id: 'm2', direction: 'incoming', body: 'I’ve cropped it but that’s all I have' },
    ],
  };

  const result = await generateMessageDraft({
    scenario: 'freeform',
    conversation,
    sourceMessageId: 'm2',
    playbook: DEFAULT_MESSAGE_PLAYBOOK,
    verifiedFacts: {},
    generate: async () => generatedReplies[generationCalls++],
    reviewDraft: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return {
          ...approvedReview(),
          approved: false,
          decision: 'block',
          natural_and_decisive: false,
          confidence: 0.94,
          rationale: 'The answer is correct but adds unnecessary generic reassurance and decorative language beyond what this simple confirmation needs.',
        };
      }
      return approvedReview();
    },
  });

  expect(generationCalls).toBe(2);
  expect(reviewCalls).toBe(2);
  expect(result).toMatchObject({ status: 'ready', scenario: 'freeform' });
  expect(result.reply_body).toBe('No worries, we can work with this photo. Thank you for sending it.');
});


test('freeform reviewer does not turn uncertainty into a refusal or premature fallback', async () => {
  const generatedReplies = [
    ready('I’m sorry, but I can’t guarantee it will be ready today. If you need it today, please go with the second photo.'),
    ready('I’ll do my best to have the updated version ready today.'),
  ];
  let generationCalls = 0;
  let reviewCalls = 0;
  const conversation = {
    source_id: 'timing-uncertainty',
    participant: 'Buyer',
    messages: [
      { source_id: 'm1', direction: 'outgoing', body: 'Just to confirm the changes you would like us to make to Option 2.' },
      { source_id: 'm2', direction: 'incoming', body: 'Yeah' },
      { source_id: 'm3', direction: 'incoming', body: 'Will it still be done today or if not I can do the second photo' },
    ],
  };

  const result = await generateMessageDraft({
    scenario: 'freeform',
    conversation,
    sourceMessageId: 'm3',
    playbook: DEFAULT_MESSAGE_PLAYBOOK,
    verifiedFacts: {},
    generate: async () => generatedReplies[generationCalls++],
    reviewDraft: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return {
          ...approvedReview(),
          approved: false,
          decision: 'block',
          natural_and_decisive: false,
          confidence: 0.96,
          rationale: 'The reply treats lack of a guarantee as if the shop cannot try to meet the requested timing and prematurely redirects the buyer to a fallback without evidence of a blocker.',
        };
      }
      return approvedReview();
    },
  });

  expect(generationCalls).toBe(2);
  expect(reviewCalls).toBe(2);
  expect(result).toMatchObject({ status: 'ready', scenario: 'freeform' });
  expect(result.reply_body).toContain('do my best');
  expect(result.reply_body.toLowerCase()).not.toContain('please go with the second photo');
});


test('freeform quality rejection gets one semantic rewrite even when the issue is an unsupported claim', async () => {
  const generatedReplies = [
    ready('It should still be completed today.'),
    ready('We’ll do our best to have the updated version ready today.'),
  ];
  let generationCalls = 0;
  let reviewCalls = 0;
  const conversation = {
    source_id: 'timing-quality-rewrite',
    participant: 'Buyer',
    messages: [
      { source_id: 'm1', direction: 'outgoing', body: 'Just to confirm the changes you would like us to make.' },
      { source_id: 'm2', direction: 'incoming', body: 'Will it still be done today?' },
    ],
  };

  const result = await generateMessageDraft({
    scenario: 'freeform',
    conversation,
    sourceMessageId: 'm2',
    playbook: DEFAULT_MESSAGE_PLAYBOOK,
    verifiedFacts: {},
    generate: async () => generatedReplies[generationCalls++],
    reviewDraft: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return {
          ...approvedReview(),
          approved: false,
          decision: 'block',
          unsupported_claims: ['Same-day completion is not verified.'],
          confidence: 0.97,
          rationale: 'The draft presents same-day completion as an expected outcome instead of a qualified intention or effort.',
        };
      }
      return approvedReview();
    },
  });

  expect(generationCalls).toBe(2);
  expect(reviewCalls).toBe(2);
  expect(result).toMatchObject({ status: 'ready', scenario: 'freeform' });
  expect(result.reply_body).toContain('do our best');
});
