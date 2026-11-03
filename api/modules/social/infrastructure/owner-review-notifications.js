function ownerNotificationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createSocialOwnerReviewNotificationGateway({
  fetchImpl = (...args) => fetch(...args),
  getBotToken = () => process.env.TELEGRAM_BOT_TOKEN,
  notificationsDisabled = () => process.env.SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS === 'true',
  timeoutMs = 45_000,
} = {}) {
  const callTelegram = async (method, payload) => {
    const token = String(getBotToken?.() || '').trim();
    if (!token) {
      throw ownerNotificationError(
        'OWNER_NOTIFICATION_NOT_CONFIGURED',
        'TELEGRAM_BOT_TOKEN is not configured in Etsy AI Command Center runtime.',
      );
    }
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) {
      throw ownerNotificationError(
        'OWNER_NOTIFICATION_DELIVERY_FAILED',
        String(result?.description || `Telegram ${method} failed with HTTP ${response.status}`),
      );
    }
    return result.result;
  };

  const deliver = async ({ ownerId, text, mediaUrls = [] } = {}) => {
    if (notificationsDisabled?.()) {
      throw ownerNotificationError(
        'OWNER_NOTIFICATION_DISABLED',
        'Owner notifications are disabled; autonomous scheduling remains blocked.',
      );
    }

    const textResult = await callTelegram('sendMessage', {
      chat_id: ownerId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });
    const textMessageId = Number(textResult?.message_id);
    const textChatId = String(textResult?.chat?.id || '');
    if (!Number.isInteger(textMessageId) || textMessageId <= 0 || textChatId !== String(ownerId)) {
      throw ownerNotificationError(
        'OWNER_NOTIFICATION_DELIVERY_FAILED',
        'Telegram sendMessage returned no verifiable owner chat/message provenance.',
      );
    }

    const deliveredUrls = (Array.isArray(mediaUrls) ? mediaUrls : []).slice(0, 10);
    let mediaMessageIds = [];
    let mediaChatIds = [];
    if (deliveredUrls.length === 1) {
      const result = await callTelegram('sendPhoto', { chat_id: ownerId, photo: deliveredUrls[0] });
      mediaMessageIds = [Number(result?.message_id)].filter(Number.isInteger);
      mediaChatIds = [String(result?.chat?.id || '')];
    } else if (deliveredUrls.length > 1) {
      const result = await callTelegram('sendMediaGroup', {
        chat_id: ownerId,
        media: deliveredUrls.map(url => ({ type: 'photo', media: url })),
      });
      mediaMessageIds = (Array.isArray(result) ? result : []).map(item => Number(item?.message_id)).filter(Number.isInteger);
      mediaChatIds = (Array.isArray(result) ? result : []).map(item => String(item?.chat?.id || ''));
    }

    if (mediaMessageIds.length !== deliveredUrls.length
      || mediaMessageIds.some(id => id <= 0)
      || mediaChatIds.length !== deliveredUrls.length
      || mediaChatIds.some(id => id !== String(ownerId))) {
      throw ownerNotificationError(
        'OWNER_NOTIFICATION_DELIVERY_FAILED',
        'Telegram media delivery returned incomplete message provenance.',
      );
    }

    return {
      textMessageId,
      textChatId,
      mediaMessageIds,
      deliveredMediaCount: deliveredUrls.length,
    };
  };

  return { deliver, isDisabled: () => notificationsDisabled?.() === true };
}

export const socialOwnerReviewNotificationGateway = createSocialOwnerReviewNotificationGateway();
