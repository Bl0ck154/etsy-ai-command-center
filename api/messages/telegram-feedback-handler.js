import crypto from 'node:crypto';

import {
  messageTelegramFeedbackEnabled,
  verifyMessageTelegramFeedbackToken,
} from './telegram-feedback-token.js';

const MIN_SECRET_BYTES = 32;

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function safeEqual(left, right) {
  const actual = Buffer.from(String(left || ''), 'utf8');
  const expected = Buffer.from(String(right || ''), 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function exactConfiguredId(value) {
  const normalized = cleanText(value, 120);
  return /^-?\d+$/.test(normalized) ? normalized : '';
}

function callbackConfig() {
  return {
    webhookSecret: cleanText(process.env.MESSAGE_TELEGRAM_FEEDBACK_WEBHOOK_SECRET, 1_000),
    ownerUserId: exactConfiguredId(process.env.MESSAGE_TELEGRAM_FEEDBACK_OWNER_USER_ID),
    chatId: exactConfiguredId(process.env.MESSAGE_TELEGRAM_FEEDBACK_CHAT_ID),
    botToken: cleanText(process.env.MESSAGE_TELEGRAM_BOT_TOKEN, 500),
  };
}

function configured(config) {
  return messageTelegramFeedbackEnabled()
    && Buffer.byteLength(config.webhookSecret, 'utf8') >= MIN_SECRET_BYTES
    && Boolean(config.ownerUserId && config.chatId && config.botToken);
}

function webhookSecretHeader(req) {
  return cleanText(
    req?.headers?.['x-telegram-bot-api-secret-token']
      || req?.headers?.['X-Telegram-Bot-Api-Secret-Token'],
    1_000,
  );
}

async function answerCallbackQuery(
  callbackQueryId,
  feedback,
  config,
  fetchImpl,
  customText = '',
) {
  const text = customText || (feedback === 'helpful'
    ? 'Дякую — збережено як корисну пропозицію 👍'
    : 'Дякую — збережено як невдалу пропозицію 👎');
  try {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${config.botToken}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text,
          show_alert: false,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const result = await response.json().catch(() => null);
    return response.ok && result?.ok === true;
  } catch {
    return false;
  }
}

function sendError(res, status, error, code) {
  return res.status(status).json({ error, code });
}

export function createMessageTelegramFeedbackHandler(options = {}) {
  if (typeof options.recordFeedback !== 'function') {
    throw new TypeError('recordFeedback callback is required');
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  return async function messageTelegramFeedbackHandler(req, res) {
    const config = callbackConfig();
    if (!configured(config)) {
      return sendError(res, 404, 'Not found', 'MESSAGE_TELEGRAM_FEEDBACK_DISABLED');
    }
    if (req.method !== 'POST') {
      return sendError(res, 405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
    }
    if (!safeEqual(webhookSecretHeader(req), config.webhookSecret)) {
      return sendError(res, 401, 'Telegram webhook authentication required', 'MESSAGE_TELEGRAM_FEEDBACK_AUTH_REQUIRED');
    }

    const callback = req.body?.callback_query;
    const callbackQueryId = cleanText(callback?.id, 160);
    const actorUserId = exactConfiguredId(callback?.from?.id);
    const chatId = exactConfiguredId(callback?.message?.chat?.id);
    if (
      !callbackQueryId
      || actorUserId !== config.ownerUserId
      || chatId !== config.chatId
    ) {
      return sendError(res, 403, 'Telegram feedback actor is not allowed', 'MESSAGE_TELEGRAM_FEEDBACK_FORBIDDEN');
    }

    const verified = verifyMessageTelegramFeedbackToken(callback?.data);
    if (!verified) {
      return sendError(res, 400, 'Invalid Telegram feedback token', 'MESSAGE_TELEGRAM_FEEDBACK_TOKEN_INVALID');
    }

    let recorded;
    try {
      recorded = await options.recordFeedback({
        shop_id: verified.shop_id,
        draft_id: verified.draft_id,
        rating: verified.feedback,
        event_id: `tgcb_${crypto.createHash('sha256').update(callbackQueryId).digest('hex').slice(0, 32)}`,
        actor_id: actorUserId,
        telegram_message_id: Number(callback?.message?.message_id) || null,
        recorded_at: new Date().toISOString(),
      });
    } catch (error) {
      if (error?.code !== 'MESSAGE_LEARNING_NOT_FOUND') throw error;
      const acknowledged = await answerCallbackQuery(
        callbackQueryId,
        verified.feedback,
        config,
        fetchImpl,
        'Ця стара пропозиція вже недоступна для оцінювання.',
      );
      return res.status(200).json({
        success: true,
        data: {
          shop_id: verified.shop_id,
          draft_id: verified.draft_id,
          feedback: verified.feedback,
          recorded: false,
          expired: true,
          telegram_acknowledged: acknowledged,
        },
      });
    }
    if (recorded === false || recorded?.recorded === false) {
      return sendError(
        res,
        503,
        'Message learning feedback is temporarily unavailable',
        'MESSAGE_TELEGRAM_FEEDBACK_NOT_RECORDED',
      );
    }
    const acknowledged = await answerCallbackQuery(
      callbackQueryId,
      verified.feedback,
      config,
      fetchImpl,
    );
    return res.status(200).json({
      success: true,
      data: {
        shop_id: verified.shop_id,
        draft_id: verified.draft_id,
        feedback: verified.feedback,
        recorded: true,
        telegram_acknowledged: acknowledged,
      },
    });
  };
}
