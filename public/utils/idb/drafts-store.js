import { scopedClientKey } from '../user-scope.js';
import {
  IDB_STORE_DRAFTS,
  idbDelete,
  idbGet,
  idbSet,
} from './driver.js';

export function createDraftStore({
  driver = { get: idbGet, set: idbSet, delete: idbDelete },
  storageProvider = () => localStorage,
  scopeKey = scopedClientKey,
} = {}) {
  function storage() {
    try { return storageProvider?.() || null; } catch { return null; }
  }

  async function get(key) {
    const scopedKey = scopeKey(key);
    try {
      const value = await driver.get(IDB_STORE_DRAFTS, scopedKey);
      if (value !== null) return value;
      const legacy = await driver.get(IDB_STORE_DRAFTS, key);
      if (legacy !== null) {
        await driver.set(IDB_STORE_DRAFTS, scopedKey, legacy);
        await driver.delete(IDB_STORE_DRAFTS, key);
        return legacy;
      }
      const target = storage();
      const local = target?.getItem(scopedKey) || target?.getItem(key);
      if (!local) return null;
      const parsed = JSON.parse(local);
      await driver.set(IDB_STORE_DRAFTS, scopedKey, parsed);
      target?.removeItem(key);
      return parsed;
    } catch {
      try {
        const target = storage();
        return JSON.parse(target?.getItem(scopedKey) || target?.getItem(key) || 'null');
      } catch {
        return null;
      }
    }
  }

  async function set(key, value) {
    const scopedKey = scopeKey(key);
    try {
      await driver.set(IDB_STORE_DRAFTS, scopedKey, value);
      const target = storage();
      target?.removeItem(key);
      target?.removeItem(scopedKey);
    } catch {
      try { storage()?.setItem(scopedKey, JSON.stringify(value)); } catch {}
    }
  }

  async function remove(key) {
    const scopedKey = scopeKey(key);
    try { await driver.delete(IDB_STORE_DRAFTS, scopedKey); } catch {}
    try {
      const target = storage();
      target?.removeItem(scopedKey);
      target?.removeItem(key);
    } catch {}
  }

  return { get, set, delete: remove };
}

export const drafts = createDraftStore();
