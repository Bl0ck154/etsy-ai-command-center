import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { IDB_STORE_DRAFTS, IDB_STORE_HISTORY } from '../public/utils/idb/driver.js';
import { createDraftStore } from '../public/utils/idb/drafts-store.js';
import { createHistoryStore } from '../public/utils/idb/history-store.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    has: key => data.has(key),
    value: key => data.get(key),
  };
}

function memoryDriver(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = [];
  const id = (store, key) => `${store}:${key}`;
  return {
    calls,
    async get(store, key) { calls.push(['get', store, key]); return data.has(id(store, key)) ? data.get(id(store, key)) : null; },
    async set(store, key, value) { calls.push(['set', store, key, value]); data.set(id(store, key), value); },
    async delete(store, key) { calls.push(['delete', store, key]); data.delete(id(store, key)); },
    async getAll(store) {
      calls.push(['getAll', store]);
      return [...data.entries()]
        .filter(([key]) => key.startsWith(`${store}:`))
        .map(([key, value]) => ({ key: key.slice(store.length + 1), value }));
    },
    value(store, key) { return data.get(id(store, key)); },
  };
}

const scopeKey = key => `${key}::alice:shop1`;

test('draft store migrates legacy IDB key into scoped key exactly once', async () => {
  const driver = memoryDriver({ [`${IDB_STORE_DRAFTS}:draft-a`]: { title: 'Legacy' } });
  const storage = memoryStorage();
  const drafts = createDraftStore({ driver, storageProvider: () => storage, scopeKey });
  expect(await drafts.get('draft-a')).toEqual({ title: 'Legacy' });
  expect(driver.value(IDB_STORE_DRAFTS, 'draft-a::alice:shop1')).toEqual({ title: 'Legacy' });
  expect(driver.value(IDB_STORE_DRAFTS, 'draft-a')).toBeUndefined();
});

test('draft localStorage fallback migrates into IDB and cleans legacy key', async () => {
  const driver = memoryDriver();
  const storage = memoryStorage({ 'draft-b': JSON.stringify({ title: 'Local' }) });
  const drafts = createDraftStore({ driver, storageProvider: () => storage, scopeKey });
  expect(await drafts.get('draft-b')).toEqual({ title: 'Local' });
  expect(driver.value(IDB_STORE_DRAFTS, 'draft-b::alice:shop1')).toEqual({ title: 'Local' });
  expect(storage.has('draft-b')).toBe(false);
});

test('draft set falls back to scoped localStorage when IDB fails', async () => {
  const storage = memoryStorage();
  const driver = {
    async get() { throw new Error('idb down'); },
    async set() { throw new Error('idb down'); },
    async delete() { throw new Error('idb down'); },
  };
  const drafts = createDraftStore({ driver, storageProvider: () => storage, scopeKey });
  await drafts.set('draft-c', { x: 1 });
  expect(JSON.parse(storage.value('draft-c::alice:shop1'))).toEqual({ x: 1 });
  expect(await drafts.get('draft-c')).toEqual({ x: 1 });
});

test('history store migrates legacy IDB records but keeps session fallback read-only', async () => {
  const driver = memoryDriver({ [`${IDB_STORE_HISTORY}:h1`]: ['legacy'] });
  const storage = memoryStorage({ 'h2::alice:shop1': JSON.stringify(['session']) });
  const history = createHistoryStore({ driver, storageProvider: () => storage, scopeKey });
  expect(await history.get('h1')).toEqual(['legacy']);
  expect(driver.value(IDB_STORE_HISTORY, 'h1::alice:shop1')).toEqual(['legacy']);
  expect(await history.get('h2')).toEqual(['session']);
  expect(driver.value(IDB_STORE_HISTORY, 'h2::alice:shop1')).toBeUndefined();
});

test('history getAll filters records to current workspace suffix', async () => {
  const driver = memoryDriver({
    [`${IDB_STORE_HISTORY}:one::alice:shop1`]: 1,
    [`${IDB_STORE_HISTORY}:two::bob:shop1`]: 2,
    [`${IDB_STORE_HISTORY}:three::alice:shop1`]: 3,
  });
  const history = createHistoryStore({ driver, storageProvider: () => memoryStorage(), scopeKey });
  const records = await history.getAll();
  expect(records.map(record => record.key)).toEqual(['one::alice:shop1', 'three::alice:shop1']);
});

test('delete clears scoped and legacy fallback keys even when IDB fails', async () => {
  const storage = memoryStorage({ old: '1', 'old::alice:shop1': '2' });
  const driver = {
    async get() { return null; },
    async set() {},
    async delete() { throw new Error('down'); },
    async getAll() { return []; },
  };
  const drafts = createDraftStore({ driver, storageProvider: () => storage, scopeKey });
  await drafts.delete('old');
  expect(storage.has('old')).toBe(false);
  expect(storage.has('old::alice:shop1')).toBe(false);
});

test('idb public entry remains compatibility facade', () => {
  const source = fs.readFileSync(new URL('../public/utils/idb.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(6);
  expect(source).not.toContain('indexedDB.open');
  expect(source).not.toContain('localStorage');
  expect(source).not.toContain('sessionStorage');
});
