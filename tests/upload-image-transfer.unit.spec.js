import { test, expect } from '@playwright/test';

import {
  downloadEtsyListingImage,
  isAllowedEtsyImageUrl,
  uploadListingImageBuffer,
} from '../api/upload/image-transfer.js';
import { API_KEY_FULL } from '../api/_etsy.js';

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: key => normalized[String(key).toLowerCase()] || null };
}

test('remote Etsy image allowlist accepts only exact HTTPS i.etsystatic.com paths', () => {
  expect(isAllowedEtsyImageUrl('https://i.etsystatic.com/123/il/abc/photo.jpg')).toBe(true);
  expect(isAllowedEtsyImageUrl('http://i.etsystatic.com/123/photo.jpg')).toBe(false);
  expect(isAllowedEtsyImageUrl('https://evil.example/123/photo.jpg')).toBe(false);
  expect(isAllowedEtsyImageUrl('https://i.etsystatic.com.evil.example/123/photo.jpg')).toBe(false);
  expect(isAllowedEtsyImageUrl('https://user@i.etsystatic.com/123/photo.jpg')).toBe(false);
  expect(isAllowedEtsyImageUrl('https://i.etsystatic.com/../secret')).toBe(false);
  expect(isAllowedEtsyImageUrl('https://i.etsystatic.com/%252e%252e/secret')).toBe(false);
});

test('remote download validates declared type and binary signature', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
  const result = await downloadEtsyListingImage('https://i.etsystatic.com/123/photo.jpg', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'image/jpeg', 'content-length': jpeg.length }),
      body: null,
      arrayBuffer: async () => jpeg,
    }),
  });
  expect(result).toEqual({ buffer: jpeg, mimeType: 'image/jpeg' });

  await expect(downloadEtsyListingImage('https://i.etsystatic.com/123/fake.jpg', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'image/jpeg' }),
      body: null,
      arrayBuffer: async () => Buffer.from('not-a-jpeg'),
    }),
  })).rejects.toMatchObject({ status: 415 });
});

test('remote download rejects declared payloads above configured byte limit', async () => {
  await expect(downloadEtsyListingImage('https://i.etsystatic.com/123/photo.png', {
    maxBytes: 10,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'image/png', 'content-length': 11 }),
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  })).rejects.toMatchObject({ status: 413 });
});

test('multipart upload preserves rank, overwrite and validated alt-text fields', async () => {
  const calls = [];
  const result = await uploadListingImageBuffer({
    token: 'token',
    listingId: '123',
    imageBuffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    mimeType: 'image/jpeg',
    rank: 3,
    overwrite: true,
    altText: 'A clear product photo showing the finished customized portrait',
    shopId: '456',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ listing_image_id: 99 }) };
    },
  });
  expect(result).toEqual({ listing_image_id: 99 });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toContain('/shops/456/listings/123/images');
  expect(calls[0].options.headers).toMatchObject({
    'x-api-key': API_KEY_FULL,
    'Authorization': 'Bearer token',
  });
  const body = calls[0].options.body.toString('utf8');
  expect(body).toContain('name="rank"\r\n\r\n3');
  expect(body).toContain('name="overwrite"\r\n\r\ntrue');
  expect(body).toContain('name="alt_text"');
});
