import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startEmbeddedKv } from '../scripts/embedded-kv-server.mjs';
import { createEtsyRevisionedStateRepository } from '../api/modules/etsy/index.js';

const call = (store, command, ...args) => fetch(store.url + '/' +
  [command, ...args].join('/'), {
    headers: { Authorization: 'Bearer ' + store.token },
  }).then(r => r.json()).then(data => {
    if (data.error) throw new Error(data.error);
    return data.result;
  });

test('embedded storage persists Redis-compatible strings and lists without public access', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'etsy-embedded-kv-'));
  const file = path.join(dir, 'state.json');
  let server = await startEmbeddedKv({ file });
  try {
    const blocked = await fetch(server.url + '/PING');
    expect(blocked.status).toBe(401);
    expect(await call(server, 'PING')).toBe('PONG');
    expect(await call(server, 'SET', 'shop:sample', 'hello')).toBe('OK');
    expect(await call(server, 'GET', 'shop:sample')).toBe('hello');
    expect(await call(server, 'SET', 'shop:sample', 'no', 'NX')).toBe(null);
    expect(await call(server, 'LPUSH', 'shop:gallery', 'one', 'two')).toBe(2);
    expect(await call(server, 'LRANGE', 'shop:gallery', 0, -1)).toEqual(['two', 'one']);
    expect(await call(server, 'LTRIM', 'shop:gallery', 0, 0)).toBe('OK');
    expect(await call(server, 'LRANGE', 'shop:gallery', 0, -1)).toEqual(['two']);
    await server.close();
    server = await startEmbeddedKv({ file });
    expect(await call(server, 'GET', 'shop:sample')).toBe('hello');
    expect(await call(server, 'LRANGE', 'shop:gallery', 0, -1)).toEqual(['two']);
    expect((await fs.stat(file)).mode & 0o077).toBe(0);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('revisioned Etsy OAuth state uses atomic EVAL compare-and-swap', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'etsy-embedded-cas-'));
  const file = path.join(dir, 'state.json');
  const server = await startEmbeddedKv({ file });
  try {
    const repo = createEtsyRevisionedStateRepository({
      key: 'shop:test:oauth',
      callKv: (name, ...args) => call(server, name, ...args),
    });
    const empty = await repo.readSnapshot();
    expect(empty.revision).toBe(0);
    const updated = await repo.update(() => ({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
    }));
    expect(updated.revision).toBeGreaterThan(0);
    const reread = await repo.readSnapshot();
    expect(reread.state.access_token).toBe('synthetic-access');
    await expect(repo.compareAndReplace(0, { access_token: 'stale-value' })).rejects.toMatchObject({
      code: 'REVISIONED_JSON_REVISION_CONFLICT',
    });
    expect((await repo.readSnapshot()).state.access_token).toBe('synthetic-access');
    const invalid = await fetch(server.url + '/EVAL/' + encodeURIComponent('return redis.call("FLUSHALL")') + '/0', {
      headers: { Authorization: 'Bearer ' + server.token },
    });
    expect(invalid.status).toBe(400);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
