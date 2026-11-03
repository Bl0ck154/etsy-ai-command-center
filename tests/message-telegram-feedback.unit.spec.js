import { expect, test } from '@playwright/test';

import {
  createMessageTelegramFeedbackToken,
  verifyMessageTelegramFeedbackToken,
} from '../api/messages/telegram-feedback-token.js';
import { createMessageTelegramFeedbackHandler } from '../api/messages/telegram-feedback-handler.js';

const ENV_KEYS = [
  'MESSAGE_TELEGRAM_FEEDBACK_ENABLED',
  'MESSAGE_LEARNING_CAPTURE_ENABLED',
  'MESSAGE_TELEGRAM_FEEDBACK_SIGNING_SECRET',
  'MESSAGE_TELEGRAM_FEEDBACK_WEBHOOK_SECRET',
  'MESSAGE_TELEGRAM_FEEDBACK_OWNER_USER_ID',
  'MESSAGE_TELEGRAM_FEEDBACK_CHAT_ID',
  'MESSAGE_TELEGRAM_BOT_TOKEN',
];

function setFeedbackEnv() {
  Object.assign(process.env, {
    MESSAGE_TELEGRAM_FEEDBACK_ENABLED: 'true',
    MESSAGE_LEARNING_CAPTURE_ENABLED: 'true',
    MESSAGE_TELEGRAM_FEEDBACK_SIGNING_SECRET: 'signing-secret-0123456789abcdef0123456789',
    MESSAGE_TELEGRAM_FEEDBACK_WEBHOOK_SECRET: 'webhook-secret-0123456789abcdef0123456789',
    MESSAGE_TELEGRAM_FEEDBACK_OWNER_USER_ID: '551234567',
    MESSAGE_TELEGRAM_FEEDBACK_CHAT_ID: '-1004403416789',
    MESSAGE_TELEGRAM_BOT_TOKEN: 'test-bot-token',
  });
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

function callbackRequest(data, overrides = {}) {
  return {
    method: 'POST',
    headers: {
      'x-telegram-bot-api-secret-token': process.env.MESSAGE_TELEGRAM_FEEDBACK_WEBHOOK_SECRET,
    },
    body: {
      callback_query: {
        id: 'callback-42',
        from: { id: 551234567 },
        message: {
          message_id: 99,
          chat: { id: -1004403416789 },
        },
        data,
        ...overrides,
      },
    },
  };
}

test.describe('Messages Telegram learning feedback', () => {
  let previous;

  test.beforeEach(() => {
    previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    setFeedbackEnv();
  });

  test.afterEach(() => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  test('signed callback tokens round-trip and remain within Telegram 64-byte limit', () => {
    const shopId = '12345678901234567890';
    const draftId = '12345678901234567890';
    const token = createMessageTelegramFeedbackToken({
      shopId,
      draftId,
      feedback: 'unhelpful',
    });

    expect(Buffer.byteLength(token, 'utf8')).toBeLessThanOrEqual(64);
    expect(verifyMessageTelegramFeedbackToken(token)).toEqual({
      shop_id: shopId,
      draft_id: draftId,
      feedback: 'unhelpful',
    });
    expect(verifyMessageTelegramFeedbackToken(`${token.slice(0, -1)}A`)).toBeNull();
  });

  test('records an owner callback and only acknowledges it through Telegram', async () => {
    const recorded = [];
    const telegramCalls = [];
    const handler = createMessageTelegramFeedbackHandler({
      recordFeedback: async input => {
        recorded.push(input);
        return { stored: true };
      },
      fetchImpl: async (url, request) => {
        telegramCalls.push({ url, payload: JSON.parse(request.body) });
        return { ok: true, json: async () => ({ ok: true, result: true }) };
      },
    });
    const token = createMessageTelegramFeedbackToken({
      shopId: '987654321',
      draftId: '123',
      feedback: 'helpful',
    });
    const res = responseRecorder();

    await handler(callbackRequest(token), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        shop_id: '987654321',
        draft_id: '123',
        feedback: 'helpful',
        recorded: true,
        telegram_acknowledged: true,
      },
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      shop_id: '987654321',
      draft_id: '123',
      rating: 'helpful',
      actor_id: '551234567',
      event_id: 'tgcb_da9f4cc200686fd93d0b0cf7dc0a4ed0',
      telegram_message_id: 99,
    });
    expect(Object.keys(recorded[0])).not.toContain('approved_body');
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].url).toContain('/answerCallbackQuery');
  });

  test('fails closed for a wrong webhook secret, owner, chat, or token', async () => {
    const calls = [];
    const handler = createMessageTelegramFeedbackHandler({
      recordFeedback: async input => calls.push(input),
      fetchImpl: async () => {
        throw new Error('Telegram must not be called');
      },
    });
    const token = createMessageTelegramFeedbackToken({
      shopId: '987654321',
      draftId: '123',
      feedback: 'helpful',
    });

    const wrongSecret = callbackRequest(token);
    wrongSecret.headers['x-telegram-bot-api-secret-token'] = 'wrong';
    const secretRes = responseRecorder();
    await handler(wrongSecret, secretRes);
    expect(secretRes.statusCode).toBe(401);

    const ownerRes = responseRecorder();
    await handler(callbackRequest(token, { from: { id: 999 } }), ownerRes);
    expect(ownerRes.statusCode).toBe(403);

    const chatRes = responseRecorder();
    await handler(callbackRequest(token, {
      message: { message_id: 99, chat: { id: -1001 } },
    }), chatRes);
    expect(chatRes.statusCode).toBe(403);

    const tokenRes = responseRecorder();
    await handler(callbackRequest(`${token.slice(0, -1)}A`), tokenRes);
    expect(tokenRes.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('acknowledges a pruned old callback as expired without claiming it was saved', async () => {
    const telegramCalls = [];
    const handler = createMessageTelegramFeedbackHandler({
      recordFeedback: async () => {
        const error = new Error('not found');
        error.code = 'MESSAGE_LEARNING_NOT_FOUND';
        throw error;
      },
      fetchImpl: async (_url, request) => {
        telegramCalls.push(JSON.parse(request.body));
        return { ok: true, json: async () => ({ ok: true, result: true }) };
      },
    });
    const token = createMessageTelegramFeedbackToken({
      shopId: '987654321',
      draftId: '123',
      feedback: 'unhelpful',
    });
    const res = responseRecorder();
    await handler(callbackRequest(token), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ recorded: false, expired: true });
    expect(telegramCalls[0].text).toContain('вже недоступна');
  });

  test('does not acknowledge feedback as saved when persistence declines it', async () => {
    const handler = createMessageTelegramFeedbackHandler({
      recordFeedback: async () => false,
      fetchImpl: async () => {
        throw new Error('Telegram must not be called');
      },
    });
    const token = createMessageTelegramFeedbackToken({
      shopId: '987654321',
      draftId: '123',
      feedback: 'helpful',
    });
    const res = responseRecorder();
    await handler(callbackRequest(token), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('MESSAGE_TELEGRAM_FEEDBACK_NOT_RECORDED');
  });

  test('stays unavailable when the feature or required owner configuration is absent', async () => {
    const handler = createMessageTelegramFeedbackHandler({
      recordFeedback: async () => {
        throw new Error('must not record');
      },
    });
    delete process.env.MESSAGE_TELEGRAM_FEEDBACK_OWNER_USER_ID;
    const res = responseRecorder();

    await handler(callbackRequest('anything'), res);

    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('MESSAGE_TELEGRAM_FEEDBACK_DISABLED');

    setFeedbackEnv();
    delete process.env.MESSAGE_LEARNING_CAPTURE_ENABLED;
    const captureDisabledRes = responseRecorder();
    await handler(callbackRequest('anything'), captureDisabledRes);
    expect(captureDisabledRes.statusCode).toBe(404);
    expect(captureDisabledRes.body.code).toBe('MESSAGE_TELEGRAM_FEEDBACK_DISABLED');
  });
});
