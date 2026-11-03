import { test, expect } from '@playwright/test';

import { createMessagesDraftDeliveryApplication } from '../api/messages/draft-delivery-application.js';

function currentReplyState() {
  return {
    status: 'eligible',
    eligible: true,
    source_message_id: 'm1',
    latest_sent_at: '2026-08-14T01:00:00Z',
    reason: 'Reply allowed',
    code: 'MESSAGE_REPLY_ELIGIBLE',
  };
}

function baseDeps(overrides = {}) {
  return {
    bridgeApprovalPost: async () => ({ status: 'APPROVED' }),
    bridgePost: async () => ({}),
    bridgeRequest: async () => ({}),
    reconcileMessageTriggerDraft: async () => ({ matched: 1 }),
    refreshedConversationForDraft: async () => ({
      sync: { synced: true },
      conversation: { source_id: '8' },
      replyState: currentReplyState(),
    }),
    conversationReplyState: currentReplyState,
    ...overrides,
  };
}

test('draft freshness fences a draft whose source message changed', () => {
  const app = createMessagesDraftDeliveryApplication(baseDeps());
  const freshness = app.draftFreshness({
    metadata: { source_message_id: 'old-message' },
  }, { source_id: '8' });
  expect(freshness).toMatchObject({
    current: false,
    stale: true,
    code: 'MESSAGE_DRAFT_CONVERSATION_CHANGED',
    baseline_source_message_id: 'old-message',
    current_source_message_id: 'm1',
  });
});

test('refresh for review skips a stale reviewable draft and reconciles trigger state', async () => {
  const approvalCalls = [];
  const reconciliationCalls = [];
  const app = createMessagesDraftDeliveryApplication(baseDeps({
    bridgeRequest: async path => {
      expect(path).toBe('/v1/outbox/drafts/5');
      return {
        status: 'AWAITING_APPROVAL',
        conversation_id: '8',
        metadata: { source_message_id: 'old-message' },
      };
    },
    bridgeApprovalPost: async (path, body) => {
      approvalCalls.push({ path, body });
      return { status: 'SKIPPED', conversation_id: '8' };
    },
    reconcileMessageTriggerDraft: async payload => {
      reconciliationCalls.push(payload);
      return { matched: 1 };
    },
  }));

  const result = await app.refreshDraftForReview({
    draftId: '5',
    currentActor: { id: 'owner-1' },
  });
  expect(approvalCalls).toEqual([{
    path: '/v1/outbox/drafts/5/skip',
    body: {
      actor: 'owner-1',
      reason: 'The Etsy conversation changed after this draft was prepared',
    },
  }]);
  expect(reconciliationCalls[0]).toMatchObject({
    draft_id: '5',
    action: 'skipDraft',
    bridge_status: 'SKIPPED',
  });
  expect(result).toMatchObject({
    draft: { status: 'SKIPPED' },
    freshness: { current: false, stale: true },
    trigger_reconciliation: { status: 'RECONCILED', matched: 1 },
  });
});

test('approve-and-send preserves exact text, refreshes twice and uses one idempotent send key', async () => {
  let draftReads = 0;
  const approvalCalls = [];
  const sendCalls = [];
  const app = createMessagesDraftDeliveryApplication(baseDeps({
    bridgeRequest: async (path, options) => {
      if (path === '/v1/outbox/drafts/5') {
        draftReads += 1;
        return {
          status: draftReads === 1 ? 'AWAITING_APPROVAL' : 'APPROVED',
          conversation_id: '8',
          body: 'Exact reply',
          metadata: { source_message_id: 'm1' },
        };
      }
      if (path === '/v1/outbox/drafts/5/send') {
        sendCalls.push({ path, options });
        return { status: 'SENT', conversation_id: '8', body: 'Exact reply' };
      }
      throw new Error(`Unexpected path ${path}`);
    },
    bridgeApprovalPost: async (path, body) => {
      approvalCalls.push({ path, body });
      return { status: 'APPROVED', conversation_id: '8', body: body.body };
    },
  }));

  const result = await app.approveAndSendDraft({
    draftId: '5',
    approvedBody: 'Exact reply',
    currentActor: { id: 'owner-1' },
    clientRequestId: 'client request / 1',
  });

  expect(draftReads).toBe(2);
  expect(approvalCalls).toEqual([{
    path: '/v1/outbox/drafts/5/approve',
    body: { approved_by: 'owner-1', body: 'Exact reply' },
  }]);
  expect(sendCalls).toHaveLength(1);
  expect(sendCalls[0].options).toMatchObject({
    method: 'POST',
    approvalCredential: true,
    timeoutMs: 170_000,
  });
  expect(sendCalls[0].options.headers['Idempotency-Key']).toBe('approve-send-5-client_request___1');
  expect(result).toMatchObject({
    outcome: 'SENT',
    sent: true,
    idempotent_replay: false,
    delivery_attempted: true,
    retry_allowed: false,
  });
});

test('uncertain send outcome is returned as UNKNOWN and never marked retryable', async () => {
  let draftReads = 0;
  const app = createMessagesDraftDeliveryApplication(baseDeps({
    bridgeRequest: async path => {
      if (path === '/v1/outbox/drafts/5/send') throw new Error('connection lost');
      if (path === '/v1/outbox/drafts/5') {
        draftReads += 1;
        if (draftReads <= 2) {
          return {
            status: 'APPROVED', conversation_id: '8', body: 'Exact reply',
            metadata: { source_message_id: 'm1' },
          };
        }
        return { status: 'UNKNOWN', conversation_id: '8' };
      }
      throw new Error(`Unexpected path ${path}`);
    },
  }));

  const result = await app.approveAndSendDraft({
    draftId: '5',
    approvedBody: 'Exact reply',
    currentActor: { id: 'owner-1' },
    clientRequestId: 'op-1',
  });
  expect(result).toMatchObject({
    outcome: 'UNKNOWN',
    sent: false,
    delivery_attempted: true,
    retry_allowed: false,
    draft: { status: 'UNKNOWN' },
  });
});
