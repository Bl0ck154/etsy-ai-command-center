const SHA256_RE = /^[a-f0-9]{64}$/;

function text(value) {
  return String(value ?? '').trim();
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function seenSetForBrief(seenSpecsByBrief, briefId) {
  if (!(seenSpecsByBrief instanceof Map)) {
    throw new TypeError('seenSpecsByBrief must be a Map');
  }
  if (!seenSpecsByBrief.has(briefId)) seenSpecsByBrief.set(briefId, new Set());
  return seenSpecsByBrief.get(briefId);
}

/**
 * Prevent deterministic review cards from cycling through identical or
 * unstable renders. This is a direct state-contract port of the active Python
 * producer; it makes no creative repair decision of its own.
 */
export function socialOwnerReviewReviewCardRepairProblem(
  brief = {},
  plan = {},
  seenSpecsByBrief = new Map(),
) {
  if (text(brief.renderer) !== 'review_card') return '';
  const briefId = text(brief.id);
  const renderSpec = text(brief.render_spec_sha256).toLowerCase();
  if (!briefId || !SHA256_RE.test(renderSpec)) {
    return 'AI review-card repair is missing a stable brief id or render fingerprint';
  }
  const seenSpecs = seenSetForBrief(seenSpecsByBrief, briefId);
  if (seenSpecs.has(renderSpec)) {
    return `AI requested identical deterministic review-card render for ${briefId}; re-rendering the same specification cannot change the result`;
  }
  if (seenSpecs.size >= 2) {
    return `AI review-card repair loop for ${briefId} changed the deterministic render specification more than once`;
  }
  if (seenSpecs.size) {
    const strategy = plainObject(plan.media_strategy) || {};
    const decisions = Array.isArray(strategy.accepted_asset_decisions) ? strategy.accepted_asset_decisions : [];
    const explicitlyDiscarded = decisions.some(item => plainObject(item)
      && text(item.brief_id) === briefId
      && text(item.decision).toLowerCase() === 'discard');
    if (!explicitlyDiscarded) {
      return `AI changed deterministic review-card render for ${briefId} without explicitly discarding the accepted asset`;
    }
  }
  return '';
}

/** Record fingerprints only after Etsy AI Command Center returned a persistent approved render. */
export function recordSocialOwnerReviewSuccessfulReviewCardRenderSpecs(
  generationRequests = [],
  approvedMedia = [],
  seenSpecsByBrief = new Map(),
) {
  const approvedBriefIds = new Set((Array.isArray(approvedMedia) ? approvedMedia : [])
    .filter(item => plainObject(item) && text(item.brief_id))
    .map(item => text(item.brief_id)));

  for (const request of Array.isArray(generationRequests) ? generationRequests : []) {
    if (!Array.isArray(request) || request.length < 2) continue;
    const [brief, payload] = request;
    const briefId = text(brief?.id);
    if (!approvedBriefIds.has(briefId) || payload?.renderer !== 'review_card') continue;
    const renderSpec = text(payload.render_spec_sha256).toLowerCase();
    if (SHA256_RE.test(renderSpec)) seenSetForBrief(seenSpecsByBrief, briefId).add(renderSpec);
  }
  return seenSpecsByBrief;
}
