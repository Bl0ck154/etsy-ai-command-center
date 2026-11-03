// public/utils/schedule-api.js — browser transport for schedule-store.js

import { kvPost } from './kv-client.js';

export function createScheduleApi({ postKv = kvPost, fetchImpl = fetch } = {}) {
  return {
    kv(action, value, extra = undefined) {
      return extra === undefined
        ? postKv(action, value)
        : postKv(action, value, extra);
    },

    async social(action, payload = {}) {
      const res = await fetchImpl('/api/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `${action} failed`);
      return data.data || data;
    },
  };
}

export const scheduleApi = createScheduleApi();
