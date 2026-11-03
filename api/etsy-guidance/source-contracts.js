import {
  ETSY_GUIDANCE_REVIEWED_AT,
  ETSY_GUIDANCE_SOURCES,
  ETSY_LISTING_OPTIMIZATION_RULES,
} from '../agent/etsy-standards.js';

export function isoNow() {
  return new Date().toISOString();
}

export function reviewedMonth(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function sourceArrayFromMap(sources = ETSY_GUIDANCE_SOURCES) {
  return Object.entries(sources).map(([id, source]) => ({
    id,
    label: source.label,
    url: source.url,
    ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
  }));
}

export function sourceMapFromArray(sources = []) {
  const byId = new Map(sources.map(source => [source.id, source]));
  return Object.fromEntries(Object.entries(ETSY_GUIDANCE_SOURCES).map(([id, fallback]) => {
    const source = byId.get(id) || {};
    return [id, {
      label: fallback.label,
      url: fallback.url,
      ...(source.publishedAt || fallback.publishedAt
        ? { publishedAt: source.publishedAt || fallback.publishedAt }
        : {}),
    }];
  }));
}

export function baselineSnapshot() {
  return {
    schemaVersion: 1,
    id: 'bundled-july-2026',
    status: 'active',
    origin: 'bundled',
    reviewedAt: ETSY_GUIDANCE_REVIEWED_AT,
    activatedAt: null,
    rules: ETSY_LISTING_OPTIMIZATION_RULES,
    sources: sourceArrayFromMap(),
  };
}
