export function createMessagesWriteActionHandler({
  getActiveShopId,
  actor,
  requireApprover,
  saveMessagePlaybook,
  saveMessageAutomationPolicy,
  bridgeRequest,
  bridgeQuery,
  positiveInt,
  numericId,
  bridgePost,
  conversationBundle,
  refreshedConversationForDraft,
  refreshDraftForReview,
  previewDraft,
  prepareGeneratedDraft,
  createManualDraft,
  approveAndSendDraft,
  approveDraft,
  sendApprovedDraft,
  skipDraft,
  blockDraft,
}) {
  return async function handlePost(req, res, action) {
    const shopId = getActiveShopId(req);
    const currentActor = actor(req);

    switch (action) {
      case 'savePlaybook': {
        requireApprover(req);
        const data = await saveMessagePlaybook(shopId, req.body.playbook, {
          expectedRevision: req.body.expected_revision,
          updatedBy: currentActor.id,
        });
        return res.json({ success: true, data });
      }
      case 'saveAutomationPolicy': {
        requireApprover(req);
        const data = await saveMessageAutomationPolicy(
          shopId,
          req.body.policy,
          {
            expectedRevision: req.body.expected_revision,
            updatedBy: currentActor.id,
          },
        );
        return res.json({ success: true, data });
      }
      case 'syncInbox': {
        const sync = await bridgeRequest('/v1/inbox/index/sync?wait=true', {
          method: 'POST',
          timeoutMs: 180_000,
        });
        const conversations = await bridgeQuery('/v1/conversations', {
          needs_attention: req.body.needs_attention,
          limit: positiveInt(req.body.limit, 50, 200),
          cursor: 0,
        });
        return res.json({ success: true, data: { sync, conversations } });
      }
      case 'markConversationViewed': {
        const id = numericId(req.body.conversation_id, 'Conversation ID');
        const data = await bridgePost(`/v1/conversations/${id}/viewed`);
        return res.json({ success: true, data });
      }
      case 'syncConversationHistory': {
        const id = numericId(req.body.conversation_id, 'Conversation ID');
        const sync = await bridgeRequest(
          `/v1/conversations/${id}/history/sync?wait=true`,
          { method: 'POST', timeoutMs: 180_000 },
        );
        const conversation = await conversationBundle(id);
        return res.json({ success: true, data: { sync, conversation } });
      }
      case 'refreshConversationRecent': {
        const refreshed = await refreshedConversationForDraft(req.body.conversation_id);
        return res.json({
          success: true,
          data: {
            sync: refreshed.sync,
            conversation: refreshed.conversation,
            conversation_check: refreshed.replyState,
          },
        });
      }
      case 'refreshDraftForReview': {
        requireApprover(req);
        const data = await refreshDraftForReview({
          shopId,
          draftId: req.body.draft_id,
          currentActor,
        });
        return res.json({ success: true, data });
      }
      case 'previewDraft': {
        const data = await previewDraft({ shopId, input: req.body });
        return res.json({ success: true, data });
      }
      case 'generateDraft': {
        const result = await prepareGeneratedDraft({
          shopId,
          input: req.body,
          currentActor,
        });
        if (!result.ready) {
          return res.status(409).json({
            error: result.error,
            code: result.code,
            data: result.generated,
          });
        }
        return res.status(201).json({
          success: true,
          data: {
            draft: result.draft,
            generated: result.generated,
            sync: result.sync,
            conversation_check: result.conversation_check,
          },
        });
      }
      case 'createManualDraft': {
        const result = await createManualDraft({
          shopId,
          input: req.body,
          currentActor,
        });
        if (!result.valid) return res.status(400).json({ error: result.error });
        return res.status(201).json({ success: true, data: result.draft });
      }
      case 'approveAndSendDraft': {
        requireApprover(req);
        const data = await approveAndSendDraft({
          shopId,
          draftId: req.body.draft_id,
          approvedBody: req.body.body,
          currentActor,
          clientRequestId: req.body.client_request_id,
        });
        return res.json({ success: true, data });
      }
      case 'approveDraft': {
        requireApprover(req);
        const result = await approveDraft({
          shopId,
          draftId: req.body.draft_id,
          approvedBody: req.body.body,
          currentActor,
        });
        if (!result.valid) return res.status(400).json({ error: result.error });
        if (!result.current) {
          return res.status(409).json({
            error: result.freshness.reason,
            code: result.freshness.code,
            data: result.refreshed,
          });
        }
        return res.json({
          success: true,
          data: result.draft,
          trigger_reconciliation: result.trigger_reconciliation,
        });
      }
      case 'sendApprovedDraft': {
        requireApprover(req);
        const result = await sendApprovedDraft({
          shopId,
          draftId: req.body.draft_id,
          currentActor,
        });
        if (!result.current) {
          return res.status(409).json({
            error: result.freshness.reason,
            code: result.freshness.code,
            data: result.refreshed,
          });
        }
        return res.json({
          success: true,
          data: result.draft,
          trigger_reconciliation: result.trigger_reconciliation,
        });
      }
      case 'skipDraft': {
        requireApprover(req);
        const result = await skipDraft({
          draftId: req.body.draft_id,
          currentActor,
          reason: req.body.reason,
        });
        return res.json({
          success: true,
          data: result.draft,
          trigger_reconciliation: result.trigger_reconciliation,
        });
      }
      case 'blockDraft': {
        requireApprover(req);
        const result = await blockDraft({
          draftId: req.body.draft_id,
          currentActor,
          reason: req.body.reason,
        });
        return res.json({
          success: true,
          data: result.draft,
          trigger_reconciliation: result.trigger_reconciliation,
        });
      }
      default:
        return res.status(400).json({ error: `Unknown Messages action: ${action}` });
    }
  };
}
