import { expect, test } from '@playwright/test';
import { createAgentMemoryClient } from '../public/utils/agent-memory-client.js';

const item = (id, text, createdAt = 1) => ({ id, text, category: 'fact', createdAt });

function fakeClient(initial = []) {
  const posts = [];
  const client = createAgentMemoryClient({
    get: async () => initial.map(entry => ({ ...entry })),
    post: async (_url, payload) => {
      posts.push(payload);
      return { success: true };
    },
  });
  return { client, posts };
}

test('normal UI add then delete stays semantic across a client-only snapshot', async () => {
  const a = item('a', 'A');
  const c = item('c', 'C', 3);
  const { client, posts } = fakeClient([a]);

  await client.load();
  await client.replace([c, a]);
  await client.replace([c]);

  expect(posts).toEqual([
    { action: 'appendAgentMemory', value: c },
    { action: 'deleteAgentMemory', value: { id: 'a' } },
  ]);
});

test('client snapshot intentionally tracks what the UI saw rather than a server result', async () => {
  const a = item('a', 'A');
  const c = item('c', 'C', 3);
  const posts = [];
  const client = createAgentMemoryClient({
    get: async () => [a],
    post: async (_url, payload) => {
      posts.push(payload);
      if (payload.action === 'appendAgentMemory') {
        return { items: [c, item('hidden', 'Concurrent server memory', 2), a] };
      }
      return { success: true };
    },
  });

  await client.load();
  await client.replace([c, a]);
  await client.replace([c]);

  expect(posts[1]).toEqual({ action: 'deleteAgentMemory', value: { id: 'a' } });
  expect(posts.some(payload => payload.action === 'setAgentMemory')).toBe(false);
});

test('edits and multi-change replacements keep the legacy full-set fallback', async () => {
  const a = item('a', 'A');
  const b = item('b', 'B', 2);
  const { client, posts } = fakeClient([a, b]);

  await client.load();
  await client.replace([item('a', 'Edited'), b]);

  expect(posts).toEqual([{
    action: 'setAgentMemory',
    value: [item('a', 'Edited'), b],
  }]);
});

test('without a loaded client snapshot replacement remains backward compatible', async () => {
  const a = item('a', 'A');
  const { client, posts } = fakeClient();
  await client.replace([a]);
  expect(posts).toEqual([{ action: 'setAgentMemory', value: [a] }]);
});
