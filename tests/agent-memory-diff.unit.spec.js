import { expect, test } from '@playwright/test';
import { classifyAgentMemoryReplacement } from '../public/utils/agent-memory-diff.js';

const item = (id, text, createdAt = 1) => ({ id, text, category: 'fact', createdAt });

test('classifies one pure addition as semantic append', () => {
  const previous = [item('a', 'A')];
  const added = item('b', 'B', 2);
  expect(classifyAgentMemoryReplacement(previous, [added, ...previous]))
    .toEqual({ kind: 'append', item: added });
});

test('classifies one pure removal as semantic delete', () => {
  const previous = [item('a', 'A'), item('b', 'B', 2)];
  expect(classifyAgentMemoryReplacement(previous, [previous[1]]))
    .toEqual({ kind: 'delete', id: 'a' });
});

test('falls back to replace for edits or multiple changes', () => {
  const previous = [item('a', 'A'), item('b', 'B', 2)];
  expect(classifyAgentMemoryReplacement(previous, [item('a', 'Edited'), previous[1]]))
    .toEqual({ kind: 'replace' });
  expect(classifyAgentMemoryReplacement(previous, [item('c', 'C'), item('d', 'D')]))
    .toEqual({ kind: 'replace' });
});

test('falls back to replace when there is no client snapshot', () => {
  expect(classifyAgentMemoryReplacement(null, [item('a', 'A')]))
    .toEqual({ kind: 'replace' });
});

test('text identity supports legacy items without ids but delete requires a stable id', () => {
  const previous = [{ text: 'Legacy', category: 'fact', createdAt: 1 }];
  expect(classifyAgentMemoryReplacement(previous, []))
    .toEqual({ kind: 'replace' });
});
