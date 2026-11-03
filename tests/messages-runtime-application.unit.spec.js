import { test, expect } from '@playwright/test';

import {
  automationOutcome,
  createMessagesRuntimeApplication,
} from '../api/messages/runtime-application.js';

test('automation outcome projection preserves legacy status mapping', () => {
  expect(automationOutcome({ status: 'AWAITING_APPROVAL' })).toBe('draft_created');
  expect(automationOutcome({ status: 'BLOCKED' })).toBe('blocked');
  expect(automationOutcome({ status: 'RETRYABLE_ERROR' })).toBe('retrying');
  expect(automationOutcome({ status: 'IGNORED_COOLDOWN' })).toBe('ignored');
  expect(automationOutcome({ status: 'READY' })).toBe('ready');
});

test('runtime status keeps production-only live gates and reserve guard', () => {
  const worker = { running: true, enabled: true, last_error: null };
  const app = createMessagesRuntimeApplication({
    bridgeRequest: async () => ({}),
    messageAutomationConfig: () => ({
      order_linking_enabled: true,
      automatic_triggers_enabled: true,
      event_ingest_configured: true,
    }),
    getMessageTriggerWorkerStatus: () => worker,
    loadMessageAutomationPolicy: async () => ({}),
    getMessageTriggerStatus: async () => ({ items: [] }),
  });

  expect(app.runtimeStatus({ account: { label: 'live', mode: 'production' } })).toMatchObject({
    order_linking_enabled: true,
    automatic_triggers_enabled: true,
    approval_required: true,
    reserve_guard_active: false,
    trigger_worker: worker,
  });
  expect(app.runtimeStatus({ account: { label: 'reserve', mode: 'test' } })).toMatchObject({
    order_linking_enabled: false,
    automatic_triggers_enabled: false,
    reserve_guard_active: true,
  });
});

test('automation status combines policy, worker and recent candidate projection', async () => {
  const app = createMessagesRuntimeApplication({
    bridgeRequest: async () => ({ account: { mode: 'production' } }),
    messageAutomationConfig: () => ({
      automatic_triggers_enabled: true,
      event_ingest_configured: true,
      order_linking_enabled: true,
      telegram_notifications_enabled: false,
    }),
    getMessageTriggerWorkerStatus: () => ({
      running: false,
      enabled: true,
      last_error: null,
      last_tick_at: '2026-08-14T01:00:00Z',
      last_completed_at: '2026-08-14T01:01:00Z',
    }),
    loadMessageAutomationPolicy: async shopId => ({ revision: 4, shop_id: shopId }),
    getMessageTriggerStatus: async () => ({
      items: [
        {
          id: 'c1', event: 'new_message', scenario: 'freeform',
          status: 'AWAITING_APPROVAL', conversation_id: '7', draft_id: '9',
          created_at: '2026-08-14T02:00:00Z', updated_at: '2026-08-14T02:01:00Z',
        },
      ],
    }),
  });

  const result = await app.automationStatus('shop-1');
  expect(result.policy).toEqual({ revision: 4, shop_id: 'shop-1' });
  expect(result.runtime).toMatchObject({
    implemented: true,
    enabled: true,
    worker_state: 'READY',
    delivery_mode: 'draft_only',
    human_approval_required: true,
    last_event_at: '2026-08-14T02:00:00Z',
    last_candidate_at: '2026-08-14T02:01:00Z',
  });
  expect(result.recent_events[0]).toMatchObject({
    id: 'c1',
    outcome: 'draft_created',
    draft_id: '9',
  });
});
