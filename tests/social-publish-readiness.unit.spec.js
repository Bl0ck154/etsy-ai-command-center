import { expect, test } from '@playwright/test';

import {
  createSocialPublishReadinessService,
  socialHermesCanaryReadinessForPost,
} from '../api/modules/social/index.js';
import {
  default as socialHandler,
  socialHermesCanaryReadinessForPost as readinessFromFacade,
  socialHermesRecordEligibleForAutoArmForTest,
} from '../api/social.js';

const FIXED_NOW = new Date('2026-08-09T12:00:00.000Z');

function mockResponse() {
  const captured = { statusCode: 200, payload: null };
  return {
    captured,
    res: {
      status(code) { captured.statusCode = code; return this; },
      json(payload) { captured.payload = payload; return payload; },
      end() { return undefined; },
      setHeader() {},
    },
  };
}

test('public readiness contract preserves facade payload and fails closed with explicit blockers', () => {
  const post = {
    id: 'blocked-readiness-contract',
    platform: 'all',
    status: 'draft',
    caption: '',
  };
  const options = {
    now: FIXED_NOW,
    minLeadMinutes: 5,
    socialConfigs: {},
    make: { url: '', source: null },
    governance: { autopublish_enabled: false, publish_now_available: false },
  };

  const readiness = socialHermesCanaryReadinessForPost(post, options);
  expect(readinessFromFacade(post, options)).toEqual(readiness);
  expect(readiness).toMatchObject({
    id: 'blocked-readiness-contract',
    platform: 'all',
    scheduled_at: null,
    status: 'draft',
    verdict: 'blocked',
    ready_for_canary_approval: false,
    ready_for_publish: false,
    ready_for_publish_when_due: false,
    owner_approval_required: false,
    publish_route: null,
    publish_governance: {
      autopublish_enabled: false,
      publish_now_available: false,
    },
    preview: { caption: '', media_items: [] },
  });
  expect(readiness.blockers.map(item => item.code)).toEqual(expect.arrayContaining([
    'PLATFORM_ALL_NOT_ALLOWED',
    'SCHEDULE_REQUIRED',
    'PUBLISH_ROUTE_NOT_CONFIGURED',
    'CAPTION_REQUIRED',
  ]));
});

test('application readiness loads configs, Make route and governance through DI', async () => {
  const calls = [];
  const service = createSocialPublishReadinessService({
    loadSocialConfigs: async () => ({ ig_config: { token: 'secret', user_id: 'ig_1' } }),
    loadMakeRoute: async () => ({ url: 'https://hook.example.test/pinterest', source: 'kv' }),
    getPublishGovernance: () => ({ autopublish_enabled: true, publish_now_available: true }),
    getScheduledPosts: async () => [],
    saveScheduledPost: async post => post,
    runPublishDueScheduled: async () => ({}),
    autoPublishOptInEnabled: () => false,
    autoPublishLeadMinutes: () => 720,
    readinessForPost: (post, options) => {
      calls.push({ post, options });
      return { id: post.id, verdict: 'blocked', blockers: [{ code: 'TEST_BLOCKER' }] };
    },
    clock: () => FIXED_NOW,
  });

  const result = await service.evaluatePost({ id: 'context-contract' }, {
    minLeadMinutes: 17,
    phase: 'publish',
  });

  expect(result).toEqual({ id: 'context-contract', verdict: 'blocked', blockers: [{ code: 'TEST_BLOCKER' }] });
  expect(calls).toHaveLength(1);
  expect(calls[0].options).toEqual({
    now: FIXED_NOW,
    minLeadMinutes: 17,
    phase: 'publish',
    socialConfigs: { ig_config: { token: 'secret', user_id: 'ig_1' } },
    make: { url: 'https://hook.example.test/pinterest', source: 'kv' },
    governance: { autopublish_enabled: true, publish_now_available: true },
  });
});

test('publish application auto-arms eligible records and preserves unknown scheduler outcomes', async () => {
  const saved = [];
  const readinessCalls = [];
  const eligible = {
    id: 'eligible-owner-review',
    source: 'social_hermes',
    platform: 'instagram',
    status: 'scheduled',
    scheduled_at: '2026-08-10T12:00:00.000Z',
    metadata: {
      owner_review_required: true,
      auto_publish_after_review_window: true,
    },
  };
  const skipped = { id: 'operator-draft', source: 'operator', status: 'draft', metadata: {} };
  const unknownSchedulerResult = {
    success: true,
    results: [{ id: 'unknown-publish', status: 'queued_external', publish_result: { status: 'unknown' } }],
  };
  const service = createSocialPublishReadinessService({
    loadSocialConfigs: async () => ({ ig_config: { token: 'secret', user_id: 'ig_1' } }),
    loadMakeRoute: async () => ({ url: '', source: null }),
    getPublishGovernance: () => ({ autopublish_enabled: true, publish_now_available: true }),
    getScheduledPosts: async () => [eligible, skipped],
    saveScheduledPost: async post => { saved.push(post); return post; },
    runPublishDueScheduled: async options => {
      const finalReadiness = await options.readinessCheck({ id: 'due-approved' }, { now: FIXED_NOW });
      expect(finalReadiness.ready_for_publish).toBe(true);
      return unknownSchedulerResult;
    },
    autoPublishOptInEnabled: () => true,
    autoPublishLeadMinutes: () => 720,
    readinessForPost: (post, options) => {
      readinessCalls.push({ id: post.id, phase: options.phase, minLeadMinutes: options.minLeadMinutes });
      return options.phase === 'publish'
        ? { id: post.id, verdict: 'approved_waiting_for_due', ready_for_publish: true, blockers: [] }
        : { id: post.id, verdict: 'ready_for_owner_approval', ready_for_canary_approval: true, blockers: [] };
    },
    clock: () => FIXED_NOW,
  });

  const result = await service.publishDueScheduled({
    dryRun: false,
    limit: 4,
    now: FIXED_NOW.toISOString(),
    canaryId: 'unknown-publish',
  });

  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    id: 'eligible-owner-review',
    status: 'approved_scheduled',
    approved_for_publish: true,
    approved_by: 'owner-opt-in:auto-schedule',
    approved_at: FIXED_NOW.toISOString(),
    approval_source: 'owner_opt_in_auto_schedule',
    metadata: {
      auto_publish_armed: true,
      auto_publish_armed_at: FIXED_NOW.toISOString(),
      auto_publish_policy: 'owner_opt_in_review_window_v1',
    },
  });
  expect(result.results).toEqual(unknownSchedulerResult.results);
  expect(result.auto_arm).toEqual({ armed_count: 1, blocked_count: 0, skipped_count: 1 });
  expect(readinessCalls).toEqual([
    { id: 'eligible-owner-review', phase: 'approval', minLeadMinutes: 720 },
    { id: 'due-approved', phase: 'publish', minLeadMinutes: 0 },
  ]);
  expect(socialHermesRecordEligibleForAutoArmForTest(eligible)).toBe(true);
});

test('dry-run publish skips auto-arm while retaining the final readiness callback', async () => {
  let queueLoaded = false;
  let readinessPhase = null;
  const service = createSocialPublishReadinessService({
    loadSocialConfigs: async () => ({}),
    loadMakeRoute: async () => ({ url: '', source: null }),
    getPublishGovernance: () => ({ autopublish_enabled: false, publish_now_available: false }),
    getScheduledPosts: async () => { queueLoaded = true; return []; },
    saveScheduledPost: async post => post,
    runPublishDueScheduled: async options => {
      await options.readinessCheck({ id: 'dry-run-record' }, { now: FIXED_NOW });
      return { dry_run: true, results: [] };
    },
    autoPublishOptInEnabled: () => true,
    autoPublishLeadMinutes: () => 720,
    readinessForPost: (_post, options) => {
      readinessPhase = options.phase;
      return { ready_for_publish: false, blockers: [{ code: 'DRY_RUN_BLOCKED' }] };
    },
    clock: () => FIXED_NOW,
  });

  await expect(service.publishDueScheduled({ dryRun: true })).resolves.toEqual({ dry_run: true, results: [] });
  expect(queueLoaded).toBe(false);
  expect(readinessPhase).toBe('publish');
});

test('HTTP facade delegates dry-run publishing without changing its scheduler payload', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    CRON_SECRET: process.env.CRON_SECRET,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
    AUTOPUBLISH: process.env.AUTOPUBLISH,
  };
  process.env.CRON_SECRET = 'readiness-cron-secret';
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  process.env.AUTOPUBLISH_ENABLED = 'false';
  process.env.AUTOPUBLISH = 'false';
  global.fetch = async url => {
    const command = new URL(String(url)).pathname.split('/').filter(Boolean)[0]?.toUpperCase();
    if (command === 'LRANGE') return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ result: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const { captured, res } = mockResponse();
    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer readiness-cron-secret' },
      query: {},
      body: {
        action: 'publishDueScheduled',
        dryRun: true,
        limit: 7,
        now: FIXED_NOW.toISOString(),
        canary_id: 'canary-contract',
      },
    }, res);

    expect(captured.statusCode).toBe(200);
    expect(captured.payload).toMatchObject({
      success: true,
      dryRun: true,
      autopublish_enabled: false,
      due_count: 0,
      results: [],
    });
    expect(captured.payload.auto_arm).toBeUndefined();
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
