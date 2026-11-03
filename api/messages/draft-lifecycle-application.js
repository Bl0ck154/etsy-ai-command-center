import { cleanText, numericId } from './contracts.js';

const AI_DRAFT_GENERATORS = new Set(['message_agent', 'message_trigger_runner']);
const PROPOSAL_VISIBLE_STATUSES = new Set(['DRAFT', 'AWAITING_APPROVAL']);

function isAiDraft(draft) {
  return AI_DRAFT_GENERATORS.has(
    cleanText(draft?.metadata?.generator, 120),
  );
}

export function createMessagesDraftLifecycleApplication({
  bridgeApprovalPost,
  bridgeRequest,
  refreshDraftForReview,
  reconcileDraftAction,
  captureMessageLearningProposal = async () => null,
  recordMessageLearningDeliveryOutcome = async () => null,
}) {
  async function approveDraft({ shopId, draftId, approvedBody, currentActor }) {
    const id = numericId(draftId, 'Draft ID');
    const exactBody = approvedBody === undefined
      ? undefined
      : cleanText(approvedBody, 10_000);
    if (exactBody !== undefined && !exactBody) {
      return { valid: false, error: 'Approved message text is required' };
    }
    const refreshed = await refreshDraftForReview({
      shopId,
      draftId: id,
      currentActor,
    });
    if (!refreshed.freshness.current) {
      return {
        valid: true,
        current: false,
        freshness: refreshed.freshness,
        refreshed,
      };
    }
    const proposal = refreshed.draft;
    const learningProposal = isAiDraft(proposal)
      && PROPOSAL_VISIBLE_STATUSES.has(
        cleanText(proposal?.status, 60).toUpperCase(),
      )
      ? await captureMessageLearningProposal({
        shopId,
        draft: proposal,
        generated: {
          status: 'ready',
          reply_body: proposal?.body,
          generation: proposal?.metadata?.generation || null,
        },
        scenario: proposal?.scenario || 'freeform',
        conversation: refreshed.conversation,
        sourceMessageId: proposal?.metadata?.source_message_id || null,
        playbookRevision: proposal?.metadata?.playbook_revision || 0,
        createdBy: proposal?.created_by || null,
      })
      : null;
    const draft = await bridgeApprovalPost(`/v1/outbox/drafts/${id}/approve`, {
      approved_by: currentActor.id,
      ...(exactBody !== undefined ? { body: exactBody } : {}),
    });
    const triggerReconciliation = await reconcileDraftAction({
      draftId: id,
      action: 'approveDraft',
      currentActor,
      bridgeStatus: draft?.status,
    });
    return {
      valid: true,
      current: true,
      draft,
      trigger_reconciliation: triggerReconciliation,
      learning: { proposal: learningProposal },
    };
  }

  async function sendApprovedDraft({ shopId, draftId, currentActor }) {
    const id = numericId(draftId, 'Draft ID');
    const refreshed = await refreshDraftForReview({
      shopId,
      draftId: id,
      currentActor,
    });
    if (!refreshed.freshness.current) {
      return {
        current: false,
        freshness: refreshed.freshness,
        refreshed,
      };
    }
    const draft = await bridgeRequest(`/v1/outbox/drafts/${id}/send`, {
      method: 'POST',
      approvalCredential: true,
    });
    const triggerReconciliation = await reconcileDraftAction({
      draftId: id,
      action: 'sendApprovedDraft',
      currentActor,
      bridgeStatus: draft?.status,
    });
    const deliveryStatus = cleanText(draft?.status, 60).toUpperCase();
    const learning = isAiDraft(refreshed.draft)
      && ['SENT', 'UNKNOWN', 'SENDING'].includes(deliveryStatus)
      ? await recordMessageLearningDeliveryOutcome({
        shopId,
        draftId: id,
        outcome: deliveryStatus === 'SENT' ? 'SENT' : 'UNKNOWN',
        finalBody: cleanText(refreshed.draft?.body, 10_000),
        actor: currentActor.id,
        deliveredAt: draft?.sent_at || draft?.updated_at || null,
      })
      : null;
    return {
      current: true,
      draft,
      trigger_reconciliation: triggerReconciliation,
      learning,
    };
  }

  async function skipDraft({ draftId, currentActor, reason }) {
    const id = numericId(draftId, 'Draft ID');
    const draft = await bridgeApprovalPost(`/v1/outbox/drafts/${id}/skip`, {
      actor: currentActor.id,
      reason: cleanText(reason, 1_000),
    });
    const triggerReconciliation = await reconcileDraftAction({
      draftId: id,
      action: 'skipDraft',
      currentActor,
      reason,
      bridgeStatus: draft?.status,
    });
    return { draft, trigger_reconciliation: triggerReconciliation };
  }

  async function blockDraft({ draftId, currentActor, reason }) {
    const id = numericId(draftId, 'Draft ID');
    const draft = await bridgeApprovalPost(`/v1/outbox/drafts/${id}/block`, {
      actor: currentActor.id,
      reason: cleanText(reason, 1_000),
    });
    const triggerReconciliation = await reconcileDraftAction({
      draftId: id,
      action: 'blockDraft',
      currentActor,
      reason,
      bridgeStatus: draft?.status,
    });
    return { draft, trigger_reconciliation: triggerReconciliation };
  }

  return { approveDraft, sendApprovedDraft, skipDraft, blockDraft };
}
