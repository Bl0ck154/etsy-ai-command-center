// public/utils/file-helpers.js — File conversion utilities

export function base64ToFile(base64, mimeType, filename) {
  const byteStr = atob(base64);
  const ab = new ArrayBuffer(byteStr.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
  return new File([ab], filename, { type: mimeType });
}
