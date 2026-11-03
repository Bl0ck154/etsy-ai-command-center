import { scheduleApi } from '../schedule-api.js';
import { normalizeScheduledPost } from './record.js';

export function createScheduleApprovalClient({ api = scheduleApi } = {}) {
  async function approveScheduledPost(id, { approvedBy = 'admin-ui', note = '' } = {}) {
    const updated = await api.social('approveScheduledPost', { id, approved_by: approvedBy, note });
    return normalizeScheduledPost(updated);
  }

  async function getAdminCanaryReadiness(id, options = {}) {
    return api.social('adminCanaryReadiness', { id, ...options });
  }

  async function unapproveScheduledPost(id, { unapprovedBy = 'admin-ui', reason = '' } = {}) {
    const updated = await api.social('unapproveScheduledPost', { id, unapproved_by: unapprovedBy, reason });
    return normalizeScheduledPost(updated);
  }

  async function restoreScheduledPostToDraft(id, snapshot = {}) {
    const restored = await api.social('restoreScheduledPostToDraft', { id, snapshot: normalizeScheduledPost(snapshot) });
    return {
      ...restored,
      record: normalizeScheduledPost(restored?.record || {}),
    };
  }

  async function recoverQueuedExternalPostToDraft(id) {
    const recovered = await api.social('recoverQueuedExternalPostToDraft', { id });
    return {
      ...recovered,
      record: normalizeScheduledPost(recovered?.record || {}),
      original: normalizeScheduledPost(recovered?.original || {}),
    };
  }

  return {
    approveScheduledPost,
    getAdminCanaryReadiness,
    unapproveScheduledPost,
    restoreScheduledPostToDraft,
    recoverQueuedExternalPostToDraft,
  };
}

const scheduleApprovalClient = createScheduleApprovalClient();
export const approveScheduledPost = scheduleApprovalClient.approveScheduledPost;
export const getAdminCanaryReadiness = scheduleApprovalClient.getAdminCanaryReadiness;
export const unapproveScheduledPost = scheduleApprovalClient.unapproveScheduledPost;
export const restoreScheduledPostToDraft = scheduleApprovalClient.restoreScheduledPostToDraft;
export const recoverQueuedExternalPostToDraft = scheduleApprovalClient.recoverQueuedExternalPostToDraft;
