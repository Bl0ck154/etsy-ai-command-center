import { test, expect } from '@playwright/test';

import { createMessagesDraftLifecycleApplication } from '../api/messages/draft-lifecycle-application.js';

function appWith(overrides = {}) {
  return createMessagesDraftLifecycleApplication({
    bridgeApprovalPost: async () => ({ status: 'APPROVED' }),
    bridgeRequest: async () => ({ status: 'SENT' }),
    refreshDraftForReview: async () => ({
      freshness: { current: true, code: 'MESSAGE_DRAFT_CURRENT' },
    }),
    reconcileDraftAction: async () => ({ status: 'RECONCILED', matched: 1 }),
    ...overrides,
  });
}

test('approve draft rejects blank exact text before bridge mutation', async () => {
  let calls = 0;
  const app = appWith({
    bridgeApprovalPost: async () => {
      calls += 1;
      return {};
    },
  });
  const result = await app.approveDraft({
    draftId: '5', approvedBody: '   ', currentActor: { id: 'owner-1' },
  });
  expect(result).toEqual({ valid: false, error: 'Approved message text is required' });
  expect(calls).toBe(0);
});

test('approve draft fails closed when refresh reports stale conversation', async () => {
  const app = appWith({
    refreshDraftForReview: async () => ({
      freshness: {
        current: false,
        code: 'MESSAGE_DRAFT_CONVERSATION_CHANGED',
        reason: 'Conversation changed',
      },
    }),
  });
  const result = await app.approveDraft({
    draftId: '5', approvedBody: 'Exact', currentActor: { id: 'owner-1' },
  });
  expect(result).toMatchObject({
    valid: true,
    current: false,
    freshness: { code: 'MESSAGE_DRAFT_CONVERSATION_CHANGED' },
  });
});

test('approve draft preserves exact bridge payload and trigger reconciliation', async () => {
  const bridgeCalls = [];
  const reconcileCalls = [];
  const app = appWith({
    bridgeApprovalPost: async (path, body) => {
      bridgeCalls.push({ path, body });
      return { status: 'APPROVED', body: body.body };
    },
    reconcileDraftAction: async input => {
      reconcileCalls.push(input);
      return { status: 'RECONCILED', matched: 1 };
    },
  });
  const result = await app.approveDraft({
    draftId: '5', approvedBody: ' Exact ', currentActor: { id: 'owner-1' },
  });
  expect(bridgeCalls).toEqual([{
    path: '/v1/outbox/drafts/5/approve',
    body: { approved_by: 'owner-1', body: 'Exact' },
  }]);
  expect(reconcileCalls[0]).toMatchObject({ action: 'approveDraft', draftId: '5' });
  expect(result).toMatchObject({
    current: true,
    draft: { status: 'APPROVED', body: 'Exact' },
    trigger_reconciliation: { status: 'RECONCILED' },
  });
});

test('send approved draft preserves approval credential and freshness fence', async () => {
  const calls = [];
  const app = appWith({
    bridgeRequest: async (path, options) => {
      calls.push({ path, options });
      return { status: 'SENT' };
    },
  });
  const result = await app.sendApprovedDraft({
    draftId: '9', currentActor: { id: 'owner-1' },
  });
  expect(calls).toEqual([{
    path: '/v1/outbox/drafts/9/send',
    options: { method: 'POST', approvalCredential: true },
  }]);
  expect(result).toMatchObject({ current: true, draft: { status: 'SENT' } });
});

test('skip and block preserve reason truncation and action-specific reconciliation', async () => {
  const bridgeCalls = [];
  const reconcileCalls = [];
  const app = appWith({
    bridgeApprovalPost: async (path, body) => {
      bridgeCalls.push({ path, body });
      return { status: path.endsWith('/skip') ? 'SKIPPED' : 'BLOCKED' };
    },
    reconcileDraftAction: async input => {
      reconcileCalls.push(input);
      return { status: 'RECONCILED', matched: 1 };
    },
  });
  await app.skipDraft({ draftId: '1', currentActor: { id: 'owner' }, reason: 'skip' });
  await app.blockDraft({ draftId: '2', currentActor: { id: 'owner' }, reason: 'block' });
  expect(bridgeCalls).toEqual([
    { path: '/v1/outbox/drafts/1/skip', body: { actor: 'owner', reason: 'skip' } },
    { path: '/v1/outbox/drafts/2/block', body: { actor: 'owner', reason: 'block' } },
  ]);
  expect(reconcileCalls.map(call => call.action)).toEqual(['skipDraft', 'blockDraft']);
});
