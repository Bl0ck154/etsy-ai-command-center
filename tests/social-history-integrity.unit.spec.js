import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import kvHandler from '../api/kv.js';
import { applyMakeCallback } from '../api/_scheduler.js';
import {
  createSocialPublishHistoryRepository,
  SOCIAL_PUBLISH_HISTORY_RECORD_TYPE,
  SOCIAL_PUBLISH_HISTORY_SCHEMA_VERSION,
} from '../api/modules/social/infrastructure/publish-history-repository.js';

function mockResponse() {
  const captured = { statusCode: 200, payload: null };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.payload = payload; return payload; },
    end() { return undefined; },
  };
  return { res, captured };
}

async function callKv(action, value) {
  const { res, captured } = mockResponse();
  await kvHandler({ method: 'POST', headers: {}, query: {}, body: { action, value } }, res);
  return captured;
}

function createHistoryRepositoryFixture(initial = []) {
  const values = [...initial];
  const calls = [];
  const repository = createSocialPublishHistoryRepository({
    shopId: 'fixture-shop',
    callKv: async (command, ...args) => {
      calls.push([command, ...args]);
      if (command === 'LRANGE') return [...values];
      if (command === 'EVAL') {
        const migrations = args.slice(3);
        for (let index = 0; index < values.length; index += 1) {
          for (let migration = 0; migration < migrations.length; migration += 2) {
            if (values[index] === decodeURIComponent(migrations[migration])) {
              values[index] = decodeURIComponent(migrations[migration + 1]);
              break;
            }
          }
        }
        return values.length;
      }
      if (command === 'LPUSH') {
        values.unshift(decodeURIComponent(args[1]));
        return values.length;
      }
      if (command === 'LTRIM') {
        values.splice(Number(args[2]) + 1);
        return 'OK';
      }
      throw new Error(`Unexpected history repository command: ${command}`);
    },
  });
  return { calls, repository, values };
}

test('current publish history schema reads as plain records without rewriting', async () => {
  const record = { listing_id: 11, platform: 'instagram', status: 'published', postedAt: 100 };
  const current = JSON.stringify({
    schema_version: SOCIAL_PUBLISH_HISTORY_SCHEMA_VERSION,
    record_type: SOCIAL_PUBLISH_HISTORY_RECORD_TYPE,
    record,
  });
  const fixture = createHistoryRepositoryFixture([current]);

  await expect(fixture.repository.list()).resolves.toEqual([record]);
  expect(fixture.calls.map(([command]) => command)).toEqual(['LRANGE']);
});

test('legacy publish history migrates in place without changing order or public records', async () => {
  const newest = { listing_id: 22, platform: 'pinterest', status: 'published', postedAt: 200 };
  const oldest = { listing_id: 21, platform: 'facebook', status: 'published', postedAt: 100 };
  const fixture = createHistoryRepositoryFixture([
    JSON.stringify(newest),
    encodeURIComponent(JSON.stringify(oldest)),
  ]);

  await expect(fixture.repository.list()).resolves.toEqual([newest, oldest]);
  expect(fixture.calls.filter(([command]) => command === 'EVAL')).toHaveLength(1);
  expect(fixture.values.map(value => JSON.parse(decodeURIComponent(value)))).toEqual([
    {
      schema_version: SOCIAL_PUBLISH_HISTORY_SCHEMA_VERSION,
      record_type: SOCIAL_PUBLISH_HISTORY_RECORD_TYPE,
      record: newest,
    },
    {
      schema_version: SOCIAL_PUBLISH_HISTORY_SCHEMA_VERSION,
      record_type: SOCIAL_PUBLISH_HISTORY_RECORD_TYPE,
      record: oldest,
    },
  ]);

  await expect(fixture.repository.list()).resolves.toEqual([newest, oldest]);
  expect(fixture.calls.filter(([command]) => command === 'EVAL')).toHaveLength(1);
});

test('unsupported publish history schema fails closed without migration', async () => {
  const fixture = createHistoryRepositoryFixture([JSON.stringify({
    schema_version: 999,
    record_type: SOCIAL_PUBLISH_HISTORY_RECORD_TYPE,
    record: { listing_id: 33 },
  })]);

  await expect(fixture.repository.list()).rejects.toMatchObject({
    code: 'SOCIAL_PUBLISH_HISTORY_SCHEMA_UNSUPPORTED',
    status: 500,
    retryable: false,
  });
  expect(fixture.calls.map(([command]) => command)).toEqual(['LRANGE']);
});

test('browser KV routes cannot fabricate or clear publish history', async () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    HOST: process.env.HOST,
    SITE_PASSWORD: process.env.SITE_PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET,
    AUTH_USERS_B64: process.env.AUTH_USERS_B64,
  };
  const originalFetch = global.fetch;
  const networkCalls = [];
  process.env.NODE_ENV = 'test';
  process.env.HOST = '127.0.0.1';
  delete process.env.SITE_PASSWORD;
  delete process.env.SESSION_SECRET;
  delete process.env.AUTH_USERS_B64;
  global.fetch = async (...args) => {
    networkCalls.push(args);
    throw new Error('history mutation must not reach KV');
  };

  try {
    const fabricated = await callKv('recordPost', {
      listing_id: 42,
      platform: 'instagram',
      status: 'published',
      postedAt: Date.now(),
    });
    const cleared = await callKv('clearPosts');

    for (const response of [fabricated, cleared]) {
      expect(response.statusCode).toBe(405);
      expect(response.payload).toMatchObject({
        success: false,
        code: 'PUBLISH_HISTORY_SERVER_WRITABLE_ONLY',
      });
    }
    expect(networkCalls).toHaveLength(0);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('confirmed Make callback still appends server-owned publish history', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  };
  const queueKey = 'default:scheduled:posts';
  const historyKey = 'default:posts:history';
  const post = {
    id: 'history-integrity-make-post',
    listing_id: 123,
    listing_title: 'Verified listing',
    platform: 'pinterest',
    status: 'queued_external',
    scheduled_at: '2026-07-22T12:00:00.000Z',
    caption: 'Verified callback post.',
    media_items: [{ url: 'https://em.example.test/api/social?action=mediaAsset&id=pin-one', type: 'image' }],
    publish_result: {
      method: 'Make.com Pinterest bridge',
      callback_attempt_id: 'history-attempt-1',
    },
  };
  const lists = new Map([[queueKey, [encodeURIComponent(JSON.stringify(post))]]]);
  const locks = new Map();
  const historyCommands = [];
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-kv-token';

  global.fetch = async (url) => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    if (command === 'LRANGE') return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
    if (command === 'SET') {
      if (locks.has(key)) return new Response(JSON.stringify({ result: null }), { status: 200 });
      locks.set(key, parts[2]);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (command === 'EVAL') {
      const keyCount = Number(parts[2] || 0);
      const lockKey = parts[3] || '';
      const token = parts[3 + keyCount] || '';
      if (locks.get(lockKey) !== token) return new Response(JSON.stringify({ result: 0 }), { status: 200 });
      if (keyCount === 3) {
        const shadowKey = parts[4] || '';
        const targetKey = parts[5] || '';
        if (!lists.has(shadowKey)) return new Response(JSON.stringify({ result: -1 }), { status: 200 });
        lists.set(targetKey, lists.get(shadowKey));
        lists.delete(shadowKey);
      }
      locks.delete(lockKey);
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }
    if (command === 'DEL') { lists.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
    if (command === 'LPUSH') {
      if (key === historyKey) historyCommands.push(parts);
      const list = lists.get(key) || [];
      for (const item of parts.slice(2)) list.unshift(item);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200 });
    }
    if (command === 'LTRIM') {
      if (key === historyKey) historyCommands.push(parts);
      const list = lists.get(key) || [];
      lists.set(key, list.slice(Number(parts[2]), Number(parts[3]) + 1));
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], lists.get(key) || []);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`Unexpected KV request: ${url}`);
  };

  try {
    const result = await applyMakeCallback({
      scheduled_post_id: post.id,
      status: 'published',
      callback_attempt_id: 'history-attempt-1',
      service: 'Make.com',
      post_url: 'https://www.pinterest.com/pin/history-integrity/',
    });
    const storedHistory = (lists.get(historyKey) || []).map(raw => JSON.parse(decodeURIComponent(raw)));
    const history = storedHistory.map(item => item.record);

    expect(result.updated).toMatchObject({ status: 'published' });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      listing_id: 123,
      listing_title: 'Verified listing',
      platform: 'pinterest',
      service: 'Make.com',
      status: 'published',
      post_url: 'https://www.pinterest.com/pin/history-integrity/',
    });
    expect(storedHistory[0]).toMatchObject({
      schema_version: SOCIAL_PUBLISH_HISTORY_SCHEMA_VERSION,
      record_type: SOCIAL_PUBLISH_HISTORY_RECORD_TYPE,
    });
    expect(history[0]).not.toHaveProperty('schema_version');
    expect(historyCommands.map(parts => [parts[0], parts[2], parts[3]])).toEqual([
      ['LPUSH', expect.any(String), undefined],
      ['LTRIM', '0', '499'],
    ]);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('public Social Hub source exposes publish history as read-only', () => {
  const storeSource = readFileSync(new URL('../public/utils/post-store.js', import.meta.url), 'utf8');
  const socialSource = readFileSync(new URL('../public/pages/social.js', import.meta.url), 'utf8');
  expect(storeSource).toContain("kvPost('getPosts')");
  expect(storeSource).not.toMatch(/recordPost|clearPosts|clearPostHistory/);
  expect(socialSource).not.toMatch(/\brecordPost\s*\(/);
});
