import { test, expect } from '@playwright/test';

import {
  attachmentIdOf,
  attachmentSize,
  attachmentsForDisplay,
  conversationIdOf,
  conversationKey,
  draftIdOf,
  hasAccessibleAttachment,
  listFrom,
  mergeConversationPages,
  messagesRouteParams,
  nextCursorFrom,
  publicEtsyAttachmentUrl,
} from '../public/utils/messages-view-model.js';

test('messages view model normalizes list, ids and forward-only cursors', () => {
  expect(listFrom([{ id: 1 }])).toEqual([{ id: 1 }]);
  expect(listFrom({ items: [{ id: 2 }] })).toEqual([{ id: 2 }]);
  expect(listFrom({ results: [{ id: 3 }] })).toEqual([{ id: 3 }]);
  expect(listFrom({})).toEqual([]);

  expect(draftIdOf({ draft_id: 123 })).toBe('123');
  expect(draftIdOf({ id: 'fallback' })).toBe('fallback');
  expect(conversationIdOf({ conversation_source_id: 456 })).toBe('456');
  expect(conversationIdOf({ conversation_id: 'legacy' })).toBe('legacy');

  expect(nextCursorFrom({ next_cursor: 51 }, 50)).toBe(51);
  expect(nextCursorFrom({ next_cursor: 50 }, 50)).toBeNull();
  expect(nextCursorFrom({ next_cursor: 'bad' }, 0)).toBeNull();
  expect(nextCursorFrom({}, 0)).toBeNull();
});

test('messages view model merges paginated conversations without duplicates', () => {
  const current = [
    { conversation_id: '1', participant: 'Older one', unread: true },
    { conversation_id: '2', participant: 'Second' },
  ];
  const incoming = [
    { conversation_id: '2', last_message_at: '2026-08-09T00:00:00Z' },
    { conversation_id: '3', participant: 'Third' },
  ];

  expect(mergeConversationPages(current, incoming)).toEqual([
    current[0],
    { ...current[1], ...incoming[0] },
    incoming[1],
  ]);

  expect(mergeConversationPages(current, incoming, { firstPage: true })).toEqual([
    { ...current[1], ...incoming[0] },
    incoming[1],
    current[0],
  ]);
});

test('messages view model keeps a stable fallback key for source-less conversations', () => {
  const value = { participant: 'Buyer', updated_at: '2026-08-09T12:00:00Z' };
  expect(conversationKey(value, item => item.participant)).toBe(
    'Buyer:2026-08-09T12:00:00Z',
  );
});

test('messages attachment view model allows only public Etsy ICM assets', () => {
  expect(publicEtsyAttachmentUrl({ url: 'https://i.etsystatic.com/icm/file.png' })).toBe(
    'https://i.etsystatic.com/icm/file.png',
  );
  expect(publicEtsyAttachmentUrl({ url: 'https://i.etsystatic.com/not-icm/file.png' })).toBe('');
  expect(publicEtsyAttachmentUrl({ url: 'https://evil.example/icm/file.png' })).toBe('');
  expect(publicEtsyAttachmentUrl({ url: 'https://i.etsystatic.com/icm/file.svg' })).toBe('');
  expect(publicEtsyAttachmentUrl({ url: 'http://i.etsystatic.com/icm/file.png' })).toBe('');
});

test('messages attachment view model prefers local copies and reports accessibility', () => {
  const publicCopy = {
    sha256: 'same',
    filename: 'proof.png',
    url: 'https://i.etsystatic.com/icm/proof.png',
  };
  const localCopy = {
    ...publicCopy,
    attachment_id: '42',
    local_path: true,
  };
  expect(attachmentsForDisplay([publicCopy, localCopy])).toEqual([localCopy]);
  expect(attachmentIdOf(localCopy)).toBe('42');
  expect(attachmentIdOf({ attachment_id: '../42' })).toBe('');
  expect(hasAccessibleAttachment({ attachments: [localCopy] })).toBeTruthy();
  expect(hasAccessibleAttachment({ attachments: [{ filename: 'missing.pdf' }] })).toBeFalsy();
  expect(attachmentSize(512)).toBe('512 B');
  expect(attachmentSize(2048)).toBe('2 KB');
  expect(attachmentSize(2.5 * 1024 ** 2)).toBe('2.5 MB');
});

test('messages route state exposes only the active tab selection', () => {
  const state = {
    locale: 'en',
    draft: { draft_id: 'draft-1' },
    conversation: { conversation_id: 'conversation-1' },
  };
  expect(messagesRouteParams({ ...state, tab: 'queue' })).toEqual({
    tab: 'queue',
    lang: 'en',
    draft_id: 'draft-1',
  });
  expect(messagesRouteParams({ ...state, tab: 'inbox' })).toEqual({
    tab: 'inbox',
    lang: 'en',
    conversation_id: 'conversation-1',
  });
  expect(messagesRouteParams({ ...state, tab: 'automation' })).toEqual({
    tab: 'automation',
    lang: 'en',
  });
});
