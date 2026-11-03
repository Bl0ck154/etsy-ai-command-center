import {
  fetchOrderContextByReceiptId,
  normalizeReceiptId,
} from './order-context-client.js';
import { etsyFetch } from '../_etsy.js';

const EXTERNAL_SOURCE_MAP = Object.freeze({
  listing_upload: {
    upstream: 'trello_attachments',
    negativeCoverage: new Set(['card_attachments_except_listing_cover']),
  },
  drive: {
    upstream: 'google_drive',
    negativeCoverage: new Set(['direct_files_in_order_folder']),
  },
});

function validIso(value) {
  return Boolean(value && Number.isFinite(Date.parse(String(value))));
}

function cleanText(value, maxLength = 2_000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function configuredTrue(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function safeProvenance(items, fallbackSource) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map(item => ({
    source: cleanText(item?.source || fallbackSource, 100),
    reference: cleanText(item?.reference, 300) || null,
    observed_at: validIso(item?.observed_at)
      ? new Date(item.observed_at).toISOString()
      : null,
    name: cleanText(item?.name, 300) || null,
    field: cleanText(item?.field, 100) || null,
    evidence: cleanText(item?.evidence, 160) || null,
  }));
}

function externalEvidence(
  source,
  generatedAt,
  provenanceName,
  negativeCoverage,
) {
  const state = cleanText(source?.state, 40).toLowerCase();
  const coverage = cleanText(source?.coverage, 160);
  const checkedAt = validIso(generatedAt)
    ? new Date(generatedAt).toISOString()
    : null;
  const provenance = safeProvenance(source?.items, provenanceName);
  if (state === 'present') {
    return {
      checked: true,
      received: true,
      checked_at: checkedAt,
      coverage: coverage || null,
      provenance,
    };
  }
  if (
    state === 'not_found'
    && checkedAt
    && negativeCoverage?.has(coverage)
  ) {
    return {
      checked: true,
      received: false,
      checked_at: checkedAt,
      coverage,
      provenance,
    };
  }
  return {
    checked: false,
    received: null,
    checked_at: checkedAt,
    coverage: coverage || 'unknown',
    reason: cleanText(source?.reason, 160)
      || (
        state === 'not_found' && coverage
          ? 'negative_coverage_is_not_comprehensive'
          : 'source_not_fully_checked'
      ),
    provenance,
  };
}

function emailEvidence(materialSources, generatedAt) {
  const gmail = externalEvidence(
    materialSources?.gmail_attachments,
    generatedAt,
    'gmail_attachment',
    new Set(['all_order_emails_searched']),
  );
  const mirror = externalEvidence(
    materialSources?.email_attachments,
    generatedAt,
    'email_attachments',
    new Set(),
  );

  if (gmail.received === true || mirror.received === true) {
    return {
      checked: true,
      received: true,
      checked_at: gmail.received === true
        ? gmail.checked_at
        : mirror.checked_at,
      coverage: gmail.received === true
        ? gmail.coverage
        : mirror.coverage,
      provenance: [
        ...(gmail.received === true ? gmail.provenance : []),
        ...(mirror.received === true ? mirror.provenance : []),
      ].slice(0, 100),
    };
  }
  if (gmail.checked === true && gmail.received === false) {
    return {
      checked: true,
      received: false,
      checked_at: gmail.checked_at,
      coverage: gmail.coverage,
      provenance: gmail.provenance,
    };
  }
  return {
    checked: false,
    received: null,
    checked_at: gmail.checked_at || mirror.checked_at,
    coverage: gmail.coverage !== 'unknown'
      ? gmail.coverage
      : mirror.coverage,
    reason: mirror.reason || gmail.reason || 'gmail_not_comprehensively_checked',
    provenance: [],
  };
}

function normalizedDirection(message) {
  const direction = cleanText(message?.direction, 40).toLowerCase();
  if (['incoming', 'inbound'].includes(direction)) return 'incoming';
  if (['outgoing', 'outbound'].includes(direction)) return 'outgoing';
  return 'unknown';
}

function bridgeParts(value) {
  return {
    conversation: value?.conversation || value || {},
    messages: Array.isArray(value?.messages)
      ? value.messages
      : Array.isArray(value?.conversation?.messages)
        ? value.conversation.messages
        : [],
  };
}

function exactBridgeReceiptIds(conversation) {
  return new Set([
    ...(Array.isArray(conversation?.receipt_ids) ? conversation.receipt_ids : []),
    ...(Array.isArray(conversation?.order_refs)
      ? conversation.order_refs.map(reference => reference?.receipt_id)
      : []),
  ].map(value => cleanText(value, 32)).filter(value => /^[0-9]{5,32}$/.test(value)));
}

function etsyAttachmentEvidence(bridge) {
  const { conversation, messages } = bridgeParts(bridge);
  const historySyncedAt = validIso(conversation.history_synced_at)
    ? new Date(conversation.history_synced_at).toISOString()
    : null;
  const incoming = [];
  let unknownDirectionAttachment = false;

  for (const message of messages) {
    const attachments = Array.isArray(message?.attachments)
      ? message.attachments
      : [];
    if (!attachments.length) continue;
    const direction = normalizedDirection(message);
    if (direction === 'unknown') {
      unknownDirectionAttachment = true;
      continue;
    }
    if (direction !== 'incoming') continue;
    for (const attachment of attachments) {
      incoming.push({
        source: 'etsy_message_attachment',
        reference: cleanText(
          attachment?.source_id || attachment?.id,
          300,
        ) || null,
        observed_at: validIso(message?.sent_at || message?.updated_at)
          ? new Date(message.sent_at || message.updated_at).toISOString()
          : null,
        name: cleanText(attachment?.filename, 300) || null,
        source_message_id: cleanText(
          message?.source_id || message?.id,
          160,
        ) || null,
      });
    }
  }

  if (incoming.length) {
    return {
      checked: true,
      received: true,
      checked_at: historySyncedAt
        || incoming.find(item => item.observed_at)?.observed_at
        || null,
      coverage: historySyncedAt
        ? 'full_bridge_history'
        : 'positive_attachment_evidence',
      provenance: incoming.slice(0, 100),
    };
  }
  if (unknownDirectionAttachment) {
    return {
      checked: false,
      received: null,
      checked_at: historySyncedAt,
      coverage: historySyncedAt ? 'full_bridge_history' : 'unknown',
      reason: 'attachment_direction_unknown',
      provenance: [],
    };
  }
  if (historySyncedAt) {
    return {
      checked: true,
      received: false,
      checked_at: historySyncedAt,
      coverage: 'full_bridge_history',
      provenance: [],
    };
  }
  return {
    checked: false,
    received: null,
    checked_at: null,
    coverage: 'history_not_fully_synced',
    reason: 'bridge_history_sync_required',
    provenance: [],
  };
}

function outgoingMessageWithExactUrl(messages, url) {
  if (!url) return null;
  return messages.find(message => (
    normalizedDirection(message) === 'outgoing'
    && cleanText(message?.body, 20_000).includes(url)
  )) || null;
}

function normalizedBody(message) {
  return cleanText(message?.body, 20_000)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ');
}

function reviewConversationEvidence(bridge) {
  const { conversation, messages } = bridgeParts(bridge);
  const historySyncedAt = validIso(conversation.history_synced_at)
    ? new Date(conversation.history_synced_at).toISOString()
    : null;
  if (!historySyncedAt) {
    return {
      positive_ending: null,
      prior_request: null,
      active_issue_signal: null,
      checked_at: null,
      reason: 'bridge_history_sync_required',
    };
  }
  const ordered = [...messages].sort((left, right) => (
    Date.parse(left?.sent_at || left?.updated_at || '') -
      Date.parse(right?.sent_at || right?.updated_at || '')
    || (Number(left?.ordinal) || 0) - (Number(right?.ordinal) || 0)
  ));
  const meaningful = ordered.filter(message => (
    ['incoming', 'outgoing'].includes(normalizedDirection(message))
    && normalizedBody(message)
  ));
  const latest = meaningful.at(-1);
  const latestIncoming = [...meaningful]
    .reverse()
    .find(message => normalizedDirection(message) === 'incoming');
  const latestIncomingText = normalizedBody(latestIncoming);
  const positivePattern = /\b(?:thank(?:s| you)|love(?:d)? it|looks? (?:great|good|perfect|amazing|beautiful)|perfect|wonderful|awesome|very happy|so happy|satisfied|gracias|perfect[oa]|me encanta|hermos[oa]|muy feliz|merci|parfait|magnifique|danke|perfekt|wunderbar|grazie|perfett[oa]|bellissim[oa])\b|(?:дякую|спасиб[оі]|чудово|ідеально|прекрасно|дуже задоволен[а-я]*)|(?:спасибо|отлично|идеально|прекрасно|очень доволен[а-я]*)/iu;
  const reviewPattern = /\b(?:review|feedback|rating|stars?|bewertung|rezension|avis|reseña|recensione)\b|(?:відгук|отзыв|оцінк|оценк)/iu;
  const issuePattern = /\b(?:refund|cancel(?:led|ation)?|problem|issue|complaint|dispute|case|damaged|wrong|not received|chargeback)\b|(?:повернен|скасуван|проблем|скарг|спір|пошкоджен)|(?:возврат|отмен|проблем|жалоб|спор|поврежден)/iu;
  const outgoingReview = meaningful.find(message => (
    normalizedDirection(message) === 'outgoing'
    && reviewPattern.test(normalizedBody(message))
  ));
  const positiveEnding = latestIncoming
    && positivePattern.test(latestIncomingText)
    ? true
    : null;
  const issueMessage = positiveEnding === true
    ? null
    : meaningful.slice(-6).find(message => (
      issuePattern.test(normalizedBody(message))
    ));
  return {
    positive_ending: positiveEnding,
    prior_request: Boolean(outgoingReview),
    active_issue_signal: Boolean(issueMessage),
    checked_at: historySyncedAt,
    latest_message_id: cleanText(latest?.source_id || latest?.id, 160) || null,
    reason: null,
  };
}

function orderAutomationFacts(context) {
  const value = context?.order?.automation_facts || {};
  const listingIds = Array.isArray(value?.listing_ids)
    ? [...new Set(value.listing_ids.map(item => cleanText(item, 32)))]
      .filter(item => /^\d+$/.test(item))
    : [];
  const verified = value?.verified === true
    && value?.is_paid === true
    && value?.all_items_physical === true
    && listingIds.length > 0
    && validIso(value?.paid_at)
    && validIso(value?.checked_at);
  return {
    verified,
    paid: verified ? true : null,
    all_items_physical: verified ? true : null,
    listing_ids: verified ? listingIds : [],
    paid_at: verified ? new Date(value.paid_at).toISOString() : null,
    checked_at: verified ? new Date(value.checked_at).toISOString() : null,
  };
}

async function loadMadeToOrderEvidence(order, fetchListing) {
  if (
    order?.automation_facts_verified !== true
    || order?.paid !== true
    || order?.all_items_physical !== true
    || !Array.isArray(order?.listing_ids)
    || !order.listing_ids.length
  ) {
    return {
      verified: false,
      made_to_order: null,
      checked_at: null,
      reason: 'verified_paid_physical_listing_facts_required',
      listings: [],
    };
  }
  const checkedAt = new Date().toISOString();
  const listings = [];
  for (const listingId of order.listing_ids.slice(0, 20)) {
    const listing = await fetchListing(listingId);
    const returnedId = cleanText(listing?.listing_id || listing?.id, 32);
    const whenMade = cleanText(listing?.when_made, 80).toLowerCase();
    if (returnedId !== listingId || !whenMade) {
      return {
        verified: false,
        made_to_order: null,
        checked_at: checkedAt,
        reason: 'official_listing_fact_mismatch',
        listings,
      };
    }
    listings.push({
      listing_id: listingId,
      when_made: whenMade,
      source: 'official_etsy_api',
    });
  }
  return {
    verified: true,
    made_to_order: listings.every(item => item.when_made === 'made_to_order'),
    checked_at: checkedAt,
    reason: null,
    listings,
  };
}

export function mergeOrderContextEvidence({
  receiptId: receiptIdValue,
  orderContextResponse,
  bridgeConversation,
}) {
  const receiptId = normalizeReceiptId(receiptIdValue);
  const generatedAt = validIso(orderContextResponse?.generated_at)
    ? new Date(orderContextResponse.generated_at).toISOString()
    : null;
  const context = orderContextResponse?.context;
  const upstreamOrderId = cleanText(context?.order?.order_id, 32);
  const bridge = bridgeParts(bridgeConversation);
  const bridgeReceiptIds = exactBridgeReceiptIds(bridge.conversation);

  if (
    orderContextResponse?.schema_version !== 1
    || orderContextResponse?.match?.status !== 'exact'
    || Number(orderContextResponse?.match?.confidence) !== 1
    || !generatedAt
    || !context
    || upstreamOrderId !== receiptId
  ) {
    const error = new Error('Order context does not exactly match receipt_id');
    error.status = 502;
    error.code = 'ORDER_CONTEXT_EVIDENCE_MISMATCH';
    throw error;
  }
  if (!bridgeReceiptIds.has(receiptId)) {
    const error = new Error(
      'The exact receipt_id is not linked to this Bridge conversation',
    );
    error.status = 409;
    error.code = 'ORDER_CONTEXT_BRIDGE_RECEIPT_MISMATCH';
    throw error;
  }

  const sources = {
    etsy: etsyAttachmentEvidence(bridgeConversation),
    email: emailEvidence(context?.materials?.sources, generatedAt),
  };
  const gmailSource = context?.materials?.sources?.gmail_attachments || {};
  const emailClaimCandidates = (
    Array.isArray(gmailSource.confirmation_candidates)
      ? gmailSource.confirmation_candidates
      : []
  ).slice(0, 20).map(candidate => ({
    source: 'gmail_personal_sender_candidate',
    reference: cleanText(candidate?.reference, 300) || null,
    observed_at: validIso(candidate?.observed_at)
      ? new Date(candidate.observed_at).toISOString()
      : null,
    sender_name: cleanText(candidate?.sender_name, 160) || null,
    identity_status: cleanText(candidate?.identity_status, 40) || 'possible',
    match_methods: (Array.isArray(candidate?.match_methods)
      ? candidate.match_methods
      : []).map(value => cleanText(value, 80)).filter(Boolean).slice(0, 10),
    attachment_count: Math.max(0, Number(candidate?.attachment_count) || 0),
    attachments: (Array.isArray(candidate?.attachments)
      ? candidate.attachments
      : []).slice(0, 20).map(item => ({
      name: cleanText(item?.name, 300) || 'attachment',
      mime_type: cleanText(item?.mime_type, 160) || null,
      size: Number.isFinite(Number(item?.size)) ? Number(item.size) : null,
    })),
  }));
  for (const [target, mapping] of Object.entries(EXTERNAL_SOURCE_MAP)) {
    sources[target] = externalEvidence(
      context?.materials?.sources?.[mapping.upstream],
      generatedAt,
      mapping.upstream,
      mapping.negativeCoverage,
    );
  }
  const sourceValues = Object.values(sources);
  const anyReceived = sourceValues.some(source => source.received === true);
  const allCheckedAbsent = sourceValues.every(source => (
    source.checked === true && source.received === false
  ));
  const operationalCardCheckedEmpty = (
    sources.listing_upload?.checked === true
    && sources.listing_upload?.received === false
  );

  const deadline = context?.order?.deadline || {};
  const dueAt = validIso(deadline.at)
    ? new Date(deadline.at).toISOString()
    : null;
  const deadlineState = cleanText(deadline.state, 40);
  // IONOS currently exposes a Trello operational due date. It is useful
  // context, but it is not proof of the buyer-facing Etsy listing deadline.
  const verifiedListingDeadline = deadline.kind === 'etsy_listing_deadline'
    && Boolean(dueAt);

  const prepared = context?.variants?.prepared || {};
  const resultUrl = /^https:\/\//i.test(cleanText(prepared.link, 2_000))
    ? cleanText(prepared.link, 2_000)
    : null;
  const sentMessage = prepared.state === 'present'
    ? outgoingMessageWithExactUrl(bridge.messages, resultUrl)
    : null;
  const fullHistory = validIso(bridge.conversation.history_synced_at);
  const variantsSent = sentMessage
    ? true
    : fullHistory && prepared.state === 'present' && resultUrl
      ? false
      : null;

  const completed = context?.order?.workflow?.completed === true;
  const activeIssue = typeof context?.order?.has_active_issue === 'boolean'
    ? context.order.has_active_issue
    : null;
  const automationFacts = orderAutomationFacts(context);
  const reviewConversation = reviewConversationEvidence(bridgeConversation);
  const lifecycle = context?.order?.lifecycle || {};
  const lifecycleVerified = lifecycle?.verified === true;
  const lifecycleReviewSafe = lifecycleVerified
    && lifecycle?.status === 'completed'
    && lifecycle?.is_paid === true
    && lifecycle?.is_shipped === true
    && Number(lifecycle?.refund_count) === 0;
  const issueEvidence = context?.order?.issue_evidence || {};
  const noKnownActiveIssue = activeIssue === false || (
    activeIssue === null
    && issueEvidence?.coverage === 'known_trello_issue_labels_only'
    && reviewConversation.active_issue_signal === false
  );

  return {
    order: {
      linked: true,
      receipt_id: receiptId,
      checked_at: generatedAt,
      completed,
      paid: automationFacts.paid,
      paid_at: automationFacts.paid_at,
      all_items_physical: automationFacts.all_items_physical,
      listing_ids: automationFacts.listing_ids,
      automation_facts_verified: automationFacts.verified,
      made_to_order: null,
      made_to_order_verified: false,
      has_active_issue: noKnownActiveIssue ? false : activeIssue,
      workflow_status: cleanText(context?.order?.workflow?.status, 100) || null,
      provenance: safeProvenance(
        context?.order?.workflow?.provenance,
        'trello_card',
      ),
    },
    materials: {
      // Trello is the shop's operational material record. Customer files
      // received through Etsy/email/Drive are mirrored or linked on the card.
      // Therefore an explicitly checked empty card is sufficient negative
      // evidence for the reminder workflow; Gmail is queried only on demand
      // when a buyer explicitly claims that an email was sent.
      missing: anyReceived
        ? false
        : operationalCardCheckedEmpty
          ? true
          : allCheckedAbsent
            ? true
            : null,
      operational_record_checked: operationalCardCheckedEmpty,
      absence_basis: operationalCardCheckedEmpty
        ? 'trello_operational_record_empty'
        : null,
      email_claim: {
        checked: validIso(gmailSource.search_since),
        checked_since: validIso(gmailSource.search_since)
          ? new Date(gmailSource.search_since).toISOString()
          : null,
        search_basis: cleanText(gmailSource.search_basis, 80) || null,
        verified_attachments_received: gmailSource.received === true,
        exact_customer_attachments_received: gmailSource.received === true,
        possible_match_requires_review: (
          gmailSource.received !== true
          && emailClaimCandidates.length > 0
        ),
        confirmation_required: false,
        candidates: emailClaimCandidates,
        reason: cleanText(gmailSource.reason, 160) || null,
      },
      all_channels_checked: sourceValues.every(source => source.checked === true),
      sources,
    },
    deadline: {
      verified: verifiedListingDeadline,
      reached_or_approaching: verifiedListingDeadline
        ? ['overdue', 'due_soon'].includes(deadlineState)
        : false,
      due_at: dueAt,
      checked_at: generatedAt,
      kind: verifiedListingDeadline
        ? 'etsy_listing_deadline'
        : dueAt
          ? 'trello_operational_due'
          : 'unknown',
      provenance: safeProvenance(deadline.provenance, 'trello_card'),
    },
    variants: {
      prepared: prepared.state === 'present',
      sent: variantsSent,
      result_url: resultUrl,
      checked_at: fullHistory
        ? new Date(bridge.conversation.history_synced_at).toISOString()
        : generatedAt,
      provenance: sentMessage
        ? [{
          source: 'etsy_outgoing_message',
          reference: cleanText(sentMessage.source_id || sentMessage.id, 160),
          observed_at: validIso(sentMessage.sent_at || sentMessage.updated_at)
            ? new Date(sentMessage.sent_at || sentMessage.updated_at).toISOString()
            : null,
        }]
        : safeProvenance(prepared.items, 'google_drive_result_folder'),
    },
    review: {
      eligible: Boolean(
        completed
        && lifecycleReviewSafe
        && noKnownActiveIssue
        && reviewConversation.positive_ending === true
        && reviewConversation.prior_request === false
      ),
      already_requested: reviewConversation.prior_request,
      positive_conversation_ending: reviewConversation.positive_ending,
      active_issue_signal: reviewConversation.active_issue_signal,
      lifecycle_verified: lifecycleVerified,
      lifecycle_eligible: lifecycleVerified ? lifecycleReviewSafe : null,
      lifecycle_status: cleanText(lifecycle?.status, 80) || null,
      lifecycle_checked_at: validIso(lifecycle?.checked_at)
        ? new Date(lifecycle.checked_at).toISOString()
        : null,
      checked_at: reviewConversation.checked_at,
      latest_message_id: reviewConversation.latest_message_id || null,
      reason: reviewConversation.reason,
    },
    shop_policy: {
      late_materials_allowed:
        configuredTrue('MESSAGE_LATE_MATERIALS_ALLOWED') ? true : null,
      checked_at: configuredTrue('MESSAGE_LATE_MATERIALS_ALLOWED')
        ? generatedAt
        : null,
      source: configuredTrue('MESSAGE_LATE_MATERIALS_ALLOWED')
        ? 'owner_runtime_policy'
        : null,
    },
    evidence_meta: {
      schema_version: 1,
      exact_receipt_only: true,
      fail_closed: true,
      ionos_generated_at: generatedAt,
      etsy_history_synced_at: fullHistory
        ? new Date(bridge.conversation.history_synced_at).toISOString()
        : null,
    },
  };
}

export async function loadVerifiedOrderFactsForConversation(
  { receiptId, bridgeConversation },
  options = {},
) {
  const orderContextResponse = await fetchOrderContextByReceiptId(
    receiptId,
    {
      ...options,
      checkEmailClaim: options.checkEmailClaim === true,
    },
  );
  const facts = mergeOrderContextEvidence({
    receiptId,
    orderContextResponse,
    bridgeConversation,
  });
  const fetchListing = options.fetchListing || (
    listingId => etsyFetch(`/listings/${listingId}`)
  );
  const madeToOrder = await loadMadeToOrderEvidence(facts.order, fetchListing);
  facts.order.made_to_order = madeToOrder.made_to_order;
  facts.order.made_to_order_verified = madeToOrder.verified;
  facts.order.made_to_order_checked_at = madeToOrder.checked_at;
  facts.order.made_to_order_reason = madeToOrder.reason;
  facts.order.listing_facts = madeToOrder.listings;
  return facts;
}
