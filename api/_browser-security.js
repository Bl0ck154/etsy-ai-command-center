import { hasBrowserSessionCookie } from './_auth.js';

export function browserMutationBlocked(req, sameOrigin) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req?.method || '').toUpperCase())) return false;
  if (!hasBrowserSessionCookie(req)) return false;
  const origin = String(req?.get?.('origin') || '');
  const fetchSite = String(req?.get?.('sec-fetch-site') || '').toLowerCase();
  return Boolean((origin && !sameOrigin(req, origin)) || (fetchSite && fetchSite !== 'same-origin'));
}
