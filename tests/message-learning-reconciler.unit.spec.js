import { expect, test } from '@playwright/test';

import {
  reconcileObservedManualRepliesForConversation,
  selectObservedManualReplyCandidates,
} from '../api/messages/learning-runtime.js';

function draft({
  id,
  createdAt,
  body,
  generator = 'message_trigger_runner',
  status = 'AWAITING_APPROVAL',
  sourceMessageId = 'buyer-1',
} = {}) {
  return {
    id: String(id),
    status,
    body,
    scenario: 'freeform',
    conversation_source_id: '1250240141',
    created_at: createdAt,
    metadata: {
      generator,
      dashboard_shop_id: '12345678',
      source_message_id: sourceMessageId,
    },
  };
}

function conversation() {
  return {
    source_id: '1250240141',
    messages: [
      {
        source_id: 'buyer-1',
        direction: 'incoming',
        body: 'Can you make the background blue?',
        sent_at: '2026-08-25T10:00:00.000Z',
      },
      {
        source_id: 'shop-1',
        direction: 'outgoing',
        body: 'Yes, I can do that. Thank you for your order!',
        sent_at: '2026-08-25T10:05:00.000Z',
      },
      {
        source_id: 'buyer-2',
        direction: 'incoming',
        body: 'Perfect, thank you.',
        sent_at: '2026-08-25T10:10:00.000Z',
      },
    ],
  };
}

test('manual reply learning survives a later buyer message and picks only the latest AI proposal', () => {
  const selected = selectObservedManualReplyCandidates({
    shopId: '12345678',
    conversation: conversation(),
    drafts: [
      draft({
        id: 10,
        createdAt: '2026-08-25T10:01:00.000Z',
        body: 'Older AI proposal',
      }),
      draft({
        id: 11,
        createdAt: '2026-08-25T10:03:00.000Z',
        body: 'Latest AI proposal',
      }),
      draft({
        id: 12,
        createdAt: '2026-08-25T10:04:00.000Z',
        body: 'Human draft should not be learned',
        generator: 'human',
      }),
    ],
  });

  expect(selected).toHaveLength(1);
  expect(selected[0].draft.id).toBe('11');
  expect(selected[0].manualReply).toMatchObject({
    source_message_id: 'shop-1',
    body: 'Yes, I can do that. Thank you for your order!',
  });
});

test('conversation reconciliation uses cached Bridge drafts only and records the observed Etsy reply', async () => {
  const previous = process.env.MESSAGE_LEARNING_CAPTURE_ENABLED;
  process.env.MESSAGE_LEARNING_CAPTURE_ENABLED = 'true';
  const calls = [];
  const outcomes = [];
  try {
    const result = await reconcileObservedManualRepliesForConversation({
      shopId: '12345678',
      conversationId: '1250240141',
      conversation: conversation(),
    }, {
      bridgeQuery: async (path, params) => {
        calls.push({ path, params });
        expect(path).toBe('/v1/outbox/drafts');
        expect(params).toMatchObject({
          conversation_id: '1250240141',
          limit: 200,
          cursor: 0,
        });
        return {
          items: [
            draft({
              id: 20,
              createdAt: '2026-08-25T10:02:00.000Z',
              body: 'Original AI suggestion',
            }),
          ],
          next_cursor: null,
        };
      },
      recordOutcome: async input => {
        outcomes.push(input);
        return { recorded: true };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).not.toContain('sync');
    expect(result).toMatchObject({
      enabled: true,
      checked_drafts: 1,
      matched: 1,
      recorded: 1,
      errors: [],
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      shopId: '12345678',
      draftId: '20',
      outcome: 'SENT',
      finalBody: 'Yes, I can do that. Thank you for your order!',
      actor: 'etsy-manual-reply-observed',
      deliveredAt: '2026-08-25T10:05:00.000Z',
      deliveryReference: 'bridge-observed:shop-1',
      proposedDraft: { id: '20', body: 'Original AI suggestion' },
    });
  } finally {
    if (previous === undefined) delete process.env.MESSAGE_LEARNING_CAPTURE_ENABLED;
    else process.env.MESSAGE_LEARNING_CAPTURE_ENABLED = previous;
  }
});

test('conversation reconciliation is inert when learning capture is disabled', async () => {
  const previous = process.env.MESSAGE_LEARNING_CAPTURE_ENABLED;
  process.env.MESSAGE_LEARNING_CAPTURE_ENABLED = 'false';
  let queried = false;
  try {
    const result = await reconcileObservedManualRepliesForConversation({
      shopId: '12345678',
      conversationId: '1250240141',
      conversation: conversation(),
    }, {
      bridgeQuery: async () => {
        queried = true;
        return { items: [], next_cursor: null };
      },
    });
    expect(result).toMatchObject({
      enabled: false,
      checked_drafts: 0,
      matched: 0,
      recorded: 0,
    });
    expect(queried).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.MESSAGE_LEARNING_CAPTURE_ENABLED;
    else process.env.MESSAGE_LEARNING_CAPTURE_ENABLED = previous;
  }
});
