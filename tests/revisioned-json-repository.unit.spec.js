import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import {
  createRevisionedJsonRepository,
} from '../api/platform/persistence/revisioned-json-repository.js';

function createMemoryKv(initial = new Map()) {
  const values = initial;
  const calls = [];
  const callKv = async (command, ...args) => {
    calls.push([command, ...args]);
    if (command === 'GET') {
      return values.get(decodeURIComponent(args[0])) ?? null;
    }
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

function repository(kv, overrides = {}) {
  return createRevisionedJsonRepository({
    callKv: kv.callKv,
    key: 'shop:example-state',
    recordType: 'example_state_store',
    ...overrides,
  });
}

function decodedStoredValue(kv) {
  return JSON.parse(decodeURIComponent(kv.values.get('shop:example-state')));
}

test('legacy plain-object state migrates to a versioned envelope without wrapper leakage', async () => {
  const kv = createMemoryKv(new Map([
    ['shop:example-state', encodeURIComponent(JSON.stringify({ alpha: 1 }))],
  ]));
  const store = repository(kv);

  const snapshot = await store.readSnapshot();

  expect(snapshot).toEqual({
    state: { alpha: 1 },
    revision: 1,
    changed: false,
    migrated: true,
  });
  expect(decodedStoredValue(kv)).toEqual({
    schema_version: 1,
    record_type: 'example_state_store',
    revision: 1,
    state: { alpha: 1 },
  });
  await expect(store.read()).resolves.toEqual({ alpha: 1 });
});

test('current versioned state is read without an unnecessary write', async () => {
  const kv = createMemoryKv(new Map([
    ['shop:example-state', encodeURIComponent(JSON.stringify({
      schema_version: 1,
      record_type: 'example_state_store',
      revision: 4,
      state: { value: 'current' },
    }))],
  ]));
  const store = repository(kv);

  const snapshot = await store.readSnapshot();

  expect(snapshot).toEqual({
    state: { value: 'current' },
    revision: 4,
    changed: false,
    migrated: false,
  });
  expect(kv.calls.filter(([command]) => command === 'EVAL')).toHaveLength(0);
});

test('concurrent transactional writers retry CAS and preserve both independent mutations', async () => {
  const kv = createMemoryKv();
  const first = repository(kv);
  const second = repository(kv);
  let initialMutators = 0;
  let releaseInitial;
  const initialBarrier = new Promise(resolve => { releaseInitial = resolve; });

  const mutate = (field, value) => async (state, metadata) => {
    if (metadata.revision === 0) {
      initialMutators += 1;
      if (initialMutators === 2) releaseInitial();
      await initialBarrier;
    }
    return { ...state, [field]: value };
  };

  const [firstResult, secondResult] = await Promise.all([
    first.update(mutate('alpha', 1)),
    second.update(mutate('beta', 2)),
  ]);

  expect([firstResult.revision, secondResult.revision].sort()).toEqual([1, 2]);
  expect(await first.read()).toEqual({ alpha: 1, beta: 2 });
  expect(decodedStoredValue(kv)).toMatchObject({
    schema_version: 1,
    record_type: 'example_state_store',
    revision: 2,
    state: { alpha: 1, beta: 2 },
  });
  expect(kv.calls.filter(([command]) => command === 'EVAL').length).toBeGreaterThanOrEqual(3);
});

test('compare-and-replace rejects a stale revision instead of silently overwriting newer state', async () => {
  const kv = createMemoryKv();
  const store = repository(kv);
  const original = await store.readSnapshot();
  expect(original.revision).toBe(0);

  await store.update(state => ({ ...state, winner: true }));

  await expect(store.compareAndReplace(original.revision, { stale: true }))
    .rejects.toMatchObject({ code: 'REVISIONED_JSON_REVISION_CONFLICT' });
  await expect(store.read()).resolves.toEqual({ winner: true });
});

test('unsupported or malformed persisted schemas fail closed', async () => {
  const wrongVersion = createMemoryKv(new Map([
    ['shop:example-state', encodeURIComponent(JSON.stringify({
      schema_version: 99,
      record_type: 'example_state_store',
      revision: 1,
      state: {},
    }))],
  ]));
  await expect(repository(wrongVersion).read())
    .rejects.toMatchObject({ code: 'REVISIONED_JSON_UNSUPPORTED' });

  const malformed = createMemoryKv(new Map([
    ['shop:example-state', '%not-json'],
  ]));
  await expect(repository(malformed).read())
    .rejects.toMatchObject({ code: 'REVISIONED_JSON_INVALID' });
});

test('state validation is injectable and blocks invalid mutations before persistence', async () => {
  const kv = createMemoryKv();
  const store = repository(kv, {
    validateState: value => Boolean(value && typeof value === 'object' && Number.isInteger(value.count)),
  });

  await expect(store.update(() => ({ count: 1 }))).resolves.toMatchObject({
    state: { count: 1 },
    revision: 1,
  });
  await expect(store.update(() => ({ nope: true })))
    .rejects.toMatchObject({ code: 'REVISIONED_JSON_MUTATION_INVALID' });
  await expect(store.read()).resolves.toEqual({ count: 1 });
});

test('generic persistence repository has no HTTP, provider, Etsy or business-policy dependency', () => {
  const source = readFileSync(
    new URL('../api/platform/persistence/revisioned-json-repository.js', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(/fetch\s*\(|express|etsy|oauth|token|refresh|publisher|queue/i);
});
