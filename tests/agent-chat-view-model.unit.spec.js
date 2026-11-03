import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  agentAttachmentPresentation,
  agentDebugTracePresentation,
  agentLoadingMarkup,
  agentMessageRolePresentation,
  agentShellMarkup,
  agentSuggestionChipsMarkup,
  agentWelcomeMarkup,
} from '../public/utils/agent-chat-view-model.js';

test('message role presentation preserves the existing chat bubble chrome', () => {
  expect(agentMessageRolePresentation('user')).toEqual({
    wrapClassName: 'agent-message-wrap agent-message-wrap-user',
    wrapStyle: 'display:flex;flex-direction:column;align-items:flex-end',
    bubbleClassName: 'agent-message-bubble agent-message-bubble-user',
    bubbleStyle: 'background:var(--orange);color:#fff;padding:10px 14px;border-radius:14px 14px 4px 14px;font-size:13px;max-width:75%;line-height:1.5;white-space:pre-wrap',
    senderLabel: 'User:\n',
  });
  expect(agentMessageRolePresentation('runtime')).toMatchObject({
    wrapClassName: 'agent-message-wrap agent-message-wrap-runtime',
    senderLabel: 'Etsy AI Command Center runtime:\n',
  });
  expect(agentMessageRolePresentation('assistant')).toMatchObject({
    wrapClassName: 'agent-message-wrap agent-message-wrap-assistant',
    senderLabel: 'Agent:\n',
  });
  expect(agentMessageRolePresentation('unknown')).toEqual({
    ...agentMessageRolePresentation('assistant'),
    wrapClassName: 'agent-message-wrap agent-message-wrap-unknown',
    bubbleClassName: 'agent-message-bubble agent-message-bubble-unknown',
  });
});

test('attachment presentation normalizes only deterministic composer chrome', () => {
  const image = { preview: 'blob:preview', filename: 'reference.png', ignored: true };
  const snapshot = structuredClone(image);

  expect(agentAttachmentPresentation(image)).toEqual({
    attached: true,
    preview: 'blob:preview',
    filename: 'reference.png',
    display: 'flex',
    accent: 'var(--orange)',
  });
  expect(agentAttachmentPresentation()).toEqual({
    attached: false,
    preview: '',
    filename: '',
    display: 'none',
    accent: '',
  });
  expect(image).toEqual(snapshot);
});

test('suggestion chip markup preserves labels and inline send arguments', () => {
  expect(agentSuggestionChipsMarkup(['Show stats', "What's new?"])).toBe(
    '<button class="btn btn-sm" style="font-size:11px;color:var(--text-2)" onclick="window.__agentSend(\'Show stats\')">Show stats</button>'
    + '<button class="btn btn-sm" style="font-size:11px;color:var(--text-2)" onclick="window.__agentSend(\'What\\\'s new?\')">What\'s new?</button>',
  );
  expect(agentSuggestionChipsMarkup(null)).toBe('');
});

test('Agent shell markup preserves required controls and event wiring', () => {
  const markup = agentShellMarkup();

  expect(markup).toContain('<div class="agent-shell">');
  expect(markup).toContain('<option value="external">External AI</option>');
  expect(markup).toContain('id="agent-history-panel"');
  expect(markup).toContain('id="agent-memory-panel"');
  expect(markup).toContain('id="agent-drag-overlay"');
  expect(markup).toContain('Image attached — ready for analysis');
  expect(markup).toContain('placeholder="Ask me anything, or drop/paste an image here…"');
  expect(markup).toContain("window.__agentHandleImgFile(this.files[0]);this.value=''");
  expect(markup).toContain('onclick="window.__agentSend()"');
  expect(markup.match(/id="agent-input"/g)).toHaveLength(1);
});

test('welcome and loading markup preserve presentation-only status regions', () => {
  expect(agentWelcomeMarkup()).toContain('Nothing is applied to Etsy until you approve a card.');
  expect(agentWelcomeMarkup()).toContain('If a listing match is unclear, I’ll ask before changing it.');
  expect(agentLoadingMarkup()).toContain('id="agent-tool-status" aria-live="polite"');
  expect(agentLoadingMarkup()).toContain('id="agent-progress-history"');
});

test('debug trace presentation filters empty diagnostics without changing the trace', () => {
  const trace = [null, { type: 'request', value: 1 }, false, { type: 'response' }];
  const snapshot = structuredClone(trace);

  expect(agentDebugTracePresentation(trace, false)).toBeNull();
  expect(agentDebugTracePresentation([], true)).toBeNull();
  expect(agentDebugTracePresentation(trace, true)).toEqual({
    items: [{ type: 'request', value: 1 }, { type: 'response' }],
    bodyText: '[\n  {\n    "type": "request",\n    "value": 1\n  },\n  {\n    "type": "response"\n  }\n]',
  });
  expect(trace).toEqual(snapshot);
});

test('Agent page delegates chat chrome across a strict presentation boundary', async () => {
  const pageSource = await fs.readFile(new URL('../public/pages/agent.js', import.meta.url), 'utf8');
  const viewModelSource = await fs.readFile(
    new URL('../public/utils/agent-chat-view-model.js', import.meta.url),
    'utf8',
  );

  expect(pageSource).toContain("from '../utils/agent-chat-view-model.js'");
  expect(pageSource).toContain('container.innerHTML = agentShellMarkup();');
  expect(pageSource).toContain('agentMessageRolePresentation(role)');
  expect(pageSource).toContain('agentAttachmentPresentation(imgData)');
  expect(pageSource).toContain('agentSuggestionChipsMarkup(CHIPS)');
  expect(pageSource).toContain('agentDebugTracePresentation(trace, agentDebugTraceVisible())');
  expect(pageSource).not.toContain('container.innerHTML = `\n    <div class="agent-shell">');
  expect(viewModelSource).not.toMatch(
    /agentMessages|sendAgentMessage|normalizePlanUpdate|stripListingThumbnailMetadata|renderAgentMarkdown|tool[_-]?result|systemPrompt|fetch\(|localStorage|sessionStorage|idbHistory|pending_updates/i,
  );
});
