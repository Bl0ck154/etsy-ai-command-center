// public/utils/image-resize.js
// Client-side image resize using Canvas API — ZERO network requests, ZERO API calls.
// Workflow: generate ONE image with NB2 → Canvas crops/pads to platform formats locally.

import { CROSS_PLATFORM_SET, PRESETS } from './image-resize-contracts.js';
import { calculateResizeRect } from './image-resize-geometry.js';

export { CROSS_PLATFORM_SET, PRESETS } from './image-resize-contracts.js';

/**
 * Resize one image to a target preset using Canvas — no API calls.
 * mode:
 *   'contain' — white padding, product never cropped. Best for Etsy.
 *   'cover'   — fills frame, may crop edges. Best for Stories.
 *   'smart'   — contain if >15% would be cropped, else cover.
 */
export async function resizeImage(file, presetKey = 'etsy', mode = 'contain') {
  const preset = PRESETS[presetKey];
  if (!preset) throw new Error(`Unknown preset: ${presetKey}`);

  const img = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = preset.w;
  canvas.height = preset.h;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, preset.w, preset.h);

  const rect = calculateResizeRect({
    srcWidth: img.width,
    srcHeight: img.height,
    dstWidth: preset.w,
    dstHeight: preset.h,
    mode,
  });

  ctx.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh);

  return new Promise(resolve => {
    canvas.toBlob(blob => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        blob,
        base64: reader.result.split(',')[1],
        dataURL: reader.result,
        width: preset.w,
        height: preset.h,
        preset: presetKey,
        mimeType: 'image/jpeg',
      });
      reader.readAsDataURL(blob);
    }, 'image/jpeg', 0.93);
  });
}

/**
 * Generate all 3 platform formats from one source image.
 * 100% local — zero API calls.
 */
export async function generateCrossPlatformSet(file, onProgress = null) {
  const results = {};
  const keys = CROSS_PLATFORM_SET;
  const modes = { etsy: 'contain', social: 'smart', stories: 'contain' };

  for (let i = 0; i < keys.length; i++) {
    if (onProgress) onProgress(i, keys.length, keys[i]);
    try {
      results[keys[i]] = await resizeImage(file, keys[i], modes[keys[i]]);
    } catch (e) {
      console.warn(`Resize failed for ${keys[i]}:`, e.message);
    }
  }
  if (onProgress) onProgress(keys.length, keys.length, 'done');
  return results;
}

export function downloadResized(result, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(result.blob);
  a.download = filename || `${result.preset}-${Date.now()}.jpg`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = (file instanceof File || file instanceof Blob)
      ? URL.createObjectURL(file)
      : file;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (file instanceof Blob) URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}
