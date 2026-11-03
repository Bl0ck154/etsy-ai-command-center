import crypto from 'node:crypto';

import {
  messageAutomationConfig,
  bridgePost,
  bridgeQuery,
  bridgeRequest,
} from './bridge-client.js';
import {
  loadMessageAutomationPolicy,
  saveMessageAutomationPolicy,
} from './automation-policy.js';
import {
  loadMessagePlaybook,
  MESSAGE_SCENARIOS,
  saveMessagePlaybook,
} from './playbook.js';
import { validateMessageDraftSafety } from './draft-safety.js';
import {
  loadVerifiedListingFactsForConversation,
  loadVerifiedListingFactsForExactOrder,
} from './listing-context-evidence.js';
import { loadVerifiedOrderFactsForConversation } from './order-context-evidence.js';

const ORDER_CONTEXT_SCENARIOS = new Set([
  'how_to_send_files',
  'materials_sent_by_email',
  'missing_materials',
  'deadline_variants_sent',
  'deadline_no_materials',
  'review_request',
]);

function numericId(value, label = 'ID') {
  const id = String(value || '').trim();
  if (!/^\d+$/.test(id)) throw new Error(`${label} must be numeric`);
  return id;
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

export async function listMessageConversationsForAgent(input = {}) {
  return bridgeQuery('/v1/conversations', {
    needs_attention: input.needs_attention,
    limit: Math.max(1, Math.min(Number(input.limit) || 25, 100)),
    cursor: Math.max(0, Number(input.cursor) || 0),
    updated_after: input.updated_after,
  });
}

export async function getMessageConversationForAgent(conversationId) {
  const id = numericId(conversationId, 'Conversation ID');
  const conversationPromise = bridgeRequest(`/v1/conversations/${id}`);
  const items = [];
  const positions = new Map();
  const visitedCursors = new Set();
  let cursor = 0;
  while (!visitedCursors.has(cursor)) {
    visitedCursors.add(cursor);
    const page = await bridgeQuery(`/v1/conversations/${id}/messages`, {
      limit: 500,
      cursor,
    });
    const pageItems = Array.isArray(page?.items) ? page.items : [];
    for (const message of pageItems) {
      const key = String(message?.source_id ?? message?.id ?? '');
      if (key && positions.has(key)) {
        const position = positions.get(key);
        items[position] = { ...items[position], ...message };
      } else {
        if (key) positions.set(key, items.length);
        items.push(message);
      }
    }
    const nextCursor = Number(page?.next_cursor);
    if (
      page?.next_cursor === null
      || page?.next_cursor === undefined
      || !Number.isFinite(nextCursor)
      || nextCursor <= cursor
      || !pageItems.length
    ) break;
    cursor = nextCursor;
  }
  const conversation = await conversationPromise;
  return {
    conversation,
    messages: items,
    source: 'local_bridge_cache',
    history_was_not_refreshed: true,
  };
}

export async function updateMessagePlaybookForAgent(shopId, input, actorId) {
  const current = await loadMessagePlaybook(shopId);
  const patch = input?.patch && typeof input.patch === 'object' ? input.patch : {};
  const playbook = {
    ...current.playbook,
    ...patch,
    tone: patch.tone
      ? { ...current.playbook.tone, ...patch.tone }
      : current.playbook.tone,
    scenarios: patch.scenarios
      ? Object.fromEntries(Object.entries(current.playbook.scenarios).map(
        ([key, value]) => [key, { ...value, ...(patch.scenarios[key] || {}) }],
      ))
      : current.playbook.scenarios,
  };
  return saveMessagePlaybook(shopId, playbook, {
    expectedRevision: input.expected_revision,
    updatedBy: `agent:${cleanText(actorId, 100) || 'unknown'}`,
  });
}

export async function updateMessageAutomationPolicyForAgent(shopId, input, actorId) {
  const current = await loadMessageAutomationPolicy(shopId);
  const patch = input?.patch && typeof input.patch === 'object' ? input.patch : {};
  const policy = {
    ...current.policy,
    ...patch,
    rules: patch.rules === undefined ? current.policy.rules : patch.rules,
  };
  return saveMessageAutomationPolicy(shopId, policy, {
    expectedRevision: input.expected_revision,
    updatedBy: `agent:${cleanText(actorId, 100) || 'unknown'}`,
  });
}

export async function prepareMessageDraftForAgent(
  input,
  actorId,
  requestId,
  dependencies = {},
) {
  const conversationId = numericId(input.conversation_id, 'Conversation ID');
  const body = cleanText(input.body, 10_000);
  if (!body) throw new Error('Draft body is required');
  const scenario = cleanText(input.scenario || 'freeform', 100);
  if (!MESSAGE_SCENARIOS.includes(scenario)) {
    throw new Error('Select a valid message scenario');
  }
  const playbook = await loadMessagePlaybook(input.shop_id);
  if (playbook.playbook.scenarios[scenario]?.enabled !== true) {
    throw new Error(`Message scenario is disabled: ${scenario}`);
  }
  if (
    ORDER_CONTEXT_SCENARIOS.has(scenario)
    && messageAutomationConfig().order_linking_enabled !== true
  ) {
    const error = new Error(
      `Message scenario requires verified order context: ${scenario}`,
    );
    error.code = 'MESSAGE_ORDER_CONTEXT_DISABLED';
    throw error;
  }
  let verifiedFacts = {};
  let sourceMessageId = cleanText(input.source_message_id, 160) || null;
  if (
    scenario === 'how_to_order'
    || scenario === 'how_to_send_files'
    || scenario === 'materials_sent_by_email'
  ) {
    const loadConversation = dependencies.loadConversation
      || getMessageConversationForAgent;
    const bundle = await loadConversation(conversationId);
    const conversation = bundle?.conversation
      ? { ...bundle.conversation, messages: bundle.messages || [] }
      : bundle;
    sourceMessageId = sourceMessageId
      || cleanText([...(Array.isArray(conversation?.messages)
        ? conversation.messages
        : [])]
        .reverse()
        .find(message => (
          cleanText(message?.direction, 40).toLowerCase() === 'incoming'
        ))?.source_id, 160)
      || null;
    if (scenario === 'how_to_order') {
      const loadListingFacts = dependencies.loadListingFacts
        || loadVerifiedListingFactsForConversation;
      const listingContext = await loadListingFacts({ conversation });
      verifiedFacts = {
        listing: listingContext?.listing || null,
        listing_context: {
          exact_reference_available: Boolean(listingContext?.listing),
          unavailable_reason:
            cleanText(listingContext?.unavailable_reason, 500) || null,
        },
      };
    } else {
      const receiptIds = [...new Set([
        ...(Array.isArray(conversation?.receipt_ids)
          ? conversation.receipt_ids
          : []),
        ...(Array.isArray(conversation?.order_refs)
          ? conversation.order_refs.map(reference => reference?.receipt_id)
          : []),
      ].map(value => cleanText(value, 32)).filter(value => /^\d+$/.test(value)))];
      if (receiptIds.length !== 1) {
        const error = new Error(
          'File-delivery guidance requires exactly one linked Etsy order',
        );
        error.status = 409;
        error.code = 'MESSAGE_VERIFIED_PAID_ORDER_REQUIRED';
        throw error;
      }
      const loadOrderFacts = dependencies.loadOrderFacts
        || loadVerifiedOrderFactsForConversation;
      const sourceMessage = (Array.isArray(conversation?.messages)
        ? conversation.messages
        : []).find(message => (
        cleanText(message?.source_id || message?.id, 160) === sourceMessageId
      ));
      verifiedFacts = await loadOrderFacts({
        receiptId: receiptIds[0],
        bridgeConversation: conversation,
        ...(scenario === 'materials_sent_by_email'
          ? { checkEmailClaim: true }
          : {}),
      });
      const loadOrderListingFacts = dependencies.loadOrderListingFacts
        || loadVerifiedListingFactsForExactOrder;
      const listingContext = await loadOrderListingFacts({
        verifiedOrderFacts: verifiedFacts,
      });
      verifiedFacts.listing = listingContext?.listing || null;
      verifiedFacts.listing_context = {
        exact_reference_available: Boolean(listingContext?.listing),
        unavailable_reason:
          cleanText(listingContext?.unavailable_reason, 500) || null,
      };
    }
    const safety = validateMessageDraftSafety({
      scenario,
      replyBody: body,
      verifiedFacts,
      conversation,
      sourceMessageId,
    });
    if (!safety.ok) {
      const error = new Error(safety.reason);
      error.status = 409;
      error.code = safety.code;
      throw error;
    }
  }
  // This endpoint can only create an AWAITING_APPROVAL outbox item. This tool
  // has no access to the separate approval credential or send operation.
  const postDraft = dependencies.postDraft || bridgePost;
  return postDraft(
    '/v1/outbox/drafts',
    {
      conversation_id: conversationId,
      body,
      scenario,
      reason: cleanText(input.reason, 1_000),
      metadata: {
        generator: 'dashboard_internal_agent',
        trigger_rule_id: cleanText(input.trigger_rule_id, 80) || null,
        source_message_id: sourceMessageId,
        ...(scenario === 'how_to_order' ? {
          listing_context: {
            listing_id: verifiedFacts.listing?.listing_id || null,
            checked_at: verifiedFacts.listing?.checked_at || null,
            provenance: verifiedFacts.listing?.provenance || null,
            exact_reference_available:
              verifiedFacts.listing_context.exact_reference_available,
          },
        } : {}),
        ...(['how_to_send_files', 'materials_sent_by_email'].includes(scenario) ? {
          order_context: {
            receipt_id: verifiedFacts.order?.receipt_id || null,
            checked_at: verifiedFacts.order?.checked_at || null,
            paid: verifiedFacts.order?.paid === true,
            listing_id: verifiedFacts.listing?.listing_id || null,
            listing_checked_at: verifiedFacts.listing?.checked_at || null,
          },
        } : {}),
      },
      created_by: `agent:${cleanText(actorId, 100) || 'unknown'}`,
      submit_for_approval: true,
    },
    {
      'Idempotency-Key': `agent-draft-${cleanText(requestId, 64) || crypto.randomUUID()}-${conversationId}`.slice(0, 128),
    },
  );
}

export { loadMessageAutomationPolicy, loadMessagePlaybook };
