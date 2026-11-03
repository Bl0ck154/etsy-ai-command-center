import { test, expect } from '@playwright/test';

import {
  createMessagesConversationApplication,
  normalizedMessageDirection,
} from '../api/messages/conversation-application.js';

test('message direction normalization preserves explicit and boolean precedence', () => {
  expect(normalizedMessageDirection({ direction: 'seller' })).toBe('outgoing');
  expect(normalizedMessageDirection({ direction: 'buyer' })).toBe('incoming');
  expect(normalizedMessageDirection({ direction: 'system' })).toBe('system');
  expect(normalizedMessageDirection({ is_outgoing: true })).toBe('outgoing');
  expect(normalizedMessageDirection({ sender_role: 'customer' })).toBe('incoming');
  expect(normalizedMessageDirection({ sender: '123456' })).toBe('unknown');
});

test('conversation application follows cursor pages and merges duplicate message ids', async () => {
  const queries = [];
  const app = createMessagesConversationApplication({
    bridgeQuery: async (path, params) => {
      queries.push({ path, params });
      if (params.cursor === 0) {
        return {
          items: [
            { source_id: 'm1', body: 'old', direction: 'buyer' },
            { source_id: 'm2', body: 'two', direction: 'seller' },
          ],
          next_cursor: 2,
        };
      }
      return {
        items: [
          { source_id: 'm1', body: 'new', attachments: [{ id: 1 }] },
          { source_id: 'm3', body: 'three', is_outgoing: false },
        ],
        next_cursor: null,
      };
    },
    bridgeRequest: async path => ({ source_id: path.split('/').pop(), participant: 'Buyer' }),
    conversationReplyState: conversation => ({
      eligible: true,
      source_message_id: conversation.messages.at(-1)?.source_id,
    }),
  });

  const bundle = await app.conversationBundle('42');
  expect(queries).toEqual([
    { path: '/v1/conversations/42/messages', params: { limit: 500, cursor: 0 } },
    { path: '/v1/conversations/42/messages', params: { limit: 500, cursor: 2 } },
  ]);
  expect(bundle.messages).toHaveLength(3);
  expect(bundle.messages[0]).toMatchObject({
    source_id: 'm1',
    body: 'new',
    attachments: [{ id: 1 }],
    direction: 'incoming',
  });
  expect(bundle.messages[1].direction).toBe('outgoing');
  expect(bundle.messages[2].direction).toBe('incoming');
});

test('conversation refresh preserves exact bridge sync contract before reply-state evaluation', async () => {
  const requests = [];
  const app = createMessagesConversationApplication({
    bridgeQuery: async () => ({ items: [], next_cursor: null }),
    bridgeRequest: async (path, options) => {
      requests.push({ path, options });
      if (path.includes('/history/sync')) return { synced: true };
      return { source_id: '77' };
    },
    conversationReplyState: () => ({ eligible: false, code: 'NO_REPLY' }),
  });

  const result = await app.refreshedConversationForDraft('77');
  expect(requests[0]).toEqual({
    path: '/v1/conversations/77/history/sync?wait=true&full=false',
    options: { method: 'POST', timeoutMs: 180_000 },
  });
  expect(result).toMatchObject({
    sync: { synced: true },
    replyState: { eligible: false, code: 'NO_REPLY' },
  });
});
