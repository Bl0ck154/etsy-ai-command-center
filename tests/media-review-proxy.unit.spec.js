import { expect, test } from '@playwright/test';

import {
  MAX_REVIEW_IMAGE_BYTES,
  isAllowedReviewImageUrl,
  proxyEtsyReviewImage,
} from '../api/media/review-image-proxy.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value; return this; },
  };
}

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: name => normalized[String(name).toLowerCase()] ?? null };
}

test('review proxy allowlist accepts only HTTPS i.etsystatic.com URLs', () => {
  expect(isAllowedReviewImageUrl('https://i.etsystatic.com/123/il/abc/image.jpg')).toBe(true);
  expect(isAllowedReviewImageUrl('http://i.etsystatic.com/123/image.jpg')).toBe(false);
  expect(isAllowedReviewImageUrl('https://evil.example/image.jpg')).toBe(false);
  expect(isAllowedReviewImageUrl('not-a-url')).toBe(false);
});

test('review proxy rejects untrusted URLs before fetching', async () => {
  let fetched = false;
  const res = responseRecorder();
  await proxyEtsyReviewImage({ query: { url: 'https://evil.example/a.png' } }, res, {
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  expect(fetched).toBe(false);
  expect(res.statusCode).toBe(400);
  expect(res.body).toEqual({ error: 'Only Etsy review image URLs are allowed' });
});

test('review proxy preserves successful image headers and body', async () => {
  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const res = responseRecorder();
  await proxyEtsyReviewImage({ query: { image_url: 'https://i.etsystatic.com/123/image.png' } }, res, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'image/png', 'content-length': String(body.length) }),
      arrayBuffer: async () => body,
    }),
  });
  expect(res.statusCode).toBe(200);
  expect(Buffer.from(res.body)).toEqual(body);
  expect(res.headers['content-type']).toBe('image/png');
  expect(res.headers['content-length']).toBe(String(body.length));
  expect(res.headers['cache-control']).toBe('private, max-age=3600');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
});

test('review proxy rejects unsupported content types and oversized declarations', async () => {
  const unsupported = responseRecorder();
  await proxyEtsyReviewImage({ query: { url: 'https://i.etsystatic.com/123/file.bin' } }, unsupported, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'application/octet-stream' }),
      arrayBuffer: async () => Buffer.from([1]),
    }),
  });
  expect(unsupported.statusCode).toBe(502);

  const oversized = responseRecorder();
  await proxyEtsyReviewImage({ query: { url: 'https://i.etsystatic.com/123/large.jpg' } }, oversized, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'image/jpeg', 'content-length': String(MAX_REVIEW_IMAGE_BYTES + 1) }),
      arrayBuffer: async () => Buffer.from([1]),
    }),
  });
  expect(oversized.statusCode).toBe(413);
  expect(oversized.body).toEqual({ error: 'Etsy review image is too large' });
});
