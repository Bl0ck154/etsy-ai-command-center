import {
  buildSocialCreativeCooldownMemory,
  buildSocialCreativePatternContext,
  planSocialCreativeCampaignForCandidates,
} from '../../../_social-creative-planner.js';
import {
  resolveSocialHermesPublishCapablePlatforms,
  resolveSocialHermesRequestedPlatforms,
} from '../domain/platform-resolution.js';

function socialText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function valueFromBody(body, key) {
  if (body?.post && Object.prototype.hasOwnProperty.call(body.post, key)) return body.post[key];
  if (body?.draft && Object.prototype.hasOwnProperty.call(body.draft, key)) return body.draft[key];
  return body?.[key];
}

function creativePlanError(httpStatus, code, message) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  error.socialCreativePlanError = true;
  return error;
}

/**
 * Plain-data orchestration for the Social creativePlan stage. Provider, Etsy,
 * quality-review, artifact and persistence adapters are injected so route and
 * future producer compositions can share this transport-neutral contract.
 */
export function createSocialCreativePlanService({
  getScheduledPosts,
  loadValue,
  saveValue,
  getImageCapabilities,
  getReviewCardShopName,
  buildMediaGenerationResolution,
  normalizeOwnerFeedbackMemory,
  currentDateContext,
  platformMediaContracts,
  hydrateCurrentListingFacts,
  analyzeListingImages,
  buildListingUnderstanding,
  buildListingCampaignFit,
  hydrateQualityVariants,
  reviewCampaignMedia,
  campaignQualityBlockingSummary,
  attachReviewArtifacts,
  buildCooldownMemory = buildSocialCreativeCooldownMemory,
  buildCreativePatternContext = buildSocialCreativePatternContext,
  planCreativeCampaignForCandidates = planSocialCreativeCampaignForCandidates,
  resolvePublishCapablePlatforms = resolveSocialHermesPublishCapablePlatforms,
  resolveRequestedPlatforms = resolveSocialHermesRequestedPlatforms,
} = {}) {
  const required = {
    getScheduledPosts,
    loadValue,
    saveValue,
    getImageCapabilities,
    getReviewCardShopName,
    buildMediaGenerationResolution,
    normalizeOwnerFeedbackMemory,
    currentDateContext,
    platformMediaContracts,
    hydrateCurrentListingFacts,
    analyzeListingImages,
    buildListingUnderstanding,
    buildListingCampaignFit,
    hydrateQualityVariants,
    reviewCampaignMedia,
    campaignQualityBlockingSummary,
    attachReviewArtifacts,
    buildCooldownMemory,
    buildCreativePatternContext,
    planCreativeCampaignForCandidates,
    resolvePublishCapablePlatforms,
    resolveRequestedPlatforms,
  };
  for (const [name, dependency] of Object.entries(required)) {
    if (typeof dependency !== 'function') throw new TypeError(`${name} dependency is required`);
  }

  const planCreativeCampaign = async (body = {}, { publicBaseUrl = '' } = {}) => {
    const listing = valueFromBody(body, 'listing') || body.listing_context || null;
    const listingId = listing?.listing_id || listing?.id || valueFromBody(body, 'listing_id');
    const listingCandidates = [
      ...(Array.isArray(body.listings) ? body.listings : []),
      ...(Array.isArray(body.listing_candidates) ? body.listing_candidates : []),
      ...(Array.isArray(body.candidate_listings) ? body.candidate_listings : []),
    ];
    if (!listingId && !listingCandidates.length) {
      throw creativePlanError(400, 'LISTING_REQUIRED', 'listing/listing_id or listing_candidates is required');
    }

    const [scheduledPosts, socialConfigs, savedMemory, savedOwnerFeedbackMemory, imageCapabilities] = await Promise.all([
      getScheduledPosts().catch(() => []),
      loadValue('social_configs').catch(() => ({})),
      loadValue('social_creative_cooldown_memory').catch(() => ({})),
      loadValue('social_owner_feedback_memory').catch(() => null),
      getImageCapabilities().catch(() => ({ generatedImageAvailable: false, referenceImageSupported: false, referenceMode: 'unsupported' })),
    ]);
    const providerConfigured = imageCapabilities.generatedImageAvailable === true;
    const configuredPlatforms = resolvePublishCapablePlatforms(socialConfigs || {});
    const platforms = resolveRequestedPlatforms(body.platforms || [], configuredPlatforms);
    const allowedPlatforms = new Set(['instagram', 'facebook', 'pinterest', 'tiktok']);
    const campaignPlatforms = (platforms.length ? platforms : configuredPlatforms)
      .filter(platform => allowedPlatforms.has(platform));
    if (!campaignPlatforms.length) {
      throw creativePlanError(
        409,
        'NO_CONFIGURED_PLATFORMS',
        'Etsy AI Command Center has no configured social platform route for this campaign. Configure Meta/Pinterest routes before creative planning.',
      );
    }

    const requestedContext = body.context || body.campaign_context || {};
    const generatedMedia = Array.isArray(body.generated_media) ? body.generated_media : [];
    const mediaGenerationResolution = buildMediaGenerationResolution(
      requestedContext.media_generation_resolution,
      generatedMedia,
    );
    const autonomousFactoryVisionRequired = requestedContext.require_vision_for_social_hero === true
      || requestedContext.social_factory_path === true
      || requestedContext.factory_path === 'social_autonomous_content_factory';
    const storedOwnerFeedbackMemory = normalizeOwnerFeedbackMemory(savedOwnerFeedbackMemory);
    const requestedOwnerFeedbackMemory = normalizeOwnerFeedbackMemory(requestedContext.owner_feedback_memory);
    const baseContext = {
      ...currentDateContext(body.now || Date.now()),
      ...requestedContext,
      owner_feedback_memory: storedOwnerFeedbackMemory.items.length
        ? storedOwnerFeedbackMemory
        : requestedOwnerFeedbackMemory,
      require_ai_listing_understanding: true,
      require_ai_media_strategy: true,
      require_vision_for_social_hero: autonomousFactoryVisionRequired,
      image_provider_capabilities: {
        generated_image_available: providerConfigured,
        reference_image_supported: imageCapabilities.referenceImageSupported === true,
        reference_mode: imageCapabilities.referenceMode,
        available_models: (imageCapabilities.models || []).map(item => ({
          provider_id: item.providerId,
          model: item.model,
          reference_image_supported: item.referenceImageSupported === true,
          reference_mode: item.referenceMode,
        })),
      },
      review_card_shop_name: socialText(getReviewCardShopName(), 80),
      recent_content_patterns: buildCreativePatternContext(scheduledPosts),
      platform_media_contracts: platformMediaContracts(campaignPlatforms),
      ...(mediaGenerationResolution ? { media_generation_resolution: mediaGenerationResolution } : {}),
      platforms: campaignPlatforms,
    };

    let selectedListing = listingId ? { ...(listing || {}), listing_id: String(listingId) } : null;
    if (selectedListing && requestedContext.require_current_listing_facts === true) {
      try {
        selectedListing = await hydrateCurrentListingFacts(selectedListing);
        baseContext.current_listing_availability = selectedListing.current_availability;
      } catch (error) {
        throw creativePlanError(
          503,
          'CURRENT_LISTING_FACTS_UNAVAILABLE',
          `Current Etsy listing inventory is required before autonomous creative planning: ${socialText(error?.message || error, 500)}`,
        );
      }
    }

    let visualAnalysis = body.visual_analysis || null;
    const requiresListingVision = baseContext.require_vision_for_social_hero === true
      || baseContext.social_factory_path === true
      || baseContext.factory_path === 'social_autonomous_content_factory';
    if (!visualAnalysis && selectedListing && requiresListingVision) {
      try {
        visualAnalysis = await analyzeListingImages({ listing: selectedListing, campaignContext: baseContext });
      } catch (error) {
        visualAnalysis = { available: false, error: socialText(error?.message || error, 700), images: [] };
      }
    }

    const suppliedListingCampaignFit = selectedListing?.listing_campaign_fit
      || selectedListing?.campaign_fit
      || selectedListing?.ai_semantic_fit
      || null;
    const listingUnderstanding = selectedListing
      ? await buildListingUnderstanding({
        listing: selectedListing,
        context: baseContext,
        visualAnalysis,
      })
      : null;
    const listingCampaignFit = selectedListing && !suppliedListingCampaignFit
      ? await buildListingCampaignFit({
        listing: selectedListing,
        listingUnderstanding,
        context: baseContext,
      })
      : suppliedListingCampaignFit;
    const enrichedSelectedListing = selectedListing
      ? {
        ...selectedListing,
        ...(listingUnderstanding ? { listing_understanding: listingUnderstanding } : {}),
        ...(listingCampaignFit ? { listing_campaign_fit: listingCampaignFit } : {}),
      }
      : null;
    const enrichedListingCandidates = [];
    const aiCandidateLimit = Math.max(1, Math.min(16, Number(body.ai_candidate_limit) || 16));
    for (const [index, candidate] of listingCandidates.entries()) {
      if (index >= aiCandidateLimit) {
        enrichedListingCandidates.push(candidate);
        continue;
      }
      const suppliedCandidateFit = candidate?.listing_campaign_fit || candidate?.campaign_fit || candidate?.ai_semantic_fit || null;
      const candidateUnderstanding = await buildListingUnderstanding({
        listing: candidate,
        context: baseContext,
        visualAnalysis: body.visual_analysis || null,
      });
      const candidateFit = suppliedCandidateFit || await buildListingCampaignFit({
        listing: candidate,
        listingUnderstanding: candidateUnderstanding,
        context: baseContext,
      });
      enrichedListingCandidates.push({
        ...candidate,
        ...(candidateUnderstanding ? { listing_understanding: candidateUnderstanding } : {}),
        ...(candidateFit ? { listing_campaign_fit: candidateFit } : {}),
      });
    }
    const enrichedContext = {
      ...baseContext,
      ...(listingUnderstanding ? { listing_understanding: listingUnderstanding } : {}),
    };
    const plannerInput = {
      listing: enrichedSelectedListing,
      listingCandidates: enrichedListingCandidates,
      context: enrichedContext,
      platforms: campaignPlatforms,
      providerConfigured,
      generatedMedia,
      publicBaseUrl,
      cooldownMemory: savedMemory || {},
      records: scheduledPosts,
      visualAnalysis,
      now: body.now || Date.now(),
    };
    let plan = planCreativeCampaignForCandidates(plannerInput);

    const selectionIssues = Array.isArray(plan.media_strategy_selection_issues)
      ? plan.media_strategy_selection_issues.filter(Boolean)
      : [];
    if (selectionIssues.length) {
      const blockedListingId = String(plan.listing_id || '');
      const blockedListing = [enrichedSelectedListing, ...enrichedListingCandidates]
        .find(candidate => candidate && String(candidate.listing_id || candidate.id || '') === blockedListingId);
      if (blockedListing) {
        const repairedUnderstanding = await buildListingUnderstanding({
          listing: {
            ...blockedListing,
            listing_understanding: plan.listing_understanding || blockedListing.listing_understanding || null,
          },
          context: {
            ...baseContext,
            listing_understanding: plan.listing_understanding || blockedListing.listing_understanding || null,
            media_quality_feedback: {
              source: 'creative_plan_selection_validation',
              issues: selectionIssues,
              instruction: 'Rebuild the AI media strategy so every listed planner selection issue is resolved without local fallback media.',
            },
          },
          visualAnalysis,
        });
        if (repairedUnderstanding?.available !== false) {
          const repairedListing = { ...blockedListing, listing_understanding: repairedUnderstanding };
          const repairedSelectedListing = enrichedSelectedListing && String(enrichedSelectedListing.listing_id || enrichedSelectedListing.id || '') === blockedListingId
            ? repairedListing
            : enrichedSelectedListing;
          const repairedListingCandidates = enrichedListingCandidates.map(candidate => (
            String(candidate.listing_id || candidate.id || '') === blockedListingId ? repairedListing : candidate
          ));
          plan = planCreativeCampaignForCandidates({
            ...plannerInput,
            listing: repairedSelectedListing,
            listingCandidates: repairedListingCandidates,
            context: baseContext,
          });
          plan.media_strategy_selection_repair = {
            attempted: true,
            source: repairedUnderstanding.source || 'external_ai',
            original_issues: selectionIssues,
            resolved: plan.status !== 'blocked_ai_media_selection',
          };
        }
      }
    }

    const campaignQualityRequired = requestedContext.require_campaign_visual_quality_review === true;
    if (campaignQualityRequired && plan.status === 'ready_for_review') {
      let qualitySelectedListing = enrichedSelectedListing;
      let qualityListingCandidates = enrichedListingCandidates;
      for (let qualityAttempt = 0; qualityAttempt < 2 && plan.status === 'ready_for_review'; qualityAttempt += 1) {
        const plannedListingId = String(plan.listing_id || '');
        const campaignListing = [qualitySelectedListing, ...qualityListingCandidates]
          .find(candidate => candidate && String(candidate.listing_id || candidate.id || '') === plannedListingId);
        try {
          const hydratedVariants = await hydrateQualityVariants(plan.variants);
          const campaignQualityReview = await reviewCampaignMedia({
            variants: hydratedVariants,
            listing: campaignListing || {},
            context: {
              campaign_goal: baseContext.campaign_context || baseContext.ai_opportunity_reason || '',
              hook: plan.concept?.hook || plan.concept?.name || '',
              media_strategy: plan.media_strategy || null,
              image_provider_capabilities: baseContext.image_provider_capabilities || null,
              listing_image_execution: 'listing_image frames use the exact supplied Etsy pixels without crop, re-layout, overlay, or aspect-ratio transformation',
            },
          });
          if (campaignQualityReview.approved === true) {
            plan = {
              ...plan,
              campaign_quality_review_required: true,
              campaign_quality_review: campaignQualityReview,
              ...(qualityAttempt ? {
                campaign_quality_repair: {
                  ...(plan.campaign_quality_repair || {}),
                  attempted: true,
                  resolved: true,
                },
              } : {}),
            };
            break;
          }
          if (campaignQualityReview.decision === 'replan' && qualityAttempt === 0 && campaignListing) {
            const repairedUnderstanding = await buildListingUnderstanding({
              listing: {
                ...campaignListing,
                listing_understanding: plan.listing_understanding || campaignListing.listing_understanding || null,
              },
              context: {
                ...baseContext,
                listing_understanding: plan.listing_understanding || campaignListing.listing_understanding || null,
                media_quality_feedback: {
                  source: 'campaign_visual_quality_review',
                  decision: campaignQualityReview.decision,
                  rationale: campaignQualityReview.rationale,
                  issues: campaignQualityReview.issues,
                  required_changes: campaignQualityReview.required_changes,
                  package_contract_issues: campaignQualityReview.package_contract_issues,
                  blocking_reasons: campaignQualityReview.blocking_reasons,
                  visible_buyer_evidence: campaignQualityReview.visible_buyer_evidence,
                  explanation_card_dependence: campaignQualityReview.explanation_card_dependence,
                  frame_reviews: campaignQualityReview.frame_reviews,
                  approval_checks: campaignQualityReview.approval_checks,
                  platform_reviews: campaignQualityReview.platform_reviews,
                  instruction: 'Rebuild the campaign media strategy from the complete pixel-level review. The repaired lead and every platform buyer_evidence_frame_ids declaration must visibly satisfy the required evidence and failed approval checks. Remove or demote frames the reviewer marked remove, weak, evidence-absent, instruction-dominant, or dependent on a qualification that is not visible in those exact pixels. A listing_image is immutable exact Etsy media: do not claim it was cropped, re-laid out, overlaid, or converted to another aspect ratio. If the review requires different pixels, choose an executable generated_image or review_card under image_provider_capabilities. Do not keep a misleading listing image and rely on the caption to repair it. For a review_card repair, materially revise its AI-authored context_note when the reviewer says the offer, fulfillment, or attribution is unclear; changing only the frame id cannot change the rendered evidence. Preserve only accepted assets that still serve the repaired buyer story.',
                },
              },
              visualAnalysis,
            });
            if (repairedUnderstanding?.available !== false) {
              const repairedListing = { ...campaignListing, listing_understanding: repairedUnderstanding };
              qualitySelectedListing = qualitySelectedListing && String(qualitySelectedListing.listing_id || qualitySelectedListing.id || '') === plannedListingId
                ? repairedListing
                : qualitySelectedListing;
              qualityListingCandidates = qualityListingCandidates.map(candidate => (
                String(candidate.listing_id || candidate.id || '') === plannedListingId ? repairedListing : candidate
              ));
              plan = planCreativeCampaignForCandidates({
                ...plannerInput,
                listing: qualitySelectedListing,
                listingCandidates: qualityListingCandidates,
                context: baseContext,
              });
              plan = {
                ...plan,
                campaign_quality_repair: {
                  attempted: true,
                  resolved: false,
                  requested_new_generation: plan.status === 'needs_generation',
                  original_review: campaignQualityReview,
                },
              };
              continue;
            }
          }
          plan = {
            ...plan,
            status: 'blocked_campaign_visual_quality',
            campaign_quality_review_required: true,
            campaign_quality_review: campaignQualityReview,
            variants: plan.variants.map(variant => ({ ...variant, readiness: 'blocked_campaign_visual_quality' })),
            generation_decision: {
              ...(plan.generation_decision || {}),
              status: 'blocked_campaign_visual_quality',
              rationale: campaignQualityBlockingSummary(campaignQualityReview),
            },
          };
        } catch (error) {
          const reason = socialText(error?.message || error, 900);
          plan = {
            ...plan,
            status: 'blocked_campaign_visual_quality_unavailable',
            campaign_quality_review_required: true,
            campaign_quality_review: {
              approved: false,
              decision: 'unavailable',
              rationale: reason || 'Campaign-level AI vision review is unavailable.',
              required_changes: [],
            },
            variants: plan.variants.map(variant => ({ ...variant, readiness: 'blocked_campaign_visual_quality_unavailable' })),
            generation_decision: {
              ...(plan.generation_decision || {}),
              status: 'blocked_campaign_visual_quality_unavailable',
              rationale: reason || 'Campaign-level AI vision review is unavailable.',
            },
          };
        }
      }
    }

    plan = {
      ...(await attachReviewArtifacts(plan)),
      visual_analysis: visualAnalysis,
      ...(selectedListing?.current_availability
        ? { current_listing_availability: selectedListing.current_availability }
        : {}),
    };
    const mergedMemory = buildCooldownMemory(scheduledPosts, savedMemory || {}, body.now || Date.now());
    if (JSON.stringify(mergedMemory) !== JSON.stringify(savedMemory || {})) {
      await saveValue('social_creative_cooldown_memory', mergedMemory).catch(() => {});
    }
    return plan;
  };

  return { planCreativeCampaign };
}
