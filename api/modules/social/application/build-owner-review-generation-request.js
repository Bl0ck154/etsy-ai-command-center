const SUPPORTED_ASPECT_RATIOS = new Set(['1:1', '4:5', '2:3', '3:4', '9:16', '16:9']);
const SUPPORTED_CROP_FOCUS = new Set(['attention', 'center', 'north', 'south', 'east', 'west']);
const SHA256_RE = /^[a-f0-9]{64}$/;

function text(value) {
  return String(value ?? '').trim();
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameJsonValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function result(payload, problem = '') {
  return { payload, problem };
}

/**
 * Build one generateMedia request from one AI-authored generated/review-card
 * brief and its matching AI media-strategy frame. Missing creative decisions
 * fail closed; this adapter never invents a model, reference, renderer or
 * alternate media choice.
 */
export function buildSocialOwnerReviewGenerationRequest({
  brief = {},
  strategyFrame = {},
  strategyReferencePolicy = '',
  title = '',
  qualityContext = null,
} = {}) {
  if (!plainObject(brief)) {
    return result(null, 'creative planner returned an invalid generated frame brief');
  }
  if (!plainObject(strategyFrame) || !new Set(['generated_image', 'review_card']).has(strategyFrame.source)) {
    return result(null, 'generated frame brief has no matching AI media strategy frame');
  }
  if (text(brief.id) !== text(strategyFrame.id)) {
    return result(null, 'generated frame brief does not match its AI media strategy frame');
  }

  const listingTitle = String(title ?? '');
  if (strategyFrame.source === 'review_card') {
    const reviewEvidence = plainObject(brief.review_evidence);
    if (brief.renderer !== 'review_card' || !reviewEvidence) {
      return result(null, 'AI review-card brief is missing deterministic renderer evidence');
    }
    if (text(reviewEvidence.review_id) !== text(strategyFrame.review_id)) {
      return result(null, 'review-card brief review_id does not match AI media strategy');
    }
    const contextNote = text(brief.context_note);
    if (!contextNote || contextNote !== text(strategyFrame.context_note)) {
      return result(null, 'review-card brief context_note does not match AI media strategy');
    }
    const reviewCardDesign = plainObject(brief.review_card_design);
    if (!reviewCardDesign || !sameJsonValue(reviewCardDesign, strategyFrame.review_card_design)) {
      return result(null, 'review-card brief art direction does not match AI media strategy');
    }
    const renderSpecSha256 = text(brief.render_spec_sha256).toLowerCase();
    if (!SHA256_RE.test(renderSpecSha256)) {
      return result(null, 'review-card brief is missing its deterministic render specification');
    }
    if (!text(reviewEvidence.exact_quote) || !reviewEvidence.rating) {
      return result(null, 'review-card brief is missing exact quote or rating');
    }
    const aspectRatio = text(brief.aspect_ratio);
    if (aspectRatio !== text(strategyFrame.aspect_ratio)) {
      return result(null, 'review-card brief changed or omitted the AI aspect ratio decision');
    }
    if (!SUPPORTED_ASPECT_RATIOS.has(aspectRatio)) {
      return result(null, 'AI review-card frame is missing a supported aspect ratio');
    }
    return result({
      renderer: 'review_card',
      brief_id: text(brief.id),
      context_note: contextNote,
      render_spec_sha256: renderSpecSha256,
      shop_name: text(brief.shop_name).slice(0, 80),
      heading: text(brief.heading).slice(0, 80),
      review_card_design: reviewCardDesign,
      review_evidence: reviewEvidence,
      listing_title: listingTitle.slice(0, 180),
      aspect_ratio: aspectRatio,
      count: 1,
      format: 'single',
      alt: `Anonymous customer review for ${listingTitle.slice(0, 120)}`,
    });
  }

  const prompt = text(brief.prompt);
  if (!prompt) return result(null, 'AI generated frame brief is missing its prompt');
  const imageModel = text(brief.image_model);
  const strategyImageModel = text(strategyFrame.image_model);
  if (imageModel !== strategyImageModel) {
    return result(null, 'generated frame brief changed or omitted the AI image_model decision');
  }
  const aspectRatio = text(brief.aspect_ratio);
  if (!aspectRatio) return result(null, 'AI generated frame brief is missing its aspect ratio');
  const cropFocus = text(brief.crop_focus || strategyFrame.crop_focus || 'attention').toLowerCase();
  if (!SUPPORTED_CROP_FOCUS.has(cropFocus)) {
    return result(null, 'AI generated frame brief has an invalid crop_focus');
  }
  const referenceRequired = strategyFrame.reference_required;
  if (typeof referenceRequired !== 'boolean') {
    return result(null, 'AI media strategy did not decide reference_required');
  }
  if (brief.reference_required !== referenceRequired) {
    return result(null, 'generated frame brief changed the AI reference_required decision');
  }
  const referenceImageUrl = text(brief.reference_image_url);
  const referencePolicy = text(strategyFrame.reference_policy || strategyReferencePolicy);
  if (referenceRequired) {
    if (!referenceImageUrl.startsWith('http://') && !referenceImageUrl.startsWith('https://')) {
      return result(null, 'AI reference-backed frame brief is missing its reference image URL');
    }
    if (!referencePolicy) {
      return result(null, 'AI reference-backed frame brief is missing its reference policy');
    }
  } else if (referenceImageUrl) {
    return result(null, 'AI frame brief supplied a reference image while reference_required is false');
  }

  const payload = {
    brief_id: text(brief.id),
    prompt,
    aspect_ratio: aspectRatio,
    crop_focus: cropFocus,
    count: 1,
    format: 'single',
    image_model_tier: 'standard',
    alt: `Generated ${brief.role || 'social'} frame for ${listingTitle.slice(0, 120)}`,
    require_visual_quality_review: true,
    quality_context: {
      ...(plainObject(qualityContext) || {}),
      frame_role: text(brief.role || strategyFrame.role),
      frame_brief: prompt,
      frame_rationale: text(strategyFrame.rationale),
      frame_communication_goal: text(strategyFrame.communication_goal),
      frame_visible_buyer_evidence: text(strategyFrame.visible_buyer_evidence),
      frame_evidence_strength: text(strategyFrame.evidence_strength),
      listing_title: listingTitle.slice(0, 400),
      frame_format: 'single',
      crop_focus: cropFocus,
      reference_required: referenceRequired,
      reference_policy: referencePolicy,
    },
  };
  if (imageModel) payload.model = imageModel;
  if (referenceImageUrl) payload.reference_image_url = referenceImageUrl;
  if (referencePolicy) payload.reference_policy = referencePolicy;
  return result(payload);
}
