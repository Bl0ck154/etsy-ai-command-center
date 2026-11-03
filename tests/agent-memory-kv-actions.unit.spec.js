import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const source = readFileSync(new URL('../api/kv.js', import.meta.url), 'utf8');

test('KV handler exposes semantic append and delete actions through the same repository helpers', () => {
  expect(source).toContain("case 'appendAgentMemory':");
  expect(source).toContain('appendUserAgentMemory(userId, value || {})');
  expect(source).toContain("case 'deleteAgentMemory':");
  expect(source).toContain('deleteUserAgentMemory(userId, memoryId)');
});

test('legacy full replacement action remains available for compatibility', () => {
  expect(source).toContain("case 'setAgentMemory':");
  expect(source).toContain('saveUserAgentMemory(userId, value)');
});
