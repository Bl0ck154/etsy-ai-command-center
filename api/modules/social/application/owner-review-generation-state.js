import { createHash } from 'node:crypto';

import { socialOwnerReviewGeneratedMediaIsPersistent } from '../domain/owner-review-media-contract.js';

function text(value) {
  return String(value ?? '').trim();
}

function integer(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function preserveSocialOwnerReviewApprovedMediaForReplan(planBody = {}, generatedMedia = []) {
  planBody.generated_media = [...(Array.isArray(generatedMedia) ? generatedMedia : [])];
  return planBody;
}

export function mergeSocialOwnerReviewGeneratedMediaByBrief(existing = [], additions = []) {
  const merged = [];
  const positions = new Map();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(additions) ? additions : [])]) {
    if (!plainObject(item)) continue;
    const identity = text(item.brief_id || item.id || item.url);
    if (!identity) continue;
    if (positions.has(identity)) {
      merged[positions.get(identity)] = item;
    } else {
      positions.set(identity, merged.length);
      merged.push(item);
    }
  }
  return merged;
}

export function reconcileSocialOwnerReviewGeneratedMediaWithAiDecisions(generatedMedia = [], plan = {}) {
  const strategy = plainObject(plan)?.media_strategy;
  const decisions = plainObject(strategy)?.accepted_asset_decisions;
  const discarded = new Set((Array.isArray(decisions) ? decisions : [])
    .filter(item => plainObject(item) && text(item.decision).toLowerCase() === 'discard')
    .map(item => text(item.brief_id)));
  if (!discarded.size) return [...(Array.isArray(generatedMedia) ? generatedMedia : [])];
  return (Array.isArray(generatedMedia) ? generatedMedia : [])
    .filter(item => !discarded.has(text(item?.brief_id)));
}

export function socialOwnerReviewGeneratedMediaHasApprovedAiQuality(item = {}) {
  if (text(item?.source) === 'review_card') return socialOwnerReviewGeneratedMediaIsPersistent(item);
  const review = plainObject(item)?.quality_review;
  return plainObject(review)?.decision === 'approve' && plainObject(review)?.approved === true;
}

export function socialOwnerReviewAiQualityReplanFeedback(response = {}, brief = {}) {
  if (!plainObject(response) || response.code !== 'MEDIA_QUALITY_REJECTED') return [];
  const data = plainObject(response.data) || {};
  const feedback = [];
  for (const review of Array.isArray(data.quality_reviews) ? data.quality_reviews : []) {
    if (!plainObject(review) || !new Set(['regenerate', 'reject']).has(review.decision)) continue;
    feedback.push({
      brief_id: text(brief.id),
      frame_role: text(brief.role),
      decision: text(review.decision),
      rationale: text(review.rationale).slice(0, 900),
      issues: (Array.isArray(review.issues) ? review.issues : [])
        .map(item => text(item).slice(0, 300))
        .filter(Boolean)
        .slice(0, 10),
      specific_revision: text(review.specific_revision).slice(0, 900),
    });
  }
  return feedback;
}

export function socialOwnerReviewGenerationFailureFact(response = {}, brief = {}, attempt = 1) {
  const code = text(response.code || 'GENERATE_MEDIA_FAILED');
  const responseData = plainObject(response.data) || {};
  const rejectedPreviews = [];
  for (const preview of Array.isArray(responseData.rejected_previews) ? responseData.rejected_previews : []) {
    if (!plainObject(preview)) continue;
    const qualityReview = plainObject(preview.quality_review) || {};
    rejectedPreviews.push({
      id: text(preview.id),
      url: text(preview.url),
      source: text(preview.source),
      publishable: false,
      decision: text(qualityReview.decision),
      owner_summary_uk: text(qualityReview.owner_summary_uk).slice(0, 320),
      rationale: text(qualityReview.rationale).slice(0, 900),
      issues: (Array.isArray(qualityReview.issues) ? qualityReview.issues : [])
        .map(item => text(item).slice(0, 300))
        .filter(Boolean)
        .slice(0, 8),
      specific_revision: text(qualityReview.specific_revision).slice(0, 900),
    });
  }
  const briefContract = {
    role: text(brief.role),
    renderer: text(brief.renderer),
    prompt: text(brief.prompt).slice(0, 1800),
    aspect_ratio: text(brief.aspect_ratio),
    crop_focus: text(brief.crop_focus),
    reference_required: brief.reference_required === true,
    context_note: text(brief.context_note).slice(0, 180),
    render_spec_sha256: text(brief.render_spec_sha256).toLowerCase(),
  };
  return {
    brief_id: text(brief.id),
    frame_role: text(brief.role),
    attempts: Math.max(1, integer(attempt, 1)),
    outcome: code.toLowerCase(),
    error: text(response.error || code).slice(0, 700),
    brief_fingerprint_sha256: sha256Canonical(briefContract),
    failed_brief: briefContract,
    rejected_previews: rejectedPreviews.slice(0, 3),
  };
}

export function socialOwnerReviewGenerationRequestFingerprint(brief = {}, payload = {}) {
  const contract = {
    brief_id: text(brief.id || payload.brief_id),
    renderer: text(payload.renderer),
    prompt: text(payload.prompt),
    aspect_ratio: text(payload.aspect_ratio),
    crop_focus: text(payload.crop_focus),
    reference_required: payload.reference_required === true,
    reference_image_url: text(payload.reference_image_url),
    reference_policy: text(payload.reference_policy),
    context_note: text(payload.context_note),
    render_spec_sha256: text(payload.render_spec_sha256).toLowerCase(),
    review_id: text(plainObject(payload.review_evidence)?.review_id),
  };
  return sha256Canonical(contract);
}

export function collectSocialOwnerReviewGenerationBatchOutcomes(
  generationRequests = [],
  generationResponses = [],
  attemptsByBrief = {},
) {
  const approvedMedia = [];
  const qualityFeedback = [];
  const failures = [];
  const requestList = Array.isArray(generationRequests) ? generationRequests : [];
  const responseList = Array.isArray(generationResponses) ? generationResponses : [];

  for (let index = 0; index < Math.min(requestList.length, responseList.length); index += 1) {
    const request = requestList[index];
    if (!Array.isArray(request) || request.length < 2) continue;
    const [brief] = request;
    const response = plainObject(responseList[index]) || {};
    const briefId = text(brief?.id);
    const attempt = Math.max(1, integer(plainObject(attemptsByBrief)?.[briefId], 1));
    const approvedForBrief = [];

    if (response.success) {
      const images = plainObject(response.data)?.images;
      for (const image of Array.isArray(images) ? images : []) {
        if (!plainObject(image)
          || !socialOwnerReviewGeneratedMediaIsPersistent(image)
          || !socialOwnerReviewGeneratedMediaHasApprovedAiQuality(image)) continue;
        const accepted = { ...image, brief_id: brief?.id };
        if (text(brief?.renderer) === 'review_card') {
          accepted.review_id = text(plainObject(brief?.review_evidence)?.review_id);
          accepted.context_note = text(brief?.context_note);
          accepted.review_card_design = brief?.review_card_design;
          accepted.aspect_ratio = text(brief?.aspect_ratio);
          accepted.render_spec_sha256 = text(brief?.render_spec_sha256 || image.render_spec_sha256).toLowerCase();
        }
        approvedForBrief.push(accepted);
      }
      if (!approvedForBrief.length) {
        failures.push(socialOwnerReviewGenerationFailureFact({
          code: 'NO_APPROVED_PERSISTENT_MEDIA',
          error: 'Etsy AI Command Center generated no AI-approved persistent media for the brief',
        }, brief, attempt));
      }
    } else {
      qualityFeedback.push(...socialOwnerReviewAiQualityReplanFeedback(response, brief));
      failures.push(socialOwnerReviewGenerationFailureFact(response, brief, attempt));
    }
    approvedMedia.push(...approvedForBrief);
  }

  return {
    approved_media: approvedMedia,
    quality_feedback: qualityFeedback,
    failures,
  };
}

export function mergeSocialOwnerReviewGenerationFailures(existing = [], additions = []) {
  const byBrief = new Map();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(additions) ? additions : [])]) {
    if (!plainObject(item)) continue;
    const briefId = text(item.brief_id);
    if (!briefId) continue;
    if (byBrief.has(briefId)) {
      const previous = byBrief.get(briefId);
      byBrief.delete(briefId);
      byBrief.set(briefId, {
        ...previous,
        ...item,
        attempts: Math.max(integer(previous.attempts), integer(item.attempts)),
      });
    } else {
      byBrief.set(briefId, item);
    }
  }
  return [...byBrief.values()].slice(-12);
}

export function mergeSocialOwnerReviewGenerationDiagnostics(existing = [], additions = []) {
  const merged = [];
  const identities = new Set();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(additions) ? additions : [])]) {
    if (!plainObject(item) || !Array.isArray(item.rejected_previews) || !item.rejected_previews.length) continue;
    const previewIds = item.rejected_previews
      .filter(preview => plainObject(preview))
      .map(preview => text(preview.id || preview.url))
      .join(',');
    const identity = previewIds || `${item.brief_fingerprint_sha256}:${item.attempts}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    merged.push(item);
  }
  return merged.slice(-12);
}

export function updateSocialOwnerReviewGenerationResolutionContext({
  planBody = {},
  generatedMedia = [],
  failedBriefs = [],
  generationRound = 0,
  generationRoundLimit = 0,
  priorCampaignRepair = null,
} = {}) {
  preserveSocialOwnerReviewApprovedMediaForReplan(planBody, generatedMedia);
  if (!plainObject(planBody.context)) planBody.context = {};
  const round = integer(generationRound);
  const limit = integer(generationRoundLimit);
  const resolution = {
    phase: 'post_generation_replan',
    generation_round: round,
    generation_round_limit: limit,
    remaining_generation_rounds: Math.max(0, limit - round),
    generation_budget_exhausted: round >= limit,
    failed_or_exhausted_briefs: [...(Array.isArray(failedBriefs) ? failedBriefs : [])],
  };
  if (plainObject(priorCampaignRepair) && Object.keys(priorCampaignRepair).length) {
    resolution.prior_campaign_quality_repair = {
      ...priorCampaignRepair,
      consumed_after_generation_round: round,
    };
  }
  planBody.context.media_generation_resolution = resolution;
  return planBody;
}

export function pendingSocialOwnerReviewGenerationBriefs(plan = {}) {
  const pendingIds = new Set((Array.isArray(plan?.storyboard) ? plan.storyboard : [])
    .filter(frame => plainObject(frame) && frame.status === 'pending_generation')
    .map(frame => text(frame.brief_id || frame.frame_id)));
  return (Array.isArray(plan?.generated_frame_briefs) ? plan.generated_frame_briefs : [])
    .filter(brief => plainObject(brief) && pendingIds.has(text(brief.id)));
}
