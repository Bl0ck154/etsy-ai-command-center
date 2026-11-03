import crypto from 'node:crypto';

import { getMessageConversationForAgent } from './agent-tools.js';
import {
  loadMessageAutomationPolicy,
  MESSAGE_TRIGGER_EVENTS,
} from './automation-policy.js';
import { bridgePost, bridgeRequest } from './bridge-client.js';
import { generateMessageDraft } from './draft-agent.js';
import { loadMessagePlaybook } from './playbook.js';
import { classifyNewMessageScenario } from './semantic-router.js';
import {
  loadVerifiedListingFactsForConversation,
  loadVerifiedListingFactsForExactOrder,
} from './listing-context-evidence.js';
import { loadVerifiedOrderFactsForConversation } from './order-context-evidence.js';
import { orderContextConfig } from './order-context-client.js';
import { notifyMessageDraftReady } from './draft-notifier.js';
import {
  captureMessageLearningProposal,
  loadMessageLearningExamples,
  reconcileObservedManualRepliesForConversation,
} from './learning-runtime.js';
import { notifyMessageEvidenceBlocked } from './evidence-debug-notifier.js';
import { loadShopSellerStyleReference } from './shop-style-reference.js';
import {
  mutateMessageTriggerState as mutateState,
  readMessageTriggerState as readState,
} from './trigger-state-repository.js';

const ORDER_CONTEXT_SCENARIOS = new Set([
  'how_to_send_files',
  'materials_sent_by_email',
  'missing_materials',
  'deadline_variants_sent',
  'deadline_no_materials',
  'review_request',
]);

const DETERMINISTIC_LIFECYCLE_EVIDENCE_SCENARIOS = new Set([
  'missing_materials',
  'deadline_variants_sent',
  'deadline_no_materials',
  'review_request',
]);

const EVIDENCE_DEBUG_CODE = /(?:UNVERIFIED|NOT_VERIFIED|NOT_CONFIRMED|UNAVAILABLE|NOT_FOUND|RECEIPT_MISMATCH|RECEIPT_REQUIRED|SOURCE_MESSAGE_NOT_CACHED|DIRECTION_UNKNOWN|ORDER_CONTEXT|TIMEOUT|UPSTREAM_ERROR|RETRY_EXHAUSTED)/;

export const UNIVERSAL_ASSISTANT_RULE_ID = 'new_message_universal_assistant';

export function messageUniversalAssistantEnabled() {
  return /^(1|true|yes|on)$/i.test(
    String(process.env.MESSAGE_UNIVERSAL_ASSISTANT_ENABLED || ''),
  );
}

export function buildUniversalAssistantRule() {
  return {
    id: UNIVERSAL_ASSISTANT_RULE_ID,
    label: 'Universal AI assistant fallback',
    enabled: true,
    event: 'new_message',
    scenario: 'freeform',
    delay_minutes: 0,
    cooldown_minutes: 0,
    require_order_context: false,
    conditions: (
      'Fallback only. Use when the newest unanswered incoming buyer message, '
      + 'interpreted together with the surrounding conversation and any '
      + 'attachments, reasonably needs a shop response and no narrower enabled '
      + 'scenario clearly applies. Simple acknowledgements or closing remarks '
      + 'usually need no reply, but context is authoritative.'
    ),
    owner_notes: (
      "Answer the buyer's practical question directly from the conversation, "
      + 'shop context, playbook, seller style, and verified facts. Distinguish '
      + 'known facts from reasonable qualified intent, and clarify only when '
      + 'a material ambiguity remains. Do not invent operational facts or seller actions.'
    ),
  };
}

export function messageTriggerRulesForEvent(policy = {}, eventType = '') {
  const rules = (Array.isArray(policy.rules) ? policy.rules : [])
    .filter(rule => rule.enabled === true && rule.event === eventType);
  if (
    eventType === 'new_message'
    && messageUniversalAssistantEnabled()
    && !rules.some(rule => rule.id === UNIVERSAL_ASSISTANT_RULE_ID)
  ) {
    return [...rules, buildUniversalAssistantRule()];
  }
  return rules;
}

function needsEvidenceDebugNotification(code) {
  return EVIDENCE_DEBUG_CODE.test(cleanText(code, 160));
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function numericId(value, label) {
  const id = cleanText(value, 100);
  if (!/^\d+$/.test(id)) {
    const error = new Error(`${label} must be numeric`);
    error.status = 400;
    error.code = 'MESSAGE_TRIGGER_INVALID_EVENT';
    throw error;
  }
  return id;
}

function validIsoDate(value, label, { required = true } = {}) {
  const raw = cleanText(value, 80);
  if (!raw && !required) return null;
  const timestamp = Date.parse(raw);
  if (!raw || !Number.isFinite(timestamp)) {
    const error = new Error(`${label} must be an ISO date`);
    error.status = 400;
    error.code = 'MESSAGE_TRIGGER_INVALID_EVENT';
    throw error;
  }
  return new Date(timestamp).toISOString();
}

function runnerEnabled() {
  return (
    /^(1|true|yes|on)$/i.test(
      String(process.env.MESSAGE_AUTO_TRIGGERS_ENABLED || ''),
    )
    && /^(1|true|yes|on)$/i.test(
      String(process.env.MESSAGE_TRIGGER_RUNNER_ENABLED || ''),
    )
    && Buffer.byteLength(
      String(process.env.MESSAGE_EVENT_INGEST_TOKEN || '').trim(),
      'utf8',
    ) >= 32
  );
}

function orderLinkingReleased() {
  return (
    /^(1|true|yes|on)$/i.test(
      String(process.env.MESSAGE_ORDER_LINKING_ENABLED || ''),
    )
    && orderContextConfig().configured
  );
}

function assertRunnerEnabled() {
  if (runnerEnabled()) return;
  const error = new Error('Message trigger runner is disabled');
  error.status = 503;
  error.code = 'MESSAGE_TRIGGER_RUNNER_DISABLED';
  throw error;
}

function assertNoSecrets(value, trail = 'event') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(authorization|cookie|password|secret|token|api[_-]?key)/i.test(key)) {
      const error = new Error(`Sensitive field is not accepted: ${trail}.${key}`);
      error.status = 400;
      error.code = 'MESSAGE_TRIGGER_SENSITIVE_FIELD';
      throw error;
    }
    assertNoSecrets(child, `${trail}.${key}`);
  }
}

function boundedJsonObject(value, label, maxBytes = 64 * 1024) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  assertNoSecrets(value);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    const error = new Error(`${label} is too large`);
    error.status = 413;
    error.code = 'MESSAGE_TRIGGER_EVENT_TOO_LARGE';
    throw error;
  }
  return JSON.parse(serialized);
}

function deterministicId(...parts) {
  return crypto
    .createHash('sha256')
    .update(parts.map(part => String(part ?? '')).join('\u001f'))
    .digest('hex');
}

export function normalizeMessageTriggerEvent(value = {}) {
  const eventId = cleanText(value.event_id, 160);
  if (!eventId) {
    const error = new Error('event_id is required');
    error.status = 400;
    error.code = 'MESSAGE_TRIGGER_INVALID_EVENT';
    throw error;
  }
  const type = cleanText(value.type || value.event, 80);
  if (!MESSAGE_TRIGGER_EVENTS.includes(type)) {
    const error = new Error('Unknown message trigger event type');
    error.status = 400;
    error.code = 'MESSAGE_TRIGGER_INVALID_EVENT';
    throw error;
  }
  const shopId = numericId(value.shop_id, 'shop_id');
  const conversationId = numericId(value.conversation_id, 'conversation_id');
  const occurredAt = validIsoDate(value.occurred_at, 'occurred_at');
  const sourceMessageId = cleanText(value.source_message_id, 160) || null;
  if (type === 'new_message' && !sourceMessageId) {
    const error = new Error('source_message_id is required for new_message');
    error.status = 400;
    error.code = 'MESSAGE_TRIGGER_INVALID_EVENT';
    throw error;
  }
  return {
    event_id: eventId,
    type,
    shop_id: shopId,
    conversation_id: conversationId,
    source_message_id: sourceMessageId,
    occurred_at: occurredAt,
    received_at: new Date().toISOString(),
    verified_facts: boundedJsonObject(value.verified_facts, 'verified_facts'),
    rule_evidence: boundedJsonObject(value.rule_evidence, 'rule_evidence', 32 * 1024),
    source: cleanText(value.source, 120) || 'internal_event',
  };
}

function eventPayloadDigest(event) {
  return deterministicId(JSON.stringify({
    event_id: event.event_id,
    type: event.type,
    shop_id: event.shop_id,
    conversation_id: event.conversation_id,
    source_message_id: event.source_message_id,
    occurred_at: event.occurred_at,
    verified_facts: event.verified_facts,
    rule_evidence: event.rule_evidence,
    source: event.source,
  }));
}

function publicCandidate(candidate) {
  return {
    id: candidate.id,
    event_id: candidate.event_id,
    rule_id: candidate.rule_id,
    event: candidate.event,
    scenario: candidate.scenario,
    shop_id: candidate.shop_id,
    conversation_id: candidate.conversation_id,
    status: candidate.status,
    due_at: candidate.due_at,
    attempts: candidate.attempts,
    draft_id: candidate.draft_id || null,
    draft_status: candidate.draft_status || null,
    draft_reconciled_at: candidate.draft_reconciled_at || null,
    draft_resolution_history: Array.isArray(candidate.draft_resolution_history)
      ? candidate.draft_resolution_history
      : [],
    notification_status: candidate.notification_status || null,
    notified_at: candidate.notified_at || null,
    debug_notification_status: candidate.debug_notification_status || null,
    debug_notified_at: candidate.debug_notified_at || null,
    participant: candidate.participant || null,
    receipt_id: candidate.receipt_id || null,
    deadline_at: candidate.deadline_at || null,
    source_message_preview: candidate.source_message_preview || null,
    buyer_message_preview: candidate.buyer_message_preview || null,
    draft_preview: candidate.draft_preview || null,
    reason: candidate.draft_reason
      || candidate.router_rationale
      || candidate.block_reason
      || null,
    block_code: candidate.block_code || null,
    block_reason: candidate.block_reason || null,
    evidence_gaps: Array.isArray(candidate.evidence_gaps)
      ? candidate.evidence_gaps
      : [],
    last_error: candidate.last_error || null,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  };
}

const DRAFT_ACTION_RESOLUTIONS = Object.freeze({
  approveDraft: { candidateStatus: 'APPROVED', draftStatus: 'APPROVED' },
  sendApprovedDraft: { candidateStatus: 'SENT', draftStatus: 'SENT' },
  skipDraft: { candidateStatus: 'SKIPPED', draftStatus: 'SKIPPED' },
  blockDraft: { candidateStatus: 'BLOCKED', draftStatus: 'BLOCKED' },
});

export async function reconcileMessageTriggerDraft({
  draft_id: draftIdValue,
  action,
  actor,
  reason,
  bridge_status: bridgeStatusValue,
  reconciled_at: reconciledAtValue,
} = {}) {
  const draftId = cleanText(draftIdValue, 160);
  if (!draftId) {
    const error = new Error('draft_id is required');
    error.status = 400;
    error.code = 'MESSAGE_TRIGGER_DRAFT_ID_REQUIRED';
    throw error;
  }
  const resolution = DRAFT_ACTION_RESOLUTIONS[action];
  if (!resolution) {
    const error = new Error('Unknown draft reconciliation action');
    error.status = 400;
    error.code = 'MESSAGE_TRIGGER_DRAFT_ACTION_INVALID';
    throw error;
  }
  const reconciledAt = reconciledAtValue
    ? validIsoDate(reconciledAtValue, 'reconciled_at')
    : new Date().toISOString();
  const observedBridgeStatus = cleanText(bridgeStatusValue, 80).toUpperCase();
  if (observedBridgeStatus && observedBridgeStatus !== resolution.draftStatus) {
    const error = new Error(
      `Bridge returned ${observedBridgeStatus} for ${action}; expected ${resolution.draftStatus}`,
    );
    error.status = 502;
    error.code = 'MESSAGE_TRIGGER_DRAFT_STATUS_MISMATCH';
    throw error;
  }
  const bridgeStatus = observedBridgeStatus || resolution.draftStatus;
  const auditEntry = {
    action,
    status: resolution.candidateStatus,
    bridge_status: bridgeStatus,
    actor: {
      id: cleanText(actor?.id, 120) || 'unknown',
      name: cleanText(actor?.name, 200) || 'Unknown operator',
    },
    reason: cleanText(reason, 1_000) || null,
    reconciled_at: reconciledAt,
  };

  const currentState = await readState();
  const hasCandidate = Object.values(currentState.candidates)
    .some(candidate => cleanText(candidate.draft_id, 160) === draftId);
  if (!hasCandidate) {
    return { draft_id: draftId, matched: 0, candidates: [] };
  }

  return mutateState(async state => {
    const matched = [];
    for (const candidate of Object.values(state.candidates)) {
      if (cleanText(candidate.draft_id, 160) !== draftId) continue;
      const history = Array.isArray(candidate.draft_resolution_history)
        ? candidate.draft_resolution_history
        : [];
      candidate.status = resolution.candidateStatus;
      candidate.draft_status = bridgeStatus;
      candidate.draft_reconciled_at = reconciledAt;
      candidate.draft_resolution_history = [...history, auditEntry].slice(-20);
      candidate.updated_at = reconciledAt;
      matched.push(publicCandidate(candidate));
    }
    return {
      draft_id: draftId,
      matched: matched.length,
      candidates: matched,
    };
  });
}

export async function enqueueMessageTriggerEvent(value, dependencies = {}) {
  assertRunnerEnabled();
  const event = normalizeMessageTriggerEvent(value);
  const loadPolicy = dependencies.loadPolicy || loadMessageAutomationPolicy;
  const policyState = await loadPolicy(event.shop_id);
  const policy = policyState?.policy || {};
  const eventKey = deterministicId(event.shop_id, event.event_id);
  const payloadDigest = eventPayloadDigest(event);

  return mutateState(async state => {
    const existingEvent = state.events[eventKey];
    if (existingEvent) {
      if (existingEvent.payload_digest !== payloadDigest) {
        const error = new Error(
          'event_id was already used with a different message event payload',
        );
        error.status = 409;
        error.code = 'MESSAGE_TRIGGER_IDEMPOTENCY_CONFLICT';
        throw error;
      }
      const candidates = Object.values(state.candidates)
        .filter(candidate => candidate.event_key === eventKey)
        .map(publicCandidate);
      return { duplicate: true, event: existingEvent, candidates };
    }

    state.events[eventKey] = {
      ...event,
      key: eventKey,
      payload_digest: payloadDigest,
      policy_revision: Number(policyState?.revision) || 0,
    };

    const matchingRules = messageTriggerRulesForEvent(policy, event.type);
    const now = new Date().toISOString();
    const candidates = [];

    if (policy.enabled !== true) {
      const id = deterministicId(eventKey, 'policy-disabled');
      state.candidates[id] = {
        id,
        event_key: eventKey,
        event_id: event.event_id,
        event: event.type,
        rule_id: null,
        scenario: null,
        shop_id: event.shop_id,
        conversation_id: event.conversation_id,
        status: 'IGNORED_DISABLED',
        due_at: now,
        attempts: 0,
        block_code: 'MESSAGE_AUTOMATION_POLICY_DISABLED',
        block_reason: 'Message automation policy is disabled',
        created_at: now,
        updated_at: now,
      };
      candidates.push(publicCandidate(state.candidates[id]));
    } else if (!matchingRules.length) {
      const id = deterministicId(eventKey, 'no-matching-rule');
      state.candidates[id] = {
        id,
        event_key: eventKey,
        event_id: event.event_id,
        event: event.type,
        rule_id: null,
        scenario: null,
        shop_id: event.shop_id,
        conversation_id: event.conversation_id,
        status: 'IGNORED_NO_RULE',
        due_at: now,
        attempts: 0,
        block_code: 'MESSAGE_TRIGGER_NO_MATCHING_RULE',
        block_reason: `No enabled policy rule handles event ${event.type}`,
        created_at: now,
        updated_at: now,
      };
      candidates.push(publicCandidate(state.candidates[id]));
    } else if (event.type === 'new_message') {
      const id = deterministicId(eventKey, 'semantic-router');
      const earliestDelay = Math.min(
        ...matchingRules.map(rule => Number(rule.delay_minutes) || 0),
      );
      state.candidates[id] = {
        id,
        event_key: eventKey,
        event_id: event.event_id,
        event: event.type,
        rule_id: null,
        scenario: null,
        shop_id: event.shop_id,
        conversation_id: event.conversation_id,
        policy_revision: Number(policyState?.revision) || 0,
        rules: matchingRules.map(rule => ({
          id: rule.id,
          label: rule.label,
          scenario: rule.scenario,
          delay_minutes: Number(rule.delay_minutes) || 0,
          cooldown_minutes: Number(rule.cooldown_minutes) || 0,
          require_order_context: rule.require_order_context === true,
          conditions: rule.conditions || '',
          owner_notes: rule.owner_notes || '',
        })),
        status: 'PENDING',
        due_at: new Date(
          Date.parse(event.occurred_at) + earliestDelay * 60_000,
        ).toISOString(),
        attempts: 0,
        created_at: now,
        updated_at: now,
      };
      candidates.push(publicCandidate(state.candidates[id]));
    } else {
      for (const rule of matchingRules) {
        const id = deterministicId(eventKey, rule.id);
        const dueAt = new Date(
          Date.parse(event.occurred_at) + (Number(rule.delay_minutes) || 0) * 60_000,
        ).toISOString();
        state.candidates[id] = {
          id,
          event_key: eventKey,
          event_id: event.event_id,
          event: event.type,
          rule_id: rule.id,
          scenario: rule.scenario,
          shop_id: event.shop_id,
          conversation_id: event.conversation_id,
          policy_revision: Number(policyState?.revision) || 0,
          rule: {
            id: rule.id,
            label: rule.label,
            scenario: rule.scenario,
            cooldown_minutes: Number(rule.cooldown_minutes) || 0,
            require_order_context: rule.require_order_context === true,
            conditions: rule.conditions || '',
            owner_notes: rule.owner_notes || '',
          },
          status: 'PENDING',
          due_at: dueAt,
          attempts: 0,
          created_at: now,
          updated_at: now,
        };
        candidates.push(publicCandidate(state.candidates[id]));
      }
    }

    return {
      duplicate: false,
      event: state.events[eventKey],
      candidates,
    };
  });
}

function evidenceError(code, reason, evidenceGaps = []) {
  return {
    ok: false,
    code,
    reason,
    evidence_gaps: evidenceGaps
      .map(value => cleanText(value, 300))
      .filter(Boolean)
      .slice(0, 20),
  };
}

function confirmedNoAction(code, reason) {
  return { ...evidenceError(code, reason), no_action: true };
}

function validCheckedAt(value) {
  return Boolean(value && Number.isFinite(Date.parse(String(value))));
}

function messageChronology(items) {
  return (Array.isArray(items) ? items : [])
    .map((message, index) => ({
      message,
      index,
      timestamp: Date.parse(
        message?.sent_at || message?.updated_at || '',
      ) || 0,
      ordinal: Number(message?.ordinal) || 0,
    }))
    .sort((left, right) => (
      right.timestamp - left.timestamp
      || right.ordinal - left.ordinal
      || right.index - left.index
    ));
}

function notificationConversationPreview(conversation) {
  return messageChronology(conversation?.messages)
    .map(entry => entry.message)
    .filter(message => (
      ['incoming', 'inbound', 'outgoing', 'outbound'].includes(
        cleanText(message?.direction, 40).toLowerCase(),
      )
      && cleanText(message?.body, 500)
    ))
    .slice(0, 6)
    .reverse()
    .map(message => ({
      direction: cleanText(message?.direction, 40).toLowerCase(),
      body: cleanText(message?.body, 500),
    }));
}

function conversationHeadMessage(conversation) {
  return messageChronology(conversation?.messages)
    .map(entry => entry.message)
    .find(message => (
      !['system', 'event'].includes(
        cleanText(message?.direction, 40).toLowerCase(),
      )
      && cleanText(message?.source_id || message?.id, 160)
    )) || null;
}

function conversationReceiptIds(conversation) {
  const values = [
    ...(Array.isArray(conversation?.receipt_ids) ? conversation.receipt_ids : []),
    ...(Array.isArray(conversation?.order_refs)
      ? conversation.order_refs.flatMap(reference => [
        reference?.receipt_id,
        reference?.id,
      ])
      : []),
  ];
  return new Set(values.map(value => cleanText(value, 160)).filter(Boolean));
}

function validateOrder(facts, conversation) {
  const order = facts?.order;
  const receiptId = cleanText(order?.receipt_id, 160);
  if (
    order?.linked !== true
    || !receiptId
    || !validCheckedAt(order.checked_at)
  ) {
    return evidenceError(
      'MESSAGE_TRIGGER_ORDER_NOT_VERIFIED',
      'A linked exact receipt_id and order checked_at timestamp are required',
    );
  }
  const receiptIds = conversationReceiptIds(conversation);
  if (!receiptIds.has(receiptId)) {
    return evidenceError(
      'MESSAGE_TRIGGER_RECEIPT_MISMATCH',
      'The verified receipt_id is not linked to this conversation by the Bridge',
    );
  }
  return { ok: true };
}

function validateMissingMaterials(facts) {
  const sources = Object.values(facts?.materials?.sources || {});
  if (
    facts?.materials?.missing === false
    || sources.some(source => source?.received === true)
  ) {
    return confirmedNoAction(
      'MESSAGE_TRIGGER_MATERIALS_ALREADY_PRESENT',
      'Materials are already present in at least one verified channel',
    );
  }
  if (facts?.order?.paid === false || facts?.order?.all_items_physical === false) {
    return confirmedNoAction(
      'MESSAGE_TRIGGER_ORDER_NOT_APPLICABLE',
      'The verified order is unpaid or does not consist only of physical made-to-order items',
    );
  }
  if (
    facts?.order?.made_to_order_verified === true
    && facts?.order?.made_to_order === false
  ) {
    return confirmedNoAction(
      'MESSAGE_TRIGGER_LISTING_NOT_MADE_TO_ORDER',
      'The official Etsy listing facts confirm that this is not a made-to-order order',
    );
  }
  const orderGaps = [
    ...(facts?.order?.paid === true ? [] : ['paid order status']),
    ...(facts?.order?.all_items_physical === true ? [] : ['physical item status']),
    ...(facts?.order?.automation_facts_verified === true
      ? []
      : ['official receipt automation facts']),
    ...(validCheckedAt(facts?.order?.paid_at) ? [] : ['paid_at timestamp']),
    ...(facts?.order?.made_to_order_verified === true
      ? []
      : ['official listing when_made check']),
    ...(facts?.order?.made_to_order === true ? [] : ['made-to-order listing status']),
    ...(validCheckedAt(facts?.order?.made_to_order_checked_at)
      ? []
      : ['made-to-order checked_at timestamp']),
  ];
  if (orderGaps.length) {
    return evidenceError(
      'MESSAGE_TRIGGER_MADE_TO_ORDER_UNVERIFIED',
      'A paid, physical, officially verified made-to-order Etsy listing is required',
      orderGaps,
    );
  }
  if (facts?.materials?.missing !== true) {
    return evidenceError(
      'MESSAGE_TRIGGER_MATERIALS_NOT_CONFIRMED_MISSING',
      'The Trello operational record does not confirm that customer materials are absent',
      ['materials.missing=true from the Trello operational record'],
    );
  }
  return { ok: true };
}

function validateDeadline(facts) {
  const deadline = facts?.deadline;
  const hoursUntilDue = validCheckedAt(deadline?.due_at)
    ? (Date.parse(deadline.due_at) - Date.now()) / 3_600_000
    : Number.NaN;
  if (
    deadline?.verified !== true
    || deadline?.reached_or_approaching !== true
    || !validCheckedAt(deadline?.due_at)
    || !validCheckedAt(deadline?.checked_at)
    || !Number.isFinite(hoursUntilDue)
    || hoursUntilDue > 24
    || hoursUntilDue < -24
  ) {
    return evidenceError(
      'MESSAGE_TRIGGER_DEADLINE_UNVERIFIED',
      'A verified Etsy ship-by deadline within the 24-hour execution window is required',
    );
  }
  return { ok: true };
}

export function validateMessageTriggerEvidence(candidate, event, conversation) {
  const rule = candidate?.rule || {};
  const facts = event?.verified_facts || {};
  const ruleEvidence = event?.rule_evidence?.[rule.id];

  if (
    rule.conditions
    && event.type !== 'new_message'
    && !DETERMINISTIC_LIFECYCLE_EVIDENCE_SCENARIOS.has(rule.scenario)
  ) {
    if (
      ruleEvidence?.matched !== true
      || !cleanText(ruleEvidence?.evaluated_by, 120)
      || !(Array.isArray(ruleEvidence?.facts) && ruleEvidence.facts.length)
    ) {
      return evidenceError(
        'MESSAGE_TRIGGER_CONDITIONS_UNVERIFIED',
        'Configured rule conditions require matched=true, evaluated_by, and supporting facts',
      );
    }
  }

  if (event.type === 'new_message') {
    const messages = messageChronology(conversation?.messages);
    const sourceEntry = messages.find(({ message }) => (
      String(message?.source_id || message?.id) === event.source_message_id
    ));
    const source = sourceEntry?.message;
    if (!source) {
      return evidenceError(
        'MESSAGE_TRIGGER_SOURCE_MESSAGE_NOT_CACHED',
        'The triggering buyer message is not present in the local conversation history',
      );
    }
    const direction = cleanText(source.direction, 40).toLowerCase();
    const sender = cleanText(source.sender, 80).toLowerCase();
    if (
      ['outgoing', 'outbound'].includes(direction)
      || ['self', 'shop', 'seller', 'you'].includes(sender)
    ) {
      return evidenceError(
        'MESSAGE_TRIGGER_SOURCE_MESSAGE_NOT_INCOMING',
        'The triggering message is not verified as an incoming buyer message',
      );
    }
    if (!['incoming', 'inbound'].includes(direction)) {
      return evidenceError(
        'MESSAGE_TRIGGER_SOURCE_DIRECTION_UNKNOWN',
        'The triggering message direction must be explicitly incoming',
      );
    }
    const newerMessages = messages.slice(0, messages.indexOf(sourceEntry));
    if (newerMessages.some(({ message }) => (
      ['outgoing', 'outbound'].includes(
        cleanText(message?.direction, 40).toLowerCase(),
      )
    ))) {
      return {
        ...evidenceError(
          'MESSAGE_TRIGGER_ALREADY_ANSWERED',
          'A newer explicit shop reply already follows the buyer message',
        ),
        no_action: true,
        already_answered: true,
      };
    }
  }

  if (rule.require_order_context || ORDER_CONTEXT_SCENARIOS.has(rule.scenario)) {
    const result = validateOrder(facts, conversation);
    if (!result.ok) return result;
  }

  if (rule.scenario === 'missing_materials') {
    return validateMissingMaterials(facts);
  }

  if (
    rule.scenario === 'how_to_send_files'
    && (
      facts?.order?.paid !== true
      || facts?.order?.automation_facts_verified !== true
      || !validCheckedAt(facts?.order?.paid_at)
    )
  ) {
    return evidenceError(
      'MESSAGE_TRIGGER_VERIFIED_PAID_ORDER_REQUIRED',
      'File-delivery guidance requires an exact verified paid Etsy order',
    );
  }

  if (
    rule.scenario === 'materials_sent_by_email'
    && facts?.materials?.email_claim?.checked !== true
  ) {
    return evidenceError(
      'MESSAGE_TRIGGER_EMAIL_CLAIM_CHECK_UNAVAILABLE',
      'The bounded Gmail check from the verified order payment time did not complete',
      ['verified order paid_at and on-demand Gmail check from that time'],
    );
  }

  if (rule.scenario === 'deadline_variants_sent') {
    const deadline = validateDeadline(facts);
    if (!deadline.ok) return deadline;
    const resultUrl = cleanText(facts?.variants?.result_url, 2_000);
    if (facts?.variants?.sent !== true || !/^https:\/\//i.test(resultUrl)) {
      return evidenceError(
        'MESSAGE_TRIGGER_VARIANTS_UNVERIFIED',
        'Verified variants.sent=true and an HTTPS result_url are required',
      );
    }
  }

  if (rule.scenario === 'deadline_no_materials') {
    const deadline = validateDeadline(facts);
    if (!deadline.ok) return deadline;
    const materials = validateMissingMaterials(facts);
    if (!materials.ok) return materials;
    if (facts?.shop_policy?.late_materials_allowed !== true) {
      return evidenceError(
        'MESSAGE_TRIGGER_LATE_MATERIALS_POLICY_UNVERIFIED',
        'The shop policy allowing materials after the deadline is not verified',
      );
    }
  }

  if (rule.scenario === 'review_request') {
    const confirmedReasons = [
      ...(facts?.order?.completed === false ? ['order is not completed'] : []),
      ...(facts?.order?.has_active_issue === true ? ['an active issue is present'] : []),
      ...(facts?.review?.already_requested === true
        ? ['a review was already requested']
        : []),
      ...(facts?.review?.positive_conversation_ending === false
        ? ['the conversation did not end on a positive buyer message']
        : []),
      ...(facts?.review?.lifecycle_verified === true
        && facts?.review?.lifecycle_eligible === false
        ? ['the official receipt lifecycle is not eligible']
        : []),
    ];
    if (confirmedReasons.length) {
      return confirmedNoAction(
        'MESSAGE_TRIGGER_REVIEW_NOT_ELIGIBLE',
        confirmedReasons.join('; '),
      );
    }
    const reviewGaps = [
      ...(facts?.order?.completed === true ? [] : ['completed order status']),
      ...(facts?.review?.lifecycle_verified === true
        ? []
        : ['official paid/shipped/non-refunded receipt lifecycle']),
      ...(facts?.order?.has_active_issue === false
        ? []
        : ['absence of an active issue']),
      ...(facts?.review?.already_requested === false
        ? []
        : ['absence of a prior review request']),
      ...(facts?.review?.positive_conversation_ending === true
        ? []
        : ['positive buyer ending']),
      ...(validCheckedAt(facts?.review?.checked_at)
        ? []
        : ['review evidence checked_at timestamp']),
    ];
    if (reviewGaps.length || facts?.review?.eligible !== true) {
      return evidenceError(
        'MESSAGE_TRIGGER_REVIEW_ELIGIBILITY_UNVERIFIED',
        'Completed order, positive conversation ending, no active issue and no prior review request must all be verified',
        reviewGaps,
      );
    }
  }

  return { ok: true };
}

function latestCooldownCandidate(state, candidate, nowMs) {
  const cooldownMs = (Number(candidate.rule?.cooldown_minutes) || 0) * 60_000;
  if (!cooldownMs) return null;
  return Object.values(state.candidates).find(other => (
    other.id !== candidate.id
    && other.shop_id === candidate.shop_id
    && other.conversation_id === candidate.conversation_id
    && other.rule_id === candidate.rule_id
    && other.status === 'AWAITING_APPROVAL'
    && Number.isFinite(Date.parse(other.draft_created_at))
    && nowMs - Date.parse(other.draft_created_at) < cooldownMs
  )) || null;
}

async function claimNextDueCandidate(now, candidateId) {
  return mutateState(async state => {
    const nowMs = Date.parse(now);
    const leaseMs = Math.max(
      60,
      Math.min(Number.parseInt(process.env.MESSAGE_TRIGGER_LEASE_SECONDS, 10) || 300, 3_600),
    ) * 1_000;
    const candidates = Object.values(state.candidates)
      .filter(candidate => (
        (
          candidate.status === 'PENDING'
          || candidate.status === 'RETRYABLE_ERROR'
          || (
            candidate.status === 'PROCESSING'
            && Number.isFinite(Date.parse(candidate.processing_started_at))
            && nowMs - Date.parse(candidate.processing_started_at) >= leaseMs
          )
        )
        && Date.parse(candidate.due_at) <= nowMs
        && (!candidateId || candidate.id === candidateId)
      ))
      .sort((left, right) => (
        Date.parse(left.due_at) - Date.parse(right.due_at)
        || left.id.localeCompare(right.id)
      ));
    const candidate = candidates[0];
    if (!candidate) return null;

    const cooldown = latestCooldownCandidate(state, candidate, nowMs);
    if (cooldown) {
      candidate.status = 'IGNORED_COOLDOWN';
      candidate.block_code = 'MESSAGE_TRIGGER_COOLDOWN_ACTIVE';
      candidate.block_reason = `Cooldown is active after candidate ${cooldown.id}`;
      candidate.updated_at = now;
      return { terminal: true, candidate: publicCandidate(candidate) };
    }

    candidate.status = 'PROCESSING';
    candidate.attempts = (Number(candidate.attempts) || 0) + 1;
    candidate.last_attempt_at = now;
    candidate.processing_started_at = now;
    candidate.processing_claim_token = crypto.randomUUID();
    candidate.processing_completed_at = null;
    candidate.updated_at = now;
    const event = state.events[candidate.event_key];
    return {
      terminal: false,
      now,
      candidate: JSON.parse(JSON.stringify(candidate)),
      event: JSON.parse(JSON.stringify(event)),
    };
  });
}

async function completeCandidate(candidateSnapshot, patch) {
  const candidateId = typeof candidateSnapshot === 'object'
    ? candidateSnapshot?.id
    : candidateSnapshot;
  const processingClaimToken = typeof candidateSnapshot === 'object'
    ? cleanText(candidateSnapshot?.processing_claim_token, 160)
    : '';
  const notificationClaimToken = typeof candidateSnapshot === 'object'
    ? cleanText(candidateSnapshot?.notification_claim_token, 160)
    : '';
  const debugNotificationClaimToken = typeof candidateSnapshot === 'object'
    ? cleanText(candidateSnapshot?.debug_notification_claim_token, 160)
    : '';
  if (
    !processingClaimToken
    && !notificationClaimToken
    && !debugNotificationClaimToken
  ) {
    const error = new Error('Message trigger completion requires an exact claim token');
    error.code = 'MESSAGE_TRIGGER_CLAIM_TOKEN_REQUIRED';
    error.status = 409;
    throw error;
  }
  return mutateState(async state => {
    const candidate = state.candidates[candidateId];
    if (!candidate) throw new Error('Message trigger candidate disappeared');
    if (
      processingClaimToken
      && candidate.processing_claim_token !== processingClaimToken
    ) return publicCandidate(candidate);
    if (
      notificationClaimToken
      && candidate.notification_claim_token !== notificationClaimToken
    ) return publicCandidate(candidate);
    if (
      debugNotificationClaimToken
      && candidate.debug_notification_claim_token
        !== debugNotificationClaimToken
    ) return publicCandidate(candidate);
    const completedAt = new Date().toISOString();
    Object.assign(candidate, patch, { updated_at: completedAt });
    if (
      patch?.status === 'BLOCKED'
      && needsEvidenceDebugNotification(patch?.block_code)
      && !candidate.debug_notification_status
    ) {
      candidate.debug_notification_status = 'PENDING';
      candidate.debug_notification_due_at = validCheckedAt(
        candidate.last_attempt_at,
      ) ? candidate.last_attempt_at : completedAt;
      candidate.debug_notification_attempts = 0;
    }
    if (processingClaimToken) {
      candidate.processing_claim_token = null;
      candidate.processing_completed_at = completedAt;
    }
    if (notificationClaimToken) {
      candidate.notification_claim_token = null;
      candidate.notification_completed_at = completedAt;
    }
    if (debugNotificationClaimToken) {
      candidate.debug_notification_claim_token = null;
      candidate.debug_notification_completed_at = completedAt;
    }
    return publicCandidate(candidate);
  });
}

async function claimDraftNotification(now, candidateId) {
  return mutateState(async state => {
    const nowMs = Date.parse(now);
    const candidate = Object.values(state.candidates)
      .filter(item => (
        item.status === 'AWAITING_APPROVAL'
        && (!candidateId || item.id === candidateId)
        && (
          ['PENDING', 'RETRYABLE_ERROR'].includes(item.notification_status)
          || (
            item.notification_status === 'PROCESSING'
            && Number.isFinite(Date.parse(item.notification_started_at))
            && nowMs - Date.parse(item.notification_started_at) >= 300_000
          )
        )
        && Date.parse(item.notification_due_at || item.updated_at) <= nowMs
      ))
      .sort((left, right) => (
        Date.parse(left.notification_due_at || left.updated_at)
        - Date.parse(right.notification_due_at || right.updated_at)
      ))[0];
    if (!candidate) return null;
    candidate.notification_status = 'PROCESSING';
    candidate.notification_attempts =
      (Number(candidate.notification_attempts) || 0) + 1;
    candidate.notification_started_at = now;
    candidate.notification_claim_token = crypto.randomUUID();
    candidate.notification_completed_at = null;
    candidate.updated_at = now;
    return JSON.parse(JSON.stringify(candidate));
  });
}

async function processDraftNotification(candidateId, dependencies, now) {
  const candidate = await claimDraftNotification(now, candidateId);
  if (!candidate) return null;
  const artifact = candidate.quality_artifact;
  if (
    candidate.quality_review_status !== 'APPROVED'
    || artifact?.status !== 'APPROVED'
    || artifact?.source_message_id !== candidate.source_message_id
    || artifact?.reply_sha256 !== deterministicId(candidate.draft_preview || '')
  ) {
    return completeCandidate(candidate, {
      notification_status: 'BLOCKED',
      notification_error: 'Draft quality artifact is missing or does not match',
      status: 'BLOCKED',
      block_code: 'MESSAGE_DRAFT_QUALITY_ARTIFACT_INVALID',
      block_reason: 'Telegram notification requires a matching approved quality artifact',
    });
  }
  try {
    const result = await dependencies.notifyDraftReady(candidate);
    return completeCandidate(candidate, result?.skipped
      ? {
        notification_status: 'SKIPPED',
        notification_reason: cleanText(result.reason, 300),
      }
      : {
        notification_status: 'SENT',
        notification_message_id: Number(result?.message_id) || null,
        notification_chat_id: cleanText(result?.chat_id, 120) || null,
        notified_at: new Date().toISOString(),
        notification_error: null,
      });
  } catch (error) {
    const attempts = Number(candidate.notification_attempts) || 1;
    const exhausted = attempts >= 8;
    return completeCandidate(candidate, {
      notification_status: exhausted ? 'FAILED' : 'RETRYABLE_ERROR',
      notification_error: cleanText(error?.message, 500)
        || 'Draft notification failed',
      notification_due_at: new Date(
        Date.parse(now) + Math.min(60, 2 ** (attempts - 1)) * 60_000,
      ).toISOString(),
    });
  }
}

async function claimEvidenceDebugNotification(now, candidateId) {
  return mutateState(async state => {
    const nowMs = Date.parse(now);
    const candidate = Object.values(state.candidates)
      .filter(item => (
        item.status === 'BLOCKED'
        && (!candidateId || item.id === candidateId)
        && (
          ['PENDING', 'RETRYABLE_ERROR'].includes(
            item.debug_notification_status,
          )
          || (
            item.debug_notification_status === 'PROCESSING'
            && Number.isFinite(Date.parse(item.debug_notification_started_at))
            && nowMs - Date.parse(item.debug_notification_started_at) >= 300_000
          )
        )
        && Date.parse(
          item.debug_notification_due_at || item.updated_at,
        ) <= nowMs
      ))
      .sort((left, right) => (
        Date.parse(left.debug_notification_due_at || left.updated_at)
        - Date.parse(right.debug_notification_due_at || right.updated_at)
      ))[0];
    if (!candidate) return null;
    candidate.debug_notification_status = 'PROCESSING';
    candidate.debug_notification_attempts =
      (Number(candidate.debug_notification_attempts) || 0) + 1;
    candidate.debug_notification_started_at = now;
    candidate.debug_notification_claim_token = crypto.randomUUID();
    candidate.debug_notification_completed_at = null;
    candidate.updated_at = now;
    return JSON.parse(JSON.stringify(candidate));
  });
}

async function processEvidenceDebugNotification(candidateId, dependencies, now) {
  const candidate = await claimEvidenceDebugNotification(now, candidateId);
  if (!candidate) return null;
  try {
    const result = await dependencies.notifyEvidenceBlocked(candidate);
    return completeCandidate(candidate, result?.skipped
      ? {
        debug_notification_status: 'SKIPPED',
        debug_notification_reason: cleanText(result.reason, 300),
      }
      : {
        debug_notification_status: 'SENT',
        debug_notification_message_id: Number(result?.message_id) || null,
        debug_notification_chat_id: cleanText(result?.chat_id, 120) || null,
        debug_notified_at: new Date().toISOString(),
        debug_notification_error: null,
      });
  } catch (error) {
    const attempts = Number(candidate.debug_notification_attempts) || 1;
    const exhausted = attempts >= 8;
    return completeCandidate(candidate, {
      debug_notification_status: exhausted ? 'FAILED' : 'RETRYABLE_ERROR',
      debug_notification_error: cleanText(error?.message, 500)
        || 'Evidence debug notification failed',
      debug_notification_due_at: new Date(
        Date.parse(now) + Math.min(60, 2 ** (attempts - 1)) * 60_000,
      ).toISOString(),
    });
  }
}

async function selectCandidateRule(candidateSnapshot, route, now) {
  const candidateId = candidateSnapshot?.id;
  const processingClaimToken = cleanText(
    candidateSnapshot?.processing_claim_token,
    160,
  );
  if (!processingClaimToken) {
    const error = new Error('Message trigger routing requires an exact processing claim token');
    error.code = 'MESSAGE_TRIGGER_CLAIM_TOKEN_REQUIRED';
    error.status = 409;
    throw error;
  }
  return mutateState(async state => {
    const candidate = state.candidates[candidateId];
    if (!candidate) throw new Error('Message trigger candidate disappeared');
    if (
      processingClaimToken
      && candidate.processing_claim_token !== processingClaimToken
    ) return { terminal: true, candidate: publicCandidate(candidate), stale: true };
    if (route.decision === 'no_action') {
      Object.assign(candidate, {
        status: 'IGNORED_NO_ACTION',
        block_code: 'MESSAGE_TRIGGER_NO_ACTION',
        block_reason: route.rationale,
        router_confidence: route.confidence,
        router_rationale: route.rationale,
        last_error: null,
        processing_claim_token: null,
        processing_completed_at: new Date().toISOString(),
        updated_at: now,
      });
      return { terminal: true, candidate: publicCandidate(candidate) };
    }
    const selected = candidate.rules?.find(rule => rule.id === route.rule_id);
    if (!selected) throw new Error('Selected message trigger rule disappeared');
    candidate.rule_id = selected.id;
    candidate.scenario = selected.scenario;
    candidate.rule = selected;
    candidate.router_confidence = route.confidence;
    candidate.router_rationale = route.rationale;
    candidate.due_at = new Date(
      Date.parse(state.events[candidate.event_key].occurred_at)
      + selected.delay_minutes * 60_000,
    ).toISOString();

    const cooldown = latestCooldownCandidate(state, candidate, Date.parse(now));
    if (cooldown) {
      Object.assign(candidate, {
        status: 'IGNORED_COOLDOWN',
        block_code: 'MESSAGE_TRIGGER_COOLDOWN_ACTIVE',
        block_reason: `Cooldown is active after candidate ${cooldown.id}`,
        updated_at: now,
      });
      return { terminal: true, candidate: publicCandidate(candidate) };
    }
    if (Date.parse(candidate.due_at) > Date.parse(now)) {
      candidate.status = 'PENDING';
      candidate.updated_at = now;
      return { terminal: true, candidate: publicCandidate(candidate) };
    }
    candidate.status = 'PROCESSING';
    candidate.updated_at = now;
    return {
      terminal: false,
      candidate: JSON.parse(JSON.stringify(candidate)),
      event: JSON.parse(JSON.stringify(state.events[candidate.event_key])),
    };
  });
}

function defaultDependencies(overrides = {}) {
  return {
    syncConversation: async conversationId => bridgeRequest(
      `/v1/conversations/${conversationId}/history/sync?wait=true&full=false`,
      { method: 'POST', timeoutMs: 180_000 },
    ),
    loadConversation: async conversationId => {
      const bundle = await getMessageConversationForAgent(conversationId);
      return {
        ...bundle.conversation,
        messages: bundle.messages,
      };
    },
    loadPlaybook: loadMessagePlaybook,
    classifyNewMessage: classifyNewMessageScenario,
    loadListingFacts: loadVerifiedListingFactsForConversation,
    loadOrderListingFacts: loadVerifiedListingFactsForExactOrder,
    loadOrderFacts: loadVerifiedOrderFactsForConversation,
    loadShopStyleReference: loadShopSellerStyleReference,
    loadLearningExamples: loadMessageLearningExamples,
    captureLearningProposal: captureMessageLearningProposal,
    notifyDraftReady: notifyMessageDraftReady,
    notifyEvidenceBlocked: notifyMessageEvidenceBlocked,
    generateDraft: generateMessageDraft,
    createDraft: async ({
      candidate,
      event,
      generated,
      learnedExamples,
      playbookRevision,
      conversation,
    }) => {
      const head = conversationHeadMessage(conversation);
      return bridgePost('/v1/outbox/drafts', {
        conversation_id: candidate.conversation_id,
        body: generated.reply_body,
        scenario: candidate.scenario,
        reason: generated.rationale,
        metadata: {
          generator: 'message_trigger_runner',
          trigger_candidate_id: candidate.id,
          trigger_event_id: candidate.event_id,
          trigger_rule_id: candidate.rule_id,
          playbook_revision: playbookRevision,
          confidence: generated.confidence,
          facts_used: generated.facts_used,
          warnings: generated.warnings,
          generation: generated.generation || null,
          dashboard_shop_id: candidate.shop_id,
          learned_example_ids: (Array.isArray(learnedExamples)
            ? learnedExamples
            : []).map(example => example.id).filter(Boolean),
          quality_artifact: generated.quality_artifact || null,
          source_message_id: event.source_message_id || null,
          conversation_head_message_id:
            cleanText(head?.source_id || head?.id, 160) || null,
          conversation_head_direction:
            cleanText(head?.direction, 40).toLowerCase() || null,
          evidence_digest: deterministicId(
            JSON.stringify(event.verified_facts || {}),
            JSON.stringify(event.rule_evidence || {}),
          ),
        },
        created_by: 'message-trigger-runner',
        submit_for_approval: true,
      }, {
        'Idempotency-Key': `trigger-draft-${candidate.id}`.slice(0, 128),
      });
    },
    ...overrides,
  };
}

async function enrichFreeformFactsBestEffort({ event, conversation, deps }) {
  let verifiedFacts = {
    ...(event?.verified_facts && typeof event.verified_facts === 'object'
      ? event.verified_facts
      : {}),
  };
  const linkedReceiptIds = conversationReceiptIds(conversation);
  const explicitReceiptId = cleanText(verifiedFacts?.order?.receipt_id, 160);
  const receiptIds = new Set([
    ...linkedReceiptIds,
    ...(explicitReceiptId ? [explicitReceiptId] : []),
  ]);

  let exactOrderFacts = null;
  if (orderLinkingReleased() && receiptIds.size === 1) {
    const receiptId = [...receiptIds][0];
    try {
      exactOrderFacts = await deps.loadOrderFacts({
        receiptId,
        bridgeConversation: conversation,
      });
      verifiedFacts = {
        ...verifiedFacts,
        ...exactOrderFacts,
      };
    } catch {
      // Freeform enrichment is optional. A transient evidence source failure
      // must not turn an otherwise answerable buyer message into a hard block.
    }
  }

  if (exactOrderFacts) {
    try {
      const listingContext = await deps.loadOrderListingFacts({
        verifiedOrderFacts: exactOrderFacts,
      });
      if (listingContext?.listing) {
        verifiedFacts.listing = listingContext.listing;
        verifiedFacts.listing_context = {
          exact_reference_available: true,
          unavailable_reason: null,
        };
      }
    } catch {
      // Keep verified order facts even when optional listing enrichment fails.
    }
  }

  if (!verifiedFacts.listing) {
    try {
      const listingContext = await deps.loadListingFacts({
        conversation,
        sourceMessageId: event?.source_message_id,
      });
      if (listingContext?.listing) {
        verifiedFacts.listing = listingContext.listing;
        verifiedFacts.listing_context = {
          exact_reference_available: true,
          unavailable_reason: null,
        };
      }
    } catch {
      // Conversation/listing context is useful but not mandatory for freeform.
    }
  }

  return {
    ...event,
    verified_facts: verifiedFacts,
  };
}

async function processClaim(claim, dependencies) {
  if (claim.terminal) return claim.candidate;
  let { candidate, event } = claim;
  let conversation = null;
  const deps = defaultDependencies(dependencies);

  try {
    if (event.type === 'new_message') {
      await deps.syncConversation(candidate.conversation_id);
    }
    conversation = await deps.loadConversation(candidate.conversation_id);
    if (event.type === 'new_message' && !candidate.rule_id) {
      const sourceEvidence = validateMessageTriggerEvidence(
        { ...candidate, rule: {} },
        event,
        conversation,
      );
      if (!sourceEvidence.ok) {
        return completeCandidate(candidate, {
          status: sourceEvidence.no_action ? 'IGNORED_NO_ACTION' : 'BLOCKED',
          block_code: sourceEvidence.code,
          block_reason: sourceEvidence.reason,
          evidence_gaps: sourceEvidence.evidence_gaps || [],
          participant: cleanText(
            conversation?.participant || conversation?.title,
            300,
          ) || null,
          last_error: null,
        });
      }
      const routerPlaybook = await deps.loadPlaybook(candidate.shop_id);
      const route = await deps.classifyNewMessage({
        conversation,
        sourceMessageId: event.source_message_id,
        rules: candidate.rules,
        playbook: routerPlaybook.playbook,
      });
      const selected = await selectCandidateRule(
        candidate,
        route,
        claim.now || new Date().toISOString(),
      );
      if (selected.terminal) return selected.candidate;
      candidate = selected.candidate;
      event = selected.event;
    }
    if (
      (candidate.rule?.require_order_context
        || ORDER_CONTEXT_SCENARIOS.has(candidate.scenario))
      && !orderLinkingReleased()
    ) {
      return completeCandidate(candidate, {
        status: 'BLOCKED',
        block_code: 'MESSAGE_TRIGGER_ORDER_LINKING_DISABLED',
        block_reason: 'Order-linked message triggers are not released',
        last_error: null,
      });
    }
    if (
      candidate.rule?.require_order_context
      || ORDER_CONTEXT_SCENARIOS.has(candidate.scenario)
    ) {
      const linkedReceiptIds = conversationReceiptIds(conversation);
      if (
        ['how_to_send_files', 'materials_sent_by_email'].includes(candidate.scenario)
        && linkedReceiptIds.size !== 1
      ) {
        return completeCandidate(candidate, {
          status: 'BLOCKED',
          block_code: 'MESSAGE_TRIGGER_EXACT_RECEIPT_REQUIRED',
          block_reason: (
            'File-delivery guidance requires exactly one Etsy receipt linked '
            + 'to this conversation'
          ),
          last_error: null,
        });
      }
      const receiptId = cleanText(
        event.verified_facts?.order?.receipt_id,
        160,
      ) || [...linkedReceiptIds][0];
      if (!receiptId) {
        return completeCandidate(candidate, {
          status: 'BLOCKED',
          block_code: 'MESSAGE_TRIGGER_RECEIPT_UNAVAILABLE',
          block_reason: 'No exact Etsy receipt_id is linked to this conversation',
          last_error: null,
        });
      }
      const verifiedOrderFacts = await deps.loadOrderFacts({
        receiptId,
        bridgeConversation: conversation,
        ...(candidate.scenario === 'materials_sent_by_email'
          ? { checkEmailClaim: true }
          : {}),
      });
      if (['how_to_send_files', 'materials_sent_by_email'].includes(candidate.scenario)) {
        const listingContext = await deps.loadOrderListingFacts({
          verifiedOrderFacts,
        });
        verifiedOrderFacts.listing = listingContext?.listing || null;
        verifiedOrderFacts.listing_context = {
          exact_reference_available: Boolean(listingContext?.listing),
          unavailable_reason:
            cleanText(listingContext?.unavailable_reason, 500) || null,
        };
      }
      if (candidate.scenario === 'review_request') {
        const state = await readState();
        const priorSent = Object.values(state.candidates).some(other => (
          other.id !== candidate.id
          && other.shop_id === candidate.shop_id
          && other.conversation_id === candidate.conversation_id
          && other.scenario === 'review_request'
          && other.status === 'SENT'
        ));
        if (priorSent) {
          verifiedOrderFacts.review = {
            ...(verifiedOrderFacts.review || {}),
            eligible: false,
            already_requested: true,
            checked_at: new Date().toISOString(),
            reason: 'prior_sent_review_request_candidate',
          };
        }
      }
      event = {
        ...event,
        verified_facts: {
          ...(event.verified_facts || {}),
          ...verifiedOrderFacts,
        },
      };
    }
    if (candidate.scenario === 'freeform') {
      event = await enrichFreeformFactsBestEffort({
        event,
        conversation,
        deps,
      });
    }
    if (candidate.scenario === 'how_to_order') {
      const listingContext = await deps.loadListingFacts({
        conversation,
        sourceMessageId: event.source_message_id,
      });
      event = {
        ...event,
        verified_facts: {
          ...(event.verified_facts || {}),
          listing: listingContext?.listing || null,
          listing_context: {
            exact_reference_available: Boolean(listingContext?.listing),
            unavailable_reason:
              cleanText(listingContext?.unavailable_reason, 500) || null,
          },
        },
      };
    }
    const evidence = validateMessageTriggerEvidence(candidate, event, conversation);
    if (!evidence.ok) {
      return completeCandidate(candidate, {
        status: evidence.no_action ? 'IGNORED_NO_ACTION' : 'BLOCKED',
        block_code: evidence.code,
        block_reason: evidence.reason,
        evidence_gaps: evidence.evidence_gaps || [],
        participant: cleanText(
          conversation?.participant || conversation?.title,
          300,
        ) || null,
        receipt_id: cleanText(
          event.verified_facts?.order?.receipt_id,
          160,
        ) || null,
        last_error: null,
      });
    }

    const playbookState = await deps.loadPlaybook(candidate.shop_id);
    if (playbookState?.playbook?.scenarios?.[candidate.scenario]?.enabled !== true) {
      return completeCandidate(candidate, {
        status: 'BLOCKED',
        block_code: 'MESSAGE_SCENARIO_DISABLED',
        block_reason: `Scenario is disabled in Agent Playbook: ${candidate.scenario}`,
        last_error: null,
      });
    }

    const sellerStyleReference = await deps.loadShopStyleReference(candidate.shop_id);
    const learnedExamples = await deps.loadLearningExamples({
      shopId: candidate.shop_id,
      scenario: candidate.scenario,
      conversation,
      sourceMessageId: event.source_message_id,
    });
    const generated = await deps.generateDraft({
      scenario: candidate.scenario,
      conversation,
      ownerNotes: candidate.rule.owner_notes,
      verifiedFacts: event.verified_facts,
      playbook: playbookState.playbook,
      account: null,
      sourceMessageId: event.source_message_id,
      sellerStyleReference,
      learnedExamples,
    });
    if (generated?.status === 'no_action') {
      return completeCandidate(candidate, {
        status: 'IGNORED_NO_ACTION',
        block_code: 'MESSAGE_DRAFT_NO_ACTION',
        block_reason: cleanText(generated?.block_reason, 1_500)
          || 'The latest buyer message does not need a shop response',
        last_error: null,
      });
    }
    if (generated?.status !== 'ready' || !cleanText(generated?.reply_body, 10_000)) {
      return completeCandidate(candidate, {
        status: 'BLOCKED',
        block_code: 'MESSAGE_DRAFT_BLOCKED',
        block_reason: cleanText(generated?.block_reason, 1_500)
          || 'The drafting agent did not produce a safe ready draft',
        last_error: null,
      });
    }
    if (generated.requires_human_approval !== true) {
      return completeCandidate(candidate, {
        status: 'BLOCKED',
        block_code: 'MESSAGE_DRAFT_APPROVAL_REQUIREMENT_MISSING',
        block_reason: 'The generated result omitted the human approval requirement',
        last_error: null,
      });
    }
    if (generated?.quality_review?.approved !== true) {
      return completeCandidate(candidate, {
        status: 'BLOCKED',
        block_code: 'MESSAGE_DRAFT_QUALITY_REJECTED',
        block_reason: cleanText(
          generated?.quality_review?.rationale,
          1_500,
        ) || 'Independent quality review did not approve the draft',
        last_error: null,
      });
    }

    const evidenceDigest = deterministicId(
      JSON.stringify(event.verified_facts || {}),
      JSON.stringify(event.rule_evidence || {}),
    );
    const qualityArtifact = {
      validator_version: 'message-draft-quality-v1',
      status: 'APPROVED',
      source_message_id: event.source_message_id || null,
      reply_sha256: deterministicId(generated.reply_body),
      evidence_digest: evidenceDigest,
      confidence: generated.quality_review.confidence,
      rationale: cleanText(generated.quality_review.rationale, 1_500),
    };
    generated.quality_artifact = qualityArtifact;

    const draft = await deps.createDraft({
      candidate,
      event,
      generated,
      learnedExamples,
      playbookRevision: Number(playbookState?.revision) || 0,
      conversation,
    });
    await deps.captureLearningProposal({
      shopId: candidate.shop_id,
      draft,
      generated,
      scenario: candidate.scenario,
      conversation,
      sourceMessageId: event.source_message_id,
      playbookRevision: Number(playbookState?.revision) || 0,
      candidateId: candidate.id,
      eventId: candidate.event_id,
      ruleId: candidate.rule_id,
      evidenceDigest,
      createdBy: 'message-trigger-runner',
    });
    const sourceMessage = messageChronology(conversation?.messages)
      .map(entry => entry.message)
      .find(message => (
        cleanText(message?.source_id || message?.id, 160)
          === cleanText(event.source_message_id, 160)
      ))
      || messageChronology(conversation?.messages)
        .map(entry => entry.message)
        .find(message => (
          ['incoming', 'inbound'].includes(
            cleanText(message?.direction, 40).toLowerCase(),
          )
          && cleanText(message?.body, 1_000)
        ))
      || null;
    const completed = await completeCandidate(candidate, {
      status: 'AWAITING_APPROVAL',
      draft_id: cleanText(draft?.id, 160) || null,
      draft_created_at: new Date().toISOString(),
      participant: cleanText(
        conversation?.participant || conversation?.title,
        300,
      ) || null,
      receipt_id: cleanText(
        event.verified_facts?.order?.receipt_id,
        160,
      ) || null,
      deadline_at: cleanText(
        event.verified_facts?.deadline?.due_at,
        80,
      ) || null,
      source_message_preview:
        cleanText(sourceMessage?.body, 700) || null,
      buyer_message_preview:
        cleanText(sourceMessage?.body, 700) || null,
      recent_conversation: notificationConversationPreview(conversation),
      draft_preview: cleanText(generated.reply_body, 1_000) || null,
      draft_reason: cleanText(generated.rationale, 500) || null,
      source_message_id: event.source_message_id || null,
      quality_review_status: 'APPROVED',
      quality_artifact: qualityArtifact,
      notification_status: 'PENDING',
      notification_due_at: claim.now || new Date().toISOString(),
      notification_attempts: 0,
      block_code: null,
      block_reason: null,
      last_error: null,
    });
    return await processDraftNotification(
      candidate.id,
      deps,
      claim.now || new Date().toISOString(),
    ) || completed;
  } catch (error) {
    if (
      Number(error?.status) >= 400
      && Number(error?.status) < 500
    ) {
      return completeCandidate(candidate, {
        status: 'BLOCKED',
        block_code: cleanText(error?.code, 160)
          || 'MESSAGE_TRIGGER_PERMANENT_ERROR',
        block_reason: cleanText(error?.message, 1_500)
          || 'Trigger processing requires operator review',
        evidence_gaps: [
          cleanText(error?.message, 300)
            || 'The required upstream evidence could not be loaded',
        ],
        participant: cleanText(
          conversation?.participant || conversation?.title,
          300,
        ) || null,
        receipt_id: cleanText(
          event?.verified_facts?.order?.receipt_id,
          160,
        ) || null,
        last_error: null,
      });
    }
    const attempts = Number(candidate.attempts) || 1;
    if (attempts >= 8) {
      return completeCandidate(candidate, {
        status: 'BLOCKED',
        block_code: 'MESSAGE_TRIGGER_RETRY_EXHAUSTED',
        block_reason: 'Trigger processing failed repeatedly and requires operator review',
        last_error: cleanText(error?.message || 'Trigger processing failed', 1_500),
      });
    }
    const retryDelayMinutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
    return completeCandidate(candidate, {
      status: 'RETRYABLE_ERROR',
      last_error: cleanText(error?.message || 'Trigger processing failed', 1_500),
      due_at: new Date(
        Date.parse(claim.now || new Date().toISOString())
        + retryDelayMinutes * 60_000,
      ).toISOString(),
    });
  }
}

export async function runDueMessageTriggerCandidates(
  { now = new Date().toISOString(), limit = 10, candidate_id: candidateId } = {},
  dependencies = {},
) {
  assertRunnerEnabled();
  const normalizedNow = validIsoDate(now, 'now');
  const boundedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 50));
  const results = [];
  for (let index = 0; index < boundedLimit; index += 1) {
    const claim = await claimNextDueCandidate(normalizedNow, cleanText(candidateId, 80));
    if (!claim) break;
    results.push(await processClaim(claim, dependencies));
    if (candidateId) break;
  }
  const deps = defaultDependencies(dependencies);
  const notifications = [];
  for (let index = 0; index < boundedLimit; index += 1) {
    const notification = await processDraftNotification(
      null,
      deps,
      normalizedNow,
    );
    if (!notification) break;
    notifications.push(notification);
  }
  const debugNotifications = [];
  for (let index = 0; index < boundedLimit; index += 1) {
    const notification = await processEvidenceDebugNotification(
      null,
      deps,
      normalizedNow,
    );
    if (!notification) break;
    debugNotifications.push(notification);
  }
  return {
    processed: results.length,
    candidates: results,
    notifications_processed: notifications.length,
    notifications,
    debug_notifications_processed: debugNotifications.length,
    debug_notifications: debugNotifications,
  };
}

export async function getMessageTriggerStatus({
  shop_id: shopId,
  conversation_id: conversationId,
  limit = 100,
} = {}) {
  const state = await readState();
  const items = Object.values(state.candidates)
    .filter(candidate => (
      (!shopId || candidate.shop_id === String(shopId))
      && (!conversationId || candidate.conversation_id === String(conversationId))
    ))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500)))
    .map(publicCandidate);
  return {
    enabled: runnerEnabled(),
    universal_assistant_enabled: messageUniversalAssistantEnabled(),
    delivery_mode: 'draft_only',
    human_approval_required: true,
    counts: items.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {}),
    items,
  };
}

export function messageTriggerRunnerAvailable() {
  return {
    available: true,
    enabled: runnerEnabled(),
    universal_assistant_enabled: messageUniversalAssistantEnabled(),
    delivery_mode: 'draft_only',
    human_approval_required: true,
  };
}

export async function hydrateNewMessageTriggerEvent(value = {}, dependencies = {}) {
  assertRunnerEnabled();
  const shopId = numericId(value.shop_id, 'shop_id');
  const conversationId = numericId(value.conversation_id, 'conversation_id');
  const eventId = cleanText(value.event_id, 160);
  if (!eventId) {
    const error = new Error('event_id is required');
    error.status = 400;
    error.code = 'MESSAGE_TRIGGER_INVALID_EVENT';
    throw error;
  }
  const eventKey = deterministicId(shopId, eventId);
  const stateBeforeSync = await readState();
  const existing = stateBeforeSync.events[eventKey];
  if (existing) {
    return {
      event: {
        event_id: existing.event_id,
        type: existing.type,
        shop_id: existing.shop_id,
        conversation_id: existing.conversation_id,
        source_message_id: existing.source_message_id,
        occurred_at: existing.occurred_at,
        verified_facts: existing.verified_facts,
        rule_evidence: existing.rule_evidence,
        source: existing.source,
      },
      duplicate: true,
      no_action: false,
    };
  }

  const syncConversation = dependencies.syncConversation
    || (async id => bridgeRequest(
      `/v1/conversations/${id}/history/sync?wait=true&full=false`,
      { method: 'POST', timeoutMs: 180_000 },
    ));
  const loadConversation = dependencies.loadConversation
    || (async id => {
      const bundle = await getMessageConversationForAgent(id);
      return { ...bundle.conversation, messages: bundle.messages };
    });
  await syncConversation(conversationId);
  const conversation = await loadConversation(conversationId);
  const reconcileLearning = dependencies.reconcileLearning
    || reconcileObservedManualRepliesForConversation;
  try {
    await reconcileLearning({
      shopId,
      conversationId,
      conversation,
    });
  } catch (error) {
    console.error('[messages-learning] cached manual reply reconciliation failed', {
      shop_id: shopId,
      conversation_id: conversationId,
      code: cleanText(error?.code || error?.message, 200)
        || 'MESSAGE_LEARNING_RECONCILE_FAILED',
    });
  }
  const messages = messageChronology(conversation?.messages);
  const incoming = messages.filter(({ message }) => {
    const direction = cleanText(message?.direction, 40).toLowerCase();
    return ['incoming', 'inbound'].includes(direction)
      && cleanText(message?.source_id || message?.id, 160);
  });
  const newestEntry = incoming[0];
  const newest = newestEntry?.message;
  if (!newest) {
    return {
      event: null,
      duplicate: false,
      no_action: true,
      reason: 'No explicit incoming buyer message exists after conversation sync',
    };
  }
  const newestSender = cleanText(newest?.sender, 80).toLowerCase();
  if (['self', 'shop', 'seller', 'you'].includes(newestSender)) {
    return {
      event: null,
      duplicate: false,
      no_action: true,
      reason: 'Newest incoming-labelled message has an inconsistent seller sender',
    };
  }
  const newerMessages = messages.slice(0, messages.indexOf(newestEntry));
  for (const { message } of newerMessages) {
    const direction = cleanText(message?.direction, 40).toLowerCase();
    if (['outgoing', 'outbound'].includes(direction)) {
      return {
        event: null,
        duplicate: false,
        no_action: true,
        already_answered: true,
        reason: 'A newer explicit shop reply already follows the buyer message',
      };
    }
    if (!['incoming', 'inbound', 'system'].includes(direction)) {
      return {
        event: null,
        duplicate: false,
        no_action: true,
        reason: 'A newer message has unknown direction; hydration failed closed',
      };
    }
  }
  const sourceMessageId = cleanText(newest.source_id || newest.id, 160);
  const alreadyUsed = Object.values(stateBeforeSync.events).some(event => (
    event.shop_id === shopId
    && event.conversation_id === conversationId
    && event.source_message_id === sourceMessageId
  ));
  if (alreadyUsed) {
    return {
      event: null,
      duplicate: true,
      no_action: true,
      reason: 'The newest incoming buyer message was already ingested',
    };
  }
  return {
    event: {
      ...value,
      event_id: eventId,
      type: 'new_message',
      shop_id: shopId,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
      occurred_at: value.occurred_at || newest.sent_at || new Date().toISOString(),
    },
    duplicate: false,
    no_action: false,
  };
}

export async function lookupExactOrderConversationLink(
  receiptId,
  dependencies = {},
) {
  const id = numericId(receiptId, 'receipt_id');
  const request = dependencies.bridgeCall || bridgeRequest;
  let link;
  try {
    link = await request(`/v1/order-links/${id}`);
  } catch (error) {
    if (Number(error?.bridge_status || error?.status) !== 404) throw error;
    link = await request(`/v1/order-links/${id}/resolve`, {
      method: 'POST',
      timeoutMs: 45_000,
    });
  }
  const conversationId = numericId(
    link?.conversation_id,
    'conversation_id',
  );
  await request(
    `/v1/conversations/${conversationId}/history/sync?wait=true`,
    {
      method: 'POST',
      timeoutMs: 180_000,
    },
  );
  return link;
}

export async function hydrateOrderLinkedTriggerEvent(value = {}, dependencies = {}) {
  const type = cleanText(value.type || value.event, 80);
  if (type === 'new_message') return { event: value, hydrated: false };
  const receiptId = numericId(
    value.receipt_id || value.verified_facts?.order?.receipt_id,
    'receipt_id',
  );
  const lookup = dependencies.lookupOrderLink
    || (async id => lookupExactOrderConversationLink(id, dependencies));
  const link = await lookup(receiptId);
  const exactMatches = new Set([
    'exact_etsy_system_message',
    'exact_etsy_order_page_dom',
    'exact_etsy_order_page_network',
    'authenticated_etsy_email_subject',
  ]);
  if (
    !exactMatches.has(link?.match)
    || String(link?.receipt_id || receiptId) !== receiptId
  ) {
    const error = new Error('Bridge did not return an exact Etsy receipt link');
    error.status = 409;
    error.code = 'MESSAGE_TRIGGER_ORDER_LINK_UNVERIFIED';
    throw error;
  }
  const linkedConversationId = numericId(
    link.conversation_id,
    'conversation_id',
  );
  const suppliedConversationId = value.conversation_id
    ? numericId(value.conversation_id, 'conversation_id')
    : null;
  if (
    suppliedConversationId
    && suppliedConversationId !== linkedConversationId
  ) {
    const error = new Error(
      'Supplied conversation_id does not match the exact Etsy receipt link',
    );
    error.status = 409;
    error.code = 'MESSAGE_TRIGGER_ORDER_CONVERSATION_MISMATCH';
    throw error;
  }
  return {
    event: {
      ...value,
      conversation_id: linkedConversationId,
      verified_facts: {
        ...(value.verified_facts || {}),
        order: {
          ...(value.verified_facts?.order || {}),
          receipt_id: receiptId,
        },
      },
    },
    hydrated: true,
    receipt_id: receiptId,
    match: link.match,
  };
}
