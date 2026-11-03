import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

export const SOCIAL_HERMES_MAX_MEDIA_ASSET_BYTES = 8 * 1024 * 1024;

const DEFAULT_SOCIAL_HERMES_MEDIA_STORAGE_DIR = path.join(process.cwd(), 'data', 'social-media-assets');
const SOCIAL_MEDIA_METADATA_SCHEMA_VERSION = 1;
const SOCIAL_MEDIA_METADATA_RECORD_TYPE = 'social_media_asset';

export function normalizeSocialMediaMimeType(value = '') {
  const mime = String(value || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  return /^image\/(png|jpeg|webp|gif)$/.test(mime) ? mime : 'image/png';
}

export function socialMediaExtensionForMimeType(mime = 'image/png') {
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'png';
}

function imageBase64ByteSize(base64 = '') {
  return Buffer.byteLength(String(base64 || '').replace(/\s+/g, ''), 'base64');
}

function socialMediaBytesMatchMimeType(bytes, mime) {
  if (mime === 'image/png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mime === 'image/webp') {
    return bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
}

function configuredSocialMediaStorageDir() {
  return process.env.SOCIAL_HERMES_MEDIA_STORAGE_DIR || DEFAULT_SOCIAL_HERMES_MEDIA_STORAGE_DIR;
}

function socialMediaMetadataEnvelope(asset) {
  return {
    schema_version: SOCIAL_MEDIA_METADATA_SCHEMA_VERSION,
    record_type: SOCIAL_MEDIA_METADATA_RECORD_TYPE,
    asset,
  };
}

function parseSocialMediaMetadata(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid stored media metadata JSON.');
  }
  if (Object.prototype.hasOwnProperty.call(parsed || {}, 'schema_version')) {
    if (parsed.schema_version !== SOCIAL_MEDIA_METADATA_SCHEMA_VERSION) {
      throw new Error('Unsupported stored media metadata schema.');
    }
    if (
      parsed.record_type !== SOCIAL_MEDIA_METADATA_RECORD_TYPE
      || !parsed.asset
      || typeof parsed.asset !== 'object'
      || Array.isArray(parsed.asset)
    ) throw new Error('Invalid stored media metadata record.');
    return { asset: parsed.asset, legacy: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid stored media metadata record.');
  }
  return { asset: parsed, legacy: true };
}

export function createSocialMediaStore({
  filesystem = fs,
  storageDir = configuredSocialMediaStorageDir,
  now = () => new Date(),
} = {}) {
  const resolveStorageDir = () => String(typeof storageDir === 'function' ? storageDir() : storageDir || '');

  const writeMetadataAtomic = async (metadataPath, asset) => {
    const temporary = `${metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await filesystem.writeFile(
        temporary,
        JSON.stringify(socialMediaMetadataEnvelope(asset), null, 2),
        { mode: 0o640 },
      );
      await filesystem.rename(temporary, metadataPath);
    } finally {
      await filesystem.rm(temporary, { force: true }).catch(() => {});
    }
  };

  const writeImmutableFile = async (filePath, contents, options = {}) => {
    try {
      await filesystem.writeFile(filePath, contents, { ...options, flag: 'wx' });
    } catch (err) {
      if (err?.code === 'EEXIST') return;
      try {
        await filesystem.access(filePath);
        return;
      } catch {
        throw err;
      }
    }
  };

  const storeAsset = async ({
    base64,
    publicBaseUrl = '',
    mimeType = 'image/png',
    prompt = '',
    alt = '',
    source = 'generated_image',
    qualityReview = null,
    geometry = null,
    renderSpecSha256 = '',
  }) => {
    const cleanBase64 = String(base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    if (!cleanBase64) throw new Error('Generated media has no base64 data to store.');
    const byteCount = imageBase64ByteSize(cleanBase64);
    if (byteCount > SOCIAL_HERMES_MAX_MEDIA_ASSET_BYTES) {
      throw new Error('Generated media asset is too large for Social Hermes public asset storage.');
    }
    const mime = normalizeSocialMediaMimeType(mimeType);
    const bytes = Buffer.from(cleanBase64, 'base64');
    if (!socialMediaBytesMatchMimeType(bytes, mime)) {
      throw new Error('Generated media bytes do not match the declared image MIME type.');
    }
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    const stableAssetKey = crypto.createHash('sha256').update(`${mime}\0${checksum}`).digest('hex').slice(0, 24);
    const id = `shmedia_${stableAssetKey}`;
    const extension = socialMediaExtensionForMimeType(mime);
    const directory = resolveStorageDir();
    const filePath = path.join(directory, `${id}.${extension}`);
    const metadataPath = path.join(directory, `${id}.json`);
    const asset = {
      id,
      mime_type: mime,
      created_at: new Date(now()).toISOString(),
      prompt: String(prompt || '').slice(0, 1800),
      alt: String(alt || 'Generated social media image').slice(0, 240),
      source,
      checksum_sha256: checksum,
      bytes: bytes.length,
      filename: path.basename(filePath),
      permanent: true,
      ...(/^[a-f0-9]{64}$/i.test(String(renderSpecSha256 || '')) ? {
        render_spec_sha256: String(renderSpecSha256).toLowerCase(),
      } : {}),
      ...(geometry && typeof geometry === 'object' ? {
        width: Number(geometry.width) || null,
        height: Number(geometry.height) || null,
        requested_aspect_ratio: String(geometry.requested_aspect_ratio || ''),
        actual_aspect_ratio: Number(geometry.actual_aspect_ratio) || null,
        original_width: Number(geometry.original_width) || null,
        original_height: Number(geometry.original_height) || null,
        original_aspect_ratio: Number(geometry.original_aspect_ratio) || null,
        aspect_ratio_normalized: geometry.normalization_applied === true,
        normalization_mode: String(geometry.normalization_mode || 'none'),
        crop_focus: String(geometry.crop_focus || ''),
        crop: geometry.crop || null,
        padding: geometry.padding || null,
      } : {}),
      ...(qualityReview && typeof qualityReview === 'object' ? { quality_review: qualityReview } : {}),
    };
    await filesystem.mkdir(directory, { recursive: true });
    await writeImmutableFile(filePath, bytes, { mode: 0o640 });
    await writeImmutableFile(
      metadataPath,
      JSON.stringify(socialMediaMetadataEnvelope(asset), null, 2),
      { mode: 0o640 },
    );
    const base = String(publicBaseUrl || '');
    if (!base) throw new Error('PUBLIC_BASE_URL/host unavailable; cannot create public media URL.');
    return {
      id,
      source,
      type: 'image',
      mime_type: mime,
      url: `${base}/api/social?action=mediaAsset&id=${encodeURIComponent(id)}`,
      alt: asset.alt,
      prompt: asset.prompt,
      permanent: true,
      checksum_sha256: checksum,
      ...(asset.render_spec_sha256 ? { render_spec_sha256: asset.render_spec_sha256 } : {}),
      ...(geometry && typeof geometry === 'object' ? {
        width: Number(geometry.width) || null,
        height: Number(geometry.height) || null,
        requested_aspect_ratio: String(geometry.requested_aspect_ratio || ''),
        actual_aspect_ratio: Number(geometry.actual_aspect_ratio) || null,
        original_width: Number(geometry.original_width) || null,
        original_height: Number(geometry.original_height) || null,
        original_aspect_ratio: Number(geometry.original_aspect_ratio) || null,
        aspect_ratio_normalized: geometry.normalization_applied === true,
        normalization_mode: String(geometry.normalization_mode || 'none'),
        crop_focus: String(geometry.crop_focus || ''),
        crop: geometry.crop || null,
      } : {}),
      ...(asset.quality_review ? { quality_review: asset.quality_review } : {}),
    };
  };

  const readAsset = async id => {
    const directory = resolveStorageDir();
    const metadataPath = path.join(directory, `${id}.json`);
    const raw = await filesystem.readFile(metadataPath, 'utf8');
    const { asset, legacy } = parseSocialMediaMetadata(raw);
    if (String(asset.id || '') !== id) throw new Error('Stored media asset id mismatch.');
    const declaredMime = String(asset.mime_type || asset.mimeType || '')
      .toLowerCase()
      .replace('image/jpg', 'image/jpeg');
    if (!/^image\/(png|jpeg|webp|gif)$/.test(declaredMime)) {
      throw new Error('Invalid stored media MIME type.');
    }
    const filename = path.basename(String(asset.filename || ''));
    const expectedFilename = `${id}.${socialMediaExtensionForMimeType(declaredMime)}`;
    if (
      !filename
      || filename !== expectedFilename
      || String(asset.filename || '') !== expectedFilename
    ) throw new Error('Invalid stored media filename.');
    const bytes = await filesystem.readFile(path.join(directory, filename));
    if (!socialMediaBytesMatchMimeType(bytes, declaredMime)) {
      throw new Error('Stored media bytes do not match the declared image MIME type.');
    }
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    if (asset.checksum_sha256 && checksum !== asset.checksum_sha256) {
      throw new Error('Stored media checksum mismatch.');
    }
    const expectedId = `shmedia_${crypto.createHash('sha256')
      .update(`${declaredMime}\0${checksum}`)
      .digest('hex')
      .slice(0, 24)}`;
    if (expectedId !== id) throw new Error('Stored media content identity mismatch.');
    if (
      Object.prototype.hasOwnProperty.call(asset, 'bytes')
      && (!Number.isInteger(Number(asset.bytes)) || Number(asset.bytes) !== bytes.length)
    ) throw new Error('Stored media byte count mismatch.');
    if (legacy) await writeMetadataAtomic(metadataPath, asset);
    return { ...asset, bytes };
  };

  return { readAsset, storeAsset };
}

const defaultSocialMediaStore = createSocialMediaStore();

export function storePersistentSocialMediaAsset(input) {
  return defaultSocialMediaStore.storeAsset(input);
}

export function readPersistentSocialMediaAsset(id) {
  return defaultSocialMediaStore.readAsset(id);
}
