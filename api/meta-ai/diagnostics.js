import {
  buildCookieHeader,
  parseCookieHeader,
  safeCookieSummary,
} from '../_meta-ai.js';

export function metaAiCookieDiagnostics(cookieHeader) {
  const header = buildCookieHeader(cookieHeader);
  const parsed = parseCookieHeader(header);
  const names = Object.keys(parsed);
  const hasRequired = Boolean(parsed.ecto_1_sess && parsed.rd_challenge);
  const onlyMinimalCookies = hasRequired && names.length <= 2;
  const proxyConfigured = Boolean(String(process.env.META_AI_PROXY_SERVER || '').trim());
  return {
    cookieCount: names.length,
    cookieNames: names,
    cookieSummary: safeCookieSummary(header),
    onlyMinimalCookies,
    proxyConfigured,
  };
}

export function metaAi403Message(err, diagnostics) {
  if (diagnostics?.onlyMinimalCookies) {
    return `${err.message}. Saved cookies are minimal. If your browser sends more Meta AI cookies, paste the full Cookie header. If this still returns 403, Meta is blocking this VPS/IP and a proxy is required.`;
  }
  return `${err.message}. Meta is rejecting requests from this VPS/browser session. Configure META_AI_PROXY_SERVER with a trusted/residential proxy or run the Meta AI browser flow from an IP where meta.ai opens normally.`;
}
