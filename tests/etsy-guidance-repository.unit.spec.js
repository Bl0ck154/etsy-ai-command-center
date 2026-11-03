import { test, expect } from '@playwright/test';

import { createEtsyGuidanceRepository } from '../api/etsy-guidance/guidance-repository.js';

function encodedJson(value) {
  return encodeURIComponent(JSON.stringify(value));
}

function decodedJson(raw) {
  return JSON.parse(decodeURIComponent(raw));
}

function createRedisFake(initial = {}) {
  const store = new Map(Object.entries(initial));
  let evalCalls = 0;

  async function callKv(command, ...encodedArgs) {
    const args = encodedArgs.map(value => decodeURIComponent(String(value)));
    if (command === 'GET') return store.get(args[0]) ?? null;
    if (command === 'SET') {
      store.set(args[0], args[1]);
      return 'OK';
    }
    if (command === 'EVAL') {
      evalCalls += 1;
      const [, , aggregateKey, activeKey, candidateKey, monitorKey, historyKey,
        expected, aggregateNext, activeNext, candidateNext, monitorNext, historyNext] = args;
      const current = store.get(aggregateKey);
      const missingExpected = expected === '__etsy_guidance_missing__';
      if ((missingExpected && current !== undefined)
        || (!missingExpected && current !== expected)) return 0;
      store.set(aggregateKey, aggregateNext);
      store.set(activeKey, activeNext);
      store.set(candidateKey, candidateNext);
      store.set(monitorKey, monitorNext);
      store.set(historyKey, historyNext);
      return 1;
    }
    throw new Error(`Unsupported Redis command ${command}`);
  }

  return { store, callKv, evalCalls: () => evalCalls };
}

test('first read migrates all four legacy guidance keys into one revisioned state', async () => {
  const redis = createRedisFake({
    'shop-1:etsy_guidance:active': encodedJson({ id: 'active-1', status: 'active' }),
    'shop-1:etsy_guidance:candidate': encodedJson({ id: 'candidate-1', status: 'candidate' }),
    'shop-1:etsy_guidance:monitor': encodedJson({ lastCheckedAt: '2026-08-14T00:00:00Z' }),
    'shop-1:etsy_guidance:history': encodedJson([{ id: 'old-1' }]),
  });
  const repository = createEtsyGuidanceRepository({ callKv: redis.callKv, shopId: 'shop-1' });

  const snapshot = await repository.readSnapshot();
  expect(snapshot).toMatchObject({ revision: 1, migrated: true, changed: false });
  expect(snapshot.state).toEqual({
    active: { id: 'active-1', status: 'active' },
    candidate: { id: 'candidate-1', status: 'candidate' },
    monitor: { lastCheckedAt: '2026-08-14T00:00:00Z' },
    history: [{ id: 'old-1' }],
  });
  expect(redis.store.has('shop-1:etsy_guidance:state')).toBe(true);
  expect(redis.evalCalls()).toBe(1);
});

test('empty legacy store initializes one canonical empty aggregate state and legacy mirrors', async () => {
  const redis = createRedisFake();
  const repository = createEtsyGuidanceRepository({ callKv: redis.callKv, shopId: 'shop-1' });
  const state = await repository.read();
  expect(state).toEqual({ active: null, candidate: null, monitor: null, history: [] });
  expect(decodedJson(redis.store.get('shop-1:etsy_guidance:active'))).toBeNull();
  expect(decodedJson(redis.store.get('shop-1:etsy_guidance:candidate'))).toBeNull();
  expect(decodedJson(redis.store.get('shop-1:etsy_guidance:monitor'))).toBeNull();
  expect(decodedJson(redis.store.get('shop-1:etsy_guidance:history'))).toEqual([]);
  expect(redis.evalCalls()).toBe(1);
});

test('multi-field approval-style mutation commits aggregate and all mirrors as one CAS revision', async () => {
  const redis = createRedisFake({
    'shop-1:etsy_guidance:active': encodedJson({ id: 'old-active', status: 'active' }),
    'shop-1:etsy_guidance:candidate': encodedJson({ id: 'candidate-1', status: 'candidate' }),
    'shop-1:etsy_guidance:monitor': encodedJson({ candidateId: 'candidate-1' }),
    'shop-1:etsy_guidance:history': encodedJson([]),
  });
  const repository = createEtsyGuidanceRepository({ callKv: redis.callKv, shopId: 'shop-1' });
  await repository.read();
  const before = redis.evalCalls();

  const result = await repository.update(state => ({
    ...state,
    active: { ...state.candidate, status: 'active', activatedAt: 'now' },
    candidate: null,
    history: [{ id: 'candidate-1', status: 'active' }, ...state.history],
  }));

  expect(result.revision).toBe(2);
  expect(redis.evalCalls() - before).toBe(1);
  expect(result.state).toMatchObject({
    active: { id: 'candidate-1', status: 'active' },
    candidate: null,
    monitor: { candidateId: 'candidate-1' },
  });
  expect(result.state.history).toHaveLength(1);
  expect(decodedJson(redis.store.get('shop-1:etsy_guidance:active'))).toMatchObject({
    id: 'candidate-1', status: 'active',
  });
  expect(decodedJson(redis.store.get('shop-1:etsy_guidance:candidate'))).toBeNull();
  expect(decodedJson(redis.store.get('shop-1:etsy_guidance:monitor'))).toEqual({ candidateId: 'candidate-1' });
  expect(decodedJson(redis.store.get('shop-1:etsy_guidance:history'))).toEqual([
    { id: 'candidate-1', status: 'active' },
  ]);
});

test('history is capped to twenty records on canonical writes', async () => {
  const redis = createRedisFake();
  const repository = createEtsyGuidanceRepository({ callKv: redis.callKv, shopId: 'shop-1' });
  const result = await repository.update(state => ({
    ...state,
    history: Array.from({ length: 25 }, (_, index) => ({ id: `h-${index}` })),
  }));
  expect(result.state.history).toHaveLength(20);
  expect(result.state.history.at(-1)).toEqual({ id: 'h-19' });
  expect(decodedJson(redis.store.get('shop-1:etsy_guidance:history'))).toHaveLength(20);
});

test('concurrent first writers retry against the same canonical aggregate key', async () => {
  const redis = createRedisFake({
    'shop-1:etsy_guidance:monitor': encodedJson({ count: 0 }),
  });
  const a = createEtsyGuidanceRepository({ callKv: redis.callKv, shopId: 'shop-1' });
  const b = createEtsyGuidanceRepository({ callKv: redis.callKv, shopId: 'shop-1' });

  await Promise.all([
    a.update(state => ({ ...state, monitor: { ...(state.monitor || {}), a: true } })),
    b.update(state => ({ ...state, monitor: { ...(state.monitor || {}), b: true } })),
  ]);

  const final = await a.readSnapshot();
  expect(final.revision).toBe(2);
  expect(final.state.monitor).toMatchObject({ count: 0, a: true, b: true });
  expect(decodedJson(redis.store.get('shop-1:etsy_guidance:monitor'))).toMatchObject({
    count: 0, a: true, b: true,
  });
  expect(redis.evalCalls()).toBeGreaterThanOrEqual(3);
});
