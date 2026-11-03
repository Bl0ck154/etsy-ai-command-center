import { truncate } from './format.js';

export function applySocialSort(listings = [], sortKey = 'created') {
  const sorted = [...listings];
  if (sortKey === 'title') {
    sorted.sort((left, right) => left.title.localeCompare(right.title));
  } else if (sortKey === 'price_asc') {
    sorted.sort((left, right) => (
      (left.price?.amount || 0) / (left.price?.divisor || 100)
      - (right.price?.amount || 0) / (right.price?.divisor || 100)
    ));
  } else if (sortKey === 'price_desc') {
    sorted.sort((left, right) => (
      (right.price?.amount || 0) / (right.price?.divisor || 100)
      - (left.price?.amount || 0) / (left.price?.divisor || 100)
    ));
  } else if (sortKey === 'views') {
    sorted.sort((left, right) => (right.views || 0) - (left.views || 0));
  }
  return sorted;
}

export function listingImageUrl(listing) {
  return listing?.MainImage?.url_570xN
    || listing?.images?.[0]?.url_570xN
    || listing?.media_items?.[0]?.url
    || listing?.image_urls?.[0]
    || listing?.image_url
    || listing?.MainImage?.url_75x75
    || listing?.images?.[0]?.url_75x75
    || '';
}

export function listingImageUrls(listing) {
  const urls = [];
  const add = url => {
    if (url && !urls.includes(url)) urls.push(url);
  };
  add(
    listing?.MainImage?.url_570xN
    || listing?.MainImage?.url_fullxfull
    || listing?.MainImage?.url_75x75,
  );
  for (const image of (Array.isArray(listing?.images) ? listing.images : [])) {
    add(image.url_570xN || image.url_fullxfull || image.url_75x75);
  }
  for (const item of (Array.isArray(listing?.media_items) ? listing.media_items : [])) {
    add(item?.url);
  }
  for (const url of (Array.isArray(listing?.image_urls) ? listing.image_urls : [])) add(url);
  add(listing?.image_url);
  return urls.slice(0, 10);
}

export function listingPriceValue(listing) {
  return ((listing?.price?.amount || 0) / (listing?.price?.divisor || 100)).toFixed(2);
}

export function compactListingForAutopilot(listing) {
  return {
    listing_id: Number(listing.listing_id),
    title: truncate(listing.title || '', 180),
    description: truncate(listing.description || '', 800),
    price: listingPriceValue(listing),
    url: `https://www.etsy.com/listing/${listing.listing_id}`,
    image_url: listingImageUrl(listing),
    image_urls: listingImageUrls(listing),
    num_favorers: listing.num_favorers || 0,
    views: listing.views || 0,
    recent_orders: listing.recent_orders || 0,
    recent_units: listing.recent_units || 0,
    recent_revenue_usd: listing.recent_revenue_usd || 0,
    last_order_at: listing.last_order_at || null,
    tags: Array.isArray(listing.tags) ? listing.tags.slice(0, 13) : [],
  };
}

export function mergeAutopilotListingFacts(listing, contextListing = {}) {
  return {
    ...contextListing,
    ...listing,
    description: contextListing.description || listing.description || '',
    image_url: contextListing.image_url || listingImageUrl(listing),
    image_urls: listingImageUrls({ ...contextListing, ...listing }),
    media_items: Array.isArray(contextListing.media_items) ? contextListing.media_items : [],
    recent_orders: contextListing.recent_orders || 0,
    recent_units: contextListing.recent_units || 0,
    recent_revenue_usd: contextListing.recent_revenue_usd || 0,
    last_order_at: contextListing.last_order_at || null,
  };
}

export function selectListingsForAutopilot(listings = []) {
  return listings.map(compactListingForAutopilot);
}

function postEventTime(record) {
  const raw = record?.postedAt
    || record?.published_at
    || record?.scheduled_at
    || record?.created_at
    || record?.date;
  if (!raw) return null;
  const time = typeof raw === 'number' ? raw : new Date(raw).getTime();
  return Number.isFinite(time) ? time : null;
}

export function buildAutopilotUsageIndex(scheduledPosts = [], postHistory = []) {
  const index = new Map();
  const add = (record, source) => {
    if (!record?.listing_id) return;
    const key = String(record.listing_id);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({
      platform: record.platform || 'all',
      source,
      at: postEventTime(record),
      status: record.status || (source === 'history' ? 'published' : 'scheduled'),
    });
  };
  for (const post of scheduledPosts || []) add(post, 'calendar');
  for (const post of postHistory || []) add(post, 'history');
  for (const uses of index.values()) {
    uses.sort((left, right) => (right.at || 0) - (left.at || 0));
  }
  return index;
}

export function usageSummaryForPost(post = {}) {
  const uses = post.usage_context || [];
  if (!uses.length) return 'Fresh listing';
  return uses.slice(0, 3).map(use => {
    const when = use.days_ago == null
      ? 'scheduled'
      : use.days_ago === 0
        ? 'today'
        : `${use.days_ago}d ago`;
    return `${use.platform} ${when}`;
  }).join(' · ');
}

export function parseAutopilotStreamJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  throw new Error('Gemini finished, but the streamed plan was not valid JSON. Try fewer posts or run again.');
}

export function socialHubScheduleStatus(record = {}) {
  const status = String(record.status || '').toLowerCase();
  if (record.published === true || status === 'published') return 'published';
  if (['failed', 'error', 'cancelled'].includes(status)) return status;
  if (status === 'queued_external') return 'queued';
  if (
    record.approved_for_publish === true
    || ['approved_scheduled', 'publishing', 'queued'].includes(status)
  ) return 'queued';
  if (status === 'scheduled' || (record.scheduled_at && status !== 'draft')) return 'scheduled';
  if (
    record.metadata?.owner_review_required === true
    || record.approval_source === 'owner_review_required'
  ) return 'owner_review';
  return 'draft';
}

export function normalizePublishHistoryStatus(result = {}) {
  if (result?.published === true) return 'published';
  if (
    result?.publish_status === 'queued_external'
    || result?.queued === true
    || result?.published === false
  ) return 'queued_external';
  return 'queued_external';
}

export function historyStatusLabel(status = 'published') {
  const normalized = String(status || 'published').toLowerCase();
  return ({
    owner_review: 'needs review',
    queued: 'sending',
    queued_external: 'sending',
    scheduled: 'scheduled',
    draft: 'draft',
    published: 'published',
    failed: 'failed',
    error: 'failed',
    cancelled: 'cancelled',
  })[normalized] || normalized;
}

export function historyStatusBadge(status = 'published') {
  const normalized = String(status || 'published').toLowerCase();
  if (normalized === 'published') return 'badge-green';
  if (normalized === 'failed' || normalized === 'error') return 'badge-red';
  if (normalized === 'scheduled') return 'badge-blue';
  if (normalized === 'owner_review') return 'badge-orange';
  return 'badge-gray';
}

export function filterAndSortHistory(history = [], {
  platform = 'all',
  status = 'all',
  sort = 'newest',
} = {}) {
  const items = history
    .filter(item => platform === 'all' || item.platform === platform)
    .filter(item => {
      if (status === 'all') return true;
      const itemStatus = String(item.status || 'published').toLowerCase();
      if (status === 'queued') return ['queued', 'queued_external'].includes(itemStatus);
      return itemStatus === status;
    });
  return items.sort((left, right) => {
    if (sort === 'oldest') return (left._postedAt || 0) - (right._postedAt || 0);
    if (sort === 'platform') {
      return String(left.platform || '').localeCompare(String(right.platform || ''))
        || (right._postedAt || 0) - (left._postedAt || 0);
    }
    if (sort === 'listing') {
      return String(left.listing || '').localeCompare(String(right.listing || ''))
        || (right._postedAt || 0) - (left._postedAt || 0);
    }
    return (right._postedAt || 0) - (left._postedAt || 0);
  });
}
