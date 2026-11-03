import { expect, test } from '@playwright/test';

import { createMessagesDraftDeliveryApplication } from '../api/messages/draft-delivery-application.js';
import { createMessagesDraftGenerationApplication } from '../api/messages/draft-generation-application.js';
import { createMessagesDraftLifecycleApplication } from '../api/messages/draft-lifecycle-application.js';

test('interactive AI draft loads semantic memory and captures the immutable proposal after Bridge assigns an ID', async () => {
  const learned = [{ id: 'mlf-1', preferred_reply: 'A prior confirmed reply.' }];
  let generationInput = null;
  let captured = null;
  const app = createMessagesDraftGenerationApplication({
    bridgeStatus: async () => ({ account: { shop_id: '23207964' } }),
    runtimeStatus: status => ({ ...status, order_linking_enabled: true }),
    refreshedConversationForDraft: async () => ({
      conversation: {
        source_id: '88',
        messages: [{ source_id: 'm-new', direction: 'incoming', body: 'Can you keep it blue?' }],
      },
      replyState: { eligible: true, source_message_id: 'm-new' },
      sync: { ok: true },
    }),
    loadMessagePlaybook: async () => ({
      revision: 9,
      playbook: { scenarios: { freeform: { enabled: true } } },
    }),
    loadVerifiedListingFactsForConversation: async () => null,
    loadShopSellerStyleReference: async () => ({ available: false }),
    loadMessageLearningExamples: async () => learned,
    generateMessageDraft: async input => {
      generationInput = input;
      return {
        status: 'ready',
        reply_body: 'Yes, I can keep it blue.',
        rationale: 'Direct answer',
        language: 'en',
        confidence: 0.9,
        facts_used: [],
        warnings: [],
        generation: { prompt_version: 'message-draft-v2-learning-memory' },
      };
    },
    createOutboxDraft: async input => ({
      id: '501',
      conversation_source_id: input.conversationId,
      body: input.body,
      metadata: input.metadata,
    }),
    captureMessageLearningProposal: async input => {
      captured = input;
      return { captured: true, id: 'mlf-new' };
    },
  });

  const result = await app.generateDraft({
    shopId: '23207964',
    input: { scenario: 'freeform', conversation_id: '88', client_request_id: 'req-1' },
    currentActor: { id: 'owner' },
  });

  expect(generationInput.sourceMessageId).toBe('m-new');
  expect(generationInput.learnedExamples).toEqual(learned);
  expect(result.draft.metadata.learned_example_ids).toEqual(['mlf-1']);
  expect(captured).toMatchObject({
    shopId: '23207964',
    draft: { id: '501' },
    generated: { reply_body: 'Yes, I can keep it blue.' },
    sourceMessageId: 'm-new',
    playbookRevision: 9,
  });
  expect(result.learning).toMatchObject({ captured: true, id: 'mlf-new' });
});

test('combined delivery records edited SENT preference without changing delivery semantics', async () => {
  const bridgeDraft = {
    id: 501,
    status: 'AWAITING_APPROVAL',
    body: 'Original AI proposal',
    scenario: 'freeform',
    conversation_source_id: 88,
    metadata: { generator: 'message_agent', source_message_id: 'm-new' },
  };
  let approved = false;
  let sent = false;
  let outcomeInput = null;
  const currentDraft = () => ({
    ...bridgeDraft,
    status: sent ? 'SENT' : approved ? 'APPROVED' : 'AWAITING_APPROVAL',
    body: approved ? 'Manager edited final' : bridgeDraft.body,
  });
  const app = createMessagesDraftDeliveryApplication({
    bridgeApprovalPost: async () => {
      approved = true;
      return currentDraft();
    },
    bridgePost: async () => null,
    bridgeRequest: async path => {
      if (path.endsWith('/send')) {
        sent = true;
        return currentDraft();
      }
      return currentDraft();
    },
    reconcileMessageTriggerDraft: async () => ({ matched: 0 }),
    refreshedConversationForDraft: async () => ({
      conversation: { messages: [{ source_id: 'm-new', direction: 'incoming', body: 'Question' }] },
      sync: { ok: true },
    }),
    conversationReplyState: () => ({
      status: 'eligible',
      eligible: true,
      source_message_id: 'm-new',
    }),
    recordMessageLearningDeliveryOutcome: async input => {
      outcomeInput = input;
      return { recorded: true, label: 'edited_sent' };
    },
  });

  const result = await app.approveAndSendDraft({
    shopId: '23207964',
    draftId: '501',
    approvedBody: 'Manager edited final',
    currentActor: { id: 'owner' },
    clientRequestId: 'req-2',
  });

  expect(result).toMatchObject({ sent: true, outcome: 'SENT', retry_allowed: false });
  expect(outcomeInput).toMatchObject({
    shopId: '23207964',
    draftId: '501',
    outcome: 'SENT',
    finalBody: 'Manager edited final',
    proposedDraft: { body: 'Original AI proposal' },
  });
});

test('review refresh conservatively learns one Bridge-observed manual Etsy reply', async () => {
  const proposal = {
    id: 700,
    status: 'AWAITING_APPROVAL',
    body: 'Original AI proposal',
    scenario: 'freeform',
    conversation_source_id: 99,
    created_at: '2026-08-24T10:01:00.000Z',
    metadata: { generator: 'message_agent', source_message_id: 'buyer-1' },
  };
  let learned = null;
  const app = createMessagesDraftDeliveryApplication({
    bridgeApprovalPost: async () => ({ ...proposal, status: 'SKIPPED' }),
    bridgePost: async () => null,
    bridgeRequest: async () => proposal,
    reconcileMessageTriggerDraft: async () => ({ matched: 0 }),
    refreshedConversationForDraft: async () => ({
      conversation: {
        messages: [
          {
            source_id: 'buyer-1',
            direction: 'incoming',
            body: 'Could you keep it blue?',
            sent_at: '2026-08-24T10:00:00.000Z',
          },
          {
            source_id: 'shop-1',
            direction: 'outgoing',
            body: 'Yes, I can keep it blue.',
            sent_at: '2026-08-24T10:05:00.000Z',
          },
        ],
      },
      sync: { ok: true },
    }),
    conversationReplyState: () => ({
      status: 'no_action',
      eligible: false,
      source_message_id: 'shop-1',
      latest_direction: 'outgoing',
      code: 'MESSAGE_DRAFT_ALREADY_ANSWERED',
      reason: 'The newest authored message is already a shop reply',
    }),
    recordMessageLearningDeliveryOutcome: async input => {
      learned = input;
      return { recorded: true, label: 'edited_sent' };
    },
  });

  const refreshed = await app.refreshDraftForReview({
    shopId: '23207964',
    draftId: '700',
    currentActor: { id: 'owner' },
  });
  expect(refreshed.draft.status).toBe('SKIPPED');
  expect(learned).toMatchObject({
    shopId: '23207964',
    draftId: '700',
    outcome: 'SENT',
    finalBody: 'Yes, I can keep it blue.',
    actor: 'etsy-manual-reply-observed',
    deliveryReference: 'bridge-observed:shop-1',
    proposedDraft: { body: 'Original AI proposal' },
  });
});

test('repeated approval never mistakes an already edited APPROVED body for the AI proposal', async () => {
  let proposalCaptures = 0;
  const approvedDraft = {
    id: 901,
    status: 'APPROVED',
    body: 'Manager edited final',
    scenario: 'freeform',
    metadata: { generator: 'message_agent', source_message_id: 'buyer-1' },
  };
  const app = createMessagesDraftLifecycleApplication({
    bridgeApprovalPost: async () => approvedDraft,
    bridgeRequest: async () => approvedDraft,
    refreshDraftForReview: async () => ({
      draft: approvedDraft,
      conversation: { messages: [] },
      freshness: { current: true },
    }),
    reconcileDraftAction: async () => ({ status: 'NOT_LINKED', matched: 0 }),
    captureMessageLearningProposal: async () => {
      proposalCaptures += 1;
    },
  });
  const result = await app.approveDraft({
    shopId: '23207964',
    draftId: '901',
    approvedBody: 'Manager edited final',
    currentActor: { id: 'owner' },
  });
  expect(result.current).toBe(true);
  expect(proposalCaptures).toBe(0);
});
