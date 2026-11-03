import { cleanText, numericId, requestId } from './contracts.js';

const REVIEWABLE_DRAFT_STATUSES = new Set([
  'DRAFT',
  'AWAITING_APPROVAL',
  'APPROVED',
]);
const AI_DRAFT_GENERATORS = new Set(['message_agent', 'message_trigger_runner']);

function isAiDraft(draft) {
  return AI_DRAFT_GENERATORS.has(
    cleanText(draft?.metadata?.generator, 120),
  );
}

export function observedManualReply(draft, conversation, shopId) {
  const draftShopId = cleanText(draft?.metadata?.dashboard_shop_id, 160);
  if (draftShopId && draftShopId !== cleanText(shopId, 160)) return null;
  const baselineId = cleanText(
    draft?.metadata?.conversation_head_message_id
      || draft?.metadata?.source_message_id,
    160,
  );
  if (!baselineId) return null;
  const proposalCreatedAt = Date.parse(draft?.created_at || draft?.submitted_at || '');
  if (!Number.isFinite(proposalCreatedAt)) return null;
  const authored = (Array.isArray(conversation?.messages)
    ? conversation.messages
    : [])
    .map((message, index) => ({
      message,
      index,
      source_id: cleanText(message?.source_id || message?.id, 160),
      direction: (() => {
        const value = cleanText(message?.direction, 40).toLowerCase();
        if (['incoming', 'inbound'].includes(value)) return 'incoming';
        if (['outgoing', 'outbound'].includes(value)) return 'outgoing';
        return value;
      })(),
      timestamp: Date.parse(message?.sent_at || message?.updated_at || ''),
      ordinal: Number(message?.ordinal) || 0,
    }))
    .filter(entry => (
      ['incoming', 'outgoing'].includes(entry.direction)
      && entry.source_id
    ))
    .sort((left, right) => (
      (Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp)
        ? left.timestamp - right.timestamp
        : left.ordinal - right.ordinal)
      || left.ordinal - right.ordinal
      || left.index - right.index
    ));
  const baselineIndex = authored.findIndex(entry => entry.source_id === baselineId);
  if (baselineIndex < 0) return null;
  if (
    !Number.isFinite(authored[baselineIndex].timestamp)
    || proposalCreatedAt < authored[baselineIndex].timestamp
  ) return null;
  const nextAuthored = authored[baselineIndex + 1];
  if (!nextAuthored || nextAuthored.direction !== 'outgoing') return null;
  const observed = nextAuthored.message;
  if (
    !Number.isFinite(nextAuthored.timestamp)
    || nextAuthored.timestamp < proposalCreatedAt
  ) return null;
  const body = cleanText(observed?.body, 10_000);
  if (!body) return null;
  return {
    body,
    source_message_id: nextAuthored.source_id,
    sent_at: observed?.sent_at || observed?.updated_at || null,
  };
}

export function createMessagesDraftDeliveryApplication({
  bridgeApprovalPost,
  bridgePost,
  bridgeRequest,
  reconcileMessageTriggerDraft,
  refreshedConversationForDraft,
  conversationReplyState,
  recordMessageLearningDeliveryOutcome = async () => null,
}) {
  const draftDeliveryChains = new Map();

  async function reconcileDraftAction({
    draftId,
    action,
    currentActor,
    reason,
    bridgeStatus: observedBridgeStatus,
  }) {
    try {
      const result = await reconcileMessageTriggerDraft({
        draft_id: draftId,
        action,
        actor: currentActor,
        reason,
        bridge_status: observedBridgeStatus,
      });
      return {
        status: result.matched > 0 ? 'RECONCILED' : 'NOT_LINKED',
        matched: result.matched,
      };
    } catch (error) {
      console.error('Message trigger draft reconciliation failed', {
        action,
        draft_id: draftId,
        code: cleanText(error?.code, 160) || 'MESSAGE_TRIGGER_RECONCILIATION_FAILED',
      });
      return {
        status: 'ERROR',
        matched: 0,
        error_code: cleanText(error?.code, 160)
          || 'MESSAGE_TRIGGER_RECONCILIATION_FAILED',
      };
    }
  }

  function draftFreshness(draft, conversation) {
    const head = conversationReplyState(conversation);
    const metadata = draft?.metadata && typeof draft.metadata === 'object'
      ? draft.metadata
      : {};
    const baselineSourceId = cleanText(
      metadata.conversation_head_message_id
        || metadata.source_message_id,
      160,
    ) || null;
    const currentSourceId = cleanText(head.source_message_id, 160) || null;

    if (head.status === 'blocked' || head.status === 'no_action') {
      return {
        current: false,
        stale: head.status === 'no_action',
        code: head.code,
        reason: head.reason,
        baseline_source_message_id: baselineSourceId,
        current_source_message_id: currentSourceId,
        conversation_check: head,
      };
    }
    if (baselineSourceId && baselineSourceId !== currentSourceId) {
      return {
        current: false,
        stale: true,
        code: 'MESSAGE_DRAFT_CONVERSATION_CHANGED',
        reason: 'The Etsy conversation changed after this draft was prepared',
        baseline_source_message_id: baselineSourceId,
        current_source_message_id: currentSourceId,
        conversation_check: head,
      };
    }
    if (!baselineSourceId) {
      const draftCreatedAt = Date.parse(
        draft?.created_at || draft?.submitted_at || '',
      );
      const latestSentAt = Date.parse(head.latest_sent_at || '');
      if (
        Number.isFinite(draftCreatedAt)
        && Number.isFinite(latestSentAt)
        && latestSentAt > draftCreatedAt
      ) {
        return {
          current: false,
          stale: true,
          code: 'MESSAGE_DRAFT_CONVERSATION_CHANGED',
          reason: 'A newer Etsy message appeared after this draft was prepared',
          baseline_source_message_id: null,
          current_source_message_id: currentSourceId,
          conversation_check: head,
        };
      }
    }
    return {
      current: true,
      stale: false,
      code: 'MESSAGE_DRAFT_CURRENT',
      reason: 'The draft still matches the newest saved Etsy conversation state',
      baseline_source_message_id: baselineSourceId,
      current_source_message_id: currentSourceId,
      conversation_check: head,
    };
  }

  function withDraftDeliveryLock(draftId, operation) {
    const key = String(draftId);
    const previous = draftDeliveryChains.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    draftDeliveryChains.set(key, current);
    return current.finally(() => {
      if (draftDeliveryChains.get(key) === current) {
        draftDeliveryChains.delete(key);
      }
    });
  }

  async function refreshDraftForReview({
    shopId,
    draftId,
    currentActor,
    skipStale = true,
  }) {
    const id = numericId(draftId, 'Draft ID');
    let draft = await bridgeRequest(`/v1/outbox/drafts/${id}`);
    const conversationId = numericId(
      draft?.conversation_source_id || draft?.conversation_id,
      'Conversation ID',
    );
    const refreshed = await refreshedConversationForDraft(conversationId);
    const freshness = draftFreshness(draft, refreshed.conversation);
    let triggerReconciliation = null;
    let learningObservation = null;

    const manualReply = REVIEWABLE_DRAFT_STATUSES.has(
      cleanText(draft?.status, 60).toUpperCase(),
    ) && isAiDraft(draft)
      ? observedManualReply(draft, refreshed.conversation, shopId)
      : null;
    if (manualReply) {
      learningObservation = await recordMessageLearningDeliveryOutcome({
        shopId,
        draftId: id,
        outcome: 'SENT',
        finalBody: manualReply.body,
        actor: 'etsy-manual-reply-observed',
        deliveredAt: manualReply.sent_at,
        deliveryReference: `bridge-observed:${manualReply.source_message_id}`,
        proposedDraft: draft,
      });
    }

    if (
      skipStale
      && freshness.stale
      && REVIEWABLE_DRAFT_STATUSES.has(
        cleanText(draft?.status, 60).toUpperCase(),
      )
    ) {
      draft = await bridgeApprovalPost(`/v1/outbox/drafts/${id}/skip`, {
        actor: currentActor.id,
        reason: freshness.reason,
      });
      triggerReconciliation = await reconcileDraftAction({
        draftId: id,
        action: 'skipDraft',
        currentActor,
        reason: freshness.reason,
        bridgeStatus: draft?.status,
      });
    }

    return {
      draft,
      conversation: refreshed.conversation,
      sync: refreshed.sync,
      freshness,
      trigger_reconciliation: triggerReconciliation,
      learning_observation: learningObservation,
    };
  }

  function deliveryStateError(draft) {
    const status = cleanText(draft?.status, 60).toUpperCase();
    const messages = {
      BLOCKED: 'This draft is blocked and cannot be sent',
      SKIPPED: 'This draft was skipped and cannot be sent',
      SENDING: 'A delivery attempt is already in progress. Do not retry it.',
      UNKNOWN: 'Delivery result is unknown. Check Etsy before taking any further action.',
    };
    const error = new Error(messages[status] || `Draft status ${status || 'UNKNOWN'} cannot be sent`);
    error.status = 409;
    error.code = status === 'UNKNOWN' || status === 'SENDING'
      ? 'MESSAGE_DELIVERY_ALREADY_ATTEMPTED'
      : 'MESSAGE_DRAFT_NOT_REVIEWABLE';
    error.data = { draft };
    return error;
  }

  async function approveAndSendDraft({
    shopId,
    draftId,
    approvedBody,
    currentActor,
    clientRequestId,
  }) {
    const id = numericId(draftId, 'Draft ID');
    const exactBody = cleanText(approvedBody, 10_000);
    if (!exactBody) {
      const error = new Error('Approved message text is required');
      error.status = 400;
      error.code = 'MESSAGE_DRAFT_BODY_REQUIRED';
      throw error;
    }
    const operationId = `approve-send-${id}-${requestId(clientRequestId)}`.slice(0, 128);

    return withDraftDeliveryLock(id, async () => {
      let refreshed = await refreshDraftForReview({
        shopId,
        draftId: id,
        currentActor,
      });
      if (!refreshed.freshness.current) {
        const error = new Error(refreshed.freshness.reason);
        error.status = 409;
        error.code = refreshed.freshness.code;
        error.data = refreshed;
        throw error;
      }

      let draft = refreshed.draft;
      let status = cleanText(draft?.status, 60).toUpperCase();
      if (status === 'SENT') {
        const learning = isAiDraft(draft)
          ? await recordMessageLearningDeliveryOutcome({
          shopId,
          draftId: id,
          outcome: 'SENT',
          finalBody: cleanText(draft?.body, 10_000),
          actor: currentActor.id,
          deliveredAt: draft?.sent_at || draft?.updated_at || null,
          })
          : null;
        return {
          draft,
          outcome: 'SENT',
          sent: true,
          idempotent_replay: true,
          delivery_attempted: false,
          retry_allowed: false,
          operation_id: operationId,
          freshness: refreshed.freshness,
          learning,
        };
      }
      if (['UNKNOWN', 'SENDING'].includes(status)) throw deliveryStateError(draft);
      if (!REVIEWABLE_DRAFT_STATUSES.has(status)) throw deliveryStateError(draft);
      const learningEligible = isAiDraft(draft);
      const proposalDraft = status !== 'APPROVED' && learningEligible
        ? draft
        : null;
      if (
        status === 'APPROVED'
        && cleanText(draft?.body, 10_000)
        && cleanText(draft.body, 10_000) !== exactBody
      ) {
        const error = new Error(
          'This draft is already approved with different exact text. Create a new draft instead.',
        );
        error.status = 409;
        error.code = 'MESSAGE_APPROVED_TEXT_MISMATCH';
        throw error;
      }

      const reconciliations = [];
      if (status !== 'APPROVED') {
        draft = await bridgeApprovalPost(`/v1/outbox/drafts/${id}/approve`, {
          approved_by: currentActor.id,
          body: exactBody,
        });
        status = cleanText(draft?.status, 60).toUpperCase();
        if (status !== 'APPROVED') {
          const error = new Error('Bridge did not confirm exact-text approval');
          error.status = 502;
          error.code = 'MESSAGE_APPROVAL_NOT_CONFIRMED';
          throw error;
        }
        reconciliations.push(await reconcileDraftAction({
          draftId: id,
          action: 'approveDraft',
          currentActor,
          bridgeStatus: status,
        }));
      }

      refreshed = await refreshDraftForReview({
        shopId,
        draftId: id,
        currentActor,
      });
      if (!refreshed.freshness.current) {
        const error = new Error(refreshed.freshness.reason);
        error.status = 409;
        error.code = refreshed.freshness.code;
        error.data = refreshed;
        throw error;
      }
      draft = refreshed.draft;
      status = cleanText(draft?.status, 60).toUpperCase();
      if (status === 'SENT') {
        const learning = learningEligible
          ? await recordMessageLearningDeliveryOutcome({
          shopId,
          draftId: id,
          outcome: 'SENT',
          finalBody: exactBody,
          actor: currentActor.id,
          deliveredAt: draft?.sent_at || draft?.updated_at || null,
          proposedDraft: proposalDraft,
          })
          : null;
        return {
          draft,
          outcome: 'SENT',
          sent: true,
          idempotent_replay: true,
          delivery_attempted: false,
          retry_allowed: false,
          operation_id: operationId,
          freshness: refreshed.freshness,
          trigger_reconciliations: reconciliations,
          learning,
        };
      }
      if (status !== 'APPROVED') throw deliveryStateError(draft);

      try {
        draft = await bridgeRequest(`/v1/outbox/drafts/${id}/send`, {
          method: 'POST',
          approvalCredential: true,
          timeoutMs: 170_000,
          headers: { 'Idempotency-Key': operationId },
        });
      } catch (error) {
        let observed = null;
        try {
          observed = await bridgeRequest(`/v1/outbox/drafts/${id}`);
        } catch {
          // Preserve the original Bridge failure when durable state cannot be inspected.
        }
        const observedStatus = cleanText(observed?.status, 60).toUpperCase();
        if (['UNKNOWN', 'SENDING'].includes(observedStatus)) {
          const learning = learningEligible
            ? await recordMessageLearningDeliveryOutcome({
            shopId,
            draftId: id,
            outcome: 'UNKNOWN',
            finalBody: exactBody,
            actor: currentActor.id,
            deliveredAt: observed?.updated_at || null,
            proposedDraft: proposalDraft,
            })
            : null;
          return {
            draft: observed,
            outcome: 'UNKNOWN',
            sent: false,
            idempotent_replay: false,
            delivery_attempted: true,
            retry_allowed: false,
            operation_id: operationId,
            freshness: refreshed.freshness,
            trigger_reconciliations: reconciliations,
            learning,
          };
        }
        throw error;
      }
      status = cleanText(draft?.status, 60).toUpperCase();
      if (status !== 'SENT') {
        const error = new Error('Bridge did not confirm message delivery');
        error.status = 502;
        error.code = 'MESSAGE_DELIVERY_NOT_CONFIRMED';
        throw error;
      }
      reconciliations.push(await reconcileDraftAction({
        draftId: id,
        action: 'sendApprovedDraft',
        currentActor,
        bridgeStatus: status,
      }));
      const learning = learningEligible
        ? await recordMessageLearningDeliveryOutcome({
        shopId,
        draftId: id,
        outcome: 'SENT',
        finalBody: exactBody,
        actor: currentActor.id,
        deliveredAt: draft?.sent_at || draft?.updated_at || null,
        proposedDraft: proposalDraft,
        })
        : null;
      return {
        draft,
        outcome: 'SENT',
        sent: true,
        idempotent_replay: false,
        delivery_attempted: true,
        retry_allowed: false,
        operation_id: operationId,
        freshness: refreshed.freshness,
        trigger_reconciliations: reconciliations,
        learning,
      };
    });
  }

  async function createOutboxDraft({
    conversationId,
    body,
    scenario,
    reason,
    metadata,
    createdBy,
    clientRequestId,
  }) {
    return bridgePost(
      '/v1/outbox/drafts',
      {
        conversation_id: numericId(conversationId, 'Conversation ID'),
        body: cleanText(body, 10_000),
        scenario,
        reason: cleanText(reason, 1_500),
        metadata,
        created_by: createdBy,
        submit_for_approval: true,
      },
      {
        'Idempotency-Key': `dashboard-draft-${requestId(clientRequestId)}`.slice(0, 128),
      },
    );
  }

  return {
    reconcileDraftAction,
    draftFreshness,
    refreshDraftForReview,
    approveAndSendDraft,
    createOutboxDraft,
  };
}
