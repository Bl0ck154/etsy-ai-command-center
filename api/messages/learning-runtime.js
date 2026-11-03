import { bridgeQuery } from './bridge-client.js';
import { observedManualReply } from './draft-delivery-application.js';
import { createMessageLearningApplication } from './learning-application.js';
import { messageLearningRepository } from './learning-feedback-repository.js';

const application = createMessageLearningApplication({
  repository: messageLearningRepository,
});

function enabled(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

export function messageLearningStoreRequired() {
  return enabled('MESSAGE_LEARNING_CAPTURE_ENABLED')
    || enabled('MESSAGE_LEARNING_ENABLED');
}

export const {
  examplesForDraft: loadMessageLearningExamples,
  captureProposal: captureMessageLearningProposal,
  recordDeliveryOutcome: recordMessageLearningDeliveryOutcome,
  recordTelegramFeedback: recordMessageLearningTelegramFeedback,
  validateStore: validateMessageLearningStore,
} = application;

const LEARNING_DRAFT_STATUSES = new Set([
  'DRAFT',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SKIPPED',
]);
const AI_DRAFT_GENERATORS = new Set(['message_agent', 'message_trigger_runner']);

function cleanText(value, maxLength = 300) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function captureEnabled() {
  return /^(1|true|yes|on)$/i.test(
    String(process.env.MESSAGE_LEARNING_CAPTURE_ENABLED || '').trim(),
  );
}

function draftCreatedAt(draft) {
  const value = Date.parse(draft?.created_at || draft?.submitted_at || '');
  return Number.isFinite(value) ? value : 0;
}

async function listConversationDrafts(conversationId, query = bridgeQuery) {
  const items = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = 0;

  while (!seenCursors.has(cursor)) {
    seenCursors.add(cursor);
    const page = await query('/v1/outbox/drafts', {
      conversation_id: conversationId,
      limit: 200,
      cursor,
    });
    const pageItems = Array.isArray(page?.items) ? page.items : [];
    for (const draft of pageItems) {
      const id = cleanText(draft?.id, 160);
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      items.push(draft);
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

  return items;
}

export function selectObservedManualReplyCandidates({
  shopId,
  conversation,
  drafts = [],
}) {
  const byOutgoingMessage = new Map();

  for (const draft of Array.isArray(drafts) ? drafts : []) {
    const status = cleanText(draft?.status, 60).toUpperCase();
    const generator = cleanText(draft?.metadata?.generator, 120);
    if (!LEARNING_DRAFT_STATUSES.has(status)) continue;
    if (!AI_DRAFT_GENERATORS.has(generator)) continue;

    const manualReply = observedManualReply(draft, conversation, shopId);
    if (!manualReply?.source_message_id || !manualReply?.body) continue;

    const key = manualReply.source_message_id;
    const current = byOutgoingMessage.get(key);
    if (!current || draftCreatedAt(draft) > draftCreatedAt(current.draft)) {
      byOutgoingMessage.set(key, { draft, manualReply });
    }
  }

  return [...byOutgoingMessage.values()]
    .sort((left, right) => (
      Date.parse(left.manualReply.sent_at || 0)
      - Date.parse(right.manualReply.sent_at || 0)
      || draftCreatedAt(left.draft) - draftCreatedAt(right.draft)
    ));
}

export async function reconcileObservedManualRepliesForConversation(
  {
    shopId,
    conversationId,
    conversation,
  } = {},
  dependencies = {},
) {
  if (!captureEnabled()) {
    return {
      enabled: false,
      checked_drafts: 0,
      matched: 0,
      recorded: 0,
      errors: [],
    };
  }

  const id = cleanText(
    conversationId || conversation?.source_id || conversation?.id,
    160,
  );
  if (!/^\d+$/.test(id) || !conversation) {
    return {
      enabled: true,
      checked_drafts: 0,
      matched: 0,
      recorded: 0,
      errors: ['conversation_unavailable'],
    };
  }

  const query = dependencies.bridgeQuery || bridgeQuery;
  const recordOutcome = dependencies.recordOutcome
    || recordMessageLearningDeliveryOutcome;
  const drafts = Array.isArray(dependencies.drafts)
    ? dependencies.drafts
    : await listConversationDrafts(id, query);
  const candidates = selectObservedManualReplyCandidates({
    shopId,
    conversation,
    drafts,
  });

  const errors = [];
  let recorded = 0;
  for (const { draft, manualReply } of candidates) {
    try {
      await recordOutcome({
        shopId,
        draftId: cleanText(draft?.id, 160),
        outcome: 'SENT',
        finalBody: manualReply.body,
        actor: 'etsy-manual-reply-observed',
        deliveredAt: manualReply.sent_at,
        deliveryReference: `bridge-observed:${manualReply.source_message_id}`,
        proposedDraft: draft,
      });
      recorded += 1;
    } catch (error) {
      errors.push({
        draft_id: cleanText(draft?.id, 160) || null,
        code: cleanText(error?.code || error?.message, 200)
          || 'MESSAGE_LEARNING_RECONCILE_FAILED',
      });
    }
  }

  return {
    enabled: true,
    checked_drafts: drafts.length,
    matched: candidates.length,
    recorded,
    errors,
  };
}
