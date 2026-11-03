const SUPPORTED_SOCIAL_PLATFORMS = new Set(['instagram', 'facebook', 'pinterest', 'tiktok']);
const SUPPORTED_SOCIAL_ASPECT_RATIOS = new Set(['1:1', '4:5', '2:3', '3:4', '9:16', '16:9']);

export function createSocialMediaStrategyValidationRules({
  normalizeText,
  aspectRatioFitsPlatform,
  normalizeReviewCardDesign,
} = {}) {
  if (typeof normalizeText !== 'function') throw new TypeError('normalizeText is required');
  if (typeof aspectRatioFitsPlatform !== 'function') throw new TypeError('aspectRatioFitsPlatform is required');
  if (typeof normalizeReviewCardDesign !== 'function') throw new TypeError('normalizeReviewCardDesign is required');

  const text = (value, max = 1000) => normalizeText(value, max);
  const requestedPlatforms = (platforms = []) => [...new Set((platforms || [])
    .map(item => text(item, 40).toLowerCase())
    .filter(item => SUPPORTED_SOCIAL_PLATFORMS.has(item)))];
  const nonEmptyPlatforms = (platforms = []) => [...new Set((platforms || [])
    .map(item => text(item, 40).toLowerCase())
    .filter(Boolean))];

  function platformRatioProblems(strategy, platforms = []) {
    if (!strategy || !Array.isArray(strategy.frames)) return [];
    const frameById = new Map(strategy.frames.map(frame => [frame?.id, frame]).filter(([id]) => id));
    const problems = [];
    for (const platform of nonEmptyPlatforms(platforms)) {
      const variant = strategy.platform_variants?.[platform];
      for (const frameId of Array.isArray(variant?.frame_ids) ? variant.frame_ids : []) {
        const frame = frameById.get(frameId);
        if (!frame || !['generated_image', 'review_card'].includes(frame.source) || !frame.aspect_ratio) continue;
        if (!aspectRatioFitsPlatform(platform, frame.aspect_ratio)) {
          problems.push(`${platform}: frame ${frameId} aspect_ratio ${frame.aspect_ratio} is incompatible with the configured ${platform} publishing surface; create a platform-suitable frame or select another compatible frame`);
        }
      }
    }
    return [...new Set(problems)];
  }

  function acceptedAssetDecisionProblems(strategy, context = {}) {
    const acceptedAssets = Array.isArray(context?.media_generation_resolution?.accepted_assets)
      ? context.media_generation_resolution.accepted_assets
      : [];
    const acceptedIds = [...new Set(acceptedAssets.map(item => text(item?.brief_id, 80)).filter(Boolean))];
    if (!acceptedIds.length) return [];
    const decisions = Array.isArray(strategy?.accepted_asset_decisions) ? strategy.accepted_asset_decisions : [];
    const creationFrames = (Array.isArray(strategy?.frames) ? strategy.frames : [])
      .filter(frame => ['generated_image', 'review_card'].includes(frame?.source));
    const creationFramesById = new Map(creationFrames.map(frame => [frame.id, frame]));
    const reviewCardReuseProblem = (asset, frame) => {
      if (text(asset?.source, 80) !== 'review_card') return '';
      const briefId = text(asset?.brief_id, 80);
      const renderSpec = text(asset?.render_spec_sha256, 80).toLowerCase();
      const reviewId = text(asset?.review_id, 120);
      const contextNote = text(asset?.context_note, 180);
      const aspectRatio = text(asset?.aspect_ratio, 20);
      const design = normalizeReviewCardDesign(asset?.review_card_design);
      if (!/^[a-f0-9]{64}$/.test(renderSpec) || !reviewId || !contextNote || !aspectRatio || !design) {
        return `accepted review-card ${briefId}: immutable render identity is incomplete; discard it and use a new frame id`;
      }
      if (!frame
        || frame.source !== 'review_card'
        || reviewId !== text(frame.review_id, 120)
        || contextNote !== text(frame.context_note, 180)
        || aspectRatio !== text(frame.aspect_ratio, 20)
        || JSON.stringify(design) !== JSON.stringify(normalizeReviewCardDesign(frame.review_card_design))) {
        return `accepted review-card ${briefId}: reuse cannot change review_id, context_note, aspect_ratio, or art direction; discard it and use a new frame id`;
      }
      return '';
    };
    const exactCompletedGeneration = decisions.length === 0
      && creationFrames.length > 0
      && acceptedAssets.length === creationFrames.length
      && acceptedAssets.every(asset => {
        const frame = creationFramesById.get(text(asset?.brief_id, 80));
        return frame
          && asset?.permanent === true
          && asset?.quality_approved === true
          && text(asset?.source, 80) === frame.source
          && !reviewCardReuseProblem(asset, frame);
      });
    // Every creative choice is already AI-authored in the existing strategy. When
    // every planned generated/rendered frame completed under that exact brief ID,
    // reusing the immutable asset is operational binding, not a new marketing
    // decision. Partial or changed outcomes still require an explicit AI replan.
    if (exactCompletedGeneration) return [];
    const decisionsById = new Map(decisions.map(item => [item.brief_id, item]));
    const frameIds = new Set((strategy?.frames || []).map(frame => frame?.id).filter(Boolean));
    const problems = [];
    for (const briefId of acceptedIds) {
      const decision = decisionsById.get(briefId);
      if (!decision) {
        problems.push(`accepted asset ${briefId}: explicit reuse/discard decision missing`);
        continue;
      }
      if (!['reuse', 'discard'].includes(decision.decision) || !decision.rationale) {
        problems.push(`accepted asset ${briefId}: decision must be reuse or discard with rationale`);
        continue;
      }
      if (decision.decision === 'reuse' && !frameIds.has(briefId)) {
        problems.push(`accepted asset ${briefId}: reuse requires a frame with the exact same id`);
      } else if (decision.decision === 'reuse') {
        const acceptedAsset = acceptedAssets.find(item => text(item?.brief_id, 80) === briefId);
        const reuseProblem = reviewCardReuseProblem(acceptedAsset, creationFramesById.get(briefId));
        if (reuseProblem) problems.push(reuseProblem);
      }
      if (decision.decision === 'discard' && frameIds.has(briefId)) problems.push(`accepted asset ${briefId}: discard cannot retain a frame with that id`);
    }
    const unknownDecisions = decisions.filter(item => item.brief_id && !acceptedIds.includes(item.brief_id));
    if (unknownDecisions.length) problems.push(`accepted_asset_decisions reference unknown ids: ${unknownDecisions.map(item => item.brief_id).join(', ')}`);
    return problems;
  }

  function buyerEvidenceProblems(strategy, context = {}) {
    const required = context.require_campaign_visual_quality_review === true
      || context.social_factory_path === true
      || text(context.factory_path, 160) === 'social_autonomous_content_factory';
    if (!required || !strategy) return [];
    const problems = [];
    if (!strategy.required_visible_evidence) problems.push('required_visible_evidence missing');
    const frames = Array.isArray(strategy.frames) ? strategy.frames : [];
    const frameById = new Map(frames.map(frame => [frame?.id, frame]).filter(([id]) => id));
    for (const frame of frames) {
      const label = frame?.id || frame?.role || 'frame';
      if (!frame?.communication_goal) problems.push(`${label}: communication_goal missing`);
      if (!frame?.visible_buyer_evidence) problems.push(`${label}: visible_buyer_evidence missing`);
      if (!['primary', 'supporting', 'none'].includes(frame?.evidence_strength)) {
        problems.push(`${label}: evidence_strength must be primary, supporting, or none`);
      }
    }
    for (const [platform, variant] of Object.entries(strategy.platform_variants || {})) {
      const selectedIds = Array.isArray(variant?.frame_ids) ? variant.frame_ids : [];
      const evidenceIds = Array.isArray(variant?.buyer_evidence_frame_ids) ? variant.buyer_evidence_frame_ids : [];
      if (!evidenceIds.length) {
        problems.push(`${platform}: buyer_evidence_frame_ids missing`);
        continue;
      }
      if (!evidenceIds.every(id => selectedIds.includes(id))) {
        problems.push(`${platform}: buyer_evidence_frame_ids must reference only selected frame_ids`);
      }
      if (selectedIds[0] && !evidenceIds.includes(selectedIds[0])) {
        problems.push(`${platform}: lead frame must be identified as visible buyer evidence`);
      }
      for (const id of evidenceIds) {
        const frame = frameById.get(id);
        if (!frame || !['primary', 'supporting'].includes(frame.evidence_strength)) {
          problems.push(`${platform}: evidence frame ${id} must declare primary or supporting evidence_strength`);
        }
      }
    }
    return [...new Set(problems)];
  }

  function valid(strategy, platforms = []) {
    if (!strategy || !Array.isArray(strategy.frames) || strategy.frames.length < 1 || strategy.frames.length > 7) return false;
    if (strategy.format === 'single' && strategy.frames.length !== 1) return false;
    if (strategy.format === 'carousel' && strategy.frames.length < 2) return false;
    if (strategy.format === 'multi_image' && strategy.frames.length < 2) return false;
    if (!['single', 'carousel', 'multi_image'].includes(strategy.format)) return false;
    if (!Number.isInteger(strategy.target_media_count) || strategy.target_media_count !== strategy.frames.length) return false;
    const ids = strategy.frames.map(frame => frame?.id).filter(Boolean);
    if (ids.length !== strategy.frames.length || new Set(ids).size !== ids.length) return false;
    const framesValid = strategy.frames.every(frame => {
      if (!frame?.id || !frame.role || !frame.rationale) return false;
      if (frame.source === 'listing_image') return Number.isInteger(frame.reference_media_rank) && frame.reference_media_rank > 0;
      if (frame.source === 'review_card') return Boolean(frame.review_id)
        && Boolean(frame.review_card_design)
        && SUPPORTED_SOCIAL_ASPECT_RATIOS.has(frame.aspect_ratio);
      if (frame.source !== 'generated_image' || !frame.prompt || typeof frame.reference_required !== 'boolean' || !SUPPORTED_SOCIAL_ASPECT_RATIOS.has(frame.aspect_ratio)) return false;
      return frame.reference_required === false || (Number.isInteger(frame.reference_media_rank) && frame.reference_media_rank > 0);
    });
    if (!framesValid) return false;
    const requiredPlatforms = requestedPlatforms(platforms);
    const frameIds = new Set(strategy.frames.map(frame => frame.id));
    const variantsValid = requiredPlatforms.every(platform => {
      const variant = strategy.platform_variants?.[platform];
      if (!variant || !Array.isArray(variant.frame_ids) || !variant.frame_ids.length) return false;
      if (new Set(variant.frame_ids).size !== variant.frame_ids.length) return false;
      if (!variant.frame_ids.every(id => frameIds.has(id))) return false;
      if (platform === 'pinterest') return variant.format === 'single' && variant.frame_ids.length === 1;
      if (platform === 'instagram') {
        return variant.format === 'single'
          ? variant.frame_ids.length === 1
          : variant.format === 'carousel' && variant.frame_ids.length >= 2;
      }
      if (platform === 'facebook') {
        return variant.format === 'single'
          ? variant.frame_ids.length === 1
          : variant.format === 'multi_image' && variant.frame_ids.length >= 2;
      }
      if (variant.format === 'single') return variant.frame_ids.length === 1;
      return false;
    });
    if (!variantsValid) return false;
    const selectedFrameIds = new Set(requiredPlatforms.flatMap(platform => strategy.platform_variants[platform].frame_ids));
    return strategy.frames.every(frame => selectedFrameIds.has(frame.id));
  }

  function structuralProblems(strategy, platforms = []) {
    if (!strategy || !Array.isArray(strategy.frames)) return ['media_strategy.frames missing'];
    const problems = [];
    if (strategy.frames.length < 1 || strategy.frames.length > 7) problems.push('frames must contain 1-7 items');
    if (!['single', 'carousel', 'multi_image'].includes(strategy.format)) problems.push('format must be single, carousel, or multi_image');
    if (strategy.format === 'single' && strategy.frames.length !== 1) problems.push('single format requires exactly 1 frame');
    if (['carousel', 'multi_image'].includes(strategy.format) && strategy.frames.length < 2) problems.push(`${strategy.format} requires at least 2 frames`);
    if (!Number.isInteger(strategy.target_media_count) || strategy.target_media_count !== strategy.frames.length) problems.push(`target_media_count must equal frames.length (${strategy.frames.length})`);
    const ids = strategy.frames.map(frame => frame?.id).filter(Boolean);
    if (ids.length !== strategy.frames.length || new Set(ids).size !== ids.length) problems.push('every frame requires a unique non-empty id');
    strategy.frames.forEach((frame, index) => {
      const label = frame?.id || `frame_${index + 1}`;
      if (!frame?.role) problems.push(`${label}: role missing`);
      if (!frame?.rationale) problems.push(`${label}: rationale missing`);
      if (frame?.source === 'listing_image' && !(Number.isInteger(frame.reference_media_rank) && frame.reference_media_rank > 0)) problems.push(`${label}: listing_image requires positive reference_media_rank`);
      else if (frame?.source === 'review_card') {
        if (!frame.review_card_design) problems.push(`${label}: review_card requires AI-authored review_card_design`);
        if (!frame.review_id) problems.push(`${label}: review_card requires review_id`);
        if (!frame.context_note) problems.push(`${label}: review_card requires an AI-authored factual context_note`);
        if (!SUPPORTED_SOCIAL_ASPECT_RATIOS.has(frame.aspect_ratio)) problems.push(`${label}: review_card aspect_ratio invalid`);
      }
      else if (frame?.source === 'generated_image') {
        if (!frame.prompt) problems.push(`${label}: generated_image prompt missing`);
        if (typeof frame.reference_required !== 'boolean') problems.push(`${label}: generated_image reference_required must be boolean`);
        if (!SUPPORTED_SOCIAL_ASPECT_RATIOS.has(frame.aspect_ratio)) problems.push(`${label}: generated_image aspect_ratio invalid`);
        if (frame.reference_required === true && !(Number.isInteger(frame.reference_media_rank) && frame.reference_media_rank > 0)) problems.push(`${label}: referenced generated_image requires positive reference_media_rank`);
      } else if (!['listing_image', 'review_card'].includes(frame?.source)) problems.push(`${label}: source must be listing_image, generated_image, or review_card`);
    });
    const frameIds = new Set(ids);
    requestedPlatforms(platforms).forEach(platform => {
      const variant = strategy.platform_variants?.[platform];
      if (!variant) return problems.push(`${platform}: platform_variant missing`);
      if (!Array.isArray(variant.frame_ids) || !variant.frame_ids.length) problems.push(`${platform}: frame_ids missing`);
      else {
        if (new Set(variant.frame_ids).size !== variant.frame_ids.length) problems.push(`${platform}: frame_ids contain duplicates`);
        if (!variant.frame_ids.every(id => frameIds.has(id))) problems.push(`${platform}: frame_ids reference unknown frames`);
        if (variant.format === 'single' && variant.frame_ids.length !== 1) problems.push(`${platform}: single variant requires exactly 1 frame_id`);
        if (variant.format === 'carousel' && variant.frame_ids.length < 2) problems.push(`${platform}: carousel variant requires at least 2 frame_ids`);
        if (variant.format === 'multi_image' && variant.frame_ids.length < 2) problems.push(`${platform}: multi_image variant requires at least 2 frame_ids`);
        if (!['single', 'carousel', 'multi_image'].includes(variant.format)) problems.push(`${platform}: variant format invalid`);
        if (platform === 'pinterest' && (variant.format !== 'single' || variant.frame_ids.length !== 1)) {
          problems.push('pinterest: the configured Make pin route requires format=single with exactly 1 frame_id');
        }
        if (platform === 'instagram' && !['single', 'carousel'].includes(variant.format)) {
          problems.push('instagram: publisher supports only single or carousel');
        }
        if (platform === 'facebook' && !['single', 'multi_image'].includes(variant.format)) {
          problems.push('facebook: publisher supports only single or multi_image');
        }
      }
    });
    const requiredPlatforms = requestedPlatforms(platforms);
    const selectedFrameIds = new Set(requiredPlatforms.flatMap(platform => (
      Array.isArray(strategy.platform_variants?.[platform]?.frame_ids)
        ? strategy.platform_variants[platform].frame_ids
        : []
    )));
    const unusedFrameIds = ids.filter(id => !selectedFrameIds.has(id));
    if (unusedFrameIds.length) problems.push(`master frames must all be selected by at least one requested platform variant; unused: ${unusedFrameIds.join(', ')}`);
    return problems;
  }

  function visionSelectionProblems(strategy, visualAnalysis = null) {
    if (!strategy || visualAnalysis?.available !== true || !Array.isArray(visualAnalysis.images)) return [];
    const visionByRank = new Map(visualAnalysis.images.map(item => [Number(item?.rank), item]));
    const frameById = new Map((strategy.frames || []).map(frame => [frame?.id, frame]));
    const problems = [];
    const listingMediaDecisions = Array.isArray(strategy.listing_media_decisions)
      ? strategy.listing_media_decisions
      : [];
    const decisionsByRank = new Map();

    for (const decision of listingMediaDecisions) {
      const rank = Number(decision?.rank);
      if (!visionByRank.has(rank)) {
        problems.push(`listing_media_decisions contains uninspected rank ${rank || 'missing'}`);
        continue;
      }
      if (decisionsByRank.has(rank)) {
        problems.push(`listing media rank ${rank} has duplicate editorial decisions`);
        continue;
      }
      decisionsByRank.set(rank, decision);
    }

    for (const rank of visionByRank.keys()) {
      const decision = decisionsByRank.get(rank);
      if (!decision) {
        problems.push(`listing media rank ${rank} is missing an explicit AI editorial decision`);
        continue;
      }
      if (!['use_exact', 'reference_only', 'exclude'].includes(decision.decision)) {
        problems.push(`listing media rank ${rank} has invalid editorial decision ${decision.decision || 'missing'}`);
        continue;
      }
      const exactFrame = (strategy.frames || []).some(frame => (
        frame?.source === 'listing_image' && Number(frame.reference_media_rank) === rank
      ));
      const referenceFrame = (strategy.frames || []).some(frame => (
        frame?.source === 'generated_image'
        && frame.reference_required === true
        && Number(frame.reference_media_rank) === rank
      ));
      if (decision.decision === 'use_exact' && !exactFrame) {
        problems.push(`listing media rank ${rank} is marked use_exact but no exact listing frame uses it`);
      }
      if (decision.decision === 'reference_only' && !referenceFrame) {
        problems.push(`listing media rank ${rank} is marked reference_only but no generated frame references it`);
      }
      if (decision.decision === 'exclude' && (exactFrame || referenceFrame)) {
        problems.push(`listing media rank ${rank} is marked exclude but the media strategy still uses it`);
      }
    }

    for (const frame of strategy.frames || []) {
      if (frame?.source !== 'listing_image') continue;
      const visual = visionByRank.get(Number(frame.reference_media_rank));
      if (!visual) {
        problems.push(`${frame.id || frame.role}: listing image rank ${frame.reference_media_rank || 'missing'} has no AI vision decision`);
        continue;
      }
      if (visual.social_use_decision === 'do_not_use') {
        problems.push(`${frame.id || frame.role}: AI vision marked listing image rank ${frame.reference_media_rank} do_not_use for this campaign`);
      }
    }

    for (const [platform, variant] of Object.entries(strategy.platform_variants || {})) {
      const lead = frameById.get(variant?.frame_ids?.[0]);
      if (lead?.source !== 'listing_image') continue;
      const visual = visionByRank.get(Number(lead.reference_media_rank));
      if (visual && visual.social_use_decision !== 'hero') {
        problems.push(`${platform}: lead frame ${lead.id} uses listing image rank ${lead.reference_media_rank}, but AI vision approved it only as ${visual.social_use_decision || 'unknown'}`);
      }
    }
    return [...new Set(problems)];
  }

  function capabilityProblems(strategy, context = {}) {
    const capabilities = context.image_provider_capabilities;
    if (!strategy) return [];
    const availableModels = Array.isArray(capabilities?.available_models)
      ? capabilities.available_models.filter(item => item && typeof item === 'object' && item.model)
      : [];
    const byModel = new Map(availableModels.map(item => [text(item.model, 180), item]));
    return (strategy.frames || []).flatMap(frame => {
      if (frame?.source !== 'generated_image') return [];
      const label = frame.id || frame.role || 'generated frame';
      if (availableModels.length > 1 && !frame.image_model) {
        return [`${label}: choose image_model from campaign_context.image_provider_capabilities.available_models`];
      }
      if (frame.image_model && availableModels.length && !byModel.has(frame.image_model)) {
        return [`${label}: image_model ${frame.image_model} is not configured`];
      }
      const selectedCapability = byModel.get(frame.image_model);
      if (frame.reference_required === true
        && (selectedCapability?.reference_image_supported === false
          || (!selectedCapability && capabilities?.reference_image_supported === false))) {
        return [`${label}: selected image model cannot preserve external reference pixels; choose a reference-capable model, the original listing_image, or a reference-free conceptual frame`];
      }
      return [];
    });
  }

  return {
    acceptedAssetDecisionProblems,
    buyerEvidenceProblems,
    capabilityProblems,
    platformRatioProblems,
    structuralProblems,
    valid,
    visionSelectionProblems,
  };
}
