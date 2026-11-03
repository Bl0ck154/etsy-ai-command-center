import { createSocialOwnerReviewProducerApplication } from './application/produce-owner-review.js';

function requireMethod(owner, method, name) {
  if (!owner || typeof owner[method] !== 'function') {
    throw new TypeError(`${name} dependency is required`);
  }
  return (...args) => owner[method](...args);
}

/**
 * Worker-independent composition seam for the future direct Social producer.
 *
 * This module deliberately does not create a worker, timer, HTTP route or
 * default producer instance. The Python/Hermes producer remains authoritative
 * until campaign preparation is migrated and an isolated producer cutover is
 * explicitly completed.
 *
 * The composition maps existing Social application services into the bounded
 * producer lifecycle and propagates its ownership fence immediately before the
 * authoritative queue and Telegram side effects.
 */
export function createSocialOwnerReviewProducerComposition({
  runRepository,
  contextService,
  opportunityService,
  campaignService,
  ownerReviewService,
  validateRecord,
  producerOptions = {},
} = {}) {
  const acquire = requireMethod(runRepository?.lease, 'acquire', 'runRepository.lease.acquire');
  const assertOwned = requireMethod(runRepository?.lease, 'assertOwned', 'runRepository.lease.assertOwned');
  const release = requireMethod(runRepository?.lease, 'release', 'runRepository.lease.release');
  const writeStatus = requireMethod(runRepository?.status, 'write', 'runRepository.status.write');
  const refreshShopContext = requireMethod(contextService, 'refreshShopContext', 'contextService.refreshShopContext');
  const selectContentOpportunities = requireMethod(
    opportunityService,
    'selectContentOpportunities',
    'opportunityService.selectContentOpportunities',
  );
  const prepareOwnerReviewCampaign = requireMethod(
    campaignService,
    'prepareOwnerReviewCampaign',
    'campaignService.prepareOwnerReviewCampaign',
  );
  const saveReviewDrafts = requireMethod(ownerReviewService, 'saveReviewDrafts', 'ownerReviewService.saveReviewDrafts');
  const deliverReviewNotification = requireMethod(
    ownerReviewService,
    'deliverReviewNotification',
    'ownerReviewService.deliverReviewNotification',
  );

  return createSocialOwnerReviewProducerApplication({
    ...producerOptions,
    lease: { acquire, assertOwned, release },
    status: { write: writeStatus },
    collectContext: ({ input, ...execution }) => refreshShopContext({ input, ...execution }),
    selectOpportunities: ({ input, context, ...execution }) => selectContentOpportunities({
      ...input,
      autonomous_context: context,
      ...execution,
    }),
    prepareOwnerReviewCampaign: input => prepareOwnerReviewCampaign(input),
    saveReviewDrafts: async (records, execution) => {
      await execution.assert_ownership();
      return saveReviewDrafts(records, {
        validateRecord,
        producer_execution: execution,
      });
    },
    deliverReviewNotification: async (ids, execution) => {
      await execution.assert_ownership();
      return deliverReviewNotification(ids, {
        producer_execution: execution,
      });
    },
  });
}
