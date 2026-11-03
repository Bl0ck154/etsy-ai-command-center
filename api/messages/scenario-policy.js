import { MESSAGE_SCENARIOS } from './playbook.js';
import { cleanText } from './contracts.js';

export const ORDER_CONTEXT_SCENARIOS = new Set([
  'missing_materials',
  'deadline_variants_sent',
  'deadline_no_materials',
  'review_request',
]);

export function assertScenario(value) {
  const scenario = cleanText(value, 80);
  if (!MESSAGE_SCENARIOS.includes(scenario)) {
    const error = new Error('Select a valid message scenario');
    error.status = 400;
    throw error;
  }
  return scenario;
}

export function assertLiveScenarioAllowed(scenario, status) {
  if (
    ORDER_CONTEXT_SCENARIOS.has(scenario)
    && !status.order_linking_enabled
  ) {
    const error = new Error(
      'This scenario needs verified order context. It is disabled while the Bridge uses the reserve/test Etsy account.',
    );
    error.status = 409;
    error.code = 'MESSAGE_ORDER_CONTEXT_DISABLED';
    throw error;
  }
}

export function blockedPreview(replyState, playbookRevision) {
  return {
    status: replyState.no_action ? 'no_action' : 'blocked',
    scenario: null,
    reply_body: '',
    confidence: 0,
    rationale: '',
    facts_used: [],
    warnings: [replyState.code],
    requires_human_approval: true,
    block_reason: replyState.reason,
    preview_only: true,
    queued: false,
    sent: false,
    conversation_check: replyState,
    playbook_revision: playbookRevision,
  };
}

export function assertConversationNeedsReply(replyState) {
  if (replyState.eligible) return;
  const error = new Error(replyState.reason);
  error.status = 409;
  error.code = replyState.code;
  error.data = { conversation_check: replyState };
  throw error;
}
