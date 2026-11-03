export const IDB_DB_NAME = 'etsy-manager';
export const IDB_DB_VERSION = 1;
export const IDB_STORE_DRAFTS = 'drafts';
export const IDB_STORE_HISTORY = 'history';

let dbCache = null;

export async function openClientDb() {
  if (dbCache) return dbCache;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
    req.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE_DRAFTS)) {
        db.createObjectStore(IDB_STORE_DRAFTS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_HISTORY)) {
        db.createObjectStore(IDB_STORE_HISTORY, { keyPath: 'key' });
      }
    };
    req.onsuccess = event => {
      dbCache = event.target.result;
      resolve(dbCache);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IDB blocked'));
  });
}

export async function idbGet(storeName, key) {
  const db = await openClientDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(storeName, key, value, { now = () => Date.now() } = {}) {
  const db = await openClientDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put({ key, value, ts: now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(storeName, key) {
  const db = await openClientDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAllRecords(storeName) {
  const db = await openClientDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
