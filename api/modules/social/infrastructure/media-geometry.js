import sharp from 'sharp';

import {
  normalizeSocialMediaMimeType,
  SOCIAL_HERMES_MAX_MEDIA_ASSET_BYTES,
} from './media-store.js';

function numericAspectRatio(value = '') {
  const match = String(value || '').trim().match(/^(\d+):(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

export async function normalizeGeneratedSocialImageGeometry({
  base64,
  mimeType = 'image/png',
  aspectRatio = '1:1',
  cropFocus = 'attention',
}) {
  const requestedRatio = numericAspectRatio(aspectRatio);
  if (!requestedRatio) throw new Error(`Unsupported generated media aspect ratio: ${aspectRatio}`);
  const input = Buffer.from(
    String(base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, ''),
    'base64',
  );
  if (!input.length) throw new Error('Generated media has no bytes for geometry validation.');
  const inputMimeType = normalizeSocialMediaMimeType(mimeType);
  const decoded = await sharp(input, { failOn: 'error' }).rotate().toBuffer({ resolveWithObject: true });
  const originalWidth = Number(decoded.info.width) || 0;
  const originalHeight = Number(decoded.info.height) || 0;
  if (!originalWidth || !originalHeight) throw new Error('Generated media dimensions are unavailable.');
  const originalRatio = originalWidth / originalHeight;
  const relativeError = Math.abs(originalRatio - requestedRatio) / requestedRatio;
  const normalizedCropFocus = ['attention', 'center', 'north', 'south', 'east', 'west']
    .includes(String(cropFocus || '').toLowerCase())
    ? String(cropFocus).toLowerCase()
    : 'attention';
  let crop = null;
  let pipeline = sharp(decoded.data, { failOn: 'error' });
  if (relativeError > 0.01) {
    let targetWidth = originalWidth;
    let targetHeight = originalHeight;
    if (originalRatio < requestedRatio) {
      targetHeight = Math.max(1, Math.round(originalWidth / requestedRatio));
    } else {
      targetWidth = Math.max(1, Math.round(originalHeight * requestedRatio));
    }
    crop = { width: targetWidth, height: targetHeight, position: normalizedCropFocus };
    pipeline = pipeline.resize({
      width: targetWidth,
      height: targetHeight,
      fit: 'cover',
      position: normalizedCropFocus,
      withoutEnlargement: true,
    });
  }
  const encode = (source, outputMimeType) => {
    if (outputMimeType === 'image/jpeg') return source.jpeg({ quality: 91, chromaSubsampling: '4:4:4' });
    if (outputMimeType === 'image/webp') return source.webp({ quality: 92, smartSubsample: true });
    return source.png({ compressionLevel: 9, adaptiveFiltering: true });
  };
  let outputMimeType = inputMimeType;
  let output = await encode(pipeline.clone(), outputMimeType).toBuffer({ resolveWithObject: true });
  if (output.data.length > SOCIAL_HERMES_MAX_MEDIA_ASSET_BYTES && outputMimeType !== 'image/jpeg') {
    outputMimeType = 'image/jpeg';
    output = await encode(pipeline.clone().flatten({ background: '#ffffff' }), outputMimeType)
      .toBuffer({ resolveWithObject: true });
  }
  return {
    base64: output.data.toString('base64'),
    mimeType: outputMimeType,
    width: Number(output.info.width) || 0,
    height: Number(output.info.height) || 0,
    requested_aspect_ratio: aspectRatio,
    actual_aspect_ratio: Number(
      ((Number(output.info.width) || 0) / (Number(output.info.height) || 1)).toFixed(6),
    ),
    original_width: originalWidth,
    original_height: originalHeight,
    original_aspect_ratio: Number(originalRatio.toFixed(6)),
    normalization_applied: Boolean(crop),
    normalization_mode: crop ? `${normalizedCropFocus}_cover_crop` : 'none',
    crop_focus: normalizedCropFocus,
    crop,
    padding: null,
    input_mime_type: inputMimeType,
  };
}
