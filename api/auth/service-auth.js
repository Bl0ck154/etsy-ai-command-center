import { timingSafeStringEqual } from './crypto.js';

function bearerToken(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

export function requireSocialHermesAuth(req, res) {
  const expected = (process.env.SOCIAL_HERMES_API_TOKEN || '').trim();
  if (!expected) {
    res.status(503).json({
      error: 'Social Hermes service token is not configured',
      code: 'SOCIAL_HERMES_AUTH_NOT_CONFIGURED',
    });
    return false;
  }
  if (!timingSafeStringEqual(bearerToken(req), expected)) {
    res.status(401).json({
      error: 'Unauthorized',
      code: 'SOCIAL_HERMES_AUTH_REQUIRED',
    });
    return false;
  }
  return true;
}
