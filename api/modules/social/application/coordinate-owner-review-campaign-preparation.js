import { buildSocialOwnerReviewGenerationRequest } from './build-owner-review-generation-request.js';
import { applySocialOwnerReviewCreativePlanRefresh } from './build-owner-review-plan-input.js';
import {
  collectSocialOwnerReviewGenerationBatchOutcomes,
  mergeSocialOwnerReviewGeneratedMediaByBrief,
  mergeSocialOwnerReviewGenerationDiagnostics,
  mergeSocialOwnerReviewGenerationFailures,
  pendingSocialOwnerReviewGenerationBriefs,
  preserveSocialOwnerReviewApprovedMediaForReplan,
  reconcileSocialOwnerReviewGeneratedMediaWithAiDecisions,
  socialOwnerReviewGenerationRequestFingerprint,
  updateSocialOwnerReviewGenerationResolutionContext,
} from './owner-review-generation-state.js';
import {
  recordSocialOwnerReviewSuccessfulReviewCardRenderSpecs,
  socialOwnerReviewReviewCardRepairProblem,
} from '../domain/review-card-repair-contract.js';

export const SOCIAL_OWNER_REVIEW_GENERATION_ROUND_LIMIT = 3;
export const SOCIAL_OWNER_REVIEW_GENERATION_CONCURRENCY = 3;
export const SOCIAL_OWNER_REVIEW_MIN_PROVIDER_BUDGET_MS = 120_000;
export const SOCIAL_OWNER_REVIEW_MIN_REPLAN_BUDGET_MS = 30_000;
export const SOCIAL_OWNER_REVIEW_GENERATE_MEDIA_TIMEOUT_MS = 600_000;
export const SOCIAL_OWNER_REVIEW_CREATIVE_PLAN_TIMEOUT_MS = 900_000;

function text(value) {
  return String(value ?? '').trim();
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function boundedInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function requireMethod(owner, method, name) {
  if (!owner || typeof owner[method] !== 'function') throw new TypeError(`${name} dependency is required`);
  return (...args) => owner[method](...args);
}

function clockMillis(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw codedError('SOCIAL_OWNER_REVIEW_CLOCK_INVALID', 'Campaign preparation clock returned an invalid instant.');
  }
  return date.getTime();
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return codedError('SOCIAL_OWNER_REVIEW_PREPARATION_ABORTED', 'Owner-review campaign preparation was aborted.');
}

function generationExecutionFailure(error) {
  return {
    success: false,
    code: text(error?.code || 'GENERATION_EXECUTION_EXCEPTION'),
    error: text(error?.message || error || 'Media generation failed.').slice(0, 500),
  };
}

function generationApplicationResponse(response) {
  const direct = plainObject(response) || {};
  if (plainObject(direct.data)) return direct;
  return {
    success: direct.success === true,
    code: text(direct.code),
    error: text(direct.error),
    data: direct,
  };
}

async function executeBoundedInOrder(items, concurrency, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Bounded creativePlan -> generateMedia -> creativePlan replan coordinator.
 *
 * All creative choices remain owned by creativePlan. This coordinator executes
 * only exact pending briefs, collects a complete independent batch before an AI
 * replan, and has no persistence, notification, publication, worker, or timer lifecycle.
 */
export function createSocialOwnerReviewCampaignPreparationCoordinator({
  creativePlanService,
  mediaGenerationService,
  planValidator,
  clock = () => new Date(),
  generationRoundLimit = SOCIAL_OWNER_REVIEW_GENERATION_ROUND_LIMIT,
  maxPostGenerationReplans = SOCIAL_OWNER_REVIEW_GENERATION_ROUND_LIMIT,
  generationConcurrency = SOCIAL_OWNER_REVIEW_GENERATION_CONCURRENCY,
  minProviderBudgetMs = SOCIAL_OWNER_REVIEW_MIN_PROVIDER_BUDGET_MS,
  minReplanBudgetMs = SOCIAL_OWNER_REVIEW_MIN_REPLAN_BUDGET_MS,
  generateMediaTimeoutMs = SOCIAL_OWNER_REVIEW_GENERATE_MEDIA_TIMEOUT_MS,
  creativePlanTimeoutMs = SOCIAL_OWNER_REVIEW_CREATIVE_PLAN_TIMEOUT_MS,
  deadlineReserveMs = 1_000,
} = {}) {
  const planCreativeCampaign = requireMethod(
    creativePlanService,
    'planCreativeCampaign',
    'creativePlanService.planCreativeCampaign',
  );
  const generateMedia = requireMethod(mediaGenerationService, 'generateMedia', 'mediaGenerationService.generateMedia');
  const validatePlan = requireMethod(planValidator, 'validate', 'planValidator.validate');
  const roundLimit = Math.min(
    boundedInteger(generationRoundLimit, SOCIAL_OWNER_REVIEW_GENERATION_ROUND_LIMIT, 3),
    boundedInteger(maxPostGenerationReplans, SOCIAL_OWNER_REVIEW_GENERATION_ROUND_LIMIT, 3),
  );
  const concurrency = boundedInteger(generationConcurrency, SOCIAL_OWNER_REVIEW_GENERATION_CONCURRENCY, 3);
  const providerBudget = Math.max(30_000, Number(minProviderBudgetMs) || SOCIAL_OWNER_REVIEW_MIN_PROVIDER_BUDGET_MS);
  const replanBudget = Math.max(5_000, Number(minReplanBudgetMs) || SOCIAL_OWNER_REVIEW_MIN_REPLAN_BUDGET_MS);
  const providerTimeout = Math.max(5_000, Math.min(900_000, Number(generateMediaTimeoutMs) || SOCIAL_OWNER_REVIEW_GENERATE_MEDIA_TIMEOUT_MS));
  const planTimeout = Math.max(5_000, Math.min(900_000, Number(creativePlanTimeoutMs) || SOCIAL_OWNER_REVIEW_CREATIVE_PLAN_TIMEOUT_MS));
  const reserve = Math.max(0, Math.min(30_000, Number(deadlineReserveMs) || 0));

  const prepare = async ({
    planBody = {},
    listing = {},
    opportunity = {},
    platforms = [],
    signal,
    deadline_at: deadlineAt,
    publicBaseUrl = '',
  } = {}) => {
    if (!plainObject(planBody)) {
      throw codedError('SOCIAL_OWNER_REVIEW_PLAN_INPUT_INVALID', 'Owner-review creativePlan input must be a plain object.');
    }
    const deadlineMs = new Date(deadlineAt).getTime();
    if (!Number.isFinite(deadlineMs)) {
      throw codedError(
        'SOCIAL_OWNER_REVIEW_DEADLINE_REQUIRED',
        'Owner-review campaign preparation requires the producer deadline_at execution field.',
      );
    }
    const remainingMs = () => deadlineMs - clockMillis(clock);
    const assertExecution = (minimumMs, code, operation) => {
      if (signal?.aborted) throw abortError(signal);
      const remaining = remainingMs();
      if (remaining < minimumMs + reserve) {
        throw codedError(
          code,
          `${operation} requires at least ${minimumMs}ms plus ${reserve}ms deadline reserve; ${Math.max(0, remaining)}ms remains.`,
          { remaining_ms: Math.max(0, remaining), required_ms: minimumMs, deadline_reserve_ms: reserve },
        );
      }
      return remaining;
    };

    const validateExactPlan = plan => {
      const result = validatePlan({ plan, platforms, planBody, listing, opportunity });
      if (result === true || result?.valid === true) return;
      const problem = text(typeof result === 'string' ? result : result?.problem)
        || 'creative planner returned an incomplete AI strategy';
      throw codedError(
        'SOCIAL_OWNER_REVIEW_STRATEGY_INVALID',
        `${problem}; producer will not invent a local media strategy.`,
        { problems: Array.isArray(result?.problems) ? result.problems : [] },
      );
    };

    const callCreativePlan = async minimumBudgetMs => {
      const remaining = assertExecution(
        minimumBudgetMs,
        'SOCIAL_OWNER_REVIEW_REPLAN_BUDGET_INSUFFICIENT',
        'AI creative planning',
      );
      const plan = await planCreativeCampaign(planBody, {
        publicBaseUrl,
        signal,
        deadline_at: new Date(deadlineMs).toISOString(),
        timeout_ms: Math.max(5_000, Math.min(planTimeout, remaining - reserve)),
      });
      if (signal?.aborted) throw abortError(signal);
      if (!plainObject(plan)) {
        throw codedError('SOCIAL_OWNER_REVIEW_PLAN_INVALID', 'creativePlan returned an invalid plan.');
      }
      applySocialOwnerReviewCreativePlanRefresh(planBody, plan);
      validateExactPlan(plan);
      return plan;
    };

    let plan = await callCreativePlan(replanBudget);
    let generationRound = 0;
    let generatedMedia = [];
    let failedBriefs = [];
    let generationDiagnostics = [];
    const attemptsByBrief = {};
    const requestFingerprintsByBrief = new Map();
    const reviewCardSpecsByBrief = new Map();

    if (plan.status === 'ready_for_review') {
      return {
        status: 'ready_for_review',
        plan,
        plan_body: planBody,
        generated_media: generatedMedia,
        generation_diagnostics: generationDiagnostics,
        generation_rounds: generationRound,
        generation_round_limit: roundLimit,
        published: false,
      };
    }
    if (plan.status !== 'needs_generation') {
      throw codedError(
        'SOCIAL_OWNER_REVIEW_PLAN_BLOCKED',
        text(plan.generation_decision?.rationale || plan.status || 'creativePlan blocked campaign preparation'),
        { plan_status: text(plan.status) },
      );
    }

    while (plan.status === 'needs_generation' && generationRound < roundLimit) {
      generationRound += 1;
      const briefs = pendingSocialOwnerReviewGenerationBriefs(plan);
      if (!briefs.length) {
        throw codedError(
          'SOCIAL_OWNER_REVIEW_PENDING_BRIEFS_REQUIRED',
          'AI media strategy requires generation but returned no pending storyboard frame briefs.',
        );
      }
      const strategy = plainObject(plan.media_strategy) || {};
      const strategyFrames = new Map((Array.isArray(strategy.frames) ? strategy.frames : [])
        .filter(frame => plainObject(frame) && text(frame.id))
        .map(frame => [text(frame.id), frame]));
      const generationRequests = [];
      const requestFingerprints = [];

      for (const brief of briefs) {
        const briefId = text(brief.id);
        const reviewProblem = socialOwnerReviewReviewCardRepairProblem(brief, plan, reviewCardSpecsByBrief);
        if (reviewProblem) {
          throw codedError('SOCIAL_OWNER_REVIEW_REVIEW_CARD_REPAIR_BLOCKED', reviewProblem, { brief_id: briefId });
        }
        const { payload, problem } = buildSocialOwnerReviewGenerationRequest({
          brief,
          strategyFrame: strategyFrames.get(briefId),
          strategyReferencePolicy: text(strategy.reference_policy),
          title: text(listing.title),
          qualityContext: {
            campaign_goal: text(planBody.context?.campaign_context),
            post_hook: text(plan.concept?.hook),
            listing_understanding: plainObject(plan.listing_understanding)
              || plainObject(planBody.listing?.listing_understanding),
            current_listing_availability: plainObject(plan.current_listing_availability)
              || plainObject(planBody.listing?.current_availability),
            platforms,
            format: text(strategy.format),
            required_visible_evidence: text(strategy.required_visible_evidence),
          },
        });
        if (problem || !payload) {
          throw codedError(
            'SOCIAL_OWNER_REVIEW_GENERATION_REQUEST_INVALID',
            problem || 'AI generated frame brief is incomplete.',
            { brief_id: briefId },
          );
        }
        const fingerprint = socialOwnerReviewGenerationRequestFingerprint(brief, payload);
        if (requestFingerprintsByBrief.get(briefId)?.has(fingerprint)) {
          throw codedError(
            'SOCIAL_OWNER_REVIEW_GENERATION_BRIEF_REPEATED',
            `AI repeated unchanged failed media brief ${briefId}; a materially revised brief or a different frame is required.`,
            { brief_id: briefId, request_fingerprint_sha256: fingerprint },
          );
        }
        generationRequests.push([brief, payload]);
        requestFingerprints.push(fingerprint);
      }

      for (let index = 0; index < generationRequests.length; index += 1) {
        const briefId = text(generationRequests[index][0]?.id);
        if (!requestFingerprintsByBrief.has(briefId)) requestFingerprintsByBrief.set(briefId, new Set());
        requestFingerprintsByBrief.get(briefId).add(requestFingerprints[index]);
        attemptsByBrief[briefId] = (attemptsByBrief[briefId] || 0) + 1;
      }

      assertExecution(
        providerBudget,
        'SOCIAL_OWNER_REVIEW_PROVIDER_BUDGET_INSUFFICIENT',
        'Media generation',
      );
      const generationResponses = await executeBoundedInOrder(
        generationRequests,
        concurrency,
        async ([, payload]) => {
          try {
            const remaining = assertExecution(
              providerBudget,
              'SOCIAL_OWNER_REVIEW_PROVIDER_BUDGET_INSUFFICIENT',
              'Media generation',
            );
            const response = await generateMedia({
              ...payload,
              timeout_ms: Math.max(5_000, Math.min(providerTimeout, remaining - reserve)),
            }, {
              publicBaseUrl,
              signal,
              deadline_at: new Date(deadlineMs).toISOString(),
            });
            if (signal?.aborted) throw abortError(signal);
            return generationApplicationResponse(plainObject(response) || {
              success: false,
              code: 'GENERATE_MEDIA_INVALID_RESPONSE',
              error: 'generateMedia returned an invalid response.',
            });
          } catch (error) {
            if (signal?.aborted) throw abortError(signal);
            return generationExecutionFailure(error);
          }
        },
      );

      const outcomes = collectSocialOwnerReviewGenerationBatchOutcomes(
        generationRequests,
        generationResponses,
        attemptsByBrief,
      );
      recordSocialOwnerReviewSuccessfulReviewCardRenderSpecs(
        generationRequests,
        outcomes.approved_media,
        reviewCardSpecsByBrief,
      );
      generatedMedia = mergeSocialOwnerReviewGeneratedMediaByBrief(generatedMedia, outcomes.approved_media);
      generationDiagnostics = mergeSocialOwnerReviewGenerationDiagnostics(
        generationDiagnostics,
        outcomes.failures,
      );
      failedBriefs = mergeSocialOwnerReviewGenerationFailures(failedBriefs, outcomes.failures);
      const acceptedBriefIds = new Set(generatedMedia.map(item => text(item?.brief_id)).filter(Boolean));
      failedBriefs = failedBriefs.filter(item => !acceptedBriefIds.has(text(item?.brief_id)));
      updateSocialOwnerReviewGenerationResolutionContext({
        planBody,
        generatedMedia,
        failedBriefs,
        generationRound,
        generationRoundLimit: roundLimit,
        priorCampaignRepair: plainObject(plan.campaign_quality_repair),
      });

      if (outcomes.quality_feedback.length) {
        planBody.context.media_quality_feedback = outcomes.quality_feedback;
      }
      try {
        plan = await callCreativePlan(replanBudget);
      } finally {
        delete planBody.context.media_quality_feedback;
      }
      generatedMedia = reconcileSocialOwnerReviewGeneratedMediaWithAiDecisions(generatedMedia, plan);
      preserveSocialOwnerReviewApprovedMediaForReplan(planBody, generatedMedia);

      if (plan.status === 'ready_for_review') break;
      if (plan.status !== 'needs_generation') {
        throw codedError(
          'SOCIAL_OWNER_REVIEW_PLAN_BLOCKED',
          text(plan.generation_decision?.rationale || plan.status || 'creativePlan blocked campaign preparation'),
          { plan_status: text(plan.status), generation_round: generationRound },
        );
      }
    }

    if (plan.status !== 'ready_for_review') {
      const pendingCount = pendingSocialOwnerReviewGenerationBriefs(plan).length;
      throw codedError(
        'SOCIAL_OWNER_REVIEW_GENERATION_ROUND_LIMIT',
        `creative plan still needs ${pendingCount} media frame(s) after ${generationRound} bounded AI media batch(es).`,
        { generation_round: generationRound, generation_round_limit: roundLimit, pending_count: pendingCount },
      );
    }

    return {
      status: 'ready_for_review',
      plan,
      plan_body: planBody,
      generated_media: generatedMedia,
      generation_diagnostics: generationDiagnostics,
      generation_rounds: generationRound,
      generation_round_limit: roundLimit,
      published: false,
    };
  };

  return { prepare };
}
