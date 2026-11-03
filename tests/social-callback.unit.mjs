import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { applyMakeCallback, getScheduledPosts, saveScheduledPosts } from '../api/_scheduler.js';

const KV_PORT = Number(process.env.SOCIAL_CALLBACK_TEST_KV_PORT || 32155);
const kvStore = new Map();
const lists = new Map();

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function startMockKvServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${KV_PORT}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const command = decodeURIComponent(parts[0] || '').toUpperCase();
    const args = parts.slice(1);
    const key = args[0] ? decodeURIComponent(args[0]) : '';

    if (command === 'GET') return json(res, 200, { result: kvStore.get(key) ?? null });
    if (command === 'SET') { kvStore.set(key, args[1] || ''); return json(res, 200, { result: 'OK' }); }
    if (command === 'DEL') { kvStore.delete(key); lists.delete(key); return json(res, 200, { result: 1 }); }
    if (command === 'LPUSH') {
      const list = lists.get(key) || [];
      for (const value of args.slice(1)) list.unshift(value);
      lists.set(key, list);
      return json(res, 200, { result: list.length });
    }
    if (command === 'LRANGE') {
      const list = lists.get(key) || [];
      const start = parseInt(args[1] || '0', 10);
      const stop = parseInt(args[2] || '-1', 10);
      const end = stop < 0 ? list.length : stop + 1;
      return json(res, 200, { result: list.slice(start, end) });
    }
    return json(res, 400, { error: `unsupported mock command ${command}` });
  });
  return new Promise(resolve => server.listen(KV_PORT, '127.0.0.1', () => resolve(server)));
}

process.env.KV_REST_API_URL = `http://127.0.0.1:${KV_PORT}`;
process.env.KV_REST_API_TOKEN = 'test-kv-token';
process.env.ETSY_SHOP_ID = '123456789';

const server = await startMockKvServer();
try {
  const id = 'unit-callback-queued';
  const before = await getScheduledPosts();
  await saveScheduledPosts([
    {
      id,
      caption: 'Callback safety regression',
      platform: 'pinterest',
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
      status: 'queued_external',
      created_at: new Date().toISOString(),
    },
    ...before.filter(post => post.id !== id),
  ]);

  for (const callbackStatus of ['accepted', 'queued', 'created']) {
    const queued = await applyMakeCallback({
      scheduled_post_id: id,
      status: callbackStatus,
      service: 'Make.com',
      message: `${callbackStatus} by connector`,
      post_url: 'https://example.test/pin/pending',
      success: true,
    });
    assert.equal(queued.updated.status, 'queued_external');
    assert.equal(queued.updated.published_at, undefined);
    assert.equal(queued.updated.publish_result.status, callbackStatus);
  }

  const confirmed = await applyMakeCallback({ scheduled_post_id: id, status: 'published', service: 'Make.com', post_url: 'https://example.test/pin/1' });
  assert.equal(confirmed.updated.status, 'published');
  assert.equal(confirmed.updated.post_url, 'https://example.test/pin/1');
  assert.ok(confirmed.updated.published_at);
  console.log('social callback queued_external regression passed');
} finally {
  await new Promise(resolve => server.close(resolve));
}
