import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import {
  createEtsyReviewResponseRepository,
  ETSY_REVIEW_RESPONSE_RECORD_TYPE,
  ETSY_REVIEW_RESPONSE_SCHEMA_VERSION,
} from '../api/modules/etsy/index.js';

function encode(value) {
  return encodeURIComponent(JSON.stringify(value));
}

function createRedisFixture(initialRaw = null, { synchronizeFirstCommits = false } = {}) {
  const values = new Map();
  const key = 'fixture-shop:reviews:responded';
  if (initialRaw !== null) values.set(key, initialRaw);
  const calls = [];
  let commitArrivals = 0;
  let releaseCommits;
  const commitGate = new Promise(resolve => { releaseCommits = resolve; });

  const callKv = async (command, ...encodedArgs) => {
    calls.push([command, ...encodedArgs]);
    const args = encodedArgs.map(argument => decodeURIComponent(String(argument)));
    if (command === 'GET') return values.get(args[0]) ?? null;
    if (command !== 'EVAL') throw new Error(`Unsupported command: ${command}`);

    if (synchronizeFirstCommits && commitArrivals < 2) {
      commitArrivals += 1;
      if (commitArrivals === 2) releaseCommits();
      await commitGate;
    }
    const redisKey = args[2];
    const expected = args[3];
    const next = args[4];
    const current = values.get(redisKey);
    const matches = expected === '__etsy_review_response_missing__'
      ? current === undefined
      : current === expected;
    if (!matches) return 0;
    values.set(redisKey, next);
    return 1;
  };

  return { callKv, calls, key, values };
}

function storedEnvelope(fixture) {
  return JSON.parse(decodeURIComponent(fixture.values.get(fixture.key)));
}

test('review-response repository migrates the legacy array without changing public IDs', async () => {
  const fixture = createRedisFixture(encode([101, '102', 101]));
  const repository = createEtsyReviewResponseRepository({
    callKv: fixture.callKv,
    shopId: 'fixture-shop',
  });

  await expect(repository.read()).resolves.toEqual([101, '102', 101]);
  expect(storedEnvelope(fixture)).toEqual({
    schema_version: ETSY_REVIEW_RESPONSE_SCHEMA_VERSION,
    record_type: ETSY_REVIEW_RESPONSE_RECORD_TYPE,
    responded_transaction_ids: [101, '102', 101],
  });
  expect(fixture.calls.map(call => call[0])).toEqual(['GET', 'EVAL']);
  expect(fixture.calls[0][1]).toBe(encodeURIComponent(fixture.key));
  expect(fixture.calls[1][1]).toContain('%0A');
  expect(fixture.calls[1][3]).toBe(encodeURIComponent(fixture.key));
  expect(fixture.calls[1][4]).toBe(encodeURIComponent(encode([101, '102', 101])));
  expect(fixture.calls[1][5]).toMatch(/^%257B/);
  expect(fixture.calls[1].slice(1)).toEqual(
    fixture.calls[1].slice(1).map(argument => encodeURIComponent(decodeURIComponent(argument))),
  );
});

test('review-response repository preserves mark and unmark idempotency', async () => {
  const fixture = createRedisFixture();
  const repository = createEtsyReviewResponseRepository({ callKv: fixture.callKv, shopId: 'fixture-shop' });

  const first = await repository.markResponded('tx-1');
  const duplicate = await repository.markResponded('tx-1');
  const missing = await repository.unmarkResponded('not-present');
  const removed = await repository.unmarkResponded('tx-1');

  expect(first.changed).toBe(true);
  expect(duplicate.changed).toBe(false);
  expect(missing.changed).toBe(false);
  expect(removed.changed).toBe(true);
  await expect(repository.read()).resolves.toEqual([]);
});

test('concurrent review-response marks retry CAS and never lose either ID', async () => {
  const fixture = createRedisFixture(null, { synchronizeFirstCommits: true });
  const first = createEtsyReviewResponseRepository({ callKv: fixture.callKv, shopId: 'fixture-shop' });
  const second = createEtsyReviewResponseRepository({ callKv: fixture.callKv, shopId: 'fixture-shop' });

  await Promise.all([
    first.markResponded('concurrent-a'),
    second.markResponded('concurrent-b'),
  ]);

  expect(new Set(storedEnvelope(fixture).responded_transaction_ids))
    .toEqual(new Set(['concurrent-a', 'concurrent-b']));
  expect(fixture.calls.filter(call => call[0] === 'EVAL')).toHaveLength(3);
});

test('concurrent mark and unmark operations preserve both accepted mutations', async () => {
  const fixture = createRedisFixture(encode({
    schema_version: ETSY_REVIEW_RESPONSE_SCHEMA_VERSION,
    record_type: ETSY_REVIEW_RESPONSE_RECORD_TYPE,
    responded_transaction_ids: ['remove-me', 'keep-me'],
  }), { synchronizeFirstCommits: true });
  const first = createEtsyReviewResponseRepository({ callKv: fixture.callKv, shopId: 'fixture-shop' });
  const second = createEtsyReviewResponseRepository({ callKv: fixture.callKv, shopId: 'fixture-shop' });

  await Promise.all([
    first.unmarkResponded('remove-me'),
    second.markResponded('add-me'),
  ]);

  expect(new Set(storedEnvelope(fixture).responded_transaction_ids))
    .toEqual(new Set(['keep-me', 'add-me']));
});

test('review-response repository rejects unsupported schemas and bounded CAS starvation', async () => {
  const unsupported = createRedisFixture(encode({
    schema_version: 2,
    record_type: ETSY_REVIEW_RESPONSE_RECORD_TYPE,
    responded_transaction_ids: [],
  }));
  const unsupportedRepository = createEtsyReviewResponseRepository({
    callKv: unsupported.callKv,
    shopId: 'fixture-shop',
  });
  await expect(unsupportedRepository.read()).rejects.toMatchObject({
    code: 'REVIEW_RESPONSE_STORE_UNSUPPORTED',
  });

  const starvedRepository = createEtsyReviewResponseRepository({
    shopId: 'fixture-shop',
    maxAttempts: 2,
    callKv: async command => (command === 'GET' ? null : 0),
  });
  await expect(starvedRepository.markResponded('never-committed')).rejects.toMatchObject({
    code: 'REVIEW_RESPONSE_CONCURRENT_UPDATE',
  });
});

test('review-response read rejects an empty Redis string before EVAL', async () => {
  const fixture = createRedisFixture('');
  const repository = createEtsyReviewResponseRepository({
    callKv: fixture.callKv,
    shopId: 'fixture-shop',
  });

  await expect(repository.read()).rejects.toMatchObject({
    code: 'REVIEW_RESPONSE_STORE_INVALID',
  });
  expect(fixture.calls.map(call => call[0])).toEqual(['GET']);
});

test('review-response mark rejects an empty Redis string without forming an EVAL request', async () => {
  const fixture = createRedisFixture('');
  const repository = createEtsyReviewResponseRepository({
    callKv: fixture.callKv,
    shopId: 'fixture-shop',
  });

  await expect(repository.markResponded('must-not-commit')).rejects.toMatchObject({
    code: 'REVIEW_RESPONSE_STORE_INVALID',
  });
  expect(fixture.calls.map(call => call[0])).toEqual(['GET']);
  expect(fixture.values.get(fixture.key)).toBe('');
});

test('KV HTTP facade delegates review tracking while preserving response payloads', async () => {
  const originalFetch = global.fetch;
  const originalEnv = Object.fromEntries([
    'SITE_PASSWORD',
    'SESSION_SECRET',
    'AUTH_USERS_B64',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'ETSY_SHOP_ID',
  ].map(key => [key, process.env[key]]));
  const values = new Map();
  process.env.SITE_PASSWORD = 'review-test-password';
  process.env.SESSION_SECRET = 'review-test-session-secret';
  delete process.env.AUTH_USERS_B64;
  process.env.KV_REST_API_URL = 'https://review-kv.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  // Keep the process-wide default because api/kv.js also composes other cached
  // repositories; the facade contract must not retarget unrelated test modules.
  process.env.ETSY_SHOP_ID = 'default';

  global.fetch = async url => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    if (command === 'GET') {
      return new Response(JSON.stringify({ result: values.get(parts[1]) ?? null }), { status: 200 });
    }
    if (command === 'EVAL') {
      const key = parts[3];
      const expected = parts[4];
      const current = values.get(key);
      const matches = expected === '__etsy_review_response_missing__'
        ? current === undefined
        : current === expected;
      if (matches) values.set(key, parts[5]);
      return new Response(JSON.stringify({ result: matches ? 1 : 0 }), { status: 200 });
    }
    throw new Error(`Unexpected KV request: ${url}`);
  };

  try {
    const [{ setSessionCookie }, { default: handler }] = await Promise.all([
      import('../api/_auth.js'),
      import(`../api/kv.js?review-response-facade=${Date.now()}`),
    ]);
    let cookie = '';
    setSessionCookie({ setHeader: (_name, value) => { cookie = String(value).split(';')[0]; } });
    const call = async (action, value) => {
      const captured = { status: 200, payload: null };
      const res = {
        status(code) { captured.status = code; return this; },
        json(payload) { captured.payload = payload; return payload; },
        end() { return undefined; },
      };
      await handler({ method: 'POST', headers: { cookie }, body: { action, value } }, res);
      return captured;
    };

    await expect(call('markReviewResponded', { transaction_id: 'route-id' }))
      .resolves.toMatchObject({ status: 200, payload: { success: true } });
    await expect(call('getRespondedReviews'))
      .resolves.toMatchObject({ status: 200, payload: { success: true, data: ['route-id'] } });
    await expect(call('unmarkReviewResponded', { transaction_id: 'route-id' }))
      .resolves.toMatchObject({ status: 200, payload: { success: true } });
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('review-response production and facade boundaries remain focused', async () => {
  const [repositorySource, indexSource, facadeSource] = await Promise.all([
    readFile(new URL('../api/modules/etsy/infrastructure/review-response-repository.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/modules/etsy/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/kv.js', import.meta.url), 'utf8'),
  ]);
  const reviewCases = facadeSource.slice(
    facadeSource.indexOf("case 'getRespondedReviews':"),
    facadeSource.indexOf("case 'setGeminiKeys':"),
  );
  expect(Buffer.byteLength(repositorySource)).toBeLessThan(50 * 1024);
  expect(repositorySource).not.toMatch(/express|req\.|res\.|fetch\(/i);
  expect(indexSource).toContain('createEtsyReviewResponseRepository');
  expect(reviewCases).toContain('etsyReviewResponseRepository.read()');
  expect(reviewCases).toContain('etsyReviewResponseRepository.markResponded(value.transaction_id)');
  expect(reviewCases).toContain('etsyReviewResponseRepository.unmarkResponded(value.transaction_id)');
  expect(reviewCases).not.toMatch(/kvGet\('reviews:responded'\)|kvSet\('reviews:responded'/);
});
