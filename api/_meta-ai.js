import { kvGet } from './kv.js';
import {
  buildCookieHeader,
  buildMetaAiGatewayUrl,
  decodeGatewayFramePayload,
  extractMetaAiAccessToken,
  extractMetaAiVideoResultFromText,
  extractMetaAiViewerId,
  fetchMetaAiHome,
  generateMetaAiVideo,
  getMetaAiSession,
  getSafeMetaAiStatus as getStandaloneSafeMetaAiStatus,
  maskedToken,
  parseCookieHeader,
  probeMetaAiGateway,
  safeCookieSummary,
  safeMetaAiStatusFromSession,
  sanitizeGatewayUrl,
} from 'metaai-cookie-client';
import { getMetaAiBrowserStatus } from 'metaai-cookie-client/browser-flow';

export {
  buildCookieHeader,
  buildMetaAiGatewayUrl,
  decodeGatewayFramePayload,
  extractMetaAiAccessToken,
  extractMetaAiVideoResultFromText,
  extractMetaAiViewerId,
  fetchMetaAiHome,
  generateMetaAiVideo,
  getMetaAiSession,
  maskedToken,
  parseCookieHeader,
  probeMetaAiGateway,
  safeCookieSummary,
  safeMetaAiStatusFromSession,
  sanitizeGatewayUrl,
};

export async function getMetaAiCookieHeader() {
  const envCookie = process.env.META_AI_COOKIE_HEADER || process.env.META_AI_COOKIES || '';
  if (envCookie.trim()) return normalizeMetaAiCookieHeader(envCookie.trim());
  const saved = await kvGet('meta_ai_cookies').catch(() => null);
  return normalizeMetaAiCookieHeader(saved);
}

export async function getSafeMetaAiStatus({ cookieHeader, signal } = {}) {
  const resolvedCookieHeader = normalizeMetaAiCookieHeader(cookieHeader) || await getMetaAiCookieHeader();
  try {
    return await getStandaloneSafeMetaAiStatus({ cookieHeader: resolvedCookieHeader, signal });
  } catch (err) {
    if (err?.code !== 'META_AI_HOME_HTTP' && err?.status !== 403 && err?.statusCode !== 403) throw err;
    return getMetaAiBrowserStatus({ cookieHeader: resolvedCookieHeader });
  }
}

function normalizeMetaAiCookieHeader(input) {
  let value = input;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      value = JSON.parse(value);
    } catch {}
  }
  const header = buildCookieHeader(typeof value === 'string'
    ? value.trim().replace(/^cookie\s*:\s*/i, '').trim()
    : value);
  if (!header) return '';
  const parsed = parseCookieHeader(header);
  if (!parsed.rd_challenge && parsed.datr) {
    parsed.rd_challenge = parsed.datr;
  }
  const missing = ['ecto_1_sess', 'rd_challenge'].filter(name => !parsed[name]);
  if (missing.length) {
    const found = Object.keys(parsed).length ? Object.keys(parsed).join(', ') : 'none';
    const err = new Error(`Saved Meta AI cookies must include ecto_1_sess and rd_challenge. Missing: ${missing.join(', ')}. Found: ${found}.`);
    err.status = 400;
    err.code = 'META_AI_COOKIES_INCOMPLETE';
    throw err;
  }
  const preferred = ['ecto_1_sess', 'rd_challenge'];
  const ordered = [
    ...preferred,
    ...Object.keys(parsed).filter(name => !preferred.includes(name)).sort(),
  ];
  return ordered
    .filter(name => parsed[name])
    .map(name => `${name}=${parsed[name]}`)
    .join('; ');
}
