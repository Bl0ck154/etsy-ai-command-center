import { expect, test } from '@playwright/test';

import {
  createMessageLearningApplication,
} from '../api/messages/learning-application.js';
import { messageLearningStoreRequired } from '../api/messages/learning-runtime.js';

function repository(overrides = {}) {
  return {
    listEligibleExamples: async () => [],
    captureProposal: async input => ({ captured: true, input }),
    recordDeliveryOutcome: async input => ({ recorded: true, input }),
    recordTelegramFeedback: async input => ({ recorded: true, input }),
    validate: async () => ({ ok: true }),
    ...overrides,
  };
}

async function withLearningCapture(operation) {
  const previous = process.env.MESSAGE_LEARNING_CAPTURE_ENABLED;
  process.env.MESSAGE_LEARNING_CAPTURE_ENABLED = 'true';
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.MESSAGE_LEARNING_CAPTURE_ENABLED;
    else process.env.MESSAGE_LEARNING_CAPTURE_ENABLED = previous;
  }
}

async function withLearningInjection(operation) {
  const previous = process.env.MESSAGE_LEARNING_ENABLED;
  process.env.MESSAGE_LEARNING_ENABLED = 'true';
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.MESSAGE_LEARNING_ENABLED;
    else process.env.MESSAGE_LEARNING_ENABLED = previous;
  }
}

test('captures an immutable AI proposal with bounded buyer context after draft creation', async () => withLearningCapture(async () => {
  let captured = null;
  const app = createMessageLearningApplication({
    repository: repository({
      captureProposal: async input => {
        captured = input;
        return { captured: true };
      },
    }),
  });
  const result = await app.captureProposal({
    shopId: 'shop-1',
    draft: { id: 44, conversation_source_id: 88 },
    generated: {
      status: 'ready',
      reply_body: 'Yes, that works for me.',
      generation: { prompt_version: 'message-draft-v2-learning-memory' },
    },
    scenario: 'freeform',
    sourceMessageId: 'm2',
    conversation: {
      messages: [
        { source_id: 'm1', direction: 'outgoing', body: 'Hello' },
        { source_id: 'm2', direction: 'incoming', body: 'Can you keep it blue?' },
      ],
    },
    playbookRevision: 7,
  });

  expect(result.captured).toBe(true);
  expect(captured).toMatchObject({
    shopId: 'shop-1',
    draftId: '44',
    conversationId: '88',
    sourceMessageId: 'm2',
    buyerMessage: 'Can you keep it blue?',
    proposedBody: 'Yes, that works for me.',
    playbookRevision: 7,
  });
  expect(captured.buyerContext).toContain('buyer: Can you keep it blue?');
}));

test('learning selection failures fail open without blocking draft generation', async () => withLearningInjection(async () => {
  const app = createMessageLearningApplication({
    repository: repository({
      listEligibleExamples: async () => {
        throw new Error('temporary lock problem');
      },
    }),
  });
  await expect(app.examplesForDraft({
    shopId: 'shop-1',
    scenario: 'freeform',
    conversation: { messages: [] },
  })).resolves.toEqual([]);
}));

test('delivery UNKNOWN is recorded but never rewritten into a sent label by the application', async () => withLearningCapture(async () => {
  let outcome = null;
  const app = createMessageLearningApplication({
    repository: repository({
      recordDeliveryOutcome: async input => {
        outcome = input;
        return { recorded: true };
      },
    }),
  });
  await app.recordDeliveryOutcome({
    shopId: 'shop-1',
    draftId: 44,
    outcome: 'UNKNOWN',
    finalBody: 'Potential duplicate',
  });
  expect(outcome).toMatchObject({ outcome: 'UNKNOWN' });
}));

test('proposal recovery conflicts never suppress a confirmed delivery outcome', async () => withLearningCapture(async () => {
  let outcome = null;
  const app = createMessageLearningApplication({
    repository: repository({
      captureProposal: async () => {
        const error = new Error('immutable proposal conflict');
        error.code = 'MESSAGE_LEARNING_PROPOSAL_CONFLICT';
        throw error;
      },
      recordDeliveryOutcome: async input => {
        outcome = input;
        return { recorded: true };
      },
    }),
  });
  const result = await app.recordDeliveryOutcome({
    shopId: '12345678',
    draftId: '44',
    outcome: 'SENT',
    finalBody: 'Manager final',
    proposedDraft: {
      body: 'Recovered proposal',
      scenario: 'freeform',
      metadata: { generator: 'message_agent' },
    },
  });
  expect(result).toMatchObject({ recorded: true });
  expect(outcome).toMatchObject({ outcome: 'SENT', finalBody: 'Manager final' });
}));

test('learning store validation is required only when capture or injection is enabled', () => {
  const keys = ['MESSAGE_LEARNING_CAPTURE_ENABLED', 'MESSAGE_LEARNING_ENABLED'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    expect(messageLearningStoreRequired()).toBe(false);
    process.env.MESSAGE_LEARNING_ENABLED = 'true';
    expect(messageLearningStoreRequired()).toBe(true);
    process.env.MESSAGE_LEARNING_ENABLED = 'false';
    process.env.MESSAGE_LEARNING_CAPTURE_ENABLED = 'true';
    expect(messageLearningStoreRequired()).toBe(true);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
