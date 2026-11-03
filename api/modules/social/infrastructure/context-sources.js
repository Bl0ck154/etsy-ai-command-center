import crypto from 'node:crypto';

import { etsyFetch, getShopId } from '../../../_etsy.js';
import { isCurrentPaidReceipt } from '../../../../public/utils/receipt-lifecycle.js';

function boundedText(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function pageConfig(kind, env) {
  const upper = String(kind || '').toUpperCase();
  const defaults = {
    LISTINGS: { maxPages: 10, maxItems: 1000 },
    RECEIPTS: { maxPages: 20, maxItems: 2000 },
    REVIEWS: { maxPages: 10, maxItems: 1000 },
  }[upper] || { maxPages: 10, maxItems: 1000 };
  return {
    pageSize: boundedInt(env[`SOCIAL_HERMES_${upper}_PAGE_SIZE`], 100, 1, 100),
    maxPages: boundedInt(env[`SOCIAL_HERMES_${upper}_MAX_PAGES`], defaults.maxPages, 1, 50),
    maxItems: boundedInt(env[`SOCIAL_HERMES_${upper}_MAX_ITEMS`], defaults.maxItems, 1, 5000),
  };
}

function pathWithPagination(pathname, limit, offset) {
  const [pathOnly, query = ''] = String(pathname || '').split('?');
  const params = new URLSearchParams(query);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `${pathOnly}?${params.toString()}`;
}

export async function collectSocialHermesEtsyPages(pathname, config = {}, fetchPage = etsyFetch) {
  const pageSize = boundedInt(config.pageSize, 100, 1, 100);
  const maxPages = boundedInt(config.maxPages, 10, 1, 50);
  const maxItems = boundedInt(config.maxItems, 1000, 1, 5000);
  const rows = [];
  let totalReported = null;
  let pagesFetched = 0;
  let exhausted = false;
  for (let page = 0; page < maxPages && rows.length < maxItems; page += 1) {
    const offset = page * pageSize;
    const payload = await fetchPage(pathWithPagination(pathname, pageSize, offset));
    const pageRows = Array.isArray(payload?.results) ? payload.results : [];
    if (Number.isFinite(Number(payload?.count))) totalReported = Number(payload.count);
    pagesFetched += 1;
    rows.push(...pageRows.slice(0, Math.max(0, maxItems - rows.length)));
    if (pageRows.length < pageSize || (totalReported !== null && offset + pageRows.length >= totalReported)) {
      exhausted = true;
      break;
    }
  }
  return {
    results: rows,
    diagnostics: {
      page_size: pageSize,
      pages_fetched: pagesFetched,
      items_collected: rows.length,
      total_reported: totalReported,
      truncated: !exhausted && (pagesFetched >= maxPages || rows.length >= maxItems),
      max_pages: maxPages,
      max_items: maxItems,
    },
  };
}

function safeImageUrl(img = {}) {
  return img.url_fullxfull || img.url_570xN || img.url_300x300 || img.url_170x135 || img.url_75x75 || '';
}

export function normalizeSocialHermesListingImage(img = {}, idx = 0) {
  const url = safeImageUrl(img);
  if (!url) return null;
  return {
    id: img.listing_image_id ? String(img.listing_image_id) : `listing_image_${idx + 1}`,
    source: 'listing_image',
    type: 'image',
    url,
    alt: img.alt_text || '',
    rank: img.rank || idx + 1,
    width: img.full_width || img.width || null,
    height: img.full_height || img.height || null,
  };
}

function timestampToIso(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function reviewImageUrl(review = {}) {
  const value = review.image_url_fullxfull
    || review.image_url
    || review.review_image_url
    || review.photo_url
    || review.Images?.[0]?.url_fullxfull
    || '';
  return /^https?:\/\//i.test(String(value || '').trim()) ? String(value).trim() : '';
}

export function summarizeSocialHermesReview(review = {}) {
  const text = boundedText(review.review || review.text || review.message || '', 2000);
  const createdAt = timestampToIso(review.create_timestamp || review.created_at || review.update_timestamp);
  const listingId = String(review.listing_id || '').trim() || null;
  const suppliedId = review.review_id || review.reviewId || null;
  const stableId = suppliedId || `review_${crypto.createHash('sha256').update(`${listingId || ''}\0${createdAt || ''}\0${review.rating || review.stars || ''}\0${text}`).digest('hex').slice(0, 20)}`;
  const imageUrl = reviewImageUrl(review);
  return {
    review_id: stableId,
    listing_id: listingId,
    rating: review.rating || review.stars || null,
    text,
    text_preview: text.slice(0, 220),
    has_photo: Boolean(imageUrl),
    review_image_url: imageUrl,
    language: boundedText(review.language || review.locale || '', 24) || null,
    created_at: createdAt,
    updated_at: timestampToIso(review.update_timestamp || review.updated_at),
    transaction_link_available: Boolean(review.transaction_id),
  };
}

function moneyAmount(value = {}) {
  if (!value || typeof value !== 'object') return 0;
  const amount = Number(value.amount);
  const divisor = Number(value.divisor) || 100;
  return Number.isFinite(amount) ? amount / divisor : 0;
}

function buildOrderSignals(receipts = []) {
  const byListing = new Map();
  const touch = listingId => {
    const id = String(listingId || '').trim();
    if (!id) return null;
    if (!byListing.has(id)) byListing.set(id, {
      listing_id: id,
      recent_orders: 0,
      recent_units: 0,
      recent_revenue_usd: 0,
      last_order_at: null,
      sample_titles: [],
    });
    return byListing.get(id);
  };
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (!isCurrentPaidReceipt(receipt)) continue;
    const orderAt = timestampToIso(receipt.create_timestamp || receipt.created_timestamp || receipt.created_at);
    for (const transaction of Array.isArray(receipt.transactions) ? receipt.transactions : []) {
      const signal = touch(transaction.listing_id);
      if (!signal) continue;
      const quantity = Math.max(1, Number(transaction.quantity) || 1);
      signal.recent_orders += 1;
      signal.recent_units += quantity;
      signal.recent_revenue_usd += moneyAmount(transaction.price) * quantity;
      if (orderAt && (!signal.last_order_at || orderAt > signal.last_order_at)) signal.last_order_at = orderAt;
      const title = String(transaction.title || '').trim();
      if (title && !signal.sample_titles.includes(title)) signal.sample_titles.push(title);
    }
  }
  return byListing;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const input = Array.isArray(items) ? items : [];
  const out = new Array(input.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), input.length) }, async () => {
    while (cursor < input.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await mapper(input[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function pendingProvenance(source) {
  return {
    source,
    status: 'pending',
    current_fetch_complete: false,
    truncated: null,
    data_complete: false,
    data_truncated: null,
    data_available: false,
    used_last_known_good: false,
    fetched_at: null,
    data_observed_at: null,
  };
}

function fetchedProvenance(source, diagnostics, fetchedAt) {
  const truncated = diagnostics?.truncated === true;
  return {
    source,
    status: truncated ? 'truncated' : 'complete',
    current_fetch_complete: !truncated,
    truncated,
    data_complete: !truncated,
    data_truncated: truncated,
    data_available: !truncated,
    used_last_known_good: false,
    fetched_at: fetchedAt,
    data_observed_at: fetchedAt,
  };
}

function failedProvenance(source, error, fetchedAt) {
  return {
    source,
    status: 'failed',
    current_fetch_complete: false,
    truncated: null,
    data_complete: false,
    data_truncated: null,
    data_available: false,
    used_last_known_good: false,
    fetched_at: fetchedAt,
    data_observed_at: null,
    error: boundedText(error || `${source} fetch failed`, 500),
  };
}

export function createSocialContextSources({
  fetchEtsy = etsyFetch,
  shopId = getShopId,
  env = process.env,
  clock = () => new Date(),
} = {}) {
  const getListingMedia = async listingId => {
    if (!listingId) return { listing: null, media_items: [], error: null };
    try {
      const listing = await fetchEtsy(`/listings/${parseInt(listingId, 10)}?includes=images`);
      const images = Array.isArray(listing.images) ? listing.images : Array.isArray(listing.Images) ? listing.Images : [];
      const mediaItems = images.map(normalizeSocialHermesListingImage).filter(Boolean).slice(0, 10);
      return {
        listing: {
          listing_id: listing.listing_id ? String(listing.listing_id) : String(listingId),
          title: listing.title || '',
          state: listing.state || '',
          url: listing.url || '',
        },
        media_items: mediaItems,
        error: null,
      };
    } catch (error) {
      return { listing: { listing_id: String(listingId) }, media_items: [], error: error?.message || 'Listing media lookup failed' };
    }
  };

  const collect = async () => {
    const generatedAt = clock().toISOString();
    const out = {
      listings: [],
      reviews: [],
      receipt_signals: [],
      discounts: [],
      stats: null,
      collection_diagnostics: {},
      source_provenance: {
        listings: pendingProvenance('listings'),
        receipts: pendingProvenance('receipts'),
        reviews: pendingProvenance('reviews'),
      },
      generated_at: generatedAt,
      errors: [],
    };
    let orderSignals = new Map();
    try {
      const since = Math.floor((clock().getTime() - 90 * 24 * 60 * 60 * 1000) / 1000);
      const receipts = await collectSocialHermesEtsyPages(
        `/shops/${shopId()}/receipts?min_created=${since}&was_paid=true&sort_on=created&sort_order=desc&includes=transactions`,
        pageConfig('receipts', env),
        fetchEtsy,
      );
      const receiptRows = receipts.results;
      out.collection_diagnostics.receipts = receipts.diagnostics;
      out.source_provenance.receipts = fetchedProvenance('receipts', receipts.diagnostics, generatedAt);
      orderSignals = buildOrderSignals(receiptRows);
      out.receipt_signals = [...orderSignals.values()].map(item => ({
        ...item,
        recent_revenue_usd: Number(item.recent_revenue_usd.toFixed(2)),
      }));
      const totalRevenue = [...orderSignals.values()].reduce((sum, item) => sum + item.recent_revenue_usd, 0);
      out.stats = {
        source: 'etsy_receipts_90d',
        paid_receipts_scanned: receiptRows.length,
        listings_with_recent_orders: orderSignals.size,
        recent_units: [...orderSignals.values()].reduce((sum, item) => sum + item.recent_units, 0),
        recent_revenue_usd: Number(totalRevenue.toFixed(2)),
      };
    } catch (error) {
      out.source_provenance.receipts = failedProvenance('receipts', error?.message, generatedAt);
      out.errors.push({ source: 'recent_order_signals', error: error?.message || 'Recent order lookup failed' });
    }
    try {
      const listings = await collectSocialHermesEtsyPages(
        `/shops/${shopId()}/listings?state=active&sort_on=updated&sort_order=desc&includes=images`,
        pageConfig('listings', env),
        fetchEtsy,
      );
      out.collection_diagnostics.listings = listings.diagnostics;
      out.source_provenance.listings = fetchedProvenance('listings', listings.diagnostics, generatedAt);
      const activeListings = listings.results.filter(listing => listing.listing_id);
      const mediaConcurrency = boundedInt(env.SOCIAL_HERMES_LISTING_MEDIA_CONCURRENCY, 6, 1, 12);
      out.listings = await mapWithConcurrency(activeListings, mediaConcurrency, async listing => {
        const inlineImages = Array.isArray(listing.images) ? listing.images : Array.isArray(listing.Images) ? listing.Images : [];
        let mediaItems = inlineImages.map(normalizeSocialHermesListingImage).filter(Boolean).slice(0, 10);
        if (!mediaItems.length) {
          const detailed = await getListingMedia(String(listing.listing_id));
          mediaItems = (detailed.media_items || []).slice(0, 10);
          if (detailed.error) out.errors.push({ source: `listing_media:${listing.listing_id}`, error: detailed.error });
        }
        const orderSignal = orderSignals.get(String(listing.listing_id)) || null;
        return {
          listing_id: String(listing.listing_id),
          title: listing.title || '',
          state: listing.state || '',
          url: listing.url || '',
          image_url: mediaItems[0]?.url || '',
          image_urls: mediaItems.map(item => item.url).filter(Boolean),
          media_items: mediaItems,
          description: boundedText(listing.description || '', 4000),
          tags: Array.isArray(listing.tags) ? listing.tags.slice(0, 13) : [],
          num_favorers: listing.num_favorers || 0,
          views: listing.views || 0,
          quantity: listing.quantity ?? null,
          listing_type: listing.listing_type || '',
          taxonomy_id: listing.taxonomy_id || null,
          created_at: timestampToIso(listing.created_timestamp || listing.create_timestamp || listing.original_creation_timestamp),
          updated_at: timestampToIso(listing.updated_timestamp || listing.update_timestamp || listing.last_modified_timestamp),
          recent_orders: orderSignal?.recent_orders || 0,
          recent_units: orderSignal?.recent_units || 0,
          recent_revenue_usd: orderSignal ? Number(orderSignal.recent_revenue_usd.toFixed(2)) : 0,
          last_order_at: orderSignal?.last_order_at || null,
          performance_signals: {
            views: listing.views || 0,
            favorites: listing.num_favorers || 0,
            recent_orders_90d: orderSignal?.recent_orders || 0,
            recent_units_90d: orderSignal?.recent_units || 0,
            recent_revenue_usd_90d: orderSignal ? Number(orderSignal.recent_revenue_usd.toFixed(2)) : 0,
            last_order_at: orderSignal?.last_order_at || null,
          },
        };
      });
      out.listings.sort((a, b) =>
        (Number(b.recent_orders) || 0) - (Number(a.recent_orders) || 0)
        || (Number(b.views) || 0) - (Number(a.views) || 0)
        || (Number(b.num_favorers) || 0) - (Number(a.num_favorers) || 0)
        || String(a.title || '').localeCompare(String(b.title || '')));
    } catch (error) {
      out.source_provenance.listings = failedProvenance('listings', error?.message, generatedAt);
      out.errors.push({ source: 'active_listings', error: error?.message || 'Active listing lookup failed' });
    }
    try {
      const reviews = await collectSocialHermesEtsyPages(
        `/shops/${shopId()}/reviews`,
        pageConfig('reviews', env),
        fetchEtsy,
      );
      out.collection_diagnostics.reviews = reviews.diagnostics;
      out.source_provenance.reviews = fetchedProvenance('reviews', reviews.diagnostics, generatedAt);
      out.reviews = reviews.results.map(summarizeSocialHermesReview).filter(review => review.rating || review.text);
    } catch (error) {
      out.source_provenance.reviews = failedProvenance('reviews', error?.message, generatedAt);
      out.errors.push({ source: 'reviews', error: error?.message || 'Reviews lookup failed' });
    }
    try {
      const discounts = await fetchEtsy(`/shops/${shopId()}/discounts?limit=20`);
      out.discounts = (Array.isArray(discounts.results) ? discounts.results : []).map(discount => ({
        discount_id: discount.discount_id || discount.coupon_id || null,
        name: discount.discount_name || discount.name || '',
        type: discount.discount_type || '',
        value: discount.discount_value || null,
        start_date: discount.start_date || null,
        end_date: discount.end_date || null,
        seller_active: discount.seller_active ?? null,
      })).slice(0, 20);
    } catch (error) {
      out.errors.push({ source: 'discounts', error: error?.message || 'Discount lookup failed' });
    }
    return out;
  };

  return { collect, getListingMedia };
}

export const socialContextSources = createSocialContextSources();

export function getSocialHermesListingMedia(listingId) {
  return socialContextSources.getListingMedia(listingId);
}
