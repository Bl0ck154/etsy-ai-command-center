import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { automationEventLabel } from '../public/utils/messages-automation/locale.js';
import {
  automationRuntimePresentation,
  isAutomationOperational,
  normalizeAutomationPolicyState,
} from '../public/utils/messages-automation/policy-runtime.js';
import {
  automationEventOutcome,
  automationEventPresentation,
} from '../public/utils/messages-automation/event-presentation.js';
import { automationHumanReason } from '../public/utils/messages-automation/human-reason.js';

test('legacy policy state normalizes to draft-only human-approved policy', () => {
  expect(normalizeAutomationPolicyState({ revision: 3, enabled: true, rules: [{ event: 'new_message' }] })).toEqual({
    revision: 3,
    policy: {
      enabled: true,
      delivery_mode: 'draft_only',
      human_approval_required: true,
      rules: [{ event: 'new_message' }],
    },
  });
});

test('operational status requires installed/enabled policy and ready-like worker', () => {
  const policy = { policy: { enabled: true } };
  expect(isAutomationOperational({ implemented: true, enabled: true, worker_state: 'running' }, policy)).toBe(true);
  expect(isAutomationOperational({ implemented: true, enabled: false, worker_state: 'running' }, policy)).toBe(false);
  expect(isAutomationOperational({ implemented: true, enabled: true, worker_state: 'error' }, policy)).toBe(false);
});

test('runtime presentation preserves unavailable, paused, blocked and running states', () => {
  expect(automationRuntimePresentation({}, {}, 'en')).toMatchObject({ label: 'Runner unavailable', className: 'is-blocked' });
  expect(automationRuntimePresentation({ implemented: true, enabled: false }, {}, 'en')).toMatchObject({ label: 'Runner paused', className: 'is-paused' });
  expect(automationRuntimePresentation({ implemented: true, enabled: true, worker_state: 'ERROR', last_error: 'boom' }, { policy: { enabled: true } }, 'en')).toMatchObject({ label: 'Runner error', detail: 'boom', className: 'is-blocked' });
  expect(automationRuntimePresentation({ implemented: true, enabled: true, worker_state: 'READY' }, { policy: { enabled: true } }, 'en')).toMatchObject({ label: 'Runner active', className: 'is-running' });
});

test('event labels preserve locale mapping and unknown fallback', () => {
  expect(automationEventLabel('order_paid', 'uk')).toBe('Замовлення оплачено');
  expect(automationEventLabel('new_message', 'en')).toBe('New Etsy message');
  expect(automationEventLabel('custom_event', 'en')).toBe('custom event');
});

test('event outcome and presentation preserve status precedence', () => {
  expect(automationEventOutcome({ outcome: 'queued', status: 'SENT' })).toBe('queued');
  expect(automationEventPresentation({ status: 'SENT', outcome: 'queued' }, 'en')).toEqual({ label: 'Sent', className: 'is-sent' });
  expect(automationEventPresentation({ status: 'RETRYABLE_ERROR' }, 'en')).toEqual({ label: 'Check will retry', className: 'is-warning' });
  expect(automationEventPresentation({ status: 'SKIPPED', block_code: 'COOLDOWN' }, 'en')).toEqual({ label: 'Skipped: cooldown is still active', className: 'is-skipped' });
  expect(automationEventPresentation({ draft_id: 'd1' }, 'en')).toEqual({ label: 'Draft ready for review', className: 'is-draft' });
});

test('human reasons preserve Ukrainian operator explanations and English raw reason', () => {
  expect(automationHumanReason({ block_code: 'NO_MATCHING_RULE', reason: 'raw' }, 'uk')).toContain('Жодне активне правило');
  expect(automationHumanReason({ block_code: 'ORDER_LINK_FAILED' }, 'uk')).toContain('пов’язати діалог із замовленням');
  expect(automationHumanReason({ status: 'RETRYABLE_ERROR' }, 'uk')).toContain('повторить перевірку');
  expect(automationHumanReason({ reason: 'Raw provider reason' }, 'en')).toBe('Raw provider reason');
});

test('messages automation view-model remains facade-only', () => {
  const source = fs.readFileSync(new URL('../public/utils/messages-automation-view-model.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(20);
  expect(source).not.toContain('NO_MATCHING_RULE');
  expect(source).not.toContain('Runner unavailable');
  expect(source).toContain("from './messages-automation/policy-runtime.js'");
  expect(source).toContain("from './messages-automation/event-presentation.js'");
});
