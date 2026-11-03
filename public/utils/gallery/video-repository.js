import { kvPost } from '../kv-client.js';
import { currentWorkspaceScope } from '../user-scope.js';
import {
  GALLERY_VIDEO_STORE,
  galleryDelete,
  galleryGet,
  galleryGetAll,
  galleryPut,
} from './idb-driver.js';

export async function saveVideo({ base64, mimeType, prompt = '', sourceImageId = '', label = '' }) {
  const id = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const meta = {
    id,
    prompt,
    sourceImageId,
    label,
    mimeType,
    createdAt: Date.now(),
    ownerScope: currentWorkspaceScope(),
  };

  await galleryPut(GALLERY_VIDEO_STORE, { ...meta, base64 }).catch(() => {});
  kvPost('saveVideoMeta', meta).catch(() => {});

  return id;
}

export async function getAllVideos() {
  const ownerScope = currentWorkspaceScope();
  let metas = null;
  try {
    metas = await kvPost('getVideoMeta');
  } catch {
    metas = null;
  }

  if (metas?.length) {
    const videos = await Promise.all(metas.map(async meta => {
      const cached = await galleryGet(GALLERY_VIDEO_STORE, meta.id).catch(() => null);
      return { ...meta, base64: cached?.base64 || null };
    }));
    return videos.filter(video => !video.ownerScope || video.ownerScope === ownerScope);
  }

  const local = await galleryGetAll(GALLERY_VIDEO_STORE).catch(() => []);
  await Promise.all(local.filter(video => !video.ownerScope).map(video => {
    video.ownerScope = ownerScope;
    return galleryPut(GALLERY_VIDEO_STORE, video).catch(() => {});
  }));
  return local
    .filter(video => video.ownerScope === ownerScope)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteVideo(id) {
  const existing = await galleryGet(GALLERY_VIDEO_STORE, id).catch(() => null);
  if (existing?.ownerScope && existing.ownerScope !== currentWorkspaceScope()) return;
  await kvPost('deleteVideoMeta', { id }).catch(() => {});
  await galleryDelete(GALLERY_VIDEO_STORE, id).catch(() => {});
}

export async function clearAllVideos() {
  await kvPost('clearVideoMeta').catch(() => {});
  const ownerScope = currentWorkspaceScope();
  const videos = await galleryGetAll(GALLERY_VIDEO_STORE).catch(() => []);
  await Promise.all(videos
    .filter(record => !record.ownerScope || record.ownerScope === ownerScope)
    .map(record => galleryDelete(GALLERY_VIDEO_STORE, record.id).catch(() => {})));
}

export async function countVideos() {
  try {
    const metas = await kvPost('getVideoMeta');
    if (metas?.length) return metas.length;
  } catch { /* fall through */ }
  return (await getAllVideos()).length;
}
