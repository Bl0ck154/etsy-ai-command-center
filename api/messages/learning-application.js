import { selectRelevantMessageLearningExamples } from './learning-selector.js';

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function enabled(name, defaultValue = true) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

function normalizedContext(conversation, sourceMessageId) {
  const messages = (Array.isArray(conversation?.messages)
    ? conversation.messages
    : [])
    .map(message => ({
      source_message_id: cleanText(message?.source_id || message?.id, 160) || null,
      direction: cleanText(message?.direction, 40).toLowerCase(),
      body: cleanText(message?.body, 2_000),
      sent_at: cleanText(message?.sent_at, 80) || null,
    }))
    .filter(message => (
      ['incoming', 'outgoing'].includes(message.direction)
      && message.body
    ));
  const targetId = cleanText(sourceMessageId, 160);
  const sourceIndex = messages.findIndex(message => (
    message.source_message_id === targetId
  ));
  const selected = sourceIndex < 0
    ? messages.slice(-12)
    : messages.slice(Math.max(0, sourceIndex - 8), sourceIndex + 3);
  const buyerMessage = (
    (sourceIndex >= 0 && messages[sourceIndex]?.direction === 'incoming'
      ? messages[sourceIndex]
      : [...messages].reverse().find(message => message.direction === 'incoming'))
    || null
  );
  return {
    buyerMessage: cleanText(buyerMessage?.body, 2_000) || null,
    buyerContext: selected
      .map(message => `${message.direction === 'incoming' ? 'buyer' : 'shop'}: ${message.body}`)
      .join('\n')
      .slice(0, 12_000),
    contextMessages: selected,
  };
}

function learningError(label, error, context = {}) {
  console.error(`[messages-learning] ${label}`, {
    ...context,
    code: cleanText(error?.code, 160) || 'MESSAGE_LEARNING_ERROR',
    message: cleanText(error?.message, 500) || 'Unknown learning error',
  });
}

export function createMessageLearningApplication({
  repository,
  selectExamples = selectRelevantMessageLearningExamples,
}) {
  if (!repository) throw new Error('Message learning repository is required');

  async function examplesForDraft({
    shopId,
    scenario,
    conversation,
    sourceMessageId = null,
  }) {
    if (!enabled('MESSAGE_LEARNING_ENABLED', false)) return [];
    try {
      const candidates = await repository.listEligibleExamples({
        shopId,
        scenario,
        limit: 24,
      });
      return await selectExamples({
        scenario,
        conversation,
        sourceMessageId,
        candidates,
      });
    } catch (error) {
      learningError('example selection failed; continuing without memory', error, {
        shop_id: cleanText(shopId, 160),
        scenario: cleanText(scenario, 80),
      });
      return [];
    }
  }

  async function captureProposal({
    shopId,
    draft,
    generated,
    scenario,
    conversation,
    sourceMessageId = null,
    playbookRevision = 0,
    candidateId = null,
    eventId = null,
    ruleId = null,
    evidenceDigest = null,
    createdBy = null,
  }) {
    if (!enabled('MESSAGE_LEARNING_CAPTURE_ENABLED', false)) {
      return { captured: false, reason: 'capture_disabled' };
    }
    const draftId = cleanText(draft?.id, 160);
    const proposedBody = cleanText(generated?.reply_body || draft?.body, 10_000);
    if (!draftId || !proposedBody || generated?.status !== 'ready') {
      return { captured: false, reason: 'not_ai_ready_draft' };
    }
    const context = normalizedContext(conversation, sourceMessageId);
    try {
      return await repository.captureProposal({
        shopId,
        draftId,
        candidateId,
        eventId,
        ruleId,
        conversationId: cleanText(
          draft?.conversation_source_id
            || draft?.conversation_id
            || conversation?.source_id
            || conversation?.id,
          160,
        ) || null,
        sourceMessageId: cleanText(sourceMessageId, 160) || null,
        scenario,
        proposedBody,
        ...context,
        playbookRevision,
        generation: generated?.generation || null,
        evidenceDigest: cleanText(evidenceDigest, 160) || null,
        createdBy: cleanText(createdBy, 160) || null,
      });
    } catch (error) {
      learningError('proposal capture failed; draft remains usable', error, {
        shop_id: cleanText(shopId, 160),
        draft_id: draftId,
      });
      return { captured: false, reason: 'capture_failed' };
    }
  }

  async function recordDeliveryOutcome({
    shopId,
    draftId,
    outcome,
    finalBody = null,
    actor = null,
    deliveredAt = null,
    deliveryReference = null,
    proposedDraft = null,
  }) {
    if (!enabled('MESSAGE_LEARNING_CAPTURE_ENABLED', false)) {
      return { recorded: false, reason: 'capture_disabled' };
    }
    if (proposedDraft?.body) {
      try {
        await repository.captureProposal({
          shopId,
          draftId,
          conversationId: cleanText(
            proposedDraft?.conversation_source_id || proposedDraft?.conversation_id,
            160,
          ) || null,
          sourceMessageId: cleanText(
            proposedDraft?.metadata?.source_message_id,
            160,
          ) || null,
          scenario: cleanText(proposedDraft?.scenario, 80) || 'freeform',
          proposedBody: cleanText(proposedDraft.body, 10_000),
          buyerMessage: null,
          buyerContext: null,
          contextMessages: [],
          playbookRevision: Number(proposedDraft?.metadata?.playbook_revision) || 0,
          generation: proposedDraft?.metadata?.generation || null,
          evidenceDigest: cleanText(
            proposedDraft?.metadata?.evidence_digest,
            160,
          ) || null,
          createdBy: cleanText(proposedDraft?.created_by, 160) || null,
        });
      } catch (error) {
        learningError('proposal recovery failed; preserving outcome capture', error, {
          shop_id: cleanText(shopId, 160),
          draft_id: cleanText(draftId, 160),
        });
      }
    }
    try {
      return await repository.recordDeliveryOutcome({
        shopId,
        draftId,
        outcome,
        finalBody,
        actor,
        deliveredAt,
        deliveryReference,
      });
    } catch (error) {
      learningError('delivery outcome capture failed; delivery result is unchanged', error, {
        shop_id: cleanText(shopId, 160),
        draft_id: cleanText(draftId, 160),
        outcome: cleanText(outcome, 40),
      });
      return { recorded: false, reason: 'capture_failed' };
    }
  }

  async function recordTelegramFeedback(input) {
    if (!enabled('MESSAGE_LEARNING_CAPTURE_ENABLED', false)) return false;
    return repository.recordTelegramFeedback(input);
  }

  async function validateStore() {
    return repository.validate();
  }

  return {
    examplesForDraft,
    captureProposal,
    recordDeliveryOutcome,
    recordTelegramFeedback,
    validateStore,
  };
}
