import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  APPROVAL_CLEAR_FIELDS,
  changesIncludeMedia,
  normalizeScheduledPost,
  normalizeScheduledPosts,
  shouldClearApproval,
  withoutApproval,
} from '../public/utils/schedule/record.js';
import { createScheduleRepository } from '../public/utils/schedule/repository.js';
import { createScheduleApprovalClient } from '../public/utils/schedule/approval-client.js';

test('media normalization flattens nested sources, deduplicates URLs and detects video', () => {
  const record = normalizeScheduledPost({
    media_items: [{ items: [{ url: 'https://cdn/x.jpg' }, { url: 'https://cdn/a.mp4' }] }],
    custom_image_url: 'https://cdn/x.jpg',
    generated_image_url: 'null',
    listing_image_url: 'https://cdn/listing.jpg',
  });
  expect(record.media_items.map(item => item.url)).toEqual(['https://cdn/x.jpg', 'https://cdn/a.mp4', 'https://cdn/listing.jpg']);
  expect(record.media_items[1].type).toBe('video');
  expect(record.custom_image_url).toBe('https://cdn/x.jpg');
  expect(record.generated_image_url).toBeNull();
});

test('post collection normalization deduplicates only records with ids', () => {
  const posts = normalizeScheduledPosts([{ id: '1' }, { id: '1', caption: 'duplicate' }, { caption: 'a' }, { caption: 'b' }]);
  expect(posts).toHaveLength(3);
  expect(posts.filter(post => post.id === '1')).toHaveLength(1);
});

test('approval invalidation fields remain explicit and non-policy changes preserve approval', () => {
  expect(APPROVAL_CLEAR_FIELDS).toContain('caption');
  expect(APPROVAL_CLEAR_FIELDS).toContain('scheduled_at');
  expect(changesIncludeMedia({ media_items: [] })).toBe(true);
  expect(shouldClearApproval({ caption: 'new' })).toBe(true);
  expect(shouldClearApproval({ retry_count: 2 })).toBe(false);
  expect(withoutApproval({ approved_for_publish: true, approved_by: 'owner' })).toMatchObject({
    approved_for_publish: false, approved_by: null, approved_at: null, approval_note: null, approval_source: null,
  });
});

test('KV repository preserves exact actions and clears approval on meaningful updates', async () => {
  const calls = [];
  const api = {
    async kv(action, payload) {
      calls.push({ action, payload });
      if (action === 'getScheduledPosts') return [{ id: 'a' }, { id: 'a' }, { id: 'b' }];
      return payload;
    },
  };
  const repo = createScheduleRepository({ api, now: () => 1234, idFactory: () => 'generated' });
  const saved = await repo.saveScheduledPost({ caption: 'hello' });
  expect(saved).toMatchObject({ id: 'generated', created_at: 1234, caption: 'hello' });
  expect(calls[0].action).toBe('saveScheduledPost');
  expect(await repo.getScheduledPosts()).toHaveLength(2);
  await repo.updateScheduledPost('a', { caption: 'changed', approved_for_publish: true, approved_by: 'old' });
  expect(calls.at(-1)).toMatchObject({
    action: 'updateScheduledPost',
    payload: { id: 'a', caption: 'changed', approved_for_publish: false, approved_by: null },
  });
  await repo.deleteScheduledPost('a');
  expect(calls.at(-1)).toEqual({ action: 'deleteScheduledPost', payload: { id: 'a' } });
});

test('approval client preserves exact Social command payloads and normalized records', async () => {
  const calls = [];
  const api = {
    async social(action, payload) {
      calls.push({ action, payload });
      if (action === 'restoreScheduledPostToDraft') return { ok: true, record: payload.snapshot };
      if (action === 'recoverQueuedExternalPostToDraft') return { record: { id: payload.id }, original: { id: `${payload.id}-old` } };
      return { id: payload.id, custom_image_url: 'https://cdn/x.jpg' };
    },
  };
  const client = createScheduleApprovalClient({ api });
  await client.approveScheduledPost('p1', { approvedBy: 'me', note: 'ok' });
  expect(calls[0]).toEqual({ action: 'approveScheduledPost', payload: { id: 'p1', approved_by: 'me', note: 'ok' } });
  await client.unapproveScheduledPost('p1', { unapprovedBy: 'me', reason: 'edit' });
  expect(calls[1]).toEqual({ action: 'unapproveScheduledPost', payload: { id: 'p1', unapproved_by: 'me', reason: 'edit' } });
  const restored = await client.restoreScheduledPostToDraft('p1', { custom_image_url: 'https://cdn/x.jpg' });
  expect(restored.record.media_items[0].url).toBe('https://cdn/x.jpg');
  const recovered = await client.recoverQueuedExternalPostToDraft('p1');
  expect(recovered.original.id).toBe('p1-old');
});

test('schedule-store public entry is a compatibility facade', () => {
  const source = fs.readFileSync(new URL('../public/utils/schedule-store.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(24);
  expect(source).not.toContain('APPROVAL_CLEAR_FIELDS');
  expect(source).not.toContain('media_items || item.items');
  expect(source).toContain("from './schedule/repository.js'");
  expect(source).toContain("from './schedule/approval-client.js'");
});
