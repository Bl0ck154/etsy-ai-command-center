import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  automationEventLabel,
  automationEventLabels,
  automationEventOutcome,
  automationEventPresentation,
  automationHumanReason,
  automationRuntimePresentation,
  isAutomationOperational,
  normalizeAutomationPolicyState,
} from '../public/utils/messages-automation-view-model.js';

test('legacy automation policy state normalizes to the existing draft-only safety contract', () => {
  const nested = { revision: 9, policy: { enabled: true, rules: [{ id: 'one' }] } };
  expect(normalizeAutomationPolicyState(nested)).toBe(nested);
  expect(normalizeAutomationPolicyState({
    revision: '4',
    enabled: true,
    rules: [{ id: 'legacy' }],
  })).toEqual({
    revision: 4,
    policy: {
      enabled: true,
      delivery_mode: 'draft_only',
      human_approval_required: true,
      rules: [{ id: 'legacy' }],
    },
  });
  expect(normalizeAutomationPolicyState(null)).toMatchObject({
    revision: 0,
    policy: { enabled: false, rules: [] },
  });
});

test('operational state requires implementation, runtime, policy, and a healthy worker state', () => {
  const runtime = { implemented: true, enabled: true, worker_state: 'ready' };
  const policyState = { policy: { enabled: true } };
  expect(isAutomationOperational(runtime, policyState)).toBe(true);
  expect(isAutomationOperational({ ...runtime, implemented: false }, policyState)).toBe(false);
  expect(isAutomationOperational({ ...runtime, enabled: false }, policyState)).toBe(false);
  expect(isAutomationOperational({ ...runtime, worker_state: 'degraded' }, policyState)).toBe(false);
  expect(isAutomationOperational(runtime, { policy: { enabled: false } })).toBe(false);
});

test('runner presentation preserves unavailable, paused, policy, error, and active precedence', () => {
  expect(automationRuntimePresentation({}, {}, 'en')).toEqual({
    label: 'Runner unavailable',
    detail: 'The draft runner is not installed on this service.',
    className: 'is-blocked',
  });
  expect(automationRuntimePresentation(
    { implemented: true, enabled: false },
    { policy: { enabled: true } },
    'en',
  )).toMatchObject({ label: 'Runner paused', className: 'is-paused' });
  expect(automationRuntimePresentation(
    { implemented: true, enabled: true },
    { policy: { enabled: false } },
    'en',
  )).toMatchObject({ label: 'Rules paused', className: 'is-paused' });
  expect(automationRuntimePresentation(
    { implemented: true, enabled: true, worker_state: 'DEGRADED', last_error: 'bridge unavailable' },
    { policy: { enabled: true } },
    'en',
  )).toEqual({
    label: 'Runner degraded',
    detail: 'bridge unavailable',
    className: 'is-blocked',
  });
  expect(automationRuntimePresentation(
    { implemented: true, enabled: true, worker_state: 'RUNNING' },
    { policy: { enabled: true } },
    'uk',
  )).toMatchObject({ label: 'Автоматизація працює', className: 'is-running' });
});

test('event labels use the selected locale and retain readable unknown values', () => {
  expect(automationEventLabels('en').new_message).toBe('New Etsy message');
  expect(automationEventLabel('order_paid', 'uk')).toBe('Замовлення оплачено');
  expect(automationEventLabel('manual_review_started', 'en')).toBe('manual review started');
  expect(automationEventLabel('', 'en')).toBe('Automation event');
});

test('event outcome preserves the current field precedence', () => {
  expect(automationEventOutcome({
    outcome: 'Draft_Created',
    result: 'blocked',
    status: 'FAILED',
  })).toBe('draft_created');
  expect(automationEventOutcome({ result: 'QUEUED' })).toBe('queued');
  expect(automationEventOutcome({ status: 'PENDING' })).toBe('pending');
  expect(automationEventOutcome({ decision: 'NO_MATCH' })).toBe('no_match');
});

test('event presentation maps lifecycle outcomes to stable labels and classes', () => {
  const cases = [
    [{ status: 'SENT' }, 'Sent', 'is-sent'],
    [{ outcome: 'approved' }, 'Approved, waiting to send', 'is-draft'],
    [{ status: 'BLOCKED' }, 'Draft not created', 'is-safe'],
    [{ status: 'RETRYABLE_ERROR' }, 'Check will retry', 'is-warning'],
    [{ outcome: 'worker_error' }, 'Check failed', 'is-error'],
    [{ status: 'PROCESSING' }, 'Waiting to be checked', 'is-pending'],
    [{ outcome: 'cooldown' }, 'Skipped: cooldown is still active', 'is-skipped'],
    [{ status: 'SKIPPED' }, 'No draft created by rules', 'is-skipped'],
    [{ created_draft_id: 'draft-1' }, 'Draft ready for review', 'is-draft'],
    [{ outcome: 'no_action_needed' }, 'Checked, no action needed', ''],
  ];

  for (const [event, label, className] of cases) {
    expect(automationEventPresentation(event, 'en')).toEqual({ label, className });
  }
});

test('human reasons keep English diagnostics and translate known Ukrainian safety reasons', () => {
  expect(automationHumanReason({ block_code: 'COOLDOWN_ACTIVE' }, 'uk'))
    .toBe('Повторна чернетка поки не потрібна: ще діє заданий інтервал.');
  expect(automationHumanReason({ block_code: 'ORDER_LINK_MISSING' }, 'uk'))
    .toBe('Не вдалося надійно пов’язати діалог із замовленням.');
  expect(automationHumanReason({ reason: 'shop reply already follows' }, 'uk'))
    .toBe('Магазин уже відповів після цього повідомлення покупця.');
  expect(automationHumanReason({ status: 'RETRYABLE_ERROR' }, 'uk'))
    .toBe('Тимчасова помилка. Система повторить перевірку автоматично.');
  expect(automationHumanReason({ reason: 'raw bridge diagnostic' }, 'en'))
    .toBe('raw bridge diagnostic');
  expect(automationHumanReason({}, 'uk'))
    .toBe('Перевірку завершено без створення чернетки.');
});

test('Messages page delegates automation presentation without moving DOM or API behavior', async () => {
  const pageSource = await fs.readFile(new URL('../public/pages/messages.js', import.meta.url), 'utf8');
  const viewModelSource = await fs.readFile(
    new URL('../public/utils/messages-automation-view-model.js', import.meta.url),
    'utf8',
  );

  expect(pageSource).toContain("from '../utils/messages-automation-view-model.js'");
  for (const functionName of [
    'automationEventLabel',
    'automationEventOutcome',
    'automationEventPresentation',
    'automationHumanReason',
  ]) {
    expect(pageSource).not.toContain(`function ${functionName}(`);
  }
  expect(viewModelSource).not.toMatch(/document\.|window\.|messagesApi|fetch\(|localStorage|sessionStorage/i);
});
