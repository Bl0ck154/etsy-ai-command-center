import crypto from 'node:crypto';

export const SOCIAL_OWNER_REVIEW_PRODUCER_MAX_RUN_BUDGET_MS = 45 * 60 * 1000;
export const SOCIAL_OWNER_REVIEW_PRODUCER_DEFAULT_RUN_BUDGET_MS = 40 * 60 * 1000;
const SOCIAL_OWNER_REVIEW_PRODUCER_DEFAULT_STATUS_WRITE_TIMEOUT_MS = 1_000;
const SOCIAL_OWNER_REVIEW_PRODUCER_MAX_STATUS_WRITE_TIMEOUT_MS = 5_000;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function asArray(value, key) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value[key])) return value[key];
  return [];
}

function errorSummary(error) {
  return {
    code: String(error?.code || 'SOCIAL_PRODUCER_FAILED').slice(0, 120),
    message: String(error?.message || error || 'Social producer failed').slice(0, 500),
  };
}

function instant(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw codedError('SOCIAL_PRODUCER_CLOCK_INVALID', 'Social producer clock returned an invalid instant.');
  }
  return date;
}

async function awaitWithAbort(promise, signal) {
  if (signal.aborted) throw signal.reason;
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(signal.reason);
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', abortListener);
  }
}

async function awaitWithTimeout(promise, timeoutMs, error) {
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(error), timeoutMs);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generation and planning may prepare an owner-review record, but they never
 * grant publication trust. The owner-review application service remains the
 * authoritative writer and may independently add a review-window schedule.
 */
export function asSocialOwnerReviewOnlyRecord(record = {}) {
  const metadata = record?.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata
    : {};
  return {
    ...record,
    approved_for_publish: false,
    approved_by: null,
    approved_at: null,
    approval_note: null,
    approval_source: 'owner_review_required',
    metadata: {
      ...metadata,
      owner_review_required: true,
      owner_notification_required: true,
      publish_approval_granted: false,
      auto_publish_armed: false,
    },
  };
}

/**
 * Plain-data orchestration boundary for the future direct Social producer.
 *
 * This factory deliberately has no default composition. Until opportunity
 * selection and creative/media preparation are public Social application
 * implementations, constructing it requires explicit dependencies and cannot
 * create a second production producer by being imported.
 */
export function createSocialOwnerReviewProducerApplication({
  lease,
  status,
  collectContext,
  selectOpportunities,
  prepareOwnerReviewCampaign,
  saveReviewDrafts,
  deliverReviewNotification,
  clock = () => new Date(),
  createRunId = () => `social-producer-${crypto.randomUUID()}`,
  statusWriteTimeoutMs = SOCIAL_OWNER_REVIEW_PRODUCER_DEFAULT_STATUS_WRITE_TIMEOUT_MS,
} = {}) {
  const required = {
    'lease.acquire': lease?.acquire,
    'lease.assertOwned': lease?.assertOwned,
    'lease.release': lease?.release,
    'status.write': status?.write,
    collectContext,
    selectOpportunities,
    prepareOwnerReviewCampaign,
    saveReviewDrafts,
    deliverReviewNotification,
  };
  for (const [name, dependency] of Object.entries(required)) {
    if (typeof dependency !== 'function') {
      throw codedError('SOCIAL_PRODUCER_DEPENDENCY_REQUIRED', `${name} dependency is required.`);
    }
  }

  const run = async ({
    input = {},
    signal: callerSignal,
    runBudgetMs = SOCIAL_OWNER_REVIEW_PRODUCER_DEFAULT_RUN_BUDGET_MS,
    leaseTtlSeconds,
    maxCandidates = 2,
  } = {}) => {
    const boundedRunBudgetMs = positiveInteger(
      runBudgetMs,
      SOCIAL_OWNER_REVIEW_PRODUCER_DEFAULT_RUN_BUDGET_MS,
      SOCIAL_OWNER_REVIEW_PRODUCER_MAX_RUN_BUDGET_MS,
    );
    const minimumLeaseTtlSeconds = Math.ceil(boundedRunBudgetMs / 1000) + 60;
    const boundedLeaseTtlSeconds = positiveInteger(
      leaseTtlSeconds,
      minimumLeaseTtlSeconds,
      Math.ceil(SOCIAL_OWNER_REVIEW_PRODUCER_MAX_RUN_BUDGET_MS / 1000) + 300,
    );
    if (boundedLeaseTtlSeconds < minimumLeaseTtlSeconds) {
      throw codedError(
        'SOCIAL_PRODUCER_LEASE_TOO_SHORT',
        'Social producer lease TTL must outlive the bounded run budget.',
      );
    }
    const boundedStatusWriteTimeoutMs = positiveInteger(
      statusWriteTimeoutMs,
      SOCIAL_OWNER_REVIEW_PRODUCER_DEFAULT_STATUS_WRITE_TIMEOUT_MS,
      SOCIAL_OWNER_REVIEW_PRODUCER_MAX_STATUS_WRITE_TIMEOUT_MS,
    );

    const runId = String(createRunId()).trim();
    if (!runId) throw codedError('SOCIAL_PRODUCER_RUN_ID_REQUIRED', 'Social producer run id is required.');
    const startedAt = instant(clock);
    const deadlineAt = new Date(startedAt.getTime() + boundedRunBudgetMs);
    const leaseResult = await lease.acquire({
      run_id: runId,
      started_at: startedAt.toISOString(),
      deadline_at: deadlineAt.toISOString(),
      ttl_seconds: boundedLeaseTtlSeconds,
    });
    const acquired = leaseResult === true || leaseResult?.acquired === true;
    if (!acquired) {
      return {
        success: true,
        status: 'skipped_overlap',
        run_id: runId,
        created_count: 0,
        blocked_count: 0,
        published: false,
      };
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(
      callerSignal?.reason || codedError('SOCIAL_PRODUCER_ABORTED', 'Social producer was aborted.'),
    );
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener?.('abort', abortFromCaller, { once: true });
    const deadlineTimer = setTimeout(() => controller.abort(codedError(
      'SOCIAL_PRODUCER_DEADLINE_EXCEEDED',
      `Social producer exceeded its ${boundedRunBudgetMs}ms run budget.`,
    )), boundedRunBudgetMs);

    const baseState = {
      component: 'social-owner-review-producer',
      run_id: runId,
      started_at: startedAt.toISOString(),
      deadline_at: deadlineAt.toISOString(),
      published: false,
    };
    let stage = 'startup';
    let createdCount = 0;
    let blockedCount = 0;
    const created = [];
    let activeStage = null;
    let leaseReleased = false;
    let statusSequence = 0;

    const releaseLease = async () => {
      if (leaseReleased) return;
      leaseReleased = true;
      try {
        await awaitWithTimeout(
          Promise.resolve().then(() => lease.release(leaseResult, { run_id: runId })),
          boundedStatusWriteTimeoutMs,
          codedError('SOCIAL_PRODUCER_LEASE_RELEASE_TIMEOUT', 'Social producer lease release timed out.'),
        );
      } catch {
        // The lease TTL remains the final exactly-one guard if a best-effort
        // release cannot complete during shutdown.
      }
    };

    const assertLeaseOwnership = () => awaitWithTimeout(
      Promise.resolve().then(() => lease.assertOwned(leaseResult, { run_id: runId })),
      boundedStatusWriteTimeoutMs,
      codedError('SOCIAL_PRODUCER_OWNERSHIP_ASSERTION_TIMEOUT', 'Social producer ownership assertion timed out.'),
    );

    const writeStatus = async (nextStatus, extra = {}, { terminal = false } = {}) => {
      statusSequence += 1;
      const writePromise = Promise.resolve().then(() => status.write({
        ...baseState,
        stage,
        status: nextStatus,
        updated_at: instant(clock).toISOString(),
        created_count: createdCount,
        blocked_count: blockedCount,
        ...extra,
        sequence: statusSequence,
      }, leaseResult));
      if (!terminal) return awaitWithAbort(writePromise, controller.signal);
      return awaitWithTimeout(
        writePromise,
        boundedStatusWriteTimeoutMs,
        codedError('SOCIAL_PRODUCER_STATUS_WRITE_TIMEOUT', 'Social producer terminal status write timed out.'),
      );
    };

    const executeStage = async (name, operation, { authoritative = false } = {}) => {
      stage = name;
      if (controller.signal.aborted) throw controller.signal.reason;
      await writeStatus('running');
      if (controller.signal.aborted) throw controller.signal.reason;
      const state = { settled: false, promise: null };
      state.promise = Promise.resolve().then(async () => {
        if (authoritative) await assertLeaseOwnership();
        let result;
        let operationError;
        try {
          result = await operation({
            signal: controller.signal,
            run_id: runId,
            deadline_at: deadlineAt.toISOString(),
            assert_ownership: assertLeaseOwnership,
          });
        } catch (error) {
          operationError = error;
        }
        if (authoritative) await assertLeaseOwnership();
        if (operationError) throw operationError;
        return result;
      });
      state.promise.then(
        () => { state.settled = true; },
        () => { state.settled = true; },
      );
      activeStage = state;
      try {
        return await awaitWithAbort(state.promise, controller.signal);
      } finally {
        if (state.settled && activeStage === state) activeStage = null;
      }
    };

    try {
      await writeStatus('running');
      const context = await executeStage('collect-context', execution => collectContext({
        input,
        ...execution,
      }));
      const selected = await executeStage('select-opportunities', execution => selectOpportunities({
        input,
        context,
        ...execution,
      }));
      const opportunities = asArray(selected, 'opportunities').slice(0, positiveInteger(maxCandidates, 2, 8));
      const blocked = [];

      for (const opportunity of opportunities) {
        let prepared;
        try {
          prepared = await executeStage('prepare-owner-review-campaign', execution => prepareOwnerReviewCampaign({
            input,
            context,
            opportunity,
            ...execution,
          }));
        } catch (error) {
          if (controller.signal.aborted) throw error;
          blocked.push({ opportunity, error: errorSummary(error) });
          blockedCount = blocked.length;
          continue;
        }
        const records = asArray(prepared, 'records').map(asSocialOwnerReviewOnlyRecord);
        if (!records.length) {
          blocked.push({
            opportunity,
            error: { code: 'SOCIAL_PRODUCER_CAMPAIGN_BLOCKED', message: 'Campaign preparation returned no owner-review records.' },
          });
          blockedCount = blocked.length;
          continue;
        }
        const savedResult = await executeStage(
          'save-owner-review',
          execution => saveReviewDrafts(records, execution),
          { authoritative: true },
        );
        if (savedResult?.validation_problem) {
          blocked.push({ opportunity, error: savedResult.validation_problem });
          blockedCount = blocked.length;
          continue;
        }
        const saved = asArray(savedResult, 'saved');
        const ids = saved.map(record => String(record?.id || '').trim()).filter(Boolean);
        if (!ids.length || saved.some(record => record?.approved_for_publish === true || record?.metadata?.publish_approval_granted === true)) {
          throw codedError(
            'SOCIAL_PRODUCER_OWNER_REVIEW_CONTRACT_VIOLATION',
            'Owner-review persistence returned no ids or granted publication approval.',
          );
        }
        created.push(...saved);
        createdCount = created.length;
        await executeStage(
          'deliver-owner-review-notification',
          execution => deliverReviewNotification(ids, execution),
          { authoritative: true },
        );
      }

      stage = 'completed';
      await writeStatus('completed', { finished_at: instant(clock).toISOString() }, { terminal: true });
      return {
        success: true,
        status: 'completed',
        run_id: runId,
        created,
        blocked,
        created_count: createdCount,
        blocked_count: blockedCount,
        published: false,
      };
    } catch (error) {
      const failure = errorSummary(error);
      stage = controller.signal.aborted ? 'shutdown' : stage;
      await writeStatus(controller.signal.aborted ? 'aborted' : 'failed', {
        error: failure,
        finished_at: instant(clock).toISOString(),
        partial_completion: createdCount > 0,
        created_ids: created.map(record => String(record?.id || '').trim()).filter(Boolean),
        lease_release_deferred: Boolean(activeStage && !activeStage.settled),
      }, { terminal: true }).catch(() => {});
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), { code: failure.code });
    } finally {
      clearTimeout(deadlineTimer);
      callerSignal?.removeEventListener?.('abort', abortFromCaller);
      if (activeStage && !activeStage.settled) {
        // The run may return at its deadline, but a non-cooperative stage can
        // still be executing. Keep the exactly-one lease until that stage is
        // quiescent; if the process exits first, the lease TTL is the guard.
        activeStage.promise.then(releaseLease, releaseLease).catch(() => {});
      } else {
        await releaseLease();
      }
    }
  };

  return { run };
}
