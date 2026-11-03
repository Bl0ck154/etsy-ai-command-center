import { expect, test } from '@playwright/test';
import { createAgentMemoryRepository, userAgentMemoryKey } from '../api/agent/memory-repository.js';

function createMemoryKv(initial = new Map()) {
  const values = initial;
  const calls = [];
  const callKv = async (command, ...args) => {
    calls.push([command, ...args]);
    if (command === 'GET') return values.get(decodeURIComponent(args[0])) ?? null;
    if (command === 'EVAL') {
      const key = decodeURIComponent(args[2]);
      const expected = decodeURIComponent(args[3]);
      const replacement = decodeURIComponent(args[4]);
      const current = values.get(key);
      const missing = expected === '__revisioned_json_missing__';
      if (missing ? current !== undefined : current !== expected) return 0;
      values.set(key, replacement);
      return 1;
    }
    throw new Error(`Unexpected fake KV command: ${command}`);
  };
  return { callKv, values, calls };
}

function deterministicRepository(kv) {
  let sequence = 0;
  return createAgentMemoryRepository({
    callKv: kv.callKv,
    shopId: 'shop-test',
    now: () => 1_000,
    random: () => 0.1 + (++sequence / 10_000),
  });
}

function decoded(values, key) {
  const raw = values.get(key);
  return raw == null ? null : JSON.parse(decodeURIComponent(raw));
}

test('public memory key keeps the previous unprefixed contract', () => {
  expect(userAgentMemoryKey('owner one@example.com'))
    .toBe('user:owner_one_example.com:agent_memory');
});

test('legacy per-user array migrates into a separate versioned state key', async () => {
  const legacyKey = 'shop-test:user:owner:agent_memory';
  const stateKey = `${legacyKey}:state`;
  const legacy = [{ id: 'old', text: 'Keep titles concise', category: 'preference', createdAt: 10 }];
  const kv = createMemoryKv(new Map([[legacyKey, encodeURIComponent(JSON.stringify(legacy))]]));
  const repository = deterministicRepository(kv);

  await expect(repository.load('owner')).resolves.toEqual(legacy);
  expect(decoded(kv.values, stateKey)).toEqual({
    schema_version: 1,
    record_type: 'agent_memory_store',
    revision: 1,
    state: { items: legacy },
  });
  expect(decoded(kv.values, legacyKey)).toEqual(legacy);
});

test('an explicit empty per-user array wins over a non-empty global fallback', async () => {
  const legacyKey = 'shop-test:user:owner:agent_memory';
  const global = [{ id: 'global', text: 'Global fallback', category: 'fact', createdAt: 9 }];
  const kv = createMemoryKv(new Map([
    [legacyKey, encodeURIComponent(JSON.stringify([]))],
    ['shop-test:agent_memory', encodeURIComponent(JSON.stringify(global))],
  ]));
  const repository = deterministicRepository(kv);

  await expect(repository.load('owner')).resolves.toEqual([]);
  expect(decoded(kv.values, `${legacyKey}:state`)).toEqual({
    schema_version: 1,
    record_type: 'agent_memory_store',
    revision: 1,
    state: { items: [] },
  });
});

test('missing per-user memory preserves the old shop-global fallback', async () => {
  const legacy = [{ id: 'global', text: 'Use short replies', category: 'rule', createdAt: 11 }];
  const kv = createMemoryKv(new Map([
    ['shop-test:agent_memory', encodeURIComponent(JSON.stringify(legacy))],
  ]));
  const repository = deterministicRepository(kv);

  await expect(repository.load('owner')).resolves.toEqual(legacy);
  expect(decoded(kv.values, 'shop-test:user:owner:agent_memory:state')).toMatchObject({
    schema_version: 1,
    record_type: 'agent_memory_store',
    state: { items: legacy },
  });
});

test('concurrent distinct appends preserve both changes after CAS retry', async () => {
  const kv = createMemoryKv();
  const first = deterministicRepository(kv);
  const second = deterministicRepository(kv);

  const [a, b] = await Promise.all([
    first.append('owner', { text: 'Preference A', category: 'preference' }),
    second.append('owner', { text: 'Preference B', category: 'preference' }),
  ]);

  expect(a.duplicate).toBe(false);
  expect(b.duplicate).toBe(false);
  const items = await first.load('owner');
  expect(items.map(item => item.text).sort()).toEqual(['Preference A', 'Preference B']);
  expect(kv.calls.filter(([command]) => command === 'EVAL').length).toBeGreaterThanOrEqual(2);
});

test('concurrent case-insensitive duplicates converge on one memory item', async () => {
  const kv = createMemoryKv();
  const first = deterministicRepository(kv);
  const second = deterministicRepository(kv);
  const results = await Promise.all([
    first.append('owner', { text: 'Use concise captions', category: 'rule' }),
    second.append('owner', { text: 'use concise captions', category: 'rule' }),
  ]);

  const items = await first.load('owner');
  expect(items).toHaveLength(1);
  expect(results.filter(result => result.duplicate)).toHaveLength(1);
  expect(results[0].memory.id).toBe(results[1].memory.id);
});

test('delete is transactional and preserves unrelated memory', async () => {
  const kv = createMemoryKv();
  const repository = deterministicRepository(kv);
  await repository.save('owner', [
    { id: 'remove', text: 'Remove me', category: 'fact', createdAt: 1 },
    { id: 'keep', text: 'Keep me', category: 'context', createdAt: 2 },
  ]);

  const result = await repository.remove('owner', 'remove');
  expect(result.deleted).toBe(true);
  expect(result.items).toEqual([
    { id: 'keep', text: 'Keep me', category: 'context', createdAt: 2 },
  ]);
});