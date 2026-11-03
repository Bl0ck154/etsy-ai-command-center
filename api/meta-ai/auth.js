import crypto from 'node:crypto';

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

export function hasMetaAiApiToken(req) {
  const expected = (process.env.META_AI_API_TOKEN || '').trim();
  return !!expected && timingSafeEqual(bearerToken(req), expected);
}
