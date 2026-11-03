import { test, expect } from '@playwright/test';

import { createMetaAiApplication } from '../api/meta-ai/application.js';

function createApp(overrides = {}) {
  const calls = [];
  const app = createMetaAiApplication({
    buildCookieHeader: value => String(value || '').trim(),
    getMetaAiCookieHeader: async () => 'saved=1',
    getMetaAiSession: async input => {
      calls.push({ type: 'session', input });
      return { accessToken: 'access-1' };
    },
    getSafeMetaAiStatus: async input => {
      calls.push({ type: 'status', input });
      return { configured: true };
    },
    probeMetaAiGateway: async input => {
      calls.push({ type: 'probe', input });
      return { ok: true };
    },
    generateMetaAiVideo: async input => {
      calls.push({ type: 'video', input });
      return { id: 'video-1' };
    },
    ...overrides,
  });
  return { app, calls };
}

test('status resolves supplied cookies before saved-cookie fallback', async () => {
  const { app, calls } = createApp();
  expect(await app.execute('status', { cookieHeader: ' supplied=1 ' })).toEqual({
    kind: 'status', data: { configured: true },
  });
  expect(calls[0]).toEqual({ type: 'status', input: { cookieHeader: 'supplied=1' } });
});

test('gateway probe resolves session and probes with access token only', async () => {
  const { app, calls } = createApp();
  expect(await app.execute('probeGateway', {})).toEqual({ kind: 'probe', data: { ok: true } });
  expect(calls).toEqual([
    { type: 'session', input: { cookieHeader: 'saved=1' } },
    { type: 'probe', input: { accessToken: 'access-1' } },
  ]);
});

test('animate image validates reference input before provider call', async () => {
  const { app, calls } = createApp();
  await expect(app.execute('animateImage', {})).rejects.toMatchObject({
    message: 'referenceImage, imageUrl, or imagePath required',
    status: 400,
  });
  expect(calls).toHaveLength(0);
});

test('video generation binds resolved cookie header into provider input', async () => {
  const { app, calls } = createApp();
  const result = await app.execute('generateVideo', { prompt: 'hello' });
  expect(result).toEqual({ kind: 'video', video: { id: 'video-1' } });
  expect(calls).toEqual([{
    type: 'video',
    input: { prompt: 'hello', cookieHeader: 'saved=1' },
  }]);
});

test('provider failures carry the active cookie header for HTTP diagnostics', async () => {
  const error = new Error('blocked');
  error.code = 'META_AI_GATEWAY_BLOCKED';
  error.status = 403;
  const { app } = createApp({
    getSafeMetaAiStatus: async () => { throw error; },
  });
  await expect(app.execute('status', { cookies: 'ecto_1_sess=a; rd_challenge=b' })).rejects.toMatchObject({
    code: 'META_AI_GATEWAY_BLOCKED',
    status: 403,
    metaAiCookieHeader: 'ecto_1_sess=a; rd_challenge=b',
  });
});
