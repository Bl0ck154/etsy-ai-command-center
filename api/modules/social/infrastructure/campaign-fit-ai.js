export const SOCIAL_CAMPAIGN_FIT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'should_use_listing', 'confidence', 'rationale', 'natural_connection', 'safer_angle', 'risks', 'evidence'],
  properties: {
    decision: { type: 'string', enum: ['strong_fit', 'acceptable_fit', 'weak_fit', 'mismatch'] },
    should_use_listing: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    natural_connection: { type: 'string' },
    safer_angle: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
  },
});

export const SOCIAL_CAMPAIGN_FIT_SYSTEM_PROMPT = [
  'You are an Etsy social marketing strategist.',
  'Decide whether this exact listing is a natural, non-forced fit for the supplied campaign moment/context, or a worthwhile general listing spotlight when no special campaign context exists.',
  'Do not use a fixed taxonomy or keyword rules. Use semantic reasoning from the listing facts and campaign context.',
  'A fit must be obvious to a human shopper without a strained explanation. If the connection is mostly generic, mark weak_fit or mismatch.',
  'Do not invent facts about the listing or the event.',
  'Do not write campaign copy, captions, headlines, markdown, or recommendations. Make only the fit decision.',
  'Return ONLY valid JSON with keys: decision, should_use_listing, confidence, rationale, natural_connection, safer_angle, risks, evidence.',
  'decision must be one of: strong_fit, acceptable_fit, weak_fit, mismatch.',
].join(' ');

export const SOCIAL_CAMPAIGN_FIT_REPAIR_SYSTEM_PROMPT = [
  'You repair an Etsy campaign/listing fit response into strict JSON.',
  'You are a classifier, not a content writer.',
  'Use only the supplied campaign, listing, listing_understanding, and previous_response facts.',
  'Do not create campaign copy, captions, or new marketing claims.',
  'If previous_response is a campaign post, caption draft, post package, promotional copy, or has sections like Primary Caption, Campaign Angle, Buyer Intent, Hashtags, CTA, or Swipe, ignore the persuasive copy and make a fresh fit decision from the supplied campaign/listing facts.',
  'Generic seasonal overlap, generic USA/JULY colors, generic travel timing, or generic summer relevance is not enough for a natural fit. Mark weak_fit or mismatch unless the listing facts directly support the specific campaign moment.',
  'Return ONLY valid JSON with keys: decision, should_use_listing, confidence, rationale, natural_connection, safer_angle, risks, evidence.',
  'decision must be one of: strong_fit, acceptable_fit, weak_fit, mismatch.',
  'If the previous response clearly treats the listing as a natural fit, return strong_fit or acceptable_fit. If it is generic or unsupported, return weak_fit or mismatch.',
].join(' ');

function requiredFunction(name, value) {
  if (typeof value !== 'function') throw new TypeError(`${name} dependency is required`);
  return value;
}

/**
 * Prompt/repair adapter for the campaign/listing semantic-fit decision.
 * Transport, shared normalization and compact payload builders are injected so
 * this adapter owns only the AI strategy contract and cannot grow route/runtime
 * dependencies or a second planner implementation.
 */
export function createSocialCampaignFitAiStrategy({
  normalizeListingCampaignFit,
  compactCampaignContext,
  compactListing,
  isAiConfigured,
  generateWithAi,
  responsePreview,
  text,
} = {}) {
  const normalize = requiredFunction('normalizeListingCampaignFit', normalizeListingCampaignFit);
  const compactCampaign = requiredFunction('compactCampaignContext', compactCampaignContext);
  const compactListingFacts = requiredFunction('compactListing', compactListing);
  const configured = requiredFunction('isAiConfigured', isAiConfigured);
  const generate = requiredFunction('generateWithAi', generateWithAi);
  const preview = requiredFunction('responsePreview', responsePreview);
  const cleanText = requiredFunction('text', text);

  async function evaluate({ listing = {}, listingUnderstanding = null, context = {} } = {}) {
    const supplied = normalize(
      listing.listing_campaign_fit || listing.campaign_fit || context.listing_campaign_fit || context.campaign_fit,
      'caller_supplied',
    );
    if (supplied) return supplied;

    const campaign = compactCampaign(context);
    const aiConfigured = await configured().catch(() => false);
    if (!aiConfigured) {
      return {
        available: false,
        source: 'ai_unavailable',
        decision: 'unverified',
        should_use_listing: false,
        reason: 'External text AI is not configured.',
      };
    }

    const payload = {
      campaign,
      listing: compactListingFacts(listing),
      listing_understanding: listingUnderstanding || listing.listing_understanding || null,
    };

    try {
      const raw = await generate(
        SOCIAL_CAMPAIGN_FIT_SYSTEM_PROMPT,
        JSON.stringify(payload, null, 2),
        SOCIAL_CAMPAIGN_FIT_OUTPUT_SCHEMA,
        { task: 'campaign_fit', maxTokens: 4_000 },
      );
      const normalized = normalize(raw, 'external_ai');
      if (normalized) return normalized;

      const repairedRaw = await generate(
        SOCIAL_CAMPAIGN_FIT_REPAIR_SYSTEM_PROMPT,
        JSON.stringify({
          campaign: payload.campaign,
          listing: payload.listing,
          listing_understanding: payload.listing_understanding,
          previous_response: raw,
        }, null, 2),
        SOCIAL_CAMPAIGN_FIT_OUTPUT_SCHEMA,
        { task: 'campaign_fit_repair', maxTokens: 4_000 },
      );
      const repaired = normalize(repairedRaw, 'external_ai_repair');
      if (repaired) {
        return {
          ...repaired,
          repair_used: true,
          raw_preview: preview(raw, 600),
          repair_response_preview: preview(repairedRaw, 600),
        };
      }
      return {
        available: false,
        source: 'ai_invalid_response',
        decision: 'unverified',
        should_use_listing: false,
        reason: 'External AI did not return a usable campaign-fit decision.',
        raw_preview: preview(raw, 600),
        repair_response_preview: preview(repairedRaw, 600),
      };
    } catch (error) {
      return {
        available: false,
        source: 'ai_error',
        decision: 'unverified',
        should_use_listing: false,
        reason: cleanText(error?.message || error, 240),
      };
    }
  }

  return Object.freeze({ evaluate });
}
