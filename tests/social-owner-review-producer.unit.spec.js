import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import {
  asSocialOwnerReviewOnlyRecord,
  createSocialOwnerReviewProducerApplication,
} from '../api/modules/social/index.js';

function producerHarness(overrides = {}) {
  const calls = [];
  const statuses = [];
  const lease = {
    acquire: async input => {
      calls.push(['acquire', input]);
      return { acquired: true, token: 'lease-one' };
    },
    assertOwned: async () => true,
    release: async input => calls.push(['release', input]),
  };
  const dependencies = {
    lease,
    status: { write: async value => statuses.push(value) },
    collectContext: async input => {
      calls.push(['context', input]);
      return { listings: [{ listing_id: 'listing-1' }] };
    },
    selectOpportunities: async input => {
      calls.push(['opportunities', input]);
      return { opportunities: [{ id: 'opportunity-1' }] };
    },
    prepareOwnerReviewCampaign: async input => {
      calls.push(['prepare', input]);
      return {
        records: [{
          id: 'review-1',
          platform: 'instagram',
          approved_for_publish: true,
          approved_by: 'caller',
          metadata: {
            review_artifact_id: 'artifact-1',
            publish_approval_granted: true,
            auto_publish_armed: true,
          },
        }],
      };
    },
    saveReviewDrafts: async (records, execution) => {
      calls.push(['save', records, execution]);
      return { saved: records };
    },
    deliverReviewNotification: async (ids, execution) => {
      calls.push(['notify', ids, execution]);
      return { records: ids.map(id => ({ id })), count: ids.length };
    },
    clock: () => new Date('2026-08-09T12:00:00.000Z'),
    createRunId: () => 'producer-run-1',
    ...overrides,
  };
  return {
    calls,
    dependencies,
    statuses,
    producer: createSocialOwnerReviewProducerApplication(dependencies),
  };
}

test('direct Social producer application keeps generated records owner-review only', async () => {
  const { calls, producer, statuses } = producerHarness();

  const result = await producer.run({ runBudgetMs: 60_000, leaseTtlSeconds: 121 });

  const savedRecords = calls.find(call => call[0] === 'save')[1];
  expect(savedRecords).toEqual([expect.objectContaining({
    id: 'review-1',
    approved_for_publish: false,
    approved_by: null,
    approval_source: 'owner_review_required',
    metadata: expect.objectContaining({
      review_artifact_id: 'artifact-1',
      owner_review_required: true,
      publish_approval_granted: false,
      auto_publish_armed: false,
    }),
  })]);
  expect(calls.find(call => call[0] === 'notify')[1]).toEqual(['review-1']);
  expect(result).toMatchObject({
    success: true,
    status: 'completed',
    created_count: 1,
    blocked_count: 0,
    published: false,
  });
  expect(statuses.map(item => `${item.stage}:${item.status}`)).toEqual([
    'startup:running',
    'collect-context:running',
    'select-opportunities:running',
    'prepare-owner-review-campaign:running',
    'save-owner-review:running',
    'deliver-owner-review-notification:running',
    'completed:completed',
  ]);
  expect(calls.at(-1)[0]).toBe('release');
});

test('direct Social producer application skips an overlapping lease before side effects', async () => {
  const { calls, dependencies, statuses } = producerHarness();
  dependencies.lease.acquire = async input => {
    calls.push(['acquire', input]);
    return { acquired: false };
  };
  const producer = createSocialOwnerReviewProducerApplication(dependencies);

  const result = await producer.run({ runBudgetMs: 60_000, leaseTtlSeconds: 121 });

  expect(result).toEqual({
    success: true,
    status: 'skipped_overlap',
    run_id: 'producer-run-1',
    created_count: 0,
    blocked_count: 0,
    published: false,
  });
  expect(calls.map(call => call[0])).toEqual(['acquire']);
  expect(statuses).toEqual([]);
});

test('direct Social producer application requires a lease longer than its run budget', async () => {
  const { producer } = producerHarness();

  await expect(producer.run({ runBudgetMs: 60_000, leaseTtlSeconds: 60 })).rejects.toMatchObject({
    code: 'SOCIAL_PRODUCER_LEASE_TOO_SHORT',
  });
});

test('direct Social producer application requires ownership assertion and release dependencies', () => {
  const { dependencies } = producerHarness();
  expect(() => createSocialOwnerReviewProducerApplication({
    ...dependencies,
    lease: { acquire: dependencies.lease.acquire, release: dependencies.lease.release },
  })).toThrow(expect.objectContaining({ code: 'SOCIAL_PRODUCER_DEPENDENCY_REQUIRED' }));
  expect(() => createSocialOwnerReviewProducerApplication({
    ...dependencies,
    lease: { acquire: dependencies.lease.acquire, assertOwned: dependencies.lease.assertOwned },
  })).toThrow(expect.objectContaining({ code: 'SOCIAL_PRODUCER_DEPENDENCY_REQUIRED' }));
});

test('direct Social producer fences authoritative save and notification before and after side effects', async () => {
  const ownershipChecks = [];
  const { calls, dependencies } = producerHarness({
    lease: {
      acquire: async () => ({ acquired: true, token: 'lease-one' }),
      assertOwned: async () => {
        ownershipChecks.push('assert');
        return true;
      },
      release: async input => calls.push(['release', input]),
    },
  });
  const producer = createSocialOwnerReviewProducerApplication(dependencies);

  await producer.run({ runBudgetMs: 60_000, leaseTtlSeconds: 121 });

  expect(ownershipChecks).toHaveLength(4);
  const save = calls.find(call => call[0] === 'save');
  const notify = calls.find(call => call[0] === 'notify');
  expect(save[2].assert_ownership).toEqual(expect.any(Function));
  expect(notify[2].assert_ownership).toEqual(expect.any(Function));
});

test('authoritative writer can assert the propagated fence immediately before commit', async () => {
  let ownershipCheck = 0;
  let committed = false;
  const { calls, dependencies } = producerHarness({
    lease: {
      acquire: async () => ({ acquired: true, token: 'lease-one' }),
      assertOwned: async () => {
        ownershipCheck += 1;
        if (ownershipCheck === 2) {
          throw Object.assign(new Error('lease replaced'), { code: 'SOCIAL_PRODUCER_LEASE_LOST' });
        }
        return true;
      },
      release: async input => calls.push(['release', input]),
    },
    saveReviewDrafts: async (records, execution) => {
      await execution.assert_ownership();
      committed = true;
      return { saved: records };
    },
  });
  const producer = createSocialOwnerReviewProducerApplication(dependencies);

  await expect(producer.run({ runBudgetMs: 60_000, leaseTtlSeconds: 121 })).rejects.toMatchObject({
    code: 'SOCIAL_PRODUCER_LEASE_LOST',
  });
  expect(committed).toBe(false);
  expect(calls.some(call => call[0] === 'notify')).toBe(false);
});

test('direct Social producer application persists aborted status and releases its lease', async () => {
  const abortController = new AbortController();
  abortController.abort(Object.assign(new Error('operator shutdown'), { code: 'SOCIAL_PRODUCER_ABORTED' }));
  const { calls, producer, statuses } = producerHarness();

  await expect(producer.run({
    runBudgetMs: 60_000,
    leaseTtlSeconds: 121,
    signal: abortController.signal,
  })).rejects.toMatchObject({ code: 'SOCIAL_PRODUCER_ABORTED' });

  expect(calls.map(call => call[0])).toEqual(['acquire', 'release']);
  expect(statuses.at(-1)).toMatchObject({
    stage: 'shutdown',
    status: 'aborted',
    published: false,
    error: { code: 'SOCIAL_PRODUCER_ABORTED' },
  });
});

test('direct Social producer application keeps its lease until an aborted stage is quiescent', async () => {
  let settleContext;
  const { calls, dependencies, statuses } = producerHarness({
    collectContext: async () => new Promise(resolve => { settleContext = resolve; }),
  });
  const producer = createSocialOwnerReviewProducerApplication(dependencies);

  await expect(producer.run({ runBudgetMs: 20, leaseTtlSeconds: 61 })).rejects.toMatchObject({
    code: 'SOCIAL_PRODUCER_DEADLINE_EXCEEDED',
  });

  expect(calls.map(call => call[0])).toEqual(['acquire']);
  expect(statuses.at(-1)).toMatchObject({
    stage: 'shutdown',
    status: 'aborted',
    error: { code: 'SOCIAL_PRODUCER_DEADLINE_EXCEEDED' },
    lease_release_deferred: true,
  });

  settleContext({});
  await expect.poll(() => calls.map(call => call[0])).toEqual(['acquire', 'release']);
});

test('direct Social producer application bounds a hanging status adapter and releases its lease', async () => {
  const { calls, dependencies } = producerHarness({
    status: { write: async () => new Promise(() => {}) },
    statusWriteTimeoutMs: 20,
  });
  const producer = createSocialOwnerReviewProducerApplication(dependencies);

  await expect(producer.run({ runBudgetMs: 20, leaseTtlSeconds: 61 })).rejects.toMatchObject({
    code: 'SOCIAL_PRODUCER_DEADLINE_EXCEEDED',
  });

  expect(calls.map(call => call[0])).toEqual(['acquire', 'release']);
});

test('direct Social producer application bounds a hanging best-effort lease release', async () => {
  const { calls, dependencies } = producerHarness({ statusWriteTimeoutMs: 20 });
  dependencies.lease.release = async input => {
    calls.push(['release', input]);
    return new Promise(() => {});
  };
  const producer = createSocialOwnerReviewProducerApplication(dependencies);

  const result = await Promise.race([
    producer.run({ runBudgetMs: 60_000, leaseTtlSeconds: 121 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('producer release did not stay bounded')), 500)),
  ]);

  expect(result).toMatchObject({ success: true, status: 'completed', created_count: 1 });
  expect(calls.at(-1)[0]).toBe('release');
});

test('direct Social producer application reports a saved draft when notification fails', async () => {
  const { calls, dependencies, statuses } = producerHarness({
    deliverReviewNotification: async () => {
      throw Object.assign(new Error('notification unavailable'), { code: 'SOCIAL_OWNER_NOTIFICATION_FAILED' });
    },
  });
  const producer = createSocialOwnerReviewProducerApplication(dependencies);

  await expect(producer.run({ runBudgetMs: 60_000, leaseTtlSeconds: 121 })).rejects.toMatchObject({
    code: 'SOCIAL_OWNER_NOTIFICATION_FAILED',
  });

  expect(calls.some(call => call[0] === 'save')).toBe(true);
  expect(statuses.at(-1)).toMatchObject({
    stage: 'deliver-owner-review-notification',
    status: 'failed',
    created_count: 1,
    partial_completion: true,
    created_ids: ['review-1'],
  });
  expect(calls.at(-1)[0]).toBe('release');
});

test('owner-review-only normalization preserves review artifacts but removes publish trust', () => {
  expect(asSocialOwnerReviewOnlyRecord({
    id: 'review-contract',
    approved_for_publish: true,
    metadata: {
      review_artifact_id: 'artifact-contract',
      publish_approval_granted: true,
      auto_publish_armed: true,
    },
  })).toMatchObject({
    id: 'review-contract',
    approved_for_publish: false,
    metadata: {
      review_artifact_id: 'artifact-contract',
      publish_approval_granted: false,
      auto_publish_armed: false,
    },
  });
});

test('direct Social producer application boundary has no Express, browser, or HTTP facade dependency', () => {
  const source = readFileSync(new URL('../api/modules/social/application/produce-owner-review.js', import.meta.url), 'utf8');
  expect(source).not.toMatch(/api\/social|express|\breq\b|\bres\b|public\/pages|fetch\s*\(/i);
});
