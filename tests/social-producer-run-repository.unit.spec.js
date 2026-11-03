import { spawn } from 'node:child_process';
import http from 'node:http';

import { expect, test } from '@playwright/test';

import {
  createSocialProducerRunRepository,
  getSocialOwnerReviewProducerStatus,
  socialOwnerReviewProducerPersistence,
  SOCIAL_PRODUCER_STATUS_RECORD_TYPE,
  SOCIAL_PRODUCER_STATUS_SCHEMA_VERSION,
} from '../api/modules/social/index.js';

function decode(argument) {
  return decodeURIComponent(String(argument));
}

function createRedisEmulator() {
  const records = new Map();

  const get = key => {
    const record = records.get(key);
    if (!record) return null;
    if (record.expiresAt && record.expiresAt <= Date.now()) {
      records.delete(key);
      return null;
    }
    return record.value;
  };

  const set = (key, value, ttlSeconds = 0) => {
    records.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
    });
  };

  const execute = async (command, ...args) => {
    if (command === 'GET') return get(decode(args[0]));
    if (command !== 'EVAL') throw new Error(`Unsupported test Redis command: ${command}`);

    const script = decode(args[0]);
    const keyCount = Number(args[1]);
    const keys = args.slice(2, 2 + keyCount).map(decode);
    const argv = args.slice(2 + keyCount).map(decode);

    if (script.includes('social-producer-acquire-v1')) {
      if (get(keys[0])) return 0;
      set(keys[0], argv[0], Number(argv[1]));
      set(keys[1], argv[2]);
      return 1;
    }
    if (script.includes('social-producer-renew-v1')) {
      if (get(keys[0]) !== argv[0]) return 0;
      set(keys[0], argv[0], Number(argv[1]));
      return 1;
    }
    if (script.includes('social-producer-assert-owned-v1')) {
      if (get(keys[0]) !== argv[0]) return 0;
      set(keys[0], argv[0], Number(argv[1]));
      return 1;
    }
    if (script.includes('social-producer-release-v1')) {
      if (get(keys[0]) !== argv[0]) return 0;
      records.delete(keys[0]);
      return 1;
    }
    if (script.includes('social-producer-write-status-v1')) {
      if (get(keys[0]) !== argv[0]) return 0;
      const currentEnvelope = JSON.parse(get(keys[1]));
      const currentStatus = currentEnvelope.status || {};
      if (Number(argv[2]) <= Number(currentStatus.sequence || 0)) return -1;
      if (['completed', 'failed', 'aborted', 'stale'].includes(currentStatus.status)) return -1;
      set(keys[1], argv[1]);
      return 1;
    }
    if (script.includes('social-producer-mark-stale-v1')) {
      if (get(keys[0]) || get(keys[1]) !== argv[0]) return 0;
      set(keys[1], argv[1]);
      return 1;
    }
    throw new Error('Unsupported test Redis script');
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const [command, ...args] = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await execute(command, ...args);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ result }));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      }
    });
  });

  return {
    execute,
    records,
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function leaseInput(runId, { ttlSeconds = 2, runBudgetMs = 100 } = {}) {
  const startedAt = new Date();
  return {
    run_id: runId,
    started_at: startedAt.toISOString(),
    deadline_at: new Date(startedAt.getTime() + runBudgetMs).toISOString(),
    ttl_seconds: ttlSeconds,
  };
}

const repositoryUrl = new URL(
  '../api/modules/social/infrastructure/producer-run-repository.js',
  import.meta.url,
).href;

const childSource = `
const [endpoint, repositoryUrl, runId, holdMs] = process.argv.slice(1);
const { createSocialProducerRunRepository } = await import(repositoryUrl);
const callKv = async (command, ...args) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([command, ...args]),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'test Redis request failed');
  return payload.result;
};
const repository = createSocialProducerRunRepository({ callKv, shopId: 'process-test' });
const startedAt = new Date();
const lease = await repository.lease.acquire({
  run_id: runId,
  started_at: startedAt.toISOString(),
  deadline_at: new Date(startedAt.getTime() + 100).toISOString(),
  ttl_seconds: 1,
});
process.stdout.write(JSON.stringify({ acquired: lease.acquired, token: lease.token || null }) + '\\n');
if (lease.acquired && Number(holdMs) > 0) {
  await new Promise(resolve => setTimeout(resolve, Number(holdMs)));
}
`;

function spawnContender(endpoint, runId, holdMs = 0) {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    childSource,
    endpoint,
    repositoryUrl,
    runId,
    String(holdMs),
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const firstResult = new Promise((resolve, reject) => {
    const inspect = () => {
      const line = stdout.split(/\r?\n/).find(Boolean);
      if (line) resolve(JSON.parse(line));
    };
    child.stdout.on('data', inspect);
    child.once('error', reject);
    child.once('exit', code => {
      inspect();
      if (!stdout.trim()) reject(new Error(`producer contender exited ${code}: ${stderr}`));
    });
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`producer contender exited ${code}: ${stderr}`));
    });
  });
  return { child, firstResult, exited };
}

test('producer repository persists a versioned truthful status and rejects a stale fence', async () => {
  const redis = createRedisEmulator();
  const repository = createSocialProducerRunRepository({
    callKv: redis.execute,
    shopId: 'schema-test',
    createToken: () => 'unique-fence-one',
  });
  const lease = await repository.lease.acquire(leaseInput('run-one'));

  expect(lease).toMatchObject({ acquired: true, token: 'unique-fence-one', run_id: 'run-one' });
  expect(await repository.status.read()).toMatchObject({
    component: 'social-owner-review-producer',
    run_id: 'run-one',
    stage: 'lease-acquired',
    status: 'acquired',
    published: false,
    sequence: 0,
  });

  const completed = {
    component: 'social-owner-review-producer',
    run_id: 'run-one',
    started_at: leaseInput('unused').started_at,
    deadline_at: leaseInput('unused').deadline_at,
    updated_at: new Date().toISOString(),
    stage: 'completed',
    status: 'completed',
    created_count: 1,
    blocked_count: 0,
    published: false,
  };
  const staleLease = { ...lease, fence_value: encodeURIComponent('different-owner') };
  await expect(repository.status.write(completed, staleLease)).rejects.toMatchObject({
    code: 'SOCIAL_PRODUCER_LEASE_LOST',
  });

  const rawStatus = redis.records.get(repository.keys.status).value;
  const envelope = JSON.parse(decodeURIComponent(rawStatus));
  expect(envelope).toMatchObject({
    schema_version: SOCIAL_PRODUCER_STATUS_SCHEMA_VERSION,
    record_type: SOCIAL_PRODUCER_STATUS_RECORD_TYPE,
  });
  await repository.lease.release(lease);
});

test('producer persistence is exposed only through the plain-data Social module interface', () => {
  expect(typeof socialOwnerReviewProducerPersistence).toBe('function');
  expect(typeof getSocialOwnerReviewProducerStatus).toBe('function');
  expect(socialOwnerReviewProducerPersistence()).toMatchObject({
    lease: {
      acquire: expect.any(Function),
      renew: expect.any(Function),
      assertOwned: expect.any(Function),
      release: expect.any(Function),
    },
    status: {
      read: expect.any(Function),
      write: expect.any(Function),
    },
  });
});

test('producer lease TTL must outlive its declared run budget', async () => {
  const redis = createRedisEmulator();
  const repository = createSocialProducerRunRepository({ callKv: redis.execute });
  await expect(repository.lease.acquire(leaseInput('too-short', {
    ttlSeconds: 1,
    runBudgetMs: 1_000,
  }))).rejects.toMatchObject({ code: 'SOCIAL_PRODUCER_LEASE_TTL_INVALID' });
});

test('producer status sequence cannot overwrite a terminal status with a delayed running write', async () => {
  const redis = createRedisEmulator();
  const repository = createSocialProducerRunRepository({ callKv: redis.execute, shopId: 'terminal-order' });
  const lease = await repository.lease.acquire(leaseInput('terminal-order'));
  const base = {
    component: 'social-owner-review-producer',
    run_id: 'terminal-order',
    started_at: leaseInput('unused').started_at,
    deadline_at: leaseInput('unused').deadline_at,
    updated_at: new Date().toISOString(),
    created_count: 0,
    blocked_count: 0,
    published: false,
  };

  await repository.status.write({
    ...base,
    stage: 'completed',
    status: 'completed',
    finished_at: new Date().toISOString(),
    sequence: 2,
  }, lease);
  await expect(repository.status.write({
    ...base,
    stage: 'save-owner-review',
    status: 'running',
    sequence: 1,
  }, lease)).rejects.toMatchObject({ code: 'SOCIAL_PRODUCER_STATUS_TRANSITION_REJECTED' });
  expect(await repository.status.read()).toMatchObject({ status: 'completed', sequence: 2 });
  await repository.lease.release(lease);
});

test('producer repository fails closed on an unsupported persisted status schema', async () => {
  const redis = createRedisEmulator();
  const repository = createSocialProducerRunRepository({ callKv: redis.execute, shopId: 'unsupported' });
  redis.records.set(repository.keys.status, {
    value: encodeURIComponent(JSON.stringify({
      schema_version: 2,
      record_type: SOCIAL_PRODUCER_STATUS_RECORD_TYPE,
      status: {},
    })),
    expiresAt: 0,
  });

  await expect(repository.status.read()).rejects.toMatchObject({
    code: 'SOCIAL_PRODUCER_STATUS_SCHEMA_UNSUPPORTED',
  });
});

test('producer acquire and release commands fail within the configured bound', async () => {
  const never = () => new Promise(() => {});
  const unavailable = createSocialProducerRunRepository({
    callKv: never,
    shopId: 'bounded-acquire',
    commandTimeoutMs: 20,
  });
  await expect(unavailable.lease.acquire(leaseInput('bounded-acquire'))).rejects.toMatchObject({
    code: 'SOCIAL_PRODUCER_PERSISTENCE_TIMEOUT',
  });

  const redis = createRedisEmulator();
  let hangRelease = false;
  const boundedRelease = createSocialProducerRunRepository({
    callKv: (...args) => (hangRelease ? never() : redis.execute(...args)),
    shopId: 'bounded-release',
    commandTimeoutMs: 20,
  });
  const lease = await boundedRelease.lease.acquire(leaseInput('bounded-release'));
  hangRelease = true;
  await expect(boundedRelease.lease.release(lease)).rejects.toMatchObject({
    code: 'SOCIAL_PRODUCER_PERSISTENCE_TIMEOUT',
  });
});

test('exactly one independent process acquires the producer lease', async () => {
  const redis = createRedisEmulator();
  const endpoint = await redis.listen();
  try {
    const contenders = Array.from({ length: 8 }, (_, index) => (
      spawnContender(endpoint, `contender-${index}`)
    ));
    const results = await Promise.all(contenders.map(contender => contender.firstResult));
    await Promise.all(contenders.map(contender => contender.exited));

    expect(results.filter(result => result.acquired)).toHaveLength(1);
    expect(new Set(results.filter(result => result.acquired).map(result => result.token)).size).toBe(1);
  } finally {
    await redis.close();
  }
});

test('live owner renews past the original TTL, then crash expiry is persisted and reclaimed', async () => {
  const redis = createRedisEmulator();
  const endpoint = await redis.listen();
  const holder = spawnContender(endpoint, 'long-live-owner', 1_600);
  try {
    expect(await holder.firstResult).toMatchObject({ acquired: true });
    await new Promise(resolve => setTimeout(resolve, 1_150));

    const competitor = createSocialProducerRunRepository({
      callKv: redis.execute,
      shopId: 'process-test',
    });
    expect(await competitor.lease.acquire(leaseInput('blocked-while-live', {
      ttlSeconds: 1,
      runBudgetMs: 100,
    }))).toEqual({ acquired: false });

    await holder.exited;
    await new Promise(resolve => setTimeout(resolve, 1_150));
    expect(await competitor.status.read()).toMatchObject({
      run_id: 'long-live-owner',
      stage: 'lease-expired',
      status: 'stale',
      error: { code: 'SOCIAL_PRODUCER_LEASE_EXPIRED' },
    });

    const reclaimed = await competitor.lease.acquire(leaseInput('reclaimed-owner', {
      ttlSeconds: 1,
      runBudgetMs: 100,
    }));
    expect(reclaimed).toMatchObject({ acquired: true, run_id: 'reclaimed-owner' });
    await competitor.lease.release(reclaimed);
  } finally {
    if (holder.child.exitCode === null) holder.child.kill();
    await redis.close();
  }
});

test('expired owner cannot pass the business-side-effect fence after another process reclaims the lease', async () => {
  const redis = createRedisEmulator();
  const endpoint = await redis.listen();
  const owner = createSocialProducerRunRepository({
    callKv: redis.execute,
    shopId: 'process-test',
    createToken: () => 'expired-owner-fence',
  });
  const lease = await owner.lease.acquire(leaseInput('expired-owner', {
    ttlSeconds: 1,
    runBudgetMs: 100,
  }));
  if (lease.heartbeat) clearInterval(lease.heartbeat);
  lease.heartbeat = null;

  try {
    await new Promise(resolve => setTimeout(resolve, 1_150));
    const replacement = spawnContender(endpoint, 'replacement-owner');
    expect(await replacement.firstResult).toMatchObject({ acquired: true });
    await replacement.exited;

    await expect(owner.lease.assertOwned(lease)).rejects.toMatchObject({
      code: 'SOCIAL_PRODUCER_LEASE_LOST',
    });
  } finally {
    await redis.close();
  }
});
