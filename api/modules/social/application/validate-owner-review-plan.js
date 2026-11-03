function text(value) {
  return String(value ?? '').trim();
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Thin aggregate over the existing focused media-strategy validators.
 *
 * This seam does not introduce another strategy implementation. It only asks
 * the current Social domain owner to evaluate the exact plan returned by
 * creativePlan and presents one fail-closed result to the producer coordinator.
 */
export function createSocialOwnerReviewPlanValidator({ validationRules } = {}) {
  const required = [
    'structuralProblems',
    'visionSelectionProblems',
    'capabilityProblems',
    'platformRatioProblems',
    'acceptedAssetDecisionProblems',
    'buyerEvidenceProblems',
  ];
  for (const method of required) {
    if (typeof validationRules?.[method] !== 'function') {
      throw new TypeError(`validationRules.${method} dependency is required`);
    }
  }

  const validate = ({ plan = {}, platforms = [], planBody = {} } = {}) => {
    if (!plainObject(plan)) {
      return { valid: false, problem: 'creative planner returned an invalid plan', problems: [] };
    }
    const understanding = plainObject(plan.listing_understanding);
    if (understanding?.available === false) {
      const reason = text(understanding.reason) || 'AI listing understanding is unavailable';
      return {
        valid: false,
        problem: `creative planner AI understanding blocked: ${reason}`,
        problems: [reason],
      };
    }
    const strategy = plainObject(plan.media_strategy);
    if (!strategy) {
      return { valid: false, problem: 'creative planner returned no AI media strategy', problems: [] };
    }

    const context = plainObject(planBody.context) || {};
    const visualAnalysis = plainObject(plan.visual_analysis) || plainObject(planBody.visual_analysis);
    const problems = [
      ...validationRules.structuralProblems(strategy, platforms),
      ...validationRules.visionSelectionProblems(strategy, visualAnalysis),
      ...validationRules.capabilityProblems(strategy, context),
      ...validationRules.platformRatioProblems(strategy, platforms),
      ...validationRules.acceptedAssetDecisionProblems(strategy, context),
      ...validationRules.buyerEvidenceProblems(strategy, context),
    ].map(item => text(item)).filter(Boolean);
    const uniqueProblems = [...new Set(problems)];
    return uniqueProblems.length
      ? {
        valid: false,
        problem: `AI media strategy is incomplete: ${uniqueProblems.join('; ')}`,
        problems: uniqueProblems,
      }
      : { valid: true, problem: '', problems: [] };
  };

  return { validate };
}
