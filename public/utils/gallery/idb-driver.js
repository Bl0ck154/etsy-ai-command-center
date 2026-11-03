export const GALLERY_DB_NAME = 'etsy-img-cache';
export const GALLERY_DB_VERSION = 4;
export const GALLERY_BLOB_STORE = 'blobs';
export const GALLERY_IMAGE_STORE = 'images';
export const GALLERY_VIDEO_STORE = 'videos';
export const GALLERY_IMAGE_SUMMARY_STORE = 'image-summaries';

export function openGalleryDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(GALLERY_DB_NAME, GALLERY_DB_VERSION);
    req.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(GALLERY_BLOB_STORE)) {
        db.createObjectStore(GALLERY_BLOB_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(GALLERY_IMAGE_STORE)) {
        const store = db.createObjectStore(GALLERY_IMAGE_STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(GALLERY_VIDEO_STORE)) {
        const store = db.createObjectStore(GALLERY_VIDEO_STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(GALLERY_IMAGE_SUMMARY_STORE)) {
        const store = db.createObjectStore(GALLERY_IMAGE_SUMMARY_STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('ownerScope', 'ownerScope');
      }
    };
    req.onsuccess = event => resolve(event.target.result);
    req.onerror = () => reject(req.error);
  });
}

export async function galleryPut(storeName, record) {
  const db = await openGalleryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`Could not save to ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`Save to ${storeName} was aborted`));
  });
}

export async function galleryGet(storeName, id) {
  const db = await openGalleryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function galleryDelete(storeName, id) {
  const db = await openGalleryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function galleryGetAll(storeName) {
  const db = await openGalleryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function galleryGetAllKeys(storeName) {
  const db = await openGalleryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
