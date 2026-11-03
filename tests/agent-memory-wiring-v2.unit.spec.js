import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const kvSource = readFileSync(new URL('../api/kv.js', import.meta.url), 'utf8');
const repositorySource = readFileSync(new URL('../api/agent/memory-repository.js', import.meta.url), 'utf8');

test('canonical KV module composes one Agent memory repository owner', () => {
  expect(kvSource).toContain("from './agent/memory-repository.js'");
  expect(kvSource).toContain('const agentMemoryRepository = createAgentMemoryRepository({');
  expect(kvSource).toContain('callKv: kvCall');
  expect(kvSource).toContain('shopId: SHOP_ID');
});

test('all public memory helpers delegate to the repository', () => {
  expect(kvSource).toContain('return buildUserAgentMemoryKey(userId);');
  expect(kvSource).toContain('return agentMemoryRepository.load(userId);');
  expect(kvSource).toContain('return agentMemoryRepository.save(userId, value);');
  expect(kvSource).toContain('return agentMemoryRepository.append(userId, value);');
  expect(kvSource).toContain('return agentMemoryRepository.remove(userId, memoryId);');
  expect(kvSource).not.toContain('function normalizeAgentMemoryItems(value)');
});

test('existing browser memory actions still route through the same public helpers', () => {
  expect(kvSource).toContain("case 'getAgentMemory':");
  expect(kvSource).toContain('const data = await loadUserAgentMemory(userId);');
  expect(kvSource).toContain("case 'setAgentMemory':");
  expect(kvSource).toContain('await saveUserAgentMemory(userId, value);');
});

test('memory repository keeps legacy keys read-only and writes only the versioned state key', () => {
  expect(repositorySource).toContain("return `${legacyUserStorageKey(userId)}:state`;");
  expect(repositorySource).toContain("callKv('GET', encodeURIComponent(legacyUserStorageKey(userId)))");
  expect(repositorySource).toContain("callKv('GET', encodeURIComponent(`${scope}:agent_memory`))");
  expect(repositorySource).not.toMatch(/callKv\(['"]SET['"]/);
});
