import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import {
  createMessageTriggerEventDispatcher,
  supersedePendingNewMessageCandidates,
} from '../api/messages/trigger-dispatcher.js';

test('event dispatcher debounces a burst into one immediate due run', async () => {
  const timers = [];
  const cleared = [];
  const runs = [];
  const dispatcher = createMessageTriggerEventDispatcher({
    debounceMs: 3_000,
    runDue: async input => {
      runs.push(input);
      return { processed: 1, candidates: [] };
    },
    setTimeoutFn: callback => {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: timer => cleared.push(timer),
    logger: { log() {}, error() {} },
  });

  dispatcher.schedule();
  dispatcher.schedule();
  dispatcher.schedule();

  expect(timers).toHaveLength(3);
  expect(cleared).toHaveLength(2);
  await timers.at(-1).callback();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(runs).toEqual([{ limit: 10 }]);
});

test('newer conversation event supersedes only unprocessed older message candidates', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-trigger-dispatcher-'));
  const stateFile = path.join(directory, 'state.json');
  const previousStateFile = process.env.MESSAGE_TRIGGER_STATE_FILE;
  const previousLockFile = process.env.MESSAGE_TRIGGER_STATE_LOCK_FILE;
  process.env.MESSAGE_TRIGGER_STATE_FILE = stateFile;
  process.env.MESSAGE_TRIGGER_STATE_LOCK_FILE = `${stateFile}.lock`;

  try {
    await fs.writeFile(stateFile, `${JSON.stringify({
      version: 1,
      events: {
        old_event: { occurred_at: '2026-08-22T11:59:00.000Z' },
        processing_event: { occurred_at: '2026-08-22T11:59:30.000Z' },
        keep_event: { occurred_at: '2026-08-22T12:00:00.000Z' },
      },
      candidates: {
        older_pending: {
          id: 'older_pending',
          event: 'new_message',
          event_id: 'gmail:old',
          event_key: 'old_event',
          shop_id: '1',
          conversation_id: '77',
          status: 'PENDING',
        },
        older_processing: {
          id: 'older_processing',
          event: 'new_message',
          event_id: 'gmail:processing',
          event_key: 'processing_event',
          shop_id: '1',
          conversation_id: '77',
          status: 'PROCESSING',
        },
        keep: {
          id: 'keep',
          event: 'new_message',
          event_id: 'gmail:new',
          event_key: 'keep_event',
          shop_id: '1',
          conversation_id: '77',
          status: 'PENDING',
        },
      },
    }, null, 2)}\n`);

    const result = await supersedePendingNewMessageCandidates({
      shop_id: '1',
      conversation_id: '77',
      keep_event_id: 'gmail:new',
      keep_occurred_at: '2026-08-22T12:00:00.000Z',
      now: '2026-08-22T12:00:00.000Z',
    });
    expect(result).toEqual({ superseded: 1 });

    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    expect(state.candidates.older_pending).toMatchObject({
      status: 'IGNORED_SUPERSEDED',
      block_code: 'MESSAGE_TRIGGER_SUPERSEDED_BY_NEWER_MESSAGE',
    });
    expect(state.candidates.older_processing.status).toBe('PROCESSING');
    expect(state.candidates.keep.status).toBe('PENDING');
  } finally {
    if (previousStateFile === undefined) delete process.env.MESSAGE_TRIGGER_STATE_FILE;
    else process.env.MESSAGE_TRIGGER_STATE_FILE = previousStateFile;
    if (previousLockFile === undefined) delete process.env.MESSAGE_TRIGGER_STATE_LOCK_FILE;
    else process.env.MESSAGE_TRIGGER_STATE_LOCK_FILE = previousLockFile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test('an out-of-order old event never supersedes a newer pending candidate', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-trigger-dispatcher-order-'));
  const stateFile = path.join(directory, 'state.json');
  const previousStateFile = process.env.MESSAGE_TRIGGER_STATE_FILE;
  const previousLockFile = process.env.MESSAGE_TRIGGER_STATE_LOCK_FILE;
  process.env.MESSAGE_TRIGGER_STATE_FILE = stateFile;
  process.env.MESSAGE_TRIGGER_STATE_LOCK_FILE = `${stateFile}.lock`;
  try {
    await fs.writeFile(stateFile, `${JSON.stringify({
      version: 1,
      events: {
        newer: { occurred_at: '2026-08-22T12:01:00.000Z' },
        older: { occurred_at: '2026-08-22T12:00:00.000Z' },
      },
      candidates: {
        newer_pending: {
          id: 'newer_pending', event: 'new_message', event_id: 'gmail:newer',
          event_key: 'newer', shop_id: '1', conversation_id: '77', status: 'PENDING',
        },
        older_keep: {
          id: 'older_keep', event: 'new_message', event_id: 'gmail:older',
          event_key: 'older', shop_id: '1', conversation_id: '77', status: 'PENDING',
        },
      },
    }, null, 2)}
`);
    const result = await supersedePendingNewMessageCandidates({
      shop_id: '1', conversation_id: '77', keep_event_id: 'gmail:older',
      keep_occurred_at: '2026-08-22T12:00:00.000Z',
      now: '2026-08-22T12:02:00.000Z',
    });
    expect(result).toEqual({ superseded: 0 });
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    expect(state.candidates.newer_pending.status).toBe('PENDING');
  } finally {
    if (previousStateFile === undefined) delete process.env.MESSAGE_TRIGGER_STATE_FILE;
    else process.env.MESSAGE_TRIGGER_STATE_FILE = previousStateFile;
    if (previousLockFile === undefined) delete process.env.MESSAGE_TRIGGER_STATE_LOCK_FILE;
    else process.env.MESSAGE_TRIGGER_STATE_LOCK_FILE = previousLockFile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
