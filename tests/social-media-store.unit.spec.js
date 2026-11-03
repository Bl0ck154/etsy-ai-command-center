import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createSocialMediaStore,
  SOCIAL_HERMES_MAX_MEDIA_ASSET_BYTES,
} from '../api/modules/social/index.js';
import {
  readPermanentSocialHermesMediaAsset,
  storeSocialHermesMediaAsset,
} from '../api/social.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(size = 1200) {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(size, 0x5a)]);
}

function expectedAssetId(bytes, mimeType) {
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  return `shmedia_${crypto.createHash('sha256').update(`${mimeType}\0${checksum}`).digest('hex').slice(0, 24)}`;
}

test.describe('persistent Social media store', () => {
  const temporaryDirectories = [];

  const makeStorageDir = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-social-media-store-'));
    temporaryDirectories.push(directory);
    return directory;
  };

  test.afterEach(() => {
    while (temporaryDirectories.length) {
      fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
  });

  test('stores and reads the exact content-addressed asset contract', async () => {
    const storageDir = makeStorageDir();
    const bytes = pngBytes();
    const store = createSocialMediaStore({
      storageDir,
      now: () => new Date('2026-08-09T12:34:56.000Z'),
    });
    const renderSpecSha256 = 'A'.repeat(64);
    const qualityReview = { approved: true, rationale: 'Exact frame passed.' };
    const geometry = {
      width: 1200,
      height: 1500,
      requested_aspect_ratio: '4:5',
      actual_aspect_ratio: 0.8,
      normalization_applied: true,
      normalization_mode: 'attention_cover_crop',
      crop_focus: 'attention',
      crop: { width: 1200, height: 1500, position: 'attention' },
      padding: null,
    };

    const stored = await store.storeAsset({
      base64: bytes.toString('base64'),
      publicBaseUrl: 'https://manager.example.test',
      mimeType: 'image/png',
      prompt: 'Content-addressed product frame',
      alt: 'A product frame',
      source: 'generated_image',
      qualityReview,
      geometry,
      renderSpecSha256,
    });
    const expectedId = expectedAssetId(bytes, 'image/png');

    expect(stored).toMatchObject({
      id: expectedId,
      source: 'generated_image',
      type: 'image',
      mime_type: 'image/png',
      url: `https://manager.example.test/api/social?action=mediaAsset&id=${expectedId}`,
      permanent: true,
      render_spec_sha256: renderSpecSha256.toLowerCase(),
      quality_review: qualityReview,
      width: 1200,
      height: 1500,
    });
    expect(fs.readdirSync(storageDir).sort()).toEqual([`${expectedId}.json`, `${expectedId}.png`]);
    const persistedMetadata = JSON.parse(
      fs.readFileSync(path.join(storageDir, `${expectedId}.json`), 'utf8'),
    );
    expect(persistedMetadata).toMatchObject({
      schema_version: 1,
      record_type: 'social_media_asset',
      asset: {
        id: expectedId,
        filename: `${expectedId}.png`,
        checksum_sha256: stored.checksum_sha256,
      },
    });

    const read = await store.readAsset(expectedId);
    expect(read).toMatchObject({
      id: expectedId,
      created_at: '2026-08-09T12:34:56.000Z',
      filename: `${expectedId}.png`,
      mime_type: 'image/png',
      permanent: true,
    });
    expect(read.bytes).toEqual(bytes);
    expect(read.checksum_sha256).toBe(stored.checksum_sha256);
    expect(read).not.toHaveProperty('schema_version');
  });

  test('reads and atomically migrates legacy unwrapped metadata without changing asset identity or bytes', async () => {
    const storageDir = makeStorageDir();
    const bytes = pngBytes();
    const id = expectedAssetId(bytes, 'image/png');
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    const legacy = {
      id,
      mime_type: 'image/png',
      created_at: '2026-07-01T00:00:00.000Z',
      prompt: 'Legacy prompt',
      alt: 'Legacy alt text',
      source: 'generated_image',
      checksum_sha256: checksum,
      bytes: bytes.length,
      filename: `${id}.png`,
      permanent: true,
    };
    fs.writeFileSync(path.join(storageDir, `${id}.png`), bytes);
    fs.writeFileSync(
      path.join(storageDir, `${id}.json`),
      JSON.stringify(legacy, null, 2),
    );
    const store = createSocialMediaStore({ storageDir });

    const read = await store.readAsset(id);

    const { bytes: _legacyByteCount, ...legacyMetadata } = legacy;
    expect(read).toMatchObject(legacyMetadata);
    expect(read.bytes).toEqual(bytes);
    expect(read).not.toHaveProperty('schema_version');
    const migrated = JSON.parse(
      fs.readFileSync(path.join(storageDir, `${id}.json`), 'utf8'),
    );
    expect(migrated).toEqual({
      schema_version: 1,
      record_type: 'social_media_asset',
      asset: legacy,
    });
  });

  test('normalizes image/jpg and preserves the jpg filename and stable id', async () => {
    const storageDir = makeStorageDir();
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const store = createSocialMediaStore({ storageDir });
    const stored = await store.storeAsset({
      base64: bytes.toString('base64'),
      publicBaseUrl: 'https://manager.example.test',
      mimeType: 'image/jpg',
    });

    expect(stored.id).toBe(expectedAssetId(bytes, 'image/jpeg'));
    expect(stored.mime_type).toBe('image/jpeg');
    expect(fs.existsSync(path.join(storageDir, `${stored.id}.jpg`))).toBe(true);
  });

  test('rejects MIME magic mismatches and assets above the existing byte limit', async () => {
    const store = createSocialMediaStore({ storageDir: makeStorageDir() });
    await expect(store.storeAsset({
      base64: pngBytes().toString('base64'),
      publicBaseUrl: 'https://manager.example.test',
      mimeType: 'image/jpeg',
    })).rejects.toThrow('Generated media bytes do not match the declared image MIME type.');

    const oversized = Buffer.alloc(SOCIAL_HERMES_MAX_MEDIA_ASSET_BYTES + 1);
    PNG_MAGIC.copy(oversized);
    await expect(store.storeAsset({
      base64: oversized.toString('base64'),
      publicBaseUrl: 'https://manager.example.test',
      mimeType: 'image/png',
    })).rejects.toThrow('Generated media asset is too large for Social Hermes public asset storage.');
  });

  test('keeps existing files immutable and detects bytes or filename tampering', async () => {
    const storageDir = makeStorageDir();
    const bytes = pngBytes();
    const store = createSocialMediaStore({ storageDir });
    const first = await store.storeAsset({
      base64: bytes.toString('base64'),
      publicBaseUrl: 'https://manager.example.test',
      mimeType: 'image/png',
      prompt: 'first immutable metadata',
    });
    await store.storeAsset({
      base64: bytes.toString('base64'),
      publicBaseUrl: 'https://manager.example.test',
      mimeType: 'image/png',
      prompt: 'must not overwrite metadata',
    });
    expect((await store.readAsset(first.id)).prompt).toBe('first immutable metadata');

    fs.writeFileSync(path.join(storageDir, `${first.id}.png`), Buffer.concat([PNG_MAGIC, Buffer.alloc(30, 0x01)]));
    await expect(store.readAsset(first.id)).rejects.toThrow('Stored media checksum mismatch.');

    const metadataPath = path.join(storageDir, `${first.id}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    fs.writeFileSync(metadataPath, JSON.stringify({
      ...metadata,
      asset: { ...metadata.asset, filename: '../outside.png' },
    }));
    await expect(store.readAsset(first.id)).rejects.toThrow('Invalid stored media filename.');
  });

  test('rejects corrupt, unsupported, or identity-mismatched metadata before returning bytes', async () => {
    const storageDir = makeStorageDir();
    const bytes = pngBytes();
    const store = createSocialMediaStore({ storageDir });
    const stored = await store.storeAsset({
      base64: bytes.toString('base64'),
      publicBaseUrl: 'https://manager.example.test',
      mimeType: 'image/png',
    });
    const metadataPath = path.join(storageDir, `${stored.id}.json`);
    const current = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    fs.writeFileSync(metadataPath, '{not valid JSON');
    await expect(store.readAsset(stored.id)).rejects.toThrow('Invalid stored media metadata JSON.');

    fs.writeFileSync(metadataPath, JSON.stringify({ ...current, schema_version: 99 }));
    await expect(store.readAsset(stored.id)).rejects.toThrow('Unsupported stored media metadata schema.');

    fs.writeFileSync(metadataPath, JSON.stringify({
      ...current,
      asset: { ...current.asset, id: 'shmedia_wrong' },
    }));
    await expect(store.readAsset(stored.id)).rejects.toThrow('Stored media asset id mismatch.');
  });

  test('preserves the missing-public-base error after immutable persistence', async () => {
    const storageDir = makeStorageDir();
    const bytes = pngBytes();
    const id = expectedAssetId(bytes, 'image/png');
    const store = createSocialMediaStore({ storageDir });

    await expect(store.storeAsset({ base64: bytes.toString('base64'), mimeType: 'image/png' }))
      .rejects.toThrow('PUBLIC_BASE_URL/host unavailable; cannot create public media URL.');
    expect(fs.existsSync(path.join(storageDir, `${id}.png`))).toBe(true);
    expect(fs.existsSync(path.join(storageDir, `${id}.json`))).toBe(true);
  });

  test('legacy social facade preserves req-based URL composition and read exports', async () => {
    const storageDir = makeStorageDir();
    const originalStorageDir = process.env.SOCIAL_HERMES_MEDIA_STORAGE_DIR;
    process.env.SOCIAL_HERMES_MEDIA_STORAGE_DIR = storageDir;
    const bytes = pngBytes();
    try {
      const stored = await storeSocialHermesMediaAsset({
        req: { headers: { host: 'manager.example.test', 'x-forwarded-proto': 'https' } },
        base64: bytes.toString('base64'),
        mimeType: 'image/png',
      });
      expect(stored.url).toBe(`https://manager.example.test/api/social?action=mediaAsset&id=${stored.id}`);
      expect((await readPermanentSocialHermesMediaAsset(stored.id)).bytes).toEqual(bytes);
    } finally {
      if (originalStorageDir === undefined) delete process.env.SOCIAL_HERMES_MEDIA_STORAGE_DIR;
      else process.env.SOCIAL_HERMES_MEDIA_STORAGE_DIR = originalStorageDir;
    }
  });
});
