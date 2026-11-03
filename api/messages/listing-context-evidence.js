import { getListingWithInventory } from '../_etsy.js';

const TRUSTED_REFERENCE_SOURCE = 'inline_listing_ids';
const MAX_LISTING_DESCRIPTION_LENGTH = 4_000;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function positiveNumericId(value) {
  const id = cleanText(value, 32);
  return /^\d+$/.test(id) && Number(id) > 0 ? id : '';
}

function canonicalListingUrl(listingId) {
  return `https://www.etsy.com/listing/${listingId}`;
}

function enabledProduct(product) {
  const offerings = Array.isArray(product?.offerings)
    ? product.offerings
    : [];
  return !offerings.length || offerings.some(offering => (
    offering?.is_enabled !== false
  ));
}

function normalizeVariationFacts(listing = {}) {
  const inventory = listing?.inventory && typeof listing.inventory === 'object'
    ? listing.inventory
    : listing;
  const products = Array.isArray(inventory?.products)
    ? inventory.products
    : [];
  const byName = new Map();
  for (const product of products) {
    if (!enabledProduct(product)) continue;
    for (const property of Array.isArray(product?.property_values)
      ? product.property_values
      : []) {
      const name = cleanText(
        property?.property_name || property?.name,
        160,
      );
      if (!name) continue;
      const values = Array.isArray(property?.values)
        ? property.values
        : [property?.value];
      const saved = byName.get(name) || new Set();
      for (const value of values) {
        const normalized = cleanText(value, 160);
        if (normalized) saved.add(normalized);
      }
      byName.set(name, saved);
    }
  }
  return [...byName.entries()].map(([name, values]) => ({
    name,
    enabled_values: [...values],
  }));
}

function questionOptions(question = {}) {
  return (Array.isArray(question.options) ? question.options : [])
    .filter(option => (
      typeof option !== 'object' || option?.enabled !== false
    ))
    .map(option => cleanText(
      typeof option === 'object'
        ? option?.label || option?.value
        : option,
      160,
    ))
    .filter(Boolean);
}

function normalizePersonalizationFacts(listing = {}) {
  const nested = listing?.personalization?.personalization_questions;
  let questions = Array.isArray(listing?.personalization_questions)
    ? listing.personalization_questions
    : (Array.isArray(nested) ? nested : []);
  if (
    !questions.length
    && (listing?.is_personalizable || listing?.personalization_instructions)
  ) {
    questions = [{
      question_type: 'text_input',
      question_text: 'Personalization',
      instructions: listing.personalization_instructions || '',
      required: listing.personalization_is_required === true,
      max_allowed_characters:
        Number(listing.personalization_char_count_max) || null,
    }];
  }
  return questions.slice(0, 20).map(question => ({
    type: cleanText(question?.question_type || question?.type, 80)
      || 'text_input',
    question: cleanText(
      question?.question_text || question?.question,
      500,
    ),
    instructions: cleanText(question?.instructions, 1_500),
    required: question?.required === true,
    max_characters: Number.isInteger(
      Number(question?.max_allowed_characters),
    )
      ? Number(question.max_allowed_characters)
      : null,
    enabled_options: questionOptions(question),
  }));
}

function listingDescription(listing = {}) {
  return cleanText(
    listing?.description || listing?.description_plain || '',
    MAX_LISTING_DESCRIPTION_LENGTH,
  );
}

function verifiedFileDeliveryPolicy(listing = {}) {
  const sources = [{
    field: 'description',
    text: listingDescription(listing),
  }];
  for (const field of normalizePersonalizationFacts(listing)) {
    sources.push({
      field: 'personalization_instructions',
      text: cleanText(field?.instructions, 1_500),
    });
  }
  const byAddress = new Map();
  for (const source of sources) {
    for (const match of source.text.match(EMAIL_PATTERN) || []) {
      const address = match.toLowerCase();
      const current = byAddress.get(address) || {
        address,
        source_fields: [],
      };
      if (!current.source_fields.includes(source.field)) {
        current.source_fields.push(source.field);
      }
      byAddress.set(address, current);
    }
  }
  return {
    etsy_conversation_allowed: true,
    verified_email_addresses: [...byAddress.values()].slice(0, 10),
  };
}

function buildVerifiedListingFacts({
  listing,
  listingId,
  checkedAt,
  provenance,
}) {
  const state = cleanText(listing?.state || listing?.listing_state, 80);
  return {
    verified: true,
    listing_id: listingId,
    title: cleanText(listing?.title, 500),
    description: listingDescription(listing),
    url: canonicalListingUrl(listingId),
    active: state.toLowerCase() === 'active',
    state: state || null,
    variations: normalizeVariationFacts(listing),
    personalization_fields: normalizePersonalizationFacts(listing),
    file_delivery_policy: verifiedFileDeliveryPolicy(listing),
    checked_at: checkedAt,
    provenance,
  };
}

export function resolveExactOrderListingReference(verifiedOrderFacts = {}) {
  const order = verifiedOrderFacts?.order || verifiedOrderFacts;
  if (
    order?.linked !== true
    || order?.paid !== true
    || order?.automation_facts_verified !== true
  ) {
    return {
      ok: false,
      reason: 'Verified paid Etsy order listing facts are unavailable',
    };
  }
  const listingIds = [...new Set(
    (Array.isArray(order?.listing_ids) ? order.listing_ids : [])
      .map(positiveNumericId)
      .filter(Boolean),
  )];
  if (listingIds.length !== 1) {
    return {
      ok: false,
      reason: listingIds.length
        ? 'The exact Etsy order contains multiple listings'
        : 'The exact Etsy order does not expose a verified listing ID',
    };
  }
  return {
    ok: true,
    reference: {
      listing_id: listingIds[0],
      source: 'verified_order_listing_ids',
      receipt_id: positiveNumericId(order?.receipt_id) || null,
    },
    scope: 'exact_paid_order',
  };
}

export function resolveExactConversationListingReference(
  conversation,
  sourceMessageId = '',
) {
  const refs = (Array.isArray(conversation?.listing_refs)
    ? conversation.listing_refs
    : [])
    .filter(ref => ref?.source === TRUSTED_REFERENCE_SOURCE)
    .map(ref => {
      const listingId = positiveNumericId(ref?.listing_id);
      const expectedUrl = listingId ? canonicalListingUrl(listingId) : '';
      if (!listingId || cleanText(ref?.listing_url, 1_000) !== expectedUrl) {
        return null;
      }
      return {
        listing_id: listingId,
        listing_url: expectedUrl,
        source: TRUSTED_REFERENCE_SOURCE,
        source_message_id: cleanText(ref?.source_message_id, 160) || null,
      };
    })
    .filter(Boolean);
  const unique = values => [...new Map(
    values.map(ref => [ref.listing_id, ref]),
  ).values()];
  const exactTrigger = unique(refs.filter(ref => (
    ref.source_message_id
    && ref.source_message_id === cleanText(sourceMessageId, 160)
  )));
  if (exactTrigger.length === 1) {
    return { ok: true, reference: exactTrigger[0], scope: 'trigger_message' };
  }
  if (exactTrigger.length > 1) {
    return {
      ok: false,
      reason: 'The triggering Etsy message references multiple listings',
    };
  }
  const conversationRefs = unique(refs);
  if (conversationRefs.length === 1) {
    return {
      ok: true,
      reference: conversationRefs[0],
      scope: 'conversation_singleton',
    };
  }
  return {
    ok: false,
    reason: conversationRefs.length
      ? 'The Etsy conversation references multiple listings'
      : 'No exact Etsy inline listing reference is cached',
  };
}

export async function loadVerifiedListingFactsForConversation(
  {
    conversation,
    sourceMessageId = '',
  },
  dependencies = {},
) {
  const resolved = resolveExactConversationListingReference(
    conversation,
    sourceMessageId,
  );
  if (!resolved.ok) {
    return {
      listing: null,
      unavailable_reason: resolved.reason,
    };
  }
  const fetchListing = dependencies.fetchListing || getListingWithInventory;
  const checkedAt = dependencies.now || new Date().toISOString();
  const listingId = resolved.reference.listing_id;
  const listing = await fetchListing(listingId, ['Personalization']);
  const returnedId = positiveNumericId(listing?.listing_id || listing?.id);
  if (returnedId !== listingId) {
    const error = new Error(
      'Official Etsy listing response did not match the exact listing reference',
    );
    error.code = 'MESSAGE_LISTING_CONTEXT_MISMATCH';
    throw error;
  }
  return {
    listing: buildVerifiedListingFacts({
      listing,
      listingId,
      checkedAt,
      provenance: {
        source: 'official_etsy_api',
        reference_source: 'bridge_inline_listing_ids',
        reference_scope: resolved.scope,
        source_message_id: resolved.reference.source_message_id,
      },
    }),
    unavailable_reason: null,
  };
}

export async function loadVerifiedListingFactsForExactOrder(
  {
    verifiedOrderFacts,
  },
  dependencies = {},
) {
  const resolved = resolveExactOrderListingReference(verifiedOrderFacts);
  if (!resolved.ok) {
    return {
      listing: null,
      unavailable_reason: resolved.reason,
    };
  }
  const fetchListing = dependencies.fetchListing || getListingWithInventory;
  const checkedAt = dependencies.now || new Date().toISOString();
  const listingId = resolved.reference.listing_id;
  const listing = await fetchListing(listingId, ['Personalization']);
  const returnedId = positiveNumericId(listing?.listing_id || listing?.id);
  if (returnedId !== listingId) {
    const error = new Error(
      'Official Etsy listing response did not match the exact order listing',
    );
    error.code = 'MESSAGE_ORDER_LISTING_CONTEXT_MISMATCH';
    throw error;
  }
  return {
    listing: buildVerifiedListingFacts({
      listing,
      listingId,
      checkedAt,
      provenance: {
        source: 'official_etsy_api',
        reference_source: 'verified_order_listing_ids',
        reference_scope: resolved.scope,
        receipt_id: resolved.reference.receipt_id,
      },
    }),
    unavailable_reason: null,
  };
}
