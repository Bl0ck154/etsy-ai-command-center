import { cleanText, numericId } from './contracts.js';

export function normalizedMessageDirection(message) {
  const explicit = cleanText(
    message?.direction
    || message?.message_direction
    || message?.sender_direction
    || message?.flow,
    40,
  ).toLowerCase();
  if (['out', 'outbound', 'outgoing', 'sent', 'seller', 'shop', 'self'].includes(explicit)) {
    return 'outgoing';
  }
  if (['in', 'inbound', 'incoming', 'received', 'buyer', 'customer'].includes(explicit)) {
    return 'incoming';
  }
  if (['system', 'event'].includes(explicit)) return 'system';

  const outgoingFlag = [
    message?.is_outgoing,
    message?.outgoing,
    message?.from_self,
    message?.is_sender_self,
  ].find(value => typeof value === 'boolean');
  if (outgoingFlag !== undefined) return outgoingFlag ? 'outgoing' : 'incoming';

  const sender = cleanText(
    message?.sender_role || message?.sender_type || message?.sender,
    200,
  ).toLowerCase();
  if (['self', 'me', 'seller', 'shop', 'outgoing'].includes(sender)) return 'outgoing';
  if (['buyer', 'customer', 'incoming'].includes(sender)) return 'incoming';
  if (sender === 'system') return 'system';
  return 'unknown';
}

export function createMessagesConversationApplication({
  bridgeQuery,
  bridgeRequest,
  conversationReplyState,
}) {
  async function allBridgeConversationMessages(conversationId) {
    const items = [];
    const itemIndexes = new Map();
    const visitedCursors = new Set();
    let cursor = 0;
    while (!visitedCursors.has(cursor)) {
      visitedCursors.add(cursor);
      const page = await bridgeQuery(`/v1/conversations/${conversationId}/messages`, {
        limit: 500,
        cursor,
      });
      const pageItems = Array.isArray(page?.items) ? page.items : [];
      for (const message of pageItems) {
        const key = String(message?.source_id ?? message?.id ?? '');
        if (key && itemIndexes.has(key)) {
          const index = itemIndexes.get(key);
          items[index] = { ...items[index], ...message };
        } else {
          if (key) itemIndexes.set(key, items.length);
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
    return items;
  }

  async function conversationBundle(conversationId) {
    const id = numericId(conversationId, 'Conversation ID');
    const [conversation, messages] = await Promise.all([
      bridgeRequest(`/v1/conversations/${id}`),
      allBridgeConversationMessages(id),
    ]);
    return {
      ...conversation,
      source_id: String(conversation.source_id || id),
      messages: messages.map(message => ({
        ...message,
        direction: normalizedMessageDirection(message),
      })),
    };
  }

  async function refreshedConversationForDraft(conversationId) {
    const id = numericId(conversationId, 'Conversation ID');
    const sync = await bridgeRequest(
      `/v1/conversations/${id}/history/sync?wait=true&full=false`,
      {
        method: 'POST',
        timeoutMs: 180_000,
      },
    );
    const conversation = await conversationBundle(id);
    return {
      sync,
      conversation,
      replyState: conversationReplyState(conversation),
    };
  }

  return {
    allBridgeConversationMessages,
    conversationBundle,
    refreshedConversationForDraft,
  };
}
