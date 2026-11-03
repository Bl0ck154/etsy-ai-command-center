import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const apiSource = readFileSync(new URL('../public/utils/api.js', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../public/pages/agent.js', import.meta.url), 'utf8');

test('central browser API composes the semantic memory client with existing shop-aware transport', () => {
  expect(apiSource).toContain("import { createAgentMemoryClient } from './agent-memory-client.js';");
  expect(apiSource).toContain('const agentMemoryClient = createAgentMemoryClient({ get, post });');
  expect(apiSource).toContain('getAgentMemory: () => agentMemoryClient.load()');
  expect(apiSource).toContain('setAgentMemory: (value) => agentMemoryClient.replace(value)');
  expect(apiSource).toContain('appendAgentMemory: (value) => agentMemoryClient.append(value)');
  expect(apiSource).toContain('deleteAgentMemory: (id) => agentMemoryClient.remove(id)');
});

test('existing Agent page keeps its compatibility get/set calls', () => {
  expect(pageSource).toContain('kv.getAgentMemory()');
  expect(pageSource).toContain('kv.setAgentMemory(items)');
});
