function cleanText(value, maxLength = 200) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizedDirection(message) {
  const value = cleanText(message?.direction, 40).toLowerCase();
  if (['incoming', 'inbound', 'received', 'buyer', 'customer'].includes(value)) {
    return 'incoming';
  }
  if (['outgoing', 'outbound', 'sent', 'seller', 'shop', 'self'].includes(value)) {
    return 'outgoing';
  }
  if (['system', 'event'].includes(value) || message?.message_kind === 'system') {
    return 'system';
  }
  return 'unknown';
}

function chronology(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => {
      const timestamp = Date.parse(message?.sent_at || message?.updated_at || '');
      return {
        message,
        index,
        direction: normalizedDirection(message),
        timestamp: Number.isFinite(timestamp) ? timestamp : null,
        ordinal: Number(message?.ordinal) || 0,
      };
    })
    .filter(entry => entry.direction !== 'system')
    .sort((left, right) => {
      if (left.timestamp !== null && right.timestamp !== null) {
        return left.timestamp - right.timestamp
          || left.ordinal - right.ordinal
          || left.index - right.index;
      }
      if (left.timestamp !== null) return -1;
      if (right.timestamp !== null) return 1;
      return left.ordinal - right.ordinal || left.index - right.index;
    });
}

function result(status, code, reason, entry = null) {
  return {
    status,
    eligible: status === 'eligible',
    no_action: status === 'no_action',
    code,
    reason,
    source_message_id: entry
      ? cleanText(entry.message?.source_id || entry.message?.id, 160) || null
      : null,
    latest_direction: entry?.direction || null,
    latest_sent_at: entry?.message?.sent_at || entry?.message?.updated_at || null,
  };
}

export function conversationReplyState(conversation) {
  const messages = chronology(conversation?.messages);
  const latest = messages.at(-1);
  if (!latest) {
    return result(
      'blocked',
      'MESSAGE_DRAFT_CONVERSATION_EMPTY',
      'No authored Etsy messages are available after the conversation refresh',
    );
  }

  const sender = cleanText(
    latest.message?.sender_role
    || latest.message?.sender_type
    || latest.message?.sender,
    200,
  ).toLowerCase();
  if (
    latest.direction === 'unknown'
    || (latest.direction === 'incoming'
      && ['self', 'me', 'seller', 'shop', 'you'].includes(sender))
  ) {
    return result(
      'blocked',
      'MESSAGE_DRAFT_LATEST_DIRECTION_UNVERIFIED',
      'The newest Etsy message does not have a trustworthy buyer/shop direction',
      latest,
    );
  }
  if (latest.direction === 'outgoing') {
    return result(
      'no_action',
      'MESSAGE_DRAFT_ALREADY_ANSWERED',
      'The newest authored message is already a shop reply',
      latest,
    );
  }
  if (!cleanText(latest.message?.source_id || latest.message?.id, 160)) {
    return result(
      'blocked',
      'MESSAGE_DRAFT_SOURCE_MESSAGE_UNVERIFIED',
      'The newest buyer message has no stable Etsy message ID',
      latest,
    );
  }
  return result(
    'eligible',
    'MESSAGE_DRAFT_REPLY_ELIGIBLE',
    'The newest authored message is an explicit buyer message',
    latest,
  );
}
