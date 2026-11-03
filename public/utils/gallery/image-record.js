export function isValidImageRecord(record) {
  if (!record || record.id == null || typeof record.base64 !== 'string') return false;
  const base64 = record.base64.trim();
  if (!base64 || /^(null|undefined|false|nan)$/i.test(base64) || /^data:/i.test(base64)) return false;
  if (base64.replace(/\s+/g, '').length < 16 || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) return false;
  return typeof record.mimeType === 'string'
    && /^image\/[a-z0-9.+-]+$/i.test(record.mimeType);
}

export function imageSummaryFrom(record, thumbnailDataUrl = '', fallbackOwnerScope = '') {
  return {
    id: record.id,
    prompt: record.prompt || '',
    slotLabel: record.slotLabel || '',
    listingTitle: record.listingTitle || '',
    mimeType: record.mimeType || 'image/jpeg',
    createdAt: Number(record.createdAt) || 0,
    ownerScope: record.ownerScope || fallbackOwnerScope,
    thumbnailDataUrl: thumbnailDataUrl || record.thumbnailDataUrl || '',
  };
}
