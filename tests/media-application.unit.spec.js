import { expect, test } from '@playwright/test';

import { createMediaApplication } from '../api/media/application.js';

function baseDependencies(overrides = {}) {
  return {
    generateImages: async input => ({ success: true, input }),
    listModels: async () => [{ key: 'nano-banana-2', id: 'gemini-image', provider: 'gemini' }],
    generateVideo: async input => ({ id: 'video-1', input }),
    getCookieHeader: async () => 'session=cookie',
    analyzeImage: async input => `analysis:${input.prompt || ''}`,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/png']]),
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    }),
    ...overrides,
  };
}

test('media application delegates image generation without changing action fields', async () => {
  let received = null;
  const application = createMediaApplication(baseDependencies({
    generateImages: async input => {
      received = input;
      return { success: true, images: [] };
    },
  }));

  await expect(application.generateImages({
    prompt: 'portrait',
    prompts: ['one', 'two'],
    model: 'nano-banana-2',
    provider: 'gemini',
    count: 2,
    aspectRatio: '4:5',
    referenceImage: { base64: 'abc', mimeType: 'image/png' },
  })).resolves.toEqual({ success: true, images: [] });

  expect(received).toEqual({
    prompt: 'portrait',
    prompts: ['one', 'two'],
    model: 'nano-banana-2',
    provider: 'gemini',
    count: 2,
    aspectRatio: '4:5',
    referenceImage: { base64: 'abc', mimeType: 'image/png' },
  });
});

test('media application keeps model listing response contract', async () => {
  const application = createMediaApplication(baseDependencies());
  await expect(application.listAvailableModels()).resolves.toEqual({
    success: true,
    models: [{ key: 'nano-banana-2', id: 'gemini-image', provider: 'gemini' }],
  });
});

test('video generation requires a prompt and binds saved Meta cookie', async () => {
  let received = null;
  const application = createMediaApplication(baseDependencies({
    generateVideo: async input => {
      received = input;
      return { id: 'video-2' };
    },
  }));

  await expect(application.generateVideo({})).rejects.toMatchObject({ status: 400, message: 'prompt required' });
  await expect(application.generateVideo({
    prompt: 'slow camera push',
    referenceImage: { base64: 'abc', mimeType: 'image/png' },
    imageUrl: 'https://example.test/reference.png',
  })).resolves.toEqual({ success: true, video: { id: 'video-2' } });

  expect(received).toEqual({
    cookieHeader: 'session=cookie',
    prompt: 'slow camera push',
    referenceImage: { base64: 'abc', mimeType: 'image/png' },
    imageUrl: 'https://example.test/reference.png',
  });
});

test('image animation preserves URL-to-base64 fallback and default prompt', async () => {
  let received = null;
  const application = createMediaApplication(baseDependencies({
    generateVideo: async input => {
      received = input;
      return { id: 'animation-1' };
    },
  }));

  await expect(application.animateImage({ imageUrl: 'https://example.test/image.png' })).resolves.toEqual({
    success: true,
    video: { id: 'animation-1' },
  });
  expect(received.cookieHeader).toBe('session=cookie');
  expect(received.prompt).toBe('Animate this image into a short video.');
  expect(received.referenceImage).toEqual({
    base64: Buffer.from([1, 2, 3]).toString('base64'),
    mimeType: 'image/png',
  });
});

test('image animation surfaces the historical URL-fetch error as HTTP 400 policy', async () => {
  const application = createMediaApplication(baseDependencies({
    fetchImpl: async () => ({ ok: false, status: 404 }),
  }));
  await expect(application.animateImage({ imageUrl: 'https://example.test/missing.png' })).rejects.toMatchObject({
    status: 400,
    message: 'Failed to fetch image: 404',
  });
});

test('Gemini analysis is application-owned and preserves success shape', async () => {
  let received = null;
  const application = createMediaApplication(baseDependencies({
    analyzeImage: async input => {
      received = input;
      return 'described';
    },
  }));
  await expect(application.analyzeImage({
    referenceImage: { base64: 'abc', mimeType: 'image/jpeg' },
    prompt: 'Describe product',
  })).resolves.toEqual({ success: true, analysis: 'described' });
  expect(received).toEqual({
    referenceImage: { base64: 'abc', mimeType: 'image/jpeg' },
    prompt: 'Describe product',
  });
});
