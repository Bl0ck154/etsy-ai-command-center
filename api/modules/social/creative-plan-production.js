import { getListingWithInventory } from '../../_etsy.js';
import { getExternalImageCapabilities } from '../../_external-ai.js';
import {
  socialPlatformMediaContracts,
} from '../../_social-platform-capabilities.js';
import { normalizeSocialReviewCardDesign } from '../../_social-review-card.js';
import {
  analyzeSocialListingImages,
  reviewSocialCampaignMedia,
} from '../../_social-media-quality.js';
import { kvGet, kvSet } from '../../kv.js';
import { createSocialCreativePlanService } from './application/plan-creative-campaign.js';
import {
  createSocialReviewArtifactService,
} from './application/review-artifacts.js';
import {
  normalizeSocialOwnerFeedbackMemory,
} from './application/select-content-opportunities.js';
import {
  normalizeSocialMediaMimeType,
  readPersistentSocialMediaAsset,
} from './infrastructure/media-store.js';
import { socialReviewArtifactRepository } from './infrastructure/review-artifact-repository.js';
import { getScheduledPosts } from './queue.js';

function socialText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function socialStringList(value, maxItems = 8, maxChars = 120) {
  return (Array.isArray(value) ? value : [])
    .map(item => socialText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function socialCreativePlanCurrentDateContext(value = Date.now()) {
  const date = new Date(value || Date.now());
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  return {
    current_date: valid.toISOString().slice(0, 10),
    current_year: valid.getUTCFullYear(),
    current_iso: valid.toISOString(),
  };
}

export function socialCampaignQualityBlockingSummary(review = {}) {
  const reasons = socialStringList(review.blocking_reasons, 12, 500);
  if (reasons.length) return socialText(`Campaign visual quality blocked: ${reasons.join('; ')}`, 4000);
  return socialText(
    review.rationale || 'Campaign-level AI vision review did not approve the media package.',
    4000,
  );
}

export function buildSocialListingAvailabilitySnapshot(listing = {}) {
  const products = Array.isArray(listing?.inventory?.products) ? listing.inventory.products : [];
  const activeByProperty = new Map();
  const allByProperty = new Map();
  const activeCombinations = [];
  let activeOfferingCount = 0;
  let inactiveOfferingCount = 0;
  const addValue = (target, propertyName, value) => {
    const name = socialText(propertyName || 'Variation', 120);
    const clean = socialText(value, 160);
    if (!name || !clean) return;
    if (!target.has(name)) target.set(name, new Set());
    target.get(name).add(clean);
  };
  for (const product of products) {
    const propertyValues = (Array.isArray(product?.property_values) ? product.property_values : [])
      .flatMap(property => (Array.isArray(property?.values) ? property.values : []).map(value => ({
        property: socialText(property?.property_name || property?.property_id, 120),
        value: socialText(value, 160),
      })))
      .filter(item => item.property && item.value);
    propertyValues.forEach(item => addValue(allByProperty, item.property, item.value));
    const activeOfferings = (Array.isArray(product?.offerings) ? product.offerings : [])
      .filter(offering => offering?.is_enabled === true && offering?.is_deleted !== true);
    const inactiveOfferings = (Array.isArray(product?.offerings) ? product.offerings : [])
      .filter(offering => offering?.is_enabled !== true || offering?.is_deleted === true);
    activeOfferingCount += activeOfferings.length;
    inactiveOfferingCount += inactiveOfferings.length;
    if (!activeOfferings.length) continue;
    propertyValues.forEach(item => addValue(activeByProperty, item.property, item.value));
    if (activeCombinations.length < 40) {
      activeCombinations.push(Object.fromEntries(propertyValues.map(item => [item.property, item.value])));
    }
  }
  const variationAvailability = [...allByProperty.entries()].map(([property, allValues]) => {
    const activeValues = activeByProperty.get(property) || new Set();
    return {
      property,
      active_values: [...activeValues].slice(0, 40),
      inactive_only_values: [...allValues].filter(value => !activeValues.has(value)).slice(0, 40),
    };
  });
  return {
    source: 'live_etsy_inventory',
    listing_id: socialText(listing.listing_id || listing.id, 80),
    active_offering_count: activeOfferingCount,
    inactive_offering_count: inactiveOfferingCount,
    active_variation_combinations: activeCombinations,
    variation_availability: variationAvailability,
    shipping_profile_present: Boolean(listing.shipping_profile_id),
    processing_min_days: Number.isFinite(Number(listing.processing_min)) ? Number(listing.processing_min) : null,
    processing_max_days: Number.isFinite(Number(listing.processing_max)) ? Number(listing.processing_max) : null,
  };
}

export async function hydrateCurrentSocialListingFacts(listing = {}) {
  const listingId = Number(listing.listing_id || listing.id);
  if (!Number.isSafeInteger(listingId) || listingId <= 0) {
    throw new Error('A numeric Etsy listing_id is required for current listing facts.');
  }
  const current = await getListingWithInventory(listingId, ['images']);
  return {
    ...listing,
    ...current,
    listing_id: String(listingId),
    current_availability: buildSocialListingAvailabilitySnapshot(current),
  };
}

export function buildSocialMediaGenerationResolution(resolution = null, generatedMedia = []) {
  const supplied = resolution && typeof resolution === 'object' && !Array.isArray(resolution)
    ? resolution
    : {};
  const acceptedAssets = (Array.isArray(generatedMedia) ? generatedMedia : [])
    .filter(item => item && typeof item === 'object')
    .slice(0, 7)
    .map(item => ({
      id: socialText(item.id, 120),
      brief_id: socialText(item.brief_id, 160),
      source: socialText(item.source, 80),
      url: socialText(item.url, 1000),
      permanent: item.permanent === true,
      quality_approved: item.source === 'review_card' || item.quality_review?.approved === true,
      quality_rationale: socialText(item.quality_review?.rationale, 500),
      review_id: socialText(item.review_id || item.review_evidence?.review_id, 120) || null,
      context_note: socialText(item.context_note, 180),
      review_card_design: normalizeSocialReviewCardDesign(item.review_card_design),
      aspect_ratio: socialText(item.aspect_ratio || item.requested_aspect_ratio, 20) || null,
      render_spec_sha256: /^[a-f0-9]{64}$/i.test(String(item.render_spec_sha256 || ''))
        ? String(item.render_spec_sha256).toLowerCase()
        : null,
    }))
    .filter(item => item.url);
  const hasSuppliedFacts = Object.keys(supplied).length > 0;
  if (!hasSuppliedFacts && !acceptedAssets.length) return null;
  return {
    ...supplied,
    phase: socialText(supplied.phase || 'post_generation_replan', 80),
    accepted_assets: acceptedAssets.length
      ? acceptedAssets
      : (Array.isArray(supplied.accepted_assets) ? supplied.accepted_assets : []),
  };
}

function permanentSocialMediaAssetId(value) {
  try {
    const url = new URL(String(value || ''), 'https://etsy-manager.invalid');
    const id = String(url.searchParams.get('id') || '').trim();
    return /^shmedia_[a-f0-9]{24}$/i.test(id) ? id : '';
  } catch {
    return '';
  }
}

export async function hydrateSocialCampaignQualityVariants(variants = []) {
  const hydratedAssets = new Map();
  const hydrateMedia = async item => {
    if (!item || typeof item !== 'object') return item;
    if (!['generated_image', 'review_card'].includes(String(item.source || ''))) return { ...item };
    const id = permanentSocialMediaAssetId(item.url || item.id);
    if (!id) throw new Error('Campaign quality review requires persistent Etsy AI Command Center media for generated frames.');
    if (!hydratedAssets.has(id)) hydratedAssets.set(id, readPersistentSocialMediaAsset(id));
    const asset = await hydratedAssets.get(id);
    return {
      ...item,
      id,
      mimeType: normalizeSocialMediaMimeType(asset.mime_type || asset.mimeType),
      base64: asset.bytes.toString('base64'),
    };
  };
  return Promise.all((Array.isArray(variants) ? variants : []).map(async variant => ({
    ...variant,
    media_items: await Promise.all((Array.isArray(variant?.media_items) ? variant.media_items : []).map(hydrateMedia)),
  })));
}

const defaultReviewArtifactService = createSocialReviewArtifactService({
  repository: socialReviewArtifactRepository,
});

export async function attachSocialCreativePlanReviewArtifacts(plan = {}) {
  if (!Array.isArray(plan.variants) || plan.status !== 'ready_for_review') return plan;
  const variants = [];
  for (const variant of plan.variants) {
    try {
      const artifact = await defaultReviewArtifactService.issue(plan, variant);
      variants.push(artifact ? { ...variant, ai_review_artifact: artifact } : variant);
    } catch (error) {
      variants.push({
        ...variant,
        ai_review_artifact_status: 'unavailable',
        ai_review_artifact_error: socialText(error?.message || error, 300),
      });
    }
  }
  return { ...plan, variants };
}

/**
 * Production composition for the transport-neutral creativePlan application.
 * The two legacy AI strategy functions are still injected from the compatibility
 * facade until their prompt/repair contracts are extracted without behavior drift.
 * All other production adapters are owned here so a future producer worker can use
 * the same composition instead of rebuilding Etsy/KV/media/QA/review wiring.
 */
export function createSocialCreativePlanProductionService({
  buildListingUnderstanding,
  buildListingCampaignFit,
  adapters = {},
} = {}) {
  if (typeof buildListingUnderstanding !== 'function') {
    throw new TypeError('buildListingUnderstanding dependency is required');
  }
  if (typeof buildListingCampaignFit !== 'function') {
    throw new TypeError('buildListingCampaignFit dependency is required');
  }
  const productionAdapters = {
    getScheduledPosts,
    loadValue: kvGet,
    saveValue: kvSet,
    getImageCapabilities: getExternalImageCapabilities,
    getReviewCardShopName: () => process.env.SOCIAL_HERMES_REVIEW_CARD_SHOP_NAME,
    buildMediaGenerationResolution: buildSocialMediaGenerationResolution,
    normalizeOwnerFeedbackMemory: normalizeSocialOwnerFeedbackMemory,
    currentDateContext: socialCreativePlanCurrentDateContext,
    platformMediaContracts: socialPlatformMediaContracts,
    hydrateCurrentListingFacts: hydrateCurrentSocialListingFacts,
    analyzeListingImages: analyzeSocialListingImages,
    hydrateQualityVariants: hydrateSocialCampaignQualityVariants,
    reviewCampaignMedia: reviewSocialCampaignMedia,
    campaignQualityBlockingSummary: socialCampaignQualityBlockingSummary,
    attachReviewArtifacts: attachSocialCreativePlanReviewArtifacts,
    ...adapters,
    buildListingUnderstanding,
    buildListingCampaignFit,
  };
  return createSocialCreativePlanService(productionAdapters);
}
