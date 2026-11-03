export function createMessagesReadActionHandler({
  getActiveShopId,
  bridgeStatus,
  runtimeStatus,
  bridgeQuery,
  conversationBundle,
  bridgeBinaryRequest,
  numericId,
  positiveInt,
  bridgeRequest,
  loadMessagePlaybook,
  automationStatus,
}) {
  return async function handleGet(req, res, action) {
    const shopId = getActiveShopId(req);

    switch (action) {
      case 'status': {
        const status = await bridgeStatus();
        return res.json({ success: true, data: runtimeStatus(status) });
      }
      case 'listConversations': {
        const data = await bridgeQuery('/v1/conversations', {
          needs_attention: req.query.needs_attention,
          limit: positiveInt(req.query.limit, 50, 200),
          cursor: positiveInt(req.query.cursor, 0, 100_000),
          updated_after: req.query.updated_after,
        });
        return res.json({ success: true, data });
      }
      case 'getConversation': {
        const data = await conversationBundle(req.query.conversation_id);
        return res.json({ success: true, data });
      }
      case 'getAttachment': {
        const id = numericId(req.query.attachment_id, 'Attachment ID');
        const data = await bridgeBinaryRequest(`/v1/attachments/${id}/content`);
        const extension = {
          'application/pdf': 'pdf',
          'image/gif': 'gif',
          'image/jpeg': 'jpg',
          'image/jpg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
        }[data.mimeType] || 'bin';
        res.setHeader('Content-Type', data.mimeType);
        res.setHeader('Content-Length', String(data.body.length));
        res.setHeader('Content-Disposition', `inline; filename="etsy-attachment-${id}.${extension}"`);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.status(200).end(data.body);
      }
      case 'listDrafts': {
        const data = await bridgeQuery('/v1/outbox/drafts', {
          status: req.query.status,
          conversation_id: req.query.conversation_id,
          limit: positiveInt(req.query.limit, 50, 200),
          cursor: positiveInt(req.query.cursor, 0, 100_000),
        });
        return res.json({ success: true, data });
      }
      case 'getDraft': {
        const id = numericId(req.query.draft_id, 'Draft ID');
        const data = await bridgeRequest(`/v1/outbox/drafts/${id}`);
        return res.json({ success: true, data });
      }
      case 'getPlaybook': {
        const data = await loadMessagePlaybook(shopId);
        return res.json({ success: true, data });
      }
      case 'getAutomationStatus': {
        const data = await automationStatus(shopId);
        return res.json({ success: true, data });
      }
      default:
        return res.status(400).json({ error: `Unknown Messages action: ${action}` });
    }
  };
}
