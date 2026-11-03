import {
  normalizeSocialMediaGenerationRequest,
  socialMediaText,
  supportedSocialMediaAspectRatio,
  valueFromSocialMediaBody,
} from '../domain/media-generation-contracts.js';

export function createSocialMediaGenerationService({
  normalizeReviewCardEvidence,
  normalizeReviewCardDesign,
  renderReviewCard,
  reviewCardRenderSpecSha256,
  providerRouter,
  normalizeGeneratedGeometry,
  reviewGeneratedImage,
  storeMediaAsset,
  getReviewCardShopName = () => '',
} = {}) {
  const required = {
    normalizeReviewCardEvidence,
    normalizeReviewCardDesign,
    renderReviewCard,
    reviewCardRenderSpecSha256,
    'providerRouter.resolve': providerRouter?.resolve,
    'providerRouter.generate': providerRouter?.generate,
    'providerRouter.safeEndpoint': providerRouter?.safeEndpoint,
    'providerRouter.errorDiagnostics': providerRouter?.errorDiagnostics,
    normalizeGeneratedGeometry,
    reviewGeneratedImage,
    storeMediaAsset,
    getReviewCardShopName,
  };
  for (const [name, dependency] of Object.entries(required)) {
    if (typeof dependency !== 'function') throw new TypeError(`${name} dependency is required`);
  }

  const generateReviewCard = async (body, { publicBaseUrl, dryRun }) => {
    const review = normalizeReviewCardEvidence(
      body.review_evidence || body.selected_review || body.review || {},
    );
    if (!review) {
      return {
        success: false,
        code: 'REVIEW_EVIDENCE_REQUIRED',
        error: 'review_card requires review_id, exact_quote, and rating',
      };
    }
    const reviewCardDesign = normalizeReviewCardDesign(
      body.review_card_design || body.reviewCardDesign,
    );
    if (!reviewCardDesign) {
      return {
        success: false,
        code: 'REVIEW_CARD_DESIGN_REQUIRED',
        error: 'review_card requires complete AI-authored art direction',
      };
    }
    const requestedAspectRatio = supportedSocialMediaAspectRatio(
      valueFromSocialMediaBody(body, 'aspect_ratio') || body.aspectRatio,
    );
    if (!requestedAspectRatio) {
      return {
        success: false,
        code: 'ASPECT_RATIO_REQUIRED',
        error: 'review_card requires an explicit supported aspect_ratio',
      };
    }
    const base = {
      renderer: 'review_card',
      aspect_ratio: requestedAspectRatio,
      review_card_design: reviewCardDesign,
      provider: 'etsy_manager_renderer',
      requested_count: 1,
      published: false,
    };
    if (dryRun) return { success: true, ...base, dry_run: true, images: [] };
    if (!publicBaseUrl) {
      return {
        success: false,
        ...base,
        code: 'REQUEST_CONTEXT_REQUIRED',
        error: 'request context unavailable for public media storage',
      };
    }
    try {
      const renderOptions = {
        review: {
          ...review,
          listing_title: socialMediaText(
            body.listing_title || body.review_evidence?.listing_title || review.listing_title,
            180,
          ),
        },
        shopName: socialMediaText(body.shop_name || body.shopName || getReviewCardShopName(), 80),
        heading: reviewCardDesign.heading,
        contextNote: socialMediaText(body.context_note || body.contextNote, 180),
        aspectRatio: requestedAspectRatio,
        design: reviewCardDesign,
      };
      const renderSpecSha256 = reviewCardRenderSpecSha256(renderOptions);
      const expectedRenderSpec = String(body.render_spec_sha256 || body.renderSpecSha256 || '')
        .trim()
        .toLowerCase();
      if (expectedRenderSpec && expectedRenderSpec !== renderSpecSha256) {
        return {
          success: false,
          ...base,
          code: 'REVIEW_CARD_RENDER_SPEC_MISMATCH',
          error: 'review_card render specification changed between planning and execution',
        };
      }
      const png = await renderReviewCard(renderOptions);
      const stored = await storeMediaAsset({
        base64: png.toString('base64'),
        publicBaseUrl,
        mimeType: 'image/png',
        prompt: `Deterministic anonymous review card for ${review.review_id}`,
        alt: body.alt || `${review.rating}-star anonymous customer review`,
        source: 'review_card',
        renderSpecSha256,
      });
      return {
        success: true,
        ...base,
        generated: true,
        generated_via: 'etsy_manager_review_card_renderer',
        public_url_available: true,
        images: [{
          ...stored,
          rank: 1,
          brief_id: body.brief_id || body.id || null,
          context_note: renderOptions.contextNote,
          review_card_design: reviewCardDesign,
          render_spec_sha256: renderSpecSha256,
        }],
      };
    } catch (error) {
      return {
        success: false,
        ...base,
        generated: false,
        images: [],
        code: 'REVIEW_CARD_RENDER_FAILED',
        error: socialMediaText(error?.message || error, 420),
      };
    }
  };

  const generateMedia = async (body = {}, { publicBaseUrl = '' } = {}) => {
    const request = normalizeSocialMediaGenerationRequest(body);
    if (request.renderer === 'review_card') {
      return generateReviewCard(body, { publicBaseUrl, dryRun: request.dryRun });
    }
    if (!request.prompt) {
      return { success: false, code: 'PROMPT_REQUIRED', error: 'prompt is required' };
    }

    const route = await providerRouter.resolve({
      tier: request.imageModelTier,
      requestedModel: request.requestedModel,
      timeoutOverride: body.timeout_ms || body.timeoutMs,
    });
    const base = {
      prompt: request.prompt,
      aspect_ratio: request.aspectRatio,
      crop_focus: request.cropFocus,
      provider: route.configured ? 'external_ai' : 'unconfigured',
      image_model_tier: request.imageModelTier,
      requested_image_model_tier: request.requestedTier,
      allow_high_model: request.allowHigh,
      requested_count: request.requestedCount,
      visual_quality_review_required: request.requireVisualQualityReview,
      reference_required: request.referenceRequired,
      model_candidates: route.modelCandidates,
      attempt_timeout_ms: route.attemptTimeoutMs,
      published: false,
    };
    if (request.dryRun) {
      return {
        success: true,
        ...base,
        dry_run: true,
        images: [],
        recommendation: 'Dry run only; no image generation was called.',
      };
    }
    if (request.fallbackRequested) {
      return {
        success: false,
        ...base,
        generated: false,
        public_url_available: false,
        images: [],
        code: 'FALLBACK_MEDIA_NOT_ALLOWED',
        error: 'Synthetic fallback PNG media is disabled. Social images must come from the configured provider and be downloaded, validated, and persisted by Etsy AI Command Center.',
      };
    }
    if (!route.configured) {
      return {
        success: false,
        ...base,
        generated: false,
        public_url_available: false,
        images: [],
        code: 'IMAGE_GENERATION_UNCONFIGURED',
        error: 'The configured external image provider is unavailable; temporary public-URL or synthetic fallbacks are not allowed.',
      };
    }
    if (request.referenceRequired && !request.referenceImage) {
      return {
        success: false,
        ...base,
        generated: false,
        public_url_available: false,
        images: [],
        code: 'REFERENCE_IMAGE_REQUIRED',
        error: 'AI selected reference-required generation, but the exact Etsy reference image is missing or invalid.',
      };
    }
    if (request.referenceRequired && route.runtime?.imageReferenceMode === 'unsupported') {
      return {
        success: false,
        ...base,
        generated: false,
        public_url_available: false,
        images: [],
        code: 'REFERENCE_IMAGE_GENERATION_UNSUPPORTED',
        error: 'The configured image provider cannot preserve external reference pixels. AI must re-plan with the exact listing image or a reference-free conceptual frame.',
      };
    }
    if (!publicBaseUrl) {
      return {
        success: false,
        ...base,
        generated: false,
        public_url_available: false,
        images: [],
        code: 'REQUEST_CONTEXT_REQUIRED',
        error: 'request context unavailable for public media storage',
      };
    }

    const providerAttempts = [];
    const storageErrors = [];
    const qualityReviews = [];
    const qualityReviewErrors = [];
    const rejectedPreviews = [];
    for (const model of route.modelCandidates) {
      try {
        const images = await providerRouter.generate({
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          count: request.requestedCount,
          model,
          referenceImage: request.referenceImage,
          referencePolicy: request.referencePolicy,
        }, route.attemptTimeoutMs, `external image generation (${model})`);
        const actualModel = String(images[0]?.model || model);
        const actualProviderId = String(images[0]?.external_provider_id || 'external_ai');
        const actualEndpoint = providerRouter.safeEndpoint(
          images[0]?.external_provider_endpoint || route.endpoint,
        );
        providerAttempts.push({
          provider: actualProviderId,
          model: actualModel,
          endpoint: actualEndpoint,
          http_status: 200,
          response_shape: `images(${images.length})`,
          success: true,
          image_count: images.length,
        });
        const storedImages = [];
        for (const [index, image] of images.slice(0, request.requestedCount).entries()) {
          try {
            if (!publicBaseUrl) throw new Error('request context unavailable for public URL generation');
            const geometry = await normalizeGeneratedGeometry({
              base64: image.base64,
              mimeType: image.mimeType || image.mime_type || 'image/png',
              aspectRatio: request.aspectRatio,
              cropFocus: request.cropFocus,
            });
            const finalBase64 = geometry.base64;
            const finalMimeType = geometry.mimeType;
            let qualityReview = null;
            if (request.requireVisualQualityReview) {
              try {
                qualityReview = await reviewGeneratedImage({
                  base64: finalBase64,
                  mimeType: finalMimeType,
                  referenceImage: request.referenceImage,
                  context: {
                    ...request.qualityContext,
                    prompt: request.prompt,
                    requested_aspect_ratio: request.aspectRatio,
                    final_width: geometry.width,
                    final_height: geometry.height,
                    original_width: geometry.original_width,
                    original_height: geometry.original_height,
                    aspect_ratio_normalized: geometry.normalization_applied,
                    crop_focus: geometry.crop_focus,
                    crop: geometry.crop,
                    reference_required: request.referenceRequired,
                    reference_policy: String(
                      body.reference_policy
                      || body.referencePolicy
                      || request.qualityContext.reference_policy
                      || '',
                    ).trim(),
                  },
                });
                qualityReviews.push({ rank: index + 1, model: actualModel, ...qualityReview });
              } catch (error) {
                qualityReviewErrors.push({
                  rank: index + 1,
                  model: actualModel,
                  error: socialMediaText(error?.message || error, 700),
                });
                continue;
              }
              if (!qualityReview.approved) {
                try {
                  const rejected = await storeMediaAsset({
                    base64: finalBase64,
                    publicBaseUrl,
                    mimeType: finalMimeType,
                    prompt: request.prompt,
                    alt: body.alt || 'AI-rejected social media image preview',
                    source: 'quality_rejected_preview',
                    qualityReview,
                    geometry,
                  });
                  rejectedPreviews.push({
                    ...rejected,
                    rank: index + 1,
                    model: actualModel,
                    publishable: false,
                  });
                } catch (error) {
                  storageErrors.push({
                    model,
                    provider: 'rejected_preview_storage',
                    ...providerRouter.errorDiagnostics(error, {
                      provider: 'rejected_preview_storage',
                      endpoint: 'local_media_asset_storage',
                    }),
                  });
                }
                continue;
              }
            }
            const stored = await storeMediaAsset({
              base64: finalBase64,
              publicBaseUrl,
              mimeType: finalMimeType,
              prompt: request.prompt,
              alt: body.alt || 'Generated social media image preview',
              source: 'generated_image',
              qualityReview,
              geometry,
            });
            storedImages.push({
              ...stored,
              rank: index + 1,
              provider: actualProviderId,
              model: actualModel,
              generated_via: 'external_ai_model_tier_routing',
              image_model_tier: request.imageModelTier,
            });
          } catch (error) {
            storageErrors.push({
              model,
              provider: 'kv_media_asset_storage',
              ...providerRouter.errorDiagnostics(error, {
                provider: 'kv_media_asset_storage',
                endpoint: 'kv_rest_api',
                parser_stage: 'media_asset_storage',
              }),
            });
          }
        }
        if (storedImages.length) {
          return {
            success: true,
            ...base,
            generated: true,
            generated_via: 'external_ai_model_tier_routing',
            selected_model: actualModel,
            selected_provider: actualProviderId,
            fallback_used: providerAttempts.length > 1,
            provider_attempts: providerAttempts,
            public_url_available: true,
            images: storedImages,
            quality_reviews: qualityReviews,
            quality_review_errors: qualityReviewErrors,
            rejected_previews: rejectedPreviews,
            storage_errors: storageErrors,
          };
        }
        if (request.requireVisualQualityReview && (qualityReviews.length || qualityReviewErrors.length)) {
          providerAttempts[providerAttempts.length - 1].quality_review = {
            accepted: 0,
            reviews: qualityReviews,
            errors: qualityReviewErrors,
          };
        } else {
          providerAttempts[providerAttempts.length - 1].storage_error = storageErrors.at(-1)
            || { error: 'Generated image did not produce a public URL.' };
        }
      } catch (error) {
        providerAttempts.push({
          provider: 'external_ai',
          model,
          endpoint: route.endpoint,
          success: false,
          ...providerRouter.errorDiagnostics(error, {
            provider: 'external_ai',
            endpoint: route.endpoint,
          }),
        });
      }
    }

    const lastError = [...providerAttempts].reverse()
      .find(attempt => attempt.error || attempt.storage_error);
    const qualityRejected = qualityReviews.length > 0
      && qualityReviews.every(review => review.approved !== true);
    const qualityUnavailable = request.requireVisualQualityReview
      && !qualityReviews.length
      && qualityReviewErrors.length > 0;
    return {
      success: false,
      ...base,
      generated: false,
      public_url_available: false,
      images: [],
      provider_attempts: providerAttempts,
      quality_reviews: qualityReviews,
      quality_review_errors: qualityReviewErrors,
      rejected_preview_available: rejectedPreviews.length > 0,
      rejected_previews: rejectedPreviews,
      storage_errors: storageErrors,
      code: qualityUnavailable
        ? 'MEDIA_QUALITY_REVIEW_UNAVAILABLE'
        : qualityRejected
          ? 'MEDIA_QUALITY_REJECTED'
          : 'GENERATE_MEDIA_FAILED',
      error: qualityUnavailable
        ? qualityReviewErrors.at(-1)?.error
          || 'AI visual quality review was unavailable; generated media was not accepted.'
        : qualityRejected
          ? qualityReviews.at(-1)?.rationale
            || 'AI visual quality review rejected the generated media.'
          : lastError?.error
            || lastError?.storage_error
            || 'All real image generation providers/models failed; no public media URL was created. Synthetic fallback media is disabled.',
    };
  };

  return { generateMedia };
}
