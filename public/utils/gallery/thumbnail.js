import { isValidImageRecord } from './image-record.js';

export const THUMBNAIL_MAX_EDGE = 320;
export const THUMBNAIL_QUALITY = 0.78;

function base64ToBlob(base64, mimeType) {
  const binary = atob(String(base64 || '').replace(/\s+/g, ''));
  const chunks = [];
  const chunkSize = 8192;
  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const slice = binary.slice(offset, offset + chunkSize);
    const bytes = new Uint8Array(slice.length);
    for (let index = 0; index < slice.length; index += 1) bytes[index] = slice.charCodeAt(index);
    chunks.push(bytes);
  }
  return new Blob(chunks, { type: mimeType });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader is unavailable'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read thumbnail'));
    reader.readAsDataURL(blob);
  });
}

async function loadDrawableImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close?.(),
      };
    } catch { /* fall through to an HTML image */ }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') throw new Error('Image decoding is unavailable');
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Could not decode gallery image'));
      element.src = objectUrl;
    });
    return {
      image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

export async function createThumbnailDataUrl(record) {
  if (!isValidImageRecord(record)) return '';
  const blob = base64ToBlob(record.base64, record.mimeType);
  const drawable = await loadDrawableImage(blob);
  try {
    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(drawable.width, drawable.height));
    const width = Math.max(1, Math.round(drawable.width * scale));
    const height = Math.max(1, Math.round(drawable.height * scale));
    let canvas;
    if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(width, height);
    else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
    } else {
      return '';
    }
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return '';
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(drawable.image, 0, 0, width, height);
    if (typeof canvas.convertToBlob === 'function') {
      const thumbnailBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMBNAIL_QUALITY });
      return blobToDataUrl(thumbnailBlob);
    }
    return typeof canvas.toDataURL === 'function'
      ? canvas.toDataURL('image/jpeg', THUMBNAIL_QUALITY)
      : '';
  } finally {
    drawable.close?.();
  }
}
