import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { createMessagesConversationView } from '../public/utils/messages-conversation-view.js';

function conversationView(locale = 'en') {
  return createMessagesConversationView({
    translate: (uk, en) => locale === 'en' ? en : uk,
    formatDate: value => `date:${value}`,
    attachmentContentUrl: id => `/api/messages/attachments/${id}/content`,
  });
}

test('conversation renderer preserves direction, sender, escaping, dates, and saved-history pagination', () => {
  const messages = Array.from({ length: 102 }, (_, index) => ({
    id: index + 1,
    direction: index % 2 ? 'outgoing' : 'incoming',
    body: index === 101 ? '<Final>\nline' : `Message ${index + 1}`,
    sent_at: `2026-08-09T00:${String(index % 60).padStart(2, '0')}:00Z`,
  }));
  const html = conversationView('en').conversationMessagesHtml({
    participant: 'Buyer & friend',
    messages,
  }, { visibleMessageLimit: 2 });

  expect(html).toContain('Show 100 older saved messages');
  expect(html).toContain('100 earlier messages are kept out of the browser until requested');
  expect(html).toContain('messages-bubble incoming buyer');
  expect(html).toContain('messages-bubble outgoing seller');
  expect(html).toContain('Buyer &amp; friend');
  expect(html).toContain('<strong>You</strong>');
  expect(html).toContain('&lt;Final&gt;<br>line');
  expect(html).toContain('date:2026-08-09T00:41:00Z');
  expect(html).not.toContain('Message 100');
});

test('conversation renderer shows only customer messages or unknown events with accessible attachments', () => {
  const html = conversationView().conversationMessagesHtml({
    messages: [
      { id: 'system', direction: 'system', body: 'Internal event' },
      { id: 'unknown-empty', direction: 'mystery', body: 'Unknown without media' },
      {
        id: 'unknown-file',
        direction: 'mystery',
        attachments: [{ id: '77', local_path: true, filename: 'proof.pdf', mime_type: 'application/pdf' }],
      },
    ],
  });

  expect(html).toContain('messages-event-unknown');
  expect(html).toContain('data-message-id="unknown-file"');
  expect(html).toContain('/api/messages/attachments/77/content');
  expect(html).toContain('download="proof.pdf"');
  expect(html).not.toContain('Internal event');
  expect(html).not.toContain('unknown-empty');
});

test('attachment renderer keeps public Etsy media read-only and fails closed for unsafe URLs', () => {
  const view = conversationView();
  const publicImage = view.attachmentHtml({
    filename: 'reference.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 1536,
    public_url: 'https://i.etsystatic.com/icm/abc/reference.jpg',
  });
  const unavailable = view.attachmentHtml({
    filename: '<private>.png',
    mime_type: 'image/png',
    public_url: 'https://example.test/private.png',
  });

  expect(publicImage).toContain('messages-attachment-preview');
  expect(publicImage).toContain('https://i.etsystatic.com/icm/abc/reference.jpg');
  expect(publicImage).toContain('image/jpeg · 2 KB');
  expect(publicImage).not.toContain(' download=');
  expect(unavailable).toContain('messages-attachment-unavailable');
  expect(unavailable).toContain('&lt;private&gt;.png');
  expect(unavailable).not.toContain('https://example.test');
});

test('conversation empty states distinguish unloaded from synchronized history', () => {
  const view = conversationView();
  expect(view.conversationMessagesHtml({ messages: [] }))
    .toContain('Messages are not loaded yet');
  expect(view.conversationMessagesHtml({ messages: [], history_synced_at: '2026-08-09' }))
    .toContain('No saved customer messages');
});

test('Messages page delegates conversation and attachment presentation across a strict boundary', async () => {
  const pageSource = await fs.readFile(new URL('../public/pages/messages.js', import.meta.url), 'utf8');
  const viewSource = await fs.readFile(
    new URL('../public/utils/messages-conversation-view.js', import.meta.url),
    'utf8',
  );

  expect(pageSource).toContain("from '../utils/messages-conversation-view.js'");
  expect(pageSource).toContain('createMessagesConversationView({');
  expect(pageSource).not.toMatch(/function (?:messageBody|conversationParticipant|messageSenderLabel|visibleConversationMessages|attachmentHtml)\(/);
  expect(pageSource).not.toContain('messages-attachment-preview-fallback');
  expect(viewSource).not.toMatch(
    /fetch\(|localStorage|sessionStorage|state\.|approve|sendDraft|delivery[_-]?status|unknown[_-]?delivery/i,
  );
});
