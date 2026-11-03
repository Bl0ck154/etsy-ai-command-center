import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import {
  getScheduledPosts,
  saveScheduledPost,
} from '../api/modules/social/index.js';

function redisListFetch(lists, {
  locks = new Map(),
  onContention = null,
  beforeCommit = null,
} = {}) {
  return async url => {
    const parts = new URL(String(url)).pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    await Promise.resolve();
    if (command === 'SET') {
      if (locks.has(key)) {
        onContention?.({ key, token: parts[2] });
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }
      locks.set(key, parts[2]);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (command === 'EVAL') {
      const keyCount = Number(parts[2]);
      if (keyCount === 3) {
        const lockKey = parts[3];
        const shadowKey = parts[4];
        const targetKey = parts[5];
        const token = parts[6];
        const mode = parts[7];
        beforeCommit?.({ lockKey, shadowKey, targetKey, token, mode, locks, lists });
        if (locks.get(lockKey) !== token) {
          return new Response(JSON.stringify({ result: 0 }), { status: 200 });
        }
        if (mode === 'replace') {
          if (!lists.has(shadowKey)) return new Response(JSON.stringify({ result: -1 }), { status: 200 });
          lists.set(targetKey, [...lists.get(shadowKey)]);
          lists.delete(shadowKey);
        } else {
          lists.delete(targetKey);
        }
        locks.delete(lockKey);
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      }
      const lockKey = parts[3];
      const token = parts[4];
      const owned = locks.get(lockKey) === token;
      if (owned && !decodeURIComponent(parts[1]).includes('EXPIRE')) locks.delete(lockKey);
      return new Response(JSON.stringify({ result: owned ? 1 : 0 }), { status: 200 });
    }
    if (command === 'LRANGE') {
      return new Response(JSON.stringify({ result: [...(lists.get(key) || [])] }), { status: 200 });
    }
    if (command === 'DEL') {
      const existed = lists.delete(key);
      return new Response(JSON.stringify({ result: existed ? 1 : 0 }), { status: 200 });
    }
    if (command === 'LPUSH') {
      const next = [parts[2], ...(lists.get(key) || [])];
      lists.set(key, next);
      return new Response(JSON.stringify({ result: next.length }), { status: 200 });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], [...(lists.get(key) || [])]);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`Unexpected KV command: ${command}`);
  };
}

function encodedQueueValue(value) {
  return encodeURIComponent(JSON.stringify(value));
}

function decodedQueueValue(value) {
  return JSON.parse(decodeURIComponent(value));
}

test.describe('Social queue repository seam', () => {
  const originalFetch = global.fetch;
  const savedEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    SOCIAL_QUEUE_MUTATION_LOCK_WAIT_MS: process.env.SOCIAL_QUEUE_MUTATION_LOCK_WAIT_MS,
    SOCIAL_QUEUE_MUTATION_LOCK_RETRY_MS: process.env.SOCIAL_QUEUE_MUTATION_LOCK_RETRY_MS,
    SOCIAL_QUEUE_MUTATION_LOCK_COMMAND_TIMEOUT_MS: process.env.SOCIAL_QUEUE_MUTATION_LOCK_COMMAND_TIMEOUT_MS,
  };

  test.beforeEach(() => {
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.SOCIAL_QUEUE_MUTATION_LOCK_WAIT_MS = '250';
    process.env.SOCIAL_QUEUE_MUTATION_LOCK_RETRY_MS = '5';
    process.env.SOCIAL_QUEUE_MUTATION_LOCK_COMMAND_TIMEOUT_MS = '100';
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('serializes concurrent callers so distinct records are not lost', async () => {
    const lists = new Map();
    global.fetch = redisListFetch(lists);

    await Promise.all([
      saveScheduledPost({ id: 'queue-a', platform: 'instagram', status: 'draft', caption: 'A' }),
      saveScheduledPost({ id: 'queue-b', platform: 'facebook', status: 'draft', caption: 'B' }),
    ]);

    const records = await getScheduledPosts();
    expect(records.map(record => record.id).sort()).toEqual(['queue-a', 'queue-b']);
    expect(records.every(record => !Object.hasOwn(record, 'schema_version'))).toBe(true);
    expect((lists.get('default:scheduled:posts') || []).map(decodedQueueValue))
      .toEqual(records.map(record => ({
        schema_version: 1,
        record_type: 'social_scheduled_post',
        record,
      })));
  });

  test('reads current schema envelopes without leaking or rewriting them', async () => {
    const queueKey = 'default:scheduled:posts';
    const envelope = {
      schema_version: 1,
      record_type: 'social_scheduled_post',
      record: { id: 'current-a', platform: 'instagram', status: 'draft', caption: 'Current' },
    };
    const encoded = encodedQueueValue(envelope);
    const lists = new Map([[queueKey, [encoded]]]);
    const locks = new Map();
    global.fetch = redisListFetch(lists, { locks });

    const records = await getScheduledPosts();

    expect(records).toEqual([envelope.record]);
    expect(records[0]).not.toHaveProperty('schema_version');
    expect(lists.get(queueKey)).toEqual([encoded]);
    expect(locks.size).toBe(0);
  });

  test('migrates legacy queue records through the fenced whole-list commit', async () => {
    const queueKey = 'default:scheduled:posts';
    const legacyA = { id: 'legacy-a', platform: 'instagram', status: 'draft', caption: 'A' };
    const legacyB = { id: 'legacy-b', platform: 'facebook', status: 'draft', caption: 'B' };
    const lists = new Map([[queueKey, [
      encodedQueueValue(legacyA),
      encodedQueueValue(legacyB),
      encodedQueueValue({ ...legacyA, caption: 'duplicate must remain deduped' }),
    ]] ]);
    const locks = new Map();
    let fencedCommits = 0;
    global.fetch = redisListFetch(lists, {
      locks,
      beforeCommit: () => { fencedCommits += 1; },
    });

    const records = await getScheduledPosts();

    expect(records).toEqual([legacyA, legacyB]);
    expect((lists.get(queueKey) || []).map(decodedQueueValue)).toEqual([
      { schema_version: 1, record_type: 'social_scheduled_post', record: legacyA },
      { schema_version: 1, record_type: 'social_scheduled_post', record: legacyB },
    ]);
    expect(fencedCommits).toBe(1);
    expect(locks.size).toBe(0);
  });

  test('fails closed on unsupported queue schema without migration or wrapper leakage', async () => {
    const queueKey = 'default:scheduled:posts';
    const unsupported = encodedQueueValue({
      schema_version: 99,
      record_type: 'social_scheduled_post',
      record: { id: 'future-record', status: 'draft' },
    });
    const lists = new Map([[queueKey, [unsupported]]]);
    const locks = new Map();
    global.fetch = redisListFetch(lists, { locks });

    await expect(getScheduledPosts()).rejects.toMatchObject({
      code: 'SOCIAL_QUEUE_SCHEMA_UNSUPPORTED',
      retryable: false,
    });
    expect(lists.get(queueKey)).toEqual([unsupported]);
    expect(locks.size).toBe(0);
  });

  test('serializes independent module instances through the Redis mutation lease', async () => {
    const lists = new Map();
    const locks = new Map();
    let resolveContention;
    const contention = new Promise(resolve => { resolveContention = resolve; });
    let firstQueueRead = true;
    let contentionCount = 0;
    const fetchRedis = redisListFetch(lists, {
      locks,
      onContention: () => {
        contentionCount += 1;
        resolveContention();
      },
    });
    global.fetch = async url => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (String(parts[0] || '').toUpperCase() === 'LRANGE' && firstQueueRead) {
        firstQueueRead = false;
        await contention;
      }
      return fetchRedis(url);
    };

    const importId = `${Date.now()}-${Math.random()}`;
    const processA = await import(`../api/_scheduler.js?queue-process-a=${importId}`);
    const processB = await import(`../api/_scheduler.js?queue-process-b=${importId}`);
    await Promise.all([
      processA.saveScheduledPost({ id: 'queue-a', platform: 'instagram', status: 'draft', caption: 'A' }),
      processB.saveScheduledPost({ id: 'queue-b', platform: 'facebook', status: 'draft', caption: 'B' }),
    ]);

    const records = await processA.getScheduledPosts();
    expect(records.map(record => record.id)).toEqual(['queue-b', 'queue-a']);
    expect(contentionCount).toBeGreaterThan(0);
    expect(locks.has('default:scheduled:mutation-lock')).toBe(false);
  });

  test('fails closed after bounded lock contention without changing the queue', async () => {
    process.env.SOCIAL_QUEUE_MUTATION_LOCK_WAIT_MS = '25';
    const queueKey = 'default:scheduled:posts';
    const original = encodeURIComponent(JSON.stringify({ id: 'existing', caption: 'Existing' }));
    const lists = new Map([[queueKey, [original]]]);
    const locks = new Map([['default:scheduled:mutation-lock', 'other-process-token']]);
    global.fetch = redisListFetch(lists, { locks });
    const scheduler = await import(`../api/_scheduler.js?queue-busy=${Date.now()}-${Math.random()}`);

    await expect(scheduler.saveScheduledPost({ id: 'must-not-save', caption: 'Blocked' }))
      .rejects.toMatchObject({ code: 'SOCIAL_QUEUE_MUTATION_LOCK_TIMEOUT', status: 503, retryable: true });
    expect(lists.get(queueKey)).toEqual([original]);
    expect([...lists.keys()].filter(key => key.includes(':replace:'))).toEqual([]);
  });

  test('atomically rejects a stale lease at commit and preserves the newer owner state', async () => {
    const queueKey = 'default:scheduled:posts';
    const original = encodeURIComponent(JSON.stringify({ id: 'existing', caption: 'Existing' }));
    const lists = new Map([[queueKey, [original]]]);
    const locks = new Map();
    let replacedOwner = false;
    global.fetch = redisListFetch(lists, {
      locks,
      beforeCommit: ({ lockKey }) => {
        if (replacedOwner) return;
        replacedOwner = true;
        locks.set(lockKey, 'newer-process-token');
      },
    });
    const scheduler = await import(`../api/_scheduler.js?queue-stale=${Date.now()}-${Math.random()}`);

    await expect(scheduler.saveScheduledPosts([{ id: 'stale-replacement', caption: 'Must not commit' }]))
      .rejects.toMatchObject({ code: 'SOCIAL_QUEUE_MUTATION_LOCK_LOST', status: 503 });
    expect(lists.get(queueKey)).toEqual([original]);
    expect(locks.get('default:scheduled:mutation-lock')).toBe('newer-process-token');
    expect([...lists.keys()].filter(key => key.includes(':replace:'))).toEqual([]);
  });

  test('keeps the KV HTTP adapter free of direct scheduled-list rewrites', async () => {
    const source = await readFile(new URL('../api/kv.js', import.meta.url), 'utf8');
    const scheduledCases = source.slice(
      source.indexOf("case 'saveScheduledPost':"),
      source.indexOf("case 'getRespondedReviews':"),
    );
    expect(scheduledCases).not.toContain(':scheduled:posts');
    expect(scheduledCases).not.toMatch(/kvCall\(['"](?:LRANGE|DEL|LPUSH)['"]/);
    expect(scheduledCases).toContain('saveScheduledPostBatch(expandedRecords)');
    expect(scheduledCases).toContain('updateScheduledPost(safeValue.id, safeValue,');
    expect(scheduledCases).toContain('deleteScheduledPost(value.id)');
  });
});
