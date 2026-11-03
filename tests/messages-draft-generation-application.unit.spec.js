import { test, expect } from '@playwright/test';

import { createMessagesDraftGenerationApplication } from '../api/messages/draft-generation-application.js';

function baseDeps(overrides = {}) {
  return {
    bridgeStatus: async () => ({ account: { mode: 'production', label: 'live' } }),
    runtimeStatus: status => ({ account: status.account, order_linking_enabled: true }),
    refreshedConversationForDraft: async () => ({
      sync: { synced: true },
      conversation: { source_id: '7', messages: [] },
      replyState: { eligible: true, source_message_id: 'm1' },
    }),
    loadMessagePlaybook: async () => ({ revision: 3, playbook: { examples: [] } }),
    loadVerifiedListingFactsForConversation: async () => ({
      listing: { listing_id: 10, title: 'Listing' },
      unavailable_reason: null,
    }),
    loadShopSellerStyleReference: async () => ({
      available: true,
      scope: 'shop_wide_cached_outgoing',
      corpus_message_count: 25,
      conversation_count: 8,
      profile: {},
      recurring_replies: [],
      examples: [],
    }),
    generateMessageDraft: async ({ scenario }) => ({
      status: 'ready',
      scenario,
      reply_body: 'Reply',
      rationale: 'Reason',
      language: 'en',
      confidence: 0.9,
      facts_used: [],
      warnings: [],
    }),
    createOutboxDraft: async values => ({ id: 'd1', ...values }),
    ...overrides,
  };
}

test('preview without conversation stays preview-only and does not queue', async () => {
  let generatedInput;
  const app = createMessagesDraftGenerationApplication(baseDeps({
    runtimeStatus: status => ({ account: status.account, order_linking_enabled: false }),
    generateMessageDraft: async input => {
      generatedInput = input;
      return {
        status: 'ready', scenario: input.scenario, reply_body: 'Preview',
        rationale: '', language: 'en', confidence: 0.7, facts_used: [], warnings: [],
      };
    },
  }));

  const result = await app.previewDraft({
    shopId: 'shop-1',
    input: {
      scenario: 'review_request',
      customer_message: 'Thanks!',
      participant: 'Buyer',
      simulated_facts: { order: { receipt_id: 1 } },
    },
  });

  expect(generatedInput.conversation).toMatchObject({
    source_id: 'playbook-preview',
    participant: 'Buyer',
  });
  expect(result).toMatchObject({
    preview_only: true,
    simulation_only: true,
    queued: false,
    sent: false,
    playbook_revision: 3,
  });
});

test('generated draft returns a plain blocked result before outbox creation', async () => {
  let createCalls = 0;
  const app = createMessagesDraftGenerationApplication(baseDeps({
    generateMessageDraft: async () => ({
      status: 'no_action',
      block_reason: 'No reply needed',
    }),
    createOutboxDraft: async () => {
      createCalls += 1;
      return {};
    },
  }));

  const result = await app.generateDraft({
    shopId: 'shop-1',
    input: { scenario: 'freeform', conversation_id: '7' },
    currentActor: { id: 'owner-1' },
  });

  expect(result).toMatchObject({
    ready: false,
    error: 'No reply needed',
    code: 'MESSAGE_DRAFT_NO_ACTION',
  });
  expect(createCalls).toBe(0);
});

test('generated draft binds refreshed conversation head and playbook revision to outbox metadata', async () => {
  let outboxInput;
  const app = createMessagesDraftGenerationApplication(baseDeps({
    createOutboxDraft: async input => {
      outboxInput = input;
      return { id: 'd1' };
    },
  }));

  const result = await app.generateDraft({
    shopId: 'shop-1',
    input: { scenario: 'how_to_order', conversation_id: '7', client_request_id: 'client-1' },
    currentActor: { id: 'owner-1' },
  });

  expect(outboxInput).toMatchObject({
    conversationId: '7',
    body: 'Reply',
    scenario: 'how_to_order',
    createdBy: 'owner-1',
    clientRequestId: 'client-1',
    metadata: {
      generator: 'message_agent',
      playbook_revision: 3,
      dashboard_shop_id: 'shop-1',
      source_message_id: 'm1',
    },
  });
  expect(result).toMatchObject({ ready: true, draft: { id: 'd1' } });
});

test('manual draft preserves live scenario gate and human metadata', async () => {
  let outboxInput;
  const app = createMessagesDraftGenerationApplication(baseDeps({
    createOutboxDraft: async input => {
      outboxInput = input;
      return { id: 'manual-1' };
    },
  }));
  const result = await app.createManualDraft({
    shopId: 'shop-1',
    input: {
      scenario: 'freeform', conversation_id: '7', body: '  Exact manual reply  ',
      client_request_id: 'manual-client',
    },
    currentActor: { id: 'owner-2' },
  });
  expect(result).toEqual({ valid: true, draft: { id: 'manual-1' } });
  expect(outboxInput).toMatchObject({
    body: 'Exact manual reply',
    metadata: { generator: 'human', dashboard_shop_id: 'shop-1' },
    createdBy: 'owner-2',
  });
});
