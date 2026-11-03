import path from 'node:path';

import { createMessageRevisionedStoreRepository } from './revisioned-store-repository.js';
import { MESSAGE_SCENARIOS } from './playbook.js';

export const MESSAGE_TRIGGER_EVENTS = Object.freeze([
  'new_message',
  'order_paid',
  'materials_missing',
  'listing_deadline',
  'order_completed',
]);

export const DEFAULT_MESSAGE_AUTOMATION_POLICY = Object.freeze({
  enabled: false,
  delivery_mode: 'draft_only',
  human_approval_required: true,
  rules: [],
});

function policyPath() {
  return process.env.MESSAGE_AUTOMATION_POLICY_FILE
    || path.join(process.cwd(), 'data', 'message-automation-policies.json');
}

const policyRepository = createMessageRevisionedStoreRepository({
  file: policyPath,
  recordType: 'message_automation_policy_store',
  validateRecord: record => (
    Number.isInteger(record?.revision)
    && record.revision > 0
    && (record.updated_at == null || (
      typeof record.updated_at === 'string'
      && Number.isFinite(Date.parse(record.updated_at))
    ))
    && (record.updated_by == null || typeof record.updated_by === 'string')
    && record.policy
    && typeof record.policy === 'object'
    && !Array.isArray(record.policy)
  ),
});

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeShopId(value) {
  const id = String(value || '').replace(/[^0-9]/g, '');
  if (!id) {
    const error = new Error('A numeric Etsy shop ID is required');
    error.status = 400;
    throw error;
  }
  return id;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(parsed, max))
    : fallback;
}

export function normalizeMessageAutomationPolicy(value = {}) {
  const rules = (Array.isArray(value?.rules) ? value.rules : [])
    .map((rule, index) => {
      const event = MESSAGE_TRIGGER_EVENTS.includes(rule?.event)
        ? rule.event
        : null;
      const scenario = MESSAGE_SCENARIOS.includes(rule?.scenario)
        ? rule.scenario
        : null;
      if (!event || !scenario) return null;
      return {
        id: cleanText(rule.id, 80) || `rule_${index + 1}`,
        label: cleanText(rule.label, 160) || `${event}: ${scenario}`,
        enabled: rule.enabled === true,
        event,
        scenario,
        delay_minutes: boundedInteger(rule.delay_minutes, 0, 0, 43_200),
        cooldown_minutes: boundedInteger(
          rule.cooldown_minutes,
          60,
          0,
          10_080,
        ),
        require_order_context: rule.require_order_context === true,
        conditions: cleanText(rule.conditions, 2_000),
        owner_notes: cleanText(rule.owner_notes, 2_000),
      };
    })
    .filter(Boolean)
    .slice(0, 50);

  return {
    enabled: value?.enabled === true,
    // These are immutable safety properties. Rules may create candidates,
    // but no policy can approve or send an Etsy message.
    delivery_mode: 'draft_only',
    human_approval_required: true,
    rules,
  };
}

export async function loadMessageAutomationPolicy(shopId) {
  const id = normalizeShopId(shopId);
  const saved = await policyRepository.load(id);
  if (!saved) {
    return {
      revision: 0,
      updated_at: null,
      updated_by: null,
      policy: normalizeMessageAutomationPolicy(DEFAULT_MESSAGE_AUTOMATION_POLICY),
    };
  }
  return {
    revision: Number(saved.revision) || 0,
    updated_at: saved.updated_at || null,
    updated_by: saved.updated_by || null,
    policy: normalizeMessageAutomationPolicy(saved.policy),
  };
}

export async function saveMessageAutomationPolicy(
  shopId,
  value,
  { expectedRevision, updatedBy } = {},
) {
  const id = normalizeShopId(shopId);
  const policy = normalizeMessageAutomationPolicy(value);
  return policyRepository.save(id, {
    expectedRevision,
    conflictError(currentRevision) {
      const error = new Error(
        `Message automation policy changed since it was opened (current revision ${currentRevision})`,
      );
      error.status = 409;
      error.code = 'MESSAGE_AUTOMATION_REVISION_CONFLICT';
      return error;
    },
    buildRecord(_current, currentRevision) {
      return {
        revision: currentRevision + 1,
        updated_at: new Date().toISOString(),
        updated_by: cleanText(updatedBy, 120) || 'unknown',
        policy,
      };
    },
  });
}

export async function validateMessageAutomationPolicyStore() {
  return policyRepository.validate();
}
