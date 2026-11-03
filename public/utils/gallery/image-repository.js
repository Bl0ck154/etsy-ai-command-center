import { kvPost } from '../kv-client.js';
import { currentWorkspaceScope } from '../user-scope.js';
import {
  GALLERY_BLOB_STORE,
  GALLERY_IMAGE_STORE,
  GALLERY_IMAGE_SUMMARY_STORE,
  galleryDelete,
  galleryGet,
  galleryGetAll,
  galleryGetAllKeys,
  galleryPut,
} from './idb-driver.js';
import { imageSummaryFrom, isValidImageRecord } from './image-record.js';
import { createThumbnailDataUrl } from './thumbnail.js';

async function persistImageSummary(record) {
  const existing = await galleryGet(GALLERY_IMAGE_SUMMARY_STORE, record.id).catch(() => null);
  const thumbnailDataUrl = existing?.thumbnailDataUrl
    || await createThumbnailDataUrl(record).catch(() => '');
  const summary = imageSummaryFrom(record, thumbnailDataUrl, currentWorkspaceScope());
  await galleryPut(GALLERY_IMAGE_SUMMARY_STORE, summary);
  return summary;
}

const summaryWarmListeners = new Set();
let summaryWarmPromise = null;

function notifySummaryWarmListeners(summary) {
  for (const listener of summaryWarmListeners) {
    try { listener(summary); } catch { /* observers must not interrupt migration */ }
  }
}

export function warmGalleryImageSummaries({ onSummary } = {}) {
  if (typeof onSummary === 'function') summaryWarmListeners.add(onSummary);
  if (!summaryWarmPromise) {
    summaryWarmPromise = (async () => {
      const ownerScope = currentWorkspaceScope();
      const existing = await galleryGetAll(GALLERY_IMAGE_SUMMARY_STORE).catch(() => []);
      const knownIds = new Set(existing.map(summary => String(summary.id)));
      for (const storeName of [GALLERY_IMAGE_STORE, GALLERY_BLOB_STORE]) {
        const ids = await galleryGetAllKeys(storeName).catch(() => []);
        for (const id of ids) {
          if (knownIds.has(String(id))) continue;
          const record = await galleryGet(storeName, id).catch(() => null);
          if (!isValidImageRecord(record)) continue;
          if (record.ownerScope && record.ownerScope !== ownerScope) continue;
          if (!record.ownerScope) {
            record.ownerScope = ownerScope;
            await galleryPut(storeName, record).catch(() => {});
          }
          const summary = await persistImageSummary(record).catch(() => null);
          if (summary) {
            knownIds.add(String(summary.id));
            notifySummaryWarmListeners(summary);
          }
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    })().finally(() => {
      summaryWarmPromise = null;
    });
  }
  return summaryWarmPromise.finally(() => {
    if (typeof onSummary === 'function') summaryWarmListeners.delete(onSummary);
  });
}

export async function listGalleryImageSummaries() {
  const ownerScope = currentWorkspaceScope();
  const summaries = await galleryGetAll(GALLERY_IMAGE_SUMMARY_STORE).catch(() => []);
  await Promise.all(summaries.filter(summary => !summary.ownerScope).map(summary => {
    summary.ownerScope = ownerScope;
    return galleryPut(GALLERY_IMAGE_SUMMARY_STORE, summary).catch(() => {});
  }));
  return summaries
    .filter(summary => summary.ownerScope === ownerScope)
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

export async function saveImage({ base64, mimeType, prompt, slotLabel, listingTitle = '', provider, model }) {
  if (!isValidImageRecord({ id: 'pending', base64, mimeType })) throw new Error('Cannot save invalid image data');
  const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const ownerScope = currentWorkspaceScope();
  const meta = {
    id,
    prompt,
    slotLabel,
    listingTitle,
    mimeType,
    createdAt: Date.now(),
    ownerScope,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };

  await galleryPut(GALLERY_IMAGE_STORE, { ...meta, base64 });
  await persistImageSummary({ ...meta, base64 }).catch(() => {});
  await galleryPut(GALLERY_BLOB_STORE, {
    id,
    base64,
    mimeType,
    ownerScope,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  }).catch(() => {});
  kvPost('saveGalleryMeta', meta).catch(() => {});

  return id;
}

export async function getImage(id) {
  if (!id) return null;
  let storeName = GALLERY_IMAGE_STORE;
  let record = await galleryGet(GALLERY_IMAGE_STORE, id).catch(() => null);
  if (!record) {
    storeName = GALLERY_BLOB_STORE;
    record = await galleryGet(GALLERY_BLOB_STORE, id).catch(() => null);
  }
  if (!isValidImageRecord(record)) return null;
  const ownerScope = currentWorkspaceScope();
  if (record.ownerScope && record.ownerScope !== ownerScope) return null;
  if (!record.ownerScope) {
    record.ownerScope = ownerScope;
    await galleryPut(storeName, record).catch(() => {});
  }
  if (!await galleryGet(GALLERY_IMAGE_SUMMARY_STORE, id).catch(() => null)) {
    persistImageSummary(record).catch(() => {});
  }
  return record;
}

export async function getImagesByIds(ids = []) {
  const records = await Promise.all(ids.map(id => getImage(id).catch(() => null)));
  return records.filter(Boolean);
}

export async function getLocalImages() {
  const ownerScope = currentWorkspaceScope();
  const [images, legacyBlobs] = await Promise.all([
    galleryGetAll(GALLERY_IMAGE_STORE).catch(() => []),
    galleryGetAll(GALLERY_BLOB_STORE).catch(() => []),
  ]);
  const byId = new Map(images.map(image => [String(image.id), image]));
  for (const blob of legacyBlobs) {
    if (blob?.id != null && !byId.has(String(blob.id))) byId.set(String(blob.id), blob);
  }
  const records = Array.from(byId.values()).filter(isValidImageRecord);
  await Promise.all(records.filter(record => !record.ownerScope).map(record => {
    record.ownerScope = ownerScope;
    return galleryPut(GALLERY_IMAGE_STORE, record).catch(() => {});
  }));
  return records
    .filter(record => record.ownerScope === ownerScope)
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

export async function getAllImages() {
  const ownerScope = currentWorkspaceScope();
  const [metaResult, localResult] = await Promise.allSettled([
    kvPost('getGalleryMeta'),
    galleryGetAll(GALLERY_IMAGE_STORE),
  ]);
  const metas = metaResult.status === 'fulfilled' ? metaResult.value : null;
  const local = localResult.status === 'fulfilled' ? localResult.value : [];
  const byId = new Map(
    local
      .filter(image => !image.ownerScope || image.ownerScope === ownerScope)
      .map(image => [String(image.id), image]),
  );
  if (metas?.length) {
    await Promise.all(metas.map(async meta => {
      if (meta?.id == null) return;
      const key = String(meta.id);
      const localRecord = byId.get(key);
      const cached = localRecord || await galleryGet(GALLERY_BLOB_STORE, meta.id).catch(() => null);
      byId.set(key, {
        ...meta,
        ...localRecord,
        base64: cached?.base64 || null,
        mimeType: cached?.mimeType || meta.mimeType,
      });
    }));
  }
  const records = Array.from(byId.values()).filter(isValidImageRecord);
  await Promise.all(records.filter(record => !record.ownerScope).map(record => {
    record.ownerScope = ownerScope;
    return galleryPut(GALLERY_IMAGE_STORE, record).catch(() => {});
  }));
  return records
    .filter(record => record.ownerScope === ownerScope)
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

export async function deleteImage(id) {
  const record = await getImage(id);
  if (!record) return;
  await kvPost('deleteGalleryMeta', { id }).catch(() => {});
  await galleryDelete(GALLERY_IMAGE_STORE, id).catch(() => {});
  await galleryDelete(GALLERY_BLOB_STORE, id).catch(() => {});
  await galleryDelete(GALLERY_IMAGE_SUMMARY_STORE, id).catch(() => {});
}

export async function clearAllImages() {
  await kvPost('clearGalleryMeta').catch(() => {});
  const ownerScope = currentWorkspaceScope();
  const images = await galleryGetAll(GALLERY_IMAGE_STORE).catch(() => []);
  const blobs = await galleryGetAll(GALLERY_BLOB_STORE).catch(() => []);
  const summaries = await galleryGetAll(GALLERY_IMAGE_SUMMARY_STORE).catch(() => []);
  await Promise.all(images
    .filter(record => !record.ownerScope || record.ownerScope === ownerScope)
    .map(record => galleryDelete(GALLERY_IMAGE_STORE, record.id).catch(() => {})));
  await Promise.all(blobs
    .filter(record => !record.ownerScope || record.ownerScope === ownerScope)
    .map(record => galleryDelete(GALLERY_BLOB_STORE, record.id).catch(() => {})));
  await Promise.all(summaries
    .filter(record => !record.ownerScope || record.ownerScope === ownerScope)
    .map(record => galleryDelete(GALLERY_IMAGE_SUMMARY_STORE, record.id).catch(() => {})));
}

export async function countImages() {
  try {
    const metas = await kvPost('getGalleryMeta');
    if (metas?.length) return metas.length;
  } catch { /* fall through */ }
  return (await getLocalImages()).length;
}
