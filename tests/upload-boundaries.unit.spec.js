import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../api/upload.js', import.meta.url), 'utf8');
const application = fs.readFileSync(new URL('../api/upload/application.js', import.meta.url), 'utf8');
const transfer = fs.readFileSync(new URL('../api/upload/image-transfer.js', import.meta.url), 'utf8');

test('upload route stays a token/auth HTTP facade', () => {
  expect(route).toContain("from './upload/application.js'");
  expect(route).toContain("from './upload/image-transfer.js'");
  expect(route).toContain('uploadApplication.execute');
  expect(route).not.toContain('new AbortController()');
  expect(route).not.toContain('i.etsystatic.com');
  expect(route).not.toContain('multipart/form-data; boundary=');
  expect(route).not.toContain("method: 'DELETE'");
});

test('image transfer owner contains SSRF, MIME, byte-limit and multipart mechanics', () => {
  expect(transfer).toContain("url.hostname !== 'i.etsystatic.com'");
  expect(transfer).toContain('MAX_REMOTE_IMAGE_BYTES');
  expect(transfer).toContain('hasMatchingImageSignature');
  expect(transfer).toContain('multipart/form-data; boundary=${boundary}');
  expect(transfer).toContain('validateListingImageAltText');
});

test('application owns Etsy image CRUD action routing', () => {
  expect(application).toContain("input.action === 'deleteImage'");
  expect(application).toContain("input.action === 'uploadImageFromUrl'");
  expect(application).toContain("input.action === 'getImages'");
  expect(application).toContain('/images/${input.listing_image_id}');
});

test('legacy image-transfer exports remain available through upload facade', () => {
  for (const name of [
    'MAX_REMOTE_IMAGE_BYTES', 'REMOTE_IMAGE_TIMEOUT_MS', 'uploadImageAction',
    'isAllowedEtsyImageUrl', 'downloadEtsyListingImage', 'uploadListingImageBuffer',
  ]) expect(route).toContain(name);
});
