import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { createSocialOwnerReviewProducerComposition } from '../api/modules/social/index.js';

function compositionHarness() {
  const calls = [];
  const statuses = [];
  let ownershipChecks = 0;
  const runRepository = {
    lease: {
      acquire: async input => {
        calls.push(['lease.acquire', input]);
        return { acquired: true, token: 'composition-lease' };
      },
      assertOwned: async () => {
        ownershipChecks += 1;
        return true;
      },
      release: async lease => {
        calls.push(['lease.release', lease]);
        return true;
      },
    },
    status: {
      write: async value => statuses.push(value),
    },
  };
  const contextService = {
    refreshShopContext: async input => {
      calls.push(['context.refresh', input]);
      return { listings: [{ listing_id: 'listing-1', title: 'Listing one' }] };
    },
  };
  const opportunityService = {
    selectContentOpportunities: async input => {
      calls.push(['opportunities.select', input]);
      return { opportunities: [{ id: 'opportunity-1', listing_id: 'listing-1' }] };
    },
  };
  const campaignService = {
    prepareOwnerReviewCampaign: async input => {
      calls.push(['campaign.prepare', input]);
      return {
        records: [{
          id: 'campaign-record-1',
          source: 'social_hermes',
          platform: 'instagram',
          approved_for_publish: true,
          approved_by: 'forged-caller',
          metadata: {
            campaign_id: 'campaign-1',
            publish_approval_granted: true,
            auto_publish_armed: true,
          },
        }],
      };
    },
  };
  const ownerReviewService = {
    saveReviewDrafts: async (records, options) => {
      calls.push(['owner-review.save', records, options]);
      return { saved: records, validation_problem: null };
    },
    deliverReviewNotification: async (ids, options) => {
      calls.push(['owner-review.notify', ids, options]);
      return { records: ids.map(id => ({ id })), count: ids.length };
    },
  };
  const validateRecord = () => null;
  const producer = createSocialOwnerReviewProducerComposition({
    runRepository,
    contextService,
    opportunityService,
    campaignService,
    ownerReviewService,
    validateRecord,
    producerOptions: {
      clock: () => new Date('2026-08-13T10:00:00.000Z'),
      createRunId: () => 'composition-run-1',
    },
  });
  return {
    calls,
    statuses,
    producer,
    validateRecord,
    ownershipChecks: () => ownershipChecks,
  };
}

test('owner-review producer composition is inert until explicitly run', () => {
  const { calls, statuses } = compositionHarness();
  expect(calls).toEqual([]);
  expect(statuses).toEqual([]);
});

test('owner-review producer composition wires module services without granting publish trust', async () => {
  const { calls, producer, statuses, validateRecord, ownershipChecks } = compositionHarness();

  const result = await producer.run({
    input: { platforms: ['instagram'], max_opportunities: 1 },
    runBudgetMs: 60_000,
    leaseTtlSeconds: 121,
  });

  expect(result).toMatchObject({
    success: true,
    status: 'completed',
    created_count: 1,
    blocked_count: 0,
    published: false,
  });
  const selected = calls.find(call => call[0] === 'opportunities.select');
  expect(selected[1]).toMatchObject({
    platforms: ['instagram'],
    max_opportunities: 1,
    autonomous_context: { listings: [{ listing_id: 'listing-1', title: 'Listing one' }] },
    run_id: 'composition-run-1',
  });

  const saved = calls.find(call => call[0] === 'owner-review.save');
  expect(saved[1]).toEqual([expect.objectContaining({
    id: 'campaign-record-1',
    approved_for_publish: false,
    approved_by: null,
    approval_source: 'owner_review_required',
    metadata: expect.objectContaining({
      campaign_id: 'campaign-1',
      owner_review_required: true,
      owner_notification_required: true,
      publish_approval_granted: false,
      auto_publish_armed: false,
    }),
  })]);
  expect(saved[2]).toMatchObject({
    validateRecord,
    producer_execution: expect.objectContaining({
      run_id: 'composition-run-1',
      assert_ownership: expect.any(Function),
    }),
  });

  const notified = calls.find(call => call[0] === 'owner-review.notify');
  expect(notified[1]).toEqual(['campaign-record-1']);
  expect(notified[2].producer_execution.assert_ownership).toEqual(expect.any(Function));
  expect(ownershipChecks()).toBe(6);
  expect(statuses.at(-1)).toMatchObject({
    stage: 'completed',
    status: 'completed',
    published: false,
  });
  expect(calls.at(-1)[0]).toBe('lease.release');
});

test('owner-review producer composition fails at construction when a production boundary is missing', () => {
  expect(() => createSocialOwnerReviewProducerComposition({
    runRepository: {
      lease: { acquire() {}, assertOwned() {}, release() {} },
      status: { write() {} },
    },
    contextService: { refreshShopContext() {} },
    opportunityService: { selectContentOpportunities() {} },
    campaignService: {},
    ownerReviewService: { saveReviewDrafts() {}, deliverReviewNotification() {} },
  })).toThrow('campaignService.prepareOwnerReviewCampaign dependency is required');
});

test('owner-review producer composition has no Express, HTTP facade, worker or publisher dependency', () => {
  const source = readFileSync(new URL('../api/modules/social/owner-review-producer-composition.js', import.meta.url), 'utf8');
  expect(source).not.toMatch(/api\/social|express|\breq\b|\bres\b|workers\/|social-publisher|publishDue|fetch\s*\(/i);
});
