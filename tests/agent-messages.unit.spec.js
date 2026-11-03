import { expect, test } from '@playwright/test';

test('internal agent has cache, policy, and draft tools but no message send authority', async () => {
  const { AGENT_SYSTEM, TOOLS } = await import(`../api/agent.js?agent_messages=${Date.now()}`);
  const names = TOOLS.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining([
    'list_message_conversations',
    'get_message_conversation',
    'get_message_playbook',
    'update_message_playbook',
    'get_message_automation_policy',
    'update_message_automation_policy',
    'prepare_message_draft',
  ]));
  expect(names.some(name => /approve.*message|send.*message/i.test(name))).toBe(false);
  expect(AGENT_SYSTEM).toContain('you have no tool or authority to approve or send it');
  expect(TOOLS.find(tool => tool.name === 'get_message_conversation').description)
    .toContain('cache-only');
});

test('message tools declare truthful runtime capabilities', async () => {
  const { AGENT_TOOL_RUNTIME_CONTRACTS } = await import(`../api/agent/tools-schema.js?agent_messages_contract=${Date.now()}`);
  expect(AGENT_TOOL_RUNTIME_CONTRACTS.get_message_conversation).toEqual({
    execution: 'server_read',
    targets: ['message_cache'],
  });
  expect(AGENT_TOOL_RUNTIME_CONTRACTS.prepare_message_draft).toEqual({
    execution: 'server_write',
    targets: ['message_outbox'],
  });
});
