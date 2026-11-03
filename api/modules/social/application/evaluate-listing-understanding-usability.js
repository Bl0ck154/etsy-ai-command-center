export function createSocialListingUnderstandingUsabilityService({
  requiresMediaStrategy,
  validMediaStrategy,
  visionSelectionProblems,
  capabilityProblems,
  platformRatioProblems,
  acceptedAssetDecisionProblems,
  buyerEvidenceProblems,
  validPlatformCaptions,
  validCaptionReviews,
} = {}) {
  const dependencies = {
    requiresMediaStrategy,
    validMediaStrategy,
    visionSelectionProblems,
    capabilityProblems,
    platformRatioProblems,
    acceptedAssetDecisionProblems,
    buyerEvidenceProblems,
    validPlatformCaptions,
    validCaptionReviews,
  };
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency !== 'function') throw new TypeError(`${name} is required`);
  }

  function isUsable(understanding, context = {}, captionReviewRequired = false, visualAnalysis = null) {
    if (!understanding) return false;
    if (!requiresMediaStrategy(context)) return true;
    const strategy = understanding.media_strategy;
    return validMediaStrategy(strategy, context.platforms)
      && visionSelectionProblems(strategy, visualAnalysis).length === 0
      && capabilityProblems(strategy, context).length === 0
      && platformRatioProblems(strategy, context.platforms).length === 0
      && acceptedAssetDecisionProblems(strategy, context).length === 0
      && buyerEvidenceProblems(strategy, context).length === 0
      && validPlatformCaptions(understanding, context.platforms)
      && (!captionReviewRequired || validCaptionReviews(understanding, context.platforms));
  }

  return Object.freeze({ isUsable });
}
