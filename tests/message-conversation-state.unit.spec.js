import { expect, test } from '@playwright/test';

import { conversationReplyState } from '../api/messages/conversation-state.js';

test('newest explicit buyer message is eligible for a reply preview', () => {
  expect(conversationReplyState({
    messages: [{
      source_id: 'shop-1',
      direction: 'outgoing',
      sender: 'self',
      sent_at: '2026-07-28T10:00:00Z',
    }, {
      source_id: 'buyer-2',
      direction: 'incoming',
      sender: 'buyer-id',
      sent_at: '2026-07-28T10:05:00Z',
    }],
  })).toMatchObject({
    status: 'eligible',
    eligible: true,
    source_message_id: 'buyer-2',
    latest_direction: 'incoming',
  });
});

test('newest shop reply produces deterministic no-action', () => {
  expect(conversationReplyState({
    messages: [{
      source_id: 'buyer-1',
      direction: 'incoming',
      sent_at: '2026-07-28T10:00:00Z',
    }, {
      source_id: 'shop-2',
      direction: 'outgoing',
      sent_at: '2026-07-28T10:05:00Z',
    }],
  })).toMatchObject({
    status: 'no_action',
    no_action: true,
    code: 'MESSAGE_DRAFT_ALREADY_ANSWERED',
    source_message_id: 'shop-2',
  });
});

test('unknown newest direction and inconsistent seller-labelled incoming fail closed', () => {
  expect(conversationReplyState({
    messages: [{
      source_id: 'unknown-1',
      direction: 'unknown',
      sent_at: '2026-07-28T10:05:00Z',
    }],
  })).toMatchObject({
    status: 'blocked',
    code: 'MESSAGE_DRAFT_LATEST_DIRECTION_UNVERIFIED',
  });

  expect(conversationReplyState({
    messages: [{
      source_id: 'conflict-1',
      direction: 'incoming',
      sender: 'seller',
      sent_at: '2026-07-28T10:05:00Z',
    }],
  })).toMatchObject({
    status: 'blocked',
    code: 'MESSAGE_DRAFT_LATEST_DIRECTION_UNVERIFIED',
  });
});

test('system events do not hide the latest authored message', () => {
  expect(conversationReplyState({
    messages: [{
      source_id: 'buyer-1',
      direction: 'incoming',
      sent_at: '2026-07-28T10:00:00Z',
    }, {
      source_id: 'system-2',
      direction: 'system',
      sent_at: '2026-07-28T10:05:00Z',
    }],
  })).toMatchObject({
    status: 'eligible',
    source_message_id: 'buyer-1',
  });
});
