import crypto from 'node:crypto';

function timingSafeEqual(left, right) {
  const actual = Buffer.from(String(left || ''), 'utf8');
  const expected = Buffer.from(String(right || ''), 'utf8');
  return actual.length === expected.length
    && crypto.timingSafeEqual(actual, expected);
}

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function requireMessageEventToken(req, res) {
  const expected = String(process.env.MESSAGE_EVENT_INGEST_TOKEN || '').trim();
  if (
    Buffer.byteLength(expected, 'utf8') >= 32
    && timingSafeEqual(bearerToken(req), expected)
  ) return true;
  res.status(401).json({
    error: 'Message event service authentication required',
    code: 'MESSAGE_EVENT_AUTH_REQUIRED',
  });
  return false;
}
