import { generateWithMessageAi } from './message-ai.js';

const ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'decision',
    'rule_id',
    'scenario',
    'confidence',
    'rationale',
  ],
  properties: {
    decision: { type: 'string', enum: ['route', 'no_action'] },
    rule_id: { type: 'string', maxLength: 80 },
    scenario: { type: 'string', maxLength: 100 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', maxLength: 1_500 },
  },
};

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizedIntentText(value) {
  return cleanText(value, 4_000)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ');
}

const MEDIA_OBJECT = (
  '(?:photos?|pictures?|images?|files?|media|attachments?|artwork|references?)'
);
const TRANSFER_ACTION = '(?:send|upload|attach|share|submit|provide|forward)';
const TRANSFERRED_ACTION = '(?:sent|uploaded|attached|shared|submitted|provided|forwarded)';

export function classifyExplicitBuyerFileTransferIntent(body) {
  const text = normalizedIntentText(body);
  if (!text) return null;

  const explicitPatterns = [
    new RegExp(
      `\\b(?:can|could|may|should)\\s+(?:i|we)\\b.{0,120}`
      + `\\b${TRANSFER_ACTION}\\b.{0,120}\\b${MEDIA_OBJECT}\\b`,
      'i',
    ),
    new RegExp(
      `\\b(?:can|could|may|should)\\s+(?:i|we)\\b.{0,120}`
      + `\\b${MEDIA_OBJECT}\\b.{0,120}\\b${TRANSFER_ACTION}\\b`,
      'i',
    ),
    new RegExp(
      `\\b(?:is|would)\\s+it\\s+(?:be\\s+)?`
      + `(?:possible|ok|okay|alright|allowed)\\b.{0,160}`
      + `\\b${TRANSFER_ACTION}\\b.{0,120}\\b${MEDIA_OBJECT}\\b`,
      'i',
    ),
    new RegExp(
      `\\b(?:where|how)\\b.{0,160}\\b${TRANSFER_ACTION}\\b`
      + `.{0,120}\\b${MEDIA_OBJECT}\\b`,
      'i',
    ),
    new RegExp(
      `\\b(?:where|how)\\b.{0,160}\\b${MEDIA_OBJECT}\\b`
      + `.{0,120}\\b${TRANSFERRED_ACTION}\\b`,
      'i',
    ),
    new RegExp(
      `\\bhow\\s+many\\b.{0,80}\\b${MEDIA_OBJECT}\\b`
      + `.{0,100}\\b(?:can|could|may|should)\\s+(?:i|we)\\b`
      + `.{0,100}\\b${TRANSFER_ACTION}\\b`,
      'i',
    ),
    new RegExp(
      `\\bdo\\s+you\\s+accept\\b.{0,120}\\b${MEDIA_OBJECT}\\b`,
      'i',
    ),
    new RegExp(
      `\\b(?:are|is)\\b.{0,80}\\b${MEDIA_OBJECT}\\b`
      + `.{0,80}\\b(?:allowed|accepted)\\b`,
      'i',
    ),
  ];
  if (!explicitPatterns.some(pattern => pattern.test(text))) return null;
  return {
    intent: 'buyer_requests_file_transfer_instructions_or_permission',
    confidence: 0.995,
    rationale: (
      'The exact incoming buyer message explicitly asks for permission, '
      + 'possibility, capacity, method, or destination to transfer buyer media.'
    ),
  };
}

export function classifyBuyerEmailTransferClaim(body) {
  const text = normalizedIntentText(body);
  if (!text) return null;
  const sent = (
    /\b(?:i|we)\s+(?:have\s+)?(?:sent|emailed|forwarded|uploaded|attached|submitted)\b/i
    .test(text)
    || /\b(?:sent|emailed|forwarded)\s+(?:it|them|the\s+(?:files?|photos?|pictures?|images?))\b/i
    .test(text)
  );
  const delivery = (
    /\b(?:e-?mail|mail|files?|photos?|pictures?|images?|attachments?|materials?)\b/i
    .test(text)
  );
  if (!sent || !delivery) return null;
  return {
    intent: 'buyer_claims_materials_already_sent_by_email',
    confidence: 0.995,
    rationale: (
      'The exact incoming buyer message says materials were already sent. '
      + 'This requires the bounded after-message email check, not general inbox search.'
    ),
  };
}

function compactMessage(message) {
  return {
    source_id: cleanText(message?.source_id || message?.id, 160),
    direction: cleanText(message?.direction, 40),
    sender: cleanText(message?.sender, 160),
    sent_at: cleanText(message?.sent_at, 80) || null,
    body: cleanText(message?.body, 3_000),
    attachment_count: Array.isArray(message?.attachments)
      ? message.attachments.length
      : 0,
  };
}

function compactConversation(messages = [], sourceMessageId = null) {
  const normalized = (Array.isArray(messages) ? messages : []).map(compactMessage);
  const maxMessages = 50;
  const maxSerializedChars = 45_000;
  if (
    normalized.length <= maxMessages
    && JSON.stringify(normalized).length <= maxSerializedChars
  ) return normalized;

  const indices = new Set();
  for (let index = 0; index < Math.min(6, normalized.length); index += 1) {
    indices.add(index);
  }
  for (
    let index = Math.max(0, normalized.length - 38);
    index < normalized.length;
    index += 1
  ) indices.add(index);

  const triggerId = cleanText(sourceMessageId, 160);
  const triggerIndex = normalized.findIndex(message => (
    cleanText(message?.source_id, 160) === triggerId
  ));
  if (triggerIndex >= 0) {
    for (
      let index = Math.max(0, triggerIndex - 3);
      index <= Math.min(normalized.length - 1, triggerIndex + 3);
      index += 1
    ) indices.add(index);
  }

  const selected = [...indices]
    .sort((left, right) => left - right)
    .map(index => normalized[index]);
  while (selected.length > maxMessages) selected.splice(6, 1);
  while (
    JSON.stringify(selected).length > maxSerializedChars
    && selected.length > 20
  ) selected.splice(Math.min(6, selected.length - 10), 1);
  return selected;
}

function compactListingReferences(conversation = {}) {
  return (Array.isArray(conversation?.listing_refs)
    ? conversation.listing_refs
    : [])
    .filter(ref => (
      ref?.source === 'inline_listing_ids'
      && /^\d+$/.test(String(ref?.listing_id || ''))
      && String(ref?.listing_url || '')
        === `https://www.etsy.com/listing/${ref.listing_id}`
    ))
    .map(ref => ({
      listing_id: cleanText(ref.listing_id, 32),
      source: 'inline_listing_ids',
      source_message_id:
        cleanText(ref.source_message_id, 160) || null,
    }))
    .slice(0, 10);
}

function exactReceiptIds(conversation = {}) {
  return [...new Set([
    ...(Array.isArray(conversation?.receipt_ids)
      ? conversation.receipt_ids
      : []),
    ...(Array.isArray(conversation?.order_refs)
      ? conversation.order_refs.map(reference => reference?.receipt_id)
      : []),
  ].map(value => cleanText(value, 32)).filter(value => /^\d+$/.test(value)))];
}

export function validateSemanticRoute(result, rules) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Message semantic router returned an invalid result');
  }
  const decision = result.decision;
  if (decision === 'no_action') {
    return {
      decision,
      rule_id: '',
      scenario: '',
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
      rationale: cleanText(result.rationale, 1_500)
        || 'No configured message scenario applies.',
    };
  }
  if (decision !== 'route') {
    throw new Error('Message semantic router returned an unknown decision');
  }
  const ruleId = cleanText(result.rule_id, 80);
  const selected = rules.find(rule => rule.id === ruleId);
  if (!selected || cleanText(result.scenario, 100) !== selected.scenario) {
    throw new Error('Message semantic router selected an unavailable rule');
  }
  return {
    decision,
    rule_id: selected.id,
    scenario: selected.scenario,
    confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
    rationale: cleanText(result.rationale, 1_500),
  };
}

export async function classifyNewMessageScenario({
  conversation,
  sourceMessageId,
  rules,
  playbook,
  generate = generateWithMessageAi,
}) {
  const enabledRules = (Array.isArray(rules) ? rules : []).map(rule => ({
    id: rule.id,
    label: rule.label,
    scenario: rule.scenario,
    conditions: rule.conditions || '',
    scenario_instructions:
      playbook?.scenarios?.[rule.scenario]?.instructions || '',
  }));
  if (!enabledRules.length) {
    return {
      decision: 'no_action',
      rule_id: '',
      scenario: '',
      confidence: 1,
      rationale: 'No enabled rule applies to new messages.',
    };
  }

  const allMessages = Array.isArray(conversation?.messages)
    ? conversation.messages
    : [];
  const recentConversation = compactConversation(allMessages, sourceMessageId);
  const exactTrigger = allMessages.find(message => (
    cleanText(message?.source_id || message?.id, 160)
    === String(sourceMessageId || '')
  ));
  // The triggering message can be outside the 30-message recent window.
  // Supply its sanitized content independently so the router never reasons
  // from an ID without seeing the exact message.
  const triggeringMessage = exactTrigger ? compactMessage(exactTrigger) : null;
  const emailTransferClaim = classifyBuyerEmailTransferClaim(
    triggeringMessage?.body,
  );
  const emailClaimRules = enabledRules.filter(rule => (
    rule.scenario === 'materials_sent_by_email'
  ));
  const explicitFileTransfer = classifyExplicitBuyerFileTransferIntent(
    triggeringMessage?.body,
  );
  const fileTransferRules = enabledRules.filter(rule => (
    rule.scenario === 'how_to_send_files'
  ));
  const receiptIds = exactReceiptIds(conversation);
  if (emailTransferClaim && receiptIds.length !== 1) {
    return {
      decision: 'no_action',
      rule_id: '',
      scenario: '',
      confidence: 1,
      rationale: 'The buyer says materials were sent, but no single exact Etsy receipt is linked for a safe email check.',
    };
  }
  if (
    emailTransferClaim
    && receiptIds.length === 1
    && emailClaimRules.length === 1
  ) {
    const selected = emailClaimRules[0];
    return {
      decision: 'route',
      rule_id: selected.id,
      scenario: selected.scenario,
      confidence: emailTransferClaim.confidence,
      rationale: emailTransferClaim.rationale,
    };
  }
  if (explicitFileTransfer && receiptIds.length !== 1) {
    return {
      decision: 'no_action',
      rule_id: '',
      scenario: '',
      confidence: 1,
      rationale: receiptIds.length > 1
        ? (
          'The buyer asks to send files, but multiple Etsy orders are linked. '
          + 'The exact order must be resolved before drafting a reply.'
        )
        : (
          'The buyer asks to send files for an order, but no exact Etsy order '
          + 'is linked. Missing order evidence is unknown, not proof that the '
          + 'buyer is pre-sale; no draft may be created yet.'
        ),
    };
  }
  if (
    explicitFileTransfer
    && receiptIds.length === 1
    && fileTransferRules.length === 1
  ) {
    const selected = fileTransferRules[0];
    return {
      decision: 'route',
      rule_id: selected.id,
      scenario: selected.scenario,
      confidence: explicitFileTransfer.confidence,
      rationale: explicitFileTransfer.rationale,
    };
  }

  const result = await generate(
    `You route one newly received Etsy buyer message to at most ONE configured draft rule.

Reason semantically over the exact triggering message and recent conversation. Do not classify by keyword matching.

Return decision="route" only when one rule clearly applies. Select exactly one supplied rule_id and its exact scenario. Return decision="no_action" for thanks, acknowledgements, spam, closing messages, or conversations that genuinely do not need a shop reply. Ambiguous wording is not by itself a reason for no_action when the buyer clearly expects help.

A supplied scenario="freeform" rule is the universal assistant fallback. Prefer a narrower non-freeform scenario whenever it clearly applies. Otherwise, when the triggering message and surrounding conversation reasonably indicate that the buyer expects a response, route to exactly one freeform rule. The drafting agent can resolve ordinary ambiguity from context or ask a material clarification when needed. With a freeform fallback available, decision="no_action" means the buyer genuinely does not need a reply, not merely that no narrow scenario matched or the wording was imperfect. Never use freeform to bypass an explicit evidence requirement of a narrower safety-sensitive workflow.

Interpret a how_to_send_files rule only for a conversation with an exact linked Etsy receipt. It includes an explicit buyer question about permission or possibility to send/share/upload/attach photos, pictures, images, files, media, artwork, or references; whether the shop accepts them; how many may be sent; and how or where to send them. Do not require the literal words "how" or "where".

Route to materials_sent_by_email when the buyer states that files, photos, images, attachments, or materials were already sent, emailed, forwarded, attached, or submitted. This includes context-dependent statements such as "I sent them" when the recent conversation clearly refers to customer materials. It requires one exact linked receipt. Do not route a promise to send later.

When no exact receipt is linked, treat the buyer's order status as unknown. Never infer that the buyer is pre-sale and never turn an explicit file-transfer question into how_to_order. Return no_action until one exact receipt is linked.

Do not choose a narrow file-transfer rule merely because media is mentioned. Statements that files were already sent, vague promises to send later, requests for the shop to send media to the buyer, feasibility questions, and other photo-product questions should be interpreted by their actual meaning. If they reasonably expect a response and no narrower safety-sensitive rule applies, the freeform fallback may handle them.

This decision may only create a draft for individual human approval. It never sends or approves a message.`,
    JSON.stringify({
      task: 'Choose zero or one draft rule for the exact incoming Etsy message.',
      triggering_source_message_id: sourceMessageId,
      triggering_message: triggeringMessage,
      participant: cleanText(
        conversation?.participant || conversation?.title,
        300,
      ),
      trusted_inline_listing_refs:
        compactListingReferences(conversation),
      exact_receipt_ids: receiptIds,
      recent_conversation: recentConversation,
      available_rules: enabledRules,
    }, null, 2),
    '',
    {
      structuredOutput: true,
      structuredOutputSchema: ROUTE_SCHEMA,
      maxTokens: 1_200,
      temperature: 0.1,
      validateResult: candidate => validateSemanticRoute(
        candidate,
        enabledRules,
      ),
    },
  );
  return validateSemanticRoute(result, enabledRules);
}
