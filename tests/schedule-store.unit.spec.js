import { test, expect } from '@playwright/test';
import {
  deleteScheduledPost,
  getScheduledPosts,
  saveScheduledPost,
  updateScheduledPost,
} from '../public/utils/schedule-store.js';

test('schedule store fails closed when server persistence is unavailable', async () => {
  const originalFetch = global.fetch;
  const originalLocalStorage = global.localStorage;
  const localWrites = [];
  global.localStorage = {
    getItem: () => JSON.stringify([{ id: 'browser-ghost-post' }]),
    setItem: (...args) => localWrites.push(args),
  };
  global.fetch = async () => new Response(JSON.stringify({ error: 'KV unavailable' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    await expect(getScheduledPosts()).rejects.toThrow('kv_unavailable');
    await expect(saveScheduledPost({ id: 'new-post', platform: 'instagram' })).rejects.toThrow('kv_unavailable');
    await expect(updateScheduledPost('new-post', { caption: 'Changed' })).rejects.toThrow('kv_unavailable');
    await expect(deleteScheduledPost('new-post')).rejects.toThrow('kv_unavailable');
    expect(localWrites).toEqual([]);
  } finally {
    global.fetch = originalFetch;
    if (originalLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = originalLocalStorage;
  }
});

test('schedule store normalizes records returned by the server', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    data: [{
      id: 'server-post',
      custom_image_url: 'https://img.example.test/one.jpg',
      media_items: [{ url: 'https://img.example.test/one.jpg' }],
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const posts = await getScheduledPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].media_items).toEqual([
      expect.objectContaining({ url: 'https://img.example.test/one.jpg', type: 'image' }),
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});
