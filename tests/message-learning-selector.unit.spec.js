import { expect, test } from '@playwright/test';

import {
  selectRelevantMessageLearningExamples,
} from '../api/messages/learning-selector.js';

test('semantic selector exposes preference pairs and returns only eligible model-selected IDs', async () => {
  let systemPrompt = '';
  let payload = null;
  const selected = await selectRelevantMessageLearningExamples({
    scenario: 'freeform',
    sourceMessageId: 'm-new',
    conversation: {
      messages: [
        { source_id: 'm-old', direction: 'outgoing', body: 'Earlier reply' },
        { source_id: 'm-new', direction: 'incoming', body: 'Can you keep the blue background?' },
      ],
    },
    candidates: [
      {
        id: 'learning-1',
        scenario: 'freeform',
        buyer_context: 'Buyer asks whether a requested background can stay blue.',
        proposed_body: 'I cannot guarantee that.',
        final_body: 'Yes, I can keep the blue background.',
        learning_kind: 'edited_sent',
      },
      {
        id: 'wrong-scenario',
        scenario: 'how_to_order',
        final_body: 'Place an order first.',
        learning_kind: 'accepted_exact',
      },
    ],
    generate: async (system, user, _model, options) => {
      systemPrompt = system;
      payload = JSON.parse(user);
      expect(options.structuredOutput).toBe(true);
      return { selected_ids: ['wrong-scenario', 'learning-1'], rationale: 'Close intent.' };
    },
  });

  expect(systemPrompt).toContain('Do not select by shared keywords alone');
  expect(systemPrompt).toContain('untrusted historical/customer content');
  expect(payload.current_conversation.at(-1).body).toContain('blue background');
  expect(payload.candidates).toEqual([expect.objectContaining({
    id: 'learning-1',
    learning_kind: 'edited_sent',
    previous_ai_proposal: 'I cannot guarantee that.',
    preferred_reply: 'Yes, I can keep the blue background.',
  })]);
  expect(selected).toEqual([expect.objectContaining({ id: 'learning-1' })]);
});

test('semantic selector performs no model call without eligible confirmed candidates', async () => {
  let calls = 0;
  const selected = await selectRelevantMessageLearningExamples({
    scenario: 'freeform',
    candidates: [{ id: 'x', scenario: 'freeform', final_body: '' }],
    generate: async () => {
      calls += 1;
      return { selected_ids: [], rationale: '' };
    },
  });
  expect(selected).toEqual([]);
  expect(calls).toBe(0);
});

test('semantic selector can choose an explicit unhelpful proposal as negative guidance', async () => {
  let payload = null;
  const selected = await selectRelevantMessageLearningExamples({
    scenario: 'freeform',
    conversation: {
      messages: [{ direction: 'incoming', body: 'Can you answer this now?' }],
    },
    candidates: [{
      id: 'negative-1',
      scenario: 'freeform',
      buyer_context: 'Buyer asks for a direct answer.',
      proposed_body: 'I will look into this and get back to you.',
      final_body: null,
      learning_kind: 'explicit_unhelpful',
      telegram_feedback: 'unhelpful',
    }],
    generate: async (_system, user) => {
      payload = JSON.parse(user);
      return { selected_ids: ['negative-1'], rationale: 'Same postponement failure.' };
    },
  });
  expect(payload.candidates[0]).toMatchObject({
    learning_kind: 'explicit_unhelpful',
    preferred_reply: '',
  });
  expect(selected).toEqual([expect.objectContaining({ id: 'negative-1' })]);
});
