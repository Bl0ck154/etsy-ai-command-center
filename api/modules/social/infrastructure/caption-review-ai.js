import { randomUUID } from 'node:crypto';

const SUPPORTED_SOCIAL_PLATFORMS = new Set(['instagram', 'facebook', 'pinterest', 'tiktok']);

export const SOCIAL_CAPTION_CRITIC_SYSTEM_PROMPT = [
  'You are the independent quality critic for autonomous Etsy social captions.',
  'Do not rewrite captions and do not invent facts. Review each exact supplied caption against the supplied listing and campaign facts.',
  'Evaluate factual grounding, listing specificity, natural public copy, platform fit, CTA/link behavior, unsupported claims, internal planner language, raw SEO-title copying, and generic template language semantically.',
  'Reject captions that ask buyers to DM, message, email, or send photos through a social platform. This shop accepts the transaction and project handoff through Etsy: Instagram must omit the raw Etsy listing URL and may use a natural Etsy link-in-bio CTA, while Facebook and Pinterest must use the exact supplied Etsy listing URL.',
  'For every platform classify cta_destination as etsy_listing, etsy_link_in_bio, social_direct_message, email, none, or other. Set cta_compliant true only when the complete buyer handoff stays on Etsy. Set required_listing_url_present from the exact supplied caption and listing URL.',
  'Do not use a fixed product taxonomy or keyword blacklist. Explain the actual semantic issue when revision is needed.',
  'For every requested platform return reviewed_caption copied exactly, decision approve or revise, approved boolean, rationale, factual_grounding, platform_fit, and risks.',
  'platform_caption_reviews MUST be a JSON object keyed by every exact requested platform, never an array. Exact shape: {"platform_caption_reviews":{"instagram":{"approved":true,"decision":"approve","reviewed_caption":"copy the exact supplied caption byte-for-byte","rationale":"...","factual_grounding":"...","platform_fit":"...","risks":[]}}}.',
  'Do not omit a requested platform. Do not wrap the JSON in markdown.',
  'Return ONLY JSON with key platform_caption_reviews.',
].join(' ');

export const SOCIAL_CAPTION_CRITIC_REPAIR_SYSTEM_PROMPT = [
  'You repair an independent Etsy social caption critic response into strict JSON by re-evaluating the exact supplied captions.',
  'Do not rewrite captions, invent facts, or approve by default. Preserve a prior supported verdict; otherwise make a fresh semantic quality decision from critic_payload.',
  'A caption asking buyers to DM, message, email, or send photos through social media must be marked revise. Instagram must omit the raw Etsy listing URL and may use an Etsy link-in-bio direction; Facebook and Pinterest must use the exact Etsy listing URL.',
  'Return cta_destination, cta_compliant, and required_listing_url_present for every platform. Facebook and Pinterest cannot be approved without the exact Etsy listing URL in reviewed_caption.',
  'Return one review for every requested platform in a JSON object keyed by the exact platform name, never an array.',
  'Each review requires: approved boolean, decision exactly approve or revise, reviewed_caption copied byte-for-byte from critic_payload.platform_captions, non-empty rationale, factual_grounding, platform_fit, and risks array.',
  'Exact shape: {"platform_caption_reviews":{"instagram":{"approved":true,"decision":"approve","reviewed_caption":"exact supplied caption","rationale":"...","factual_grounding":"...","platform_fit":"...","risks":[]}}}.',
  'Return ONLY JSON with key platform_caption_reviews and no markdown.',
].join(' ');

function requiredFunction(name, value) {
  if (typeof value !== 'function') throw new TypeError(`${name} dependency is required`);
  return value;
}

/**
 * Worker-safe AI adapter for independent platform-caption review.
 * Shared schema, compact payload builders, normalization and route-policy rules
 * stay injected until their existing compatibility contracts are extracted.
 */
export function createSocialCaptionReviewAiStrategy({
  normalizeText,
  compactListing,
  compactCampaignContext,
  outputSchema,
  generateWithAi,
  getRuntimeConfig,
  normalizeReviews,
  enforceRoutePolicy,
  createRunId = () => `caption_critic_${randomUUID()}`,
  now = () => new Date().toISOString(),
} = {}) {
  const text = requiredFunction('normalizeText', normalizeText);
  const listingPayload = requiredFunction('compactListing', compactListing);
  const campaignPayload = requiredFunction('compactCampaignContext', compactCampaignContext);
  const schemaForPlatforms = requiredFunction('outputSchema', outputSchema);
  const generate = requiredFunction('generateWithAi', generateWithAi);
  const runtimeConfig = requiredFunction('getRuntimeConfig', getRuntimeConfig);
  const normalize = requiredFunction('normalizeReviews', normalizeReviews);
  const applyRoutePolicy = requiredFunction('enforceRoutePolicy', enforceRoutePolicy);
  const runId = requiredFunction('createRunId', createRunId);
  const timestamp = requiredFunction('now', now);

  async function review({ listing = {}, context = {}, understanding = {} } = {}) {
    const captions = understanding.platform_captions || {};
    const requestedPlatforms = [...new Set((context.platforms || [])
      .map(item => text(item, 40).toLowerCase())
      .filter(item => SUPPORTED_SOCIAL_PLATFORMS.has(item)))];
    const criticRunId = runId();
    const reviewedAt = timestamp();
    const criticOutputSchema = schemaForPlatforms(requestedPlatforms);

    try {
      const criticPayload = {
        listing: listingPayload(listing, null),
        campaign_context: campaignPayload(context),
        listing_understanding: {
          what_is_sold: understanding.what_is_sold,
          fulfillment: understanding.fulfillment,
          buyer_use_case: understanding.buyer_use_case,
          target_buyer: understanding.target_buyer,
          marketing_angle: understanding.marketing_angle,
          unsupported_claims_to_avoid: understanding.unsupported_claims_to_avoid,
          offer_fact_review: understanding.offer_fact_review,
        },
        requested_platforms: requestedPlatforms,
        platform_captions: captions,
      };
      let raw = await generate(
        SOCIAL_CAPTION_CRITIC_SYSTEM_PROMPT,
        JSON.stringify(criticPayload, null, 2),
        criticOutputSchema,
        { task: 'caption_critic', maxTokens: 5_000 },
      );
      const runtime = await runtimeConfig().catch(() => null);
      let reviews = applyRoutePolicy(normalize(
        raw?.platform_caption_reviews || raw?.caption_quality_reviews || raw,
        captions,
      ), captions, requestedPlatforms, listing.url || listing.listing_url);

      if (!requestedPlatforms.every(platform => reviews[platform]?.reviewed_caption)) {
        raw = await generate(
          SOCIAL_CAPTION_CRITIC_REPAIR_SYSTEM_PROMPT,
          JSON.stringify({
            critic_payload: criticPayload,
            previous_critic_response: raw,
            schema_error: `Expected keyed reviews for: ${requestedPlatforms.join(', ')}`,
          }, null, 2),
          criticOutputSchema,
          { task: 'caption_critic_repair', maxTokens: 5_000 },
        );
        reviews = applyRoutePolicy(normalize(
          raw?.platform_caption_reviews || raw?.caption_quality_reviews || raw,
          captions,
        ), captions, requestedPlatforms, listing.url || listing.listing_url);
      }

      for (const reviewRecord of Object.values(reviews)) Object.assign(reviewRecord, {
        critic_source: 'external_ai_caption_critic',
        critic_model: text(runtime?.textModel, 160),
        critic_run_id: criticRunId,
        reviewed_at: reviewedAt,
      });
      return {
        ...understanding,
        platform_caption_reviews: reviews,
        caption_review_source: 'external_ai_caption_critic',
        caption_review_model: text(runtime?.textModel, 160),
        caption_review_run_id: criticRunId,
        caption_reviewed_at: reviewedAt,
      };
    } catch (error) {
      return {
        ...understanding,
        platform_caption_reviews: {},
        caption_review_source: 'external_ai_caption_critic_error',
        caption_review_error: text(error?.message || error, 240),
      };
    }
  }

  return Object.freeze({ review });
}
