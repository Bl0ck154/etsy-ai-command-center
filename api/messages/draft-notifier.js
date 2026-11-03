import { createMessageTelegramFeedbackToken } from './telegram-feedback-token.js';

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function configured() {
  return /^(1|true|yes|on)$/i.test(
    String(process.env.MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED || ''),
  );
}

function dashboardUrl(draftId) {
  const id = cleanText(draftId, 40);
  if (!/^\d+$/.test(id)) return '';
  const raw = cleanText(process.env.PUBLIC_BASE_URL, 2_000).replace(/\/+$/, '');
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  return `${parsed.toString().replace(/\/+$/, '')}/#messages?tab=queue&draft_id=${encodeURIComponent(id)}`;
}

function oneLine(value, maxLength) {
  return cleanText(value, maxLength).replace(/\s+/g, ' ');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function feedbackButtons(shopId, draftId) {
  const helpful = createMessageTelegramFeedbackToken({
    shopId,
    draftId,
    feedback: 'helpful',
  });
  const unhelpful = createMessageTelegramFeedbackToken({
    shopId,
    draftId,
    feedback: 'unhelpful',
  });
  if (!helpful || !unhelpful) return [];
  return [[
    { text: '👍 Влучно', callback_data: helpful },
    { text: '👎 Не влучно', callback_data: unhelpful },
  ]];
}

function recentConversationMessages(bundle, maxItems = 6) {
  const messages = Array.isArray(bundle?.messages)
    ? bundle.messages
    : Array.isArray(bundle?.conversation?.messages)
      ? bundle.conversation.messages
      : [];
  return messages
    .map((message, index) => ({
      direction: cleanText(message?.direction, 40).toLowerCase(),
      body: oneLine(message?.body, 500),
      sent_at: cleanText(message?.sent_at || message?.updated_at, 80),
      ordinal: Number(message?.ordinal) || 0,
      index,
    }))
    .filter(message => (
      ['incoming', 'inbound', 'outgoing', 'outbound'].includes(message.direction)
      && message.body
    ))
    .sort((left, right) => (
      (Date.parse(left.sent_at) || 0) - (Date.parse(right.sent_at) || 0)
      || left.ordinal - right.ordinal
      || left.index - right.index
    ))
    .slice(-Math.max(1, Math.min(maxItems, 8)));
}

function formatConversationBlock(messages, fallbackBuyerMessage) {
  const lines = messages.map(message => {
    const isShop = ['outgoing', 'outbound'].includes(message.direction);
    const label = isShop ? '🛍️ <b>Ми</b>' : '👤 <b>Клієнт</b>';
    return `${label}: ${escapeHtml(message.body)}`;
  });
  if (!lines.length && fallbackBuyerMessage) {
    lines.push(`👤 <b>Клієнт</b>: ${escapeHtml(fallbackBuyerMessage)}`);
  }
  return lines.length ? `<blockquote>${lines.join('\n')}</blockquote>` : '';
}

async function loadRecentConversation(candidate, options) {
  const cached = recentConversationMessages({
    messages: Array.isArray(candidate?.recent_conversation)
      ? candidate.recent_conversation
      : [],
  }, 6);
  if (cached.length) return cached;

  // Production notifications should be self-contained: the trigger runner has
  // already synced and loaded this conversation. An explicit loader is kept
  // only for isolated callers/tests and must never be required for delivery.
  if (typeof options.loadConversation !== 'function') return [];
  const conversationId = oneLine(candidate?.conversation_id, 80);
  if (!/^\d+$/.test(conversationId)) return [];
  try {
    const bundle = await options.loadConversation(conversationId);
    return recentConversationMessages(bundle, 6);
  } catch {
    return [];
  }
}

export async function notifyMessageDraftReady(candidate, options = {}) {
  if (!configured()) {
    return { delivered: false, skipped: true, reason: 'notifications_disabled' };
  }
  const token = cleanText(process.env.MESSAGE_TELEGRAM_BOT_TOKEN, 500);
  const suggestionsChatId = cleanText(
    process.env.MESSAGE_SUGGESTIONS_CHAT_ID,
    120,
  );
  const approvalsChatId = cleanText(
    process.env.MESSAGE_APPROVALS_CHAT_ID,
    120,
  );
  const chatId = suggestionsChatId || approvalsChatId;
  if (!token || !chatId) {
    const error = new Error('Message approval Telegram notification is not configured');
    error.code = 'MESSAGE_NOTIFICATION_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
  const link = dashboardUrl(candidate?.draft_id);
  if (!link) {
    const error = new Error('PUBLIC_BASE_URL is not configured for draft notifications');
    error.code = 'MESSAGE_NOTIFICATION_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }

  const participant = oneLine(candidate?.participant, 160) || 'Покупець Etsy';
  const receiptId = oneLine(candidate?.receipt_id, 80);
  const buyerMessage = oneLine(candidate?.source_message_preview, 500);
  const draftPreview = oneLine(candidate?.draft_preview, 1_200);
  const recentMessages = await loadRecentConversation(candidate, options);
  const conversationBlock = formatConversationBlock(recentMessages, buyerMessage);

  const text = [
    `💬 <b>Etsy · ${escapeHtml(participant)}</b>`,
    ...(receiptId ? [`🧾 Замовлення <b>#${escapeHtml(receiptId)}</b>`] : []),
    '',
    '<b>Останні повідомлення</b>',
    conversationBlock || '<blockquote>Історія переписки недоступна.</blockquote>',
    '',
    '✨ <b>Пропозиція відповіді</b>',
    `<blockquote>${escapeHtml(draftPreview || 'Чернетка порожня')}</blockquote>`,
    '',
    '🕒 <i>Нічого не відправлено. Це лише чернетка для перевірки.</i>',
  ].join('\n');

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  async function deliver(targetChatId, targetThreadId) {
    const payload = {
      chat_id: targetChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          ...feedbackButtons(candidate?.shop_id, candidate?.draft_id),
          [
            { text: 'Відкрити в Etsy AI Command Center', url: link },
          ],
        ],
      },
    };
    if (Number.isInteger(targetThreadId) && targetThreadId > 0) {
      payload.message_thread_id = targetThreadId;
    }

    let response;
    try {
      response = await fetchImpl(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch {
      const error = new Error('Telegram notification request failed');
      error.code = 'MESSAGE_NOTIFICATION_DELIVERY_FAILED';
      error.status = 503;
      error.telegram_response_received = false;
      throw error;
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true || !result?.result?.message_id) {
      const error = new Error(
        cleanText(result?.description, 300)
        || `Telegram notification failed with HTTP ${response.status}`,
      );
      error.code = 'MESSAGE_NOTIFICATION_DELIVERY_FAILED';
      error.status = 503;
      error.telegram_response_received = true;
      throw error;
    }
    if (String(result.result.chat?.id || '') !== String(targetChatId)) {
      const error = new Error('Telegram delivered the notification to an unexpected chat');
      error.code = 'MESSAGE_NOTIFICATION_DESTINATION_MISMATCH';
      error.status = 503;
      throw error;
    }
    return {
      delivered: true,
      skipped: false,
      chat_id: String(result.result.chat?.id || targetChatId),
      message_id: Number(result.result.message_id),
    };
  }

  const suggestionsThreadId = Number.parseInt(
    process.env.MESSAGE_SUGGESTIONS_THREAD_ID
      || process.env.MESSAGE_APPROVALS_THREAD_ID,
    10,
  );
  try {
    return await deliver(chatId, suggestionsThreadId);
  } catch (error) {
    const canUseLegacyFallback = Boolean(
      suggestionsChatId
      && approvalsChatId
      && suggestionsChatId !== approvalsChatId
      && error?.code === 'MESSAGE_NOTIFICATION_DELIVERY_FAILED'
      && error?.telegram_response_received === true,
    );
    if (!canUseLegacyFallback) throw error;

    const approvalsThreadId = Number.parseInt(
      process.env.MESSAGE_APPROVALS_THREAD_ID,
      10,
    );
    const fallback = await deliver(approvalsChatId, approvalsThreadId);
    return {
      ...fallback,
      fallback_used: true,
      preferred_chat_id: suggestionsChatId,
      preferred_error: cleanText(error?.message, 300) || 'Telegram rejected preferred chat',
    };
  }
}
