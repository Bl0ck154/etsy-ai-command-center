import { scheduleApi } from '../schedule-api.js';
import {
  changesIncludeMedia,
  generateId,
  normalizeScheduledPost,
  normalizeScheduledPosts,
  shouldClearApproval,
  withoutApproval,
} from './record.js';

export function createScheduleRepository({ api = scheduleApi, now = () => Date.now(), idFactory = generateId } = {}) {
  async function saveScheduledPost(post) {
    const record = normalizeScheduledPost({ id: post.id || idFactory(), ...post, created_at: post.created_at || now() });
    const saved = await api.kv('saveScheduledPost', record);
    return Array.isArray(saved) ? saved.map(normalizeScheduledPost) : normalizeScheduledPost(saved || record);
  }

  async function getScheduledPosts() {
    const posts = normalizeScheduledPosts((await api.kv('getScheduledPosts')) || []);
    return normalizeScheduledPosts(posts);
  }

  async function updateScheduledPost(id, changes) {
    const rawPayload = changesIncludeMedia(changes)
      ? normalizeScheduledPost({ ...changes, id })
      : { ...changes, id };
    const payload = shouldClearApproval(rawPayload) ? withoutApproval(rawPayload) : rawPayload;
    const updated = await api.kv('updateScheduledPost', payload);
    return normalizeScheduledPost(updated);
  }

  async function deleteScheduledPost(id) {
    return api.kv('deleteScheduledPost', { id });
  }

  return { saveScheduledPost, getScheduledPosts, updateScheduledPost, deleteScheduledPost };
}

const scheduleRepository = createScheduleRepository();
export const saveScheduledPost = scheduleRepository.saveScheduledPost;
export const getScheduledPosts = scheduleRepository.getScheduledPosts;
export const updateScheduledPost = scheduleRepository.updateScheduledPost;
export const deleteScheduledPost = scheduleRepository.deleteScheduledPost;
