export function routeParamsFrom(query = '') {
  return Object.fromEntries(
    new URLSearchParams(String(query || '').replace(/^\?/, '')),
  );
}

const PAGE_ROUTE_KEYS = Object.freeze({
  create: new Set(['listing_id', 'id']),
  messages: new Set(['tab', 'draft_id', 'conversation_id']),
  schedule: new Set(['preview_id', 'post_id']),
  social: new Set(['listing_id', 'autoGenerate']),
});

export function routeParamsForPage(page, params = {}) {
  const allowed = PAGE_ROUTE_KEYS[String(page || '')];
  if (!allowed) return {};
  return Object.fromEntries(
    Object.entries(params || {}).filter(([key, value]) => (
      allowed.has(key)
      && value !== undefined
      && value !== null
      && value !== ''
    )),
  );
}

export function canonicalRouteUrl(page, params = {}) {
  const routePage = String(page || 'agent').trim() || 'agent';
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(
    routeParamsForPage(routePage, params),
  )) {
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return `/#${routePage}${encoded ? `?${encoded}` : ''}`;
}
