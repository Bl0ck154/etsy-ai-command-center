import { test, expect } from '@playwright/test';

import { notifyMessageDraftReady } from '../api/messages/draft-notifier.js';

test('Telegram suggestion is a compact Ukrainian HTML card with recent conversation and button', async () => {
  const previous = {
    enabled: process.env.MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED,
    token: process.env.MESSAGE_TELEGRAM_BOT_TOKEN,
    suggestions: process.env.MESSAGE_SUGGESTIONS_CHAT_ID,
    approvals: process.env.MESSAGE_APPROVALS_CHAT_ID,
    base: process.env.PUBLIC_BASE_URL,
    feedbackEnabled: process.env.MESSAGE_TELEGRAM_FEEDBACK_ENABLED,
  };
  process.env.MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED = 'true';
  process.env.MESSAGE_TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.MESSAGE_SUGGESTIONS_CHAT_ID = '-1004403416789';
  process.env.MESSAGE_APPROVALS_CHAT_ID = '-1001';
  process.env.PUBLIC_BASE_URL = 'https://em.example.test';
  process.env.MESSAGE_TELEGRAM_FEEDBACK_ENABLED = 'false';

  let payload;
  try {
    const result = await notifyMessageDraftReady({
      draft_id: '123',
      participant: 'Sarah & Co',
      conversation_id: '77',
      receipt_id: '4150273796',
      scenario: 'freeform',
      reason: 'internal router rationale that should not be shown',
      source_message_preview: 'Can you make it lighter?',
      draft_preview: 'Hi! Yes, sure, I can make it lighter for you 😊',
    }, {
      loadConversation: async () => ({
        messages: [
          { direction: 'incoming', sent_at: '2026-08-22T10:00:00Z', body: 'Hello <there>' },
          { direction: 'outgoing', sent_at: '2026-08-22T10:01:00Z', body: 'Hi! Yes, sure 😊' },
          { direction: 'incoming', sent_at: '2026-08-22T10:02:00Z', body: 'Can you make it lighter?' },
        ],
      }),
      fetchImpl: async (_url, request) => {
        payload = JSON.parse(request.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { message_id: 9, chat: { id: -1004403416789 } },
          }),
        };
      },
    });

    expect(result).toMatchObject({ delivered: true, message_id: 9 });
    expect(payload.parse_mode).toBe('HTML');
    expect(payload.text).toContain('💬 <b>Etsy · Sarah &amp; Co</b>');
    expect(payload.text).toContain('<b>Останні повідомлення</b>');
    expect(payload.text).toContain('<blockquote>');
    expect(payload.text).toContain('👤 <b>Клієнт</b>: Hello &lt;there&gt;');
    expect(payload.text).toContain('🛍️ <b>Ми</b>: Hi! Yes, sure 😊');
    expect(payload.text).toContain('✨ <b>Пропозиція відповіді</b>');
    expect(payload.text).toContain('Нічого не відправлено. Це лише чернетка');
    expect(payload.text).not.toContain('Scenario:');
    expect(payload.text).not.toContain('Conversation:');
    expect(payload.text).not.toContain('internal router rationale');
    expect(payload.reply_markup.inline_keyboard[0][0]).toEqual({
      text: 'Відкрити в Etsy AI Command Center',
      url: 'https://em.example.test/#messages?tab=queue&draft_id=123',
    });
  } finally {
    for (const [key, value] of Object.entries({
      MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED: previous.enabled,
      MESSAGE_TELEGRAM_BOT_TOKEN: previous.token,
      MESSAGE_SUGGESTIONS_CHAT_ID: previous.suggestions,
      MESSAGE_APPROVALS_CHAT_ID: previous.approvals,
      PUBLIC_BASE_URL: previous.base,
      MESSAGE_TELEGRAM_FEEDBACK_ENABLED: previous.feedbackEnabled,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Telegram suggestion adds signed learning buttons only when explicitly enabled', async () => {
  const keys = [
    'MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED',
    'MESSAGE_TELEGRAM_BOT_TOKEN',
    'MESSAGE_SUGGESTIONS_CHAT_ID',
    'PUBLIC_BASE_URL',
    'MESSAGE_TELEGRAM_FEEDBACK_ENABLED',
    'MESSAGE_LEARNING_CAPTURE_ENABLED',
    'MESSAGE_TELEGRAM_FEEDBACK_SIGNING_SECRET',
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
    MESSAGE_TELEGRAM_BOT_TOKEN: 'test-token',
    MESSAGE_SUGGESTIONS_CHAT_ID: '-1004403416789',
    PUBLIC_BASE_URL: 'https://em.example.test',
    MESSAGE_TELEGRAM_FEEDBACK_ENABLED: 'true',
    MESSAGE_LEARNING_CAPTURE_ENABLED: 'true',
    MESSAGE_TELEGRAM_FEEDBACK_SIGNING_SECRET: '0123456789abcdef0123456789abcdef',
  });

  let payload;
  try {
    await notifyMessageDraftReady({
      shop_id: '987654321',
      draft_id: '123',
      participant: 'Sarah',
      source_message_preview: 'Can you make it lighter?',
      draft_preview: 'Yes, I can make it lighter.',
    }, {
      fetchImpl: async (_url, request) => {
        payload = JSON.parse(request.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { message_id: 9, chat: { id: -1004403416789 } },
          }),
        };
      },
    });

    const [feedbackRow, dashboardRow] = payload.reply_markup.inline_keyboard;
    expect(feedbackRow.map(button => button.text)).toEqual(['👍 Влучно', '👎 Не влучно']);
    expect(feedbackRow[0].callback_data).toMatch(/^ml1\.h\.987654321\.123\./);
    expect(feedbackRow[1].callback_data).toMatch(/^ml1\.n\.987654321\.123\./);
    expect(Buffer.byteLength(feedbackRow[0].callback_data, 'utf8')).toBeLessThanOrEqual(64);
    expect(dashboardRow[0].url).toContain('draft_id=123');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
