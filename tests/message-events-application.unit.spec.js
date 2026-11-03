import { test, expect } from '@playwright/test';

import { createMessageEventsApplication } from '../api/message-events/application.js';

function createApp(overrides = {}) {
  const calls = { queued: [], due: [], dispatch: [], supersede: [] };
  const app = createMessageEventsApplication({
    enqueueMessageTriggerEvent: async event => {
      calls.queued.push(event);
      return { id: 'queued-1', ...event };
    },
    getMessageTriggerStatus: async query => ({ items: [], query }),
    hydrateNewMessageTriggerEvent: async event => ({
      event: { ...event, source_message_id: 'm1' },
      hydrated: true,
    }),
    hydrateOrderLinkedTriggerEvent: async event => ({ event: { ...event, conversation_id: '77' }, hydrated: true }),
    runDueMessageTriggerCandidates: async input => {
      calls.due.push(input);
      return { processed: 1, candidates: [{ id: 'candidate-1' }] };
    },
    scheduleImmediateMessageTriggerRun: () => {
      calls.dispatch.push(true);
      return { scheduled: true, debounce_ms: 3_000 };
    },
    supersedePendingNewMessageCandidates: async input => {
      calls.supersede.push(input);
      return { superseded: 1 };
    },
    getPersistedMessageTriggerWorkerStatus: async () => null,
    defaultShopId: () => 'shop-default',
    now: () => new Date('2026-08-14T08:00:00.000Z'),
    ...overrides,
  });
  return { app, calls };
}

test('status preserves query normalization and not-started worker fallback', async () => {
  const { app } = createApp();
  const result = await app.status({ shop_id: ' shop-1 ', conversation_id: ' 7 ', limit: '12' });
  expect(result).toMatchObject({
    query: { shop_id: 'shop-1', conversation_id: '7', limit: '12' },
    worker: { version: 1, enabled: false, running: false, status: 'not_started' },
  });
});

test('new-message hydration no-action returns accepted outcome without enqueue', async () => {
  const { app, calls } = createApp({
    hydrateNewMessageTriggerEvent: async event => ({
      event,
      hydrated: false,
      no_action: true,
      reason: 'Already handled',
    }),
  });
  const result = await app.ingest({ event: { type: 'new_message' } });
  expect(result).toMatchObject({
    status: 202,
    data: {
      queued: null,
      due: { processed: 0, candidates: [] },
      hydration: { no_action: true, reason: 'Already handled' },
    },
  });
  expect(calls.queued).toHaveLength(0);
  expect(calls.dispatch).toHaveLength(0);
});

test('order-linked hydration maps Bridge 404 to stable application error contract', async () => {
  const error = new Error('missing');
  error.bridge_status = 404;
  const { app, calls } = createApp({
    hydrateOrderLinkedTriggerEvent: async () => { throw error; },
  });
  const result = await app.ingest({ type: 'order_paid', receipt_id: '123' });
  expect(result).toMatchObject({
    status: 404,
    code: 'MESSAGE_TRIGGER_ORDER_LINK_NOT_FOUND',
    error: 'No Etsy conversation is linked to this receipt',
    data: { hydration: { no_action: true, hydrated: false } },
  });
  expect(calls.queued).toHaveLength(0);
});

test('ingest enqueues, coalesces and schedules immediate event-driven processing', async () => {
  const { app, calls } = createApp();
  const result = await app.ingest({
    event: {
      event: 'new_message',
      event_id: 'gmail:1',
      conversation_id: '77',
    },
  });
  expect(calls.queued[0]).toMatchObject({
    type: 'new_message',
    shop_id: 'shop-default',
    occurred_at: '2026-08-14T08:00:00.000Z',
    source_message_id: 'm1',
  });
  expect(calls.supersede[0]).toMatchObject({
    shop_id: 'shop-default',
    conversation_id: '77',
    keep_event_id: 'gmail:1',
    keep_occurred_at: '2026-08-14T08:00:00.000Z',
  });
  expect(result).toMatchObject({
    status: 202,
    data: {
      coalescing: { superseded: 1 },
      due: {
        processed: 0,
        candidates: [],
        event_dispatch_scheduled: true,
        debounce_ms: 3_000,
        fallback_worker: true,
      },
    },
  });
  expect(calls.dispatch).toHaveLength(1);
  expect(calls.due).toHaveLength(0);
});


test('duplicate new-message ingest does not let an old replay supersede newer work', async () => {
  const { app, calls } = createApp({
    enqueueMessageTriggerEvent: async event => {
      calls.queued.push(event);
      return { duplicate: true, event };
    },
  });
  const result = await app.ingest({
    event: {
      type: 'new_message',
      event_id: 'gmail:old-replay',
      conversation_id: '77',
      source_message_id: 'm1',
    },
  });
  expect(calls.supersede).toHaveLength(0);
  expect(result.data.coalescing).toEqual({ superseded: 0 });
  expect(calls.dispatch).toHaveLength(1);
});

test('process_due executes the same bounded due runner without scheduling a second dispatch', async () => {
  const { app, calls } = createApp();
  const result = await app.ingest({
    event: {
      type: 'new_message',
      event_id: 'gmail:2',
      conversation_id: '77',
      source_message_id: 'm1',
    },
    process_due: true,
  });
  expect(calls.due).toEqual([{ limit: 10 }]);
  expect(calls.dispatch).toHaveLength(0);
  expect(result.data.due).toMatchObject({ processed: 1 });
});
