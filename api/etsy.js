// api/etsy.js — Etsy API proxy
// Handles all Etsy API calls server-side to avoid CORS and protect credentials

import { requireAuth } from './_auth.js';
import { writeSecurityAudit } from './_security-audit.js';
import { publicErrorMessage } from './_errors.js';
import { etsyFetch, getListingWithInventory, API_KEY_FULL } from './_etsy.js';
import { getActiveShopId, parseShopsFromEnv } from './_shops.js';
import { buildImageFormData, buildListingBody, buildListingUpdateBody, IMAGE_COPY_DELAY_MS, safeInt } from './_listing-body.js';
import { listingVideoUrl } from '../public/utils/media-url.js';
import {
  listingImagePath,
  normalizeListingImagesResponse,
  requireExplicitListingWriteConfirmation,
  validateListingImageAltText,
} from './_listing-image-alt-text.js';
import { isCurrentPaidReceipt, receiptLifecycle } from '../public/utils/receipt-lifecycle.js';

export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };

function optionalAuditId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  try { return safeInt(value); } catch { return undefined; }
}

export function normalizeDropdownOptionLabel(value) {
  let label = String(value || '').trim();
  const aspect = label.match(/^(\d{1,2}\s*:\s*\d{1,2})\b/);
  if (aspect) return aspect[1].replace(/\s+/g, '');
  if (/^square\b/i.test(label)) return 'Square';
  label = label.replace(/\s*\([^)]*\)\s*/g, '').trim();
  label = label.replace(/:.*/, '').trim();
  if (label.length > 20) label = label.slice(0, 20).trim();
  return label;
}

function normalizeQuestionText(value) {
  let text = String(value || 'Personalization').trim();
  text = text.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/[\s:;,.!?-]+$/g, '').trim();
  if (/aspect ratio/i.test(text)) return 'Select Aspect Ratio';
  if (/print size/i.test(text)) return 'Select Print Size';
  if (/upload|reference photo|photos?/i.test(text)) return 'Upload Reference Photos';
  if (/special instructions|names|specific details/i.test(text)) return 'Special Instructions';
  if (/orientation/i.test(text)) return 'Select Orientation';
  return text.slice(0, 60).trim() || 'Personalization';
}

function toEtsyPersonalizationQuestion(q = {}) {
  const requestedType = q.question_type;
  const hasLabels = Array.isArray(q.options) && q.options.length > 0;
  const questionType = requestedType === 'file_upload'
    ? (hasLabels ? 'labeled_upload' : 'unlabeled_upload')
    : requestedType;
  const questionText = normalizeQuestionText(q.question_text);
  const rawOptions = Array.isArray(q.options) ? q.options : [];
  const options = rawOptions.map(o => ({ label: normalizeDropdownOptionLabel(o.label || String(o)) })).filter(o => o.label);
  const uploadMax = hasLabels ? options.length : 10;
  if (questionType === 'dropdown' && !options.length && /\borientation\b/i.test(questionText)) {
    options.push({ label: 'Portrait' }, { label: 'Landscape' });
  }
  return {
    question_type: questionType || 'text_input',
    question_text: questionText,
    required: q.required === true,
    ...(questionType === 'text_input' ? { max_allowed_characters: q.max_allowed_characters || 1024 } : {}),
    ...(questionType === 'dropdown' && options.length ? { options } : {}),
    ...(questionType === 'unlabeled_upload' ? { max_allowed_files: uploadMax } : {}),
    ...(questionType === 'labeled_upload' ? { max_allowed_files: uploadMax, options } : {}),
  };
}

function normalizeMoneyValue(value) {
  if (value && typeof value === 'object' && value.amount != null) {
    const divisor = Number(value.divisor) || 100;
    return Number(value.amount) / divisor;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const DEPRECATED_CUSTOM_PROPERTY_IDS = new Set([100, 101]);
const CUSTOM_PROPERTY_IDS = [513, 514];

function inventoryPropertyIdMap(products = []) {
  const propertyIds = [];
  for (const product of products || []) {
    for (const property of product.property_values || []) {
      const id = Number(property.property_id || 0);
      if (id > 0 && !propertyIds.includes(id)) propertyIds.push(id);
    }
  }
  const used = new Set(propertyIds.filter(id => !DEPRECATED_CUSTOM_PROPERTY_IDS.has(id)));
  const mapped = new Map();
  for (const id of propertyIds.filter(id => DEPRECATED_CUSTOM_PROPERTY_IDS.has(id))) {
    const replacement = CUSTOM_PROPERTY_IDS.find(candidate => !used.has(candidate));
    if (!replacement) {
      const err = new Error('Custom variations could not be migrated to Etsy property slots 513 and 514. Remove and add the variation types again.');
      err.status = 400;
      err.isValidation = true;
      throw err;
    }
    mapped.set(id, replacement);
    used.add(replacement);
  }
  return mapped;
}

function normalizeInventoryProducts(products = [], fallbackReadinessStateId = null, propertyIdMap = new Map()) {
  return (products || []).map(prod => ({
    sku: prod.sku || '',
    property_values: Array.isArray(prod.property_values) ? prod.property_values.map(pv => {
      const sourceId = Number(pv.property_id || 0);
      const migratedId = propertyIdMap.get(sourceId);
      return {
        property_id: migratedId || sourceId,
        value_ids: migratedId ? [] : (pv.value_ids || []),
        property_name: pv.property_name,
        values: pv.values || [],
        ...(pv.scale_id != null ? { scale_id: pv.scale_id } : {}),
      };
    }) : [],
    offerings: (prod.offerings || []).map(off => {
      const readinessStateId = Number(off.readiness_state_id || fallbackReadinessStateId || 0);
      return {
        price: normalizeMoneyValue(off.price),
        quantity: Math.max(0, Math.min(999, parseInt(off.quantity, 10) || 0)),
        is_enabled: off.is_enabled !== false,
        ...(readinessStateId > 0 ? { readiness_state_id: readinessStateId } : {}),
      };
    }),
  }));
}

function mapInventoryPropertyIds(values = [], propertyIdMap = new Map()) {
  return [...new Set((values || [])
    .map(value => propertyIdMap.get(Number(value)) || Number(value))
    .filter(value => value > 0))];
}

function inventoryPropertyValueKey(property = {}) {
  const values = Array.isArray(property.values) && property.values.length
    ? property.values
    : (property.value_ids || []);
  return `${property.property_id}:${values.map(value => String(value)).join(',')}`;
}

function derivePriceOnProperty(products = []) {
  const propertyIds = [...new Set(products.flatMap(product =>
    (product.property_values || []).map(property => Number(property.property_id)).filter(Boolean)))];
  return propertyIds.filter(propertyId => {
    const groups = new Map();
    for (const product of products) {
      const key = (product.property_values || [])
        .filter(property => Number(property.property_id) !== propertyId)
        .map(inventoryPropertyValueKey)
        .sort()
        .join('|');
      if (!groups.has(key)) groups.set(key, new Set());
      const price = Number(product.offerings?.[0]?.price);
      if (Number.isFinite(price)) groups.get(key).add(price.toFixed(2));
    }
    return [...groups.values()].some(prices => prices.size > 1);
  });
}

function normalizeInventoryPayload(inventory = {}) {
  inventory = inventory || {};
  const propertyIdMap = inventoryPropertyIdMap(inventory.products || []);
  const products = normalizeInventoryProducts(inventory.products || [], inventory.readiness_state_id, propertyIdMap);
  const derivedPriceProperties = derivePriceOnProperty(products);
  return {
    products,
    price_on_property: derivedPriceProperties.length
      ? derivedPriceProperties
      : mapInventoryPropertyIds(inventory.price_on_property, propertyIdMap),
    quantity_on_property: mapInventoryPropertyIds(inventory.quantity_on_property, propertyIdMap),
    sku_on_property: mapInventoryPropertyIds(inventory.sku_on_property, propertyIdMap),
    readiness_state_on_property: mapInventoryPropertyIds(inventory.readiness_state_on_property, propertyIdMap),
  };
}

function normalizeInventoryParams(params = {}) {
  return {
    products: params.products || [],
    price_on_property: params.price_on_property || [],
    quantity_on_property: params.quantity_on_property || [],
    sku_on_property: params.sku_on_property || [],
    readiness_state_id: params.readiness_state_id || null,
    readiness_state_on_property: params.readiness_state_on_property || [],
  };
}

export function hasVariationInventory(inventory = {}) {
  inventory = inventory || {};
  return Boolean(
    inventory.price_on_property?.length
    || inventory.quantity_on_property?.length
    || inventory.sku_on_property?.length
    || (inventory.products || []).some(product => product.property_values?.length)
  );
}

async function withEditRetry(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 700 * attempt));
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const text = `${err.message || ''} ${extractEtsyErrorText(err.data)}`;
      if (!/(edit|process|conflict|locked|busy|429|409)/i.test(text) && err.status !== 409 && err.status !== 429) break;
      console.warn(`[etsy.js] Retrying ${label} after Etsy edit conflict (${attempt + 1}/3):`, err.message);
    }
  }
  throw lastErr;
}

async function deleteListingQuietly(listingId) {
  try {
    await etsyFetch(`/listings/${safeInt(listingId)}`, { method: 'DELETE' });
  } catch (err) {
    console.warn('[duplicateListing] Rollback delete failed:', err.message, err.data || '');
  }
}

async function putListingInventory(listingId, inventory) {
  inventory = inventory || {};
  const payload = normalizeInventoryPayload(inventory);
  if (!payload.products.length) return null;
  return withEditRetry(() => etsyFetch(`/listings/${safeInt(listingId)}/inventory?legacy=false`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  }), 'inventory update');
}

async function putListingPersonalization(shopId, listingId, questions) {
  const normalizedQuestions = normalizePersonalizationQuestionsForEtsy(questions);
  if (!normalizedQuestions.length) return null;
  const validationErrors = validatePersonalizationQuestionsForEtsy(normalizedQuestions);
  if (validationErrors.length) {
    const err = new Error(validationErrors.join('; '));
    err.status = 400;
    err.request = { listing_id: listingId, personalization_questions: normalizedQuestions };
    err.isValidation = true;
    throw err;
  }
  return withEditRetry(() => etsyFetch(`/shops/${shopId}/listings/${safeInt(listingId)}/personalization?supports_multiple_personalization_questions=true`, {
    method: 'POST',
    body: JSON.stringify({ personalization_questions: normalizedQuestions }),
  }), 'personalization update');
}

function extractEtsyErrorText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  const parts = [data.error_description, data.error, data.message, data.detail, data.raw].filter(Boolean);
  if (Array.isArray(data.errors)) parts.push(...data.errors.map(e => typeof e === 'string' ? e : (e.message || e.detail || JSON.stringify(e))));
  return parts.join(' ').trim();
}

function formatEtsyValidationDetails(data) {
  if (!Array.isArray(data?.errors)) return '';
  return data.errors.map(error => {
    if (typeof error === 'string') return error;
    const pointer = String(error?.source?.pointer || error?.path || '').toLowerCase();
    const field = pointer.includes('/title') ? 'Title'
      : pointer.includes('/materials') ? 'Materials'
        : pointer.includes('/tags') ? 'Tags'
          : pointer.includes('/price') ? 'Price'
            : pointer.includes('/taxonomy') ? 'Category'
              : '';
    const detail = error?.detail || error?.message || error?.title || '';
    return [field, detail].filter(Boolean).join(': ');
  }).filter(Boolean).join('; ');
}

export function normalizeInventoryProductsForEtsy(products = []) {
  const propertyIdMap = inventoryPropertyIdMap(products);
  return normalizeInventoryProducts(products, null, propertyIdMap);
}

export function normalizeInventoryPayloadForEtsy(inventory = {}) {
  return normalizeInventoryPayload(inventory);
}

export function hasVariationInventoryForEtsy(inventory = {}) {
  return hasVariationInventory(inventory);
}

export function normalizePersonalizationQuestionsForEtsy(questions) {
  return Array.isArray(questions) ? questions.map(toEtsyPersonalizationQuestion) : [];
}

export function validatePersonalizationQuestionsForEtsy(questions) {
  const errors = [];
  (questions || []).forEach((q, idx) => {
    if (q.question_type === 'dropdown' && (!Array.isArray(q.options) || q.options.length === 0)) {
      errors.push(`Question ${idx + 1} (${q.question_text || 'Dropdown'}) is a dropdown but has no options`);
    }
    if (q.question_type === 'dropdown' && Array.isArray(q.options)) {
      const labels = q.options.map(o => o.label || String(o));
      const duplicate = labels.find((label, labelIdx) => labels.indexOf(label) !== labelIdx);
      const tooLong = labels.find(label => String(label).length > 20);
      if (tooLong) errors.push(`Question ${idx + 1} (${q.question_text || 'Dropdown'}) has an option over 20 characters: ${tooLong}`);
      if (duplicate) errors.push(`Question ${idx + 1} (${q.question_text || 'Dropdown'}) has duplicate option: ${duplicate}`);
    }
    if (q.question_type === 'labeled_upload' && (!Array.isArray(q.options) || q.options.length !== q.max_allowed_files)) {
      errors.push(`Question ${idx + 1} (${q.question_text || 'File upload'}) labeled_upload options must match max_allowed_files`);
    }
  });
  return errors;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const { action, ...params } = req.method === 'GET' ? req.query : { ...req.query, ...req.body };
  const isWriteAction = Boolean(action) && !/^(get|search)/.test(action);
  if (req.method === 'GET' && isWriteAction) {
    return res.status(405).json({ error: 'This Etsy action requires a state-changing request method', code: 'WRITE_REQUIRES_POST' });
  }


  // Guard: check required env vars on every request
  if (!process.env.ETSY_API_KEY) return res.status(500).json({ error: 'ETSY_API_KEY environment variable not set. Add it to the runtime environment.' });
  const SHOP_ID = getActiveShopId(req);
  if (!SHOP_ID) {
    console.error('[etsy.js] SHOP_ID empty. ETSY_SHOP_ID env =', JSON.stringify(process.env.ETSY_SHOP_ID));
    return res.status(500).json({ error: 'ETSY_SHOP_ID not set. Add it to the runtime environment.', debug: { raw: process.env.ETSY_SHOP_ID } });
  }

  try {
    let result;

    switch (action) {

      // ── MULTI-SHOP ────────────────────────────────────────
      case 'getAvailableShops':
        result = parseShopsFromEnv();
        break;

      case 'searchListings': {
        // Public search — no auth needed but we pass key for rate limit
        const q = params.keyword || '';
        const limit = params.limit || 20;
        const r = await fetch(
          `https://openapi.etsy.com/v3/application/listings/active?keywords=${encodeURIComponent(q)}&limit=${limit}&sort_on=score&sort_order=desc&includes=MainImage`,
          { headers: { 'x-api-key': API_KEY_FULL } }
        );
        const d = await r.json();
        if (!r.ok) throw { status: r.status, message: d.error_description || 'Search failed' };
        result = d;
        break;
      }

      // ── SHOP ──────────────────────────────────────────────
      case 'getShop':
        result = await etsyFetch(`/shops/${SHOP_ID}`);
        break;

      case 'getShopSections':
        result = await etsyFetch(`/shops/${SHOP_ID}/sections`);
        break;

      case 'createShopSection':
        result = await etsyFetch(`/shops/${SHOP_ID}/sections`, {
          method: 'POST',
          body: JSON.stringify({ title: params.title }),
        });
        break;

      case 'getShippingProfiles':
        result = await etsyFetch(`/shops/${SHOP_ID}/shipping-profiles`);
        break;

      case 'getReadinessStateDefinitions':
        result = await etsyFetch(`/shops/${SHOP_ID}/readiness-state-definitions?limit=100`);
        break;

      case 'getReturnPolicies':
        result = await etsyFetch(`/shops/${SHOP_ID}/policies/return`);
        break;

      case 'getShopStats':
        result = await etsyFetch(`/shops/${SHOP_ID}/stats?unit=${params.unit || 'day'}&limit=${params.limit || 30}`);
        break;

      // ── LISTINGS ──────────────────────────────────────────
      case 'getListings': {
        const limit = params.limit || 25;
        const offset = params.offset || 0;
        const state = params.state || 'active';
        const sort_on = params.sort_on || 'created';
        const sort_order = params.sort_order || 'desc';
        result = await etsyFetch(
          `/shops/${SHOP_ID}/listings?state=${state}&limit=${limit}&offset=${offset}&sort_on=${sort_on}&sort_order=${sort_order}&includes=Images`
        );
        break;
      }

      case 'getListing':
        result = await getListingWithInventory(
          safeInt(params.listing_id),
          ['Images', 'Videos', 'Personalization']
        );
        break;

      case 'createListing': {
        const body = buildListingBody(params);
        result = await etsyFetch(`/shops/${SHOP_ID}/listings?legacy=false`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        break;
      }

      case 'updateListing': {
        const { listing_id, ...updateFields } = params;
        if (updateFields.price !== undefined) {
          const inventory = await etsyFetch(`/listings/${safeInt(listing_id)}/inventory`).catch(() => null);
          if (hasVariationInventory(inventory)) {
            const err = new Error('Variation listing prices must be updated through inventory so variations are preserved. Use updateListingVariationInventory.');
            err.status = 400;
            err.data = { code: 'PRICE_REQUIRES_INVENTORY_UPDATE', listing_id: safeInt(listing_id) };
            throw err;
          }
        }
        const body = buildListingUpdateBody(updateFields);
        // NOTE: Etsy API v3 requires shop-scoped URL for PATCH (plain /listings/{id} returns 404)
        result = await etsyFetch(`/shops/${SHOP_ID}/listings/${safeInt(listing_id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        break;
      }

      case 'deleteListing':
        result = await etsyFetch(`/listings/${safeInt(params.listing_id)}`, { method: 'DELETE' });
        break;

      case 'updateListingState':
        result = await etsyFetch(`/shops/${SHOP_ID}/listings/${safeInt(params.listing_id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ state: params.state }),
        });
        break;

      case 'duplicateListing': {
        // Get original with images and personalization
        const originalId = safeInt(params.listing_id);
        const original = await getListingWithInventory(
          originalId,
          ['Images', 'Personalization']
        );
        const originalInventory = original.inventory;

        // If physical listing without shipping profile, get first available one
        let shippingProfileId = original.shipping_profile_id;
        if (original.listing_type !== 'download' && (!shippingProfileId || shippingProfileId === 0)) {
          const profiles = await etsyFetch(`/shops/${SHOP_ID}/shipping-profiles`);
          shippingProfileId = profiles.results?.[0]?.shipping_profile_id || null;
        }

        const copyBody = buildListingBody({
          // Keep original title - user will rename manually if needed
          title: original.title,
          description: original.description,
          price: original.price,
          quantity: original.quantity,
          tags: original.tags,
          materials: original.materials,
          who_made: original.who_made,
          when_made: original.when_made,
          taxonomy_id: original.taxonomy_id,
          listing_type: original.listing_type,
          // Digital downloads should never be marked as supply to avoid duplication
          is_supply: original.listing_type === 'download' ? false : original.is_supply,
          should_auto_renew: original.should_auto_renew,
          shop_section_id: original.shop_section_id,
          // Only include shipping/return/processing for physical listings
          ...(original.listing_type !== 'download' ? {
            shipping_profile_id: shippingProfileId,
            return_policy_id: original.return_policy_id,
            processing_min: original.processing_min,
            processing_max: original.processing_max,
          } : {}),
          state: 'draft',
        });

        // Create the duplicate listing
        const newListing = await etsyFetch(`/shops/${SHOP_ID}/listings`, {
          method: 'POST',
          body: JSON.stringify(copyBody),
        });

        // Copy images from original to new listing (sequentially to avoid conflicts)
        if (original.images && original.images.length > 0) {
          let successCount = 0;
          for (let i = 0; i < Math.min(original.images.length, 20); i++) {
            const img = original.images[i];
            try {
              await etsyFetch(`/shops/${SHOP_ID}/listings/${newListing.listing_id}/images`, {
                method: 'POST',
                body: JSON.stringify({
                  listing_image_id: img.listing_image_id,
                  rank: i + 1,
                }),
              });
              successCount++;
              // Small delay to avoid "being edited by another process" error
              if (i < original.images.length - 1) {
                await new Promise(resolve => setTimeout(resolve, IMAGE_COPY_DELAY_MS));
              }
            } catch (imgErr) {
              console.warn(`[duplicateListing] Failed to copy image ${i + 1}:`, imgErr.message);
              // Continue with next image
            }
          }
        }

        // Copy inventory/variations after creation. Creating a listing only copies the
        // single price/quantity fields, so variation price tiers must be restored via inventory.
        let inventoryCopied = false;
        if (hasVariationInventory(originalInventory)) {
          try {
            await putListingInventory(newListing.listing_id, originalInventory);
            inventoryCopied = true;
          } catch (invErr) {
            console.warn('[duplicateListing] Failed to copy inventory:', invErr.message, invErr.data || '');
            await deleteListingQuietly(newListing.listing_id);
            throw new Error(`Duplicate was rolled back because variations could not be copied: ${invErr.message}`);
          }
        }

        // Copy personalization to the new listing via new dedicated endpoint
        const origQuestions = params.personalization_questions || original.personalization?.personalization_questions;
        let personalizationCopied = false;
        if (origQuestions && origQuestions.length > 0) {
          try {
            await putListingPersonalization(SHOP_ID, newListing.listing_id, origQuestions);
            personalizationCopied = true;
          } catch (pErr) {
            console.warn('[duplicateListing] Failed to copy personalization:', pErr.message, pErr.data || '');
            await deleteListingQuietly(newListing.listing_id);
            throw pErr;
          }
        }

        result = { ...newListing, inventory_copied: inventoryCopied, personalization_copied: personalizationCopied };
        break;
      }

      // ── LISTING PERSONALIZATION (new endpoints, Apr 9 2026+) ─────────────
      case 'getListingPersonalization':
        result = await etsyFetch(`/listings/${safeInt(params.listing_id)}/personalization`);
        break;

      case 'updateListingPersonalization': {
        const { listing_id: plid, personalization_questions } = params;
        if (!Array.isArray(personalization_questions) || !personalization_questions.length) {
          return res.status(400).json({ error: 'personalization_questions must contain at least one question' });
        }
        result = await putListingPersonalization(SHOP_ID, plid, personalization_questions);
        break;
      }

      case 'deleteListingPersonalization':
        await etsyFetch(`/shops/${SHOP_ID}/listings/${safeInt(params.listing_id)}/personalization`, {
          method: 'DELETE',
        });
        result = { success: true };
        break;

      // ── LISTING IMAGES ────────────────────────────────────
      case 'getListingImages':
        result = await etsyFetch(listingImagePath(params.listing_id));
        result = { ...result, results: normalizeListingImagesResponse(result) };
        break;

      case 'getListingImage':
        result = await etsyFetch(listingImagePath(params.listing_id, params.listing_image_id));
        result = { ...result, alt_text: typeof result?.alt_text === 'string' ? result.alt_text : '' };
        break;

      case 'updateListingImageAltText': {
        // Etsy has no dedicated alt-text PATCH endpoint. The documented write is
        // uploadListingImage: POST multipart with listing_image_id + alt_text.
        // Requiring an explicit actor confirmation prevents background/agent writes.
        const confirmedBy = requireExplicitListingWriteConfirmation(params);
        const altText = validateListingImageAltText(params.alt_text);
        const formData = new FormData();
        formData.append('listing_image_id', String(safeInt(params.listing_image_id)));
        formData.append('alt_text', altText);
        result = await etsyFetch(listingImagePath(params.listing_id, null, SHOP_ID), {
          method: 'POST',
          headers: {}, // Let fetch set the native FormData boundary.
          body: formData,
        });
        result = { ...result, alt_text: typeof result?.alt_text === 'string' ? result.alt_text : altText, confirmed_by: confirmedBy };
        break;
      }

      case 'uploadListingImage': {
        // params.imageBase64, params.contentType, params.rank
        const formData = buildImageFormData(params);
        result = await etsyFetch(`/shops/${SHOP_ID}/listings/${safeInt(params.listing_id)}/images`, {
          method: 'POST',
          headers: {}, // Let fetch set multipart boundary
          body: formData,
        });
        break;
      }

      case 'deleteListingImage':
        result = await etsyFetch(
          `/shops/${SHOP_ID}/listings/${safeInt(params.listing_id)}/images/${safeInt(params.listing_image_id)}`,
          { method: 'DELETE' }
        );
        break;

      // ── LISTING VIDEOS ────────────────────────────────────
      case 'getListingVideos':
        result = await etsyFetch(`/listings/${safeInt(params.listing_id)}/videos`);
        break;

      case 'getListingVideoFile': {
        // Proxy video file from Etsy (streaming to avoid memory issues)
        const videos = await etsyFetch(`/listings/${safeInt(params.listing_id)}/videos`);
        if (!videos.results?.length) {
          throw new Error('No video found');
        }
        const video = videos.results[0];
        const videoUrl = listingVideoUrl(video);

        if (!videoUrl) {
          throw new Error('Video URL not available');
        }

        // Stream video from Etsy instead of loading into memory
        const videoRes = await fetch(videoUrl);
        if (!videoRes.ok) {
          throw new Error('Failed to fetch video from Etsy');
        }

        // Stream response directly
        res.status(200);
        res.setHeader('Content-Type', videoRes.headers.get('content-type') || 'video/mp4');
        if (videoRes.headers.get('content-length')) {
          res.setHeader('Content-Length', videoRes.headers.get('content-length'));
        }

        // Pipe the stream
        const reader = videoRes.body.getReader();
        const pump = async () => {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            return;
          }
          res.write(Buffer.from(value));
          await pump();
        };
        await pump();
        return;
      }

      case 'uploadListingVideo': {
        // params.videoBase64, params.name
        if (!params.videoBase64) {
          throw new Error('videoBase64 is required');
        }

        // Convert base64 to buffer
        const base64Data = params.videoBase64.includes(',')
          ? params.videoBase64.split(',')[1]
          : params.videoBase64;
        const buffer = Buffer.from(base64Data, 'base64');

        // Detect content type from base64 prefix or filename
        let contentType = 'video/mp4';
        if (params.videoBase64.includes('data:')) {
          const match = params.videoBase64.match(/data:([^;]+);/);
          if (match) contentType = match[1];
        } else if (params.name) {
          const ext = params.name.split('.').pop().toLowerCase();
          if (ext === 'mov') contentType = 'video/quicktime';
          else if (ext === 'avi') contentType = 'video/x-msvideo';
        }

        // Create FormData with buffer
        const FormData = (await import('form-data')).default;
        const formData = new FormData();
        formData.append('video', buffer, {
          filename: params.name || 'video.mp4',
          contentType,
        });

        result = await etsyFetch(`/shops/${SHOP_ID}/listings/${safeInt(params.listing_id)}/videos`, {
          method: 'POST',
          headers: formData.getHeaders(),
          body: formData,
        });
        break;
      }

      case 'deleteListingVideo':
        result = await etsyFetch(
          `/shops/${SHOP_ID}/listings/${safeInt(params.listing_id)}/videos/${safeInt(params.video_id)}`,
          { method: 'DELETE' }
        );
        break;

      // ── INVENTORY / VARIATIONS ────────────────────────────
      case 'getListingInventory':
        result = await etsyFetch(`/listings/${safeInt(params.listing_id)}/inventory`);
        break;

      case 'updateListingInventory': {
        // Ensure each offering has readiness_state_id (required for physical listings)
        result = await putListingInventory(params.listing_id, normalizeInventoryParams(params));
        break;
      }

      case 'clearListingVariations': {
        const products = normalizeInventoryProducts(params.products || [{
          sku: '',
          offerings: [{ price: params.price || 0, quantity: params.quantity || 999, is_enabled: true }],
          property_values: [],
        }]);
        result = await etsyFetch(`/listings/${safeInt(params.listing_id)}/inventory?legacy=false`, {
          method: 'PUT',
          body: JSON.stringify({ products, price_on_property: [] }),
        });
        break;
      }

      case 'updateListingVariationInventory': {
        result = await putListingInventory(params.listing_id, normalizeInventoryParams(params));
        break;
      }

      // ── ORDERS / RECEIPTS ─────────────────────────────────
      case 'getReceipts': {
        const limit = params.limit || 25;
        const offset = params.offset || 0;
        const state = params.state || '';
        const stateParam = state ? `&was_paid=true&was_shipped=${state === 'shipped' ? 'true' : 'false'}` : '';
        result = await etsyFetch(
          `/shops/${SHOP_ID}/receipts?limit=${limit}&offset=${offset}${stateParam}&sort_on=created&sort_order=desc&includes=Transactions`
        );
        result = {
          ...result,
          results: (result.results || [])
            .filter(receipt => state !== 'paid' || isCurrentPaidReceipt(receipt))
            .map(receipt => ({ ...receipt, lifecycle: receiptLifecycle(receipt) })),
        };
        break;
      }

      case 'getReceipt':
        result = await etsyFetch(`/shops/${SHOP_ID}/receipts/${safeInt(params.receipt_id)}?includes=Transactions`);
        result = { ...result, lifecycle: receiptLifecycle(result) };
        break;

      case 'updateReceiptShipment':
        result = await etsyFetch(`/shops/${SHOP_ID}/receipts/${safeInt(params.receipt_id)}/tracking`, {
          method: 'POST',
          body: JSON.stringify({
            tracking_code: params.tracking_code,
            carrier_name: params.carrier_name,
            send_bcc: params.send_bcc !== false,
            note_to_buyer: params.note_to_buyer || '',
          }),
        });
        break;

      case 'getTransactions':
        result = await etsyFetch(
          `/shops/${SHOP_ID}/transactions?limit=${params.limit || 25}&offset=${params.offset || 0}`
        );
        break;

      // ── TAXONOMY ──────────────────────────────────────────
      case 'getTaxonomy':
        result = await etsyFetch('/seller-taxonomy/nodes');
        break;

      case 'getTaxonomyProperties':
        result = await etsyFetch(`/seller-taxonomy/nodes/${safeInt(params.taxonomy_id)}/properties`);
        break;

      // ── DISCOUNTS / SALES ─────────────────────────────────
      case 'getDiscounts':
        result = await etsyFetch(`/shops/${SHOP_ID}/discounts?limit=100`);
        break;

      case 'getDiscount':
        result = await etsyFetch(`/shops/${SHOP_ID}/discounts/${safeInt(params.discount_id)}`);
        break;

      case 'createDiscount': {
        const body = {};
        if (params.discount_name) body.discount_name = params.discount_name;
        if (params.discount_type) body.discount_type = params.discount_type;
        if (params.discount_value !== undefined) body.discount_value = parseFloat(params.discount_value);
        if (params.min_order_quantity_type) body.min_order_quantity_type = params.min_order_quantity_type;
        if (params.min_order_quantity !== undefined) body.min_order_quantity = parseInt(params.min_order_quantity);
        if (params.start_date !== undefined) body.start_date = parseInt(params.start_date);
        if (params.end_date !== undefined) body.end_date = parseInt(params.end_date);
        body.seller_active = params.seller_active !== false;
        result = await etsyFetch(`/shops/${SHOP_ID}/discounts`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        break;
      }

      case 'updateDiscount': {
        const { discount_id, ...updateFields } = params;
        const body = {};
        if (updateFields.discount_name) body.discount_name = updateFields.discount_name;
        if (updateFields.discount_value !== undefined) body.discount_value = parseFloat(updateFields.discount_value);
        if (updateFields.start_date !== undefined) body.start_date = parseInt(updateFields.start_date);
        if (updateFields.end_date !== undefined) body.end_date = parseInt(updateFields.end_date);
        if (updateFields.seller_active !== undefined) body.seller_active = Boolean(updateFields.seller_active);
        result = await etsyFetch(`/shops/${SHOP_ID}/discounts/${safeInt(discount_id)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        break;
      }

      case 'deleteDiscount':
        result = await etsyFetch(`/shops/${SHOP_ID}/discounts/${safeInt(params.discount_id)}`, { method: 'DELETE' });
        break;

      // ── MISC ──────────────────────────────────────────────
      case 'getFeaturedListings':
        result = await etsyFetch(`/shops/${SHOP_ID}/listings/featured?limit=10`);
        break;

      // ── REVIEWS ───────────────────────────────────────────
      case 'getReviews': {
        const limit = Math.min(parseInt(params.limit) || 25, 100);
        const offset = parseInt(params.offset) || 0;
        result = await etsyFetch(
          `/shops/${SHOP_ID}/reviews?limit=${limit}&offset=${offset}`
        );

        if (offset === 0 && Array.isArray(result.results)) {
          try {
            const shop = await etsyFetch(`/shops/${SHOP_ID}`);
            const reviewsPageUrl = shop.shop_name ? `https://www.etsy.com/shop/${encodeURIComponent(shop.shop_name)}/reviews` : null;
            result = {
              ...result,
              reviews_page_url: reviewsPageUrl,
              response_status_source: 'not_available_in_etsy_open_api',
              review_media_source: 'etsy_open_api',
            };
          } catch (err) {
            console.warn('[etsy.js] reviews page URL lookup skipped:', err.message || err);
          }
        }
        break;
      }


      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    if (isWriteAction) {
      writeSecurityAudit(req, 'etsy.write.succeeded', {
        action,
        listing_id: optionalAuditId(params.listing_id),
        listing_image_id: optionalAuditId(params.listing_image_id),
        receipt_id: optionalAuditId(params.receipt_id),
        discount_id: optionalAuditId(params.discount_id),
      });
    }
    return res.json({ success: true, data: result });

  } catch (err) {
    if (isWriteAction) {
      writeSecurityAudit(req, 'etsy.write.failed', {
        action,
        listing_id: optionalAuditId(params.listing_id),
        status: Number(err?.status || 500),
      });
    }
    const safeParams = err.request || (action === 'updateListingPersonalization' || action === 'duplicateListing'
      ? { listing_id: params.listing_id, personalization_questions: normalizePersonalizationQuestionsForEtsy(params.personalization_questions) }
      : null);
    const etsyDetails = formatEtsyValidationDetails(err.data) || extractEtsyErrorText(err.data);
    console.error(`[etsy.js] ${action} error:`, err.message, err.data || '', safeParams ? JSON.stringify(safeParams) : '');
    const status = err.status || 500;
    const body = { error: publicErrorMessage(err, status) };
    if (status < 500 || process.env.NODE_ENV !== 'production') {
      body.details = err.data || null;
      body.detail_text = etsyDetails || null;
      body.request = safeParams;
    }
    return res.status(status).json(body);
  }
}

