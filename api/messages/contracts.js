import crypto from 'node:crypto';

export function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

export function numericId(value, label = 'ID') {
  const id = String(value || '').trim();
  if (!/^\d+$/.test(id)) {
    const error = new Error(`${label} must be numeric`);
    error.status = 400;
    throw error;
  }
  return id;
}

export function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(parsed, max))
    : fallback;
}

export function requestId(value) {
  const clean = cleanText(value, 100).replace(/[^a-zA-Z0-9._-]/g, '_');
  return clean || crypto.randomUUID();
}
