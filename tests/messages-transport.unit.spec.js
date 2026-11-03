import { expect, test } from '@playwright/test';
import { createMessagesTransport } from '../public/utils/messages-transport.js';

function harness({ response = { data: { ok: true } }, fetchError = null } = {}) {
  const calls = [];
  const timers = [];
  const controller = {
    signal: { test: true },
    aborted: false,
    abort() { this.aborted = true; },
  };
  const transport = createMessagesTransport({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (fetchError) throw fetchError;
      return { marker: 'response' };
    },
    readJson: async (_res, context) => {
      expect(context).toBe('Messages');
      return response;
    },
    presentError: message => `friendly:${message}`,
    storage: { getItem: key => key === 'etsy_mgr_active_shop' ? 'shop-42' : null },
    createAbortController: () => controller,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  return { transport, calls, timers, controller };
}

test('GET preserves action query, no body, no-store and active shop header', async () => {
  const { transport, calls, timers } = harness();
  await expect(transport.get('listConversations', { limit: 50, cursor: 0 })).resolves.toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('/api/messages?action=listConversations&limit=50&cursor=0');
  expect(calls[0].options).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    body: undefined,
    headers: {
      'Content-Type': 'application/json',
      'x-shop-id': 'shop-42',
    },
  });
  expect(timers[0].ms).toBe(60_000);
});

test('POST preserves JSON action payload and caller timeout', async () => {
  const { transport, calls, timers } = harness({ response: { accepted: true } });
  await expect(transport.post('syncInbox', { full: true }, 190_000)).resolves.toEqual({ accepted: true });
  expect(calls[0].url).toBe('/api/messages');
  expect(calls[0].options.method).toBe('POST');
  expect(JSON.parse(calls[0].options.body)).toEqual({ action: 'syncInbox', full: true });
  expect(timers[0].ms).toBe(190_000);
});

test('non-timeout failures keep user-facing error mapping', async () => {
  const { transport } = harness({ fetchError: new Error('bridge unavailable') });
  await expect(transport.get('status')).rejects.toThrow('friendly:bridge unavailable');
});

test('AbortError preserves explicit no-message-sent timeout text', async () => {
  const error = new Error('aborted');
  error.name = 'AbortError';
  const { transport } = harness({ fetchError: error });
  await expect(transport.post('sendApprovedDraft', { draft_id: '12' }, 170_000))
    .rejects.toThrow('Messages request timed out. No message was sent.');
});
