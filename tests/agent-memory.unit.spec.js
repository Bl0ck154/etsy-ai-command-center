import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test('memory tool contract proactively captures durable preferences without collecting transient or sensitive data', async () => {
  const { TOOLS } = await import(`../api/agent/tools-schema.js?memory=${Date.now()}`);
  const memoryTool = TOOLS.find(tool => tool.name === 'save_memory');
  const shopMemoryTool = TOOLS.find(tool => tool.name === 'save_shop_operating_context');
  const deleteShopMemoryTool = TOOLS.find(tool => tool.name === 'delete_shop_operating_context');
  const system = fs.readFileSync(new URL('../api/agent/helpers.js', import.meta.url), 'utf8');

  expect(memoryTool?.description).toContain('Use proactively');
  expect(memoryTool?.description).toContain('Do not save transient requests');
  expect(memoryTool?.description).toContain('private preference');
  expect(shopMemoryTool?.description).toContain('shared with every authenticated operator');
  expect(deleteShopMemoryTool?.input_schema?.required).toContain('id');
  expect(memoryTool?.input_schema?.required).toEqual(expect.arrayContaining(['text', 'category', 'progress_message']));
  expect(system).toContain('The owner does not need to use the word "remember"');
  expect(system).toContain('credentials, secrets, sensitive personal data');
  expect(system).toContain('Choose memory scope semantically');
});

test('shop memory is shared across operators while using one shop-scoped KV record', async () => {
  const previous = {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
    fetch: global.fetch,
  };
  const values = new Map();
  process.env.KV_REST_API_URL = 'https://shared-memory-kv.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  global.fetch = async (_input, init = {}) => {
    const [command, key, value] = JSON.parse(init.body || '[]');
    if (command === 'GET') return { ok: true, json: async () => ({ result: values.get(key) ?? null }) };
    if (command === 'SET') {
      values.set(key, value);
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    throw new Error(`Unexpected KV command: ${command}`);
  };

  try {
    const dispatch = await import(`../api/agent/tools-dispatch.js?shared-memory=${Date.now()}`);
    const firstOperator = { _owner_id: 'illia', shop_operating_context: null };
    const saved = await dispatch.dispatchToolForTest('save_shop_operating_context', {
      summary: 'Use archival packaging for physical portrait orders.',
      category: 'fulfillment',
    }, firstOperator, dispatch.makeState());
    expect(saved.result.saved).toBe(true);
    expect(saved.result.item.created_by).toBe('illia');
    expect([...values.keys()]).toHaveLength(1);
    expect([...values.keys()][0]).toMatch(/:shop_operating_context$/);
    expect([...values.values()][0]).toMatch(/^%7B/);

    const secondOperator = { _owner_id: 'second-admin', shop_operating_context: null };
    const loaded = await dispatch.dispatchToolForTest('get_shop_operating_context', {}, secondOperator, dispatch.makeState());
    expect(loaded.result.context.items[0].summary).toContain('archival packaging');
    expect(secondOperator.shop_operating_context.items).toHaveLength(1);

    const removed = await dispatch.dispatchToolForTest('delete_shop_operating_context', {
      id: saved.result.item.id,
    }, secondOperator, dispatch.makeState());
    expect(removed.result.deleted).toBe(true);
    expect(removed.result.context.items).toEqual([]);
  } finally {
    if (previous.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = previous.url;
    if (previous.token === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});

test('save_memory commits to user-scoped server storage before reporting success and deduplicates repeats', async () => {
  const previous = {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
    fetch: global.fetch,
  };
  const values = new Map();
  process.env.KV_REST_API_URL = 'https://memory-kv.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  global.fetch = async input => {
    const parts = new URL(String(input)).pathname.slice(1).split('/').map(decodeURIComponent);
    const [command, key, value] = parts;
    if (command === 'GET') return { json: async () => ({ result: values.get(key) ?? null }) };
    if (command === 'SET') {
      values.set(key, value);
      return { json: async () => ({ result: 'OK' }) };
    }
    if (command === 'EVAL') {
      const storageKey = parts[3];
      const expected = parts[4];
      const replacement = parts[5];
      const current = values.get(storageKey);
      const missing = expected === '__revisioned_json_missing__';
      if (missing ? current !== undefined : current !== expected) {
        return { json: async () => ({ result: 0 }) };
      }
      values.set(storageKey, replacement);
      return { json: async () => ({ result: 1 }) };
    }
    throw new Error(`Unexpected KV command: ${command}`);
  };

  try {
    const dispatch = await import(`../api/agent/tools-dispatch.js?memory=${Date.now()}`);
    const context = { _owner_id: 'illia', agent_memory: [] };
    const state = dispatch.makeState();
    const input = { text: 'Always write Etsy buyer-facing copy in English.', category: 'rule' };

    const first = await dispatch.dispatchToolForTest('save_memory', input, context, state);
    expect(first.result.status).toBe('saved');
    expect(first.state.pendingMemorySave).toMatchObject({ text: input.text, category: 'rule', persisted: true });
    expect(context.agent_memory).toHaveLength(1);
    expect([...values.keys()].some(key => key.endsWith(':user:illia:agent_memory:state'))).toBe(true);

    const duplicateState = dispatch.makeState();
    const duplicate = await dispatch.dispatchToolForTest('save_memory', input, context, duplicateState);
    expect(duplicate.result.status).toBe('already_saved');
    expect(context.agent_memory).toHaveLength(1);

    const otherContext = { _owner_id: 'second-admin', agent_memory: [] };
    const otherState = dispatch.makeState();
    await dispatch.dispatchToolForTest('save_memory', { text: 'Use concise replies.', category: 'preference' }, otherContext, otherState);
    expect(otherContext.agent_memory.map(item => item.text)).toEqual(['Use concise replies.']);

    const deleted = await dispatch.dispatchToolForTest('delete_memory', { id: first.result.memory.id }, context, dispatch.makeState());
    expect(deleted.result.status).toBe('deleted');
    expect(context.agent_memory).toEqual([]);
    expect(otherContext.agent_memory).toHaveLength(1);
  } finally {
    if (previous.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = previous.url;
    if (previous.token === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});
