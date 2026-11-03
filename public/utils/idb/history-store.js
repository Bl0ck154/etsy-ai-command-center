import { scopedClientKey } from '../user-scope.js';
import {
  IDB_STORE_HISTORY,
  idbDelete,
  idbGet,
  idbGetAllRecords,
  idbSet,
} from './driver.js';

export function createHistoryStore({
  driver = { get: idbGet, set: idbSet, delete: idbDelete, getAll: idbGetAllRecords },
  storageProvider = () => sessionStorage,
  scopeKey = scopedClientKey,
} = {}) {
  function storage() {
    try { return storageProvider?.() || null; } catch { return null; }
  }

  async function get(key) {
    const scopedKey = scopeKey(key);
    try {
      const value = await driver.get(IDB_STORE_HISTORY, scopedKey);
      if (value !== null) return value;
      const legacy = await driver.get(IDB_STORE_HISTORY, key);
      if (legacy !== null) {
        await driver.set(IDB_STORE_HISTORY, scopedKey, legacy);
        await driver.delete(IDB_STORE_HISTORY, key);
        return legacy;
      }
      const cached = storage()?.getItem(scopedKey) || storage()?.getItem(key);
      return cached ? JSON.parse(cached) : null;
    } catch {
      try {
        return JSON.parse(storage()?.getItem(scopedKey) || storage()?.getItem(key) || 'null');
      } catch {
        return null;
      }
    }
  }

  async function set(key, value) {
    const scopedKey = scopeKey(key);
    try {
      await driver.set(IDB_STORE_HISTORY, scopedKey, value);
    } catch {
      try { storage()?.setItem(scopedKey, JSON.stringify(value)); } catch {}
    }
  }

  async function remove(key) {
    const scopedKey = scopeKey(key);
    try { await driver.delete(IDB_STORE_HISTORY, scopedKey); } catch {}
    try {
      const target = storage();
      target?.removeItem(scopedKey);
      target?.removeItem(key);
    } catch {}
  }

  async function getAll() {
    try {
      const scopeSuffix = scopeKey('');
      return (await driver.getAll(IDB_STORE_HISTORY))
        .filter(record => String(record?.key || '').endsWith(scopeSuffix));
    } catch {
      return [];
    }
  }

  return { get, set, delete: remove, getAll };
}

export const history = createHistoryStore();
