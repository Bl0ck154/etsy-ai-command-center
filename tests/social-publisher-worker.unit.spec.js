import { expect, test } from '@playwright/test';

import { runSocialPublisherWorker } from '../workers/social-publisher.js';

test('Social publisher worker calls the public application interface with bounded input', async () => {
  const calls = [];
  const logs = [];
  const { result, summary } = await runSocialPublisherWorker({
    env: {
      SOCIAL_PUBLISHER_BATCH_LIMIT: '999',
      SOCIAL_PUBLISHER_DRY_RUN: 'true',
      SOCIAL_PUBLISHER_CANARY_ID: 'canary-1',
    },
    now: '2026-08-09T12:00:00.000Z',
    publishDue: async input => {
      calls.push(input);
      return {
        success: true,
        dryRun: true,
        publish_blocked: false,
        due_count: 2,
        results: [
          { id: 'one', success: true },
          { id: 'two', success: false, skipped: true },
        ],
      };
    },
    logger: { log: value => logs.push(JSON.parse(value)) },
  });

  expect(calls).toEqual([{
    dryRun: true,
    limit: 25,
    canaryId: 'canary-1',
    now: '2026-08-09T12:00:00.000Z',
  }]);
  expect(result.success).toBe(true);
  expect(summary).toMatchObject({
    component: 'social-publisher-worker',
    event: 'completed',
    due_count: 2,
    attempted_count: 2,
    published_count: 1,
    skipped_count: 1,
    failed_count: 0,
  });
  expect(logs).toHaveLength(1);
});

test('Social publisher worker defaults to a real bounded scheduler pass', async () => {
  let input;
  await runSocialPublisherWorker({
    env: {},
    publishDue: async value => {
      input = value;
      return { success: true, results: [] };
    },
    logger: { log() {} },
  });
  expect(input).toEqual({ dryRun: false, limit: 25, canaryId: null });
});
