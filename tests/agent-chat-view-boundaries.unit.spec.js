import fs from 'node:fs';
import { expect, test } from '@playwright/test';

import {
  agentAttachmentPresentation,
  agentDebugTracePresentation,
  agentMessageRolePresentation,
} from '../public/utils/agent-chat/message-presentation.js';
import {
  agentLoadingMarkup,
  agentSuggestionChipsMarkup,
  agentWelcomeMarkup,
} from '../public/utils/agent-chat/auxiliary-markup.js';
import { agentShellMarkup } from '../public/utils/agent-chat/shell-markup.js';

test('message role presentation preserves user/runtime/assistant contracts', () => {
  expect(agentMessageRolePresentation('user')).toMatchObject({
    wrapClassName: 'agent-message-wrap agent-message-wrap-user',
    bubbleClassName: 'agent-message-bubble agent-message-bubble-user',
    senderLabel: 'User:\n',
  });
  expect(agentMessageRolePresentation('runtime').senderLabel).toBe('Etsy AI Command Center runtime:\n');
  expect(agentMessageRolePresentation('assistant').senderLabel).toBe('Agent:\n');
  expect(agentMessageRolePresentation('custom')).toMatchObject({
    wrapClassName: 'agent-message-wrap agent-message-wrap-custom',
    bubbleClassName: 'agent-message-bubble agent-message-bubble-custom',
    senderLabel: 'Agent:\n',
  });
});

test('attachment and debug projections preserve fail-soft behavior', () => {
  expect(agentAttachmentPresentation()).toEqual({
    attached: false,
    preview: '',
    filename: '',
    display: 'none',
    accent: '',
  });
  expect(agentAttachmentPresentation({ preview: 'blob:x', filename: '' })).toMatchObject({
    attached: true,
    preview: 'blob:x',
    filename: 'image.jpg',
    display: 'flex',
  });
  expect(agentDebugTracePresentation([], true)).toBeNull();
  expect(agentDebugTracePresentation([{ tool: 'etsy' }], false)).toBeNull();
  expect(agentDebugTracePresentation([{ tool: 'etsy' }], true)).toEqual({
    items: [{ tool: 'etsy' }],
    bodyText: '[\n  {\n    "tool": "etsy"\n  }\n]',
  });
});

test('auxiliary markup preserves welcome/loading/chip behavior', () => {
  expect(agentWelcomeMarkup()).toContain('AI Shop Agent');
  expect(agentWelcomeMarkup()).toContain('Nothing is applied to Etsy until you approve a card.');
  expect(agentLoadingMarkup()).toContain('agent-tool-status');
  expect(agentLoadingMarkup()).toContain('agent-progress-history');
  expect(agentSuggestionChipsMarkup(["What's new?"])).toContain("window.__agentSend('What\\'s new?')");
});

test('shell markup preserves required controller element ids', () => {
  const html = agentShellMarkup();
  for (const id of [
    'agent-model-select',
    'agent-memory-btn',
    'agent-history-btn',
    'agent-clear-btn',
    'agent-history-panel',
    'agent-memory-panel',
    'agent-messages',
    'agent-input',
    'agent-img-file',
    'agent-send-btn',
    'agent-chips',
  ]) expect(html).toContain(`id="${id}"`);
});

test('agent-chat-view-model entry is a thin compatibility facade', () => {
  const source = fs.readFileSync(new URL('../public/utils/agent-chat-view-model.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(25);
  expect(source).not.toContain('MESSAGE_PRESENTATIONS');
  expect(source).not.toContain('<div class="agent-shell">');
  expect(source).toContain("./agent-chat/message-presentation.js");
  expect(source).toContain("./agent-chat/auxiliary-markup.js");
  expect(source).toContain("./agent-chat/shell-markup.js");
});
