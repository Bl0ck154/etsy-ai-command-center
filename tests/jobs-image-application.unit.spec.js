import { expect, test } from '@playwright/test';

import {
  createImageGenerationApplication,
  resolveImageJobTimeoutMs,
} from '../api/jobs/image-generation-application.js';

test('image job timeout remains clamped to 10-120 seconds', () => {
  expect(resolveImageJobTimeoutMs({})).toBe(120_000);
  expect(resolveImageJobTimeoutMs({ timeoutMs: 1 })).toBe(10_000);
  expect(resolveImageJobTimeoutMs({ timeoutMs: 30_000 })).toBe(30_000);
  expect(resolveImageJobTimeoutMs({ timeoutMs: 999_999 })).toBe(120_000);
});

test('multi-image jobs fan out prompts and preserve output ordering metadata', async () => {
  const calls = [];
  const application = createImageGenerationApplication({
    generateImages: async input => {
      calls.push(input);
      if (input.prompt.includes('image 2 of 3')) throw new Error('second failed');
      return {
        success: true,
        provider: 'gemini',
        model: 'model-a',
        images: [{ base64: input.prompt, mimeType: 'image/png' }],
      };
    },
  });

  const result = await application.generateJobImages({
    prompt: 'Base prompt',
    count: 3,
    aspectRatio: '4:5',
  }, new AbortController().signal);

  expect(calls).toHaveLength(3);
  expect(calls.every(call => call.count === 1 && call.aspectRatio === '4:5')).toBe(true);
  expect(result.images).toHaveLength(2);
  expect(result.images.map(image => image.prompt_index)).toEqual([0, 2]);
  expect(result.images.every(image => image.provider === 'gemini' && image.model === 'model-a')).toBe(true);
  expect(result.warning).toContain('Generated 2 of 3 images.');
  expect(result.warning).toContain('second failed');
});

test('image job start schedules only a newly-created job', () => {
  let scheduled = 0;
  const job = { id: 'job_image_1', type: 'image_generation', status: 'queued' };
  const application = createImageGenerationApplication({
    createJob: () => ({ job, created: true }),
    schedule: () => { scheduled += 1; },
  });
  expect(application.start({ prompt: 'image' }, 'owner')).toBe(job);
  expect(scheduled).toBe(1);

  const existingApplication = createImageGenerationApplication({
    createJob: () => ({ job, created: false }),
    schedule: () => { scheduled += 1; },
  });
  expect(existingApplication.start({ prompt: 'image' }, 'owner')).toBe(job);
  expect(scheduled).toBe(1);
});

test('timeout-like image errors preserve terminal timeout message', async () => {
  const updates = [];
  const application = createImageGenerationApplication({
    generateImages: async () => { throw new Error('provider timeout'); },
    updateJob: (id, patch) => { updates.push({ id, patch }); },
    setTimer: () => 123,
    clearTimer: () => {},
  });

  await application.run('job_image_timeout', { prompt: 'image', timeoutMs: 20_000 });
  expect(updates.at(-1).patch).toEqual({
    status: 'error',
    progress: 100,
    message: 'Image generation timed out after 20s',
    error: 'Image generation timed out after 20s',
  });
});
