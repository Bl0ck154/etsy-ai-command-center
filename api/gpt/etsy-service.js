import { getValidToken, refreshAccessToken } from '../auth.js';
import { etsyFetch, getListingWithInventory, getShopId } from '../_etsy.js';
import {
  buildListingBody,
  buildListingUpdateBody,
} from '../_listing-body.js';
import {
  hasVariationInventoryForEtsy,
  normalizeInventoryPayloadForEtsy,
  normalizePersonalizationQuestionsForEtsy,
  validatePersonalizationQuestionsForEtsy,
} from '../etsy.js';
import {
  listingImagePath,
  normalizeListingImagesResponse,
  validateListingImageAltText,
} from '../_listing-image-alt-text.js';
import { uploadListingImageBuffer } from '../upload.js';
import {
  associateDigitalListingFileMultipart,
  associateListingImageMultipart,
  associateListingVideoMultipart,
  updateListingImageAltTextMultipart,
  uploadDigitalListingFileMultipart,
  uploadListingVideoMultipart,
} from './etsy-multipart.js';

const LISTING_STATES = new Set(['active', 'inactive', 'draft', 'expired', 'sold_out']);
const MUTABLE_LISTING_STATES = new Set(['active', 'inactive', 'draft']);
const SORT_FIELDS = new Set(['created', 'price', 'updated', 'score']);
const SORT_ORDERS = new Set(['asc', 'desc']);
const STAT_KINDS = new Set(['shop', 'listings', 'orders', 'revenue']);
const LISTING_UPDATE_FIELDS = new Set([
  'title', 'description', 'price', 'quantity', 'tags', 'materials', 'who_made', 'when_made',
  'taxonomy_id', 'listing_type', 'is_supply', 'should_auto_renew', 'shop_section_id',
  'shipping_profile_id', 'return_policy_id', 'readiness_state_id', 'processing_min',
  'processing_max', 'language', 'state',
]);
const INVENTORY_UPDATE_FIELDS = new Set([
  'inventory', 'variations', 'options', 'products', 'offerings', 'property_values',
  'price_on_property', 'quantity_on_property', 'sku_on_property',
]);

function inputError(message, code = 'INVALID_INPUT', status = 400) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.isValidation = true;
  return error;
}

export function strictPositiveId(value, name = 'id') {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw inputError(`${name} must be a positive integer`, 'INVALID_ID');
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) throw inputError(`${name} must be a positive integer`, 'INVALID_ID');
  return number;
}

function shopId(value) {
  return strictPositiveId(value ?? getShopId(), 'shop_id');
}

function boundedInteger(value, name, { min = 0, max, fallback }) {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw inputError(`${name} must be an integer from ${min} to ${max}`);
  }
  return candidate;
}

function enumValue(value, name, allowed, fallback) {
  const candidate = String(value ?? fallback).trim().toLowerCase();
  if (!allowed.has(candidate)) throw inputError(`${name} has an unsupported value`);
  return candidate;
}

function queryString(entries) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

function cleanLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  if (!new Set(['de', 'en', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt']).has(language)) {
    throw inputError('language must be one of de, en, es, fr, it, ja, nl, pl, or pt');
  }
  return encodeURIComponent(language);
}

function allowedBody(value, allowedFields, { required = [], label = 'payload' } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const unknown = Object.keys(source).filter(key => !allowedFields.includes(key));
  if (unknown.length) throw inputError(`${label} contains unsupported field: ${unknown[0]}`);
  const body = Object.fromEntries(allowedFields
    .filter(key => source[key] !== undefined)
    .map(key => [key, source[key]]));
  const missing = required.filter(key => body[key] === undefined || body[key] === null || body[key] === '');
  if (missing.length) throw inputError(`${label}.${missing[0]} is required`);
  if (!Object.keys(body).length) throw inputError(`${label} must contain at least one supported field`);
  return body;
}

function formBody(value) {
  const form = new URLSearchParams();
  for (const [key, raw] of Object.entries(value)) {
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      if (item !== undefined && item !== null) form.append(key, String(item));
    }
  }
  return form.toString();
}

function etsyForm(path, method, body) {
  return etsyFetch(path, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody(body),
  });
}

export async function getUserProfile() {
  return etsyFetch('/users/me');
}

export async function getShop({ shopId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}`);
}

export async function updateShop({ shopId, changes } = {}) {
  const body = allowedBody(changes, ['title', 'announcement', 'sale_message', 'digital_sale_message', 'policy_additional'], { label: 'changes' });
  return etsyForm(`/shops/${shopIdForPath(shopId)}`, 'PUT', body);
}

function shopIdForPath(value) {
  return shopId(value);
}

export async function getShopSections({ shopId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/sections`);
}

export async function createShopSection({ shopId, title }) {
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
  if (!cleanTitle || cleanTitle.length > 24) throw inputError('title must contain 1 to 24 characters');
  return etsyForm(`/shops/${shopIdForPath(shopId)}/sections`, 'POST', { title: cleanTitle });
}

export async function getShippingProfiles({ shopId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/shipping-profiles`);
}

const SHIPPING_PROFILE_FIELDS = [
  'title', 'origin_country_iso', 'primary_cost', 'secondary_cost', 'min_processing_time',
  'max_processing_time', 'processing_time_unit', 'destination_country_iso', 'destination_region',
  'origin_postal_code', 'shipping_carrier_id', 'mail_class', 'min_delivery_days', 'max_delivery_days',
];
const SHIPPING_PROFILE_UPDATE_FIELDS = [
  'title', 'origin_country_iso', 'min_processing_time', 'max_processing_time',
  'processing_time_unit', 'origin_postal_code',
];
const SHIPPING_DESTINATION_FIELDS = [
  'primary_cost', 'secondary_cost', 'destination_country_iso', 'destination_region',
  'shipping_carrier_id', 'mail_class', 'min_delivery_days', 'max_delivery_days',
];
const SHIPPING_UPGRADE_FIELDS = [
  'type', 'upgrade_name', 'price', 'secondary_price', 'shipping_carrier_id', 'mail_class',
  'min_delivery_days', 'max_delivery_days',
];

function validateShippingDelivery(body, label) {
  const hasAnyCarrier = body.shipping_carrier_id !== undefined || body.mail_class !== undefined;
  const hasAnyDays = body.min_delivery_days !== undefined || body.max_delivery_days !== undefined;
  const hasCarrier = body.shipping_carrier_id !== undefined && body.mail_class !== undefined;
  const hasDays = body.min_delivery_days !== undefined && body.max_delivery_days !== undefined;
  if (hasAnyCarrier && !hasCarrier) {
    throw inputError(`${label} requires both shipping_carrier_id and mail_class`);
  }
  if (hasAnyDays && !hasDays) {
    throw inputError(`${label} requires both min_delivery_days and max_delivery_days`);
  }
  if (!hasCarrier && !hasDays) throw inputError(`${label} requires a carrier/mail_class pair or min/max delivery days`);
  if (hasCarrier && hasDays) throw inputError(`${label} must use either carrier/mail_class or min/max delivery days, not both`);
}

function validateDestinationSelector(body, label, { required = false } = {}) {
  const hasCountry = body.destination_country_iso !== undefined && body.destination_country_iso !== '';
  const hasRegion = body.destination_region !== undefined && body.destination_region !== '';
  if (hasCountry && hasRegion) throw inputError(`${label} must use destination_country_iso or destination_region, not both`);
  if (required && !hasCountry && !hasRegion) throw inputError(`${label} requires destination_country_iso or destination_region`);
}

export async function getShippingProfile({ shopId, shippingProfileId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${strictPositiveId(shippingProfileId, 'shipping_profile_id')}`);
}

export async function createShippingProfile({ shopId, profile } = {}) {
  const body = allowedBody(profile, SHIPPING_PROFILE_FIELDS, {
    required: ['title', 'origin_country_iso', 'primary_cost', 'secondary_cost'], label: 'profile',
  });
  validateDestinationSelector(body, 'profile', { required: true });
  validateShippingDelivery(body, 'profile');
  return etsyForm(`/shops/${shopIdForPath(shopId)}/shipping-profiles`, 'POST', body);
}

export async function updateShippingProfile({ shopId, shippingProfileId, changes } = {}) {
  const body = allowedBody(changes, SHIPPING_PROFILE_UPDATE_FIELDS, { label: 'changes' });
  return etsyForm(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${strictPositiveId(shippingProfileId, 'shipping_profile_id')}`, 'PUT', body);
}

export async function deleteShippingProfile({ shopId, shippingProfileId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${strictPositiveId(shippingProfileId, 'shipping_profile_id')}`, { method: 'DELETE' });
}

export async function getShippingProfileDestinations({ shopId, shippingProfileId, limit = 25, offset = 0 } = {}) {
  const query = queryString({
    limit: boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 25 }),
    offset: boundedInteger(offset, 'offset', { min: 0, max: 100_000, fallback: 0 }),
  });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${strictPositiveId(shippingProfileId, 'shipping_profile_id')}/destinations?${query}`);
}

export async function createShippingProfileDestination({ shopId, shippingProfileId, destination } = {}) {
  const id = strictPositiveId(shippingProfileId, 'shipping_profile_id');
  const body = allowedBody(destination, SHIPPING_DESTINATION_FIELDS, { required: ['primary_cost', 'secondary_cost'], label: 'destination' });
  validateDestinationSelector(body, 'destination');
  validateShippingDelivery(body, 'destination');
  return etsyForm(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${id}/destinations`, 'POST', body);
}

export async function updateShippingProfileDestination({ shopId, shippingProfileId, destinationId, changes } = {}) {
  const profile = strictPositiveId(shippingProfileId, 'shipping_profile_id');
  const destination = strictPositiveId(destinationId, 'destination_id');
  const body = allowedBody(changes, SHIPPING_DESTINATION_FIELDS, { label: 'changes' });
  validateDestinationSelector(body, 'changes');
  if (['shipping_carrier_id', 'mail_class', 'min_delivery_days', 'max_delivery_days'].some(key => body[key] !== undefined)) {
    validateShippingDelivery(body, 'changes');
  }
  return etsyForm(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${profile}/destinations/${destination}`, 'PUT', body);
}

export async function deleteShippingProfileDestination({ shopId, shippingProfileId, destinationId } = {}) {
  const profile = strictPositiveId(shippingProfileId, 'shipping_profile_id');
  const destination = strictPositiveId(destinationId, 'destination_id');
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${profile}/destinations/${destination}`, { method: 'DELETE' });
}

export async function getShippingProfileUpgrades({ shopId, shippingProfileId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${strictPositiveId(shippingProfileId, 'shipping_profile_id')}/upgrades`);
}

export async function createShippingProfileUpgrade({ shopId, shippingProfileId, upgrade } = {}) {
  const id = strictPositiveId(shippingProfileId, 'shipping_profile_id');
  const body = allowedBody(upgrade, SHIPPING_UPGRADE_FIELDS, { required: ['type', 'upgrade_name', 'price', 'secondary_price'], label: 'upgrade' });
  validateShippingDelivery(body, 'upgrade');
  return etsyForm(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${id}/upgrades`, 'POST', body);
}

export async function updateShippingProfileUpgrade({ shopId, shippingProfileId, upgradeId, changes } = {}) {
  const profile = strictPositiveId(shippingProfileId, 'shipping_profile_id');
  const upgrade = strictPositiveId(upgradeId, 'upgrade_id');
  const body = allowedBody(changes, SHIPPING_UPGRADE_FIELDS, { label: 'changes' });
  if (['shipping_carrier_id', 'mail_class', 'min_delivery_days', 'max_delivery_days'].some(key => body[key] !== undefined)) {
    validateShippingDelivery(body, 'changes');
  }
  return etsyForm(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${profile}/upgrades/${upgrade}`, 'PUT', body);
}

export async function deleteShippingProfileUpgrade({ shopId, shippingProfileId, upgradeId } = {}) {
  const profile = strictPositiveId(shippingProfileId, 'shipping_profile_id');
  const upgrade = strictPositiveId(upgradeId, 'upgrade_id');
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/shipping-profiles/${profile}/upgrades/${upgrade}`, { method: 'DELETE' });
}

export async function getReturnPolicies({ shopId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/policies/return`);
}

function returnPolicyBody(value) {
  const body = allowedBody(value, ['accepts_returns', 'accepts_exchanges', 'return_deadline'], {
    required: ['accepts_returns', 'accepts_exchanges'], label: 'policy',
  });
  if (typeof body.accepts_returns !== 'boolean' || typeof body.accepts_exchanges !== 'boolean') {
    throw inputError('policy.accepts_returns and policy.accepts_exchanges must be booleans');
  }
  if ((body.accepts_returns === true || body.accepts_exchanges === true)
    && ![7, 14, 21, 30, 45, 60, 90].includes(Number(body.return_deadline))) {
    throw inputError('return_deadline must be 7, 14, 21, 30, 45, 60, or 90 when returns or exchanges are accepted');
  }
  return body;
}

export async function getReturnPolicy({ shopId, returnPolicyId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/policies/return/${strictPositiveId(returnPolicyId, 'return_policy_id')}`);
}

export async function createReturnPolicy({ shopId, policy } = {}) {
  return etsyForm(`/shops/${shopIdForPath(shopId)}/policies/return`, 'POST', returnPolicyBody(policy));
}

export async function updateReturnPolicy({ shopId, returnPolicyId, policy } = {}) {
  return etsyForm(`/shops/${shopIdForPath(shopId)}/policies/return/${strictPositiveId(returnPolicyId, 'return_policy_id')}`, 'PUT', returnPolicyBody(policy));
}

export async function deleteReturnPolicy({ shopId, returnPolicyId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/policies/return/${strictPositiveId(returnPolicyId, 'return_policy_id')}`, { method: 'DELETE' });
}

export async function consolidateReturnPolicies({ shopId, sourceReturnPolicyId, destinationReturnPolicyId } = {}) {
  return etsyForm(`/shops/${shopIdForPath(shopId)}/policies/return/consolidate`, 'POST', {
    source_return_policy_id: strictPositiveId(sourceReturnPolicyId, 'source_return_policy_id'),
    destination_return_policy_id: strictPositiveId(destinationReturnPolicyId, 'destination_return_policy_id'),
  });
}

export async function getListingsByReturnPolicy({ shopId, returnPolicyId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/policies/return/${strictPositiveId(returnPolicyId, 'return_policy_id')}/listings?legacy=false`);
}

export async function getReadinessStateDefinitions({ shopId, limit = 100 } = {}) {
  const safeLimit = boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 100 });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/readiness-state-definitions?limit=${safeLimit}`);
}

export async function getShopProductionPartners({ shopId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/production-partners`);
}

function responseCount(response) {
  const count = Number(response?.count);
  return Number.isSafeInteger(count) && count >= 0
    ? count
    : Array.isArray(response?.results) ? response.results.length : 0;
}

export async function getShopSection({ shopId, sectionId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/sections/${strictPositiveId(sectionId, 'section_id')}`);
}

export async function updateShopSection({ shopId, sectionId, title } = {}) {
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
  if (!cleanTitle || cleanTitle.length > 24) throw inputError('title must contain 1 to 24 characters');
  return etsyForm(`/shops/${shopIdForPath(shopId)}/sections/${strictPositiveId(sectionId, 'section_id')}`, 'PUT', { title: cleanTitle });
}

export async function deleteShopSection({ shopId, sectionId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/sections/${strictPositiveId(sectionId, 'section_id')}`, { method: 'DELETE' });
}

function moneyValue(value) {
  if (value && typeof value === 'object') {
    const amount = Number(value.amount);
    const divisor = Number(value.divisor || 100);
    return Number.isFinite(amount) && Number.isFinite(divisor) && divisor > 0 ? amount / divisor : 0;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function receiptsInPeriod({ shopId, days, maxPages = 10 }) {
  const minCreated = Math.floor(Date.now() / 1000) - days * 86_400;
  const results = [];
  let available = 0;
  let pagesFetched = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await listReceipts({ shopId, limit: 100, offset: page * 100, minCreated });
    pagesFetched += 1;
    const pageResults = Array.isArray(response?.results) ? response.results : [];
    available = Math.max(available, responseCount(response));
    results.push(...pageResults);
    if (pageResults.length < 100 || results.length >= available) break;
  }
  return { minCreated, results, available, pagesFetched, truncated: results.length < available };
}

// Etsy Open API v3 has no /shops/{shop_id}/stats resource. Compute bounded,
// auditable summaries only from documented shop, listing, and receipt reads.
export async function getShopStats({ shopId, kind = 'shop', days = 30 } = {}) {
  const safeShopId = shopIdForPath(shopId);
  const safeKind = enumValue(kind, 'kind', STAT_KINDS, 'shop');
  const safeDays = boundedInteger(days, 'days', { min: 1, max: 365, fallback: 30 });

  if (safeKind === 'shop') {
    const shop = await getShop({ shopId: safeShopId });
    return { kind: safeKind, days: safeDays, source: 'etsy_shop', shop };
  }

  if (safeKind === 'listings') {
    const states = ['active', 'draft', 'inactive', 'expired', 'sold_out'];
    const responses = await Promise.all(states.map(state => listListings({
      shopId: safeShopId, state, limit: 1, offset: 0,
    })));
    return {
      kind: safeKind,
      days: safeDays,
      source: 'etsy_listings',
      counts: Object.fromEntries(states.map((state, index) => [state, responseCount(responses[index])])),
    };
  }

  const period = await receiptsInPeriod({ shopId: safeShopId, days: safeDays });
  if (safeKind === 'orders') {
    return {
      kind: safeKind,
      days: safeDays,
      source: 'etsy_receipts',
      count: period.results.length,
      available: period.available,
      truncated: period.truncated,
      paid: period.results.filter(item => item?.is_paid === true || item?.was_paid === true).length,
      shipped: period.results.filter(item => item?.is_shipped === true || item?.was_shipped === true).length,
      canceled: period.results.filter(item => item?.is_canceled === true || item?.was_canceled === true || item?.status === 'canceled').length,
      min_created: period.minCreated,
      pages_fetched: period.pagesFetched,
    };
  }

  const eligibleReceipts = period.results.filter(receipt =>
    (receipt?.is_paid === true || receipt?.was_paid === true)
    && receipt?.is_canceled !== true
    && receipt?.was_canceled !== true
    && receipt?.status !== 'canceled');
  const currencies = new Set();
  let total = 0;
  for (const receipt of eligibleReceipts) {
    const money = receipt?.grandtotal || receipt?.total_price || receipt?.total;
    const currency = money?.currency_code || receipt?.currency_code;
    if (currency) currencies.add(String(currency));
    total += moneyValue(money);
  }
  return {
    kind: safeKind,
    days: safeDays,
    source: 'etsy_receipts',
    gross_order_total: Number(total.toFixed(2)),
    currencies: [...currencies],
    receipt_count: eligibleReceipts.length,
    available: period.available,
    truncated: period.truncated,
    min_created: period.minCreated,
    pages_fetched: period.pagesFetched,
    note: 'Gross receipt total before Etsy fees, refunds, taxes, and payment-account adjustments.',
  };
}

export async function listListings({
  shopId,
  state = 'active',
  limit = 25,
  offset = 0,
  sortOn = 'created',
  sortOrder = 'desc',
} = {}) {
  const safeState = enumValue(state, 'state', LISTING_STATES, 'active');
  const safeLimit = boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 25 });
  const safeOffset = boundedInteger(offset, 'offset', { min: 0, max: 100_000, fallback: 0 });
  const safeSort = enumValue(sortOn, 'sort_on', SORT_FIELDS, 'created');
  const safeOrder = enumValue(sortOrder, 'sort_order', SORT_ORDERS, 'desc');
  const query = queryString({ state: safeState, limit: safeLimit, offset: safeOffset, sort_on: safeSort, sort_order: safeOrder, includes: 'Images' });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings?${query}`);
}

export async function searchShopListings({ shopId, keywords, limit = 20, offset = 0 } = {}) {
  const text = String(keywords || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 200) throw inputError('keywords must contain 1 to 200 characters');
  const safeLimit = boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 20 });
  const safeOffset = boundedInteger(offset, 'offset', { min: 0, max: 100_000, fallback: 0 });
  const query = queryString({ keywords: text, limit: safeLimit, offset: safeOffset, includes: 'Images' });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/active?${query}`);
}

export async function getFeaturedListings({ shopId, limit = 25, offset = 0 } = {}) {
  const query = queryString({
    limit: boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 25 }),
    offset: boundedInteger(offset, 'offset', { min: 0, max: 100_000, fallback: 0 }),
  });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/featured?${query}`);
}

export async function getListing({ listingId } = {}) {
  const listing = strictPositiveId(listingId, 'listing_id');
  return getListingWithInventory(listing, ['Images', 'Videos', 'Personalization']);
}

export async function createDraftListing({ shopId, listing = {} } = {}) {
  const body = buildListingBody({ ...listing, state: 'draft' });
  body.state = 'draft';
  if (!body.title || !body.description || !Number.isFinite(body.price) || body.price <= 0 || !body.taxonomy_id) {
    throw inputError('title, description, positive price, and taxonomy_id are required for an Etsy draft', 'INVALID_LISTING_DRAFT');
  }
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings?legacy=false`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateListing({ shopId, listingId, changes = {} } = {}) {
  const listing = strictPositiveId(listingId, 'listing_id');
  const unknownFields = Object.keys(changes || {}).filter(key => !LISTING_UPDATE_FIELDS.has(key));
  if (unknownFields.length) {
    const inventoryField = unknownFields.find(key => INVENTORY_UPDATE_FIELDS.has(key));
    if (inventoryField) {
      throw inputError(
        `Use the dedicated inventory operation for variation field: ${inventoryField}`,
        'INVENTORY_REQUIRES_DEDICATED_OPERATION',
      );
    }
    throw inputError(`Unsupported listing metadata field: ${unknownFields[0]}`, 'UNSUPPORTED_LISTING_PATCH_FIELD');
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'state')) {
    throw inputError('Use setListingState for state changes', 'STATE_REQUIRES_DEDICATED_OPERATION');
  }
  if (changes.price !== undefined || changes.quantity !== undefined) {
    const inventory = await getListingInventory({ listingId: listing });
    if (hasVariationInventoryForEtsy(inventory)) {
      throw inputError(
        'Variation listing prices and quantities must be changed through the dedicated inventory operation',
        'INVENTORY_REQUIRES_DEDICATED_OPERATION',
      );
    }
  }
  const body = buildListingUpdateBody(changes);
  if (!Object.keys(body).length) throw inputError('At least one supported listing field is required');
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${listing}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function setListingState({ shopId, listingId, state } = {}) {
  const listing = strictPositiveId(listingId, 'listing_id');
  const safeState = enumValue(state, 'state', MUTABLE_LISTING_STATES);
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${listing}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: safeState }),
  });
}

export async function deleteListing({ listingId } = {}) {
  return etsyFetch(`/listings/${strictPositiveId(listingId, 'listing_id')}`, { method: 'DELETE' });
}

export async function getListingInventory({ listingId } = {}) {
  return etsyFetch(`/listings/${strictPositiveId(listingId, 'listing_id')}/inventory`);
}

export async function updateListingInventory({ listingId, inventory } = {}) {
  const listing = strictPositiveId(listingId, 'listing_id');
  const payload = normalizeInventoryPayloadForEtsy(inventory || {});
  if (!payload.products.length) throw inputError('inventory.products must not be empty');
  return etsyFetch(`/listings/${listing}/inventory?legacy=false`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

function inventoryVerificationProjection(inventory = {}) {
  const normalized = normalizeInventoryPayloadForEtsy(inventory || {});
  const products = normalized.products.map(product => ({
    sku: product.sku || '',
    property_values: (product.property_values || [])
      .map(property => ({
        property_id: Number(property.property_id),
        property_name: String(property.property_name || ''),
        values: (property.values?.length ? property.values : property.value_ids || []).map(String),
        ...(property.scale_id != null ? { scale_id: Number(property.scale_id) } : {}),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    offerings: (product.offerings || []).map(offering => ({
      price: Number(offering.price),
      quantity: Number(offering.quantity),
      is_enabled: offering.is_enabled !== false,
      ...(offering.readiness_state_id != null
        ? { readiness_state_id: Number(offering.readiness_state_id) }
        : {}),
    })),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const numericSet = values => [...new Set((values || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  return {
    products,
    price_on_property: numericSet(normalized.price_on_property),
    quantity_on_property: numericSet(normalized.quantity_on_property),
    sku_on_property: numericSet(normalized.sku_on_property),
    readiness_state_on_property: numericSet(normalized.readiness_state_on_property),
  };
}

export async function updateAndVerifyListingInventory({ listingId, inventory } = {}) {
  const listing = strictPositiveId(listingId, 'listing_id');
  const expected = inventoryVerificationProjection(inventory);
  await updateListingInventory({ listingId: listing, inventory });
  const verifiedInventory = await getListingInventory({ listingId: listing });
  const actual = inventoryVerificationProjection(verifiedInventory);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw inputError(
      'Etsy accepted the inventory request but the read-back did not match the requested draft inventory',
      'INVENTORY_VERIFICATION_FAILED',
      502,
    );
  }
  return {
    listing_id: listing,
    updated: true,
    verified: true,
    inventory: verifiedInventory,
  };
}

export async function getListingProduct({ listingId, productId } = {}) {
  return etsyFetch(`/listings/${strictPositiveId(listingId, 'listing_id')}/inventory/products/${strictPositiveId(productId, 'product_id')}`);
}

export async function getListingOffering({ listingId, productId, offeringId } = {}) {
  return etsyFetch(`/listings/${strictPositiveId(listingId, 'listing_id')}/products/${strictPositiveId(productId, 'product_id')}/offerings/${strictPositiveId(offeringId, 'offering_id')}`);
}

export async function getListingVariationImages({ shopId, listingId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/variation-images`);
}

export async function updateListingVariationImages({ shopId, listingId, variationImages } = {}) {
  if (!Array.isArray(variationImages) || !variationImages.length || variationImages.length > 100) {
    throw inputError('variation_images must contain 1 to 100 entries');
  }
  const normalized = variationImages.map((item, index) => ({
    property_id: strictPositiveId(item?.property_id, `variation_images[${index}].property_id`),
    value_id: strictPositiveId(item?.value_id, `variation_images[${index}].value_id`),
    image_id: strictPositiveId(item?.image_id, `variation_images[${index}].image_id`),
  }));
  if (new Set(normalized.map(item => item.property_id)).size !== 1) {
    throw inputError('variation_images may reference only one property_id');
  }
  const pairs = normalized.map(item => `${item.property_id}:${item.value_id}`);
  if (new Set(pairs).size !== pairs.length) throw inputError('variation_images must not contain duplicate property/value pairs');
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/variation-images`, {
    method: 'POST',
    body: JSON.stringify({ variation_images: normalized }),
  });
}

export async function getListingTranslation({ shopId, listingId, language } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/translations/${cleanLanguage(language)}`);
}

function listingTranslationBody(value) {
  const body = allowedBody(value, ['title', 'description', 'tags'], {
    required: ['title', 'description'], label: 'translation',
  });
  if (!String(body.title).trim() || String(body.title).length > 140) throw inputError('translation.title must contain 1 to 140 characters');
  if (!String(body.description).trim() || String(body.description).length > 50_000) throw inputError('translation.description must contain 1 to 50000 characters');
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 13)) throw inputError('translation.tags must be an array of at most 13 tags');
  return body;
}

export async function createListingTranslation({ shopId, listingId, language, translation } = {}) {
  const path = `/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/translations/${cleanLanguage(language)}`;
  return etsyForm(path, 'POST', listingTranslationBody(translation));
}

export async function updateListingTranslation({ shopId, listingId, language, translation } = {}) {
  const path = `/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/translations/${cleanLanguage(language)}`;
  return etsyForm(path, 'PUT', listingTranslationBody(translation));
}

export async function getListingProperties({ shopId, listingId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/properties`);
}

export async function getListingProperty({ shopId, listingId, propertyId } = {}) {
  const safePropertyId = strictPositiveId(propertyId, 'property_id');
  // Etsy documents the singular property endpoint as non-functional (501).
  // Read the supported collection and select the exact property locally.
  const response = await getListingProperties({ shopId, listingId });
  const property = (Array.isArray(response?.results) ? response.results : [])
    .find(item => Number(item?.property_id) === safePropertyId);
  if (!property) throw inputError('Listing property not found', 'NOT_FOUND', 404);
  return property;
}

export async function updateListingProperty({ shopId, listingId, propertyId, property } = {}) {
  const body = allowedBody(property, ['value_ids', 'values', 'scale_id'], {
    required: ['value_ids', 'values'], label: 'property',
  });
  if (!Array.isArray(body.value_ids) || !body.value_ids.length || body.value_ids.some(value => !Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
    throw inputError('property.value_ids must be an array of positive integer IDs');
  }
  if (!Array.isArray(body.values) || !body.values.length || body.values.some(value => typeof value !== 'string' || !value.trim() || /[()]/.test(value))) {
    throw inputError('property.values must be an array of non-empty strings');
  }
  if (body.value_ids.length !== body.values.length) throw inputError('property.value_ids and property.values must have equal length');
  const path = `/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/properties/${strictPositiveId(propertyId, 'property_id')}`;
  return etsyForm(path, 'PUT', body);
}

export async function deleteListingProperty({ shopId, listingId, propertyId } = {}) {
  const path = `/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/properties/${strictPositiveId(propertyId, 'property_id')}`;
  return etsyFetch(path, { method: 'DELETE' });
}

export async function getListingPersonalization({ listingId } = {}) {
  return etsyFetch(`/listings/${strictPositiveId(listingId, 'listing_id')}/personalization`);
}

export async function updateListingPersonalization({ shopId, listingId, questions } = {}) {
  const normalized = normalizePersonalizationQuestionsForEtsy(questions);
  if (!normalized.length || normalized.length > 5) throw inputError('personalization questions must contain 1 to 5 entries');
  const errors = validatePersonalizationQuestionsForEtsy(normalized);
  if (errors.length) throw inputError(errors.join('; '), 'INVALID_PERSONALIZATION');
  const query = 'supports_multiple_personalization_questions=true';
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/personalization?${query}`, {
    method: 'POST',
    body: JSON.stringify({ personalization_questions: normalized }),
  });
}

export async function deleteListingPersonalization({ shopId, listingId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/personalization`, { method: 'DELETE' });
}

export async function getListingImages({ listingId } = {}) {
  const response = await etsyFetch(listingImagePath(strictPositiveId(listingId, 'listing_id')));
  return { ...response, results: normalizeListingImagesResponse(response) };
}

export async function getListingImage({ listingId, listingImageId } = {}) {
  return etsyFetch(listingImagePath(
    strictPositiveId(listingId, 'listing_id'),
    strictPositiveId(listingImageId, 'listing_image_id'),
  ));
}

export async function uploadPreparedListingImage({ shopId, listingId, buffer, mimeType, rank, overwrite, altText } = {}) {
  const imageBuffer = Buffer.isBuffer(buffer) ? buffer : null;
  if (!imageBuffer?.length) throw inputError('image buffer must be a non-empty Buffer');
  let token = await getValidToken();
  const args = {
    token,
    listingId: strictPositiveId(listingId, 'listing_id'),
    imageBuffer,
    mimeType,
    rank,
    overwrite,
    altText,
    shopId: shopIdForPath(shopId),
  };
  try {
    return await uploadListingImageBuffer(args);
  } catch (error) {
    if (error?.status !== 401) throw error;
    await refreshAccessToken();
    token = await getValidToken();
    return uploadListingImageBuffer({ ...args, token });
  }
}

export async function associateListingImage({ shopId, listingId, listingImageId, rank, altText } = {}) {
  return associateListingImageMultipart({
    shopId: shopIdForPath(shopId),
    listingId: strictPositiveId(listingId, 'listing_id'),
    listingImageId: strictPositiveId(listingImageId, 'listing_image_id'),
    rank,
    ...(altText ? { altText: validateListingImageAltText(altText) } : {}),
  });
}

export async function updateListingImageAltText({ shopId, listingId, listingImageId, altText } = {}) {
  return updateListingImageAltTextMultipart({
    shopId: shopIdForPath(shopId),
    listingId: strictPositiveId(listingId, 'listing_id'),
    listingImageId: strictPositiveId(listingImageId, 'listing_image_id'),
    altText: validateListingImageAltText(altText),
  });
}

export async function deleteListingImage({ shopId, listingId, listingImageId } = {}) {
  const path = `/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/images/${strictPositiveId(listingImageId, 'listing_image_id')}`;
  return etsyFetch(path, { method: 'DELETE' });
}

export async function getListingVideos({ listingId } = {}) {
  return etsyFetch(`/listings/${strictPositiveId(listingId, 'listing_id')}/videos`);
}

export async function uploadPreparedListingVideo({ shopId, listingId, buffer, name, mimeType } = {}) {
  return uploadListingVideoMultipart({ shopId: shopIdForPath(shopId), listingId: strictPositiveId(listingId, 'listing_id'), buffer, name, mimeType });
}

export async function associateListingVideo({ shopId, listingId, videoId } = {}) {
  return associateListingVideoMultipart({ shopId: shopIdForPath(shopId), listingId: strictPositiveId(listingId, 'listing_id'), videoId: strictPositiveId(videoId, 'video_id') });
}

export async function deleteListingVideo({ shopId, listingId, videoId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/videos/${strictPositiveId(videoId, 'video_id')}`, { method: 'DELETE' });
}

export async function listDigitalListingFiles({ shopId, listingId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/files`);
}

export async function getDigitalListingFile({ shopId, listingId, listingFileId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/files/${strictPositiveId(listingFileId, 'listing_file_id')}`);
}

function digitalFilename(value) {
  const raw = String(value || 'digital-file').normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_');
  const dot = raw.lastIndexOf('.');
  const extension = dot > 0 && raw.length - dot <= 12 ? raw.slice(dot) : '';
  const stem = (extension ? raw.slice(0, dot) : raw).replace(/^\.+|\.+$/g, '') || 'digital-file';
  return `${stem.slice(0, Math.max(1, 70 - extension.length))}${extension}`;
}

export async function uploadPreparedDigitalListingFile({ shopId, listingId, buffer, name, mimeType, rank } = {}) {
  return uploadDigitalListingFileMultipart({ shopId: shopIdForPath(shopId), listingId: strictPositiveId(listingId, 'listing_id'), buffer, name: digitalFilename(name), mimeType, rank });
}

export async function associateDigitalListingFile({ shopId, listingId, listingFileId, rank } = {}) {
  return associateDigitalListingFileMultipart({ shopId: shopIdForPath(shopId), listingId: strictPositiveId(listingId, 'listing_id'), listingFileId: strictPositiveId(listingFileId, 'listing_file_id'), rank });
}

export async function deleteDigitalListingFile({ shopId, listingId, listingFileId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/files/${strictPositiveId(listingFileId, 'listing_file_id')}`, { method: 'DELETE' });
}

export async function listReceipts({ shopId, limit = 25, offset = 0, minCreated, maxCreated, wasPaid, wasShipped } = {}) {
  const query = queryString({
    limit: boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 25 }),
    offset: boundedInteger(offset, 'offset', { min: 0, max: 100_000, fallback: 0 }),
    min_created: minCreated === undefined ? undefined : boundedInteger(minCreated, 'min_created', { min: 946684800, max: 4_102_444_800 }),
    max_created: maxCreated === undefined ? undefined : boundedInteger(maxCreated, 'max_created', { min: 946684800, max: 4_102_444_800 }),
    was_paid: typeof wasPaid === 'boolean' ? wasPaid : undefined,
    was_shipped: typeof wasShipped === 'boolean' ? wasShipped : undefined,
    sort_on: 'created',
    sort_order: 'desc',
  });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/receipts?${query}`);
}

export async function getReceipt({ shopId, receiptId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/receipts/${strictPositiveId(receiptId, 'receipt_id')}`);
}

export async function createReceiptShipment({ shopId, receiptId, trackingCode, carrierName, sendBcc = true, noteToBuyer = '' } = {}) {
  const tracking = String(trackingCode || '').trim();
  const carrier = String(carrierName || '').trim();
  if (!tracking || tracking.length > 100 || !carrier || carrier.length > 100) {
    throw inputError('tracking_code and carrier_name are required and must be 100 characters or fewer');
  }
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/receipts/${strictPositiveId(receiptId, 'receipt_id')}/tracking`, {
    method: 'POST',
    body: JSON.stringify({
      tracking_code: tracking,
      carrier_name: carrier,
      send_bcc: sendBcc !== false,
      note_to_buyer: String(noteToBuyer || '').slice(0, 500),
    }),
  });
}

export async function listTransactions({ shopId, limit = 25, offset = 0 } = {}) {
  const query = queryString({
    limit: boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 25 }),
    offset: boundedInteger(offset, 'offset', { min: 0, max: 100_000, fallback: 0 }),
  });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/transactions?${query}`);
}

export async function getTransaction({ shopId, transactionId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/transactions/${strictPositiveId(transactionId, 'transaction_id')}`);
}

export async function getListingTransactions({ shopId, listingId, limit = 25, offset = 0 } = {}) {
  const query = queryString({
    limit: boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 25 }),
    offset: boundedInteger(offset, 'offset', { min: 0, max: 100_000, fallback: 0 }),
  });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/listings/${strictPositiveId(listingId, 'listing_id')}/transactions?${query}`);
}

export async function getReceiptTransactions({ shopId, receiptId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/receipts/${strictPositiveId(receiptId, 'receipt_id')}/transactions?legacy=false`);
}

function positiveIdList(values, name) {
  if (!Array.isArray(values) || !values.length || values.length > 100) throw inputError(`${name} must contain 1 to 100 IDs`);
  return values.map((value, index) => strictPositiveId(value, `${name}[${index}]`));
}

export async function getPayments({ shopId, paymentIds } = {}) {
  const ids = positiveIdList(paymentIds, 'payment_ids');
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/payments?payment_ids=${ids.join(',')}`);
}

export async function getReceiptPayments({ shopId, receiptId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/receipts/${strictPositiveId(receiptId, 'receipt_id')}/payments`);
}

export async function getLedgerEntries({ shopId, minCreated, maxCreated, limit = 25, offset = 0 } = {}) {
  const query = queryString({
    min_created: boundedInteger(minCreated, 'min_created', { min: 946684800, max: 4_102_444_800 }),
    max_created: boundedInteger(maxCreated, 'max_created', { min: 946684800, max: 4_102_444_800 }),
    limit: boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 25 }),
    offset: boundedInteger(offset, 'offset', { min: 0, max: 100_000, fallback: 0 }),
  });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/payment-account/ledger-entries?${query}`);
}

export async function getLedgerEntry({ shopId, ledgerEntryId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/payment-account/ledger-entries/${strictPositiveId(ledgerEntryId, 'ledger_entry_id')}`);
}

export async function getLedgerEntryPayments({ shopId, ledgerEntryIds } = {}) {
  // Etsy's endpoint-specific Payments Tutorial requires one comma-separated
  // value, encoded by URLSearchParams as %2C in the upstream request URL.
  const ids = positiveIdList(ledgerEntryIds, 'ledger_entry_ids');
  const query = new URLSearchParams({ ledger_entry_ids: ids.join(',') });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/payment-account/ledger-entries/payments?${query}`);
}

export async function getSellerTaxonomy() {
  return etsyFetch('/seller-taxonomy/nodes');
}

export async function getTaxonomyProperties({ taxonomyId } = {}) {
  return etsyFetch(`/seller-taxonomy/nodes/${strictPositiveId(taxonomyId, 'taxonomy_id')}/properties`);
}

export async function listReviews({ shopId, limit = 25, offset = 0 } = {}) {
  const query = queryString({
    limit: boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 25 }),
    offset: boundedInteger(offset, 'offset', { min: 0, max: 100_000, fallback: 0 }),
  });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/reviews?${query}`);
}

export async function listDiscounts({ shopId, limit = 100 } = {}) {
  const safeLimit = boundedInteger(limit, 'limit', { min: 1, max: 100, fallback: 100 });
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/discounts?limit=${safeLimit}`);
}

export async function getDiscount({ shopId, discountId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/discounts/${strictPositiveId(discountId, 'discount_id')}`);
}

export async function createDiscount({ shopId, discount } = {}) {
  const body = discountBody(discount, false);
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/discounts`, { method: 'POST', body: JSON.stringify(body) });
}

export async function updateDiscount({ shopId, discountId, changes } = {}) {
  const body = discountBody(changes, true);
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/discounts/${strictPositiveId(discountId, 'discount_id')}`, { method: 'PUT', body: JSON.stringify(body) });
}

export async function deleteDiscount({ shopId, discountId } = {}) {
  return etsyFetch(`/shops/${shopIdForPath(shopId)}/discounts/${strictPositiveId(discountId, 'discount_id')}`, { method: 'DELETE' });
}

function discountBody(value = {}, partial) {
  const body = {};
  if (value.discount_name !== undefined) body.discount_name = String(value.discount_name || '').trim().slice(0, 100);
  if (value.discount_type !== undefined) body.discount_type = String(value.discount_type || '').trim();
  if (value.discount_value !== undefined) body.discount_value = Number(value.discount_value);
  if (value.min_order_quantity_type !== undefined) body.min_order_quantity_type = String(value.min_order_quantity_type || '').trim();
  if (value.min_order_quantity !== undefined) body.min_order_quantity = boundedInteger(value.min_order_quantity, 'min_order_quantity', { min: 1, max: 999 });
  if (value.start_date !== undefined) body.start_date = boundedInteger(value.start_date, 'start_date', { min: 946684800, max: 4_102_444_800 });
  if (value.end_date !== undefined) body.end_date = boundedInteger(value.end_date, 'end_date', { min: 946684800, max: 4_102_444_800 });
  if (value.seller_active !== undefined) body.seller_active = value.seller_active === true;
  if (!Object.keys(body).length || (!partial && (!body.discount_name || !body.discount_type || !Number.isFinite(body.discount_value)))) {
    throw inputError('A valid discount payload is required');
  }
  return body;
}
