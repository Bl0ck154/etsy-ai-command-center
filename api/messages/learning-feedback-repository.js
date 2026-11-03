import crypto from 'node:crypto';
import path from 'node:path';

import { createMessageRevisionedStoreRepository } from './revisioned-store-repository.js';

export const MESSAGE_LEARNING_FEEDBACK_RECORD_TYPE = 'message_learning_feedback_store';
export const MESSAGE_LEARNING_FEEDBACK_SCHEMA_VERSION = 1;

const DELIVERY_STATUSES = new Set([
  'SENT',
  'UNKNOWN',
  'FAILED',
  'STALE',
  'SKIPPED',
  'CANCELLED',
]);
const TELEGRAM_RATINGS = new Set(['helpful', 'unhelpful']);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function repositoryError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function optionalText(value, maxLength) {
  const text = cleanText(value, maxLength);
  return text || null;
}

function exactBody(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw repositoryError(`${field} is required`, 'MESSAGE_LEARNING_BODY_REQUIRED');
  }
  if (value.length > 20_000) {
    throw repositoryError(`${field} exceeds 20000 characters`, 'MESSAGE_LEARNING_BODY_TOO_LONG');
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeShopId(value) {
  const id = String(value ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw repositoryError('A numeric Etsy shop ID is required', 'MESSAGE_LEARNING_SHOP_REQUIRED');
  }
  return id;
}

function normalizeIdentifier(value, field) {
  const identifier = cleanText(value, 240);
  if (!identifier) return null;
  if (!/^[A-Za-z0-9._:@/-]+$/.test(identifier)) {
    throw repositoryError(`${field} contains unsupported characters`, 'MESSAGE_LEARNING_IDENTIFIER_INVALID');
  }
  return identifier;
}

function normalizeScenario(value) {
  return cleanText(value, 80) || 'freeform';
}

function normalizeTimestamp(value, fallback, field) {
  const timestamp = value == null ? fallback : String(value);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw repositoryError(`${field} must be an ISO timestamp`, 'MESSAGE_LEARNING_TIMESTAMP_INVALID');
  }
  return new Date(timestamp).toISOString();
}

function normalizeProvenance(value = {}) {
  if (!isObject(value)) return {};
  const finalProvider = isObject(value.final_provider ?? value.finalProvider)
    ? (value.final_provider ?? value.finalProvider)
    : {};
  const normalized = {
    provider: optionalText(
      value.provider ?? finalProvider.provider_id ?? finalProvider.providerId ?? finalProvider.id,
      120,
    ),
    model: optionalText(value.model ?? finalProvider.model, 160),
    prompt_version: optionalText(value.prompt_version ?? value.promptVersion, 120),
    response_schema_version: optionalText(
      value.response_schema_version ?? value.responseSchemaVersion,
      120,
    ),
    playbook_revision: Number.isInteger(Number(value.playbook_revision ?? value.playbookRevision))
      ? Number(value.playbook_revision ?? value.playbookRevision)
      : null,
    playbook_digest: optionalText(value.playbook_digest ?? value.playbookDigest, 128),
    evidence_digest: optionalText(value.evidence_digest ?? value.evidenceDigest, 128),
    context_digest: optionalText(value.context_digest ?? value.contextDigest, 128),
    learned_example_count: Number.isInteger(
      Number(value.learned_example_count ?? value.learnedExampleCount),
    )
      ? Number(value.learned_example_count ?? value.learnedExampleCount)
      : null,
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, item]) => item !== null));
}

function identityKeys({ draftId, candidateId }) {
  const keys = [];
  if (draftId) keys.push(`draft:${draftId}`);
  if (candidateId) keys.push(`candidate:${candidateId}`);
  if (!keys.length) {
    throw repositoryError(
      'A draft ID or candidate ID is required',
      'MESSAGE_LEARNING_IDENTITY_REQUIRED',
    );
  }
  return keys;
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isValidOutcome(outcome) {
  if (outcome === null) return true;
  return isObject(outcome)
    && DELIVERY_STATUSES.has(outcome.status)
    && typeof outcome.label === 'string'
    && isIsoTimestamp(outcome.resolved_at)
    && (outcome.final_body === null || typeof outcome.final_body === 'string')
    && (outcome.final_body_sha256 === null || /^[a-f0-9]{64}$/.test(outcome.final_body_sha256));
}

function isValidFeedback(feedback) {
  return isObject(feedback)
    && Array.isArray(feedback.events)
    && feedback.events.length <= 20
    && feedback.events.every(event => (
      isObject(event)
      && TELEGRAM_RATINGS.has(event.rating)
      && typeof event.event_id === 'string'
      && isIsoTimestamp(event.recorded_at)
    ))
    && (feedback.latest === null || (
      isObject(feedback.latest)
      && TELEGRAM_RATINGS.has(feedback.latest.rating)
      && typeof feedback.latest.event_id === 'string'
      && isIsoTimestamp(feedback.latest.recorded_at)
    ));
}

function isValidEntry(entry) {
  return isObject(entry)
    && typeof entry.id === 'string'
    && /^\d+$/.test(entry.shop_id)
    && Array.isArray(entry.identity_keys)
    && entry.identity_keys.length > 0
    && entry.identity_keys.every(key => typeof key === 'string')
    && typeof entry.scenario === 'string'
    && typeof entry.proposed_body === 'string'
    && /^[a-f0-9]{64}$/.test(entry.proposed_body_sha256)
    && sha256(entry.proposed_body) === entry.proposed_body_sha256
    && isIsoTimestamp(entry.proposal_created_at)
    && isIsoTimestamp(entry.created_at)
    && isIsoTimestamp(entry.updated_at)
    && Number.isInteger(entry.activity_sequence)
    && entry.activity_sequence > 0
    && isObject(entry.provenance)
    && isValidOutcome(entry.outcome)
    && isValidFeedback(entry.feedback);
}

function isValidShopRecord(record) {
  return isObject(record)
    && Number.isInteger(record.revision)
    && record.revision > 0
    && isIsoTimestamp(record.updated_at)
    && Array.isArray(record.entries)
    && record.entries.every(isValidEntry);
}

function entryActivity(entry) {
  return Date.parse(entry.updated_at || entry.created_at || 0) || 0;
}

function retainNewest(entries, maximum) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (
      entryActivity(right.entry) - entryActivity(left.entry)
      || right.entry.activity_sequence - left.entry.activity_sequence
      || right.index - left.index
    ))
    .slice(0, maximum)
    .map(item => item.entry);
}

function findEntry(entries, { recordId, draftId, candidateId }) {
  const keys = [];
  if (draftId) keys.push(`draft:${draftId}`);
  if (candidateId) keys.push(`candidate:${candidateId}`);
  const matches = entries.filter(entry => (
    (recordId && entry.id === recordId)
    || keys.some(key => entry.identity_keys.includes(key))
  ));
  const unique = [...new Set(matches)];
  if (unique.length > 1) {
    throw repositoryError(
      'Message learning identifiers resolve to different records',
      'MESSAGE_LEARNING_IDENTITY_CONFLICT',
      409,
    );
  }
  return unique[0] || null;
}

function deliveryLabel(status, proposedHash, finalHash) {
  if (status === 'SENT') return proposedHash === finalHash ? 'accepted_exact' : 'edited_sent';
  if (status === 'UNKNOWN') return 'unknown_delivery';
  return status.toLowerCase();
}

function equivalentOutcome(existing, next) {
  return existing?.status === next.status
    && existing?.final_body_sha256 === next.final_body_sha256
    && existing?.delivery_reference === next.delivery_reference
    && existing?.reason === next.reason;
}

function ensureOutcomeTransition(existing, next) {
  if (!existing || equivalentOutcome(existing, next)) return;
  if (existing.status === 'UNKNOWN' && next.status === 'SENT') return;
  throw repositoryError(
    `Delivery outcome is already resolved as ${existing.status}`,
    'MESSAGE_LEARNING_OUTCOME_CONFLICT',
    409,
  );
}

function defaultFeedbackFile() {
  if (process.env.MESSAGE_LEARNING_FEEDBACK_FILE) {
    return path.resolve(process.env.MESSAGE_LEARNING_FEEDBACK_FILE);
  }
  const directory = process.env.MESSAGE_LEARNING_DATA_DIR
    ? path.resolve(process.env.MESSAGE_LEARNING_DATA_DIR)
    : path.join(process.cwd(), 'data');
  return path.join(directory, 'message-learning-feedback.json');
}

export function createMessageLearningRepository({
  directory,
  file,
  maxRecordsPerShop = 1_000,
  clock = () => new Date(),
  repositoryOptions = {},
} = {}) {
  const maximum = Number(maxRecordsPerShop);
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new TypeError('maxRecordsPerShop must be a positive integer');
  }

  const fileResolver = typeof file === 'function'
    ? file
    : file
      ? () => path.resolve(String(file))
      : typeof directory === 'function'
        ? () => path.join(path.resolve(String(directory())), 'message-learning-feedback.json')
        : directory
          ? () => path.join(path.resolve(String(directory)), 'message-learning-feedback.json')
          : defaultFeedbackFile;

  const persistence = createMessageRevisionedStoreRepository({
    ...repositoryOptions,
    file: fileResolver,
    recordType: MESSAGE_LEARNING_FEEDBACK_RECORD_TYPE,
    validateRecord: isValidShopRecord,
  });

  function currentTimestamp() {
    const value = clock();
    return normalizeTimestamp(value instanceof Date ? value.toISOString() : value, null, 'clock');
  }

  async function captureProposal(input = {}) {
    const shopId = normalizeShopId(input.shopId ?? input.shop_id);
    const draftId = normalizeIdentifier(input.draftId ?? input.draft_id, 'draftId');
    const candidateId = normalizeIdentifier(input.candidateId ?? input.candidate_id, 'candidateId');
    const keys = identityKeys({ draftId, candidateId });
    const proposedBody = exactBody(input.proposedBody ?? input.proposed_body, 'proposedBody');
    const proposedHash = sha256(proposedBody);
    const suppliedHash = optionalText(
      input.proposedBodySha256 ?? input.proposed_body_sha256,
      64,
    );
    if (suppliedHash && suppliedHash !== proposedHash) {
      throw repositoryError(
        'proposedBodySha256 does not match proposedBody',
        'MESSAGE_LEARNING_HASH_MISMATCH',
      );
    }
    const createdAt = normalizeTimestamp(
      input.proposalCreatedAt ?? input.proposal_created_at,
      currentTimestamp(),
      'proposalCreatedAt',
    );

    return persistence.transact(store => {
      const existingShop = store.shops[shopId] || null;
      const entries = existingShop?.entries || [];
      const matches = entries.filter(entry => keys.some(key => entry.identity_keys.includes(key)));
      if (new Set(matches).size > 1) {
        throw repositoryError(
          'Message learning identifiers resolve to different records',
          'MESSAGE_LEARNING_IDENTITY_CONFLICT',
          409,
        );
      }
      const existing = matches[0] || null;
      if (existing) {
        if (existing.proposed_body_sha256 !== proposedHash) {
          throw repositoryError(
            'The immutable proposal snapshot conflicts with the existing record',
            'MESSAGE_LEARNING_PROPOSAL_CONFLICT',
            409,
          );
        }
        const newKeys = keys.filter(key => !existing.identity_keys.includes(key));
        if (!newKeys.length) return { write: false, value: clone(existing) };
        existing.identity_keys.push(...newKeys);
        existing.draft_id ||= draftId;
        existing.candidate_id ||= candidateId;
        existing.updated_at = currentTimestamp();
        existing.activity_sequence = existingShop.revision + 1;
        existingShop.revision += 1;
        existingShop.updated_at = existing.updated_at;
        return { write: true, value: clone(existing) };
      }

      const now = currentTimestamp();
      const nextActivitySequence = (existingShop?.revision || 0) + 1;
      const record = {
        id: `mlf_${sha256(`${shopId}|${keys.sort().join('|')}`).slice(0, 24)}`,
        shop_id: shopId,
        identity_keys: keys,
        draft_id: draftId,
        candidate_id: candidateId,
        conversation_id: normalizeIdentifier(
          input.conversationId ?? input.conversation_id,
          'conversationId',
        ),
        source_message_id: normalizeIdentifier(
          input.sourceMessageId ?? input.source_message_id,
          'sourceMessageId',
        ),
        conversation_head_id: normalizeIdentifier(
          input.conversationHeadId ?? input.conversation_head_id,
          'conversationHeadId',
        ),
        scenario: normalizeScenario(input.scenario),
        buyer_message: cleanText(input.buyerMessage ?? input.buyer_message, 8_000),
        context_excerpt: cleanText(
          input.contextExcerpt ?? input.context_excerpt ?? input.buyerContext ?? input.buyer_context,
          12_000,
        ),
        proposed_body: proposedBody,
        proposed_body_sha256: proposedHash,
        provenance: normalizeProvenance({
          ...(isObject(input.generation) ? input.generation : {}),
          ...(isObject(input.provenance) ? input.provenance : {}),
          playbookRevision: input.playbookRevision
            ?? input.playbook_revision
            ?? input.provenance?.playbookRevision
            ?? input.provenance?.playbook_revision,
          evidenceDigest: input.evidenceDigest
            ?? input.evidence_digest
            ?? input.provenance?.evidenceDigest
            ?? input.provenance?.evidence_digest,
        }),
        trigger_event_id: optionalText(input.eventId ?? input.event_id, 240),
        trigger_rule_id: optionalText(input.ruleId ?? input.rule_id, 240),
        created_by: optionalText(input.createdBy ?? input.created_by, 240),
        proposal_created_at: createdAt,
        outcome: null,
        feedback: { latest: null, events: [] },
        created_at: now,
        updated_at: now,
        activity_sequence: nextActivitySequence,
      };
      const shop = existingShop || { revision: 0, updated_at: now, entries: [] };
      shop.entries.push(record);
      shop.entries = retainNewest(shop.entries, maximum);
      shop.revision += 1;
      shop.updated_at = now;
      store.shops[shopId] = shop;
      return { write: true, value: clone(record) };
    });
  }

  async function recordDeliveryOutcome(input = {}) {
    const shopId = normalizeShopId(input.shopId ?? input.shop_id);
    const draftId = normalizeIdentifier(input.draftId ?? input.draft_id, 'draftId');
    const candidateId = normalizeIdentifier(input.candidateId ?? input.candidate_id, 'candidateId');
    const recordId = normalizeIdentifier(input.recordId ?? input.record_id, 'recordId');
    if (!recordId && !draftId && !candidateId) identityKeys({ draftId, candidateId });
    const status = cleanText(input.status ?? input.outcome, 32).toUpperCase();
    if (!DELIVERY_STATUSES.has(status)) {
      throw repositoryError('Unsupported delivery outcome', 'MESSAGE_LEARNING_OUTCOME_INVALID');
    }
    const suppliedBody = input.finalBody ?? input.final_body;
    const finalBody = suppliedBody == null || suppliedBody === ''
      ? null
      : exactBody(suppliedBody, 'finalBody');
    if ((status === 'SENT' || status === 'UNKNOWN') && !finalBody) {
      throw repositoryError(
        `${status} requires the exact approved final body`,
        'MESSAGE_LEARNING_FINAL_BODY_REQUIRED',
      );
    }
    const finalHash = finalBody ? sha256(finalBody) : null;
    const suppliedHash = optionalText(input.finalBodySha256 ?? input.final_body_sha256, 64);
    if (suppliedHash && suppliedHash !== finalHash) {
      throw repositoryError(
        'finalBodySha256 does not match finalBody',
        'MESSAGE_LEARNING_HASH_MISMATCH',
      );
    }
    const resolvedAt = normalizeTimestamp(
      input.resolvedAt ?? input.resolved_at ?? input.deliveredAt ?? input.delivered_at,
      currentTimestamp(),
      'resolvedAt',
    );

    return persistence.transact(store => {
      const shop = store.shops[shopId];
      const record = shop && findEntry(shop.entries, { recordId, draftId, candidateId });
      if (!record) {
        throw repositoryError('Message learning proposal was not found', 'MESSAGE_LEARNING_NOT_FOUND', 404);
      }
      const next = {
        status,
        label: deliveryLabel(status, record.proposed_body_sha256, finalHash),
        final_body: finalBody,
        final_body_sha256: finalHash,
        delivery_reference: optionalText(
          input.deliveryReference ?? input.delivery_reference,
          500,
        ),
        reason: optionalText(input.reason, 1_000),
        actor: optionalText(input.actor ?? input.resolvedBy ?? input.resolved_by, 240),
        resolved_at: resolvedAt,
      };
      ensureOutcomeTransition(record.outcome, next);
      if (equivalentOutcome(record.outcome, next)) return { write: false, value: clone(record) };
      record.outcome = next;
      record.updated_at = currentTimestamp();
      record.activity_sequence = shop.revision + 1;
      shop.revision += 1;
      shop.updated_at = record.updated_at;
      return { write: true, value: clone(record) };
    });
  }

  async function recordTelegramFeedback(input = {}) {
    const shopId = normalizeShopId(input.shopId ?? input.shop_id);
    const draftId = normalizeIdentifier(input.draftId ?? input.draft_id, 'draftId');
    const candidateId = normalizeIdentifier(input.candidateId ?? input.candidate_id, 'candidateId');
    const recordId = normalizeIdentifier(input.recordId ?? input.record_id, 'recordId');
    if (!recordId && !draftId && !candidateId) identityKeys({ draftId, candidateId });
    const eventId = normalizeIdentifier(
      input.eventId ?? input.event_id ?? input.callbackQueryId ?? input.callback_query_id,
      'eventId',
    );
    if (!eventId) {
      throw repositoryError('A Telegram callback event ID is required', 'MESSAGE_LEARNING_FEEDBACK_ID_REQUIRED');
    }
    const rating = cleanText(input.rating, 32).toLowerCase();
    if (!TELEGRAM_RATINGS.has(rating)) {
      throw repositoryError(
        'Telegram rating must be helpful or unhelpful',
        'MESSAGE_LEARNING_FEEDBACK_INVALID',
      );
    }
    const recordedAt = normalizeTimestamp(
      input.recordedAt ?? input.recorded_at,
      currentTimestamp(),
      'recordedAt',
    );

    return persistence.transact(store => {
      const shop = store.shops[shopId];
      const record = shop && findEntry(shop.entries, { recordId, draftId, candidateId });
      if (!record) {
        throw repositoryError('Message learning proposal was not found', 'MESSAGE_LEARNING_NOT_FOUND', 404);
      }
      const duplicate = record.feedback.events.find(event => event.event_id === eventId);
      if (duplicate) {
        if (duplicate.rating !== rating) {
          throw repositoryError(
            'Telegram callback event conflicts with existing feedback',
            'MESSAGE_LEARNING_FEEDBACK_CONFLICT',
            409,
          );
        }
        return { write: false, value: clone(record) };
      }
      const event = {
        event_id: eventId,
        rating,
        actor_id: optionalText(input.actorId ?? input.actor_id, 160),
        telegram_message_id: optionalText(
          input.telegramMessageId ?? input.telegram_message_id,
          160,
        ),
        recorded_at: recordedAt,
      };
      record.feedback.events = [...record.feedback.events, event].slice(-20);
      record.feedback.latest = event;
      record.updated_at = currentTimestamp();
      record.activity_sequence = shop.revision + 1;
      shop.revision += 1;
      shop.updated_at = record.updated_at;
      return { write: true, value: clone(record) };
    });
  }

  async function getByDraft({ shopId, shop_id: snakeShopId, draftId, draft_id: snakeDraftId } = {}) {
    const id = normalizeShopId(shopId ?? snakeShopId);
    const normalizedDraftId = normalizeIdentifier(draftId ?? snakeDraftId, 'draftId');
    if (!normalizedDraftId) identityKeys({ draftId: normalizedDraftId, candidateId: null });
    const shop = await persistence.load(id);
    return clone(shop?.entries.find(entry => entry.identity_keys.includes(`draft:${normalizedDraftId}`)) || null);
  }

  async function getByCandidate({
    shopId,
    shop_id: snakeShopId,
    candidateId,
    candidate_id: snakeCandidateId,
  } = {}) {
    const id = normalizeShopId(shopId ?? snakeShopId);
    const normalizedCandidateId = normalizeIdentifier(candidateId ?? snakeCandidateId, 'candidateId');
    if (!normalizedCandidateId) identityKeys({ draftId: null, candidateId: normalizedCandidateId });
    const shop = await persistence.load(id);
    return clone(
      shop?.entries.find(entry => entry.identity_keys.includes(`candidate:${normalizedCandidateId}`)) || null,
    );
  }

  async function listEligibleExamples({
    shopId,
    shop_id: snakeShopId,
    scenario,
    limit = 30,
  } = {}) {
    const id = normalizeShopId(shopId ?? snakeShopId);
    const normalizedScenario = scenario == null ? null : normalizeScenario(scenario);
    const maximumResults = Math.min(Math.max(Number(limit) || 0, 0), 100);
    if (!maximumResults) return [];
    const shop = await persistence.load(id);
    if (!shop) return [];
    return clone(shop.entries
      .filter(entry => (
        (!normalizedScenario || entry.scenario === normalizedScenario)
        && (
          (entry.outcome?.status === 'SENT' && entry.outcome.final_body)
          || entry.feedback.latest?.rating === 'unhelpful'
        )
      ))
      .sort((left, right) => (
        Date.parse(right.outcome?.resolved_at || right.updated_at)
        - Date.parse(left.outcome?.resolved_at || left.updated_at)
      ))
      .slice(0, maximumResults)
      .map(entry => {
        const negativeOnly = entry.feedback.latest?.rating === 'unhelpful'
          && entry.outcome?.label !== 'edited_sent';
        return {
        id: entry.id,
        draft_id: entry.draft_id,
        candidate_id: entry.candidate_id,
        conversation_id: entry.conversation_id,
        source_message_id: entry.source_message_id,
        scenario: entry.scenario,
        buyer_message: entry.buyer_message,
        buyer_context: entry.context_excerpt,
        context_excerpt: entry.context_excerpt,
        proposed_body: entry.proposed_body,
        proposed_body_sha256: entry.proposed_body_sha256,
        final_body: negativeOnly ? null : entry.outcome?.final_body || null,
        final_body_sha256: negativeOnly
          ? null
          : entry.outcome?.final_body_sha256 || null,
        outcome_label: entry.outcome?.label || null,
        learning_kind: negativeOnly
          ? 'explicit_unhelpful'
          : entry.outcome.label,
        label: negativeOnly ? 'explicit_unhelpful' : entry.outcome.label,
        feedback: entry.feedback.latest,
        telegram_feedback: entry.feedback.latest?.rating || null,
        proposal_created_at: entry.proposal_created_at,
        sent_at: entry.outcome?.resolved_at || null,
        provenance: entry.provenance,
        };
      }));
  }

  async function validate() {
    return persistence.transact(store => {
      let write = false;
      const now = currentTimestamp();
      for (const shop of Object.values(store.shops)) {
        if (shop.entries.length <= maximum) continue;
        shop.entries = retainNewest(shop.entries, maximum);
        shop.revision += 1;
        shop.updated_at = now;
        write = true;
      }
      return { write, value: true };
    });
  }

  return {
    captureProposal,
    recordDeliveryOutcome,
    recordTelegramFeedback,
    listEligibleExamples,
    getByDraft,
    getByCandidate,
    validate,
  };
}

export const messageLearningRepository = createMessageLearningRepository();
