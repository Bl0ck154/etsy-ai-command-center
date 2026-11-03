function schemaText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Structured-output contract for the listing-understanding AI strategy.
 * This module intentionally owns only schema construction. It has no AI
 * transport, prompt, queue, publish, approval, Etsy or route dependencies.
 */
export function buildSocialListingUnderstandingOutputSchema(
  platforms = [],
  acceptedAssetIds = [],
  listingMediaRanks = [],
) {
  const requested = [...new Set(platforms.map(item => schemaText(item, 40).toLowerCase()).filter(Boolean))];
  const acceptedIds = [...new Set(acceptedAssetIds.map(item => schemaText(item, 80)).filter(Boolean))];
  const inspectedRanks = [...new Set(
    listingMediaRanks
      .map(item => Number(item))
      .filter(rank => Number.isInteger(rank) && rank > 0),
  )].slice(0, 12);
  const captions = Object.fromEntries(requested.map(platform => [platform, { type: 'string' }]));
  const variants = Object.fromEntries(requested.map(platform => [platform, {
    type: 'object',
    additionalProperties: false,
    required: ['format', 'frame_ids', 'buyer_evidence_frame_ids'],
    properties: {
      format: {
        type: 'string',
        enum: platform === 'pinterest'
          ? ['single']
          : platform === 'instagram'
            ? ['single', 'carousel']
            : platform === 'facebook'
              ? ['single', 'multi_image']
              : ['single'],
      },
      frame_ids: { type: 'array', minItems: 1, maxItems: platform === 'pinterest' ? 1 : 7, items: { type: 'string' } },
      buyer_evidence_frame_ids: { type: 'array', minItems: 1, maxItems: platform === 'pinterest' ? 1 : 7, items: { type: 'string' } },
    },
  }]));
  const stringArray = { type: 'array', items: { type: 'string' } };
  const mediaStrategyRequired = [
    'format', 'target_media_count', 'campaign_offer_focus', 'lead_proof_plan',
    'required_visible_evidence', 'frame_count_rationale', 'rationale',
    'listing_media_decisions', 'frames', 'platform_variants',
  ];
  if (acceptedIds.length) mediaStrategyRequired.push('accepted_asset_decisions');

  return {
    type: 'object',
    additionalProperties: false,
    required: ['what_is_sold', 'product_category', 'fulfillment', 'buyer_use_case', 'target_buyer', 'marketing_angle', 'caption_body', 'platform_captions', 'visual_brief', 'media_strategy', 'platforms', 'hashtags', 'unsupported_claims_to_avoid', 'offer_fact_review', 'evidence', 'unknowns', 'confidence'],
    properties: {
      what_is_sold: { type: 'string' }, product_category: { type: 'string' }, fulfillment: { type: 'string' },
      buyer_use_case: { type: 'string' }, target_buyer: { type: 'string' }, marketing_angle: { type: 'string' },
      caption_body: { type: 'string' }, visual_brief: { type: 'string' },
      platform_captions: { type: 'object', additionalProperties: false, required: requested, properties: captions },
      offer_fact_review: {
        type: 'object',
        additionalProperties: false,
        required: ['current_inventory_applied', 'current_offer_summary', 'claims', 'conflicts'],
        properties: {
          current_inventory_applied: { type: 'boolean' },
          current_offer_summary: { type: 'string' },
          claims: {
            type: 'array',
            maxItems: 24,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['claim', 'status', 'source_ids', 'rationale'],
              properties: {
                claim: { type: 'string' },
                status: { type: 'string', enum: ['current_available', 'inactive', 'unknown'] },
                source_ids: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
                rationale: { type: 'string' },
              },
            },
          },
          conflicts: { type: 'array', items: { type: 'string' } },
        },
      },
      media_strategy: {
        type: 'object',
        additionalProperties: false,
        required: mediaStrategyRequired,
        properties: {
          format: { type: 'string', enum: ['single', 'carousel', 'multi_image'] },
          target_media_count: { type: 'integer', minimum: 1, maximum: 7 },
          listing_media_policy: { type: 'string' }, reference_policy: { type: 'string' },
          listing_media_decisions: {
            type: 'array',
            minItems: inspectedRanks.length,
            maxItems: inspectedRanks.length,
            description: `Exactly one explicit AI editorial decision for every supplied Etsy listing-media rank, ordered as: ${inspectedRanks.join(', ') || 'none'}. This is the audit trail for exact use, reference-only use, or exclusion; generated-only must be a reasoned choice rather than a default.`,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['rank', 'decision', 'social_role', 'rationale'],
              properties: {
                rank: inspectedRanks.length
                  ? { type: 'integer', enum: inspectedRanks }
                  : { type: 'integer', minimum: 1 },
                decision: { type: 'string', enum: ['use_exact', 'reference_only', 'exclude'] },
                social_role: { type: 'string' },
                rationale: { type: 'string' },
              },
            },
          },
          campaign_offer_focus: {
            type: 'string',
            minLength: 1,
            description: 'One exact supported product, service, deliverable, transformation, or coherent use case promoted by this campaign. For an umbrella listing, never answer with the broad umbrella category.',
          },
          lead_proof_plan: {
            type: 'string',
            minLength: 1,
            description: 'The concrete visible source/result, product/use-case, or finished-output relationship that makes the lead understandable without its caption. Mood, props, an editing timeline, icons, arrows, diagrams, and sentimental or descriptive copy alone are explanation, not proof.',
          },
          required_visible_evidence: { type: 'string' },
          frame_count_rationale: { type: 'string' },
          rationale: { type: 'string' },
          frames: {
            type: 'array', minItems: 1, maxItems: 7,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'role', 'source', 'rationale', 'communication_goal', 'visible_buyer_evidence', 'evidence_strength'],
              properties: {
                id: { type: 'string' }, role: { type: 'string' },
                source: { type: 'string', enum: ['listing_image', 'generated_image', 'review_card'] },
                rationale: { type: 'string' }, communication_goal: { type: 'string' },
                visible_buyer_evidence: { type: 'string' },
                evidence_strength: { type: 'string', enum: ['primary', 'supporting', 'none'] },
                image_model: {
                  type: 'string',
                  maxLength: 180,
                  description: 'For generated_image, choose an exact model from campaign_context.image_provider_capabilities.available_models when more than one is available. Reference-required frames must use a reference-capable model.',
                },
                prompt: {
                  type: 'string',
                  maxLength: 1800,
                  description: 'For generated media, describe actual buyer-facing proof of campaign_offer_focus. Lead prompts must make the concrete result, transformation, or use case dominant. Icons, arrows, diagrams, labels, devices, scattered props, process metaphors, or sentimental typography can support proof but cannot substitute for visible source/result or finished-output evidence. A synthetic/non-customer illustrative example is allowed when public copy identifies it honestly and it demonstrates a supported capability. For animation/video/time-based offers, a single altered or enhanced still is not motion proof; require visibly distinct temporal states or another unambiguous representation of change over time.',
                },
                reference_policy: { type: 'string' },
                reference_required: { type: 'boolean' }, reference_media_rank: { type: 'integer', minimum: 1 },
                review_id: { type: 'string' },
                context_note: {
                  type: 'string',
                  maxLength: 180,
                  description: 'Public buyer-facing copy rendered verbatim on a review card. State one concise factual qualifier supported by listing facts that clarifies the concrete result, service, or useful fulfillment benefit. A bare format/disclaimer statement that only says the item is digital, downloadable, custom, non-physical, or what it is not does not add buyer value. Never quote, paraphrase, repeat, summarize, or label the review text. Never include prompts, production instructions, requirements for the seller, missing-asset notes, diagnostics, or directions about what the card should contain. Omit the review card when no distinct qualifier adds value.',
                },
                review_card_design: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['style', 'heading', 'highlight_phrase', 'background_color', 'surface_color', 'text_color', 'accent_color'],
                  description: 'Required for review_card. AI-authored social art direction; Etsy AI Command Center renders the exact review deterministically so typography stays correct.',
                  properties: {
                    style: { type: 'string', enum: ['bold_editorial', 'modern_poster', 'scrapbook_note'] },
                    heading: {
                      type: 'string',
                      maxLength: 80,
                      description: 'Short human social-proof label such as “What an Etsy buyer said”; do not imitate Etsy UI chrome.',
                    },
                    highlight_phrase: {
                      type: 'string',
                      maxLength: 100,
                      description: 'Optional exact contiguous substring copied from the supplied exact review quote for visual emphasis; use an empty string when no phrase deserves emphasis.',
                    },
                    background_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
                    surface_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
                    text_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
                    accent_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
                  },
                },
                aspect_ratio: { type: 'string', enum: ['1:1', '4:5', '2:3', '3:4', '9:16', '16:9'] },
                crop_focus: {
                  type: 'string',
                  enum: ['attention', 'center', 'north', 'south', 'east', 'west'],
                  description: 'For generated_image frames, choose which semantic region must survive provider aspect-ratio adaptation.',
                },
              },
            },
          },
          platform_variants: { type: 'object', additionalProperties: false, required: requested, properties: variants },
          accepted_asset_decisions: {
            type: 'array',
            minItems: acceptedIds.length,
            maxItems: acceptedIds.length,
            items: {
              type: 'object', additionalProperties: false, required: ['brief_id', 'decision', 'rationale'],
              properties: {
                brief_id: acceptedIds.length
                  ? {
                    type: 'string',
                    enum: acceptedIds,
                    description: 'Exact brief_id from campaign_context.media_generation_resolution.accepted_assets. Never use a listing image frame id or media rank.',
                  }
                  : {
                    type: 'string',
                    description: 'No accepted assets are available in this turn; accepted_asset_decisions must be empty.',
                  },
                decision: { type: 'string', enum: ['reuse', 'discard'] },
                rationale: { type: 'string' },
              },
            },
          },
        },
      },
      platforms: stringArray, hashtags: stringArray, unsupported_claims_to_avoid: stringArray,
      evidence: stringArray, unknowns: stringArray, confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
}
