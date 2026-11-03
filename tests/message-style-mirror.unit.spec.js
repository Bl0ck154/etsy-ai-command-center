import { test, expect } from '@playwright/test';

import { generateMessageDraft } from '../api/messages/draft-agent.js';
import { DEFAULT_MESSAGE_PLAYBOOK } from '../api/messages/playbook.js';
import {
  buildShopSellerStyleReference,
  clearShopSellerStyleReferenceCache,
  loadShopSellerStyleReference,
} from '../api/messages/shop-style-reference.js';

test.afterEach(() => clearShopSellerStyleReferenceCache());

test('shop style profile uses the whole outgoing corpus across conversations', () => {
  const corpus = [];
  for (let index = 0; index < 120; index += 1) {
    corpus.push({
      source_id: `seller-${index}`,
      conversation_source_id: `conversation-${index % 17}`,
      sent_at: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      body: index % 3 === 0
        ? `Hi! Yes, sure 😊 Example ${index}`
        : `No problem! I can do that for you. Example ${index}`,
    });
  }
  const style = buildShopSellerStyleReference(corpus);

  expect(style).toMatchObject({
    available: true,
    scope: 'shop_wide_cached_outgoing',
    corpus_message_count: 120,
    unique_message_count: 120,
    conversation_count: 17,
    priority: 'strong',
  });
  expect(style.examples.length).toBeGreaterThan(12);
  expect(style.examples.length).toBeLessThanOrEqual(80);
  expect(style.profile.emoji_message_rate).toBeGreaterThan(0);
  expect(style.profile.common_openings.length).toBeGreaterThan(0);
});

test('shop style loader paginates every Bridge corpus page and caches the result', async () => {
  const calls = [];
  const pages = new Map([
    [0, {
      total: 3,
      next_cursor: 2,
      items: [
        { source_id: 'a', conversation_source_id: 'c1', body: 'Hi!', sent_at: '2026-08-01T10:00:00Z' },
        { source_id: 'b', conversation_source_id: 'c2', body: 'Sure 😊', sent_at: '2026-08-02T10:00:00Z' },
      ],
    }],
    [2, {
      total: 3,
      next_cursor: null,
      items: [
        { source_id: 'c', conversation_source_id: 'c3', body: 'No problem!', sent_at: '2026-08-03T10:00:00Z' },
      ],
    }],
  ]);
  const fetchPage = async (path, query) => {
    calls.push({ path, query });
    return pages.get(query.cursor);
  };

  const first = await loadShopSellerStyleReference('shop-1', { fetchPage, nowMs: 1000 });
  const second = await loadShopSellerStyleReference('shop-1', { fetchPage, nowMs: 2000 });

  expect(first.corpus_message_count).toBe(3);
  expect(first.conversation_count).toBe(3);
  expect(second).toEqual(first);
  expect(calls).toEqual([
    { path: '/v1/style/outgoing-messages', query: { limit: 2000, cursor: 0 } },
    { path: '/v1/style/outgoing-messages', query: { limit: 2000, cursor: 2 } },
  ]);
});

test('draft agent uses shop-wide style even when the current conversation has no seller reply', async () => {
  let capturedSystem = '';
  let capturedUser = null;
  const sellerStyleReference = buildShopSellerStyleReference([
    { source_id: 's1', conversation_source_id: 'old-1', sent_at: '2026-07-01T10:00:00Z', body: 'Hi! Yes, sure 😊' },
    { source_id: 's2', conversation_source_id: 'old-2', sent_at: '2026-07-02T10:00:00Z', body: 'No problem! I can do that for you 😊' },
    { source_id: 's3', conversation_source_id: 'old-3', sent_at: '2026-07-03T10:00:00Z', body: 'Thank you!' },
    { source_id: 's4', conversation_source_id: 'old-4', sent_at: '2026-07-04T10:00:00Z', body: 'Sure! 😊' },
  ]);

  const result = await generateMessageDraft({
    scenario: 'freeform',
    conversation: {
      id: 'new-thread',
      participant: 'Sarah',
      messages: [
        { source_id: 'buyer-new', direction: 'incoming', sender: 'buyer', sent_at: '2026-08-22T10:05:00Z', body: 'Please make it slightly warmer.' },
      ],
    },
    ownerNotes: '',
    verifiedFacts: {},
    playbook: DEFAULT_MESSAGE_PLAYBOOK,
    sourceMessageId: 'buyer-new',
    sellerStyleReference,
    generate: async (systemPrompt, userPrompt) => {
      capturedSystem = systemPrompt;
      capturedUser = JSON.parse(userPrompt);
      return {
        status: 'ready',
        scenario: 'freeform',
        reply_body: 'Hi! Yes, sure 😊 I can make it slightly warmer.',
        language: 'English',
        confidence: 0.95,
        rationale: 'Directly answers the request in the shop style.',
        facts_used: [],
        warnings: [],
        requires_human_approval: true,
        block_reason: '',
      };
    },
    reviewDraft: async () => ({
      approved: true,
      confidence: 0.95,
      rationale: 'Good',
    }),
  });

  expect(result.status).toBe('ready');
  expect(capturedSystem).toContain('ALL available real OUTGOING Etsy messages');
  expect(capturedSystem).toContain('new or contains no prior shop reply');
  expect(capturedUser.conversation.messages).toHaveLength(1);
  expect(capturedUser.seller_style_reference).toMatchObject({
    available: true,
    scope: 'shop_wide_cached_outgoing',
    corpus_message_count: 4,
    conversation_count: 4,
  });
  expect(capturedUser.seller_style_reference.examples.map(item => item.body)).toContain('Hi! Yes, sure 😊');
  expect(capturedUser.seller_style_reference.examples.some(item => item.body.includes('Please make'))).toBe(false);
});
