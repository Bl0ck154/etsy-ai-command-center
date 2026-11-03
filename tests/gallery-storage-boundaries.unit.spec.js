import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  GALLERY_BLOB_STORE,
  GALLERY_DB_NAME,
  GALLERY_DB_VERSION,
  GALLERY_IMAGE_STORE,
  GALLERY_IMAGE_SUMMARY_STORE,
  GALLERY_VIDEO_STORE,
} from '../public/utils/gallery/idb-driver.js';
import { imageSummaryFrom, isValidImageRecord } from '../public/utils/gallery/image-record.js';

const validBase64 = 'QUJDREVGR0hJSktMTU5PUA==';

test('gallery image validation preserves historical encoded-image contract', () => {
  expect(isValidImageRecord({ id: '1', base64: validBase64, mimeType: 'image/png' })).toBe(true);
  expect(isValidImageRecord({ id: '1', base64: `  ${validBase64}\n`, mimeType: 'image/jpeg' })).toBe(true);
  expect(isValidImageRecord({ id: '1', base64: 'data:image/png;base64,AAAA', mimeType: 'image/png' })).toBe(false);
  expect(isValidImageRecord({ id: '1', base64: 'undefined', mimeType: 'image/png' })).toBe(false);
  expect(isValidImageRecord({ id: '1', base64: 'short', mimeType: 'image/png' })).toBe(false);
  expect(isValidImageRecord({ id: '1', base64: validBase64, mimeType: 'video/mp4' })).toBe(false);
});

test('gallery image summary keeps metadata, thumbnail and owner fallback', () => {
  expect(imageSummaryFrom({
    id: 'img-1',
    prompt: 'portrait',
    slotLabel: 'Cover',
    listingTitle: 'Listing',
    mimeType: 'image/webp',
    createdAt: '123',
  }, 'data:image/jpeg;base64,thumb', 'alice:shop1')).toEqual({
    id: 'img-1',
    prompt: 'portrait',
    slotLabel: 'Cover',
    listingTitle: 'Listing',
    mimeType: 'image/webp',
    createdAt: 123,
    ownerScope: 'alice:shop1',
    thumbnailDataUrl: 'data:image/jpeg;base64,thumb',
  });
});

test('gallery IndexedDB schema remains compatible', () => {
  expect(GALLERY_DB_NAME).toBe('etsy-img-cache');
  expect(GALLERY_DB_VERSION).toBe(4);
  expect(GALLERY_BLOB_STORE).toBe('blobs');
  expect(GALLERY_IMAGE_STORE).toBe('images');
  expect(GALLERY_VIDEO_STORE).toBe('videos');
  expect(GALLERY_IMAGE_SUMMARY_STORE).toBe('image-summaries');
});

test('image-store public entry is a compatibility facade', () => {
  const source = fs.readFileSync(new URL('../public/utils/image-store.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(30);
  expect(source).not.toContain('indexedDB.open');
  expect(source).not.toContain("kvPost('");
  expect(source).not.toContain('createThumbnailDataUrl');
  expect(source).toContain("./gallery/image-repository.js");
  expect(source).toContain("./gallery/video-repository.js");
});

test('gallery responsibilities stay in focused owners', () => {
  const driver = fs.readFileSync(new URL('../public/utils/gallery/idb-driver.js', import.meta.url), 'utf8');
  const images = fs.readFileSync(new URL('../public/utils/gallery/image-repository.js', import.meta.url), 'utf8');
  const videos = fs.readFileSync(new URL('../public/utils/gallery/video-repository.js', import.meta.url), 'utf8');
  const thumbnail = fs.readFileSync(new URL('../public/utils/gallery/thumbnail.js', import.meta.url), 'utf8');
  expect(driver).toContain('indexedDB.open');
  expect(images).toContain("kvPost('saveGalleryMeta'");
  expect(videos).toContain("kvPost('saveVideoMeta'");
  expect(thumbnail).toContain('THUMBNAIL_MAX_EDGE = 320');
  expect(thumbnail).toContain('THUMBNAIL_QUALITY = 0.78');
});
