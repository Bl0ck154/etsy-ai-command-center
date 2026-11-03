// Delay between image copies to avoid Etsy API "being edited" conflicts
import { sanitizeEtsyMaterials, sanitizeEtsyTags, sanitizeEtsyTitle, stripMarkdownForEtsy } from './_etsy-text.js';

export const IMAGE_COPY_DELAY_MS = 500;

// Safely parse any ID to integer — prevents /listings/NaN/ URLs
export function safeInt(val) {
  const n = parseInt(String(val ?? '').trim(), 10);
  if (isNaN(n)) throw new Error(`Invalid ID value: ${val}`);
  return n;
}

export function clampEtsyTitle(value, max = 140) {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim();
  return title.length > max ? title.slice(0, max).trim() : title;
}

export function buildListingBody(p, options = {}) {
  const defaults = options.defaults !== false;
  const body = {};
  if (p.title !== undefined) body.title = clampEtsyTitle(sanitizeEtsyTitle(p.title));
  if (p.description !== undefined) body.description = stripMarkdownForEtsy(p.description);
  if (p.price !== undefined) {
    const raw = p.price;
    body.price = (typeof raw === 'object' && raw !== null && raw.amount !== undefined)
      ? raw.amount / (raw.divisor || 100)
      : parseFloat(raw);
  }
  if (p.quantity !== undefined) body.quantity = parseInt(p.quantity);
  if (p.tags !== undefined) body.tags = Array.isArray(p.tags) ? sanitizeEtsyTags(p.tags) : [];
  if (p.materials !== undefined) body.materials = sanitizeEtsyMaterials(p.materials);
  if (p.who_made !== undefined) body.who_made = p.who_made;
  if (p.when_made !== undefined) body.when_made = p.when_made;
  if (p.taxonomy_id !== undefined) body.taxonomy_id = parseInt(p.taxonomy_id);
  if (p.listing_type !== undefined) {
    body.listing_type = p.listing_type;
    body.type = p.listing_type;
  }
  if (p.is_supply !== undefined) body.is_supply = Boolean(p.is_supply);
  if (p.should_auto_renew !== undefined) body.should_auto_renew = Boolean(p.should_auto_renew);
  if (p.shop_section_id !== undefined && p.shop_section_id) body.shop_section_id = parseInt(p.shop_section_id);

  const isDigital = (p.listing_type || body.listing_type) === 'download';
  if (!isDigital) {
    if (p.shipping_profile_id !== undefined && p.shipping_profile_id !== null) body.shipping_profile_id = parseInt(p.shipping_profile_id);
    if (p.return_policy_id !== undefined && p.return_policy_id !== null) body.return_policy_id = parseInt(p.return_policy_id);
    if (p.readiness_state_id !== undefined && p.readiness_state_id !== null) body.readiness_state_id = parseInt(p.readiness_state_id);
    if (p.processing_min !== undefined && p.processing_min !== null) body.processing_min = parseInt(p.processing_min);
    if (p.processing_max !== undefined && p.processing_max !== null) body.processing_max = parseInt(p.processing_max);
  } else {
    delete body.shipping_profile_id;
    delete body.return_policy_id;
    delete body.readiness_state_id;
    delete body.processing_min;
    delete body.processing_max;
  }

  if (p.state !== undefined) body.state = p.state;
  if (p.language !== undefined) body.language = p.language;
  if (defaults) {
    if (!body.quantity) body.quantity = 999;
    if (!body.who_made) body.who_made = 'i_did';
    if (!body.when_made) body.when_made = 'made_to_order';
    if (body.should_auto_renew === undefined) body.should_auto_renew = true;
  }

  return body;
}

export function buildListingUpdateBody(p) {
  return buildListingBody(p, { defaults: false });
}

export function buildImageFormData(params) {
  return params.imageBase64;
}
