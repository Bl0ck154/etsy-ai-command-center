import crypto from 'node:crypto';
import { load } from 'cheerio';

import { ETSY_GUIDANCE_SOURCES } from '../agent/etsy-standards.js';
import { isoNow } from './source-contracts.js';

const SOURCE_TIMEOUT_MS = 20_000;
const SOURCE_TEXT_LIMIT = 30_000;
const SOURCE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export function extractEtsyGuidanceText(html = '') {
  const $ = load(String(html || ''));
  $('script,style,noscript,svg,template,nav,header,footer,form,button').remove();
  const root = $('article').first().length
    ? $('article').first()
    : ($('main').first().length ? $('main').first() : $('body'));
  root.find('br,p,li,h1,h2,h3,h4,h5,h6,section,div').each((_, element) => {
    $(element).append('\n');
  });
  return root.text()
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, SOURCE_TEXT_LIMIT);
}

export function hashEtsyGuidanceText(text = '') {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function assertOfficialSourceUrl(url, source) {
  const parsed = new URL(url);
  const expected = new URL(source.contentUrl);
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'help.etsy.com'
    || parsed.pathname !== expected.pathname
    || parsed.search
  ) {
    throw new Error('Etsy guidance source redirect is not allowlisted');
  }
}

export async function fetchOfficialEtsyGuidanceSource(source, fetchImpl = fetch) {
  const expected = ETSY_GUIDANCE_SOURCES[source.id];
  if (!expected || source.url !== expected.url) throw new Error('Etsy guidance source is not allowlisted');
  const fetchSource = { ...source, contentUrl: expected.contentUrl };
  assertOfficialSourceUrl(fetchSource.contentUrl, fetchSource);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    let currentUrl = fetchSource.contentUrl;
    let response;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'EtsyManagerGuidanceMonitor/1.0 (+https://dashboard.example.test)',
        },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirectCount === 3) throw new Error(`${source.label} exceeded the redirect limit`);
      const location = response.headers?.get?.('location');
      if (!location) throw new Error(`${source.label} returned an invalid redirect`);
      currentUrl = new URL(location, currentUrl).toString();
      assertOfficialSourceUrl(currentUrl, fetchSource);
    }
    if (!response.ok) throw new Error(`${source.label} returned HTTP ${response.status}`);
    const contentType = String(response.headers?.get?.('content-type') || '');
    if (!contentType.toLowerCase().includes('application/json')) throw new Error(`${source.label} returned an unexpected content type`);
    const declaredLength = Number(response.headers?.get?.('content-length') || 0);
    if (declaredLength > SOURCE_RESPONSE_MAX_BYTES) throw new Error(`${source.label} exceeds the response size limit`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > SOURCE_RESPONSE_MAX_BYTES) throw new Error(`${source.label} exceeds the response size limit`);
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(`${source.label} returned invalid JSON`);
    }
    const article = payload?.article;
    const expectedArticleId = expected.contentUrl.match(/articles\/(\d+)\.json$/)?.[1];
    const articleUrl = new URL(String(article?.html_url || 'https://invalid.local'));
    if (
      String(article?.id || '') !== expectedArticleId
      || articleUrl.protocol !== 'https:'
      || articleUrl.hostname !== 'help.etsy.com'
      || !articleUrl.pathname.includes(`/articles/${expectedArticleId}`)
      || typeof article?.body !== 'string'
    ) {
      throw new Error(`${source.label} returned an unexpected Etsy Help article`);
    }
    const text = extractEtsyGuidanceText(article.body);
    if (text.length < 1500 || !/etsy/i.test(text)) throw new Error(`${source.label} did not return a usable Etsy article`);
    return {
      ...source,
      fetchedAt: isoNow(),
      contentHash: hashEtsyGuidanceText(text),
      sourceUpdatedAt: article.updated_at || null,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}
