import { classifyExplicitBuyerFileTransferIntent } from './semantic-router.js';

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalized(value) {
  return cleanText(value, 10_000)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function blocked(code, reason) {
  return { ok: false, code, reason };
}

function urlsIn(body) {
  return cleanText(body, 10_000).match(/https?:\/\/[^\s<>()]+/gi) || [];
}

function emailAddressesIn(body) {
  return (cleanText(body, 10_000).match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  ) || []).map(value => value.toLowerCase());
}

function verifiedDeliveryEmails(facts) {
  return (Array.isArray(
    facts?.listing?.file_delivery_policy?.verified_email_addresses,
  )
    ? facts.listing.file_delivery_policy.verified_email_addresses
    : [])
    .map(value => normalized(
      typeof value === 'object' ? value?.address : value,
    ))
    .filter(value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value));
}

function hasPriceClaim(body) {
  const text = normalized(body);
  return /[$€£]\s*\d|\b\d+(?:[.,]\d{1,2})?\s*(?:usd|eur|gbp|dollars?|euros?|pounds?)\b/i.test(
    text,
  ) || /\b(?:price|costs?|priced at|total is|charge(?:d)?|fee is)\b/i.test(text);
}

function oneConciseQuestion(body) {
  const text = cleanText(body, 10_000);
  if (!text || text.length > 500) return false;
  if ((text.match(/\?/g) || []).length !== 1) return false;
  if (!text.endsWith('?') || /[!]/.test(text)) return false;
  const withoutFinalQuestion = text.slice(0, -1);
  return !/[.;](?:\s|$)/.test(withoutFinalQuestion);
}

function purchaseGuidance(body) {
  return /\b(?:order|purchase|buy|checkout)\b|(?:ordin(?:e|a|are|i)|acquist(?:o|a|are))|(?:pedido|compr(?:a|ar|e))|(?:commande|acheter|achat)|(?:bestell(?:en|ung)|kaufen|kauf)|(?:замов(?:ити|лення|ляйте)|куп(?:ити|уйте))|(?:заказ(?:ать|а|у)|куп(?:ить|ите))/iu.test(
    normalized(body),
  );
}

function preSaleMaterialInvitation(body) {
  const text = normalized(body);
  const media = '(?:photos?|pictures?|images?|files?|media|attachments?|artwork|references?|foto|fotografie|immagin(?:e|i)|allegat(?:o|i)|fotos?|im(?:a|á)genes?|archivos?|adjuntos?|fichiers?|pi(?:e|è)ces? jointes?|bilder?|dateien?|anhang|фото|файли?|зображення|вкладення|файлы?|изображения|вложения)';
  const transfer = '(?:send|upload|attach|share|submit|provide|forward|show|invi(?:a|are|ami)|caric(?:a|are)|alleg(?:a|are)|condivid(?:i|ere)|envi(?:a|ar|e)|subir|adjuntar|compartir|envoy(?:er|ez)|t(?:e|é)l(?:e|é)verser|joindre|partager|senden|hochladen|anh(?:a|ä)ngen|teilen|надсил\\w*|відправ\\w*|завантаж\\w*|прикріп\\w*|покаж\\w*|присыл\\w*|отправ\\w*|загруз\\w*|прикреп\\w*)';
  return new RegExp(
    `(?:${transfer}.{0,140}${media}|${media}.{0,140}${transfer})`,
    'iu',
  ).test(text);
}

function verifiedPaidOrder(facts) {
  const order = facts?.order;
  return (
    order?.linked === true
    && order?.paid === true
    && /^\d+$/.test(String(order?.receipt_id || ''))
    && Number.isFinite(Date.parse(String(order?.checked_at || '')))
  );
}

function optionClaim(body) {
  return /\b(?:choose|select|pick|option|variation|dropdown)\b/i.test(
    normalized(body),
  );
}

function listingClaim(body) {
  return /\b(?:listing|product|item)\b/i.test(normalized(body));
}

function clarificationInstruction(body) {
  return /\b(?:choose|select|pick|click|open|go to|add to cart|order the)\b/i.test(
    normalized(body),
  );
}

function verifiedOptionTerms(listing) {
  const terms = [];
  for (const variation of Array.isArray(listing?.variations)
    ? listing.variations
    : []) {
    terms.push(variation?.name);
    terms.push(...(Array.isArray(variation?.enabled_values)
      ? variation.enabled_values
      : []));
  }
  for (const field of Array.isArray(listing?.personalization_fields)
    ? listing.personalization_fields
    : []) {
    terms.push(field?.question);
    terms.push(...(Array.isArray(field?.enabled_options)
      ? field.enabled_options
      : []));
  }
  return terms.map(normalized).filter(value => value.length >= 2);
}

export function validateMessageDraftSafety({
  scenario,
  replyBody,
  verifiedFacts = {},
  conversation = {},
  sourceMessageId = null,
}) {
  const body = cleanText(replyBody, 10_000);
  const sourceMessage = (
    Array.isArray(conversation?.messages) ? conversation.messages : []
  ).find(message => (
    String(message?.source_id || message?.id || '')
    === String(sourceMessageId || '')
  ));
  const explicitFileTransfer = classifyExplicitBuyerFileTransferIntent(
    sourceMessage?.body,
  );
  const freeform = scenario === 'freeform';
  if (!freeform && /[\u2013\u2014]/u.test(body)) {
    return blocked(
      'MESSAGE_DRAFT_DASH_STYLE_VIOLATION',
      'Template-driven buyer-facing drafts may not contain en dash or em dash characters',
    );
  }
  if (
    body.length > (freeform ? 2_500 : 1_000)
    || (!freeform && /[\r\n]/u.test(body))
  ) {
    return blocked(
      'MESSAGE_DRAFT_COMPACT_PARAGRAPH_REQUIRED',
      freeform
        ? 'Universal assistant drafts must stay within 2500 characters'
        : 'Template-driven buyer-facing drafts must be one compact line of at most 1000 characters',
    );
  }
  if (scenario === 'how_to_order' && explicitFileTransfer) {
    return blocked(
      'MESSAGE_DRAFT_SCENARIO_MISMATCH',
      'A buyer file-transfer question may not be answered with how-to-order guidance',
    );
  }
  if (scenario === 'how_to_send_files') {
    if (!verifiedPaidOrder(verifiedFacts)) {
      return blocked(
        'MESSAGE_DRAFT_VERIFIED_PAID_ORDER_REQUIRED',
        'File-delivery instructions require an exact verified paid Etsy order linked to this conversation',
      );
    }
    if (!explicitFileTransfer) {
      return blocked(
        'MESSAGE_DRAFT_FILE_INTENT_UNVERIFIED',
        'The exact triggering message is not a verified file-transfer question',
      );
    }
    const text = normalized(body);
    if (
      /\bwhich product\b|\bnumber of people\b|\bwould you like to order\b/i.test(
        text,
      )
    ) {
      return blocked(
        'MESSAGE_DRAFT_IRRELEVANT_CLARIFICATION',
        'The reply asks an ordering question instead of answering how to send files',
      );
    }
    if (!/^(?:hi|hello|hey)\b/i.test(body)) {
      return blocked(
        'MESSAGE_DRAFT_GREETING_MISSING',
        'The first reply must begin with a short natural greeting',
      );
    }
    const answersDirectly = (
      /\b(?:yes|you can|please|feel free)\b/i.test(text)
      && /\b(?:send|upload|attach|share)\b/i.test(text)
      && /\b(?:photos?|pictures?|images?|files?|attachments?)\b/i.test(text)
      && /\b(?:here|etsy|conversation|message)\b/i.test(text)
    );
    if (!answersDirectly) {
      return blocked(
        'MESSAGE_DRAFT_DIRECT_ANSWER_MISSING',
        'The reply must directly confirm how the buyer can send the files here',
      );
    }
    if (/\b(?:google drive|dropbox|wetransfer|telegram|whatsapp)\b/i.test(text)) {
      return blocked(
        'MESSAGE_DRAFT_UNVERIFIED_CHANNEL',
        'The reply mentions an unverified file-delivery channel',
      );
    }
    const mentionsEmail = /\be-?mail\b/i.test(text)
      || emailAddressesIn(body).length > 0;
    if (mentionsEmail) {
      const allowedEmails = verifiedDeliveryEmails(verifiedFacts);
      const bodyEmails = emailAddressesIn(body);
      if (
        !allowedEmails.length
        || !bodyEmails.length
        || bodyEmails.some(address => !allowedEmails.includes(address))
      ) {
        return blocked(
          'MESSAGE_DRAFT_UNVERIFIED_EMAIL_CHANNEL',
          'Email delivery may be mentioned only with an exact address verified in the linked Etsy listing',
        );
      }
    }
    return { ok: true };
  }
  if (scenario === 'materials_sent_by_email') {
    const claim = verifiedFacts?.materials?.email_claim;
    if (claim?.checked !== true) {
      return blocked(
        'MESSAGE_DRAFT_EMAIL_CHECK_REQUIRED',
        'The bounded Gmail check from the verified order payment time is required',
      );
    }
    const bodyEmails = emailAddressesIn(body);
    if (bodyEmails.length) {
      const allowedEmails = verifiedDeliveryEmails(verifiedFacts);
      if (
        !allowedEmails.length
        || bodyEmails.some(address => !allowedEmails.includes(address))
      ) {
        return blocked(
          'MESSAGE_DRAFT_UNVERIFIED_EMAIL_CHANNEL',
          'The draft contains an email address not verified in the linked Etsy listing',
        );
      }
    }
    if (
      claim?.possible_match_requires_review === true
      && /\b(?:we|i)\s+(?:have\s+)?(?:definitely\s+)?(?:received|got)\s+(?:all\s+)?(?:your\s+)?(?:files?|photos?|images?|attachments?|materials?)\b/i.test(normalized(body))
    ) {
      return blocked(
        'MESSAGE_DRAFT_EMAIL_MATCH_OVERSTATED',
        'A possible personal-sender match may not be described as definitely received buyer materials',
      );
    }
    return { ok: true };
  }
  if (scenario !== 'how_to_order') return { ok: true };
  const listing = verifiedFacts?.listing;
  const verifiedListing = listing?.verified === true
    && /^\d+$/.test(String(listing?.listing_id || ''))
    && cleanText(listing?.url, 1_000)
      === `https://www.etsy.com/listing/${listing.listing_id}`;

  if (hasPriceClaim(body)) {
    return blocked(
      'MESSAGE_DRAFT_UNVERIFIED_PRICE_CLAIM',
      'How-to-order drafts may not state a price without verified price facts',
    );
  }

  if (preSaleMaterialInvitation(body)) {
    return blocked(
      'MESSAGE_DRAFT_PRE_SALE_MATERIAL_INVITATION',
      'A pre-sale reply may not ask the buyer to send files, photos, or other materials before ordering',
    );
  }
  if (!purchaseGuidance(body)) {
    return blocked(
      'MESSAGE_DRAFT_PURCHASE_FIRST_REQUIRED',
      'A pre-sale reply must direct the buyer to place or choose an order before materials are reviewed',
    );
  }

  const urls = urlsIn(body);
  if (urls.length && (
    !verifiedListing
    || urls.some(url => url.replace(/[.,!?]+$/, '') !== listing.url)
  )) {
    return blocked(
      'MESSAGE_DRAFT_UNVERIFIED_LINK_CLAIM',
      'The draft contains a link that is not the exact verified Etsy listing URL',
    );
  }

  if (!verifiedListing) {
    if (
      !oneConciseQuestion(body)
      || clarificationInstruction(body)
    ) {
      return blocked(
        'MESSAGE_DRAFT_CLARIFICATION_ONLY',
        'Without an exact verified listing, the draft must be one concise clarification question',
      );
    }
    return { ok: true };
  }

  const text = normalized(body);
  if (
    /\b(?:active|available)\s+listing\b|\blisting\s+is\s+(?:active|available)\b/i.test(
      text,
    )
    && listing.active !== true
  ) {
    return blocked(
      'MESSAGE_DRAFT_UNVERIFIED_LISTING_CLAIM',
      'The draft describes a listing as active although that is not verified',
    );
  }
  if (
    /\b(?:inactive|unavailable)\s+listing\b|\blisting\s+is\s+(?:inactive|unavailable)\b/i.test(
      text,
    )
    && listing.active !== false
  ) {
    return blocked(
      'MESSAGE_DRAFT_UNVERIFIED_LISTING_CLAIM',
      'The draft describes a listing as inactive although that is not verified',
    );
  }
  if (
    listingClaim(body)
    && /\b\d{6,}\b/.test(text)
    && !text.includes(String(listing.listing_id))
  ) {
    return blocked(
      'MESSAGE_DRAFT_UNVERIFIED_LISTING_CLAIM',
      'The draft contains an Etsy listing ID that was not verified',
    );
  }
  if (optionClaim(body)) {
    const terms = verifiedOptionTerms(listing);
    if (!terms.length || !terms.some(term => text.includes(term))) {
      return blocked(
        'MESSAGE_DRAFT_UNVERIFIED_OPTION_CLAIM',
        'The draft mentions an option that is not backed by verified listing fields',
      );
    }
  }
  return { ok: true };
}
