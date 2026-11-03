import { test, expect } from '@playwright/test';
import fs from 'node:fs';

import { requireMessageEventToken } from '../api/message-events/auth.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function withToken(value, fn) {
  const previous = process.env.MESSAGE_EVENT_INGEST_TOKEN;
  if (value === undefined) delete process.env.MESSAGE_EVENT_INGEST_TOKEN;
  else process.env.MESSAGE_EVENT_INGEST_TOKEN = value;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.MESSAGE_EVENT_INGEST_TOKEN;
    else process.env.MESSAGE_EVENT_INGEST_TOKEN = previous;
  }
}

test('event auth requires a configured token of at least 32 bytes', () => {
  withToken('short-token', () => {
    const res = responseRecorder();
    expect(requireMessageEventToken({ headers: { authorization: 'Bearer short-token' } }, res)).toBe(false);
    expect(res).toMatchObject({ statusCode: 401, body: { code: 'MESSAGE_EVENT_AUTH_REQUIRED' } });
  });
  withToken('12345678901234567890123456789012', () => {
    const denied = responseRecorder();
    expect(requireMessageEventToken({ headers: { authorization: 'Bearer wrong' } }, denied)).toBe(false);
    expect(requireMessageEventToken({
      headers: { authorization: 'Bearer 12345678901234567890123456789012' },
    }, responseRecorder())).toBe(true);
  });
});

test('HTTP entry delegates hydration and queue semantics to the application owner', () => {
  const route = fs.readFileSync(new URL('../api/message-events.js', import.meta.url), 'utf8');
  const application = fs.readFileSync(new URL('../api/message-events/application.js', import.meta.url), 'utf8');
  expect(route).toContain("from './message-events/application.js'");
  expect(route).toContain('messageEventsApplication.ingest');
  expect(route).not.toContain('hydrateNewMessageTriggerEvent(supplied)');
  expect(route).not.toContain('enqueueMessageTriggerEvent(hydration');
  expect(route).not.toContain('No Etsy conversation is linked to this receipt');
  expect(application).toContain('async function ingest(');
  expect(application).toContain('hydrateNewMessageTriggerEvent(supplied)');
  expect(application).toContain('const event = hydration?.event || supplied;');
  expect(application).toContain('enqueueMessageTriggerEvent(event)');
  expect(application).toContain('scheduleImmediateMessageTriggerRun()');
  expect(application).toContain('supersedePendingNewMessageCandidates({');
});
