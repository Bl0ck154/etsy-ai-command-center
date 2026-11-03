import { test, expect } from '@playwright/test';

import {
  buildMultipartPayload,
  configuredEtsyVideoUploadTimeoutMs,
  DEFAULT_ETSY_VIDEO_UPLOAD_TIMEOUT_MS,
} from '../api/gpt/etsy-multipart.js';

test('multipart payload streams the original file buffer without Buffer.concat duplication', async () => {
  const fileBuffer = Buffer.from('video-bytes');
  const payload = buildMultipartPayload({ name: 'clip.mp4' }, {
    field: 'video',
    filename: 'clip.mp4',
    mimeType: 'video/mp4',
    buffer: fileBuffer,
  });
  const body = payload.createBody();

  expect(Buffer.isBuffer(body)).toBe(false);
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  expect(chunks).toContain(fileBuffer);
  expect(chunks.reduce((total, chunk) => total + chunk.length, 0)).toBe(payload.contentLength);
  expect(Buffer.concat(chunks).toString('latin1')).toContain('Content-Type: video/mp4');
});

test('video upload timeout defaults to 90 seconds and stays bounded', () => {
  expect(configuredEtsyVideoUploadTimeoutMs({})).toBe(DEFAULT_ETSY_VIDEO_UPLOAD_TIMEOUT_MS);
  expect(configuredEtsyVideoUploadTimeoutMs({ GPT_ETSY_VIDEO_UPLOAD_TIMEOUT_MS: '120000' })).toBe(120_000);
  expect(configuredEtsyVideoUploadTimeoutMs({ GPT_ETSY_VIDEO_UPLOAD_TIMEOUT_MS: '1000' })).toBe(30_000);
  expect(configuredEtsyVideoUploadTimeoutMs({ GPT_ETSY_VIDEO_UPLOAD_TIMEOUT_MS: '900000' })).toBe(180_000);
});
