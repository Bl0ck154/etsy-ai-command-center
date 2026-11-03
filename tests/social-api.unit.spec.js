import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import { readFileSync, rmSync } from 'fs';
import socialHandler, {
  aiMediaStrategyAcceptedAssetDecisionProblemsForTest,
  aiMediaStrategyPlatformRatioProblemsForTest,
  applySocialHermesSafeMutableStatus,
  buildSocialListingAvailabilitySnapshot,
  buildSocialMediaGenerationResolution,
  enforcePlatformCaptionRoutePolicyForTest,
  listingUnderstandingValidationProblems,
  safeSocialHermesContextPayload,
  socialCampaignQualityBlockingSummary,
  socialHermesRecordEligibleForAutoArmForTest,
  socialHermesReviewContentDigest,
} from '../api/social.js';
import kvHandler from '../api/kv.js';
import {
  applyMakeCallback,
  assertScheduledPostMediaContract,
  resolveInstagramDirectPublishConfig,
  postFacebookDirect,
  approveScheduledPost,
  classifyScheduledPost,
  dedupeScheduledPosts,
  publishDueScheduled,
  recoverQueuedExternalPostToDraft,
  restoreScheduledPostToDraft,
  saveScheduledPost,
  saveScheduledPosts,
} from '../api/_scheduler.js';
import {
  buildSocialCreativeCooldownMemory,
  buildSocialCreativePatternContext,
  isPersistentSocialMediaUrl,
  planSocialCreativeCampaign,
  planSocialCreativeCampaignForCandidates,
  rankSocialListingMedia,
  suggestSocialContentOpportunities,
} from '../api/_social-creative-planner.js';
import { analyzeSocialListingImages, reviewGeneratedSocialImage, reviewSocialCampaignMedia, socialMediaQualityInternals } from '../api/_social-media-quality.js';
import { buildAutopilotPrompt } from '../api/_generate.js';

const PYTHON_BIN = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function schedulerRedisLockCommand(parts, { lists, locks }) {
  const command = String(parts[0] || '').toUpperCase();
  if (command === 'SET') {
    const options = parts.slice(3).map(value => String(value || '').toUpperCase());
    if (!options.includes('NX')) return null;
    const key = parts[1] || '';
    if (locks.has(key)) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    locks.set(key, parts[2] || 'token');
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  }
  if (command !== 'EVAL') return null;

  const script = parts[1] || '';
  const keyCount = Number(parts[2] || 0);
  const lockKey = parts[3] || '';
  const token = parts[3 + keyCount] || '';
  if (locks.get(lockKey) !== token) {
    return new Response(JSON.stringify({ result: 0 }), { status: 200 });
  }

  if (keyCount === 3) {
    const shadowKey = parts[4] || '';
    const targetKey = parts[5] || '';
    const mode = parts[7] || '';
    if (mode === 'replace') {
      if (!lists.has(shadowKey)) {
        return new Response(JSON.stringify({ result: -1 }), { status: 200 });
      }
      lists.set(targetKey, lists.get(shadowKey));
      lists.delete(shadowKey);
    } else {
      lists.delete(targetKey);
    }
    locks.delete(lockKey);
    return new Response(JSON.stringify({ result: 1 }), { status: 200 });
  }

  if (!script.includes('EXPIRE')) locks.delete(lockKey);
  return new Response(JSON.stringify({ result: 1 }), { status: 200 });
}

function decodeScheduledQueueTestRecord(raw) {
  const parsed = JSON.parse(decodeURIComponent(raw));
  return parsed?.schema_version === 1
    && parsed?.record_type === 'social_scheduled_post'
    ? parsed.record
    : parsed;
}

function encodeScheduledQueueTestRecord(record) {
  return encodeURIComponent(JSON.stringify({
    schema_version: 1,
    record_type: 'social_scheduled_post',
    record,
  }));
}

function testReviewCardDesign(overrides = {}) {
  return {
    style: 'modern_poster',
    heading: 'What an Etsy buyer said',
    highlight_phrase: 'looked natural',
    background_color: '#DDEFE7',
    surface_color: '#FFFDF8',
    text_color: '#17251F',
    accent_color: '#E85D3F',
    ...overrides,
  };
}

test('pausing an owner revision disarms the superseded scheduled record', () => {
  const changed = applySocialHermesSafeMutableStatus({
    approved_for_publish: true,
    approved_by: 'owner-opt-in:auto-schedule',
    approved_at: '2026-07-20T10:00:00.000Z',
    metadata: {
      auto_publish_after_review_window: true,
      auto_publish_armed: true,
      retained_fact: 'keep-me',
    },
  }, {
    id: 'scheduled-preview',
    status: 'paused',
  }, {
    ownerRevisionInProgress: true,
    now: '2026-07-23T10:00:00.000Z',
  });

  expect(changed).toMatchObject({
    id: 'scheduled-preview',
    status: 'paused',
    approved_for_publish: false,
    approved_by: null,
    approved_at: null,
    approval_source: 'owner_revision_in_progress',
    metadata: {
      auto_publish_after_review_window: false,
      auto_publish_armed: false,
      auto_publish_disarmed_at: '2026-07-23T10:00:00.000Z',
      owner_revision_in_progress: true,
      owner_revision_requested_at: '2026-07-23T10:00:00.000Z',
      retained_fact: 'keep-me',
    },
  });
});



test('visual quality prompts reject vague mood scenes without mistaking decorative marks for readable text', () => {
  const framePrompt = socialMediaQualityInternals.qualityPrompt({
    listing_understanding: {
      what_is_sold: 'A custom digital service selected from several supported project types.',
    },
  });
  const campaignPrompt = socialMediaQualityInternals.campaignQualitySystemPrompt();

  expect(framePrompt).toContain('one concrete supported service');
  expect(framePrompt).toContain('can transcribe the exact visible words');
  expect(framePrompt).toContain('atmospheric flat lay is not evidence');
  expect(framePrompt).toContain('process context or explanation, not a finished result');
  expect(framePrompt).toContain('abstract source-to-output icon diagram');
  expect(framePrompt).toContain('fictional or synthetic demonstration may be approved');
  expect(framePrompt).toContain('time-based output');
  expect(framePrompt).toContain('distinct temporal states');
  expect(campaignPrompt).toContain('umbrella custom-order or multi-service offer');
  expect(campaignPrompt).toContain('review card as supporting social proof');
  expect(campaignPrompt).toContain('cannot replace a failed or missing product');
  expect(campaignPrompt).toContain('another selected frame independently supplies');
  expect(campaignPrompt).toContain('does not by itself show a finished custom output');
  expect(campaignPrompt).toContain('icon diagram as a substitute');
  expect(campaignPrompt).toContain('context note must add distinct buyer information');
  expect(campaignPrompt).toContain('source still beside one altered');
  expect(campaignPrompt).toContain('caption cannot rescue a static image');
  expect(campaignPrompt).toContain('compare every pair of unique media keys');
  expect(campaignPrompt).toContain('Aspect-ratio adaptation alone is not creative diversity');
});

test('per-frame approve verdict cannot contradict a failed communication goal', () => {
  const review = socialMediaQualityInternals.normalizeQualityReview({
    decision: 'approve',
    confidence: 0.95,
    communication_goal_met: false,
    persuasive_evidence_visible: false,
    persuasive_evidence_strength: 'absent',
    offer_fidelity: 'The pixels do not prove the intended time-based result.',
    attention_quality: 'Polished but ambiguous.',
    reference_fidelity: 'No reference was required.',
    text_assessment: 'Readable.',
    issues: ['The image is a static restoration comparison rather than motion evidence.'],
    blocking_issues: ['The advertised motion is not visible.'],
    rationale: 'The candidate cannot demonstrate the advertised animation.',
    specific_revision: 'Show coherent distinct temporal states.',
    owner_summary_uk: '',
  }, 'test-model');

  expect(review).toMatchObject({
    decision: 'regenerate',
    approved: false,
    communication_goal_met: false,
  });
});

test('per-frame approve fails closed without visible persuasive evidence and an explicit blocker contract', () => {
  const shared = {
    decision: 'approve',
    confidence: 0.94,
    communication_goal_met: true,
    offer_fidelity: 'The frame is related to the listing.',
    attention_quality: 'Visually polished.',
    reference_fidelity: 'No reference was required.',
    text_assessment: 'Readable.',
    issues: [],
    rationale: 'The frame looks polished but does not prove the offer.',
    specific_revision: 'Show the concrete buyer-visible result.',
  };

  const noEvidence = socialMediaQualityInternals.normalizeQualityReview({
    ...shared,
    persuasive_evidence_visible: false,
    persuasive_evidence_strength: 'absent',
    blocking_issues: [],
  }, 'test-model');
  const missingBlockerContract = socialMediaQualityInternals.normalizeQualityReview({
    ...shared,
    persuasive_evidence_visible: true,
    persuasive_evidence_strength: 'strong',
  }, 'test-model');

  expect(noEvidence).toMatchObject({ decision: 'regenerate', approved: false });
  expect(missingBlockerContract).toMatchObject({ decision: 'regenerate', approved: false });
});

test('campaign QA receives complete platform packages without truncating through generation prompts', () => {
  const prompt = socialMediaQualityInternals.campaignQualityPrompt({
    listing: {
      listing_id: 'compact-contract',
      title: 'Custom animated family memory',
      description: 'A time-based custom digital service.',
      listing_understanding: {
        what_is_sold: 'A short custom animation made from a submitted family photo.',
        fulfillment: 'Digital delivery.',
        ignored_internal_noise: 'LISTING-NOISE-'.repeat(2000),
      },
    },
    context: {
      campaign_goal: 'Demonstrate the time-based result clearly.',
      media_strategy: {
        campaign_offer_focus: 'Custom family photo animation.',
        lead_proof_plan: 'Show coherent temporal states.',
        required_visible_evidence: 'Visible change over time.',
        frames: [{ prompt: 'GENERATION-NOISE-'.repeat(2000) }],
      },
    },
    variants: [{
      platform: 'instagram',
      format: 'carousel',
      caption: 'A family memory brought into motion.',
      media_keys: ['media_1', 'media_2'],
    }],
    media: [
      { key: 'media_1', source: 'generated_image', brief_id: 'motion-start' },
      { key: 'media_2', source: 'generated_image', brief_id: 'motion-finish' },
    ],
  });

  const contract = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
  expect(contract.platform_variants[0]).toMatchObject({
    platform: 'instagram',
    format: 'carousel',
    media_keys: ['media_1', 'media_2'],
  });
  expect(prompt).not.toContain('GENERATION-NOISE');
  expect(prompt).not.toContain('LISTING-NOISE');
});


test('AI media strategy rejects a Pinterest-first 2:3 frame reused in Instagram feed', () => {
  const strategy = {
    frames: [
      { id: 'pin-hero', source: 'generated_image', aspect_ratio: '2:3' },
      { id: 'ig-hero', source: 'generated_image', aspect_ratio: '4:5' },
    ],
    platform_variants: {
      instagram: { format: 'single', frame_ids: ['pin-hero'] },
      pinterest: { format: 'single', frame_ids: ['pin-hero'] },
    },
  };

  expect(aiMediaStrategyPlatformRatioProblemsForTest(strategy, ['instagram', 'pinterest'])).toEqual([
    expect.stringContaining('instagram: frame pin-hero aspect_ratio 2:3 is incompatible'),
  ]);
  strategy.platform_variants.instagram.frame_ids = ['ig-hero'];
  expect(aiMediaStrategyPlatformRatioProblemsForTest(strategy, ['instagram', 'pinterest'])).toEqual([]);
});

test('recent creative pattern context reports saved frame counts without choosing the next count', () => {
  const context = buildSocialCreativePatternContext([
    {
      id: 'campaign-one-instagram',
      source: 'social_hermes',
      platform: 'instagram',
      created_at: '2026-07-27T10:00:00.000Z',
      media_items: [{ url: 'one' }, { url: 'two' }],
      metadata: {
        campaign_id: 'campaign-one',
        creative_concept: 'Buyer story',
        media_strategy: {
          frames: [
            { id: 'hero', source: 'generated_image', role: 'attention hook', communication_goal: 'Stop the scroll with the finished result.', aspect_ratio: '4:5' },
            { id: 'proof', source: 'review_card', role: 'transformation proof', communication_goal: 'Show how the source becomes the result.', aspect_ratio: '4:5' },
          ],
          platform_variants: {
            instagram: { format: 'carousel', frame_ids: ['hero', 'proof'] },
          },
        },
      },
    },
  ]);

  expect(context).toMatchObject({
    source: 'saved_social_hermes_queue_facts',
    recent_campaigns: [{
      campaign_id: 'campaign-one',
      variants: [{
        platform: 'instagram',
        format: 'carousel',
        media_count: 2,
        selected_frame_roles: ['attention hook', 'transformation proof'],
        selected_communication_goals: [
          'Stop the scroll with the finished result.',
          'Show how the source becomes the result.',
        ],
        ordered_frames: [
          expect.objectContaining({ position: 1, frame_id: 'hero', source: 'generated_image' }),
          expect.objectContaining({ position: 2, frame_id: 'proof', source: 'review_card' }),
        ],
        source_sequence: ['generated_image', 'review_card'],
        review_card_positions: [2],
        aspect_ratios: ['4:5'],
      }],
    }],
  });
  expect(context).not.toHaveProperty('recommended_count');
});

test('paused Social Hermes records cannot be re-armed automatically', () => {
  const record = {
    source: 'social_hermes',
    status: 'paused',
    approved_for_publish: false,
    metadata: {
      owner_review_required: true,
      auto_publish_after_review_window: true,
      auto_publish_armed: false,
    },
  };

  expect(socialHermesRecordEligibleForAutoArmForTest(record)).toBe(false);
  expect(socialHermesRecordEligibleForAutoArmForTest({
    ...record,
    status: 'scheduled',
  })).toBe(true);
});

test('caption route policy rejects social handoff and missing Etsy links', () => {
  const listingUrl = 'https://www.etsy.com/listing/42/example';
  const reviews = enforcePlatformCaptionRoutePolicyForTest({
    instagram: {
      approved: true,
      decision: 'approve',
      cta_destination: 'etsy_listing',
      cta_compliant: true,
      risks: [],
    },
    facebook: {
      approved: true,
      decision: 'approve',
      cta_destination: 'social_direct_message',
      cta_compliant: false,
      risks: [],
    },
    pinterest: {
      approved: true,
      decision: 'approve',
      cta_destination: 'etsy_listing',
      cta_compliant: true,
      risks: [],
    },
  }, {
    instagram: `See the custom project on Etsy: ${listingUrl}`,
    facebook: 'Message us to discuss your custom project.',
    pinterest: `See the custom project on Etsy: ${listingUrl}`,
  }, ['instagram', 'facebook', 'pinterest'], listingUrl);

  expect(reviews.instagram).toMatchObject({
    approved: false,
    decision: 'revise',
  });
  expect(reviews.instagram.risks).toEqual(expect.arrayContaining([
    expect.stringContaining('Raw Etsy listing URL is not suitable'),
  ]));
  expect(reviews.facebook).toMatchObject({
    approved: false,
    decision: 'revise',
    required_listing_url_present: false,
  });
  expect(reviews.facebook.risks).toEqual(expect.arrayContaining([
    expect.stringContaining('outside the required Etsy handoff'),
    expect.stringContaining('Exact Etsy listing URL is missing'),
  ]));
  expect(reviews.pinterest).toMatchObject({
    approved: true,
    decision: 'approve',
    required_listing_url_present: true,
  });
});

test('scheduler transport must match the exact AI-reviewed platform format', () => {
  expect(() => assertScheduledPostMediaContract({
    platform: 'instagram',
    metadata: { media_format: 'single' },
  }, 2)).toThrow('single format requires exactly one image');
  expect(() => assertScheduledPostMediaContract({
    platform: 'facebook',
    metadata: { media_format: 'multi_image' },
  }, 1)).toThrow('multi_image format requires at least two images');
  expect(() => assertScheduledPostMediaContract({
    platform: 'instagram',
    metadata: {
      media_format: 'single',
      media_strategy: {
        platform_variants: { instagram: { format: 'carousel' } },
      },
    },
  }, 1)).toThrow('does not match its AI-reviewed platform variant');
  expect(assertScheduledPostMediaContract({
    platform: 'pinterest',
    metadata: { media_format: 'single' },
  }, 1)).toEqual({ platform: 'pinterest', format: 'single', image_count: 1 });
  for (const mediaItem of [
    { url: 'https://media.example.test/reel.mp4', type: 'video' },
    { url: 'https://media.example.test/reel', content_type: 'video/mp4' },
    'https://media.example.test/reel.webm?token=unit',
  ]) {
    expect(() => assertScheduledPostMediaContract({
      platform: 'instagram',
      metadata: { media_format: 'single' },
      media_items: [mediaItem],
    })).toThrow(expect.objectContaining({
      code: 'VIDEO_ROUTE_NOT_IMPLEMENTED',
      message: expect.stringContaining('currently supports images only'),
    }));
  }
});

test('campaign vision approval cannot bypass a failed evidence check', () => {
  const review = socialMediaQualityInternals.normalizeCampaignQualityReview({
    decision: 'approve',
    confidence: 0.99,
    campaign_goal_met: true,
    visible_buyer_evidence: {
      required_evidence: 'A finished service outcome.',
      satisfied: true,
      strength: 'strong',
      dominant_media_keys: ['media_1'],
      rationale: 'The result is visible.',
    },
    explanation_card_dependence: { level: 'none', rationale: 'No explanation card is needed.' },
    frame_reviews: [{
      media_key: 'media_1', dominant_visual: 'Finished result', persuasive_evidence_visible: true,
      persuasive_evidence_strength: 'strong', text_or_instruction_dominance: 'low',
      mobile_feed_hook_strength: 'strong', marginal_buyer_value: 'strong',
      sequence_position_fit: 'strong', recommended_use: 'lead', rationale: 'Strong proof.',
    }],
    approval_checks: {
      compelling_lead: { status: 'pass', rationale: 'Pass.' },
      visible_evidence: { status: 'fail', rationale: 'The evidence is not trustworthy enough.' },
      distinct_progression: { status: 'pass', rationale: 'Pass.' },
      not_gallery_repackaging: { status: 'pass', rationale: 'Pass.' },
    },
    platform_reviews: [{
      platform: 'instagram', decision: 'approve', lead_media_key: 'media_1',
      visible_offer_understanding: 'clear', persuasive_evidence_media_keys: ['media_1'],
      package_strength: 'strong', listing_gallery_repackaging: false,
      rationale: 'Platform pass.', issues: [],
    }],
    rationale: 'The model tried to approve this package.',
  }, 'test-model', ['instagram'], ['media_1']);
  expect(review.approved).toBe(false);
  expect(review.approval_checks.visible_evidence.status).toBe('fail');
});

test('campaign approval cannot hide unresolved observations inside an approve verdict', () => {
  const review = socialMediaQualityInternals.normalizeCampaignQualityReview({
    decision: 'approve',
    confidence: 0.97,
    campaign_goal_met: true,
    visible_buyer_evidence: {
      required_evidence: 'A concrete finished service result.',
      satisfied: true,
      strength: 'strong',
      dominant_media_keys: ['media_1'],
      rationale: 'The finished result is dominant and immediately clear.',
    },
    explanation_card_dependence: { level: 'none', rationale: 'The result stands on its own.' },
    frame_reviews: [{
      media_key: 'media_1',
      dominant_visual: 'A complete finished result',
      persuasive_evidence_visible: true,
      persuasive_evidence_strength: 'strong',
      text_or_instruction_dominance: 'low',
      mobile_feed_hook_strength: 'strong',
      marginal_buyer_value: 'strong',
      sequence_position_fit: 'strong',
      recommended_use: 'lead',
      rationale: 'Strong buyer-facing proof.',
    }],
    approval_checks: {
      compelling_lead: { status: 'pass', rationale: 'The lead is compelling.' },
      visible_evidence: { status: 'pass', rationale: 'The evidence is visible.' },
      distinct_progression: { status: 'pass', rationale: 'One standalone frame is sufficient.' },
      not_gallery_repackaging: { status: 'pass', rationale: 'Purpose-built creative.' },
    },
    platform_reviews: [{
      platform: 'instagram',
      decision: 'approve',
      lead_media_key: 'media_1',
      visible_offer_understanding: 'clear',
      persuasive_evidence_media_keys: ['media_1'],
      package_strength: 'strong',
      listing_gallery_repackaging: false,
      rationale: 'Ready for Instagram.',
      issues: [],
    }],
    issues: ['Minor optional styling observation that does not require revision.'],
    required_changes: [],
    rationale: 'The package is ready.',
  }, 'test-model', ['instagram'], ['media_1'], { instagram: ['media_1'] });

  expect(review.approved).toBe(false);
  expect(review.decision).toBe('replan');
  expect(review.issues).toEqual([
    'Minor optional styling observation that does not require revision.',
  ]);
  expect(review.blocking_reasons).toContain(
    'Minor optional styling observation that does not require revision.',
  );
});

test('campaign vision cannot approve an adequate ambiguous standalone image', () => {
  const review = socialMediaQualityInternals.normalizeCampaignQualityReview({
    decision: 'approve',
    confidence: 0.96,
    campaign_goal_met: true,
    hook_clarity: 'The lifestyle scene is attractive.',
    offer_demonstration: 'A phone and scattered photos imply a digital memory product.',
    sequence_coherence: 'There is only one frame.',
    listing_gallery_dependence: 'The image was generated for the campaign.',
    visible_buyer_evidence: {
      required_evidence: 'A finished personalized video made from customer memories.',
      satisfied: true,
      strength: 'adequate',
      dominant_media_keys: ['media_1'],
      rationale: 'The phone suggests the result, but it is not unmistakably a video.',
    },
    explanation_card_dependence: { level: 'none', rationale: 'No explanation card is used.' },
    frame_reviews: [{
      media_key: 'media_1',
      dominant_visual: 'A smartphone surrounded by loose printed photos.',
      persuasive_evidence_visible: true,
      persuasive_evidence_strength: 'partial',
      text_or_instruction_dominance: 'low',
      mobile_feed_hook_strength: 'adequate',
      marginal_buyer_value: 'meaningful',
      sequence_position_fit: 'strong',
      recommended_use: 'lead',
      rationale: 'Polished but the advertised output is inferred.',
    }],
    approval_checks: {
      compelling_lead: { status: 'pass', rationale: 'Attractive image.' },
      visible_evidence: { status: 'pass', rationale: 'The model considered the evidence adequate.' },
      distinct_progression: { status: 'pass', rationale: 'The model considered the single sufficient.' },
      not_gallery_repackaging: { status: 'pass', rationale: 'Purpose-built image.' },
    },
    platform_reviews: [{
      platform: 'pinterest',
      decision: 'approve',
      lead_media_key: 'media_1',
      visible_offer_understanding: 'partial',
      persuasive_evidence_media_keys: ['media_1'],
      package_strength: 'adequate',
      listing_gallery_repackaging: false,
      rationale: 'The caption can explain that this is a video service.',
      issues: ['The screen can be interpreted as a static photo.'],
    }],
    emotional_tone: 'Warm.',
    text_quality: 'No text.',
    issues: [],
    required_changes: [],
    rationale: 'The model attempted to approve an adequate standalone image.',
  }, 'test-model', ['pinterest'], ['media_1'], { pinterest: ['media_1'] });

  expect(review.approved).toBe(false);
  expect(review.decision).toBe('replan');
  expect(review.package_contract_issues).toEqual(expect.arrayContaining([
    'pinterest: standalone image does not make the offer unambiguously clear',
    'pinterest: standalone image is not strong enough to carry the post by itself',
    'pinterest: standalone image still has unresolved campaign issues',
    'pinterest: lead lacks strong visible buyer evidence or hook strength',
  ]));
  expect(review.blocking_reasons).toEqual(expect.arrayContaining([
    'pinterest: standalone image does not make the offer unambiguously clear',
  ]));
  expect(socialCampaignQualityBlockingSummary(review)).toContain(
    'pinterest: standalone image does not make the offer unambiguously clear',
  );
  expect(socialCampaignQualityBlockingSummary(review)).not.toContain(
    'The model attempted to approve an adequate standalone image.',
  );
});

test('current Etsy inventory separates active digital choices from inactive physical variations', () => {
  const snapshot = buildSocialListingAvailabilitySnapshot({
    listing_id: '4466797732',
    shipping_profile_id: 123,
    inventory: {
      products: [
        {
          offerings: [{ is_enabled: true, is_deleted: false }],
          property_values: [{ property_name: 'Material and Size', values: ['Digital file_JPEG'] }],
        },
        {
          offerings: [{ is_enabled: false, is_deleted: false }],
          property_values: [{ property_name: 'Material and Size', values: ['Paper Poster 8x10'] }],
        },
        {
          offerings: [{ is_enabled: false, is_deleted: false }],
          property_values: [{ property_name: 'Material and Size', values: ['Matte Canvas 12x16'] }],
        },
      ],
    },
  });

  expect(snapshot).toMatchObject({
    source: 'live_etsy_inventory',
    active_offering_count: 1,
    inactive_offering_count: 2,
  });
  expect(snapshot.variation_availability).toEqual([{
    property: 'Material and Size',
    active_values: ['Digital file_JPEG'],
    inactive_only_values: ['Paper Poster 8x10', 'Matte Canvas 12x16'],
  }]);
});

test('autonomous listing understanding must acknowledge current inventory with claim provenance', () => {
  const context = {
    require_current_listing_facts: true,
    current_listing_availability: { source: 'live_etsy_inventory' },
    platforms: [],
  };
  expect(listingUnderstandingValidationProblems({
    available: true,
    offer_fact_review: {
      current_inventory_applied: false,
      current_offer_summary: '',
      claims: [],
    },
  }, context)).toContain('offer_fact_review_did_not_apply_current_inventory');

  expect(listingUnderstandingValidationProblems({
    available: true,
    offer_fact_review: {
      current_inventory_applied: true,
      current_offer_summary: 'Only the active digital variation is currently purchasable.',
      claims: [{
        claim: 'Digital file is currently available.',
        status: 'current_available',
        source_ids: ['listing.current_availability.variation_availability[0].active_values'],
        rationale: 'The current live inventory marks this value active.',
      }],
    },
  }, context)).toEqual([]);
});

test('campaign vision rejects low-value frames and cross-platform evidence hallucinations', () => {
  const review = socialMediaQualityInternals.normalizeCampaignQualityReview({
    decision: 'approve',
    confidence: 0.98,
    campaign_goal_met: true,
    hook_clarity: 'The hero is clear.',
    offer_demonstration: 'The service is visible.',
    sequence_coherence: 'The planner claims the sequence works.',
    listing_gallery_dependence: 'None.',
    visible_buyer_evidence: {
      required_evidence: 'A visible transformation.',
      satisfied: true,
      strength: 'strong',
      dominant_media_keys: ['media_1'],
      rationale: 'The hero carries the proof.',
    },
    explanation_card_dependence: { level: 'supporting', rationale: 'The second card is informational.' },
    frame_reviews: [
      {
        media_key: 'media_1', dominant_visual: 'Transformation proof', persuasive_evidence_visible: true,
        persuasive_evidence_strength: 'strong', text_or_instruction_dominance: 'low',
        mobile_feed_hook_strength: 'strong', marginal_buyer_value: 'strong',
        sequence_position_fit: 'strong', recommended_use: 'lead', rationale: 'Keep.',
      },
      {
        media_key: 'media_2', dominant_visual: 'A plain options card', persuasive_evidence_visible: true,
        persuasive_evidence_strength: 'partial', text_or_instruction_dominance: 'high',
        mobile_feed_hook_strength: 'adequate', marginal_buyer_value: 'low',
        sequence_position_fit: 'poor', recommended_use: 'remove', rationale: 'The caption can carry this information.',
      },
    ],
    approval_checks: {
      compelling_lead: { status: 'pass', rationale: 'Pass.' },
      visible_evidence: { status: 'pass', rationale: 'Pass.' },
      distinct_progression: { status: 'pass', rationale: 'Pass.' },
      not_gallery_repackaging: { status: 'pass', rationale: 'Pass.' },
    },
    platform_reviews: [
      {
        platform: 'instagram', decision: 'approve', lead_media_key: 'media_1',
        visible_offer_understanding: 'clear', persuasive_evidence_media_keys: ['media_1'],
        package_strength: 'strong', listing_gallery_repackaging: false, rationale: 'Looks ready.', issues: [],
      },
      {
        platform: 'pinterest', decision: 'approve', lead_media_key: 'media_1',
        visible_offer_understanding: 'clear', persuasive_evidence_media_keys: ['media_1', 'media_2'],
        package_strength: 'strong', listing_gallery_repackaging: false, rationale: 'Incorrectly cites another frame.', issues: [],
      },
    ],
    emotional_tone: 'Appropriate.',
    text_quality: 'Readable.',
    issues: [],
    required_changes: [],
    rationale: 'The model attempted to approve the package.',
  }, 'test-model', ['instagram', 'pinterest'], ['media_1', 'media_2'], {
    instagram: ['media_1', 'media_2'],
    pinterest: ['media_1'],
  });

  expect(review.approved).toBe(false);
  expect(review.decision).toBe('replan');
  expect(review.package_contract_issues).toEqual(expect.arrayContaining([
    'media_2: marginal buyer value is too low for the selected package',
    'media_2: sequence position is poor',
    'media_2: final editor recommended removal',
    'pinterest: persuasive evidence references media outside that platform variant',
  ]));
});

test('scheduled queue replacement keeps the live list intact when a shadow write is interrupted', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  };
  const liveKey = 'default:scheduled:posts';
  const oldRecord = encodeURIComponent(JSON.stringify({ id: 'existing-post', caption: 'Existing queue record' }));
  const lists = new Map([[liveKey, [oldRecord]]]);
  const locks = new Map();
  let shadowPushes = 0;
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-kv-token';
  global.fetch = async url => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
    if (lockResponse) return lockResponse;
    if (command === 'DEL') {
      lists.delete(key);
      return new Response(JSON.stringify({ result: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (command === 'LPUSH') {
      shadowPushes += 1;
      if (shadowPushes === 2) throw new Error('simulated worker termination');
      const list = lists.get(key) || [];
      list.unshift(parts[2]);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], lists.get(key) || []);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ result: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await expect(saveScheduledPosts([
      { id: 'replacement-1', caption: 'Replacement one' },
      { id: 'replacement-2', caption: 'Replacement two' },
    ])).rejects.toThrow('simulated worker termination');
    expect(lists.get(liveKey)).toEqual([oldRecord]);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('scheduled queue replacement atomically swaps a complete shadow list into the live key', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  };
  const liveKey = 'default:scheduled:posts';
  const lists = new Map([[liveKey, [encodeURIComponent(JSON.stringify({ id: 'old-post' }))]]]);
  const locks = new Map();
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-kv-token';
  global.fetch = async url => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
    if (lockResponse) return lockResponse;
    if (command === 'DEL') {
      lists.delete(key);
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }
    if (command === 'LPUSH') {
      const list = lists.get(key) || [];
      list.unshift(parts[2]);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200 });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], lists.get(key) || []);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`Unexpected KV command: ${command}`);
  };

  try {
    await saveScheduledPosts([
      { id: 'replacement-1', caption: 'Replacement one' },
      { id: 'replacement-2', caption: 'Replacement two' },
    ]);
    const ids = (lists.get(liveKey) || []).map(raw => decodeScheduledQueueTestRecord(raw).id);
    expect(ids).toEqual(['replacement-1', 'replacement-2']);
    expect([...lists.keys()].filter(key => key.includes(':replace:'))).toEqual([]);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('saving one scheduled post preserves queue records beyond the old 200 item truncation', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  };
  const liveKey = 'default:scheduled:posts';
  const existing = Array.from({ length: 205 }, (_, index) => encodeURIComponent(JSON.stringify({
    id: `existing-${index + 1}`,
    status: 'draft',
    platform: 'instagram',
    caption: `Existing ${index + 1}`,
  })));
  const lists = new Map([[liveKey, existing]]);
  const locks = new Map();
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-kv-token';
  global.fetch = async url => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
    if (lockResponse) return lockResponse;
    if (command === 'LRANGE') return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
    if (command === 'DEL') {
      lists.delete(key);
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }
    if (command === 'LPUSH') {
      const list = lists.get(key) || [];
      list.unshift(parts[2]);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200 });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], lists.get(key) || []);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`Unexpected KV command: ${command}`);
  };

  try {
    await saveScheduledPost({
      id: 'new-record',
      status: 'draft',
      platform: 'instagram',
      caption: 'New record',
    });
    const saved = (lists.get(liveKey) || []).map(decodeScheduledQueueTestRecord);
    expect(saved).toHaveLength(206);
    expect(saved.map(record => record.id)).toEqual(expect.arrayContaining(['new-record', 'existing-1', 'existing-205']));
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('schedule recovery restores paused records and preserves unconfirmed external attempts as failed history', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  };
  const liveKey = 'default:scheduled:posts';
  const encode = value => encodeURIComponent(JSON.stringify(value));
  const lists = new Map([[liveKey, [
    encode({ id: 'paused-post', status: 'paused', platform: 'facebook', caption: 'Paused idea', scheduled_at: '2026-07-21T10:00:00.000Z' }),
    encode({ id: 'queued-pin', status: 'queued_external', platform: 'pinterest', caption: 'Unconfirmed pin', scheduled_at: '2026-07-22T10:00:00.000Z', approved_for_publish: true, approved_by: 'owner', publish_result: { callback_attempt_id: 'attempt-1' } }),
  ]]]);
  const locks = new Map();
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-kv-token';
  global.fetch = async url => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
    if (lockResponse) return lockResponse;
    if (command === 'LRANGE') return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
    if (command === 'DEL') {
      lists.delete(key);
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }
    if (command === 'LPUSH') {
      const list = lists.get(key) || [];
      list.unshift(parts[2]);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200 });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], lists.get(key) || []);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`Unexpected KV command: ${command}`);
  };

  try {
    const restored = await restoreScheduledPostToDraft('paused-post');
    expect(restored.record).toMatchObject({ id: 'paused-post', status: 'draft', scheduled_at: null, approved_for_publish: false });

    const recovered = await recoverQueuedExternalPostToDraft('queued-pin', { now: new Date('2026-07-27T12:00:00.000Z') });
    expect(recovered.record).toMatchObject({
      status: 'draft',
      scheduled_at: null,
      approved_for_publish: false,
      metadata: { recovered_from_external_record_id: 'queued-pin' },
    });
    expect(recovered.original).toMatchObject({
      id: 'queued-pin',
      status: 'failed',
      approved_for_publish: false,
      approved_by: null,
      publish_result: { callback_attempt_id: 'attempt-1' },
    });
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
process.env.SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS = 'true';

test('Social Hermes context exposes the complete queue instead of a first-50 sample', () => {
  const scheduledPosts = Array.from({ length: 75 }, (_, index) => ({
    id: `queue-${index + 1}`,
    status: 'draft',
    platform: 'instagram',
    created_at: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
  }));
  const context = safeSocialHermesContextPayload({ scheduledPosts, ownerTelegramUserId: 'owner-1' });
  expect(context.queue_summary.total_visible).toBe(75);
  expect(context.scheduled_posts).toHaveLength(75);
  expect(context.scheduled_posts.at(-1).id).toBe('queue-75');
});

test('paused scheduled records are inert and stay out of the active queue', () => {
  const classified = classifyScheduledPost({
    id: 'paused-future-post',
    status: 'paused',
    scheduled_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  });
  expect(classified).toMatchObject({
    queue_state: 'paused',
    is_active_queue: false,
    is_overdue: false,
    is_publishable_due: false,
  });
});

test('listing-understanding repair receives exact schema validation problems', () => {
  const problems = listingUnderstandingValidationProblems({
    available: true,
    platform_captions: { instagram: 'Too short' },
    platform_caption_reviews: {},
    media_strategy: null,
  }, {
    social_factory_path: true,
    platforms: ['instagram', 'facebook', 'pinterest'],
  }, true);
  expect(problems).toEqual(expect.arrayContaining([
    expect.stringContaining('media_strategy_invalid_or_missing'),
    expect.stringContaining('platform_captions_missing_or_too_short: instagram, facebook, pinterest'),
    expect.stringContaining('platform_caption_reviews_not_approved: instagram, facebook, pinterest'),
  ]));
});

test('listing-understanding repair rejects reference-required generation when provider capability is unavailable', () => {
  const caption = 'A grounded platform-specific caption that is long enough for strict validation.';
  const problems = listingUnderstandingValidationProblems({
    available: true,
    platform_captions: { instagram: caption },
    media_strategy: {
      format: 'single',
      target_media_count: 1,
      frames: [{
        id: 'faithful-mockup',
        role: 'product proof',
        source: 'generated_image',
        prompt: 'Show the exact sold design on a finished product.',
        rationale: 'The buyer needs to see the sold design in context.',
        reference_required: true,
        reference_media_rank: 1,
        aspect_ratio: '4:5',
      }],
      platform_variants: { instagram: { format: 'single', frame_ids: ['faithful-mockup'] } },
    },
  }, {
    social_factory_path: true,
    platforms: ['instagram'],
    image_provider_capabilities: { generated_image_available: true, reference_image_supported: false, reference_mode: 'unsupported' },
  });
  expect(problems).toEqual(expect.arrayContaining([
    expect.stringContaining('selected image model cannot preserve external reference pixels'),
  ]));
});

test('listing-understanding repair rejects master frames unused by every requested platform variant', () => {
  const problems = listingUnderstandingValidationProblems({
    available: true,
    platform_captions: {
      pinterest: 'A focused Pinterest caption with a concrete buyer benefit and enough detail for review.',
    },
    media_strategy: {
      format: 'carousel',
      target_media_count: 2,
      frames: [
        {
          id: 'pin-lead',
          role: 'buyer-facing lead',
          source: 'generated_image',
          prompt: 'Create one persuasive Pinterest lead image grounded in the actual offer.',
          rationale: 'This is the selected Pin asset.',
          communication_goal: 'Make the offer understandable at feed scale.',
          visible_buyer_evidence: 'The concrete offered result is visually dominant.',
          evidence_strength: 'primary',
          reference_required: false,
          aspect_ratio: '2:3',
        },
        {
          id: 'unused-alternate',
          role: 'unused alternate',
          source: 'generated_image',
          prompt: 'Create an alternate image that no requested platform selects.',
          rationale: 'This frame should not survive contract validation.',
          communication_goal: 'Unused.',
          visible_buyer_evidence: 'Unused.',
          evidence_strength: 'supporting',
          reference_required: false,
          aspect_ratio: '2:3',
        },
      ],
      platform_variants: {
        pinterest: {
          format: 'single',
          frame_ids: ['pin-lead'],
          buyer_evidence_frame_ids: ['pin-lead'],
        },
      },
    },
  }, {
    social_factory_path: true,
    platforms: ['pinterest'],
  });

  expect(problems).toEqual(expect.arrayContaining([
    expect.stringContaining('unused: unused-alternate'),
  ]));
});

test('listing-understanding repair rejects AI media choices that conflict with ranked vision evidence', () => {
  const problems = listingUnderstandingValidationProblems({
    available: true,
    platform_captions: {
      instagram: 'A grounded Instagram caption that is long enough for strict validation.',
      facebook: 'A grounded Facebook caption that is long enough for strict validation.',
    },
    media_strategy: {
      format: 'carousel',
      target_media_count: 2,
      frames: [
        { id: 'weak-lead', role: 'lead', source: 'listing_image', reference_media_rank: 2, rationale: 'AI selected this as the lead.' },
        { id: 'blocked-support', role: 'support', source: 'listing_image', reference_media_rank: 3, rationale: 'AI selected this as support.' },
      ],
      platform_variants: {
        instagram: { format: 'carousel', frame_ids: ['weak-lead', 'blocked-support'] },
        facebook: { format: 'multi_image', frame_ids: ['weak-lead', 'blocked-support'] },
      },
    },
  }, {
    social_factory_path: true,
    platforms: ['instagram', 'facebook'],
  }, false, {
    available: true,
    images: [
      { rank: 2, social_use_decision: 'support' },
      { rank: 3, social_use_decision: 'do_not_use' },
    ],
  });

  expect(problems).toEqual(expect.arrayContaining([
    expect.stringContaining('rank 2 is missing an explicit AI editorial decision'),
    expect.stringContaining('rank 3 is missing an explicit AI editorial decision'),
    expect.stringContaining('rank 3 do_not_use'),
    expect.stringContaining('instagram: lead frame weak-lead'),
    expect.stringContaining('facebook: lead frame weak-lead'),
  ]));
});

test('listing-understanding repair rejects incomplete or unapplied listing-media audit decisions', () => {
  const caption = 'A grounded platform-specific caption that is long enough for strict validation.';
  const problems = listingUnderstandingValidationProblems({
    available: true,
    platform_captions: { instagram: caption },
    media_strategy: {
      format: 'single',
      target_media_count: 1,
      listing_media_decisions: [
        {
          rank: 1,
          decision: 'use_exact',
          social_role: 'real finished result',
          rationale: 'The exact Etsy pixels are the strongest result evidence.',
        },
      ],
      frames: [{
        id: 'generated-lead',
        role: 'lead',
        source: 'generated_image',
        prompt: 'Create a truthful social-native conceptual lead.',
        rationale: 'The campaign needs a strong lead.',
        reference_required: false,
        aspect_ratio: '4:5',
      }],
      platform_variants: {
        instagram: { format: 'single', frame_ids: ['generated-lead'] },
      },
    },
  }, {
    social_factory_path: true,
    platforms: ['instagram'],
  }, false, {
    available: true,
    images: [
      { rank: 1, social_use_decision: 'hero' },
      { rank: 2, social_use_decision: 'support' },
    ],
  });

  expect(problems).toEqual(expect.arrayContaining([
    expect.stringContaining('rank 1 is marked use_exact but no exact listing frame uses it'),
    expect.stringContaining('rank 2 is missing an explicit AI editorial decision'),
  ]));
});

test('scheduled queue keeps the newest occurrence of each id', () => {
  expect(dedupeScheduledPosts([
    { id: 'same-post', status: 'published', updated_at: '2026-07-18T12:00:00Z' },
    { id: 'same-post', status: 'draft', updated_at: '2026-07-17T12:00:00Z' },
    { id: 'other-post', status: 'draft' },
  ])).toEqual([
    { id: 'same-post', status: 'published', updated_at: '2026-07-18T12:00:00Z' },
    { id: 'other-post', status: 'draft' },
  ]);
});

test('post-generation replan exposes accepted assets and bounded failures to AI without choosing the new frame count locally', () => {
  const resolution = buildSocialMediaGenerationResolution({
    phase: 'post_generation_replan',
    failed_or_exhausted_briefs: [{
      brief_id: 'pet-support',
      outcome: 'transport_attempts_exhausted',
      attempts: 2,
    }],
    instruction: 'Decide whether the two accepted frames complete the story or one different replacement is essential.',
  }, [
    {
      id: 'hero-asset',
      brief_id: 'merge-hero',
      source: 'generated_image',
      url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_aaaaaaaaaaaaaaaaaaaaaaaa',
      permanent: true,
      quality_review: { approved: true, rationale: 'The hero clearly shows many photos becoming one family portrait.' },
    },
    {
      id: 'memorial-asset',
      brief_id: 'memorial-support',
      source: 'generated_image',
      url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_bbbbbbbbbbbbbbbbbbbbbbbb',
      permanent: true,
      quality_review: { approved: true, rationale: 'The memorial use case is clear and respectful.' },
    },
  ]);

  expect(resolution).toMatchObject({
    phase: 'post_generation_replan',
    failed_or_exhausted_briefs: [expect.objectContaining({ brief_id: 'pet-support', attempts: 2 })],
    accepted_assets: [
      expect.objectContaining({ brief_id: 'merge-hero', permanent: true, quality_approved: true }),
      expect.objectContaining({ brief_id: 'memorial-support', permanent: true, quality_approved: true }),
    ],
  });
  expect(resolution).not.toHaveProperty('target_media_count');
});

test('a complete QA-approved generation batch reuses its exact AI-authored frame ids without another creative decision', () => {
  const strategy = {
    frames: [
      { id: 'generated-hero', source: 'generated_image' },
      {
        id: 'review-proof',
        source: 'review_card',
        review_id: 'review-42',
        context_note: 'Custom digital family photo composition service',
        review_card_design: testReviewCardDesign(),
        aspect_ratio: '1:1',
      },
    ],
    accepted_asset_decisions: [],
  };
  const context = {
    media_generation_resolution: buildSocialMediaGenerationResolution(null, [
      {
        brief_id: 'generated-hero',
        source: 'generated_image',
        url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_aaaaaaaaaaaaaaaaaaaaaaaa',
        permanent: true,
        quality_review: { approved: true, rationale: 'Approved by AI vision.' },
      },
      {
        brief_id: 'review-proof',
        source: 'review_card',
        review_id: 'review-42',
        context_note: 'Custom digital family photo composition service',
        review_card_design: testReviewCardDesign(),
        aspect_ratio: '1:1',
        render_spec_sha256: 'a'.repeat(64),
        url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_bbbbbbbbbbbbbbbbbbbbbbbb',
        permanent: true,
      },
    ]),
  };

  expect(aiMediaStrategyAcceptedAssetDecisionProblemsForTest(strategy, context)).toEqual([]);
});

test('a changed review-card context note cannot silently reuse stale pixels', () => {
  const strategy = {
    frames: [{
      id: 'review-proof',
      source: 'review_card',
      review_id: 'review-42',
      context_note: 'Custom digital memorial photo composition service',
      review_card_design: testReviewCardDesign(),
      aspect_ratio: '1:1',
    }],
    accepted_asset_decisions: [],
  };
  const context = {
    media_generation_resolution: buildSocialMediaGenerationResolution(null, [{
      brief_id: 'review-proof',
      source: 'review_card',
      review_id: 'review-42',
      context_note: 'Custom digital family photo composition service',
      review_card_design: testReviewCardDesign(),
      aspect_ratio: '1:1',
      render_spec_sha256: 'a'.repeat(64),
      url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_bbbbbbbbbbbbbbbbbbbbbbbb',
      permanent: true,
    }]),
  };

  expect(aiMediaStrategyAcceptedAssetDecisionProblemsForTest(strategy, context)).toEqual([
    'accepted asset review-proof: explicit reuse/discard decision missing',
  ]);
});

test('an explicit review-card reuse cannot change immutable rendered fields', () => {
  const strategy = {
    frames: [{
      id: 'review-proof',
      source: 'review_card',
      review_id: 'review-42',
      context_note: 'Custom digital family photo composition service',
      review_card_design: testReviewCardDesign(),
      aspect_ratio: '4:5',
    }],
    accepted_asset_decisions: [{
      brief_id: 'review-proof',
      decision: 'reuse',
      rationale: 'Keep the approved customer proof.',
    }],
  };
  const context = {
    media_generation_resolution: buildSocialMediaGenerationResolution(null, [{
      brief_id: 'review-proof',
      source: 'review_card',
      review_id: 'review-42',
      context_note: 'Custom digital family photo composition service',
      review_card_design: testReviewCardDesign(),
      aspect_ratio: '1:1',
      render_spec_sha256: 'a'.repeat(64),
      url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_bbbbbbbbbbbbbbbbbbbbbbbb',
      permanent: true,
    }]),
  };

  expect(aiMediaStrategyAcceptedAssetDecisionProblemsForTest(strategy, context)).toEqual([
    'accepted review-card review-proof: reuse cannot change review_id, context_note, aspect_ratio, or art direction; discard it and use a new frame id',
  ]);
});

test('a partial generation batch still requires an explicit AI reuse or discard decision', () => {
  const strategy = {
    frames: [
      { id: 'generated-hero', source: 'generated_image' },
      { id: 'generated-support', source: 'generated_image' },
    ],
    accepted_asset_decisions: [],
  };
  const context = {
    media_generation_resolution: buildSocialMediaGenerationResolution(null, [{
      brief_id: 'generated-hero',
      source: 'generated_image',
      url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_aaaaaaaaaaaaaaaaaaaaaaaa',
      permanent: true,
      quality_review: { approved: true, rationale: 'Approved by AI vision.' },
    }]),
  };

  expect(aiMediaStrategyAcceptedAssetDecisionProblemsForTest(strategy, context)).toContain(
    'accepted asset generated-hero: explicit reuse/discard decision missing',
  );
});

test('Social Hub Autopilot gives AI the complete inventory without fixed content taxonomy', () => {
  const listings = Array.from({ length: 120 }, (_, index) => ({
    listing_id: index + 1,
    title: `Listing ${index + 1}`,
    description: `Description ${index + 1}`,
    image_urls: [`https://img.example.test/${index + 1}.jpg`],
    num_favorers: 120 - index,
  }));
  const prompt = buildAutopilotPrompt({ listings, targetCount: 4, platforms: ['instagram', 'facebook'] });

  expect(prompt).toContain('"id":120');
  expect(prompt).toContain('"description":"Description 120"');
  expect(prompt).toContain('Decide media count, source, and final order independently');
  expect(prompt).not.toContain('Content mix:');
  expect(prompt).not.toContain('Requested content mix counts:');
});

test('Social Hub Autopilot orients cadence to United States buyer time zones', () => {
  const prompt = buildAutopilotPrompt({ listings: [], targetCount: 1, platforms: ['instagram'] });

  expect(prompt).toContain('Primary buyer audience: United States');
  expect(prompt).toContain('America/New_York');
  expect(prompt).toContain('America/Los_Angeles');
  expect(prompt).toContain('Return scheduled_at as an ISO UTC timestamp with Z');
  expect(prompt).toContain('avoid repeating the exact same local time');
});

test('Social Hub Autopilot blocks when Etsy AI Command Center supplies no configured platforms', () => {
  expect(() => buildAutopilotPrompt({ listings: [], targetCount: 1, platforms: [] }))
    .toThrow('Autopilot requires explicit configured platforms; no platform fallback is allowed.');
});

test('Social Hub generates every AI media brief without first-frame fallback', () => {
  const source = readFileSync(new URL('../public/pages/social.js', import.meta.url), 'utf8');

  expect(source).toContain('Promise.all(briefs.map');
  expect(source).toContain('AI media plan is missing explicit frame order');
  expect(source).not.toContain('generation_briefs?.[0]');
  expect(source).not.toContain("includes(p.platform) ? p.platform : 'instagram'");
});

test('Social Hub persistent media generation uses the admin-safe non-publishing action', async () => {
  const result = await callSocial({ action: 'adminGenerateMedia', prompt: '' });
  expect(result.statusCode).toBe(400);
  expect(result.payload).toMatchObject({
    success: false,
    action: 'adminGenerateMedia',
    code: 'PROMPT_REQUIRED',
    published: false,
  });
});

function mockResponse() {
  const captured = { statusCode: 200, payload: null };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.payload = payload; return payload; },
    end() { return undefined; },
  };
  return { res, captured };
}

function approvedCampaignVisualReview(platform = 'facebook') {
  return {
    ai_review_contract_version: 2,
    ai_campaign_visual_quality_review_required: true,
    ai_campaign_visual_quality_review: {
      approved: true,
      decision: 'approve',
      rationale: 'The complete platform media sequence clearly communicates the campaign offer.',
      platform_reviews: [{
        platform,
        decision: 'approve',
        rationale: `The final ${platform} media sequence is ready for owner review.`,
        issues: [],
      }],
    },
  };
}

test('Social Hermes review digest binds the exact caption and ordered media', () => {
  const record = {
    platform: 'instagram',
    caption: 'Exact final caption',
    media_items: [
      { url: 'https://img.example.test/one.jpg', source: 'listing_image', type: 'image' },
      { url: 'https://app.example.test/api/social?action=mediaAsset&id=two', source: 'generated_image', type: 'image', checksum_sha256: 'a'.repeat(64) },
    ],
  };
  const digest = socialHermesReviewContentDigest(record);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(socialHermesReviewContentDigest({ ...record, caption: 'Changed caption' })).not.toBe(digest);
  expect(socialHermesReviewContentDigest({ ...record, media_items: [...record.media_items].reverse() })).not.toBe(digest);
  expect(socialHermesReviewContentDigest({
    ...record,
    media_items: [record.media_items[0], { ...record.media_items[1], checksum_sha256: 'b'.repeat(64) }],
  })).not.toBe(digest);
});

test('scheduler pauses a due post when final server readiness is blocked', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
    AUTOPUBLISH: process.env.AUTOPUBLISH,
  };
  const post = {
    id: 'due-with-stale-review',
    platform: 'facebook',
    status: 'approved_scheduled',
    approved_for_publish: true,
    approved_by: 'owner-opt-in:auto-schedule',
    approved_at: '2026-07-20T00:00:00.000Z',
    scheduled_at: '2026-07-21T00:00:00.000Z',
    caption: 'Changed after the review was approved.',
    metadata: {
      owner_review_required: true,
      auto_publish_after_review_window: true,
      auto_publish_armed: true,
    },
  };
  const lists = new Map([['default:scheduled:posts', [encodeURIComponent(JSON.stringify(post))]]]);
  const locks = new Map();
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-kv-token';
  process.env.AUTOPUBLISH_ENABLED = 'true';
  process.env.AUTOPUBLISH = 'true';
  global.fetch = async (url) => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
    if (lockResponse) return lockResponse;
    if (command === 'LRANGE') return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
    if (command === 'SET') return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    if (command === 'DEL') { lists.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
    if (command === 'LPUSH') {
      const list = lists.get(key) || [];
      for (const value of parts.slice(2)) list.unshift(value);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200 });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], lists.get(key) || []);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`Unexpected external request: ${url}`);
  };
  try {
    const result = await publishDueScheduled({
      now: '2026-07-22T00:00:00.000Z',
      readinessCheck: async () => ({
        ready_for_publish: false,
        blockers: [{ code: 'AI_REVIEW_CONTENT_CHANGED', message: 'Content changed.' }],
      }),
    });
    expect(result.results).toEqual([expect.objectContaining({
      id: post.id,
      success: false,
      blocked: true,
      blockers: [expect.objectContaining({ code: 'AI_REVIEW_CONTENT_CHANGED' })],
    })]);
    const saved = (lists.get('default:scheduled:posts') || []).map(decodeScheduledQueueTestRecord);
    expect(saved[0]).toMatchObject({
      id: post.id,
      status: 'paused',
      approved_for_publish: false,
      approval_source: null,
      metadata: {
        owner_review_required: true,
        auto_publish_after_review_window: false,
        auto_publish_armed: false,
        auto_publish_disarmed_at: expect.any(String),
      },
    });
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('scheduler skips a due post when another run already owns the publish lock', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
    AUTOPUBLISH: process.env.AUTOPUBLISH,
  };
  const post = {
    id: 'already-claimed-post',
    platform: 'facebook',
    status: 'approved_scheduled',
    approved_for_publish: true,
    approved_by: 'owner-opt-in:auto-schedule',
    approved_at: '2026-07-20T00:00:00.000Z',
    scheduled_at: '2026-07-21T00:00:00.000Z',
    caption: 'Ready but another scheduler run claimed it first.',
  };
  const queueKey = 'default:scheduled:posts';
  const lockKey = 'default:scheduled:publish-lock:already-claimed-post';
  const lists = new Map([[queueKey, [encodeURIComponent(JSON.stringify(post))]]]);
  const locks = new Map([[lockKey, 'other-run']]);
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-kv-token';
  process.env.AUTOPUBLISH_ENABLED = 'true';
  process.env.AUTOPUBLISH = 'true';
  global.fetch = async (url) => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
    if (lockResponse) return lockResponse;
    if (command === 'LRANGE') return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
    if (command === 'SET') {
      if (locks.has(key)) return new Response(JSON.stringify({ result: null }), { status: 200 });
      locks.set(key, parts[2] || 'token');
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (command === 'DEL') { locks.delete(key); lists.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
    if (command === 'LPUSH') {
      const list = lists.get(key) || [];
      for (const value of parts.slice(2)) list.unshift(value);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200 });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], lists.get(key) || []);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`Unexpected external request: ${url}`);
  };
  try {
    const result = await publishDueScheduled({
      now: '2026-07-22T00:00:00.000Z',
      readinessCheck: async () => {
        throw new Error('readiness should not run when publish lock is held');
      },
    });
    expect(result.results).toEqual([expect.objectContaining({
      id: post.id,
      success: false,
      skipped: true,
      locked: true,
    })]);
    const saved = (lists.get(queueKey) || []).map(decodeScheduledQueueTestRecord);
    expect(saved[0]).toMatchObject({
      id: post.id,
      status: 'approved_scheduled',
      approved_for_publish: true,
    });
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('scheduler releases only the publish lock token owned by its run', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
    AUTOPUBLISH: process.env.AUTOPUBLISH,
  };
  const post = {
    id: 'lock-owner-changed-post',
    platform: 'facebook',
    status: 'approved_scheduled',
    approved_for_publish: true,
    approved_by: 'owner-opt-in:auto-schedule',
    approved_at: '2026-07-20T00:00:00.000Z',
    scheduled_at: '2026-07-21T00:00:00.000Z',
    caption: 'The lock owner changes while readiness runs.',
  };
  const queueKey = 'default:scheduled:posts';
  const lockKey = 'default:scheduled:publish-lock:lock-owner-changed-post';
  const lists = new Map([[queueKey, [encodeURIComponent(JSON.stringify(post))]]]);
  const locks = new Map();
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-kv-token';
  process.env.AUTOPUBLISH_ENABLED = 'true';
  process.env.AUTOPUBLISH = 'true';
  global.fetch = async (url) => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
    if (lockResponse) return lockResponse;
    if (command === 'LRANGE') return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
    if (command === 'SET') {
      if (locks.has(key)) return new Response(JSON.stringify({ result: null }), { status: 200 });
      locks.set(key, parts[2]);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (command === 'EVAL') {
      const evalKey = parts[3];
      const token = parts[4];
      const owned = locks.get(evalKey) === token;
      if (owned) locks.delete(evalKey);
      return new Response(JSON.stringify({ result: owned ? 1 : 0 }), { status: 200 });
    }
    if (command === 'DEL') { lists.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
    if (command === 'LPUSH') {
      const list = lists.get(key) || [];
      for (const value of parts.slice(2)) list.unshift(value);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200 });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], lists.get(key) || []);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`Unexpected external request: ${url}`);
  };
  try {
    const result = await publishDueScheduled({
      now: '2026-07-22T00:00:00.000Z',
      readinessCheck: async () => {
        expect(locks.has(lockKey)).toBe(true);
        locks.set(lockKey, 'replacement-owner-token');
        return { ready_for_publish: false, blockers: [{ code: 'TEST_BLOCKED' }] };
      },
    });
    expect(result.results[0]).toMatchObject({ id: post.id, blocked: true });
    expect(locks.get(lockKey)).toBe('replacement-owner-token');
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Pinterest callback can complete before Make webhook response without being overwritten', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
    AUTOPUBLISH: process.env.AUTOPUBLISH,
    MAKE_WEBHOOK_URL: process.env.MAKE_WEBHOOK_URL,
    MAKE_CALLBACK_SECRET: process.env.MAKE_CALLBACK_SECRET,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  };
  const post = {
    id: 'fast-make-callback-post',
    platform: 'pinterest',
    status: 'approved_scheduled',
    approved_for_publish: true,
    approved_by: 'owner-opt-in:auto-schedule',
    approved_at: '2026-07-20T00:00:00.000Z',
    scheduled_at: '2026-07-21T00:00:00.000Z',
    caption: 'A ready Pinterest pin.',
    media_items: [{ url: 'https://em.example.test/api/social?action=mediaAsset&id=pin-one', type: 'image' }],
  };
  const queueKey = 'default:scheduled:posts';
  const lists = new Map([[queueKey, [encodeURIComponent(JSON.stringify(post))]]]);
  const values = new Map();
  const locks = new Map();
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-kv-token';
  process.env.AUTOPUBLISH_ENABLED = 'true';
  process.env.AUTOPUBLISH = 'true';
  process.env.MAKE_WEBHOOK_URL = 'https://make.example.test/hook';
  process.env.MAKE_CALLBACK_SECRET = 'make-callback-secret';
  process.env.PUBLIC_BASE_URL = 'https://em.example.test';
  global.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    if (parsedUrl.hostname === 'make.example.test') {
      const payload = JSON.parse(String(init.body || '{}'));
      const queued = (lists.get(queueKey) || []).map(decodeScheduledQueueTestRecord);
      expect(queued[0]).toMatchObject({
        id: post.id,
        status: 'publishing',
        publish_result: { status: 'dispatching', callback_attempt_id: payload.callback_attempt_id },
      });
      await applyMakeCallback({
        scheduled_post_id: post.id,
        status: 'published',
        callback_attempt_id: payload.callback_attempt_id,
        post_url: 'https://www.pinterest.com/pin/fast-callback/',
      });
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }
    const parts = parsedUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
    if (lockResponse) return lockResponse;
    if (command === 'GET') return new Response(JSON.stringify({ result: values.get(key) || null }), { status: 200 });
    if (command === 'LRANGE') return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
    if (command === 'SET') {
      if (locks.has(key)) return new Response(JSON.stringify({ result: null }), { status: 200 });
      locks.set(key, parts[2]);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (command === 'EVAL') {
      const evalKey = parts[3];
      const token = parts[4];
      const owned = locks.get(evalKey) === token;
      if (owned) locks.delete(evalKey);
      return new Response(JSON.stringify({ result: owned ? 1 : 0 }), { status: 200 });
    }
    if (command === 'DEL') { lists.delete(key); values.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
    if (command === 'LPUSH') {
      const list = lists.get(key) || [];
      for (const value of parts.slice(2)) list.unshift(value);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200 });
    }
    if (command === 'LTRIM') {
      const list = lists.get(key) || [];
      lists.set(key, list.slice(Number(parts[2]), Number(parts[3]) + 1));
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], lists.get(key) || []);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`Unexpected external request: ${url}`);
  };
  try {
    const result = await publishDueScheduled({
      now: '2026-07-22T00:00:00.000Z',
      readinessCheck: async () => ({ ready_for_publish: true, blockers: [] }),
    });
    const saved = (lists.get(queueKey) || []).map(decodeScheduledQueueTestRecord);
    expect(saved[0]).toMatchObject({
      id: post.id,
      status: 'published',
      post_url: 'https://www.pinterest.com/pin/fast-callback/',
    });
    expect(result.results[0]).toMatchObject({ id: post.id, success: true, queued: false });
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('cron bearer is scoped to scheduler actions only', async () => {
  const originalEnv = {
    CRON_SECRET: process.env.CRON_SECRET,
    SITE_PASSWORD: process.env.SITE_PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET,
  };
  process.env.CRON_SECRET = 'cron-only-secret';
  process.env.SITE_PASSWORD = 'owner-password';
  process.env.SESSION_SECRET = 'test-session-secret';
  try {
    const { res, captured } = mockResponse();
    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer cron-only-secret' },
      query: {},
      body: { action: 'adminCanaryReadiness' },
    }, res);
    expect(captured.statusCode).toBe(401);
    expect(captured.payload).toMatchObject({ code: 'AUTH_REQUIRED' });
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Make callbacks require the dedicated Make secret instead of the cron bearer', async () => {
  const originalEnv = {
    CRON_SECRET: process.env.CRON_SECRET,
    MAKE_CALLBACK_SECRET: process.env.MAKE_CALLBACK_SECRET,
    SITE_PASSWORD: process.env.SITE_PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET,
  };
  process.env.CRON_SECRET = 'cron-only-secret';
  delete process.env.MAKE_CALLBACK_SECRET;
  process.env.SITE_PASSWORD = 'owner-password';
  process.env.SESSION_SECRET = 'test-session-secret';
  try {
    const { res, captured } = mockResponse();
    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer cron-only-secret' },
      query: {},
      body: { action: 'makeCallback', scheduled_post_id: 'post-1', status: 'published' },
    }, res);
    expect(captured.statusCode).toBe(401);
    expect(captured.payload).toMatchObject({ code: 'AUTH_REQUIRED' });
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Make callback is bound to the queued publish attempt and stores only allowlisted fields', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  };
  const queueKey = 'default:scheduled:posts';
  const post = {
    id: 'make-attempt-post',
    platform: 'pinterest',
    status: 'queued_external',
    scheduled_at: '2026-07-21T00:00:00.000Z',
    caption: 'Queued pin.',
    publish_result: {
      method: 'Make.com Pinterest bridge',
      queued: true,
      callback_attempt_id: 'attempt-123',
    },
  };
  const lists = new Map([[queueKey, [encodeURIComponent(JSON.stringify(post))]]]);
  const locks = new Map();
  process.env.KV_REST_API_URL = 'https://kv.example.test';
  process.env.KV_REST_API_TOKEN = 'test-kv-token';
  global.fetch = async (url) => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
    if (lockResponse) return lockResponse;
    if (command === 'LRANGE') return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
    if (command === 'DEL') { lists.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
    if (command === 'LPUSH') {
      const list = lists.get(key) || [];
      for (const value of parts.slice(2)) list.unshift(value);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200 });
    }
    if (command === 'RENAME') {
      lists.set(parts[2], lists.get(key) || []);
      lists.delete(key);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`Unexpected external request: ${url}`);
  };
  try {
    await expect(applyMakeCallback({
      scheduled_post_id: post.id,
      status: 'published',
      callback_attempt_id: 'wrong-attempt',
    })).rejects.toThrow(/attempt mismatch/);

    const result = await applyMakeCallback({
      scheduled_post_id: post.id,
      status: 'published',
      callback_attempt_id: 'attempt-123',
      service: 'Make.com',
      post_url: 'https://www.pinterest.com/pin/123/',
      pin_id: 'pin-123',
      secret: 'must-not-be-persisted',
      nested: { arbitrary: true },
    });
    expect(result.updated).toMatchObject({
      id: post.id,
      status: 'published',
      post_url: 'https://www.pinterest.com/pin/123/',
      publish_result: {
        method: 'Make.com',
        status: 'published',
        callback_attempt_id: 'attempt-123',
        external_id: 'pin-123',
      },
    });
    expect(result.updated.publish_result.raw).toBeUndefined();
    expect(result.updated.publish_result.secret).toBeUndefined();
    expect(result.updated.publish_result.nested).toBeUndefined();
    const historyEnvelope = JSON.parse(decodeURIComponent(
      lists.get('default:posts:history')?.[0] || '',
    ));
    const history = historyEnvelope.record;
    expect(history).toMatchObject({
      listing_id: null,
      platform: 'pinterest',
      status: 'published',
      post_url: 'https://www.pinterest.com/pin/123/',
    });
    expect(historyEnvelope).toMatchObject({
      schema_version: 1,
      record_type: 'social_publish_history',
    });
    expect(history).not.toHaveProperty('schema_version');
    expect(history).not.toHaveProperty('record_type');
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

async function callSocial(body) {
  const { res, captured } = mockResponse();
  await socialHandler({ method: 'POST', headers: {}, query: {}, body }, res);
  return captured;
}

async function callKv(body) {
  const { res, captured } = mockResponse();
  await kvHandler({ method: 'POST', headers: {}, query: {}, body }, res);
  return captured;
}

test('legacy direct publish API actions are retired even when autopublish is enabled', async () => {
  const originalAutopublishEnabled = process.env.AUTOPUBLISH_ENABLED;
  const originalAutopublish = process.env.AUTOPUBLISH;
  const originalSitePassword = process.env.SITE_PASSWORD;
  const originalSessionSecret = process.env.SESSION_SECRET;
  const originalFetch = global.fetch;
  const networkCalls = [];
  process.env.AUTOPUBLISH_ENABLED = 'true';
  process.env.AUTOPUBLISH = 'true';
  delete process.env.SITE_PASSWORD;
  delete process.env.SESSION_SECRET;
  global.fetch = async (...args) => {
    networkCalls.push(args);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    for (const action of [
      'postBuffer',
      'postMake',
      'postZapier',
      'postMetricool',
      'postInstagram',
      'postInstagramCarousel',
      'postFacebook',
      'postPinterest',
      'smartPost',
      'sendToBuffer',
      'sendToMetricool',
      'sendToMake',
      'sendToZapier',
    ]) {
      const captured = await callSocial({ action, caption: 'Must not publish', imageUrl: 'https://img.example.test/test.jpg' });
      expect(captured.statusCode).toBe(410);
      expect(captured.payload).toMatchObject({
        success: false,
        code: 'DIRECT_PUBLISH_ROUTE_RETIRED',
        published: false,
      });
    }
    expect(networkCalls).toHaveLength(0);
  } finally {
    global.fetch = originalFetch;
    if (originalAutopublishEnabled === undefined) delete process.env.AUTOPUBLISH_ENABLED;
    else process.env.AUTOPUBLISH_ENABLED = originalAutopublishEnabled;
    if (originalAutopublish === undefined) delete process.env.AUTOPUBLISH;
    else process.env.AUTOPUBLISH = originalAutopublish;
    if (originalSitePassword === undefined) delete process.env.SITE_PASSWORD;
    else process.env.SITE_PASSWORD = originalSitePassword;
    if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSessionSecret;
  }
});

test.describe.skip('Retired direct publish API implementation history', () => {
  let originalFetch;
  let originalEnv;
  let calls;

  test.beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = {
      FACEBOOK_PAGE_TOKEN: process.env.FACEBOOK_PAGE_TOKEN,
      FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,
      PINTEREST_ACCESS_TOKEN: process.env.PINTEREST_ACCESS_TOKEN,
      MAKE_WEBHOOK_URL: process.env.MAKE_WEBHOOK_URL,
      BUFFER_ACCESS_TOKEN: process.env.BUFFER_ACCESS_TOKEN,
      BUFFER_PROFILE_IDS: process.env.BUFFER_PROFILE_IDS,
      ZAPIER_WEBHOOK_URL: process.env.ZAPIER_WEBHOOK_URL,
      METRICOOL_API_KEY: process.env.METRICOOL_API_KEY,
      METRICOOL_BRAND_ID: process.env.METRICOOL_BRAND_ID,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
      SITE_PASSWORD: process.env.SITE_PASSWORD,
      SESSION_SECRET: process.env.SESSION_SECRET,
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      EXTERNAL_AI_BASE_URL: process.env.EXTERNAL_AI_BASE_URL,
      EXTERNAL_AI_API_KEY: process.env.EXTERNAL_AI_API_KEY,
      EXTERNAL_AI_MODEL: process.env.EXTERNAL_AI_MODEL,
      EXTERNAL_VISION_MODEL: process.env.EXTERNAL_VISION_MODEL,
      EXTERNAL_IMAGE_MODEL: process.env.EXTERNAL_IMAGE_MODEL,
      EXTERNAL_AI_TEXT_PATH: process.env.EXTERNAL_AI_TEXT_PATH,
    };
    calls = [];
    delete process.env.FACEBOOK_PAGE_TOKEN;
    delete process.env.FACEBOOK_PAGE_ID;
    delete process.env.PINTEREST_ACCESS_TOKEN;
    delete process.env.MAKE_WEBHOOK_URL;
    delete process.env.BUFFER_ACCESS_TOKEN;
    delete process.env.BUFFER_PROFILE_IDS;
    delete process.env.ZAPIER_WEBHOOK_URL;
    delete process.env.METRICOOL_API_KEY;
    delete process.env.METRICOOL_BRAND_ID;
    delete process.env.SITE_PASSWORD;
    delete process.env.SESSION_SECRET;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.EXTERNAL_AI_BASE_URL;
    delete process.env.EXTERNAL_AI_API_KEY;
    delete process.env.EXTERNAL_AI_MODEL;
    delete process.env.EXTERNAL_VISION_MODEL;
    delete process.env.EXTERNAL_IMAGE_MODEL;
    delete process.env.EXTERNAL_AI_TEXT_PATH;
    process.env.AUTOPUBLISH_ENABLED = 'true';
    process.env.AUTOPUBLISH = 'true';
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('Facebook direct publish uses token and page id from request body', async () => {
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ id: 'page_123_post_456' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const captured = await callSocial({
      action: 'postFacebook',
      token: 'body-page-token',
      pageId: 'page_123',
      text: 'Caption',
      link: 'https://www.etsy.com/listing/1',
    });

    expect(captured.statusCode).toBe(200);
    expect(captured.payload).toMatchObject({ success: true, published: true, post_id: 'page_123_post_456' });
    expect(calls[0].url).toContain('graph.facebook.com/v25.0/page_123/feed');
    expect(calls[0].url).toContain('access_token=body-page-token');
  });

  test('Make webhook is Pinterest-only and rejects Instagram/Facebook routing', async () => {
    process.env.AUTOPUBLISH_ENABLED = 'true';
    process.env.AUTOPUBLISH = 'true';
    process.env.MAKE_WEBHOOK_URL = 'https://hook.example.test/social';
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const captured = await callSocial({ action: 'postMake', platform: 'instagram', text: 'Should not route through Make' });

    expect(captured.statusCode).toBe(400);
    expect(captured.payload).toMatchObject({ success: false, expected_route: 'instagram/facebook=direct_api, pinterest=make' });
    expect(calls).toHaveLength(0);
  });

  test('Make webhook queues Pinterest only, not reported as published', async () => {
    process.env.AUTOPUBLISH_ENABLED = 'true';
    process.env.AUTOPUBLISH = 'true';
    process.env.MAKE_WEBHOOK_URL = 'https://hook.example.test/social';
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const captured = await callSocial({
      action: 'postMake',
      platform: 'pinterest',
      text: 'Queued pin',
      imageUrl: 'https://img.example.test/pin.jpg',
    });

    expect(captured.statusCode).toBe(200);
    expect(captured.payload).toMatchObject({ success: true, published: false, queued: true, publish_status: 'queued_external', status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hook.example.test/social');
    expect(calls[0].body.platform).toBe('pinterest');
    expect(calls[0].body.imageUrls).toEqual(['https://img.example.test/pin.jpg']);
    expect(calls[0].body.media_items).toHaveLength(1);
  });

  test('Make Pinterest route rejects multi-image payloads instead of pretending they are a carousel', async () => {
    process.env.MAKE_WEBHOOK_URL = 'https://hook.example.test/social';
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const captured = await callSocial({
      action: 'postMake',
      platform: 'pinterest',
      text: 'Invalid multi-image pin',
      imageUrls: ['https://img.example.test/one.jpg', 'https://img.example.test/two.jpg'],
    });

    expect(captured.statusCode).toBe(400);
    expect(captured.payload).toMatchObject({ success: false, code: 'PINTEREST_SINGLE_PIN_MEDIA_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  for (const connector of [
    {
      name: 'Buffer',
      action: 'postBuffer',
      env: { BUFFER_ACCESS_TOKEN: 'buffer-test-token', BUFFER_PROFILE_IDS: 'profile_1' },
      httpStatus: 202,
      response: { updates: [{ id: 'buffer_queued_1' }] },
    },
    {
      name: 'Zapier',
      action: 'postZapier',
      env: { ZAPIER_WEBHOOK_URL: 'https://zapier.example.test/hook' },
      httpStatus: 202,
      response: { status: 'success' },
    },
    {
      name: 'Metricool',
      action: 'postMetricool',
      env: { METRICOOL_API_KEY: 'metricool-test-key', METRICOOL_BRAND_ID: 'brand_1' },
      httpStatus: 202,
      response: { id: 'metricool_queued_1' },
    },
  ]) {
    test(`${connector.name} accepted/queued response remains queued_external, not published`, async () => {
      Object.assign(process.env, connector.env);
      global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        return new Response(JSON.stringify(connector.response), { status: connector.httpStatus, headers: { 'Content-Type': 'application/json' } });
      };

      const captured = await callSocial({ action: connector.action, platform: 'tiktok', text: 'Safe queued regression' });

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        published: false,
        queued: true,
        publish_status: 'queued_external',
      });
      expect(captured.payload).not.toMatchObject({ published: true });
      expect(calls.length).toBeGreaterThan(0);
    });
  }

  test('Pinterest direct publish accepts UI token, boardId, and caption aliases', async () => {
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: 'pin_789' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const captured = await callSocial({
      action: 'postPinterest',
      token: 'pin-token',
      boardId: 'board_1',
      title: 'Pin title',
      caption: 'Pin caption',
      imageUrl: 'https://img.example.test/a.jpg',
      link: 'https://www.etsy.com/listing/1',
    });

    expect(captured.statusCode).toBe(200);
    expect(captured.payload).toMatchObject({ success: true, published: true, pin_id: 'pin_789' });
    expect(calls[0].body).toMatchObject({ board_id: 'board_1', description: 'Pin caption' });
    expect(calls[0].options.headers.Authorization).toBe('Bearer pin-token');
  });

  test('Instagram direct publish preserves full Meta permalink without duplicating the domain', async () => {
    const originalEnv = {
      SITE_PASSWORD: process.env.SITE_PASSWORD,
      SESSION_SECRET: process.env.SESSION_SECRET,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
      INSTAGRAM_ACCESS_TOKEN: process.env.INSTAGRAM_ACCESS_TOKEN,
      INSTAGRAM_USER_ID: process.env.INSTAGRAM_USER_ID,
    };
    delete process.env.SITE_PASSWORD;
    delete process.env.SESSION_SECRET;
    process.env.AUTOPUBLISH_ENABLED = 'true';
    process.env.AUTOPUBLISH = 'true';
    process.env.INSTAGRAM_ACCESS_TOKEN = 'ig-secret-token';
    process.env.INSTAGRAM_USER_ID = 'ig-user-1';
    global.fetch = async (url) => {
      const value = String(url);
      if (value.includes('/media?') && value.includes('image_url=')) {
        return new Response(JSON.stringify({ id: 'container_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (value.includes('/container_1?fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (value.includes('/media_publish?')) {
        return new Response(JSON.stringify({ id: 'media_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (value.includes('/media_1?fields=permalink')) {
        return new Response(JSON.stringify({ permalink: 'https://www.instagram.com/p/live-post/' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unexpected fetch' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const captured = await callSocial({
        action: 'postInstagram',
        caption: 'Test caption',
        imageUrl: 'https://img.example.test/post.jpg',
      });

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        media_id: 'media_1',
        post_url: 'https://www.instagram.com/p/live-post/',
      });
      expect(captured.payload.post_url).not.toContain('instagram.comhttps://');
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test.describe('Social autonomous factory regression', () => {
  test('factory continues with AI shop evidence when live web research is unavailable', () => {
    const code = String.raw`
import importlib.util
import json
import os
import pathlib
import tempfile

os.environ["SOCIAL_HERMES_API_TOKEN"] = "unit-token"
os.environ["SOCIAL_FACTORY_CREATE_PER_RUN"] = "1"
os.environ["SOCIAL_FACTORY_TARGET_UPCOMING"] = "99"
os.environ["SOCIAL_FACTORY_DRY_RUN"] = "true"
spec = importlib.util.spec_from_file_location("factory", "scripts/social_autonomous_content_factory.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

m.TOKEN = "unit-token"
m.OWNER = "owner-1"
m.CREATE_PER_RUN = 1
m.TARGET_UPCOMING = 99
m.DRY_RUN = True
m.MEMORY_PATH = pathlib.Path(tempfile.mkdtemp()) / "social_factory_unit_memory_no_web.json"
m.build_current_research = lambda _ac, _now, *_args: {
    "status": "unavailable",
    "external_research_used": False,
    "summary": "",
    "sources": [],
    "signals": [],
    "reason": "unit web research unavailable",
}

listing = {
    "listing_id": "shop-evidence-listing",
    "state": "active",
    "title": "Custom family keepsake",
    "url": "https://www.etsy.com/listing/shop-evidence-listing",
    "image_url": "https://img.example.test/listing.jpg",
    "images": [{"url_fullxfull": "https://img.example.test/listing.jpg"}],
}
content_opportunity_calls = []

def bridge(action, body=None, method="POST", timeout=40):
    body = body or {}
    if action == "refreshShopContext":
        return {"success": True, "data": {"listings": [listing]}}
    if action == "context":
        return {"success": True, "data": {
            "bridge": {"publish_governance": {"autopublish_enabled": False}},
            "social_config_summary": {"configured_platforms": ["instagram"]},
            "scheduled_posts": [],
            "autonomous_context": {"listings": [listing]},
        }}
    if action == "contentOpportunities":
        content_opportunity_calls.append(body)
        return {"success": True, "data": {
            "status": "ready",
            "opportunities": [{
                "id": "shop-evidence-opportunity",
                "type": "ai_selected_opportunity",
                "priority": 90,
                "moment": "Useful evergreen buyer story",
                "reason": "AI selected a shop-evidence spotlight.",
                "research_basis": "shop_evidence",
                "research_source_ids": [],
                "suggested_platforms": [],
                "listing_candidates": [{"listing_id": "shop-evidence-listing"}],
            }],
        }}
    raise AssertionError(f"unexpected bridge action {action}")

m.bridge = bridge
exit_code = m.run_factory()
print(json.dumps({
    "exit_code": exit_code,
    "content_opportunity_calls": len(content_opportunity_calls),
    "final_research": content_opportunity_calls[-1].get("current_research"),
}))
assert len(content_opportunity_calls) == 1, (exit_code, content_opportunity_calls)
assert content_opportunity_calls[-1]["current_research"]["external_research_used"] is False
`;
    const output = execFileSync(PYTHON_BIN, ['-c', code], {
      cwd: process.cwd(),
      env: { ...process.env, SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS: 'true', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(output).toContain('continuing with AI shop-evidence/evergreen selection');
    expect(output).toContain('"content_opportunity_calls": 1');
    expect(output).toContain('"external_research_used": false');
  });

  test('CREATE_PER_RUN counts campaign packages, not individual platform variants', () => {
    const code = String.raw`
import importlib.util
import json
import os
import pathlib
import tempfile

os.environ["SOCIAL_HERMES_API_TOKEN"] = "unit-token"
os.environ["SOCIAL_FACTORY_CREATE_PER_RUN"] = "1"
os.environ["SOCIAL_FACTORY_TARGET_UPCOMING"] = "99"
os.environ["SOCIAL_FACTORY_DRY_RUN"] = "false"
spec = importlib.util.spec_from_file_location("factory", "scripts/social_autonomous_content_factory.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

m.TOKEN = "unit-token"
m.OWNER = "owner-1"
m.CREATE_PER_RUN = 1
m.TARGET_UPCOMING = 99
m.DRY_RUN = False
m.WEB_RESEARCH_ENABLED = True
m.MEMORY_PATH = pathlib.Path(tempfile.mkdtemp()) / "social_factory_unit_memory_missing.json"
m.build_current_research = lambda _ac, _now, *_args: {
    "status": "researched",
    "external_research_used": True,
    "summary": "unit current research",
    "sources": [{"title": "unit", "url": "https://example.test", "description": "unit"}],
    "signals": ["unit signal"],
}

listing = {
    "listing_id": "unit-listing-1",
    "state": "active",
    "title": "Custom family keepsake digital portrait",
    "url": "https://www.etsy.com/listing/unit-listing-1",
    "image_url": "https://img.example.test/listing-1.jpg",
    "images": [
        {"url_fullxfull": "https://img.example.test/1.jpg"},
        {"url_fullxfull": "https://img.example.test/2.jpg"},
        {"url_fullxfull": "https://img.example.test/3.jpg"},
    ],
}
media = [
    {"url": "https://img.example.test/1.jpg", "type": "image", "source": "listing_image", "alt": "one"},
    {"url": "https://img.example.test/2.jpg", "type": "image", "source": "listing_image", "alt": "two"},
    {"url": "https://img.example.test/3.jpg", "type": "image", "source": "listing_image", "alt": "three"},
]
save_review_calls = []
content_opportunity_calls = []

def bridge(action, body=None, method="POST", timeout=40):
    body = body or {}
    if action == "refreshShopContext":
        return {"success": True, "data": {"listings": [listing]}}
    if action == "context":
        return {"success": True, "data": {
            "bridge": {"publish_governance": {"autopublish_enabled": False}},
            "social_config_summary": {"configured_platforms": ["instagram", "facebook", "pinterest"]},
            "scheduled_posts": [],
            "autonomous_context": {"listings": [listing]},
        }}
    if action == "contentOpportunities":
        content_opportunity_calls.append(body)
        return {"success": True, "data": {
            "status": "ready",
            "external_research_used": True,
            "opportunities": [{
                "id": "unit-opportunity",
                "type": "ai_selected_opportunity",
                "priority": 100,
                "moment": "AI-selected campaign package",
                "reason": "AI selected a natural multi-platform campaign.",
                "suggested_platforms": ["instagram", "facebook", "pinterest"],
                "timing": {
                    "audience_timezone": "America/New_York",
                    "rationale": "Unit-test US audience schedule.",
                    "scheduled_at_by_platform": {
                        "instagram": "2099-07-22T14:00:00.000Z",
                        "facebook": "2099-07-22T15:00:00.000Z",
                        "pinterest": "2099-07-22T16:00:00.000Z",
                    },
                },
                "context": {
                    "occasion": "unit campaign",
                    "audience": "buyers",
                    "campaign_context": "Promote this family keepsake as one coherent platform package.",
                },
                "listing_candidates": [{
                    **listing,
                    "listing_campaign_fit": {"decision": "strong_fit", "should_use_listing": True, "confidence": 0.9},
                }],
            }],
        }}
    if action == "creativePlan":
        return {"success": True, "data": {
            "status": "ready_for_review",
            "campaign_id": "campaign_unit_package",
            "concept": {"name": "Unit Campaign Package", "hook": "One idea, all platforms"},
            "media_strategy": {
                "format": "carousel",
                "target_media_count": 3,
                "required_visible_evidence": "A clearly visible custom family keepsake result.",
                "platform_variants": {
                    "instagram": {"format": "carousel", "frame_ids": ["listing-1", "listing-2", "listing-3"], "buyer_evidence_frame_ids": ["listing-1", "listing-2"]},
                    "facebook": {"format": "multi_image", "frame_ids": ["listing-1", "listing-2"], "buyer_evidence_frame_ids": ["listing-1"]},
                    "pinterest": {"format": "single", "frame_ids": ["listing-3"], "buyer_evidence_frame_ids": ["listing-3"]},
                },
                "frames": [
                    {"id": "listing-1", "source": "listing_image", "reference_media_rank": 1, "communication_goal": "Lead with the finished keepsake result.", "visible_buyer_evidence": "The completed family portrait is visible.", "evidence_strength": "primary"},
                    {"id": "listing-2", "source": "listing_image", "reference_media_rank": 2, "communication_goal": "Show a supporting detail of the result.", "visible_buyer_evidence": "A second finished detail supports the offer.", "evidence_strength": "supporting"},
                    {"id": "listing-3", "source": "listing_image", "reference_media_rank": 3, "communication_goal": "Provide an alternate finished view.", "visible_buyer_evidence": "The alternate finished view remains product evidence.", "evidence_strength": "supporting"},
                ],
            },
            "storyboard": [{"role": "hook"}, {"role": "product_evidence"}, {"role": "product_evidence"}],
            "generation_decision": {"status": "not_needed"},
            "variants": [
                {"platform": "instagram", "format": "carousel", "variant_of": "campaign_unit_package", "caption": "A keepsake idea for the family story. #familykeepsake #etsyshop #customportrait", "caption_quality_review": {"approved": True, "decision": "approve", "reviewed_caption": "A keepsake idea for the family story. #familykeepsake #etsyshop #customportrait", "rationale": "Specific and platform-ready."}, "carousel": True, "media_items": media},
                {"platform": "facebook", "format": "multi_image", "variant_of": "campaign_unit_package", "caption": "A keepsake idea for the family story.\nhttps://www.etsy.com/listing/unit-listing-1", "caption_quality_review": {"approved": True, "decision": "approve", "reviewed_caption": "A keepsake idea for the family story.\nhttps://www.etsy.com/listing/unit-listing-1", "rationale": "Specific and platform-ready."}, "carousel": False, "media_items": media[:2]},
                {"platform": "pinterest", "format": "single", "variant_of": "campaign_unit_package", "caption": "Family keepsake portrait idea for custom gifts.", "caption_quality_review": {"approved": True, "decision": "approve", "reviewed_caption": "Family keepsake portrait idea for custom gifts.", "rationale": "Specific and platform-ready."}, "carousel": False, "media_items": [media[2]]},
            ],
        }}
    if action == "saveReviewDraft":
        posts = body.get("posts") or []
        save_review_calls.append(posts)
        return {"success": True, "data": {"records": [{"id": item.get("id"), "platform": item.get("platform"), "status": "scheduled"} for item in posts], "count": len(posts)}}
    if action == "deliverReviewNotification":
        ids = set(body.get("ids") or [])
        posts = save_review_calls[-1] if save_review_calls else []
        records = [{"id": item.get("id"), "platform": item.get("platform"), "status": "scheduled"} for item in posts if item.get("id") in ids]
        return {"success": True, "data": {"records": records, "count": len(records)}}
    raise AssertionError(f"unexpected bridge action {action}")

m.bridge = bridge
exit_code = m.run_factory()
assert save_review_calls, (exit_code, content_opportunity_calls)
saved_platforms = [item.get("platform") for item in save_review_calls[0]]
print(json.dumps({
    "exit_code": exit_code,
    "save_review_call_count": len(save_review_calls),
    "saved_platforms": saved_platforms,
    "requested_max_opportunities": content_opportunity_calls[0].get("max_opportunities"),
}))
assert exit_code == 0
assert len(save_review_calls) == 1, save_review_calls
assert saved_platforms == ["instagram", "facebook", "pinterest"], saved_platforms
assert content_opportunity_calls[0].get("max_opportunities") >= 4, content_opportunity_calls
`;
    const output = execFileSync(PYTHON_BIN, ['-c', code], {
      cwd: process.cwd(),
      env: { ...process.env, SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS: 'true', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(output).toContain('"save_review_call_count": 1');
    expect(output).toContain('"saved_platforms": ["instagram", "facebook", "pinterest"]');
    expect(output).toContain('"requested_max_opportunities": 4');
  });

  test('Facebook scheduler publishes every AI-selected image as one multi-photo post', async () => {
    process.env.FACEBOOK_PAGE_TOKEN = 'page-token';
    process.env.FACEBOOK_PAGE_ID = 'page-123';
    const requests = [];
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(String(url));
      requests.push({ parsed, options });
      if (parsed.pathname.endsWith('/photos')) {
        return new Response(JSON.stringify({ id: `photo-${requests.length}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'page-123_post-456' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await postFacebookDirect({
      caption: 'One coherent Facebook story.',
      media_items: [
        { url: 'https://media.example.test/one.jpg' },
        { url: 'https://media.example.test/two.jpg' },
        { url: 'https://media.example.test/three.jpg' },
      ],
    });
    delete process.env.FACEBOOK_PAGE_TOKEN;
    delete process.env.FACEBOOK_PAGE_ID;

    expect(result).toMatchObject({ published: true, media_count: 3, post_id: 'page-123_post-456' });
    expect(requests.filter(item => item.parsed.pathname.endsWith('/photos'))).toHaveLength(3);
    const feed = requests.find(item => item.parsed.pathname.endsWith('/feed'));
    expect(feed.parsed.searchParams.get('attached_media[0]')).toContain('photo-1');
    expect(feed.parsed.searchParams.get('attached_media[2]')).toContain('photo-3');
  });

  test('factory stops AI retries when quota is exhausted', () => {
    const code = String.raw`
import importlib.util
import json
import os
import pathlib

os.environ["SOCIAL_HERMES_API_TOKEN"] = "unit-token"
os.environ["SOCIAL_FACTORY_CREATE_PER_RUN"] = "1"
os.environ["SOCIAL_FACTORY_TARGET_UPCOMING"] = "99"
os.environ["SOCIAL_FACTORY_DRY_RUN"] = "false"
spec = importlib.util.spec_from_file_location("factory", "scripts/social_autonomous_content_factory.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

m.TOKEN = "unit-token"
m.OWNER = "owner-1"
m.CREATE_PER_RUN = 1
m.TARGET_UPCOMING = 99
m.DRY_RUN = False
m.WEB_RESEARCH_ENABLED = True
m.CONTENT_OPPORTUNITY_AI_RETRIES = 3
m.MEMORY_PATH = pathlib.Path(os.environ.get("TMP", "/tmp")) / "social_factory_unit_memory_quota.json"
m.build_current_research = lambda _ac, _now, *_args: {
    "status": "researched",
    "external_research_used": True,
    "summary": "unit current research",
    "sources": [{"title": "unit", "url": "https://example.test", "description": "unit"}],
    "signals": ["unit signal"],
}

listing = {
    "listing_id": "quota-listing-1",
    "state": "active",
    "title": "Custom family keepsake digital portrait",
    "url": "https://www.etsy.com/listing/quota-listing-1",
    "image_url": "https://img.example.test/listing-1.jpg",
    "images": [{"url_fullxfull": "https://img.example.test/1.jpg"}],
}
content_opportunity_calls = []

def bridge(action, body=None, method="POST", timeout=40):
    body = body or {}
    if action == "refreshShopContext":
        return {"success": True, "data": {"listings": [listing]}}
    if action == "context":
        return {"success": True, "data": {
            "bridge": {"publish_governance": {"autopublish_enabled": False}},
            "social_config_summary": {"configured_platforms": ["instagram", "facebook", "pinterest"]},
            "scheduled_posts": [],
            "autonomous_context": {"listings": [listing]},
        }}
    if action == "contentOpportunities":
        content_opportunity_calls.append(body)
        return {"success": True, "data": {
            "status": "blocked_ai_error",
            "external_research_used": True,
            "opportunities": [],
            "ai_opportunity_selection": {
                "source": "ai_error",
                "reason": "[codex/gpt-5.5] All codex accounts reached configured quota threshold (reset after 3h)",
            },
        }}
    raise AssertionError(f"unexpected bridge action {action}")

m.bridge = bridge
exit_code = m.run_factory()
print(json.dumps({"exit_code": exit_code, "content_opportunity_calls": len(content_opportunity_calls)}))
assert exit_code == 0
assert len(content_opportunity_calls) == 1, content_opportunity_calls
`;
    const output = execFileSync(PYTHON_BIN, ['-c', code], {
      cwd: process.cwd(),
      env: { ...process.env, SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS: 'true', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(output).toContain('blocked_ai_quota_exhausted');
    expect(output).toContain('wait for external AI quota reset');
    expect(output).toContain('"content_opportunity_calls": 1');
  });

  test('factory reports AI selection timeout as blocked timeout', () => {
    const code = String.raw`
import importlib.util
import json
import os
import pathlib

os.environ["SOCIAL_HERMES_API_TOKEN"] = "unit-token"
os.environ["SOCIAL_FACTORY_CREATE_PER_RUN"] = "1"
os.environ["SOCIAL_FACTORY_TARGET_UPCOMING"] = "99"
os.environ["SOCIAL_FACTORY_DRY_RUN"] = "true"
spec = importlib.util.spec_from_file_location("factory", "scripts/social_autonomous_content_factory.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

m.TOKEN = "unit-token"
m.OWNER = "owner-1"
m.CREATE_PER_RUN = 1
m.TARGET_UPCOMING = 99
m.DRY_RUN = True
m.WEB_RESEARCH_ENABLED = True
m.CONTENT_OPPORTUNITY_AI_RETRIES = 3
m.MEMORY_PATH = pathlib.Path(os.environ.get("TMP", "/tmp")) / "social_factory_unit_memory_timeout.json"
m.build_current_research = lambda _ac, _now, *_args: {"status": "researched", "external_research_used": True, "summary": "unit", "sources": [], "signals": []}

listing = {
    "listing_id": "timeout-listing-1",
    "state": "active",
    "title": "Custom family keepsake digital portrait",
    "url": "https://www.etsy.com/listing/timeout-listing-1",
    "image_url": "https://img.example.test/listing-1.jpg",
    "images": [{"url_fullxfull": "https://img.example.test/1.jpg"}],
}
content_opportunity_calls = []

def bridge(action, body=None, method="POST", timeout=40):
    body = body or {}
    if action == "refreshShopContext":
        return {"success": True, "data": {"listings": [listing]}}
    if action == "context":
        return {"success": True, "data": {
            "bridge": {"publish_governance": {"autopublish_enabled": False}},
            "social_config_summary": {"configured_platforms": ["instagram", "facebook", "pinterest"]},
            "scheduled_posts": [],
            "autonomous_context": {"listings": [listing]},
        }}
    if action == "contentOpportunities":
        content_opportunity_calls.append(body)
        return {"success": False, "error": "timed out", "code": "bridge_request_failed", "action": "contentOpportunities"}
    raise AssertionError(f"unexpected bridge action {action}")

m.bridge = bridge
exit_code = m.run_factory()
print(json.dumps({"exit_code": exit_code, "content_opportunity_calls": len(content_opportunity_calls)}))
assert exit_code == 0
assert len(content_opportunity_calls) == 1, content_opportunity_calls
`;
    const output = execFileSync(PYTHON_BIN, ['-c', code], {
      cwd: process.cwd(),
      env: { ...process.env, SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS: 'true', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(output).toContain('blocked_ai_timeout');
    expect(output).toContain('wait for external AI provider timeout to clear');
    expect(output).toContain('"content_opportunity_calls": 1');
  });

  test('factory uses configurable generateMedia timeout', () => {
    const code = String.raw`
import importlib.util
import json
import os
import pathlib
import tempfile

os.environ["SOCIAL_HERMES_API_TOKEN"] = "unit-token"
os.environ["SOCIAL_FACTORY_CREATE_PER_RUN"] = "1"
os.environ["SOCIAL_FACTORY_TARGET_UPCOMING"] = "99"
os.environ["SOCIAL_FACTORY_DRY_RUN"] = "true"
os.environ["SOCIAL_FACTORY_GENERATE_MEDIA_TIMEOUT_SECONDS"] = "47"
spec = importlib.util.spec_from_file_location("factory", "scripts/social_autonomous_content_factory.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

m.TOKEN = "unit-token"
m.OWNER = "owner-1"
m.CREATE_PER_RUN = 1
m.TARGET_UPCOMING = 99
m.DRY_RUN = True
m.WEB_RESEARCH_ENABLED = True
m.GENERATE_MEDIA_TIMEOUT_SECONDS = 47
m.MEMORY_PATH = pathlib.Path(tempfile.mkdtemp()) / "social_factory_unit_memory_generate_timeout.json"
m.build_current_research = lambda _ac, _now, *_args: {
    "status": "researched",
    "external_research_used": True,
    "summary": "unit current research",
    "sources": [{"title": "unit", "url": "https://example.test", "description": "unit"}],
    "signals": ["unit signal"],
}

listing = {
    "listing_id": "media-timeout-listing",
    "state": "active",
    "title": "Beach vacation PNG design",
    "url": "https://www.etsy.com/listing/media-timeout-listing",
    "image_url": "https://img.example.test/listing.jpg",
    "images": [{"url_fullxfull": "https://img.example.test/listing.jpg"}],
}
generate_timeouts = []

def bridge(action, body=None, method="POST", timeout=40):
    body = body or {}
    if action == "refreshShopContext":
        return {"success": True, "data": {"listings": [listing]}}
    if action == "context":
        return {"success": True, "data": {
            "bridge": {"publish_governance": {"autopublish_enabled": False}},
            "social_config_summary": {"configured_platforms": ["instagram", "facebook", "pinterest"]},
            "scheduled_posts": [],
            "autonomous_context": {"listings": [listing]},
        }}
    if action == "contentOpportunities":
        return {"success": True, "data": {
            "status": "ready",
            "opportunities": [{
                "id": "media-timeout-opportunity",
                "type": "ai_selected_opportunity",
                "priority": 100,
                "moment": "AI-selected summer maker campaign",
                "reason": "AI selected a visual digital design campaign.",
                "suggested_platforms": ["instagram", "facebook", "pinterest"],
                "timing": {
                    "audience_timezone": "America/New_York",
                    "rationale": "Unit-test US audience schedule.",
                    "scheduled_at_by_platform": {
                        "instagram": "2099-07-22T14:00:00.000Z",
                        "facebook": "2099-07-22T15:00:00.000Z",
                        "pinterest": "2099-07-22T16:00:00.000Z",
                    },
                },
                "context": {"campaign_context": "Show the vacation design as a useful maker asset."},
                "listing_candidates": [{
                    **listing,
                    "listing_campaign_fit": {"decision": "strong_fit", "should_use_listing": True, "confidence": 0.92},
                    "listing_understanding": {"product_summary": "Vacation PNG design for maker projects."},
                }],
            }],
        }}
    if action == "creativePlan":
        generated = body.get("generated_media") or []
        if not generated:
            return {"success": True, "data": {
                "status": "needs_generation",
                "campaign_id": "campaign_media_timeout",
                "media_strategy": {
                    "format": "single",
                    "target_media_count": 1,
                    "required_visible_evidence": "A visible custom wedding-photo result.",
                    "reference_policy": "Use the listing image as the exact design reference.",
                    "platform_variants": {
                        "instagram": {"format": "single", "frame_ids": ["brief-1"], "buyer_evidence_frame_ids": ["brief-1"]},
                        "facebook": {"format": "single", "frame_ids": ["brief-1"], "buyer_evidence_frame_ids": ["brief-1"]},
                        "pinterest": {"format": "single", "frame_ids": ["brief-1"], "buyer_evidence_frame_ids": ["brief-1"]},
                    },
                    "frames": [{
                        "id": "brief-1",
                        "source": "generated_image",
                        "communication_goal": "Show the finished vacation design in a believable use case.",
                        "visible_buyer_evidence": "The exact design is visibly applied to a clean shirt mockup.",
                        "evidence_strength": "primary",
                        "prompt": "Use the reference design on a clean beach shirt mockup.",
                        "aspect_ratio": "4:5",
                        "reference_required": True,
                        "reference_media_rank": 1,
                    }],
                },
                "generated_frame_briefs": [{
                    "id": "brief-1",
                    "role": "use_case_mockup",
                    "prompt": "Use the reference design on a clean beach shirt mockup.",
                    "aspect_ratio": "4:5",
                    "reference_required": True,
                    "reference_image_url": "https://img.example.test/listing.jpg",
                    "reference_policy": "Use the listing image as the exact design reference.",
                }],
                "storyboard": [{
                    "frame_id": "brief-1",
                    "brief_id": "brief-1",
                    "role": "use_case_mockup",
                    "status": "pending_generation",
                }],
            }}
        return {"success": True, "data": {
            "status": "ready_for_review",
            "campaign_id": "campaign_media_timeout",
            "concept": {"name": "Beach maker mockup", "hook": "A vacation design buyers can picture on products."},
            "media_strategy": {
                "format": "single",
                "target_media_count": 1,
                "required_visible_evidence": "A visible custom wedding-photo result.",
                "reference_policy": "Use the listing image as the exact design reference.",
                "platform_variants": {
                    "instagram": {"format": "single", "frame_ids": ["brief-1"], "buyer_evidence_frame_ids": ["brief-1"]},
                    "facebook": {"format": "single", "frame_ids": ["brief-1"], "buyer_evidence_frame_ids": ["brief-1"]},
                    "pinterest": {"format": "single", "frame_ids": ["brief-1"], "buyer_evidence_frame_ids": ["brief-1"]},
                },
                "frames": [{
                    "id": "brief-1",
                    "source": "generated_image",
                    "communication_goal": "Show the finished vacation design in a believable use case.",
                    "visible_buyer_evidence": "The exact design is visibly applied to a clean shirt mockup.",
                    "evidence_strength": "primary",
                    "prompt": "Use the reference design on a clean beach shirt mockup.",
                    "aspect_ratio": "4:5",
                    "reference_required": True,
                    "reference_media_rank": 1,
                }],
            },
            "storyboard": [{
                "frame_id": "brief-1",
                "brief_id": "brief-1",
                "role": "hook",
                "status": "ready" if generated else "pending_generation",
                **({"media": generated[0]} if generated else {}),
            }],
            "generation_decision": {"status": "ready"},
            "variants": [
                {"platform": "instagram", "variant_of": "campaign_media_timeout", "caption": "Beach-trip makers can picture this PNG on shirts and gifts. #digitaldownload #sublimationdesign #etsyshop", "caption_quality_review": {"approved": True, "decision": "approve", "reviewed_caption": "Beach-trip makers can picture this PNG on shirts and gifts. #digitaldownload #sublimationdesign #etsyshop", "rationale": "Specific and platform-ready."}, "carousel": False, "media_items": generated},
                {"platform": "facebook", "variant_of": "campaign_media_timeout", "caption": "Beach-trip makers can picture this PNG on shirts and gifts.\nhttps://www.etsy.com/listing/media-timeout-listing", "caption_quality_review": {"approved": True, "decision": "approve", "reviewed_caption": "Beach-trip makers can picture this PNG on shirts and gifts.\nhttps://www.etsy.com/listing/media-timeout-listing", "rationale": "Specific and platform-ready."}, "carousel": False, "media_items": generated},
                {"platform": "pinterest", "variant_of": "campaign_media_timeout", "caption": "Vacation maker file inspiration for shirts, mugs, totes, and small-shop product planning.", "caption_quality_review": {"approved": True, "decision": "approve", "reviewed_caption": "Vacation maker file inspiration for shirts, mugs, totes, and small-shop product planning.", "rationale": "Specific and platform-ready."}, "carousel": False, "media_items": generated},
            ],
        }}
    if action == "generateMedia":
        generate_timeouts.append(timeout)
        return {"success": True, "data": {"images": [{
            "url": "https://dashboard.example.test/api/social?action=mediaAsset&id=timeout-unit",
            "type": "image",
                "source": "generated_image",
                "permanent": True,
                "checksum_sha256": "a" * 64,
                "quality_review": {"decision": "approve", "approved": True},
            }]}}
    raise AssertionError(f"unexpected bridge action {action}")

m.bridge = bridge
exit_code = m.run_factory()
print(json.dumps({"exit_code": exit_code, "generate_timeouts": generate_timeouts}))
assert exit_code == 0
assert len(generate_timeouts) == 1, generate_timeouts
assert 30 <= generate_timeouts[0] <= 47, generate_timeouts
`;
    const output = execFileSync(PYTHON_BIN, ['-c', code], {
      cwd: process.cwd(),
      env: { ...process.env, SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS: 'true', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(output).toContain('"generate_timeouts": [');
  });
});

test.describe('Social Hermes bridge actions', () => {
  let originalEnv;

  test.beforeEach(() => {
    originalEnv = {
      SOCIAL_HERMES_API_TOKEN: process.env.SOCIAL_HERMES_API_TOKEN,
      SOCIAL_HERMES_OWNER_TELEGRAM_ID: process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
      INSTAGRAM_ACCESS_TOKEN: process.env.INSTAGRAM_ACCESS_TOKEN,
      INSTAGRAM_USER_ID: process.env.INSTAGRAM_USER_ID,
      FACEBOOK_PAGE_TOKEN: process.env.FACEBOOK_PAGE_TOKEN,
      FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,
      MAKE_WEBHOOK_URL: process.env.MAKE_WEBHOOK_URL,
      MAKE_CALLBACK_SECRET: process.env.MAKE_CALLBACK_SECRET,
    };
    process.env.SOCIAL_HERMES_API_TOKEN = 'bridge-token';
    process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID = 'owner-1';
    process.env.PUBLIC_BASE_URL = 'https://manager.example.test';
    process.env.INSTAGRAM_ACCESS_TOKEN = 'test-instagram-token';
    process.env.INSTAGRAM_USER_ID = 'test-instagram-business-id';
    process.env.FACEBOOK_PAGE_TOKEN = 'test-facebook-page-token';
    process.env.FACEBOOK_PAGE_ID = 'test-facebook-page-id';
    process.env.MAKE_WEBHOOK_URL = 'https://hook.example.test/pinterest';
    process.env.MAKE_CALLBACK_SECRET = 'test-make-callback-secret';
  });

  test.afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('ideaPreview is an advertised safe bridge action and does not require approval/save', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: { action: 'ideaPreview', caption: 'Preview only', platform: 'facebook' },
    }, res);

    expect(captured.statusCode).toBe(200);
    expect(captured.payload).toMatchObject({
      success: true,
      action: 'ideaPreview',
      published: false,
      data: {
        requires_approval_for_save: true,
        saved: false,
        published: false,
        preview: expect.objectContaining({ caption: 'Preview only', platform: 'facebook' }),
      },
    });
  });

  test('ideaPreview preserves safe agent metadata and media source without leaking secrets', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'ideaPreview',
        id: 'agent-autonomy-test-1',
        caption: 'Agent preview with metadata',
        platform: 'all',
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        source: 'social_hermes',
        created_by: 'social_autonomous_content_factory',
        approval_source: 'factory_safe_schedule',
        metadata: { angle: 'graduation', api_token: 'should-hide' },
        media_items: [{ url: 'https://example.test/social.jpg', type: 'image', source: 'media_asset' }],
      },
    }, res);

    expect(captured.statusCode).toBe(200);
    expect(captured.payload.data.preview).toMatchObject({
      id: 'agent-autonomy-test-1',
      source: 'social_hermes',
      created_by: 'social_autonomous_content_factory',
      approval_source: 'factory_safe_schedule',
      metadata: { angle: 'graduation', api_token: '[redacted]' },
      media_items: [expect.objectContaining({ url: 'https://example.test/social.jpg', source: 'media_asset' })],
    });
  });

  test('Social Hermes owner approval preview never grants future publish approval', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'ideaPreview',
        id: 'agent-autonomy-owner-write-only',
        approved: true,
        approved_by: 'owner-1',
        approved_for_publish: true,
        caption: 'A thoughtful custom portrait gift idea that keeps the family story close.\n\nFeatured from the shop: Custom family portrait keepsake\n\nSee the listing here:\nhttps://www.etsy.com/listing/123456789',
        platform: 'facebook',
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        listing_id: '123456789',
        listing_title: 'Custom family portrait keepsake',
        media_items: [{ url: 'https://img.example.test/social-owner-write.jpg', type: 'image', source: 'listing_image' }],
      },
    }, res);

    expect(captured.statusCode).toBe(200);
    expect(captured.payload.data.preview).toMatchObject({
      id: 'agent-autonomy-owner-write-only',
      status: 'scheduled',
      approved_for_publish: false,
      approved_by: null,
      approved_at: null,
      queue_state: 'active_scheduled',
    });
  });

  test('updateScheduled refuses synthetic fallback media before persistence', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'updateScheduled',
        id: 'fallback-media-update-regression',
        approved: true,
        approved_by: 'owner-1',
        media_items: [{
          url: 'https://example.test/fallback.png',
          type: 'image',
          source: 'generated_fallback',
          generated_via: 'fallback_png_e2e_only',
        }],
      },
    }, res);

    expect(captured.statusCode).toBe(400);
    expect(captured.payload).toMatchObject({
      success: false,
      code: 'FALLBACK_MEDIA_NOT_ALLOWED',
    });
  });

  test('schedule requires an AI quality review when autonomous caption review is declared', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'schedule',
        id: 'bad-canary-caption-regression',
        approved: true,
        approved_by: 'owner-1',
        platform: 'instagram',
        listing_id: '1321295998',
        listing_title: 'Hawaii 2026 Png file, Islands Family Vacation 2026, Shirt Print',
        caption: '[CANARY schedule visibility - no publish] schedule visibility canary: a closer look at Hawaii 2026 Png file',
        metadata: { ai_caption_quality_review_required: true },
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        media_items: [{ url: 'https://img.example.test/hawaii.jpg', type: 'image', source: 'listing_image' }],
      },
    }, res);

    expect(captured.statusCode).toBe(400);
    expect(captured.payload).toMatchObject({
      success: false,
      code: 'AI_REVIEW_ARTIFACT_REQUIRED',
    });
  });

  test('creativePlan fails closed when Etsy AI Command Center has no configured platform route', async () => {
    const originalPlatformEnv = {
      INSTAGRAM_ACCESS_TOKEN: process.env.INSTAGRAM_ACCESS_TOKEN,
      INSTAGRAM_USER_ID: process.env.INSTAGRAM_USER_ID,
      FACEBOOK_PAGE_TOKEN: process.env.FACEBOOK_PAGE_TOKEN,
      FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,
      PINTEREST_ACCESS_TOKEN: process.env.PINTEREST_ACCESS_TOKEN,
      MAKE_WEBHOOK_URL: process.env.MAKE_WEBHOOK_URL,
      METRICOOL_API_KEY: process.env.METRICOOL_API_KEY,
      METRICOOL_BRAND_ID: process.env.METRICOOL_BRAND_ID,
    };
    for (const key of Object.keys(originalPlatformEnv)) delete process.env[key];
    const { res, captured } = mockResponse();
    try {
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'creativePlan',
          listing: { listing_id: 'no-platform', title: 'Owner-review listing' },
          platforms: [],
        },
      }, res);
    } finally {
      for (const [key, value] of Object.entries(originalPlatformEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(captured.statusCode).toBe(409);
    expect(captured.payload).toMatchObject({
      success: false,
      code: 'NO_CONFIGURED_PLATFORMS',
      published: false,
    });
  });

  test('schedule rejects an AI quality review that does not match the final caption', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'schedule',
        id: 'instagram-no-hashtags-regression',
        approved: true,
        approved_by: 'owner-1',
        platform: 'instagram',
        listing_id: '4517826856',
        listing_title: 'Family Generations Portrait',
        caption: 'Some photos deserve to become a keepsake, not stay hidden in a camera roll.\n\nSave this idea for later and visit the Etsy shop through the link in bio.',
        metadata: {
          ai_caption_quality_review_required: true,
          ai_caption_quality_review: {
            approved: true,
            decision: 'approve',
            reviewed_caption: 'A different caption was reviewed.',
            rationale: 'The reviewed draft was suitable.',
          },
        },
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        media_items: [{ url: 'https://img.example.test/portrait.jpg', type: 'image', source: 'listing_image' }],
      },
    }, res);

    expect(captured.statusCode).toBe(400);
    expect(captured.payload).toMatchObject({
      success: false,
      code: 'AI_REVIEW_ARTIFACT_REQUIRED',
    });
  });

  test('Social Hermes bridge cannot approve posts for future autopublish', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'approveScheduled',
        id: 'agent-owned-scheduled-post',
        approved: true,
        approved_by: 'owner-1',
      },
    }, res);

    expect(captured.statusCode).toBe(400);
    expect(captured.payload).toMatchObject({
      success: false,
      code: 'UNSUPPORTED_ACTION',
    });
  });

  test('Social Hermes schedule approval saves queue item but never grants publish approval', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
    };
    const kv = new Map();
    const lists = new Map();
    const locks = new Map();
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'false';
    process.env.AUTOPUBLISH = 'false';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
      if (lockResponse) return lockResponse;
      if (command === 'GET') return new Response(JSON.stringify({ result: kv.get(key) ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (command === 'DEL') { lists.delete(key); kv.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (command === 'LPUSH') {
        const list = lists.get(key) || [];
        for (const value of parts.slice(2)) list.unshift(value);
        lists.set(key, list);
        return new Response(JSON.stringify({ result: list.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'RENAME') {
        lists.set(parts[2], lists.get(key) || []);
        lists.delete(key);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        const list = lists.get(key) || [];
        const start = parseInt(parts[2] || '0', 10);
        const stop = parseInt(parts[3] || '-1', 10);
        const end = stop < 0 ? list.length : stop + 1;
        return new Response(JSON.stringify({ result: list.slice(start, end) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'schedule',
          id: 'safe-hermes-scheduled-no-publish-approval',
          approved: true,
          approved_by: 'owner-1',
          platform: 'facebook',
          listing_id: '1234567890',
          listing_title: 'Custom family portrait keepsake',
          caption: 'A custom portrait works when it makes separate photos feel like one clear family story.\n\nFeatured from the shop: Custom family portrait keepsake\n\nSee the listing here:\nhttps://www.etsy.com/listing/1234567890',
          scheduled_at: '2026-06-12T12:00:00.000Z',
          media_items: [{ url: 'https://img.example.test/family-portrait.jpg', type: 'image', source: 'listing_image' }],
        },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        action: 'schedule',
        published: false,
        data: {
          id: 'safe-hermes-scheduled-no-publish-approval',
          status: 'scheduled',
          approved_for_publish: false,
          approved_by: null,
          approved_at: null,
        },
      });

      const publishCheck = await callSocial({ action: 'publishDueScheduled', dryRun: true, now: '2026-06-13T12:00:00.000Z' });
      expect(publishCheck.statusCode).toBe(200);
      expect(publishCheck.payload).toMatchObject({
        success: true,
        dryRun: true,
        autopublish_enabled: false,
        due_count: 0,
        overdue_total: 1,
        skipped_unapproved_count: 1,
      });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('Social Hermes saveReviewDraft saves visible owner-review records without publish approval', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
      CRON_SECRET: process.env.CRON_SECRET,
    };
    const kv = new Map();
    const lists = new Map();
    const locks = new Map();
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'false';
    process.env.AUTOPUBLISH = 'false';
    process.env.CRON_SECRET = 'test-cron-secret';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
      if (lockResponse) return lockResponse;
      if (command === 'GET') return new Response(JSON.stringify({ result: kv.get(key) ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (command === 'SET') { kv.set(key, parts[2]); return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (command === 'DEL') { lists.delete(key); kv.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (command === 'LPUSH') {
        const list = lists.get(key) || [];
        for (const value of parts.slice(2)) list.unshift(value);
        lists.set(key, list);
        return new Response(JSON.stringify({ result: list.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'RENAME') {
        lists.set(parts[2], lists.get(key) || []);
        lists.delete(key);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        const list = lists.get(key) || [];
        const start = parseInt(parts[2] || '0', 10);
        const stop = parseInt(parts[3] || '-1', 10);
        const end = stop < 0 ? list.length : stop + 1;
        return new Response(JSON.stringify({ result: list.slice(start, end) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'saveReviewDraft',
          id: 'owner-review-visible-no-publish',
          platform: 'facebook',
          listing_id: '1234567890',
          listing_title: 'Custom family portrait keepsake',
          caption: 'A custom portrait works when it makes separate photos feel like one clear family story.\n\nFeatured idea: Family keepsake\n\nSee the listing here:\nhttps://www.etsy.com/listing/1234567890',
          scheduled_at: '2026-06-12T12:00:00.000Z',
          media_items: [{ url: 'https://img.example.test/family-portrait.jpg', type: 'image', source: 'listing_image' }],
        },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        action: 'saveReviewDraft',
        saved: true,
        published: false,
        data: {
          id: 'owner-review-visible-no-publish',
          status: 'draft',
          scheduled_at: null,
          approved_for_publish: false,
          approved_by: null,
          approved_at: null,
        },
      });
      expect(captured.payload.data.metadata.ai_review_content_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(captured.payload.data.metadata.ai_review_content_digest_source).toBe('etsy_manager_server');

      const publishCheck = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer test-cron-secret' },
        query: {},
        body: { action: 'publishDueScheduled', dryRun: true, now: '2026-06-13T12:00:00.000Z' },
      }, publishCheck.res);
      expect(publishCheck.captured.payload).toMatchObject({
        success: true,
        dryRun: true,
        due_count: 0,
        skipped_unapproved_count: 0,
      });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('Social Hermes saveReviewDraft batch discards schedules and persists owner-review drafts', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
    };
    const kv = new Map();
    const lists = new Map();
    const locks = new Map();
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'false';
    process.env.AUTOPUBLISH = 'false';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
      if (lockResponse) return lockResponse;
      if (command === 'GET') return new Response(JSON.stringify({ result: kv.get(key) ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (command === 'SET') { kv.set(key, parts[2]); return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (command === 'DEL') { lists.delete(key); kv.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (command === 'LPUSH') {
        const list = lists.get(key) || [];
        for (const value of parts.slice(2)) list.unshift(value);
        lists.set(key, list);
        return new Response(JSON.stringify({ result: list.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'RENAME') {
        lists.set(parts[2], lists.get(key) || []);
        lists.delete(key);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        const list = lists.get(key) || [];
        const start = parseInt(parts[2] || '0', 10);
        const stop = parseInt(parts[3] || '-1', 10);
        const end = stop < 0 ? list.length : stop + 1;
        return new Response(JSON.stringify({ result: list.slice(start, end) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'saveReviewDraft',
          posts: ['instagram', 'facebook', 'pinterest'].map((platform, index) => ({
            id: `owner-review-package-${platform}`,
            platform,
            listing_id: '1234567890',
            listing_title: 'Custom family portrait keepsake',
            caption: platform === 'instagram'
              ? 'A keepsake idea for the family story. #familykeepsake #etsyshop #customportrait'
              : `A keepsake idea for the family story.\nhttps://www.etsy.com/listing/1234567890`,
            scheduled_at: `2026-06-1${index + 2}T12:00:00.000Z`,
            media_items: [
              { url: `https://img.example.test/${platform}-1.jpg`, type: 'image', source: 'listing_image' },
              { url: `https://img.example.test/${platform}-2.jpg`, type: 'image', source: 'listing_image' },
              { url: `https://img.example.test/${platform}-3.jpg`, type: 'image', source: 'listing_image' },
            ].slice(0, platform === 'pinterest' ? 1 : 3),
            metadata: { campaign_id: 'owner-review-package' },
          })),
        },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        action: 'saveReviewDraft',
        saved: true,
        published: false,
        data: { count: 3 },
      });
      expect(captured.payload.data.records.map(record => record.platform).sort()).toEqual(['facebook', 'instagram', 'pinterest']);
      expect(captured.payload.data.records.every(record => record.status === 'draft' && record.scheduled_at === null)).toBe(true);
      expect(captured.payload.data.records.every(record => record.approved_for_publish === false)).toBe(true);
      expect(captured.payload.data.records.every(record => record.approval_source === 'owner_review_required')).toBe(true);

      const saved = (lists.get('default:scheduled:posts') || []).map(decodeScheduledQueueTestRecord);
      expect(saved).toHaveLength(3);
      expect(saved.map(record => record.platform).sort()).toEqual(['facebook', 'instagram', 'pinterest']);
      expect(saved.every(record => record.status === 'draft' && record.scheduled_at === null)).toBe(true);
      expect(saved.every(record => record.approved_for_publish === false)).toBe(true);
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('owner opt-in refuses caller-supplied AI reviews without a server artifact', async () => {
    const originalFetch = global.fetch;
    const originalEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
      CRON_SECRET: process.env.CRON_SECRET,
      SOCIAL_AUTOPUBLISH_OWNER_OPT_IN: process.env.SOCIAL_AUTOPUBLISH_OWNER_OPT_IN,
      SOCIAL_AUTOPUBLISH_MIN_REVIEW_HOURS: process.env.SOCIAL_AUTOPUBLISH_MIN_REVIEW_HOURS,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS: process.env.SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS,
    };
    const caption = 'A finished custom keepsake can turn separate family photos into one natural portrait.';
    const scheduledAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const kv = new Map([
      ['default:social_configs', encodeURIComponent(JSON.stringify({ fb_posts_config: { page_id: 'page_1', token: 'secret-token' } }))],
    ]);
    const lists = new Map();
    const locks = new Map();
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'true';
    process.env.AUTOPUBLISH = 'true';
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.SOCIAL_AUTOPUBLISH_OWNER_OPT_IN = 'true';
    process.env.SOCIAL_AUTOPUBLISH_MIN_REVIEW_HOURS = '12';
    process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
    process.env.SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS = 'false';
    let telegramChatId = 'owner-1';
    let staleScheduledReads = 0;
    const telegramRequests = [];
    global.fetch = async (url, options = {}) => {
      if (String(url).startsWith('https://api.telegram.org/')) {
        const method = String(url).split('/').pop();
        telegramRequests.push({
          method,
          body: JSON.parse(String(options.body || '{}')),
        });
        if (method === 'sendMediaGroup') {
          return new Response(JSON.stringify({ ok: true, result: [{ message_id: 102, chat: { id: telegramChatId } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: method === 'sendMessage' ? 101 : 102, chat: { id: telegramChatId } } }), { status: 200 });
      }
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
      if (lockResponse) return lockResponse;
      if (command === 'GET') return new Response(JSON.stringify({ result: kv.get(key) ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (command === 'SET') { kv.set(key, parts[2]); return new Response(JSON.stringify({ result: 'OK' }), { status: 200 }); }
      if (command === 'DEL') { lists.delete(key); kv.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
      if (command === 'LPUSH') {
        const list = lists.get(key) || [];
        for (const value of parts.slice(2)) list.unshift(value);
        lists.set(key, list);
        return new Response(JSON.stringify({ result: list.length }), { status: 200 });
      }
      if (command === 'RENAME') {
        lists.set(parts[2], lists.get(key) || []);
        lists.delete(key);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      if (command === 'LRANGE') {
        if (key === 'default:scheduled:posts' && staleScheduledReads > 0) {
          staleScheduledReads -= 1;
          return new Response(JSON.stringify({ result: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    };

    try {
      const reviewResponse = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'saveReviewDraft',
          id: 'auto-safe-review-facebook',
          platform: 'facebook',
          caption,
          scheduled_at: scheduledAt,
          media_items: [{ url: 'https://img.example.test/family-portrait.jpg', source: 'listing_image', type: 'image' }],
          metadata: {
            ...approvedCampaignVisualReview('facebook'),
            owner_notification_required: true,
            owner_notification_sent_at: new Date().toISOString(),
            media_strategy: {
              frame_count_rationale: 'One proof frame is sufficient because Facebook needs a focused service example without filler.',
              frames: [{ id: 'proof', source: 'listing_image' }],
              platform_variants: { facebook: { format: 'single', frame_ids: ['proof'] } },
            },
            ai_caption_quality_review_required: true,
            ai_caption_quality_review: {
              approved: true,
              decision: 'approve',
              reviewed_caption: caption,
              rationale: 'Grounded in the exact service and suitable for Facebook.',
            },
          },
        },
      }, reviewResponse.res);

      expect(reviewResponse.captured.statusCode).toBe(200);
      expect(reviewResponse.captured.payload.data).toMatchObject({
        id: 'auto-safe-review-facebook',
        status: 'draft',
        scheduled_at: null,
        approved_for_publish: false,
        metadata: {
          owner_review_required: true,
          auto_publish_after_review_window: false,
          requested_scheduled_at: scheduledAt,
        },
      });
      expect(reviewResponse.captured.payload.data.metadata.owner_notification_sent_at).toBeUndefined();
      expect(reviewResponse.captured.payload.data.metadata.ai_review_contract_version).toBeUndefined();

      staleScheduledReads = 1;
      const confirmationResponse = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'deliverReviewNotification',
          ids: ['auto-safe-review-facebook'],
        },
      }, confirmationResponse.res);
      expect(confirmationResponse.captured.statusCode).toBe(200);
      expect(confirmationResponse.captured.payload.data.records[0]).toMatchObject({
        id: 'auto-safe-review-facebook',
        status: 'draft',
        scheduled_at: null,
        approved_for_publish: false,
        metadata: {
          owner_notification_delivery: 'etsy_manager_telegram_bot_api',
          owner_notification_chat_id: 'owner-1',
          owner_notification_text_message_id: 101,
          auto_publish_after_review_window: false,
        },
      });
      const notificationText = telegramRequests.find(request => request.method === 'sendMessage')?.body?.text || '';
      expect(notificationText).toContain('<b>Кадри:</b>');
      expect(notificationText).toContain('facebook: 1');

      const undeliveredResponse = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'saveReviewDraft',
          id: 'auto-safe-review-undelivered',
          platform: 'facebook',
          caption,
          scheduled_at: scheduledAt,
          media_items: [{ url: 'https://img.example.test/family-portrait.jpg', source: 'listing_image', type: 'image' }],
          metadata: {
            ...approvedCampaignVisualReview('facebook'),
            owner_notification_required: true,
            media_strategy: {
              frames: [{ id: 'proof', source: 'listing_image' }],
              platform_variants: { facebook: { format: 'single', frame_ids: ['proof'] } },
            },
            ai_caption_quality_review_required: true,
            ai_caption_quality_review: {
              approved: true,
              decision: 'approve',
              reviewed_caption: caption,
              rationale: 'Grounded in the exact service and suitable for Facebook.',
            },
          },
        },
      }, undeliveredResponse.res);
      expect(undeliveredResponse.captured.payload.data.approved_for_publish).toBe(false);

      telegramChatId = 'other-chat';
      const wrongChatDeliveryResponse = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'deliverReviewNotification',
          ids: ['auto-safe-review-undelivered'],
        },
      }, wrongChatDeliveryResponse.res);
      expect(wrongChatDeliveryResponse.captured.statusCode).toBe(409);
      expect(wrongChatDeliveryResponse.captured.payload.code).toBe('OWNER_NOTIFICATION_DELIVERY_FAILED');
      telegramChatId = 'owner-1';

      process.env.SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS = 'true';
      const disabledDeliveryResponse = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'deliverReviewNotification',
          ids: ['auto-safe-review-undelivered'],
        },
      }, disabledDeliveryResponse.res);
      expect(disabledDeliveryResponse.captured.statusCode).toBe(409);
      expect(disabledDeliveryResponse.captured.payload.code).toBe('OWNER_NOTIFICATION_DISABLED');
      process.env.SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS = 'false';

      const schedulerResponse = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer test-cron-secret' },
        query: {},
        body: { action: 'publishDueScheduled', dryRun: false, limit: 25 },
      }, schedulerResponse.res);

      expect(schedulerResponse.captured.statusCode).toBe(200);
      expect(schedulerResponse.captured.payload).toMatchObject({
        success: true,
        due_count: 0,
        auto_arm: { armed_count: 0, blocked_count: 0, skipped_count: 2 },
      });
      const saved = (lists.get('default:scheduled:posts') || []).map(decodeScheduledQueueTestRecord);
      expect(saved).toHaveLength(2);
      expect(saved.find(record => record.id === 'auto-safe-review-facebook')).toMatchObject({
        id: 'auto-safe-review-facebook',
        status: 'draft',
        scheduled_at: null,
        approved_for_publish: false,
      });
      expect(saved.find(record => record.id === 'auto-safe-review-undelivered')).toMatchObject({
        status: 'draft',
        scheduled_at: null,
        approved_for_publish: false,
      });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('Social Hermes schedule saves a two-image mixed Instagram carousel without publish approval', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    const kv = new Map();
    const lists = new Map();
    const locks = new Map();
    const assetId = 'shmedia_62a1e8bf5a3822b081a2d4a6';
    const generatedUrl = `https://manager.example.test/api/social?action=mediaAsset&id=${assetId}`;
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'false';
    process.env.AUTOPUBLISH = 'false';
    process.env.PUBLIC_BASE_URL = 'https://manager.example.test';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
      if (lockResponse) return lockResponse;
      if (command === 'GET') return new Response(JSON.stringify({ result: kv.get(key) ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (command === 'DEL') { lists.delete(key); kv.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (command === 'LPUSH') {
        const list = lists.get(key) || [];
        for (const value of parts.slice(2)) list.unshift(value);
        lists.set(key, list);
        return new Response(JSON.stringify({ result: list.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'RENAME') {
        lists.set(parts[2], lists.get(key) || []);
        lists.delete(key);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        const list = lists.get(key) || [];
        const start = parseInt(parts[2] || '0', 10);
        const stop = parseInt(parts[3] || '-1', 10);
        const end = stop < 0 ? list.length : stop + 1;
        return new Response(JSON.stringify({ result: list.slice(start, end) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token', host: 'manager.example.test' },
        query: {},
        body: {
          action: 'schedule',
          id: 'safe-hermes-instagram-mixed-carousel',
          approved: true,
          approved_by: 'owner-1',
          platform: 'instagram',
          listing_id: '1392015419',
          listing_title: 'Aruba Vacation 2026 Tropical Island Design',
          caption: 'A trip detail can make the family plan feel ready before anyone packs.\n\nSave this idea for later, or visit the Etsy shop through the link in bio.\n\n#VacationShirts #FamilyTrip #SublimationPNG #EtsyDigitalDownload #TravelStyle',
          scheduled_at: '2026-06-12T12:00:00.000Z',
          media_items: [
            { url: generatedUrl, type: 'image', source: 'generated_image', permanent: true, checksum_sha256: 'a'.repeat(64) },
            { url: 'https://i.etsystatic.com/23207964/r/il/5a7a2f/4589442324/il_fullxfull.4589442324_8mra.jpg', type: 'image', source: 'listing_image' },
          ],
          generated_image_url: generatedUrl,
          listing_image_url: 'https://i.etsystatic.com/23207964/r/il/5a7a2f/4589442324/il_fullxfull.4589442324_8mra.jpg',
          metadata: { instagram_carousel: true, campaign_id: 'campaign_mixed_carousel' },
        },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        action: 'schedule',
        published: false,
        data: {
          id: 'safe-hermes-instagram-mixed-carousel',
          platform: 'instagram',
          status: 'scheduled',
          approved_for_publish: false,
          approved_by: null,
          approved_at: null,
        },
      });
      expect(captured.payload.data.media_items[0]).toMatchObject({ url: generatedUrl, source: 'generated_image', permanent: true });
      expect(captured.payload.data.media_items).toHaveLength(2);
      expect(captured.payload.data.media_items.filter(item => item.source === 'listing_image').length).toBe(1);

      const publishCheck = await callSocial({ action: 'publishDueScheduled', dryRun: true, now: '2026-06-13T12:00:00.000Z' });
      expect(publishCheck.payload).toMatchObject({
        success: true,
        dryRun: true,
        autopublish_enabled: false,
        due_count: 0,
        overdue_total: 1,
        skipped_unapproved_count: 1,
      });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('Social Hermes schedule can save one approved campaign as platform-specific queue records', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    const kv = new Map();
    const lists = new Map();
    const locks = new Map();
    const generatedHero = 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_aaaaaaaaaaaaaaaaaaaaaaaa';
    const generatedPin = 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_bbbbbbbbbbbbbbbbbbbbbbbb';
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'false';
    process.env.AUTOPUBLISH = 'false';
    process.env.PUBLIC_BASE_URL = 'https://manager.example.test';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
      if (lockResponse) return lockResponse;
      if (command === 'GET') return new Response(JSON.stringify({ result: kv.get(key) ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (command === 'DEL') { lists.delete(key); kv.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (command === 'LPUSH') {
        const list = lists.get(key) || [];
        for (const value of parts.slice(2)) list.unshift(value);
        lists.set(key, list);
        return new Response(JSON.stringify({ result: list.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'RENAME') {
        lists.set(parts[2], lists.get(key) || []);
        lists.delete(key);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        const list = lists.get(key) || [];
        const start = parseInt(parts[2] || '0', 10);
        const stop = parseInt(parts[3] || '-1', 10);
        const end = stop < 0 ? list.length : stop + 1;
        return new Response(JSON.stringify({ result: list.slice(start, end) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'schedule',
          approved: true,
          approved_by: 'owner-1',
          posts: [
            {
              id: 'campaign-variant-instagram',
              platform: 'instagram',
              listing_id: '1097290075',
              listing_title: 'Pickleball PNG bundle',
              caption: 'Make the pickleball design feel like a finished project, not just a flat file.\n\nSave this idea for later, or visit the Etsy shop through the link in bio.\n\n#PickleballPNG #SublimationDesign #CraftBusiness',
              scheduled_at: '2026-07-05T12:00:00.000Z',
              media_items: [
                { url: generatedHero, type: 'image', source: 'generated_image', permanent: true, checksum_sha256: 'b'.repeat(64) },
                { url: 'https://img.example.test/pickleball-listing-1.jpg', type: 'image', source: 'listing_image' },
                { url: 'https://img.example.test/pickleball-listing-2.jpg', type: 'image', source: 'listing_image' },
              ],
              metadata: { instagram_carousel: true, campaign_id: 'campaign-platform-specific' },
            },
            {
              id: 'campaign-variant-facebook',
              platform: 'facebook',
              listing_id: '1097290075',
              listing_title: 'Pickleball PNG bundle',
              caption: 'A ready-to-use pickleball design can help a maker turn a sports idea into shirts, totes, or small-shop product mockups.\n\nSee the listing here:\nhttps://www.etsy.com/listing/1097290075',
              scheduled_at: '2026-07-05T12:10:00.000Z',
              media_items: [{ url: generatedHero, type: 'image', source: 'generated_image', permanent: true, checksum_sha256: 'b'.repeat(64) }],
              metadata: { campaign_id: 'campaign-platform-specific' },
            },
            {
              id: 'campaign-variant-pinterest',
              platform: 'pinterest',
              listing_id: '1097290075',
              listing_title: 'Pickleball PNG bundle',
              caption: 'Plan a sporty craft board around a ready digital pickleball design for sublimation, stickers, shirts, and small-shop product ideas.\n\nhttps://www.etsy.com/listing/1097290075',
              scheduled_at: '2026-07-05T12:20:00.000Z',
              media_items: [{ url: generatedPin, type: 'image', source: 'generated_image', permanent: true, checksum_sha256: 'c'.repeat(64) }],
              metadata: { campaign_id: 'campaign-platform-specific' },
            },
          ],
        },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        action: 'schedule',
        published: false,
        data: { count: 3 },
      });
      const platforms = captured.payload.data.records.map(post => post.platform).sort();
      expect(platforms).toEqual(['facebook', 'instagram', 'pinterest']);
      expect(captured.payload.data.records.every(post => post.approved_for_publish === false)).toBe(true);
      const saved = (lists.get('default:scheduled:posts') || []).map(decodeScheduledQueueTestRecord);
      expect(saved.map(post => post.platform).sort()).toEqual(['facebook', 'instagram', 'pinterest']);
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('caller-approved schedule cannot forge AI readiness or arm autonomous publish', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      SOCIAL_AUTOPUBLISH_OWNER_OPT_IN: process.env.SOCIAL_AUTOPUBLISH_OWNER_OPT_IN,
      SOCIAL_AUTOPUBLISH_MIN_REVIEW_HOURS: process.env.SOCIAL_AUTOPUBLISH_MIN_REVIEW_HOURS,
    };
    const kv = new Map([
      ['default:social_configs', encodeURIComponent(JSON.stringify({ fb_posts_config: { page_id: 'page_1', token: 'secret-token' } }))],
    ]);
    const lists = new Map();
    const caption = 'A custom animated keepsake can turn family photographs into a meaningful life story video.';
    const scheduledAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.SOCIAL_AUTOPUBLISH_OWNER_OPT_IN = 'true';
    process.env.SOCIAL_AUTOPUBLISH_MIN_REVIEW_HOURS = '12';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      if (command === 'GET') return new Response(JSON.stringify({ result: kv.get(key) ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (command === 'DEL') { lists.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
      if (command === 'LPUSH') {
        const list = lists.get(key) || [];
        for (const value of parts.slice(2)) list.unshift(value);
        lists.set(key, list);
        return new Response(JSON.stringify({ result: list.length }), { status: 200 });
      }
      if (command === 'RENAME') {
        lists.set(parts[2], lists.get(key) || []);
        lists.delete(key);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      if (command === 'LRANGE') return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    };
    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'schedule',
          approved: true,
          approved_by: 'owner-1',
          id: 'auto-review-facebook',
          platform: 'facebook',
          caption,
          scheduled_at: scheduledAt,
          media_items: [{ url: 'https://img.example.test/life-story.jpg', source: 'listing_image', type: 'image' }],
          metadata: {
            campaign_id: 'auto-review-campaign',
            auto_publish_after_review_window: true,
            ...approvedCampaignVisualReview('facebook'),
            ai_caption_quality_review_required: true,
            ai_caption_quality_review: {
              approved: true,
              decision: 'approve',
              reviewed_caption: caption,
              rationale: 'Grounded in the custom service and appropriate for Facebook.',
            },
            media_strategy: {
              frames: [{ id: 'proof', source: 'listing_image' }],
              platform_variants: { facebook: { format: 'single', frame_ids: ['proof'] } },
            },
          },
        },
      }, res);
      expect(captured.statusCode).toBe(400);
      expect(captured.payload).toMatchObject({
        success: false,
        code: 'AI_REVIEW_ARTIFACT_REQUIRED',
        published: false,
      });
      expect(lists.get('default:scheduled:posts') || []).toHaveLength(0);
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('canaryReadiness reports owner-approval candidates without approving or publishing', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
    };
    const scheduled = [
      {
        id: 'ready-facebook-canary',
        status: 'scheduled',
        platform: 'facebook',
        listing_id: '1234567890',
        listing_title: 'Custom family portrait keepsake',
        caption: 'A custom portrait works when it makes separate photos feel like one clear family story.\n\nFeatured from the shop: Custom family portrait keepsake\n\nSee the listing here:\nhttps://www.etsy.com/listing/1234567890',
        scheduled_at: '2026-06-12T12:00:00.000Z',
        media_items: [{ url: 'https://img.example.test/family-portrait.jpg', type: 'image', source: 'listing_image' }],
      },
      {
        id: 'blocked-instagram-canary',
        status: 'scheduled',
        platform: 'instagram',
        listing_id: '222',
        listing_title: 'Custom family portrait keepsake',
        caption: 'Custom family portrait keepsake',
        metadata: { ai_caption_quality_review_required: true },
        scheduled_at: '2026-06-12T12:00:00.000Z',
        media_items: [],
      },
    ];
    const socialConfigs = {
      fb_posts_config: { page_id: 'page_1', token: 'secret-fb-token' },
      ig_config: { ig_id: 'ig_1', token: 'secret-ig-token' },
    };
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'false';
    process.env.AUTOPUBLISH = 'false';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      if (command === 'GET') {
        const result = key === 'default:social_configs' ? encodeURIComponent(JSON.stringify(socialConfigs)) : null;
        return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        return new Response(JSON.stringify({ result: scheduled.map(encodeScheduledQueueTestRecord) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: { action: 'canaryReadiness', now: '2026-06-11T12:00:00.000Z' },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        action: 'canaryReadiness',
        saved: false,
        published: false,
        data: {
          summary: {
            total_checked: 2,
            ready_for_owner_approval: 1,
            blocked: 1,
            autopublish_enabled: false,
          },
        },
      });
      const ready = captured.payload.data.candidates.find(item => item.id === 'ready-facebook-canary');
      expect(ready).toMatchObject({
        verdict: 'ready_for_owner_approval',
        owner_approval_required: true,
        publish_route: 'facebook_direct',
        ready_for_canary_approval: true,
        preview: {
          caption: expect.stringContaining('A custom portrait works'),
          listing_url: 'https://www.etsy.com/listing/1234567890',
          media_items: [expect.objectContaining({
            url: 'https://img.example.test/family-portrait.jpg',
            source: 'listing_image',
          })],
        },
      });
      const blocked = captured.payload.data.candidates.find(item => item.id === 'blocked-instagram-canary');
      expect(blocked.verdict).toBe('blocked');
      expect(blocked.blockers.map(item => item.code)).toEqual(expect.arrayContaining(['AI_CAPTION_REVIEW_REQUIRED', 'MEDIA_REQUIRED']));
      expect(JSON.stringify(captured.payload)).not.toContain('secret-fb-token');
      expect(JSON.stringify(captured.payload)).not.toContain('secret-ig-token');
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('adminCanaryReadiness returns approval preview without bridge token or publishing', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
    };
    const scheduled = [{
      id: 'admin-ready-facebook-canary',
      status: 'scheduled',
      platform: 'facebook',
      listing_id: '1234567890',
      listing_title: 'Custom family portrait keepsake',
      caption: 'A custom portrait works when it makes separate photos feel like one clear family story.\n\nSee the listing here:\nhttps://www.etsy.com/listing/1234567890',
      scheduled_at: '2026-06-12T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/family-portrait.jpg', type: 'image', source: 'listing_image' }],
    }];
    const socialConfigs = {
      fb_posts_config: { page_id: 'page_1', token: 'secret-fb-token' },
    };
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'false';
    process.env.AUTOPUBLISH = 'false';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      if (command === 'GET') {
        const result = key === 'default:social_configs' ? encodeURIComponent(JSON.stringify(socialConfigs)) : null;
        return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        return new Response(JSON.stringify({ result: scheduled.map(encodeScheduledQueueTestRecord) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const captured = await callSocial({
        action: 'adminCanaryReadiness',
        id: 'admin-ready-facebook-canary',
        now: '2026-06-11T12:00:00.000Z',
      });

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        saved: false,
        published: false,
        data: {
          requested_id: 'admin-ready-facebook-canary',
          summary: {
            ready_for_owner_approval: 1,
            autopublish_enabled: false,
          },
        },
      });
      const candidate = captured.payload.data.candidates[0];
      expect(candidate).toMatchObject({
        id: 'admin-ready-facebook-canary',
        verdict: 'ready_for_owner_approval',
        owner_approval_required: true,
        publish_route: 'facebook_direct',
        ready_for_canary_approval: true,
      });
      expect(candidate.preview.caption).toContain('A custom portrait works');
      expect(candidate.preview.media_items[0]).toMatchObject({ url: 'https://img.example.test/family-portrait.jpg' });
      expect(JSON.stringify(captured.payload)).not.toContain('secret-fb-token');
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('adminCanaryReadiness media probe blocks non-media carousel URLs before approval', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
    };
    const scheduled = [{
      id: 'admin-broken-media-canary',
      status: 'scheduled',
      platform: 'instagram',
      listing_id: '1392015419',
      listing_title: 'Aruba Vacation 2026 Tropical Island Design',
      caption: 'A trip detail can make the family plan feel ready before anyone packs.\n\nSave this idea for later, or visit the Etsy shop through the link in bio.\n\n#VacationShirts #FamilyTrip #SublimationPNG #EtsyDigitalDownload #TravelStyle',
      scheduled_at: '2026-06-12T12:00:00.000Z',
      media_items: [
        { url: 'https://img.example.test/not-an-image', type: 'image', source: 'listing_image' },
        { url: 'https://img.example.test/listing-2.jpg', type: 'image', source: 'listing_image' },
        { url: 'https://img.example.test/listing-3.jpg', type: 'image', source: 'listing_image' },
      ],
      metadata: { instagram_carousel: true },
    }];
    const socialConfigs = {
      ig_config: { ig_id: 'ig_1', token: 'secret-ig-token' },
    };
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'false';
    process.env.AUTOPUBLISH = 'false';
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === 'img.example.test') {
        if (parsed.pathname === '/not-an-image') {
          return new Response('<html>not image</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
        }
        return new Response('', { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      }
      const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      if (command === 'GET') {
        const result = key === 'default:social_configs' ? encodeURIComponent(JSON.stringify(socialConfigs)) : null;
        return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        return new Response(JSON.stringify({ result: scheduled.map(encodeScheduledQueueTestRecord) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK', method: options.method || 'GET' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const captured = await callSocial({
        action: 'adminCanaryReadiness',
        id: 'admin-broken-media-canary',
        now: '2026-06-11T12:00:00.000Z',
        probe_media: true,
      });

      expect(captured.statusCode).toBe(200);
      const candidate = captured.payload.data.candidates[0];
      expect(candidate).toMatchObject({
        id: 'admin-broken-media-canary',
        verdict: 'blocked',
        ready_for_canary_approval: false,
        owner_approval_required: false,
        media_probe: {
          checked: 3,
          ok: 2,
          failed: 1,
        },
      });
      expect(candidate.blockers.map(item => item.code)).toContain('MEDIA_URL_PROBE_FAILED');
      expect(JSON.stringify(captured.payload)).not.toContain('secret-ig-token');
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('adminCanaryReadiness blocks Instagram when UI config lacks direct publish credentials', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
      INSTAGRAM_ACCESS_TOKEN: process.env.INSTAGRAM_ACCESS_TOKEN,
      INSTAGRAM_USER_ID: process.env.INSTAGRAM_USER_ID,
    };
    const scheduled = [{
      id: 'instagram-config-present-without-credentials',
      status: 'scheduled',
      platform: 'instagram',
      listing_id: '1392015419',
      listing_title: 'Aruba Vacation 2026 Tropical Island Design',
      caption: 'A trip detail can make the family plan feel ready before anyone packs.\n\nSave this idea for later, or visit the Etsy shop through the link in bio.\n\n#VacationShirts #FamilyTrip #SublimationPNG #EtsyDigitalDownload #TravelStyle',
      scheduled_at: '2026-06-12T12:00:00.000Z',
      media_items: [
        { url: 'https://img.example.test/listing-1.jpg', type: 'image', source: 'listing_image' },
        { url: 'https://img.example.test/listing-2.jpg', type: 'image', source: 'listing_image' },
        { url: 'https://img.example.test/listing-3.jpg', type: 'image', source: 'listing_image' },
      ],
      metadata: { instagram_carousel: true },
    }];
    const socialConfigs = {
      ig_config: { ig_username: 'shop-without-token' },
    };
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'false';
    process.env.AUTOPUBLISH = 'false';
    delete process.env.INSTAGRAM_ACCESS_TOKEN;
    delete process.env.INSTAGRAM_USER_ID;
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      if (command === 'GET') {
        const result = key === 'default:social_configs' ? encodeURIComponent(JSON.stringify(socialConfigs)) : null;
        return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        return new Response(JSON.stringify({ result: scheduled.map(encodeScheduledQueueTestRecord) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const captured = await callSocial({
        action: 'adminCanaryReadiness',
        id: 'instagram-config-present-without-credentials',
        now: '2026-06-11T12:00:00.000Z',
      });

      expect(captured.statusCode).toBe(200);
      const candidate = captured.payload.data.candidates[0];
      expect(resolveInstagramDirectPublishConfig(socialConfigs)).toMatchObject({ configured: false });
      expect(candidate).toMatchObject({
        id: 'instagram-config-present-without-credentials',
        verdict: 'blocked',
        ready_for_canary_approval: false,
        owner_approval_required: false,
      });
      expect(candidate.blockers.map(item => item.code)).toContain('PUBLISH_ROUTE_NOT_CONFIGURED');
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('canaryReadiness blocks legacy autonomous records without current AI reviews and media provenance', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    };
    const legacy = {
      id: 'agent-autonomy-legacy-facebook-campaign',
      source: 'agent-autonomy',
      status: 'scheduled',
      platform: 'facebook',
      caption: 'Legacy autonomous caption without a current critic review.',
      scheduled_at: '2026-07-20T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/legacy.jpg', type: 'image' }],
      metadata: { campaign_id: 'legacy-campaign' },
    };
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      if (command === 'GET') {
        const configs = { fb_posts_config: { page_id: 'page_1', token: 'secret-fb-token' } };
        const result = key === 'default:social_configs' ? encodeURIComponent(JSON.stringify(configs)) : null;
        return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        return new Response(JSON.stringify({ result: [encodeScheduledQueueTestRecord(legacy)] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: { action: 'canaryReadiness', id: legacy.id, now: '2026-07-19T12:00:00.000Z' },
      }, res);
      const candidate = captured.payload.data.candidates[0];
      expect(candidate).toMatchObject({ verdict: 'blocked', ready_for_canary_approval: false });
      expect(candidate.blockers.map(item => item.code)).toEqual(expect.arrayContaining([
        'AI_REVIEW_CONTRACT_OBSOLETE',
        'AI_CAPTION_REVIEW_REQUIRED',
        'AI_CAMPAIGN_VISUAL_REVIEW_REQUIRED',
        'AI_MEDIA_PROVENANCE_REQUIRED',
      ]));
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('canaryReadiness accepts AI platform media strategy when selected frames match persisted media', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    const caption = 'A custom life story video turns family photos into a meaningful animated keepsake.';
    const post = {
      id: 'social-hermes-current-strategy-facebook',
      source: 'social_hermes',
      status: 'scheduled',
      platform: 'facebook',
      caption,
      scheduled_at: '2026-07-20T12:00:00.000Z',
      media_items: [
        {
          url: 'https://app.example.test/api/social?action=mediaAsset&id=shmedia_0123456789abcdef01234567',
          type: 'image',
          source: 'generated_image',
          permanent: true,
          checksum_sha256: 'a'.repeat(64),
        },
        { url: 'https://img.example.test/listing.jpg', type: 'image', source: 'listing_image' },
      ],
      metadata: {
        campaign_id: 'current-ai-strategy',
        ...approvedCampaignVisualReview('facebook'),
        ai_caption_quality_review_required: true,
        ai_caption_quality_review: {
          approved: true,
          decision: 'approve',
          reviewed_caption: caption,
          rationale: 'Grounded and appropriate for Facebook.',
        },
        media_strategy: {
          frames: [
            { id: 'hero', source: 'generated_image' },
            { id: 'proof', source: 'listing_image' },
          ],
          platform_variants: {
            facebook: { format: 'carousel', frame_ids: ['hero', 'proof'] },
          },
        },
      },
    };
    post.metadata.ai_review_content_digest = socialHermesReviewContentDigest(post);
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.PUBLIC_BASE_URL = 'https://app.example.test';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      if (command === 'GET') {
        const configs = { fb_posts_config: { page_id: 'page_1', token: 'secret-fb-token' } };
        const result = key === 'default:social_configs' ? encodeURIComponent(JSON.stringify(configs)) : null;
        return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        return new Response(JSON.stringify({ result: [encodeScheduledQueueTestRecord(post)] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: { action: 'canaryReadiness', id: post.id, now: '2026-07-19T12:00:00.000Z' },
      }, res);
      const candidate = captured.payload.data.candidates[0];
      expect(candidate).toMatchObject({ verdict: 'ready_for_owner_approval', ready_for_canary_approval: true });
      expect(candidate.blockers.map(item => item.code)).not.toContain('AI_MEDIA_PROVENANCE_REQUIRED');

      post.caption = `${caption} Changed after review.`;
      const changed = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: { action: 'canaryReadiness', id: post.id, now: '2026-07-19T12:00:00.000Z' },
      }, changed.res);
      expect(changed.captured.payload.data.candidates[0]).toMatchObject({ verdict: 'blocked', ready_for_canary_approval: false });
      expect(changed.captured.payload.data.candidates[0].blockers.map(item => item.code)).toContain('AI_REVIEW_CONTENT_CHANGED');
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('canaryReadiness rejects AI media strategy when persisted media order does not match selected frames', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    };
    const post = {
      id: 'social-hermes-mismatched-strategy-facebook',
      source: 'social_hermes',
      status: 'scheduled',
      platform: 'facebook',
      caption: 'A grounded campaign caption.',
      scheduled_at: '2026-07-20T12:00:00.000Z',
      media_items: [
        { url: 'https://img.example.test/listing.jpg', type: 'image', source: 'listing_image' },
        { url: 'https://img.example.test/generated.jpg', type: 'image', source: 'generated_image' },
      ],
      metadata: {
        campaign_id: 'mismatched-ai-strategy',
        ai_caption_quality_review_required: true,
        media_strategy: {
          frames: [
            { id: 'hero', source: 'generated_image' },
            { id: 'proof', source: 'listing_image' },
          ],
          platform_variants: { facebook: { format: 'carousel', frame_ids: ['hero', 'proof'] } },
        },
      },
    };
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      if (command === 'GET') {
        const configs = { fb_posts_config: { page_id: 'page_1', token: 'secret-fb-token' } };
        const result = key === 'default:social_configs' ? encodeURIComponent(JSON.stringify(configs)) : null;
        return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        return new Response(JSON.stringify({ result: [encodeScheduledQueueTestRecord(post)] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: { action: 'canaryReadiness', id: post.id, now: '2026-07-19T12:00:00.000Z' },
      }, res);
      expect(captured.payload.data.candidates[0].blockers.map(item => item.code)).toContain('AI_MEDIA_PROVENANCE_REQUIRED');
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('AI campaign approval enforces canary readiness at the scheduler boundary', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    };
    const post = {
      id: 'ai-campaign-readiness-boundary',
      source: 'social_hermes',
      metadata: { campaign_id: 'campaign-boundary-test' },
      status: 'scheduled',
      platform: 'facebook',
      caption: 'A grounded campaign caption for a real scheduled post.',
      scheduled_at: '2026-07-20T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/campaign.jpg', type: 'image' }],
    };
    const lists = new Map([['default:scheduled:posts', [encodeURIComponent(JSON.stringify(post))]]]);
    const locks = new Map();
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
      if (lockResponse) return lockResponse;
      if (command === 'LRANGE') {
        return new Response(JSON.stringify({ result: lists.get(parts[1]) || [] }), { status: 200 });
      }
      throw new Error(`Unexpected KV command: ${command}`);
    };

    try {
      await expect(approveScheduledPost(post.id, {
        now: '2026-07-19T12:00:00.000Z',
        readinessCheck: async () => ({
          verdict: 'blocked',
          ready_for_owner_approval: false,
          blockers: [{ code: 'MEDIA_URL_PROBE_FAILED', message: 'media probe failed' }],
        }),
      })).rejects.toMatchObject({ code: 'CANARY_READINESS_REQUIRED' });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('caller-confirmed Telegram delivery is retired', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'confirmReviewNotification',
        ids: ['forged-owner-review'],
        media_count: 3,
        telegram_message_id: 999,
      },
    }, res);

    expect(captured.statusCode).toBe(410);
    expect(captured.payload).toMatchObject({
      success: false,
      code: 'CALLER_NOTIFICATION_CONFIRMATION_RETIRED',
      published: false,
    });
  });

  test('saveReviewDraft rejects a Pinterest record with more than one image', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'saveReviewDraft',
        id: 'pinterest-carousel-not-supported',
        platform: 'pinterest',
        caption: 'One focused Pinterest pin should lead to the exact Etsy listing.',
        media_items: [
          { url: 'https://img.example.test/pin-one.jpg', type: 'image', source: 'listing_image' },
          { url: 'https://img.example.test/pin-two.jpg', type: 'image', source: 'listing_image' },
        ],
      },
    }, res);

    expect(captured.statusCode).toBe(400);
    expect(captured.payload).toMatchObject({
      success: false,
      code: 'PINTEREST_SINGLE_PIN_MEDIA_REQUIRED',
    });
  });

  test('AI campaign approval accepts the canary readiness field returned by Social Hermes', async () => {
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    };
    const post = {
      id: 'ai-campaign-canary-field-boundary',
      source: 'social_hermes',
      metadata: { campaign_id: 'campaign-canary-field-test' },
      status: 'scheduled',
      platform: 'facebook',
      caption: 'A grounded campaign caption for a real scheduled post.',
      scheduled_at: '2026-07-20T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/campaign.jpg', type: 'image' }],
    };
    const lists = new Map([['default:scheduled:posts', [encodeURIComponent(JSON.stringify(post))]]]);
    const locks = new Map();
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    const originalFetch = global.fetch;
    global.fetch = async url => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
      if (lockResponse) return lockResponse;
      if (command === 'LRANGE') return new Response(JSON.stringify({ result: lists.get(key) || [] }), { status: 200 });
      if (command === 'DEL') { lists.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
      if (command === 'LPUSH') {
        const list = lists.get(key) || [];
        for (const value of parts.slice(2)) list.unshift(value);
        lists.set(key, list);
        return new Response(JSON.stringify({ result: list.length }), { status: 200 });
      }
      throw new Error(`Unexpected KV command: ${command}`);
    };
    try {
      const updated = await approveScheduledPost(post.id, {
        now: '2026-07-19T12:00:00.000Z',
        readinessCheck: async () => ({
          verdict: 'ready_for_owner_approval',
          ready_for_canary_approval: true,
          blockers: [],
        }),
      });
      expect(updated).toMatchObject({ approved_for_publish: true, status: 'approved_scheduled' });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('AI visual quality review inspects generated pixels with the configured vision model', async () => {
    process.env.EXTERNAL_AI_BASE_URL = 'https://vision.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'vision-token';
    process.env.EXTERNAL_AI_MODEL = 'reasoning-text-model';
    process.env.EXTERNAL_VISION_MODEL = 'reasoning-vision-model';
    process.env.EXTERNAL_IMAGE_MODEL = 'image-generator-model';
    let providerBody = null;
    global.fetch = async (_url, options = {}) => {
      providerBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          decision: 'approve',
          confidence: 0.91,
          communication_goal_met: true,
          persuasive_evidence_visible: true,
          persuasive_evidence_strength: 'strong',
          offer_fidelity: 'The visible scene communicates the custom keepsake offer.',
          attention_quality: 'Clear subject and useful visual hierarchy.',
          reference_fidelity: 'No reference was required.',
          text_assessment: 'No embedded text is needed for this frame.',
          issues: [],
          blocking_issues: [],
          rationale: 'The actual image supports the intended frame and is suitable for owner review.',
          specific_revision: '',
        }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const review = await reviewGeneratedSocialImage({
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      context: {
        campaign_goal: 'Explain a custom family keepsake service',
        frame_role: 'hook',
        platforms: ['instagram'],
        owner_revision: 'Show four visibly different source photos on the left, directional arrows, and one combined group portrait on the right.',
        required_revision_outcomes: ['Distinct source-photo identities remain separate before the merge.', 'Visible directional arrows explain the transformation.'],
        rejected_creative_functions: ['Decorative collage with repeated copies of the final portrait.'],
      },
    });
    delete process.env.EXTERNAL_AI_BASE_URL;
    delete process.env.EXTERNAL_AI_API_KEY;
    delete process.env.EXTERNAL_AI_MODEL;
    delete process.env.EXTERNAL_VISION_MODEL;
    delete process.env.EXTERNAL_IMAGE_MODEL;

    expect(review).toMatchObject({ decision: 'approve', approved: true, model: 'reasoning-vision-model' });
    expect(providerBody.model).toBe('reasoning-vision-model');
    expect(providerBody.model).not.toBe('image-generator-model');
    expect(providerBody.messages[0].content[2].image_url.url).toContain('data:image/png;base64,');
    expect(providerBody.messages[0].content[0].text).toContain('four visibly different source photos');
    expect(providerBody.messages[0].content[0].text).toContain('Visible directional arrows');
    expect(providerBody.messages[0].content[0].text).toContain('Decorative collage with repeated copies');
    expect(providerBody.messages[0].content[0].text).toContain('internal production requests');
    expect(providerBody.messages[0].content[0].text).toContain('visibly inside the final canvas');
    expect(providerBody.messages[0].content[0].text).toContain('natural consumer-facing social copy');
    expect(providerBody.messages[0].content[0].text).toContain('formal classification language');
      expect(providerBody.messages[0].content[0].text).toContain('Canvas-edge clipping is a blocking composition defect');
      expect(providerBody.messages[0].content[0].text).toContain('do not prohibit every connector');
      expect(providerBody.messages[0].content[0].text).toContain('Do not spend on-image copy on formal asset labels');
  });

  test('AI visual quality review compares generated pixels with the actual Etsy reference image', async () => {
    process.env.EXTERNAL_AI_BASE_URL = 'https://vision.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'vision-token';
    process.env.EXTERNAL_VISION_MODEL = 'reasoning-vision-model';
    let providerBody = null;
    global.fetch = async (url, options = {}) => {
      if (String(url) === 'https://i.etsystatic.com/original-reference.jpg') {
        return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      providerBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        decision: 'regenerate', confidence: 0.99, communication_goal_met: false,
        persuasive_evidence_visible: false, persuasive_evidence_strength: 'absent',
        offer_fidelity: 'The candidate depicts a different product identity.', attention_quality: 'Polished but misleading.',
        reference_fidelity: 'The sold artwork is not preserved.', text_assessment: 'Not relevant.',
        issues: ['The generated artwork does not match the original reference pixels.'],
        blocking_issues: ['The sold artwork identity is not preserved.'],
        rationale: 'A thematic redraw cannot represent the exact sold design.',
        specific_revision: 'Use the exact listing image or a provider that can preserve its pixels.',
      }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const review = await reviewGeneratedSocialImage({
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        mimeType: 'image/png',
        referenceImage: { url: 'https://i.etsystatic.com/original-reference.jpg' },
        context: { reference_required: true, reference_policy: 'Preserve the sold design exactly.' },
      });
      const content = providerBody.messages[0].content;
      expect(content.filter(item => item.type === 'image_url')).toHaveLength(2);
      expect(content[1].text).toContain('GENERATED CANDIDATE');
      expect(content[3].text).toContain('ORIGINAL REFERENCE');
      expect(review).toMatchObject({ decision: 'regenerate', approved: false });
    } finally {
      delete process.env.EXTERNAL_AI_BASE_URL;
      delete process.env.EXTERNAL_AI_API_KEY;
      delete process.env.EXTERNAL_VISION_MODEL;
    }
  });

  test('AI visual quality review rejects a generated frame without local keyword matching', async () => {
    process.env.EXTERNAL_AI_BASE_URL = 'https://vision.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'vision-token';
    process.env.EXTERNAL_VISION_MODEL = 'reasoning-vision-model';
    global.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        decision: 'regenerate',
        confidence: 0.96,
        communication_goal_met: false,
        persuasive_evidence_visible: false,
        persuasive_evidence_strength: 'absent',
        offer_fidelity: 'The pixels do not explain the service outcome.',
        attention_quality: 'The composition does not provide a meaningful focal point.',
        reference_fidelity: 'No reference was required.',
        text_assessment: 'No useful visual explanation is present.',
        issues: ['The frame is decorative but does not communicate the campaign goal.'],
        blocking_issues: ['The campaign offer is not visibly demonstrated.'],
        rationale: 'The candidate would confuse the intended buyer and should not reach owner review.',
        specific_revision: 'Show a concrete, emotionally clear result-oriented scene tied to the supplied service facts.',
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const review = await reviewGeneratedSocialImage({
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      context: { campaign_goal: 'Promote an emotionally meaningful photo service', frame_role: 'hook' },
    });
    delete process.env.EXTERNAL_AI_BASE_URL;
    delete process.env.EXTERNAL_AI_API_KEY;
    delete process.env.EXTERNAL_VISION_MODEL;

    expect(review).toMatchObject({ decision: 'regenerate', approved: false, communication_goal_met: false });
    expect(review.specific_revision).toContain('concrete');
  });

  test('campaign AI vision reviews the actual ordered media package for every platform', async () => {
    process.env.EXTERNAL_AI_BASE_URL = 'https://vision.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'vision-token';
    process.env.EXTERNAL_VISION_MODEL = 'codex/gpt-5.6-terra-medium';
    let providerBody = null;
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('i.etsystatic.com')) {
        return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      providerBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{
        type: 'function',
        function: { name: 'submit_campaign_quality_review', arguments: JSON.stringify({
        decision: 'replan',
        confidence: 0.98,
        campaign_goal_met: false,
        hook_clarity: 'The opening gallery image is informational rather than persuasive.',
        offer_demonstration: 'The sequence does not visibly demonstrate the promised transformation.',
        sequence_coherence: 'The emotional reaction is unexplained between two listing slides.',
        listing_gallery_dependence: 'The package repeats weak listing-gallery material instead of building a social story.',
        visible_buyer_evidence: {
          required_evidence: 'A visually dominant before-to-finished-result transformation.',
          satisfied: false,
          strength: 'weak',
          dominant_media_keys: [],
          rationale: 'The only outcome is too small and cluttered to function as proof at feed-view scale.',
        },
        explanation_card_dependence: {
          level: 'dominant',
          rationale: 'The package relies on process and option copy instead of showing the service payoff.',
        },
        frame_reviews: [
          {
            media_key: 'media_1',
            dominant_visual: 'A dense listing infographic with a small result example.',
            persuasive_evidence_visible: true,
            persuasive_evidence_strength: 'partial',
            text_or_instruction_dominance: 'high',
            mobile_feed_hook_strength: 'weak',
            marginal_buyer_value: 'low',
            sequence_position_fit: 'poor',
            recommended_use: 'remove',
            rationale: 'The service result is too small to lead at feed-view scale.',
          },
          {
            media_key: 'media_2',
            dominant_visual: 'A generated mood image without a clear finished result.',
            persuasive_evidence_visible: false,
            persuasive_evidence_strength: 'absent',
            text_or_instruction_dominance: 'low',
            mobile_feed_hook_strength: 'weak',
            marginal_buyer_value: 'none',
            sequence_position_fit: 'poor',
            recommended_use: 'remove',
            rationale: 'It does not prove the advertised transformation.',
          },
        ],
        approval_checks: {
          compelling_lead: { status: 'fail', rationale: 'Neither frame provides a compelling lead.' },
          visible_evidence: { status: 'fail', rationale: 'The promised transformation is not visually dominant.' },
          distinct_progression: { status: 'fail', rationale: 'The sequence does not develop a persuasive story.' },
          not_gallery_repackaging: { status: 'fail', rationale: 'The package behaves like a listing gallery.' },
        },
        emotional_tone: 'The tearful reaction is ambiguous without visible positive context.',
        text_quality: 'The final slide is dense and difficult to scan.',
        platform_reviews: [
          {
            platform: 'instagram', decision: 'replan', lead_media_key: 'media_1',
            visible_offer_understanding: 'partial', persuasive_evidence_media_keys: [],
            package_strength: 'weak', listing_gallery_repackaging: true,
            rationale: 'The carousel needs a purpose-built hook and clear transformation proof.', issues: ['Weak opening hook'],
          },
          {
            platform: 'pinterest', decision: 'approve', lead_media_key: 'media_2',
            visible_offer_understanding: 'clear', persuasive_evidence_media_keys: ['media_2'],
            package_strength: 'adequate', listing_gallery_repackaging: false,
            rationale: 'The dedicated vertical discovery image works as a standalone pin.', issues: [],
          },
        ],
        issues: ['The Instagram sequence does not communicate the offer quickly enough.'],
        required_changes: ['Rebuild the Instagram sequence around a clear before-to-result transformation.'],
        rationale: 'One platform asset works, but the campaign package as a whole is not ready for owner review.',
      }) },
      }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const generatedBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      const review = await reviewSocialCampaignMedia({
        listing: { listing_id: '4316038646', title: 'Custom animated memory video' },
        context: { campaign_goal: 'Show why animating an old family photo makes a meaningful keepsake.' },
        variants: [
          {
            platform: 'instagram',
            format: 'carousel',
            caption: 'Bring one favorite family photo to life.',
            media_items: [
              { url: 'https://i.etsystatic.com/123/listing-hero.png', source: 'listing_image' },
              { id: 'shmedia_example', source: 'generated_image', mimeType: 'image/png', base64: generatedBase64 },
            ],
          },
          {
            platform: 'pinterest',
            format: 'single',
            caption: 'Animated old photo keepsake idea.',
            media_items: [{ id: 'shmedia_example', source: 'generated_image', mimeType: 'image/png', base64: generatedBase64 }],
          },
        ],
      });

      expect(review).toMatchObject({ decision: 'replan', approved: false, model: 'codex/gpt-5.6-terra-medium' });
      expect(review.platform_reviews).toHaveLength(2);
      expect(providerBody.model).toBe('codex/gpt-5.6-terra-medium');
      expect(providerBody.tool_choice).toEqual({
        type: 'function',
        function: { name: 'submit_campaign_quality_review' },
      });
      expect(providerBody.tools[0].function.parameters.properties.platform_reviews).toMatchObject({
        minItems: 2,
        maxItems: 2,
      });
      expect(providerBody.tools[0].function.parameters.required).toEqual(expect.arrayContaining([
        'visible_buyer_evidence',
        'explanation_card_dependence',
      ]));
      expect(providerBody.tools[0].function.parameters.properties.frame_reviews).toMatchObject({
        minItems: 2,
        maxItems: 2,
      });
      expect(providerBody.messages[0]).toMatchObject({ role: 'system' });
      expect(providerBody.messages[0].content).toContain('as one advertising package');
      expect(providerBody.messages[0].content).toContain('feed-view scale');
      expect(providerBody.messages[0].content).toContain('all four approval checks');
      expect(providerBody.messages[0].content).toContain('Canvas-edge clipping is a blocking composition defect');
      expect(providerBody.messages[0].content).toContain('Different scenery, pose, crop, or styling does not create progression');
      expect(providerBody.messages[1].content.filter(item => item.type === 'image_url')).toHaveLength(2);
      const prompt = providerBody.messages[1].content[0].text;
      expect(prompt).toContain('media_keys');
      expect(prompt).toContain('instagram');
      expect(prompt).toContain('pinterest');
    } finally {
      delete process.env.EXTERNAL_AI_BASE_URL;
      delete process.env.EXTERNAL_AI_API_KEY;
      delete process.env.EXTERNAL_VISION_MODEL;
    }
  });

  test('social listing planning sends actual Etsy image pixels to AI vision before selecting media', async () => {
    process.env.EXTERNAL_AI_BASE_URL = 'https://vision.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'vision-token';
    process.env.EXTERNAL_VISION_MODEL = 'reasoning-vision-model';
    let providerBody = null;
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('i.etsystatic.com')) {
        return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      providerBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          overall_summary: 'The supplied image clearly shows the offer in a campaign-relevant way.',
          images: [{
            rank: 1,
            social_use_decision: 'hero',
            quality_score: 88,
            concept_relevance_score: 94,
            visible_summary: 'A clear product-led composition.',
            rationale: 'The actual pixels communicate the intended buyer value.',
            concerns: [],
          }],
        }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const analysis = await analyzeSocialListingImages({
      listing: {
        listing_id: 'vision-listing',
        title: 'Custom keepsake',
        images: [{ rank: 1, url: 'https://i.etsystatic.com/123/example.png' }],
      },
      campaignContext: { campaign_context: 'Show why this keepsake matters to a family buyer.' },
    });
    delete process.env.EXTERNAL_AI_BASE_URL;
    delete process.env.EXTERNAL_AI_API_KEY;
    delete process.env.EXTERNAL_VISION_MODEL;

    expect(analysis).toMatchObject({ available: true, provider: 'reasoning-vision-model' });
    expect(analysis.images[0]).toMatchObject({ rank: 1, social_use_decision: 'hero', quality_score: 88 });
    expect(providerBody.messages[0].content.some(part => part.image_url?.url?.startsWith('data:image/png;base64,'))).toBe(true);
    expect(providerBody.max_tokens).toBe(4000);
    expect(providerBody.messages[0].content[0].text).toContain('instructions, requirements, process explanation');
    expect(providerBody.messages[0].content[0].text).toContain('strongest visible proof');
    expect(providerBody.messages[0].content[0].text).toContain('integer scores from 0 to 100');
  });

  test('multi-batch Etsy gallery gets one final AI-wide hero adjudication', async () => {
    process.env.EXTERNAL_AI_BASE_URL = 'https://vision.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'vision-token';
    process.env.EXTERNAL_VISION_MODEL = 'reasoning-vision-model';
    const calls = [];
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('i.etsystatic.com')) {
        return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      const body = JSON.parse(options.body);
      calls.push(body);
      const content = body.messages[0].content;
      if (Array.isArray(content)) {
        const ranks = content
          .map(part => Number(String(part.text || '').match(/^Listing image rank (\d+):$/)?.[1]))
          .filter(Number.isFinite);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            overall_summary: `Batch view of ranks ${ranks.join(', ')}.`,
            images: ranks.map(rank => ({
              rank,
              social_use_decision: 'hero',
              quality_score: 80,
              concept_relevance_score: 80,
              visible_summary: `Observed listing image ${rank}.`,
              rationale: 'Strongest candidate inside this bounded batch.',
              concerns: [],
            })),
          }) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      expect(content).toContain('Compare all ranks across batches');
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          overall_summary: 'Rank 5 is the strongest buyer-facing hero across the complete gallery.',
          images: [1, 2, 3, 4, 5].map(rank => ({
            rank,
            social_use_decision: rank === 5 ? 'hero' : 'support',
            quality_score: rank === 5 ? 96 : 74,
            concept_relevance_score: rank === 5 ? 98 : 72,
            visible_summary: `Observed listing image ${rank}.`,
            rationale: rank === 5
              ? 'Strongest complete-gallery campaign lead.'
              : 'Useful support but weaker than rank 5.',
            concerns: [],
          })),
        }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const analysis = await analyzeSocialListingImages({
        listing: {
          listing_id: 'gallery-wide-1',
          title: 'Custom family service',
          description: 'A custom buyer-facing service.',
        },
        campaignContext: { campaign_goal: 'Show the strongest finished result.' },
        images: [1, 2, 3, 4, 5].map(rank => ({
          rank,
          url: `https://i.etsystatic.com/gallery-wide-${rank}.jpg`,
        })),
      });

      expect(calls).toHaveLength(3);
      expect(analysis).toMatchObject({
        complete: true,
        batch_count: 2,
        gallery_wide_adjudication: true,
      });
      expect(analysis.images.find(item => item.rank === 5)).toMatchObject({
        social_use_decision: 'hero',
        quality_score: 96,
      });
      expect(analysis.images.find(item => item.rank === 1).social_use_decision).toBe('support');
    } finally {
      delete process.env.EXTERNAL_AI_BASE_URL;
      delete process.env.EXTERNAL_AI_API_KEY;
      delete process.env.EXTERNAL_VISION_MODEL;
    }
  });

  test('researchPlan lets external AI author web queries directly from shop context', async () => {
    const originalFetch = global.fetch;
    const originalAiEnv = {
      EXTERNAL_AI_BASE_URL: process.env.EXTERNAL_AI_BASE_URL,
      EXTERNAL_AI_API_KEY: process.env.EXTERNAL_AI_API_KEY,
      EXTERNAL_AI_MODEL: process.env.EXTERNAL_AI_MODEL,
    };
    process.env.EXTERNAL_AI_BASE_URL = 'https://ai.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'test-ai-key';
    process.env.EXTERNAL_AI_MODEL = 'test-social-model';
    try {
      global.fetch = async (url, options = {}) => {
        const body = JSON.parse(options.body || '{}');
        const system = String(body.messages?.[0]?.content || '');
        const planningPayload = JSON.parse(String(body.messages?.[1]?.content || '{}'));
        expect(body.max_tokens).toBe(4000);
        expect(system).toContain('web-research planner');
        expect(planningPayload.ai_selected_shop_opportunities).toEqual([]);
        expect(planningPayload.shop_context.listings[0]).toMatchObject({
          listing_id: 'listing-42',
          title: 'Custom family photo composition',
        });
        expect(planningPayload.shop_context.listings[0].description).toHaveLength(240);
        expect(planningPayload.instruction).toContain('research directions');
        expect(body.tool_choice).toEqual({
          type: 'function',
          function: { name: 'submit_structured_result' },
        });
        expect(body.tools?.[0]?.function?.parameters).toMatchObject({
          type: 'object',
          additionalProperties: false,
          required: ['rationale', 'queries'],
          properties: { queries: { type: 'array', minItems: 2, maxItems: 6 } },
        });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          rationale: 'Verify whether the selected buyer moment is currently supported.',
          queries: [{
            id: 'current-evidence',
            query: 'current evidence for the AI selected buyer moment 2026',
            purpose: 'Find current authoritative evidence that can confirm or reject the angle.',
            freshness: 'last 30 days',
            preferred_sources: ['official organizations', 'established publications'],
          }],
        }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'researchPlan',
          now: '2026-07-10T12:00:00.000Z',
          autonomous_context: {
            shop_totals: { active_listings: 120 },
            listings: [{
              listing_id: 'listing-42',
              title: 'Custom family photo composition',
              description: 'A custom digital service that combines supplied family photos. '.repeat(12),
              views: 220,
              favorites: 18,
            }],
            reviews: [{
              review_id: 'review-42',
              listing_id: 'listing-42',
              rating: 5,
              text: 'The result looked natural and thoughtful.',
            }],
          },
        },
      }, res);
      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({ success: true, action: 'researchPlan', saved: false, published: false });
      expect(captured.payload.data.queries).toEqual([
        expect.objectContaining({ query: 'current evidence for the AI selected buyer moment 2026' }),
      ]);
      expect(captured.payload.data.evidence_requirements).toMatchObject({
        minimum_distinct_sources: 2,
        source_pages_must_be_read: true,
      });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalAiEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('canaryReadiness accepts Instagram carousel mixing persistent generated mediaAsset with listing images', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      AUTOPUBLISH_ENABLED: process.env.AUTOPUBLISH_ENABLED,
      AUTOPUBLISH: process.env.AUTOPUBLISH,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    const assetId = 'shmedia_62a1e8bf5a3822b081a2d4a6';
    const generatedUrl = `https://manager.example.test/api/social?action=mediaAsset&id=${assetId}`;
    const scheduled = [{
      id: 'ready-instagram-mixed-carousel',
      status: 'scheduled',
      platform: 'instagram',
      listing_id: '1392015419',
      listing_title: 'Aruba Vacation 2026 Tropical Island Design',
      caption: 'A trip detail can make the family plan feel ready before anyone packs.\n\nSave this idea for later, or visit the Etsy shop through the link in bio.\n\n#VacationShirts #FamilyTrip #SublimationPNG #EtsyDigitalDownload #TravelStyle',
      scheduled_at: '2026-06-12T12:00:00.000Z',
      media_items: [
        { url: generatedUrl, type: 'image', source: 'generated_image', permanent: true, checksum_sha256: 'a'.repeat(64) },
        { url: 'https://i.etsystatic.com/23207964/r/il/5a7a2f/4589442324/il_fullxfull.4589442324_8mra.jpg', type: 'image', source: 'listing_image' },
        { url: 'https://i.etsystatic.com/23207964/r/il/c3480b/4589442370/il_fullxfull.4589442370_rgkc.jpg', type: 'image', source: 'listing_image' },
        { url: 'https://i.etsystatic.com/23207964/r/il/c8259c/4637676749/il_fullxfull.4637676749_7tqg.jpg', type: 'image', source: 'listing_image' },
      ],
      generated_image_url: generatedUrl,
      listing_image_url: 'https://i.etsystatic.com/23207964/r/il/5a7a2f/4589442324/il_fullxfull.4589442324_8mra.jpg',
      metadata: { instagram_carousel: true, campaign_id: 'campaign_mixed_carousel' },
    }];
    const socialConfigs = {
      ig_config: { ig_id: 'ig_1', token: 'secret-ig-token' },
    };
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.AUTOPUBLISH_ENABLED = 'false';
    process.env.AUTOPUBLISH = 'false';
    process.env.PUBLIC_BASE_URL = 'https://manager.example.test';
    global.fetch = async (url) => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      if (command === 'GET') {
        const result = key === 'default:social_configs' ? encodeURIComponent(JSON.stringify(socialConfigs)) : null;
        return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        return new Response(JSON.stringify({ result: scheduled.map(encodeScheduledQueueTestRecord) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token', host: 'manager.example.test' },
        query: {},
        body: { action: 'canaryReadiness', id: 'ready-instagram-mixed-carousel', now: '2026-06-11T12:00:00.000Z' },
      }, res);

      expect(captured.statusCode).toBe(200);
      const candidate = captured.payload.data.candidates[0];
      expect(candidate).toMatchObject({
        id: 'ready-instagram-mixed-carousel',
        platform: 'instagram',
        verdict: 'ready_for_owner_approval',
        ready_for_canary_approval: true,
        owner_approval_required: true,
        publish_route: 'instagram_direct',
        media_count: 6,
        blockers: [],
      });
      expect(candidate.preview.media_items[0]).toMatchObject({ url: generatedUrl, source: 'generated_image' });
      expect(candidate.preview.media_items.some(item => item.source === 'listing_image')).toBe(true);
      expect(candidate.preview.media_items.filter(item => item.source === 'listing_image').length).toBeGreaterThanOrEqual(3);
      expect(candidate.preview.caption).toContain('#VacationShirts');
      expect(captured.payload.saved).toBe(false);
      expect(captured.payload.published).toBe(false);
      expect(JSON.stringify(captured.payload)).not.toContain('secret-ig-token');
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('contentOpportunities HTTP facade preserves the semantic-filter payload contract', async () => {
    const originalFetch = global.fetch;
    const originalAiEnv = {
      EXTERNAL_AI_BASE_URL: process.env.EXTERNAL_AI_BASE_URL,
      EXTERNAL_AI_API_KEY: process.env.EXTERNAL_AI_API_KEY,
      EXTERNAL_AI_MODEL: process.env.EXTERNAL_AI_MODEL,
    };
    process.env.EXTERNAL_AI_BASE_URL = 'https://ai.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'test-ai-key';
    process.env.EXTERNAL_AI_MODEL = 'test-social-model';
    let selectionCalls = 0;

    try {
      global.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url));
        if (parsed.hostname !== 'ai.example.test') {
          return new Response(JSON.stringify({ result: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        selectionCalls += 1;
        const body = JSON.parse(options.body || '{}');
        const payload = JSON.parse(body.messages?.[1]?.content || '{}');
        const signal = payload.local_raw_signals?.[0] || {};
        const listingId = payload.listing_operational_signals?.[0]?.listing_id || 'facade-listing';
        return new Response(JSON.stringify({
          choices: [{
            message: { content: JSON.stringify({
              status: 'selected',
              confidence: 0.93,
              rationale: 'The supplied listing facts support a truthful evergreen spotlight.',
              selected_opportunities: [{
                source_opportunity_id: signal.id,
                type: 'evergreen_listing_spotlight',
                moment: 'AI-selected buyer story',
                reason: 'The listing facts support a useful buyer-facing angle.',
                audience: 'Etsy buyers',
                campaign_context: 'Show one truthful use case from the supplied listing.',
                platforms: ['instagram'],
                platform_decisions: {
                  instagram: { decision: 'include', rationale: 'The listing has suitable visual media.' },
                },
                listing_ids: [listingId],
                listing_campaign_fit_by_id: {
                  [listingId]: {
                    decision: 'strong_fit',
                    should_use_listing: true,
                    confidence: 0.92,
                    rationale: 'The supplied listing facts directly support this angle.',
                    natural_connection: 'direct listing spotlight',
                    safer_angle: 'stay factual',
                    risks: [],
                    evidence: ['listing facts'],
                  },
                },
                research_basis: 'evergreen',
                research_source_ids: [],
                priority: 90,
                evidence: ['listing facts'],
                risks: [],
              }],
              rejected_signals: [],
            }) },
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token', host: 'manager.example.test' },
        query: {},
        body: {
          action: 'contentOpportunities',
          now: '2026-08-09T12:00:00.000Z',
          platforms: ['instagram'],
          limit: 1,
          listings: [{
            listing_id: 'facade-listing',
            title: 'Custom Portrait Keepsake',
            description: 'A custom portrait made from a supplied customer photo.',
            url: 'https://www.etsy.com/listing/facade-listing',
            views: 900,
            num_favorers: 25,
            recent_orders: 2,
            media_items: [{ url: 'https://img.example.test/facade.jpg', width: 1600, height: 2000 }],
          }],
        },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        action: 'contentOpportunities',
        saved: false,
        published: false,
        data: {
          status: 'ready',
          external_ai_semantic_fit_used: true,
          opportunities: [{
            listing_candidates: [expect.objectContaining({ listing_id: 'facade-listing' })],
          }],
          ai_opportunity_selection: { applied: true, selected_count: 1 },
          ai_semantic_selection: { applied: true, evaluated_candidates: 1, rejected_candidates: 0 },
        },
      });
      expect(selectionCalls).toBe(1);
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalAiEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('content opportunity discovery exposes unranked listing facts instead of choosing winners locally', () => {
    const suggestions = suggestSocialContentOpportunities({
      now: '2026-06-25T12:00:00.000Z',
      records: [],
      platforms: ['instagram', 'facebook', 'pinterest'],
      autonomousContext: {
        listings: [
          {
            listing_id: 'popular-design',
            title: 'Modern SVG bundle for craft projects',
            url: 'https://www.etsy.com/listing/popular-design',
            views: 1800,
            num_favorers: 90,
            recent_orders: 5,
            recent_units: 7,
            recent_revenue_usd: 160,
            media_items: [
              { url: 'https://img.example.test/popular-1.jpg', width: 1600, height: 2000 },
              { url: 'https://img.example.test/popular-2.jpg', width: 1600, height: 2000 },
              { url: 'https://img.example.test/popular-3.jpg', width: 1600, height: 1600 },
            ],
          },
          {
            listing_id: 'seasonal-weak',
            title: 'Manatee Sublimation Design Tropical T-Shirt PNG',
            url: 'https://www.etsy.com/listing/seasonal-weak',
            views: 8,
            num_favorers: 0,
            recent_orders: 0,
            media_items: [{ url: 'https://img.example.test/weak.jpg', width: 1200, height: 1200 }],
          },
        ],
      },
    });

    const listingFacts = suggestions.opportunities.find(item => item.type === 'shop_facts_for_ai_review');
    expect(listingFacts).toBeTruthy();
    expect(listingFacts.listing_candidates).toHaveLength(2);
    expect(listingFacts.listing_candidates[0]).toMatchObject({
      listing_id: 'popular-design',
      recent_orders: 5,
      recent_units: 7,
      views: 1800,
    });
    expect(listingFacts.listing_candidates[1]).toMatchObject({ listing_id: 'seasonal-weak', views: 8 });
    expect(JSON.stringify(listingFacts)).not.toContain('opportunity_score');
    expect(suggestions.honesty_note).toContain('local code made no marketing match or product choice');
  });

  test('content opportunity discovery sends a broader candidate pool to AI selection', () => {
    const listings = Array.from({ length: 6 }, (_, index) => ({
      listing_id: `summer-trip-${index + 1}`,
      title: `Beach vacation trip PNG design ${index + 1}`,
      url: `https://www.etsy.com/listing/summer-trip-${index + 1}`,
      views: 200 - index,
      num_favorers: 10,
      recent_orders: index === 0 ? 2 : 0,
      media_items: [
        { url: `https://img.example.test/summer-${index + 1}-1.jpg`, width: 1600, height: 2000 },
        { url: `https://img.example.test/summer-${index + 1}-2.jpg`, width: 1600, height: 1600 },
        { url: `https://img.example.test/summer-${index + 1}-3.jpg`, width: 1600, height: 1600 },
      ],
    }));
    const suggestions = suggestSocialContentOpportunities({
      now: '2026-06-25T12:00:00.000Z',
      records: [],
      platforms: ['instagram', 'facebook', 'pinterest'],
      autonomousContext: { listings },
    });

    const inventory = suggestions.opportunities.find(item => item.type === 'shop_facts_for_ai_review');
    expect(inventory).toBeTruthy();
    expect(inventory.listing_candidates.map(item => item.listing_id)).toEqual([
      'summer-trip-1',
      'summer-trip-2',
      'summer-trip-3',
      'summer-trip-4',
      'summer-trip-5',
      'summer-trip-6',
    ]);
  });

  test('creativePlan fails closed instead of turning metadata-only ranking into campaign variants', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token', host: 'manager.example.test' },
      query: {},
      body: {
        action: 'creativePlan',
        now: '2026-06-07T12:00:00.000Z',
        platforms: ['instagram', 'facebook', 'all'],
        listing: {
          listing_id: '42',
          title: 'Custom Watercolor Pet Portrait Digital File',
          url: 'https://www.etsy.com/listing/42/custom-watercolor-pet-portrait',
          listing_campaign_fit: {
            source: 'unit_ai',
            decision: 'acceptable_fit',
            should_use_listing: true,
            confidence: 0.91,
            rationale: 'The supplied campaign context naturally fits this custom portrait listing.',
          },
          media_items: [
            { id: 'first-small', url: 'https://img.example.test/first-small.jpg', width: 400, height: 300, rank: 1 },
            { id: 'strong', url: 'https://img.example.test/strong.jpg', width: 1600, height: 2000, rank: 4, alt: 'Finished watercolor-style pet portrait example with soft neutral background' },
            { id: 'square', url: 'https://img.example.test/square.jpg', width: 1400, height: 1400, rank: 2, alt: 'Square crop showing portrait detail' },
          ],
        },
        context: { occasion: 'Father’s Day', audience: 'pet parents buying a thoughtful gift' },
      },
    }, res);

    expect(captured.statusCode).toBe(200);
    expect(captured.payload).toMatchObject({ success: true, action: 'creativePlan', saved: false, published: false });
    const plan = captured.payload.data;
    expect(plan.status).toBe('blocked_no_media_ready_candidate');
    expect(plan.image_selection.confidence).toBe('none');
    expect(plan.image_selection.honesty_note).toContain('requires AI listing understanding');
    expect(plan.image_selection.ranked).toEqual([]);
    expect(plan.storyboard).toEqual([]);
    expect(plan.listing_media_ranking_rationale || []).toEqual([]);
    expect(plan.variants).toEqual([]);
    expect(plan.candidate_selection.attempts[0].status).toBe('blocked_ai_listing_understanding_required');
  });

  test('creativePlan asks AI to complete supplied listing understanding when autonomous media strategy is missing', async () => {
    const originalFetch = global.fetch;
    const originalAiEnv = {
      EXTERNAL_AI_BASE_URL: process.env.EXTERNAL_AI_BASE_URL,
      EXTERNAL_AI_API_KEY: process.env.EXTERNAL_AI_API_KEY,
      EXTERNAL_AI_MODEL: process.env.EXTERNAL_AI_MODEL,
    };
    process.env.EXTERNAL_AI_BASE_URL = 'https://ai.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'test-ai-key';
    process.env.EXTERNAL_AI_MODEL = 'test-social-model';
    let understandingCalls = 0;
    let captionCriticCalls = 0;
    let campaignCriticCalls = 0;
    let understandingPayload = null;
    let understandingSystem = '';
    let understandingSchema = null;
    let captionCriticSystem = '';
    const instagramCaption = 'Separate family photos can become one believable keepsake when lighting and scale are handled carefully. #FamilyKeepsake #PhotoEditing';
    try {
      global.fetch = async (url, options = {}) => {
        if (String(url) === 'https://i.etsystatic.com/family-merge.jpg') {
          return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          });
        }
        const body = JSON.parse(options.body || '{}');
        const system = String(body.messages?.[0]?.content || '');
        if (system.includes('Etsy social marketing analyst')) {
          understandingCalls += 1;
          understandingSystem = system;
          understandingSchema = body.tools?.[0]?.function?.parameters || null;
          understandingPayload = JSON.parse(String(body.messages?.[1]?.content || '{}'));
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            what_is_sold: 'A custom digital family photo composition service.',
            product_category: 'custom digital creative service',
            fulfillment: 'digital delivery',
            buyer_use_case: 'Creating one believable family keepsake from supplied photos.',
            target_buyer: 'Families preserving a shared memory.',
            marketing_angle: 'Show the care behind a natural-looking family composition.',
            caption_body: 'Separate family photos can become one believable keepsake when lighting and scale are handled carefully.',
            platform_captions: { instagram: instagramCaption },
            visual_brief: 'Use the supplied finished example as factual product evidence.',
            media_strategy: {
              format: 'single',
              target_media_count: 1,
              listing_media_decisions: Array.from({ length: 10 }, (_, index) => index === 0
                ? {
                  rank: 1,
                  decision: 'use_exact',
                  social_role: 'finished-result hero',
                  rationale: 'The exact Etsy pixels already provide the strongest truthful finished-result evidence.',
                }
                : {
                  rank: index + 1,
                  decision: 'exclude',
                  social_role: 'none for this focused campaign',
                  rationale: `Media rank ${index + 1} adds no distinct buyer evidence beyond the selected hero.`,
                }),
              required_visible_evidence: 'A clear finished custom family-photo composition shown as the dominant result.',
              platform_variants: {
                instagram: {
                  format: 'single',
                  frame_ids: ['finished-example'],
                  buyer_evidence_frame_ids: ['finished-example'],
                },
              },
              frames: [{
                id: 'finished-example',
                role: 'finished result evidence',
                source: 'listing_image',
                reference_media_rank: 1,
                communication_goal: 'Make the finished family composition immediately understandable.',
                visible_buyer_evidence: 'The completed combined family portrait itself fills the frame.',
                evidence_strength: 'primary',
                rationale: 'The AI-inspected finished example communicates the actual service result.',
              }],
            },
            evidence: ['listing description', 'AI visual analysis'],
            unknowns: [],
            confidence: 0.94,
          }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (system.includes('independent quality critic')) {
          captionCriticCalls += 1;
          captionCriticSystem = system;
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            platform_caption_reviews: {
              instagram: {
                approved: true,
                decision: 'approve',
                reviewed_caption: instagramCaption,
                rationale: 'The caption is specific to the service and grounded in the supplied facts.',
                factual_grounding: 'It describes combining supplied family photos without promising unsupported outcomes.',
                platform_fit: 'Concise visual-first copy with relevant discovery tags.',
                risks: [],
              },
            },
          }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (system.includes('final campaign-level visual editor')) {
          campaignCriticCalls += 1;
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            decision: 'approve',
            confidence: 0.95,
            campaign_goal_met: true,
            hook_clarity: 'The finished result is immediately clear.',
            offer_demonstration: 'The actual service result is visible.',
            sequence_coherence: 'A single proof image is sufficient for this concept.',
            listing_gallery_dependence: 'The selected image is evidence, not filler.',
            visible_buyer_evidence: {
              required_evidence: 'A clear finished custom family-photo composition.',
              satisfied: true,
              strength: 'strong',
              dominant_media_keys: ['media_1'],
              rationale: 'The finished result fills the frame and is immediately understandable.',
            },
            explanation_card_dependence: {
              level: 'none',
              rationale: 'The campaign is carried by the visible result rather than explanatory copy.',
            },
            frame_reviews: [{
              media_key: 'media_1',
              dominant_visual: 'The finished family composition fills the frame.',
              persuasive_evidence_visible: true,
              persuasive_evidence_strength: 'strong',
              text_or_instruction_dominance: 'low',
              mobile_feed_hook_strength: 'strong',
              marginal_buyer_value: 'strong',
              sequence_position_fit: 'strong',
              recommended_use: 'lead',
              rationale: 'The actual service result is immediate and dominant.',
            }],
            approval_checks: {
              compelling_lead: { status: 'pass', rationale: 'The result is immediately visible.' },
              visible_evidence: { status: 'pass', rationale: 'The finished composition is strong proof.' },
              distinct_progression: { status: 'pass', rationale: 'A single strong image is sufficient.' },
              not_gallery_repackaging: { status: 'pass', rationale: 'This is focused proof rather than a gallery summary.' },
            },
            emotional_tone: 'Natural and appropriate.',
            text_quality: 'No embedded copy is required.',
            platform_reviews: [{
              platform: 'instagram', decision: 'approve', lead_media_key: 'media_1',
              visible_offer_understanding: 'clear', persuasive_evidence_media_keys: ['media_1'],
              package_strength: 'strong', listing_gallery_repackaging: false,
              rationale: 'The proof-led single image fits Instagram.', issues: [],
            }],
            issues: [],
            required_changes: [],
            rationale: 'The complete Instagram package is ready for owner review.',
          }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`Unexpected AI call: ${system.slice(0, 80)}`);
      };
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token', host: 'manager.example.test' },
        query: {},
        body: {
          action: 'creativePlan',
          platforms: ['instagram'],
          listing: {
            listing_id: 'family-merge-42',
            title: 'Custom Family Photo Composition',
            description: 'We combine supplied family photos into one natural digital composition.',
            url: 'https://www.etsy.com/listing/family-merge-42',
            media_items: Array.from({ length: 10 }, (_, index) => ({
              url: index === 0
                ? 'https://i.etsystatic.com/family-merge.jpg'
                : `https://i.etsystatic.com/family-merge-${index + 1}.jpg`,
              width: 1600,
              height: 2000,
              rank: index + 1,
            })),
            listing_understanding: {
              source: 'external_ai_selection',
              what_is_sold: 'A custom digital family photo composition service.',
              buyer_use_case: 'A family keepsake.',
              marketing_angle: 'A natural combined family memory.',
              caption_body: 'Bring separate family photos into one believable keepsake.',
              confidence: 0.9,
            },
            listing_campaign_fit: {
              decision: 'strong_fit',
              should_use_listing: true,
              confidence: 0.95,
              rationale: 'The selected shop opportunity directly concerns this service.',
            },
          },
          context: {
            social_factory_path: true,
            factory_path: 'social_autonomous_content_factory',
            require_ai_media_strategy: true,
            require_ai_caption_quality_review: true,
            require_campaign_visual_quality_review: true,
          },
          visual_analysis: {
            available: true,
            provider: 'unit-vision',
            images: Array.from({ length: 10 }, (_, index) => ({
              rank: index + 1,
              url: index === 0
                ? 'https://i.etsystatic.com/family-merge.jpg'
                : `https://i.etsystatic.com/family-merge-${index + 1}.jpg`,
              social_use_decision: index === 0 ? 'hero' : 'support',
              quality_score: index === 0 ? 0.94 : 0.7,
              concept_relevance_score: index === 0 ? 0.95 : 0.65,
              rationale: index === 0
                ? 'Finished family composition is clear and campaign-relevant.'
                : 'Supplementary gallery media was inspected but is not essential to this campaign.',
            })),
          },
        },
      }, res);
      expect(captured.statusCode).toBe(200);
      expect(understandingCalls).toBe(1);
      expect(captionCriticCalls).toBe(1);
      expect(campaignCriticCalls).toBe(1);
      expect(understandingSystem).toContain('Never ask buyers to DM');
      expect(understandingSystem).toContain('compare at least a listing-only direction');
      expect(understandingSystem).toContain('listing_media_decisions');
      expect(understandingSystem).toContain('Do not reject all listing media merely because generated art can look cleaner');
      expect(understandingSystem).toContain('Build the package around visible buyer evidence');
      expect(understandingSystem).toContain('option-menu, or ordering-guide frame earns a place only');
      expect(understandingSystem).toContain('must not substitute for it');
      expect(understandingSystem).toContain('Never generate an internal production request');
      expect(understandingSystem).toContain('buyer_evidence_frame_ids');
      expect(understandingSystem).toContain('clearly disclosed fictional transformation demonstration');
      expect(understandingSystem).toContain('Do not confuse a fictional demonstration with a fabricated customer claim');
      expect(understandingSystem).toContain('social-native thumbnail energy');
      expect(understandingSystem).toContain('Treat every selected frame as advertising');
      expect(understandingSystem).toContain('do not prohibit every connector');
      expect(understandingSystem).toContain('Do not spend on-image copy on formal asset labels');
      expect(understandingSystem).toContain('Canvas-edge clipping is a blocking composition defect');
      expect(understandingSystem).toContain('Different scenery, pose, crop, or styling does not create progression');
      expect(understandingSystem).toContain('Never place it as a legalistic footer');
      expect(understandingSystem).toContain('Prefer a natural disclosure in the platform caption');
      expect(understandingSystem).toContain('not formal compliance language');
      expect(understandingSystem).toContain('generic image/video icons');
      expect(understandingSystem).toContain('must not quote, paraphrase, restate, or label the review text');
      expect(understandingSystem).toContain('no longer than 1600 characters');
      expect(understandingSchema?.properties?.media_strategy?.required).toContain('required_visible_evidence');
      expect(understandingSchema?.properties?.media_strategy?.required).toContain('listing_media_decisions');
      expect(understandingSchema?.properties?.media_strategy?.properties?.listing_media_decisions?.items?.properties?.decision?.enum)
        .toEqual(['use_exact', 'reference_only', 'exclude']);
      expect(understandingSchema?.properties?.media_strategy?.properties?.listing_media_decisions).toMatchObject({
        minItems: 10,
        maxItems: 10,
      });
      expect(understandingSchema?.properties?.media_strategy?.properties?.listing_media_decisions?.items?.properties?.rank?.enum)
        .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(understandingPayload?.listing?.media).toHaveLength(10);
      expect(understandingPayload?.listing?.visual_analysis?.images).toHaveLength(10);
      expect(understandingSchema?.properties?.media_strategy?.properties?.platform_variants?.properties?.instagram?.required)
        .toContain('buyer_evidence_frame_ids');
      expect(understandingSchema?.properties?.media_strategy?.properties?.frames?.items?.properties?.prompt).toMatchObject({
        type: 'string',
        maxLength: 1800,
      });
      expect(understandingSchema?.properties?.media_strategy?.properties?.frames?.items?.properties?.context_note?.description)
        .toContain('rendered verbatim');
      expect(understandingSchema?.properties?.media_strategy?.properties?.frames?.items?.properties?.context_note?.description)
        .toContain('Never quote, paraphrase, repeat, summarize, or label the review text');
      expect(understandingSchema?.properties?.media_strategy?.properties?.frames?.items?.properties?.prompt?.description)
        .toContain('cannot substitute for visible source/result');
      expect(captionCriticSystem).toContain('Reject captions that ask buyers to DM');
      expect(understandingPayload.existing_listing_understanding).toMatchObject({
        what_is_sold: 'A custom digital family photo composition service.',
        marketing_angle: 'A natural combined family memory.',
      });
      expect(understandingPayload.campaign_context).toMatchObject({
        social_factory_path: true,
        require_vision_for_social_hero: true,
      });
      expect(captured.payload.data.listing_understanding).toMatchObject({
        caption_review_source: 'external_ai_caption_critic',
        caption_review_model: 'test-social-model',
        platform_caption_reviews: { instagram: {
          approved: true,
          decision: 'approve',
          critic_source: 'external_ai_caption_critic',
          critic_model: 'test-social-model',
        } },
      });
      expect(captured.payload.data.listing_understanding.caption_review_run_id).toMatch(/^caption_critic_/);
      expect(captured.payload.data.variants[0].caption_quality_review).toMatchObject({
        critic_source: 'external_ai_caption_critic',
        critic_model: 'test-social-model',
      });
      expect(captured.payload.data.listing_understanding.media_strategy).toMatchObject({
        format: 'single',
        required_visible_evidence: 'A clear finished custom family-photo composition shown as the dominant result.',
        platform_variants: {
          instagram: { buyer_evidence_frame_ids: ['finished-example'] },
        },
        frames: [expect.objectContaining({
          source: 'listing_image',
          reference_media_rank: 1,
          evidence_strength: 'primary',
          visible_buyer_evidence: 'The completed combined family portrait itself fills the frame.',
        })],
      });
      expect(captured.payload.data.listing_understanding.media_strategy.listing_media_decisions).toHaveLength(10);
      expect(captured.payload.data.listing_understanding.media_strategy.listing_media_decisions[0]).toMatchObject({
        rank: 1,
        decision: 'use_exact',
        social_role: 'finished-result hero',
      });
      expect(captured.payload.data.storyboard[0]).toMatchObject({
        frame_id: 'finished-example',
        evidence_strength: 'primary',
      });
      expect(captured.payload.data.status).not.toBe('blocked_ai_media_strategy_required');
      expect(captured.payload.data).toMatchObject({
        status: 'ready_for_review',
        campaign_quality_review_required: true,
        campaign_quality_review: { approved: true, decision: 'approve' },
        visual_analysis: {
          available: true,
          provider: 'unit-vision',
        },
      });
      expect(captured.payload.data.visual_analysis.images).toHaveLength(10);
      expect(captured.payload.data.visual_analysis.images[0]).toMatchObject({
        rank: 1,
        social_use_decision: 'hero',
      });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalAiEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('creativePlan re-plans a valid owner-review preview from natural owner feedback', async () => {
    const originalFetch = global.fetch;
    const originalAiEnv = {
      EXTERNAL_AI_BASE_URL: process.env.EXTERNAL_AI_BASE_URL,
      EXTERNAL_AI_API_KEY: process.env.EXTERNAL_AI_API_KEY,
      EXTERNAL_AI_MODEL: process.env.EXTERNAL_AI_MODEL,
    };
    process.env.EXTERNAL_AI_BASE_URL = 'https://ai.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'test-ai-key';
    process.env.EXTERNAL_AI_MODEL = 'test-social-model';
    const ownerRevision = 'Зроби яскраву хайпову заглавну фотку: багато окремих фотокарток перетворюються на спільне групове фото. Другий guide-кадр прибери. І переоціни Pinterest.';
    let analystCalls = 0;
    let analystSystem = '';
    let analystPayload = null;
    try {
      global.fetch = async (_url, options = {}) => {
        const body = JSON.parse(options.body || '{}');
        const system = String(body.messages?.[0]?.content || '');
        if (!system.includes('Etsy social marketing analyst')) {
          throw new Error(`Unexpected AI call: ${system.slice(0, 80)}`);
        }
        analystCalls += 1;
        analystSystem = system;
        analystPayload = JSON.parse(String(body.messages?.[1]?.content || '{}'));
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          what_is_sold: 'A custom digital service that merges separate supplied photos into one group portrait.',
          product_category: 'custom digital photo editing service',
          fulfillment: 'digital delivery',
          buyer_use_case: 'Creating one shared group portrait from separate photos of people.',
          target_buyer: 'Families who do not have one complete group photo.',
          marketing_angle: 'Show separate snapshots visually converging into one believable group portrait.',
          caption_body: 'Separate photos can become one shared group portrait that brings everyone into the same frame.',
          platform_captions: {
            instagram: 'Separate snapshots can become one shared group portrait that brings everyone into the same frame. See the custom photo merge service through the Etsy link in bio. #FamilyPortrait #PhotoMerge',
            facebook: 'Bring people from separate photos into one custom group portrait created as a digital keepsake. https://www.etsy.com/listing/4420886705/custom-photo-merge',
            pinterest: 'Custom group portrait idea: merge people from separate photos into one shared family keepsake. https://www.etsy.com/listing/4420886705/custom-photo-merge',
          },
          visual_brief: 'A vivid hero showing many separate photo prints flowing together into one realistic group portrait.',
          media_strategy: {
            format: 'single',
            target_media_count: 1,
            rationale: 'The revised hero explains the transformation immediately; the rejected guide frame is removed.',
            frames: [{
              id: 'generated-transform-hero',
              role: 'hero',
              source: 'generated_image',
              prompt: 'Vivid premium social hero: many distinct photo prints arc inward and transform into one cohesive realistic group portrait with many people, energetic composition, clean background, no guide text or process infographic.',
              reference_required: false,
              aspect_ratio: '4:5',
              rationale: 'This directly visualizes the owner-requested many-photos-to-one-group transformation.',
            }],
            platform_variants: {
              instagram: { format: 'single', frame_ids: ['generated-transform-hero'] },
              facebook: { format: 'single', frame_ids: ['generated-transform-hero'] },
              pinterest: { format: 'single', frame_ids: ['generated-transform-hero'] },
            },
          },
          evidence: ['listing description', 'owner revision'],
          unknowns: [],
          confidence: 0.97,
        }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token', host: 'manager.example.test' },
        query: {},
        body: {
          action: 'creativePlan',
          platforms: ['instagram', 'facebook', 'pinterest'],
          listing: {
            listing_id: '4420886705',
            title: 'Custom Photo Merge Service',
            description: 'We merge people from separate supplied photos into one custom digital group portrait.',
            url: 'https://www.etsy.com/listing/4420886705/custom-photo-merge',
            listing_campaign_fit: {
              decision: 'strong_fit',
              should_use_listing: true,
              confidence: 0.99,
              rationale: 'This is a revision of the current preview for the same listing.',
            },
            listing_understanding: {
              what_is_sold: 'A custom digital photo merge service.',
              buyer_use_case: 'A combined family portrait.',
              caption_body: 'Old caption that was already valid.',
              platform_captions: {
                instagram: 'Old Instagram caption that is long enough to pass the existing schema unchanged.',
                facebook: 'Old Facebook caption that is long enough to pass the existing schema unchanged.',
                pinterest: 'Old Pinterest caption that is long enough to pass the existing schema unchanged.',
              },
              media_strategy: {
                format: 'carousel',
                target_media_count: 2,
                frames: [
                  { id: 'old-hero', role: 'hero', source: 'generated_image', prompt: 'Old hero', reference_required: false, aspect_ratio: '4:5', rationale: 'Old hero rationale.' },
                  { id: 'old-guide', role: 'guide', source: 'generated_image', prompt: 'Old guide', reference_required: false, aspect_ratio: '4:5', rationale: 'Old guide rationale.' },
                ],
                platform_variants: {
                  instagram: { format: 'carousel', frame_ids: ['old-hero', 'old-guide'] },
                  facebook: { format: 'carousel', frame_ids: ['old-hero', 'old-guide'] },
                  pinterest: { format: 'carousel', frame_ids: ['old-hero', 'old-guide'] },
                },
              },
              confidence: 0.9,
            },
          },
          context: {
            owner_revision: ownerRevision,
            revision_of_preview_id: 'p3-20260718-ai-creative-plan-1784361928',
            previous_media_strategy: { frames: [{ id: 'old-hero' }, { id: 'old-guide' }] },
            require_ai_media_strategy: true,
          },
        },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({ success: true, action: 'creativePlan', saved: false, published: false });
      expect(analystCalls).toBe(1);
      expect(analystSystem).toContain('authoritative correction');
      expect(analystSystem).toContain('Pinterest');
      expect(analystSystem).toContain('semantic purpose');
      expect(analystPayload.campaign_context).toMatchObject({
        owner_revision: ownerRevision,
        revision_of_preview_id: 'p3-20260718-ai-creative-plan-1784361928',
        platforms: ['instagram', 'facebook', 'pinterest'],
      });
      const understanding = captured.payload.data.listing_understanding;
      expect(understanding.media_strategy.frames.map(frame => frame.id)).toEqual(['generated-transform-hero']);
      expect(understanding.media_strategy.platform_variants.pinterest).toMatchObject({
        format: 'single',
        frame_ids: ['generated-transform-hero'],
      });
      expect(understanding.platform_captions.pinterest).toContain('4420886705');
      expect(captured.payload.data.generated_frame_briefs[0]).toMatchObject({
        id: 'generated-transform-hero',
        reference_required: false,
      });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalAiEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('creativePlan lets AI finish a bounded generation round with fewer accepted frames and stable brief ids', async () => {
    const originalFetch = global.fetch;
    const originalAiEnv = {
      EXTERNAL_AI_BASE_URL: process.env.EXTERNAL_AI_BASE_URL,
      EXTERNAL_AI_API_KEY: process.env.EXTERNAL_AI_API_KEY,
      EXTERNAL_AI_MODEL: process.env.EXTERNAL_AI_MODEL,
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    };
    process.env.EXTERNAL_AI_BASE_URL = 'https://ai.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'test-ai-key';
    process.env.EXTERNAL_AI_MODEL = 'test-social-model';
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    const savedOwnerFeedbackMemory = {
      updated_at: '2026-07-23T10:00:00.000Z',
      items: [{
        id: 'owner-pref-1',
        scope: 'listing',
        listing_id: '4420886705',
        preferences: ['Do not use process-guide frames unless the owner explicitly asks for one.'],
        active: true,
      }],
    };
    let analystPayload = null;
    let analystSystem = '';
    let analystSchema = null;
    try {
      global.fetch = async (_url, options = {}) => {
        const url = new URL(String(_url));
        if (url.hostname === 'kv.example.test') {
          return new Response(JSON.stringify({
            result: encodeURIComponent(JSON.stringify(savedOwnerFeedbackMemory)),
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        const body = JSON.parse(options.body || '{}');
        analystSystem = String(body.messages?.[0]?.content || '');
        analystPayload = JSON.parse(String(body.messages?.[1]?.content || '{}'));
        analystSchema = body.tools?.[0]?.function?.parameters || null;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          what_is_sold: 'A custom digital service that merges separate supplied photos into one group portrait.',
          product_category: 'custom digital photo editing service',
          fulfillment: 'digital delivery',
          buyer_use_case: 'Creating one shared group portrait from separate family photos.',
          target_buyer: 'Families who do not have one complete group photo.',
          marketing_angle: 'Show many separate memories becoming one believable family portrait.',
          caption_body: 'Separate photos can become one shared family portrait that brings everyone into the same frame.',
          platform_captions: {
            instagram: 'Separate memories can become one shared family portrait that brings everyone into the same frame. #FamilyPortrait #PhotoMerge',
            facebook: 'Bring people from separate photos into one custom digital family portrait. https://www.etsy.com/listing/4420886705/custom-photo-merge',
            pinterest: 'Custom family portrait idea: merge people from separate photos into one shared keepsake. https://www.etsy.com/listing/4420886705/custom-photo-merge',
          },
          visual_brief: 'Use the two accepted generated frames; they already form a complete transformation and memorial story.',
          media_strategy: {
            format: 'carousel',
            target_media_count: 2,
            rationale: 'The accepted hero and memorial support frame form a complete story; the exhausted pet frame is not essential.',
            accepted_asset_decisions: [
              { brief_id: 'merge-hero', decision: 'reuse', rationale: 'The approved hero is the strongest transformation hook.' },
              { brief_id: 'memorial-support', decision: 'reuse', rationale: 'The approved support frame completes the emotional buyer story.' },
            ],
            frames: [
              { id: 'merge-hero', role: 'hero', source: 'generated_image', prompt: 'Accepted generated hero.', reference_required: false, aspect_ratio: '4:5', rationale: 'Shows many separate photos becoming one group portrait.' },
              { id: 'memorial-support', role: 'support', source: 'generated_image', prompt: 'Accepted generated memorial scene.', reference_required: false, aspect_ratio: '4:5', rationale: 'Shows the service\'s central emotional use case.' },
            ],
            platform_variants: {
              instagram: { format: 'carousel', frame_ids: ['merge-hero', 'memorial-support'] },
              facebook: { format: 'multi_image', frame_ids: ['merge-hero', 'memorial-support'] },
              pinterest: { format: 'single', frame_ids: ['merge-hero'] },
            },
          },
          evidence: ['owner revision', 'two accepted AI-QA assets', 'bounded pet-frame failure'],
          unknowns: [],
          confidence: 0.98,
        }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const generatedMedia = [
        {
          id: 'hero-asset',
          brief_id: 'merge-hero',
          source: 'generated_image',
          url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_aaaaaaaaaaaaaaaaaaaaaaaa',
          permanent: true,
          checksum_sha256: 'a'.repeat(64),
          quality_review: { approved: true, decision: 'approve', rationale: 'Clear, bright transformation hero.' },
        },
        {
          id: 'memorial-asset',
          brief_id: 'memorial-support',
          source: 'generated_image',
          url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_bbbbbbbbbbbbbbbbbbbbbbbb',
          permanent: true,
          checksum_sha256: 'b'.repeat(64),
          quality_review: { approved: true, decision: 'approve', rationale: 'Respectful memorial use case.' },
        },
      ];
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token', host: 'manager.example.test', 'x-forwarded-proto': 'https' },
        query: {},
        body: {
          action: 'creativePlan',
          platforms: ['instagram', 'facebook', 'pinterest'],
          listing: {
            listing_id: '4420886705',
            title: 'Custom Photo Merge Service',
            description: 'We merge people from separate supplied photos into one custom digital group portrait.',
            url: 'https://www.etsy.com/listing/4420886705/custom-photo-merge',
            listing_campaign_fit: { decision: 'strong_fit', should_use_listing: true, confidence: 0.99, rationale: 'Owner revision of this listing.' },
            listing_understanding: {
              what_is_sold: 'A custom digital photo merge service.',
              buyer_use_case: 'A combined family portrait.',
              caption_body: 'Existing valid caption.',
              platform_captions: {
                instagram: 'Existing Instagram caption that is long enough for the schema.',
                facebook: 'Existing Facebook caption that is long enough for the schema.',
                pinterest: 'Existing Pinterest caption that is long enough for the schema.',
              },
              media_strategy: {
                format: 'carousel',
                target_media_count: 3,
                frames: [
                  { id: 'merge-hero', role: 'hero', source: 'generated_image', prompt: 'Hero', reference_required: false, aspect_ratio: '4:5', rationale: 'Transformation hero.' },
                  { id: 'memorial-support', role: 'support', source: 'generated_image', prompt: 'Memorial', reference_required: false, aspect_ratio: '4:5', rationale: 'Memorial use case.' },
                  { id: 'pet-support', role: 'support', source: 'generated_image', prompt: 'Pet', reference_required: false, aspect_ratio: '4:5', rationale: 'Pet use case.' },
                ],
                platform_variants: {
                  instagram: { format: 'carousel', frame_ids: ['merge-hero', 'memorial-support', 'pet-support'] },
                  facebook: { format: 'multi_image', frame_ids: ['merge-hero', 'memorial-support', 'pet-support'] },
                  pinterest: { format: 'single', frame_ids: ['merge-hero'] },
                },
              },
              confidence: 0.95,
            },
          },
          context: {
            owner_revision: 'Keep the new bright hero, remove the guide, and include Pinterest.',
            required_revision_outcomes: ['Use a bright many-photos-to-one-group hero.', 'Include Pinterest.'],
            rejected_creative_functions: ['Guide or how-it-works frame.'],
            media_generation_resolution: {
              phase: 'post_generation_replan',
              generation_round: 2,
              generation_round_limit: 2,
              remaining_generation_rounds: 0,
              generation_budget_exhausted: true,
              failed_or_exhausted_briefs: [{ brief_id: 'pet-support', attempts: 2, outcome: 'transport_attempts_exhausted' }],
            },
            require_ai_media_strategy: true,
          },
          generated_media: generatedMedia,
        },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(analystSystem).toContain('bounded post-generation planning turn');
      expect(analystSystem).toContain('accepted_asset_decisions');
      expect(analystSystem).toContain('never put listing-image frame ids');
      expect(analystSystem).toContain('listing_image remains immutable supplied pixels');
      expect(analystSystem).toContain('no additional generated-image execution is available');
      const acceptedDecisionSchema = analystSchema?.properties?.media_strategy?.properties?.accepted_asset_decisions;
      expect(analystSchema?.properties?.media_strategy?.required).toContain('accepted_asset_decisions');
      expect(acceptedDecisionSchema).toMatchObject({ minItems: 2, maxItems: 2 });
      expect(acceptedDecisionSchema?.items?.properties?.brief_id?.enum).toEqual(['merge-hero', 'memorial-support']);
      expect(acceptedDecisionSchema?.items?.properties?.brief_id?.enum).not.toContain('listing_media_rank_1');
      expect(analystPayload.campaign_context.media_generation_resolution).toMatchObject({
        phase: 'post_generation_replan',
        generation_round_limit: 2,
        remaining_generation_rounds: 0,
        generation_budget_exhausted: true,
        failed_or_exhausted_briefs: [expect.objectContaining({ brief_id: 'pet-support', attempts: 2 })],
        accepted_assets: [
          expect.objectContaining({ brief_id: 'merge-hero', quality_approved: true }),
          expect.objectContaining({ brief_id: 'memorial-support', quality_approved: true }),
        ],
      });
      expect(analystPayload.campaign_context.owner_feedback_memory).toMatchObject({
        items: [expect.objectContaining({
          id: 'owner-pref-1',
          listing_id: '4420886705',
        })],
      });
      const plan = captured.payload.data;
      expect(plan.status).toBe('ready_for_review');
      expect(plan.media_strategy.frames.map(frame => frame.id)).toEqual(['merge-hero', 'memorial-support']);
      expect(plan.media_strategy.accepted_asset_decisions).toEqual([
        expect.objectContaining({ brief_id: 'merge-hero', decision: 'reuse' }),
        expect.objectContaining({ brief_id: 'memorial-support', decision: 'reuse' }),
      ]);
      expect(plan.storyboard.map(frame => frame.media?.id)).toEqual(['hero-asset', 'memorial-asset']);
      expect(plan.variants.find(variant => variant.platform === 'instagram')).toMatchObject({ readiness: 'media_ready', carousel: true });
      expect(plan.variants.find(variant => variant.platform === 'pinterest')).toMatchObject({ readiness: 'media_ready', carousel: false });
      expect(plan.storyboard.every(frame => frame.status === 'ready')).toBe(true);
      expect(plan.generated_frame_briefs.map(brief => brief.id)).toEqual(['merge-hero', 'memorial-support']);
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalAiEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('revisionPlan semantically binds natural Telegram feedback without publish approval', async () => {
    const originalFetch = global.fetch;
    const originalAiEnv = {
      EXTERNAL_AI_BASE_URL: process.env.EXTERNAL_AI_BASE_URL,
      EXTERNAL_AI_API_KEY: process.env.EXTERNAL_AI_API_KEY,
      EXTERNAL_AI_MODEL: process.env.EXTERNAL_AI_MODEL,
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    };
    process.env.EXTERNAL_AI_BASE_URL = 'https://ai.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'test-ai-key';
    process.env.EXTERNAL_AI_MODEL = 'test-social-model';
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    const savedOwnerFeedbackMemory = {
      updated_at: '2026-07-23T10:00:00.000Z',
      items: [{
        id: 'owner-pref-1',
        scope: 'listing',
        listing_id: '4420886705',
        preferences: ['Do not use process-guide frames unless the owner explicitly asks for one.'],
        active: true,
      }],
    };
    const ownerFeedback = 'Зроби яскравішу заглавну фотку з багатьма окремими фото, які стають одним груповим портретом; guide прибери, і чому немає Pinterest?';
    let aiPayload = null;
    let aiSystem = '';
    let aiSchema = null;
    try {
      global.fetch = async (_url, options = {}) => {
        const url = new URL(String(_url));
        if (url.hostname === 'kv.example.test') {
          return new Response(JSON.stringify({
            result: encodeURIComponent(JSON.stringify(savedOwnerFeedbackMemory)),
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        const body = JSON.parse(options.body || '{}');
        aiSystem = String(body.messages?.[0]?.content || '');
        aiPayload = JSON.parse(String(body.messages?.[1]?.content || '{}'));
        aiSchema = body.tools?.[0]?.function?.parameters || null;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          intent: 'revision',
          rationale: 'The owner requested material changes to the current creative and questioned platform coverage.',
          revision_brief: 'Generate a vivid hero showing separate photo cards becoming one group portrait, remove the guide frame, and re-evaluate Pinterest coverage.',
          affected_areas: ['hero', 'frame set', 'platform coverage'],
          platform_questions: ['Pinterest'],
          required_revision_outcomes: ['A vivid generated hero must show separate photo cards becoming one group portrait.', 'Pinterest must be reconsidered.'],
          rejected_creative_functions: ['Guide or how-it-works explanation frame.'],
          required_platforms: ['pinterest'],
          new_request_kind: '',
          requested_platforms: [],
          requested_format: '',
          schedule_text: '',
          future_preference_scope: 'listing',
          future_creative_preferences: ['Do not use process-guide frames for this listing unless the owner explicitly asks for one.'],
          publish_authorized: false,
        }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'revisionPlan',
          owner_feedback: ownerFeedback,
          current_preview: {
            id: 'p3-20260718-ai-creative-plan-1784361928',
            listing_id: '4420886705',
            platform: 'all',
            frames: [{ id: 'hero' }, { id: 'guide' }],
          },
        },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        action: 'revisionPlan',
        saved: false,
        scheduled: false,
        published: false,
        data: {
          intent: 'revision',
          publish_authorized: false,
          affected_areas: ['hero', 'frame set', 'platform coverage'],
          platform_questions: ['Pinterest'],
          required_revision_outcomes: ['A vivid generated hero must show separate photo cards becoming one group portrait.', 'Pinterest must be reconsidered.'],
          rejected_creative_functions: ['Guide or how-it-works explanation frame.'],
          required_platforms: ['pinterest'],
          future_preference_scope: 'listing',
          future_creative_preferences: ['Do not use process-guide frames for this listing unless the owner explicitly asks for one.'],
        },
      });
      expect(aiSystem).toContain('Do not use keyword rules');
      expect(aiSystem).toContain('A negated action such as "do not schedule"');
      expect(aiSystem).toContain('"this idea is not needed"');
      expect(aiSystem).toContain('"таке не треба"');
      expect(aiSystem).toContain('Do not invent a revision goal');
      expect(aiSystem).toContain('MUST be intent=cancel');
      expect(aiSchema.properties.intent.description).toContain('whole current preview');
      expect(aiSchema.properties.revision_brief.description).toContain('Must be empty for cancel');
      expect(aiPayload).toMatchObject({
        owner_feedback: ownerFeedback,
        current_preview: {
          id: 'p3-20260718-ai-creative-plan-1784361928',
          listing_id: '4420886705',
          owner_feedback_memory: {
            items: [expect.objectContaining({
              id: 'owner-pref-1',
              listing_id: '4420886705',
            })],
          },
        },
      });
      expect(aiSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining(['intent', 'revision_brief', 'required_revision_outcomes', 'future_preference_scope', 'future_creative_preferences', 'publish_authorized']),
        properties: {
          intent: { type: 'string', enum: ['revision', 'status', 'approve', 'schedule', 'cancel', 'question', 'new_request', 'other'] },
          future_preference_scope: { type: 'string', enum: ['none', 'listing', 'shop'] },
          publish_authorized: { type: 'boolean', enum: [false] },
        },
      });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalAiEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('recordOwnerFeedback persists AI-classified listing creative preferences without publishing', async () => {
    const originalFetch = global.fetch;
    const originalKvEnv = {
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    };
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    let storedMemory = null;
    global.fetch = async url => {
      const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      if (command === 'GET') {
        return new Response(JSON.stringify({ result: storedMemory ? encodeURIComponent(JSON.stringify(storedMemory)) : null }), { status: 200 });
      }
      if (command === 'SET') {
        storedMemory = JSON.parse(decodeURIComponent(parts[2]));
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      throw new Error(`Unexpected KV command: ${command}`);
    };
    try {
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token' },
        query: {},
        body: {
          action: 'recordOwnerFeedback',
          owner_feedback: 'Do not put operational submission requirements on the social hero.',
          current_preview: {
            id: 'current-owner-review',
            listing_id: '4316038646',
          },
          revision_plan: {
            intent: 'revision',
            rationale: 'This is a reusable listing-specific presentation preference.',
            future_preference_scope: 'listing',
            future_creative_preferences: [
              'Keep operational submission requirements out of buyer-facing social hero graphics for this listing.',
            ],
          },
        },
      }, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.payload).toMatchObject({
        success: true,
        action: 'recordOwnerFeedback',
        saved: true,
        scheduled: false,
        published: false,
        data: {
          stored: true,
          item: {
            scope: 'listing',
            listing_id: '4316038646',
            preferences: [
              'Keep operational submission requirements out of buyer-facing social hero graphics for this listing.',
            ],
          },
        },
      });
      expect(storedMemory.items).toHaveLength(1);
      expect(storedMemory.items[0]).toMatchObject({
        scope: 'listing',
        listing_id: '4316038646',
        active: true,
      });
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalKvEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('creativePlan gives AI a second schema repair turn with caption critic feedback', async () => {
    const originalFetch = global.fetch;
    const originalAiEnv = {
      EXTERNAL_AI_BASE_URL: process.env.EXTERNAL_AI_BASE_URL,
      EXTERNAL_AI_API_KEY: process.env.EXTERNAL_AI_API_KEY,
      EXTERNAL_AI_MODEL: process.env.EXTERNAL_AI_MODEL,
    };
    process.env.EXTERNAL_AI_BASE_URL = 'https://ai.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'test-ai-key';
    process.env.EXTERNAL_AI_MODEL = 'test-social-model';
    const rejectedCaption = 'This generic caption does not explain the custom wedding photo service clearly enough.';
    const finalCaption = 'Bring separate family photos together in one wedding keepsake, with each supplied person placed into a natural-looking custom composition. #WeddingKeepsake #PhotoEditing';
    let analystCalls = 0;
    let repairCalls = 0;
    let criticCalls = 0;
    let criticRepairCalls = 0;
    let secondRepairPayload = null;
    let repairSystem = '';
    try {
      global.fetch = async (url, options = {}) => {
        const body = JSON.parse(options.body || '{}');
        const system = String(body.messages?.[0]?.content || '');
        if (system.includes('Etsy social marketing analyst')) {
          analystCalls += 1;
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            what_is_sold: 'A custom digital wedding photo composition service.',
            buyer_use_case: 'Adding a supplied loved one to a wedding keepsake.',
            target_buyer: 'Families preserving a wedding memory.',
            marketing_angle: 'Show the care behind a believable custom composition.',
            caption_body: rejectedCaption,
            platform_captions: { instagram: rejectedCaption },
            visual_brief: 'Show the actual custom composition service truthfully.',
            confidence: 0.92,
          }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (system.includes('repair an Etsy listing understanding')) {
          repairCalls += 1;
          repairSystem = system;
          const payload = JSON.parse(String(body.messages?.[1]?.content || '{}'));
          if (repairCalls === 2) secondRepairPayload = payload;
          const content = repairCalls === 1
            ? {
                what_is_sold: 'A custom digital wedding photo composition service.',
                buyer_use_case: 'Adding a supplied loved one to a wedding keepsake.',
                target_buyer: 'Families preserving a wedding memory.',
                marketing_angle: 'Show the care behind a believable custom composition.',
                caption_body: rejectedCaption,
                platform_captions: { instagram: rejectedCaption },
                visual_brief: 'Show the actual custom composition service truthfully.',
                confidence: 0.92,
              }
            : {
                what_is_sold: 'A custom digital wedding photo composition service.',
                buyer_use_case: 'Adding a supplied loved one to a wedding keepsake.',
                target_buyer: 'Families preserving a wedding memory.',
                marketing_angle: 'Show the care behind a believable custom composition.',
                caption_body: finalCaption,
                platform_captions: { instagram: finalCaption },
                visual_brief: 'Use the supplied finished example as evidence of the custom composition service.',
                media_strategy: {
                  format: 'single',
                  target_media_count: 1,
                  listing_media_decisions: [{
                    rank: 1,
                    decision: 'use_exact',
                    social_role: 'finished result evidence',
                    rationale: 'The exact Etsy image clearly demonstrates the finished custom composition.',
                  }],
                  campaign_offer_focus: 'Custom digital wedding photo composition from supplied family photos.',
                  lead_proof_plan: 'Lead with the exact finished wedding composition so the completed buyer result is immediately visible.',
                  required_visible_evidence: 'A clear finished wedding-photo composition.',
                  frame_count_rationale: 'One exact finished-result frame communicates this specific service completely; another frame would repeat the same evidence.',
                  rationale: 'One strong finished example explains the service without filler.',
                  frames: [{
                    id: 'finished-example',
                    role: 'service result evidence',
                    source: 'listing_image',
                    reference_media_rank: 1,
                    communication_goal: 'Make the finished wedding composition immediately understandable.',
                    visible_buyer_evidence: 'The completed custom wedding composition is visible as the dominant result.',
                    evidence_strength: 'primary',
                    rationale: 'The supplied finished example shows the actual custom composition result.',
                  }],
                  platform_variants: { instagram: { format: 'single', frame_ids: ['finished-example'], buyer_evidence_frame_ids: ['finished-example'] } },
                },
                confidence: 0.95,
              };
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (system.includes('repair an independent Etsy social caption critic')) {
          criticRepairCalls += 1;
          const payload = JSON.parse(String(body.messages?.[1]?.content || '{}'));
          const caption = payload.critic_payload.platform_captions.instagram;
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            platform_caption_reviews: {
              instagram: {
                approved: false,
                decision: 'revise',
                reviewed_caption: caption,
                rationale: 'The caption is generic and does not explain the actual service.',
                factual_grounding: 'Too vague to establish grounding.',
                platform_fit: 'Needs a clearer buyer-facing hook.',
                risks: ['generic template language'],
              },
            },
          }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (system.includes('independent quality critic')) {
          criticCalls += 1;
          const payload = JSON.parse(String(body.messages?.[1]?.content || '{}'));
          const caption = payload.platform_captions.instagram;
          const approved = caption === finalCaption;
          if (criticCalls === 1) {
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
              platform_caption_reviews: [{
                platform: 'instagram',
                approved: false,
                decision: 'revise',
                reviewed_caption: caption,
                rationale: 'Malformed array response that requires an AI schema repair.',
              }],
            }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            platform_caption_reviews: {
              instagram: {
                approved,
                decision: approved ? 'approve' : 'revise',
                reviewed_caption: caption,
                rationale: approved ? 'Specific, grounded, and suitable for Instagram.' : 'The caption is generic and does not explain the actual service.',
                factual_grounding: approved ? 'Grounded in the supplied custom-service facts.' : 'Too vague to establish grounding.',
                platform_fit: approved ? 'Concise visual-first copy.' : 'Needs a clearer buyer-facing hook.',
                risks: approved ? [] : ['generic template language'],
              },
            },
          }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`Unexpected AI call: ${system.slice(0, 80)}`);
      };
      const { res, captured } = mockResponse();
      await socialHandler({
        method: 'POST',
        headers: { authorization: 'Bearer bridge-token', host: 'manager.example.test' },
        query: {},
        body: {
          action: 'creativePlan',
          platforms: ['instagram'],
          listing: {
            listing_id: 'wedding-merge-42',
            title: 'Custom Wedding Photo Merge',
            description: 'We merge supplied family photos into one custom digital wedding composition.',
            url: 'https://www.etsy.com/listing/wedding-merge-42',
            media_items: [{ url: 'https://img.example.test/wedding-merge.jpg', width: 1600, height: 2000, rank: 1 }],
            listing_understanding: {
              what_is_sold: 'A custom digital wedding photo composition service.',
              buyer_use_case: 'A family wedding keepsake.',
              marketing_angle: 'A believable combined wedding memory.',
              caption_body: rejectedCaption,
              confidence: 0.9,
            },
            listing_campaign_fit: {
              decision: 'strong_fit',
              should_use_listing: true,
              confidence: 0.96,
              rationale: 'The shop opportunity directly concerns this custom service.',
            },
          },
          context: {
            social_factory_path: true,
            factory_path: 'social_autonomous_content_factory',
            require_ai_media_strategy: true,
            require_ai_caption_quality_review: true,
          },
          visual_analysis: {
            available: true,
            provider: 'unit-vision',
            images: [{
              rank: 1,
              url: 'https://img.example.test/wedding-merge.jpg',
              social_use_decision: 'hero',
              quality_score: 0.94,
              concept_relevance_score: 0.95,
              rationale: 'The finished composition clearly demonstrates the service.',
            }],
          },
        },
      }, res);
      expect(captured.statusCode).toBe(200);
      expect(analystCalls).toBe(1);
      expect(repairCalls).toBe(2);
      expect(criticCalls).toBe(3);
      expect(criticRepairCalls).toBe(1);
      expect(repairSystem).toContain('explicitly AI-selected supported aspect_ratio');
      expect(secondRepairPayload.validation_errors).toEqual(expect.arrayContaining([
        expect.stringContaining('media_strategy.frames missing'),
        expect.stringContaining('platform_caption_reviews_not_approved'),
      ]));
      expect(secondRepairPayload).not.toHaveProperty('existing_listing_understanding');
      expect(secondRepairPayload).not.toHaveProperty('normalized_previous_response');
      expect(secondRepairPayload.campaign_context).not.toHaveProperty('listing_understanding');
      expect(repairSystem).toContain('Prefer natural disclosure in the platform caption');
      expect(repairSystem).toContain('rather than formal classification language');
      expect(repairSystem).toContain('Treat every selected frame as advertising');
      expect(repairSystem).toContain('Canvas-edge clipping is a blocking composition defect');
      expect(repairSystem).toContain('Different scenery, pose, crop, or styling does not create progression');
      expect(repairSystem).toContain('Do not spend on-image copy on formal asset labels');
      expect(secondRepairPayload.caption_review_feedback.instagram).toMatchObject({ approved: false, decision: 'revise' });
      expect(captured.payload.data.listing_understanding).toMatchObject({
        source: 'external_ai_repair_2',
        repair_used: true,
        repair_attempts: 2,
        platform_captions: { instagram: finalCaption },
        media_strategy: { format: 'single', target_media_count: 1 },
      });
      expect(captured.payload.data.status).not.toBe('blocked_ai_media_strategy_required');
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalAiEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('schedule rejects Instagram carousel duplicates instead of accepting first-image filler', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'schedule',
        id: 'duplicate-carousel-regression',
        approved: true,
        approved_by: 'owner-1',
        platform: 'instagram',
        listing_id: 'dupe-carousel',
        listing_title: 'Custom Family Portrait',
        caption: 'A custom portrait works when it makes separate photos feel like one clear family story.\n\nSave this idea for later, or visit the Etsy shop through the link in bio.\n\n#CustomPortrait #FamilyKeepsake #PhotoGift',
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        media_items: [
          { url: 'https://img.example.test/repeated.jpg', type: 'image', source: 'listing_image' },
          { url: 'https://img.example.test/repeated.jpg', type: 'image', source: 'listing_image' },
          { url: 'https://img.example.test/repeated.jpg', type: 'image', source: 'listing_image' },
        ],
        metadata: { instagram_carousel: true },
      },
    }, res);

    expect(captured.statusCode).toBe(400);
    expect(captured.payload).toMatchObject({ success: false, code: 'CAROUSEL_MEDIA_NOT_DISTINCT' });
  });

  test('schedule rejects generated media that is not persistent public mediaAsset', async () => {
    const { res, captured } = mockResponse();

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'schedule',
        id: 'temporary-generated-regression',
        approved: true,
        approved_by: 'owner-1',
        platform: 'instagram',
        listing_id: 'generated-temp',
        listing_title: 'Custom Family Portrait',
        caption: 'A custom portrait works when it makes separate photos feel like one clear family story.\n\nSave this idea for later, or visit the Etsy shop through the link in bio.\n\n#CustomPortrait #FamilyKeepsake #PhotoGift',
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        generated_image_url: 'https://provider.example.test/generated/temp.png',
        media_items: [{ url: 'https://provider.example.test/generated/temp.png', type: 'image', source: 'generated_image', permanent: false }],
      },
    }, res);

    expect(captured.statusCode).toBe(400);
    expect(captured.payload).toMatchObject({ success: false, code: 'GENERATED_MEDIA_NOT_PERMANENT' });
  });
});

test.describe('Quality-driven social creative planner', () => {
  const now = '2026-06-07T12:00:00.000Z';
  const listing = {
    listing_id: '77',
    title: 'Editable Graduation Invitation Template',
    url: 'https://www.etsy.com/listing/77/editable-graduation-invitation',
    media_items: [
      { id: 'input-first', url: 'https://img.example.test/low.jpg', width: 500, height: 280, rank: 1 },
      { id: 'portrait', url: 'https://img.example.test/portrait.jpg', width: 1600, height: 2000, rank: 6, alt: 'Editable graduation invitation shown in a clean portrait layout with gold details' },
      { id: 'square', url: 'https://img.example.test/square.jpg', width: 1500, height: 1500, rank: 2, alt: 'Close view of invitation typography and date fields' },
      { id: 'portrait-two', url: 'https://img.example.test/portrait-two.jpg', width: 1200, height: 1500, rank: 5, alt: 'Graduation party invitation customization detail' },
    ],
    listing_understanding: {
      available: true,
      source: 'unit_ai',
      what_is_sold: 'an editable digital graduation invitation template',
      buyer_use_case: 'preparing a personalized graduation celebration invitation',
      target_buyer: 'families planning a graduation celebration',
      marketing_angle: 'A polished invitation that makes graduation details easy to share.',
      caption_body: 'Celebrate the graduate with an editable invitation designed to make the event details clear and personal.',
      platform_captions: {
        instagram: 'Celebrate the graduate with an editable invitation that keeps every party detail clear and personal. #GraduationInvitation #EditableTemplate',
        facebook: 'Make the graduation details easy to share with an editable invitation built for a personal celebration. https://www.etsy.com/listing/77/editable-graduation-invitation',
        pinterest: 'Editable graduation invitation template for a polished personal celebration. https://www.etsy.com/listing/77/editable-graduation-invitation',
        tiktok: 'Editable graduation invitation inspiration for a personal celebration.',
      },
      media_strategy: {
        format: 'multi_image',
        target_media_count: 4,
        listing_media_policy: 'Use the four exact listing views selected by AI as truthful product evidence.',
        reference_policy: 'No generated frames are requested; listing image ranks identify every selected frame.',
        rationale: 'The exact listing gallery already explains the editable template clearly.',
        frames: [
          { id: 'base-rank-6', role: 'hero', source: 'listing_image', reference_media_rank: 6, rationale: 'Strong portrait product view.' },
          { id: 'base-rank-2', role: 'detail', source: 'listing_image', reference_media_rank: 2, rationale: 'Square typography detail.' },
          { id: 'base-rank-5', role: 'support', source: 'listing_image', reference_media_rank: 5, rationale: 'Customization support view.' },
          { id: 'base-rank-1', role: 'support', source: 'listing_image', reference_media_rank: 1, rationale: 'Additional exact listing evidence.' },
        ],
        platform_variants: {
          instagram: { format: 'carousel', frame_ids: ['base-rank-6', 'base-rank-2', 'base-rank-5', 'base-rank-1'] },
          facebook: { format: 'multi_image', frame_ids: ['base-rank-6', 'base-rank-2', 'base-rank-5', 'base-rank-1'] },
          pinterest: { format: 'single', frame_ids: ['base-rank-6'] },
          tiktok: { format: 'single', frame_ids: ['base-rank-6'] },
        },
      },
      confidence: 0.95,
    },
  };

  function aiListingMediaStrategy(platforms, ranks = [1]) {
    const frameIds = ranks.map(rank => `ai-listing-rank-${rank}`);
    const format = ranks.length > 1 ? 'multi_image' : 'single';
    return {
      format,
      target_media_count: ranks.length,
      listing_media_policy: 'AI selected these exact listing images as truthful campaign evidence.',
      reference_policy: 'No generated media or inferred support frame is requested.',
      rationale: 'The AI determined that the selected listing media can carry this campaign.',
      frames: ranks.map((rank, index) => ({
        id: frameIds[index],
        role: index === 0 ? 'hook' : 'support',
        source: 'listing_image',
        reference_media_rank: rank,
        rationale: `AI selected exact listing image rank ${rank}.`,
      })),
      platform_variants: Object.fromEntries(platforms.map(platform => [platform, {
        format: platform === 'pinterest' || ranks.length === 1
          ? 'single'
          : platform === 'instagram'
            ? 'carousel'
            : format,
        frame_ids: platform === 'pinterest' ? frameIds.slice(0, 1) : frameIds,
      }])),
    };
  }

  test('ranks all images by defensible signals rather than first-N and does not fake visual analysis', () => {
    const ranking = rankSocialListingMedia({ listing, now });
    expect(ranking.ranked).toHaveLength(4);
    expect(ranking.ranked[0].id).toBe('portrait');
    expect(ranking.ranked[0].source_rank).toBe(6);
    expect(ranking.confidence).toBe('metadata_only_low');
    expect(ranking.visual_analysis_used).toBe(false);
    expect(ranking.honesty_note).toContain('Pixels were not analyzed');
  });

  test('creative planner uses AI listing understanding instead of hard-coded title guesses', () => {
    const plan = planSocialCreativeCampaign({
      now,
      platforms: ['instagram', 'facebook'],
      providerConfigured: true,
      listing: {
        listing_id: 'ai-understood-manatee',
        title: 'Manatee Sublimation Design, Tropical T-Shirt PNG (Digital Download)',
        url: 'https://www.etsy.com/listing/ai-understood-manatee',
        media_items: [
          { id: 'hero', url: 'https://img.example.test/manatee-hero.jpg', width: 1600, height: 2000, rank: 1, alt: 'Manatee tropical t-shirt sublimation design mockup' },
          { id: 'detail', url: 'https://img.example.test/manatee-detail.jpg', width: 1400, height: 1400, rank: 2, alt: 'Close view of tropical manatee PNG design' },
          { id: 'use-case', url: 'https://img.example.test/manatee-shirt.jpg', width: 1600, height: 2000, rank: 3, alt: 'Beach shirt mockup with manatee design' },
        ],
      },
      context: {
        generated_hero_requested: true,
        listing_understanding: {
          available: true,
          source: 'unit_ai',
          what_is_sold: 'instant-download tropical manatee PNG for sublimation and shirts',
          product_category: 'digital design download',
          fulfillment: 'instant download',
          buyer_use_case: 'making beachy T-shirts, mugs, totes, stickers, and vacation gifts',
          target_buyer: 'DIY makers and small shops preparing summer products',
          marketing_angle: 'Beachy manatee design for summer craft products',
          caption_body: 'Use this design when a summer project needs a friendly tropical character: shirts, mugs, totes, and giftable beach-trip pieces can all start from the same digital artwork.',
          platform_captions: {
            instagram: 'Use this tropical manatee design when a summer project needs a friendly character for shirts, mugs, totes, or beach-trip gifts. #sublimationdesign #digitaldownload',
            facebook: 'A tropical manatee design can give summer shirts, mugs, totes, and beach-trip gifts one friendly visual theme. https://www.etsy.com/listing/ai-understood-manatee',
          },
          visual_brief: 'Show the manatee design as a faithful summer product mockup on a shirt or tote, with a clean beach craft-shop feel.',
          media_strategy: {
            format: 'single',
            target_media_count: 1,
            platform_variants: {
              instagram: { format: 'single', frame_ids: ['summer-product-mockup'] },
              facebook: { format: 'single', frame_ids: ['summer-product-mockup'] },
            },
            frames: [{
              id: 'summer-product-mockup',
              role: 'hook',
              source: 'generated_image',
              prompt: 'Create a faithful summer product mockup using the exact manatee design.',
              rationale: 'Shows the sold design in a concrete buyer use case.',
              reference_required: true,
              reference_media_rank: 1,
              reference_policy: 'Use rank 1 to preserve product identity exactly.',
              aspect_ratio: '4:5',
              crop_focus: 'north',
            }],
          },
          hashtags: ['#sublimationdesign', '#digitaldownload', '#tshirtdesign'],
          unsupported_claims_to_avoid: ['Do not say a physical shirt is shipped', 'Do not claim commercial license details unless supplied'],
          evidence: ['title says PNG', 'title says digital download'],
          confidence: 0.93,
        },
      },
    });

    expect(plan.listing_understanding).toMatchObject({ source: 'unit_ai', what_is_sold: /manatee PNG/ });
    expect(plan.concept.hook).toContain('Beachy manatee design');
    expect(plan.variants.find(v => v.platform === 'instagram').caption).toContain('summer project');
    expect(plan.variants.find(v => v.platform === 'instagram').caption).toContain('#sublimationdesign');
    expect(plan.variants.find(v => v.platform === 'instagram').caption).not.toMatch(/send the photo|custom photo edit|photo restoration|object removal/i);
    expect(plan.generated_frame_briefs[0]?.prompt || '').toContain('faithful summer product mockup');
    expect(plan.generated_frame_briefs[0]).toMatchObject({
      reference_image_url: 'https://img.example.test/manatee-hero.jpg',
      reference_policy: expect.stringContaining('preserve product identity'),
      crop_focus: 'north',
    });
    expect(plan.factual_safety_notes).toContain('AI listing understanding is advisory and must not override missing listing facts or owner approval.');
    expect(plan.provenance).toMatchObject({ listing_understanding_source: 'unit_ai', listing_understanding_confidence: 0.93 });
  });

  test('autonomous social planning follows AI media strategy instead of a fixed three-image template', () => {
    const completePrompt = `Lead with a clearly buyer-facing family-memory transformation. ${'Keep supporting visual detail grounded and concise. '.repeat(22)}FULL PLAYER INSIDE CANVAS WITH SAFE MARGINS.`;
    const sparseListing = {
      listing_id: 'ai-memory-video',
      title: 'Turn Old Photo into Video, Animate Your Old Photo, Memorable Gift',
      url: 'https://www.etsy.com/listing/ai-memory-video',
      media_items: [
        { id: 'only', url: 'https://img.example.test/memory-video-only.jpg', width: 1600, height: 2000, rank: 1, alt: 'Old family photo animation keepsake preview' },
      ],
      listing_understanding: {
        available: true,
        source: 'unit_ai',
        what_is_sold: 'custom service that turns an old family photo into a short animated keepsake video',
        buyer_use_case: 'sharing family memories during gatherings and preserving legacy moments',
        target_buyer: 'families who want a sentimental digital keepsake',
        marketing_angle: 'Bring old family photos to life for a meaningful memory-sharing moment',
        caption_body: 'Bring a cherished family photo back into the conversation with a short animated keepsake video made for sharing during a family gathering.',
        platform_captions: {
          instagram: 'Bring one treasured family memory back into the conversation as a short animated keepsake. #FamilyHistory #MemoryPreservation #CustomGift',
          facebook: 'A treasured family memory can become a short animated keepsake made for sharing.\n\nhttps://www.etsy.com/listing/ai-memory-video',
          pinterest: 'Animated family memory keepsake inspiration for preserving a treasured old photo. https://www.etsy.com/listing/ai-memory-video',
        },
        visual_brief: 'Create warm memory-preservation social frames around a family photo animation keepsake without showing fake reviews or before-after claims.',
        media_strategy: {
          format: 'single',
          target_media_count: 1,
          listing_media_policy: 'Do not use the listing image as the lead because a custom service result depends on the buyer photo.',
          reference_policy: 'No listing reference image needed; generated preview must stay conceptual and owner-reviewed.',
          platform_variants: {
            instagram: { format: 'single', frame_ids: ['service_concept_visual'] },
            facebook: { format: 'single', frame_ids: ['service_concept_visual'] },
            pinterest: { format: 'single', frame_ids: ['service_concept_visual'] },
          },
          frames: [{
            id: 'service_concept_visual',
            role: 'warm service concept visual',
            source: 'generated_image',
            image_model: 'antigravity/gemini-3.1-flash-image',
            prompt: completePrompt,
            reference_required: false,
            reference_policy: 'No listing reference image needed for this custom service concept.',
            aspect_ratio: '4:5',
            rationale: 'A single conceptual service visual is clearer than forcing listing-image evidence plus mockups.',
          }],
        },
        hashtags: ['#familyhistory', '#memorypreservation', '#customgift'],
        confidence: 0.94,
      },
    };
    const context = {
      social_factory_path: true,
      campaign_context: 'A holiday weekend is a natural time for families to gather and revisit old photos.',
    };

    const initial = planSocialCreativeCampaign({
      listing: sparseListing,
      context,
      now,
      providerConfigured: true,
      platforms: ['instagram', 'facebook', 'pinterest'],
      publicBaseUrl: 'https://manager.example.test',
    });

    expect(initial.status).toBe('needs_generation');
    expect(initial.generation_decision).toMatchObject({
      use_generation: true,
      status: 'briefs_required',
    });
    expect(initial.generated_frame_briefs.map(brief => brief.id)).toEqual(['service_concept_visual']);
    expect(initial.generated_frame_briefs[0]).toMatchObject({
      image_model: 'antigravity/gemini-3.1-flash-image',
      aspect_ratio: '4:5',
      reference_image_url: null,
      reference_policy: expect.stringContaining('No listing reference image needed'),
    });
    expect(initial.generated_frame_briefs[0].prompt.length).toBeGreaterThan(900);
    expect(initial.generated_frame_briefs[0].prompt).toContain('FULL PLAYER INSIDE CANVAS WITH SAFE MARGINS');
    expect(initial.variants.every(variant => variant.readiness === 'blocked_pending_generation')).toBe(true);

    const ready = planSocialCreativeCampaign({
      listing: sparseListing,
      context,
      now,
      providerConfigured: true,
      platforms: ['instagram', 'facebook', 'pinterest'],
      publicBaseUrl: 'https://manager.example.test',
      generatedMedia: [
        {
          id: 'hero-generated',
          brief_id: 'service_concept_visual',
          url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_aaaaaaaaaaaaaaaaaaaaaaaa',
          permanent: true,
          checksum_sha256: 'a'.repeat(64),
          quality_review: { decision: 'approve', approved: true },
        },
      ],
    });

    expect(ready.status).toBe('ready_for_review');
    expect(ready.storyboard).toHaveLength(1);
    expect(ready.storyboard.map(frame => frame.media?.source)).toEqual(['generated_image']);
    expect(ready.variants.every(variant => variant.readiness === 'media_ready' && variant.media_items.length === 1)).toBe(true);
    expect(ready.variants.find(variant => variant.platform === 'instagram')).toMatchObject({ carousel: false });
  });

  test('AI media strategy must choose a configured model and keep reference-required frames on a capable provider', async () => {
    const { aiMediaStrategyCapabilityProblemsForTest } = await import('../api/social.js');
    const context = {
      image_provider_capabilities: {
        reference_image_supported: true,
        available_models: [
          {
            provider_id: 'codex',
            model: 'codex/gpt-5.6-terra',
            reference_image_supported: true,
            reference_mode: 'provider_native',
          },
          {
            provider_id: 'antigravity',
            model: 'antigravity/gemini-3.1-flash-image',
            reference_image_supported: false,
            reference_mode: 'unsupported',
          },
        ],
      },
    };
    const baseFrame = {
      id: 'hero',
      role: 'hero',
      source: 'generated_image',
      prompt: 'Create a campaign hero.',
      reference_required: false,
      aspect_ratio: '3:4',
      rationale: 'Buyer-facing campaign lead.',
    };

    expect(aiMediaStrategyCapabilityProblemsForTest({ frames: [baseFrame] }, context))
      .toEqual(['hero: choose image_model from campaign_context.image_provider_capabilities.available_models']);
    expect(aiMediaStrategyCapabilityProblemsForTest({
      frames: [{ ...baseFrame, image_model: 'antigravity/gemini-3.1-flash-image' }],
    }, context)).toEqual([]);
    expect(aiMediaStrategyCapabilityProblemsForTest({
      frames: [{
        ...baseFrame,
        image_model: 'antigravity/gemini-3.1-flash-image',
        reference_required: true,
        reference_media_rank: 1,
      }],
    }, context)).toEqual([
      'hero: selected image model cannot preserve external reference pixels; choose a reference-capable model, the original listing_image, or a reference-free conceptual frame',
    ]);
    expect(aiMediaStrategyCapabilityProblemsForTest({
      frames: [{
        ...baseFrame,
        image_model: 'codex/gpt-5.6-terra',
        reference_required: true,
        reference_media_rank: 1,
      }],
    }, context)).toEqual([]);
  });

  test('AI owns platform-specific image count, ordering, format, and caption', () => {
    const listingUrl = 'https://www.etsy.com/listing/platform-specific-story';
    const media = [1, 2, 3, 4].map(rank => ({
      id: `source-${rank}`,
      url: `https://img.example.test/platform-${rank}.jpg`,
      width: 1600,
      height: 2000,
      rank,
      alt: `AI-inspected listing view ${rank}`,
    }));
    const listing = {
      listing_id: 'platform-specific-story',
      title: 'Custom Family Keepsake',
      url: listingUrl,
      media_items: media,
      listing_understanding: {
        available: true,
        source: 'unit_ai',
        what_is_sold: 'a custom digital family keepsake',
        buyer_use_case: 'bringing separate family memories into one personal gift',
        marketing_angle: 'show the finished keepsake and the details that make it personal',
        caption_body: 'A personal family keepsake can turn separate memories into one gift made for sharing.',
        platform_captions: {
          instagram: 'One family story, shown through the finished keepsake and its most personal details. #FamilyKeepsake #CustomGift',
          facebook: `A closer look at the finished keepsake, from the complete piece to the details that make it personal.\n\n${listingUrl}`,
          pinterest: `Custom family keepsake inspiration for a thoughtful personal gift. ${listingUrl}`,
        },
        platform_caption_reviews: {
          instagram: { approved: true, decision: 'approve', reviewed_caption: 'One family story, shown through the finished keepsake and its most personal details. #FamilyKeepsake #CustomGift', rationale: 'Specific and visual-first.' },
          facebook: { approved: true, decision: 'approve', reviewed_caption: `A closer look at the finished keepsake, from the complete piece to the details that make it personal.\n\n${listingUrl}`, rationale: 'Conversational and grounded.' },
          pinterest: { approved: true, decision: 'approve', reviewed_caption: `Custom family keepsake inspiration for a thoughtful personal gift. ${listingUrl}`, rationale: 'Concise and searchable.' },
        },
        media_strategy: {
          format: 'carousel',
          target_media_count: 4,
          frames: media.map((item, index) => ({
            id: `frame-${item.rank}`,
            role: index ? 'support' : 'hook',
            source: 'listing_image',
            reference_media_rank: item.rank,
            rationale: `The AI selected listing view ${item.rank} for this campaign.`,
          })),
          platform_variants: {
            instagram: { format: 'carousel', frame_ids: ['frame-2', 'frame-1', 'frame-4'] },
            facebook: { format: 'multi_image', frame_ids: ['frame-4', 'frame-2'] },
            pinterest: { format: 'single', frame_ids: ['frame-3'] },
          },
        },
        confidence: 0.95,
      },
    };

    const plan = planSocialCreativeCampaign({
      listing,
      context: { social_factory_path: true, campaign_context: 'Owner-review multi-platform campaign.' },
      platforms: ['instagram', 'facebook', 'pinterest'],
      providerConfigured: false,
      publicBaseUrl: 'https://manager.example.test',
      now,
    });

    expect(plan.status).toBe('ready_for_review');
    const byPlatform = Object.fromEntries(plan.variants.map(variant => [variant.platform, variant]));
    expect(byPlatform.instagram).toMatchObject({
      carousel: true,
      format: 'carousel',
      selected_frame_ids: ['frame-2', 'frame-1', 'frame-4'],
      caption: listing.listing_understanding.platform_captions.instagram,
      caption_quality_review: { approved: true, decision: 'approve' },
    });
    expect(byPlatform.instagram.media_items.map(item => item.url)).toEqual([
      media[1].url,
      media[0].url,
      media[3].url,
    ]);
    expect(byPlatform.facebook).toMatchObject({
      carousel: false,
      format: 'multi_image',
      selected_frame_ids: ['frame-4', 'frame-2'],
      caption: listing.listing_understanding.platform_captions.facebook,
    });
    expect(byPlatform.facebook.media_items.map(item => item.url)).toEqual([media[3].url, media[1].url]);
    expect(byPlatform.pinterest).toMatchObject({
      format: 'single',
      selected_frame_ids: ['frame-3'],
      caption: listing.listing_understanding.platform_captions.pinterest,
    });
    expect(byPlatform.pinterest.media_items.map(item => item.url)).toEqual([media[2].url]);
  });

  test('autonomous social planning blocks instead of inventing media strategy locally', () => {
    const plan = planSocialCreativeCampaign({
      listing: {
        listing_id: 'strategy-missing',
        title: 'Custom Photo Cleanup Service',
        url: 'https://www.etsy.com/listing/strategy-missing',
        media_items: [
          { id: 'only', url: 'https://img.example.test/photo-cleanup.jpg', width: 1600, height: 2000, rank: 1, alt: 'Photo cleanup service example' },
        ],
        listing_understanding: {
          available: true,
          source: 'unit_ai',
          what_is_sold: 'custom photo cleanup service',
          buyer_use_case: 'removing distractions from an important personal photo',
          marketing_angle: 'make a personal photo feel cleaner without over-editing',
          caption_body: 'A clean edit can keep the focus on the people and memory that matter.',
          visual_brief: 'Warm photo-editing service concept.',
          confidence: 0.91,
        },
      },
      context: {
        social_factory_path: true,
        campaign_context: 'Owner-review autonomous preview.',
      },
      now,
      providerConfigured: true,
      platforms: ['instagram', 'facebook'],
      publicBaseUrl: 'https://manager.example.test',
    });

    expect(plan.status).toBe('blocked_ai_media_strategy_required');
    expect(plan.storyboard).toEqual([]);
    expect(plan.variants).toEqual([]);
    expect(plan.generation_decision.rationale).toContain('will not use a hardcoded');
  });

  test('AI media strategy reference rank selects the intended listing image instead of the first image', () => {
    const plan = planSocialCreativeCampaign({
      listing: {
        listing_id: 'ranked-reference-design',
        title: 'Beach Vacation Shirt PNG',
        url: 'https://www.etsy.com/listing/ranked-reference-design',
        media_items: [
          { id: 'instructional', url: 'https://img.example.test/instructions.jpg', width: 1600, height: 2000, rank: 1, alt: 'Download instructions and file details' },
          { id: 'design', url: 'https://img.example.test/design-reference.jpg', width: 1600, height: 2000, rank: 2, alt: 'Actual beach vacation shirt PNG design artwork' },
        ],
        listing_understanding: {
          available: true,
          source: 'unit_ai',
          what_is_sold: 'beach vacation PNG design download',
          buyer_use_case: 'making vacation shirts and beach trip gifts',
          marketing_angle: 'show the actual design in a realistic finished-product context',
          caption_body: 'A ready design helps makers plan matching vacation projects before choosing the blank product.',
          platform_captions: {
            instagram: 'Plan a matching vacation project around the exact beach design shown in this faithful product mockup. #VacationDesign #DigitalDownload',
          },
          visual_brief: 'Create a faithful product mockup that preserves the supplied beach vacation PNG design.',
          media_strategy: {
            format: 'single',
            target_media_count: 1,
            reference_policy: 'Generated frame must preserve the actual design from listing media rank 2.',
            platform_variants: {
              instagram: { format: 'single', frame_ids: ['ranked_design_mockup'] },
            },
            frames: [{
              id: 'ranked_design_mockup',
              role: 'faithful product mockup',
              source: 'generated_image',
              prompt: 'Create one clean product mockup preserving the referenced beach vacation design.',
              reference_required: true,
              reference_policy: 'Use listing media rank 2 as the exact design reference.',
              reference_media_rank: 2,
              rationale: 'The first listing image is instructional; the second image contains the design that must be preserved.',
              aspect_ratio: '4:5',
            }],
          },
          confidence: 0.94,
        },
      },
      context: {
        social_factory_path: true,
        campaign_context: 'Owner-review autonomous preview.',
      },
      now,
      providerConfigured: true,
      platforms: ['instagram'],
      publicBaseUrl: 'https://manager.example.test',
    });

    expect(plan.status).toBe('needs_generation');
    expect(plan.generated_frame_briefs[0]).toMatchObject({
      id: 'ranked_design_mockup',
      reference_image_url: 'https://img.example.test/design-reference.jpg',
    });
  });

  test('AI media strategy can select a two-image Instagram carousel without local expansion to three', () => {
    const plan = planSocialCreativeCampaign({
      listing: {
        listing_id: 'two-frame-carousel',
        title: 'Custom Pet Portrait Service',
        url: 'https://www.etsy.com/listing/two-frame-carousel',
        media_items: [
          { id: 'example', url: 'https://img.example.test/pet-portrait-example.jpg', width: 1600, height: 2000, rank: 1, alt: 'Custom pet portrait example' },
        ],
        listing_understanding: {
          available: true,
          source: 'unit_ai',
          what_is_sold: 'a custom pet portrait service',
          buyer_use_case: 'creating a personal gift from a pet photo',
          marketing_angle: 'show one real style example and one conceptual ordering moment',
          caption_body: 'Turn a favorite pet photo into a personal portrait made for gifting or keeping.',
          platform_captions: {
            instagram: 'Turn a favorite pet photo into a personal portrait made for gifting or keeping. Swipe from the real style example to the ordering idea. #PetPortrait #CustomGift',
          },
          visual_brief: 'Warm, faithful custom pet portrait story.',
          media_strategy: {
            format: 'carousel',
            target_media_count: 2,
            rationale: 'Two frames tell the complete story; a third would be filler.',
            platform_variants: {
              instagram: { format: 'carousel', frame_ids: ['real_example', 'ordering_context'] },
            },
            frames: [
              {
                id: 'real_example',
                role: 'real style evidence',
                source: 'listing_image',
                reference_required: true,
                reference_media_rank: 1,
                rationale: 'Show the actual Etsy example.',
              },
              {
                id: 'ordering_context',
                role: 'ordering context',
                source: 'generated_image',
                prompt: 'Create a warm conceptual frame showing a pet owner selecting a favorite photo for a custom portrait, without a fake finished result.',
                reference_required: false,
                reference_policy: 'No listing reference is required because this frame explains the ordering moment rather than depicting the sold result.',
                aspect_ratio: '4:5',
                rationale: 'Explain the use case without copying or inventing a customer portrait.',
              },
            ],
          },
          confidence: 0.93,
        },
      },
      context: { social_factory_path: true, campaign_context: 'Owner review.' },
      now,
      providerConfigured: true,
      platforms: ['instagram'],
      publicBaseUrl: 'https://manager.example.test',
      generatedMedia: [{
        id: 'ordering-context-ready',
        brief_id: 'ordering_context',
        url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_cccccccccccccccccccccccc',
        permanent: true,
        checksum_sha256: 'c'.repeat(64),
        quality_review: { decision: 'approve', approved: true },
      }],
    });

    expect(plan.status).toBe('ready_for_review');
    expect(plan.storyboard).toHaveLength(2);
    expect(plan.variants[0]).toMatchObject({
      platform: 'instagram',
      carousel: true,
      carousel_minimum_distinct_media: 2,
      readiness: 'media_ready',
    });
  });

  test('candidate planner accepts an AI-selected two-image carousel as media ready', () => {
    const candidate = {
      listing_id: 'two-frame-candidate',
      title: 'Custom Pet Portrait Service',
      url: 'https://www.etsy.com/listing/two-frame-candidate',
      listing_campaign_fit: {
        decision: 'strong_fit',
        should_use_listing: true,
        confidence: 0.94,
        rationale: 'The owner-review campaign directly matches this custom portrait service.',
      },
      media_items: [
        { id: 'example', url: 'https://img.example.test/two-frame-example.jpg', width: 1600, height: 2000, rank: 1, alt: 'Actual portrait style example' },
      ],
      listing_understanding: {
        available: true,
        source: 'unit_ai',
        what_is_sold: 'a custom pet portrait service',
        buyer_use_case: 'creating a personal gift from a pet photo',
        marketing_angle: 'show one real style example and one conceptual ordering moment',
        caption_body: 'Turn a favorite pet photo into a personal portrait made for gifting or keeping.',
        platform_captions: {
          instagram: 'Turn a favorite pet photo into a personal portrait made for gifting or keeping. Swipe from a real style example to the ordering idea. #PetPortrait #CustomGift',
        },
        visual_brief: 'A concise two-frame custom portrait story.',
        media_strategy: {
          format: 'carousel',
          target_media_count: 2,
          rationale: 'Two frames tell the full story without filler.',
          platform_variants: {
            instagram: { format: 'carousel', frame_ids: ['real_example', 'ordering_context'] },
          },
          frames: [
            {
              id: 'real_example',
              role: 'real style evidence',
              source: 'listing_image',
              reference_required: true,
              reference_media_rank: 1,
              rationale: 'Show the actual Etsy example.',
            },
            {
              id: 'ordering_context',
              role: 'ordering context',
              source: 'generated_image',
              prompt: 'Show the buyer selecting a favorite pet photo for a custom portrait.',
              reference_required: false,
              reference_policy: 'No reference is required because this is an ordering-context frame, not a depiction of the sold result.',
              aspect_ratio: '4:5',
              rationale: 'Explain the ordering use case without inventing a finished customer portrait.',
            },
          ],
        },
        confidence: 0.93,
      },
    };

    const plan = planSocialCreativeCampaignForCandidates({
      listingCandidates: [candidate],
      context: { social_factory_path: true, campaign_context: 'Owner review.' },
      now,
      providerConfigured: true,
      platforms: ['instagram'],
      publicBaseUrl: 'https://manager.example.test',
      generatedMedia: [{
        id: 'ordering-context-ready',
        brief_id: 'ordering_context',
        url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia_dddddddddddddddddddddddd',
        permanent: true,
        checksum_sha256: 'd'.repeat(64),
        quality_review: { decision: 'approve', approved: true },
      }],
    });

    expect(plan.status).toBe('ready_for_review');
    expect(plan.candidate_selection).toMatchObject({
      mode: 'scanned_listing_candidates',
      selected_listing_id: 'two-frame-candidate',
    });
    expect(plan.variants[0]).toMatchObject({ carousel: true, readiness: 'media_ready' });
    expect(plan.variants[0].media_items).toHaveLength(2);
  });

  test('creative planner does not rewrite AI caption bodies with title-overlap regexes', () => {
    const plan = planSocialCreativeCampaign({
      now,
      platforms: ['instagram', 'facebook', 'pinterest'],
      providerConfigured: true,
      listing: {
        listing_id: 'panama-title-spam',
        title: 'Panama City Beach 2026 Png, Family Matching Shirt File, Vacation 2026 Print, Sublimation Transfer, Ready to Press, Summer Travel Graphic',
        url: 'https://www.etsy.com/listing/panama-title-spam',
        media_items: [
          { id: 'hero', url: 'https://img.example.test/panama-hero.jpg', width: 1600, height: 2000, rank: 1, alt: 'Panama City Beach family vacation design preview' },
          { id: 'mockup', url: 'https://img.example.test/panama-shirt.jpg', width: 1600, height: 1600, rank: 2, alt: 'Matching vacation shirt mockup' },
          { id: 'detail', url: 'https://img.example.test/panama-detail.jpg', width: 1400, height: 1800, rank: 3, alt: 'Beach trip design detail' },
        ],
      },
      context: {
        listing_understanding: {
          available: true,
          source: 'unit_ai',
          what_is_sold: 'digital beach-trip artwork for matching vacation shirt projects',
          product_category: 'digital design download',
          fulfillment: 'digital download',
          buyer_use_case: 'planning coordinated Panama City Beach shirts, mugs, totes, and small-shop summer travel products',
          target_buyer: 'DIY makers preparing family vacation projects',
          marketing_angle: 'Matching beach-trip design for maker projects',
          caption_body: 'Planning a matching project for the trip? This Panama City Beach 2026 Png, Family Matching Shirt File, Vacation 2026 Print, Sublimation Transfer, Ready to Press, Su... PNG is made for makers who want the design ready before the blank product is picked.',
          platform_captions: {
            instagram: 'Planning a matching project for the trip? This Panama City Beach 2026 Png, Family Matching Shirt File, Vacation 2026 Print, Sublimation Transfer, Ready to Press, Su... PNG is made for makers who want the design ready before the blank product is picked.',
            facebook: 'Planning a matching project for the trip? This Panama City Beach 2026 Png, Family Matching Shirt File, Vacation 2026 Print, Sublimation Transfer, Ready to Press, Su... PNG is made for makers. https://www.etsy.com/listing/panama-title-spam',
            pinterest: 'Panama City Beach matching-trip design for maker projects. https://www.etsy.com/listing/panama-title-spam',
          },
          visual_brief: 'Use the supplied design faithfully in realistic beach-trip product mockups.',
          media_strategy: aiListingMediaStrategy(['instagram', 'facebook', 'pinterest'], [1, 2, 3]),
          hashtags: ['#VacationShirts', '#SublimationDesign', '#DigitalDownload'],
          confidence: 0.91,
        },
      },
    });

    const captions = plan.variants.map(variant => variant.caption).join('\n\n');
    expect(captions).toMatch(/This Panama City Beach 2026 Png, Family Matching Shirt File/i);
    expect(captions).toMatch(/Ready to Press, Su\.\.\./i);
    expect(plan.variants.find(variant => variant.platform === 'facebook').caption).toContain('https://www.etsy.com/listing/panama-title-spam');
  });

  test('creative planner leaves semantic product interpretation to AI instead of word matching', () => {
    const plan = planSocialCreativeCampaign({
      now,
      platforms: ['instagram', 'facebook'],
      providerConfigured: true,
      listing: {
        listing_id: 'punta-design-file',
        title: 'Punta Cana 2026 Png, Family trip 2026, Sublimation Transfer, Ready to Press, Summer Travel Graphic',
        url: 'https://www.etsy.com/listing/punta-design-file',
        media_items: [
          { id: 'hero', url: 'https://img.example.test/punta-hero.jpg', width: 1600, height: 2000, rank: 1, alt: 'Punta Cana family trip shirt design preview' },
          { id: 'shirt', url: 'https://img.example.test/punta-shirt.jpg', width: 1600, height: 1600, rank: 2, alt: 'Matching vacation shirt mockup' },
          { id: 'detail', url: 'https://img.example.test/punta-detail.jpg', width: 1400, height: 1800, rank: 3, alt: 'Vacation design detail' },
        ],
      },
      context: {
        listing_understanding: {
          available: true,
          source: 'unit_ai',
          what_is_sold: 'digital vacation graphic file for sublimation and matching shirt projects',
          product_category: 'digital design download',
          fulfillment: 'digital download',
          buyer_use_case: 'planning matching Punta Cana vacation shirts, mugs, totes, and small-shop summer travel products',
          target_buyer: 'DIY makers preparing family trip projects',
          marketing_angle: 'Elevate your family vacation photos with custom, matching outfits created at home.',
          caption_body: 'Make your 2026 Punta Cana getaway even more memorable in family vacation photos with custom matching outfits for the whole crew.',
          platform_captions: {
            instagram: 'Make your 2026 Punta Cana getaway even more memorable in family vacation photos with matching outfits created at home. #VacationShirts #DigitalDownload',
            facebook: 'Make your 2026 Punta Cana getaway more memorable in family vacation photos with matching outfits created at home. https://www.etsy.com/listing/punta-design-file',
          },
          visual_brief: 'Use the supplied design faithfully in realistic vacation product mockups.',
          media_strategy: aiListingMediaStrategy(['instagram', 'facebook'], [1, 2, 3]),
          hashtags: ['#VacationShirts', '#SublimationDesign', '#DigitalDownload'],
          confidence: 0.9,
        },
      },
    });

    const instagram = plan.variants.find(variant => variant.platform === 'instagram').caption;
    const facebook = plan.variants.find(variant => variant.platform === 'facebook').caption;
    expect(plan.concept.name).toMatch(/photos/i);
    expect(plan.concept.hook).toMatch(/photos/i);
    expect(instagram).toMatch(/photos/i);
    expect(facebook).toMatch(/photos/i);
    expect(facebook).toContain('https://www.etsy.com/listing/punta-design-file');
  });

  test('creative planner does not regex-rewrite AI planning copy after generation', () => {
    const plan = planSocialCreativeCampaign({
      now,
      platforms: ['instagram', 'facebook'],
      providerConfigured: true,
      listing: {
        listing_id: 'birthday-template',
        title: 'Custom Birthday template Canva Editable, Girls t-shirt Birthday print, PNG digital photo frame',
        url: 'https://www.etsy.com/listing/birthday-template',
        media_items: [
          { id: 'hero', url: 'https://img.example.test/birthday-hero.jpg', width: 1600, height: 1600, rank: 1, alt: 'Birthday shirt design preview' },
          { id: 'mockup', url: 'https://img.example.test/birthday-shirt.jpg', width: 1600, height: 1600, rank: 2, alt: 'Birthday shirt mockup' },
          { id: 'detail', url: 'https://img.example.test/birthday-detail.jpg', width: 1600, height: 1600, rank: 3, alt: 'Birthday design detail' },
        ],
      },
      context: {
        listing_understanding: {
          available: true,
          source: 'unit_ai',
          what_is_sold: 'editable digital birthday shirt template',
          product_category: 'digital design download',
          fulfillment: 'digital download',
          buyer_use_case: 'creating a colorful birthday shirt or party keepsake',
          target_buyer: 'parents and makers planning birthday projects',
          marketing_angle: 'The post should stay faithful to the listing facts and avoid unsupported claims.',
          caption_body: 'Use supplied listing facts only.',
          platform_captions: {
            instagram: 'The post should stay faithful to the supplied listing facts and avoid unsupported claims about this editable birthday design. #BirthdayShirt #DigitalDownload',
            facebook: 'Use the supplied listing facts only when presenting this editable birthday design, without unsupported product claims. https://www.etsy.com/listing/birthday-template',
          },
          visual_brief: 'Show the design in realistic birthday shirt and party mockups.',
          media_strategy: aiListingMediaStrategy(['instagram', 'facebook'], [1, 2, 3]),
          hashtags: ['#BirthdayShirt', '#DigitalDownload'],
          confidence: 0.88,
        },
      },
    });

    const captions = plan.variants.map(variant => variant.caption).join('\n');
    expect(captions).toMatch(/stay faithful|unsupported claims|supplied listing facts|the post should/i);
  });

  test('candidate creative planner keeps AI-understood single-image listings usable', () => {
    const plan = planSocialCreativeCampaignForCandidates({
      now,
      platforms: ['instagram', 'facebook'],
      providerConfigured: true,
      listingCandidates: [{
        listing_id: 'single-image-ai-listing',
        title: 'Manatee Sublimation Design, Tropical T-Shirt PNG (Digital Download)',
        url: 'https://www.etsy.com/listing/single-image-ai-listing',
        image_url: 'https://img.example.test/manatee-hero.jpg',
        listing_campaign_fit: {
          source: 'unit_ai',
          decision: 'acceptable_fit',
          should_use_listing: true,
          confidence: 0.91,
          rationale: 'The supplied campaign context naturally fits this AI-understood listing.',
        },
        listing_understanding: {
          available: true,
          source: 'unit_ai',
          what_is_sold: 'digital PNG design featuring a tropical manatee for sublimation and T-shirt projects',
          buyer_use_case: 'making manatee-themed shirts, mugs, totes, stickers, and summer craft products',
          marketing_angle: 'Tropical manatee PNG for beachy craft projects',
          caption_body: 'Use the design as a ready-made digital artwork for tropical T-shirt and sublimation projects without claiming a physical shirt is shipped.',
          platform_captions: {
            instagram: 'Use this ready-made digital artwork for tropical T-shirt and sublimation projects without implying that a physical shirt ships. #sublimationdesign #digitaldownload',
            facebook: 'Use this tropical manatee PNG as ready-made digital artwork for T-shirt and sublimation projects. https://www.etsy.com/listing/single-image-ai-listing',
          },
          visual_brief: 'Show the tropical manatee artwork as a faithful product mockup or clean digital design preview.',
          media_strategy: aiListingMediaStrategy(['instagram', 'facebook'], [1]),
          hashtags: ['#sublimationdesign', '#digitaldownload'],
          confidence: 0.9,
        },
      }],
      context: {
        generated_hero_requested: false,
      },
    });

    expect(plan.status).toBe('ready_for_review');
    expect(plan.candidate_selection.mode).toBe('scanned_listing_candidates');
    const instagram = plan.variants.find(variant => variant.platform === 'instagram');
    expect(instagram).toBeTruthy();
    expect(instagram.readiness).toBe('media_ready');
    expect(instagram.carousel).toBe(false);
    expect(instagram.media_items).toHaveLength(1);
    expect(instagram.caption).toContain('ready-made digital artwork');
    expect(instagram.caption).not.toMatch(/send the photo|custom photo edit|photo restoration|object removal/i);
    expect(plan.provenance).toMatchObject({ listing_understanding_source: 'unit_ai', listing_understanding_confidence: 0.9 });
  });

  test('opportunity discovery makes no calendar match and only applies operational cooldown exclusion', () => {
    const opportunities = suggestSocialContentOpportunities({
      now: '2026-06-17T12:00:00.000Z',
      windowDays: 21,
      platforms: ['instagram', 'facebook', 'all'],
      records: [{
        id: 'recent-post',
        status: 'scheduled',
        listing_id: 'cooldown-listing',
        scheduled_at: '2026-06-20T12:00:00.000Z',
      }],
      autonomousContext: {
        listings: [
          {
            listing_id: 'cooldown-listing',
            title: 'America 250 Family Portrait Already Queued',
            url: 'https://www.etsy.com/listing/cooldown-listing',
            tags: ['america 250', 'family roots'],
            media_items: [{ url: 'https://img.example.test/cooldown.jpg', width: 1600, height: 2000 }],
          },
          {
            listing_id: 'ready-america',
            title: 'Family Generations Portrait America 250 Anniversary Custom Picture',
            url: 'https://www.etsy.com/listing/ready-america',
            tags: ['america 250', 'immigrant roots', 'family portrait'],
            num_favorers: 80,
            media_items: [
              { url: 'https://img.example.test/ready-a.jpg', width: 1600, height: 2000 },
              { url: 'https://img.example.test/ready-b.jpg', width: 1600, height: 1600 },
              { url: 'https://img.example.test/ready-c.jpg', width: 1400, height: 1800 },
            ],
          },
          {
            listing_id: 'vacation-png',
            title: 'Panama City Beach 2026 Png, Family Matching Shirt File, Vacation 2026 Print, Sublimation Transfer',
            url: 'https://www.etsy.com/listing/vacation-png',
            tags: ['vacation shirt', 'png', 'sublimation', 'summer travel'],
            num_favorers: 120,
            views: 2500,
            recent_orders: 4,
            recent_revenue_usd: 12,
            media_items: [
              { url: 'https://img.example.test/vacation-a.jpg', width: 1600, height: 2000 },
              { url: 'https://img.example.test/vacation-b.jpg', width: 1600, height: 1600 },
              { url: 'https://img.example.test/vacation-c.jpg', width: 1400, height: 1800 },
            ],
          },
        ],
      },
    });

    expect(opportunities.status).toBe('ready');
    expect(opportunities).toMatchObject({
      external_research_used: false,
      research_owner: 'social_hermes',
      source_basis: 'stored_shop_context',
    });
    expect(opportunities.honesty_note).toContain('local code made no marketing match or product choice');
    const inventory = opportunities.opportunities.find(item => item.type === 'shop_facts_for_ai_review');
    expect(inventory).toBeTruthy();
    expect(inventory.moment).toBe('');
    expect(inventory.context).toMatchObject({ occasion: '', source_opportunity_type: 'shop_facts_for_ai_review' });
    expect(inventory.listing_candidates.map(item => item.listing_id)).toEqual(['ready-america', 'vacation-png']);
    expect(opportunities.operational_exclusions.cooldown_blocked_listings).toEqual([
      expect.objectContaining({ listing_id: 'cooldown-listing' }),
    ]);
    expect(inventory.guardrails.join(' ')).toContain('Read-only facts');
    expect(opportunities.recommended_next_action).toContain('creativePlan');
  });

  test('uses declared attributed visual analysis only when actually supplied', () => {
    const ranking = rankSocialListingMedia({
      listing,
      now,
      visualAnalysis: {
        available: true,
        provider: 'configured-vision-provider',
        images: [{ url: 'https://img.example.test/low.jpg', quality_score: 100, concept_relevance_score: 100, rationale: 'Clear validated concept fit' }],
      },
    });
    expect(ranking.visual_analysis_used).toBe(true);
    expect(ranking.confidence).toBe('visual_analysis_supported');
    expect(ranking.ranked.find(item => item.id === 'input-first').visual_analysis).toEqual({ used: true, provider: 'configured-vision-provider' });
  });

  test('enforces 21-day listing and concrete-media cooldown while allowing expired history', () => {
    const recent = buildSocialCreativeCooldownMemory([{
      listing_id: '77',
      scheduled_at: '2026-05-25T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/portrait.jpg' }],
    }], {}, now);
    const blocked = planSocialCreativeCampaign({ listing, now, cooldownMemory: recent, platforms: ['instagram'] });
    expect(blocked.status).toBe('blocked_listing_cooldown');
    expect(blocked.variants).toEqual([]);
    expect(blocked.cooldown.excluded_media_urls).toContain('https://img.example.test/portrait.jpg');

    const expired = buildSocialCreativeCooldownMemory([{
      listing_id: '77',
      scheduled_at: '2026-05-10T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/portrait.jpg' }],
    }], {}, now);
    const eligible = planSocialCreativeCampaign({ listing, now, cooldownMemory: expired, platforms: ['instagram'] });
    expect(eligible.status).not.toBe('blocked_listing_cooldown');
    expect(eligible.cooldown.listing_eligible).toBe(true);
  });

  test('future scheduled records reserve listing and media cooldown', () => {
    const futureRecord = {
      listing_id: '77',
      status: 'scheduled',
      scheduled_at: '2026-06-12T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/portrait.jpg' }],
    };
    const future = buildSocialCreativeCooldownMemory([futureRecord], {}, now);
    expect(future.listings.find(item => item.listing_id === '77')).toMatchObject({ used_at: '2026-06-12T12:00:00.000Z' });
    const plan = planSocialCreativeCampaign({ listing, now, cooldownMemory: {}, records: [futureRecord], platforms: ['instagram'] });
    expect(plan.status).toBe('blocked_listing_cooldown');
    expect(plan.cooldown.excluded_media_urls).toContain('https://img.example.test/portrait.jpg');
    expect(plan.variants).toEqual([]);
  });

  test('explicit revision can re-plan its own listing without disabling cooldown globally', () => {
    const futureRecord = {
      id: 'existing-campaign-instagram',
      campaign_id: 'campaign-existing',
      listing_id: '77',
      status: 'approved_scheduled',
      scheduled_at: '2026-06-12T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/portrait.jpg' }],
    };
    const revision = planSocialCreativeCampaign({
      listing,
      now,
      records: [futureRecord],
      platforms: ['instagram'],
      context: {
        revision_campaign_id: 'campaign-existing',
        revision_listing_id: '77',
      },
    });
    expect(revision.status).not.toBe('blocked_listing_cooldown');
    expect(revision.cooldown.listing_eligible).toBe(true);
    expect(revision.cooldown.excluded_media_urls).not.toContain('https://img.example.test/portrait.jpg');

    const unrelated = planSocialCreativeCampaign({
      listing,
      now,
      records: [futureRecord],
      platforms: ['instagram'],
      context: {
        revision_campaign_id: 'campaign-other',
        revision_listing_id: 'different-listing',
      },
    });
    expect(unrelated.status).toBe('blocked_listing_cooldown');
  });

  test('Hermes owner revision context bypasses cooldown only for its exact previous listing', () => {
    const futureRecord = {
      id: 'existing-owner-review',
      listing_id: '77',
      status: 'approved_scheduled',
      scheduled_at: '2026-06-12T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/portrait.jpg' }],
    };
    const revision = planSocialCreativeCampaign({
      listing,
      now,
      records: [futureRecord],
      platforms: ['instagram'],
      context: {
        revision_of_preview_id: 'existing-owner-review',
        previous_listing_id: '77',
      },
    });
    expect(revision.status).not.toBe('blocked_listing_cooldown');
    expect(revision.cooldown.listing_eligible).toBe(true);

    const mismatched = planSocialCreativeCampaign({
      listing,
      now,
      records: [futureRecord],
      platforms: ['instagram'],
      context: {
        revision_of_preview_id: 'existing-owner-review',
        previous_listing_id: 'different-listing',
      },
    });
    expect(mismatched.status).toBe('blocked_listing_cooldown');
  });

  test('stale overdue unapproved records do not block fresh queue creation', () => {
    const overdueRecord = {
      id: 'stale-overdue-unapproved',
      listing_id: '77',
      status: 'scheduled',
      scheduled_at: '2026-06-01T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/portrait.jpg' }],
      approved_for_publish: false,
    };
    const memory = buildSocialCreativeCooldownMemory([overdueRecord], {}, now);
    expect(memory.listings.find(item => item.listing_id === '77')).toBeUndefined();
    expect(memory.media.find(item => item.url === 'https://img.example.test/portrait.jpg')).toBeUndefined();

    const plan = planSocialCreativeCampaign({ listing, now, cooldownMemory: memory, records: [overdueRecord], platforms: ['instagram'] });
    expect(plan.status).toBe('ready_for_review');
    expect(plan.cooldown.listing_eligible).toBe(true);
    expect(plan.variants.some(variant => variant.readiness === 'media_ready')).toBe(true);
  });

  test('queued_external records do not count as published cooldown history', () => {
    const queuedExternalRecord = {
      id: 'accepted-webhook-no-confirmation',
      listing_id: '77',
      status: 'queued_external',
      queued_at: '2026-06-08T12:00:00.000Z',
      scheduled_at: '2026-06-08T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/portrait.jpg' }],
      publish_result: { published: false, queued: true, publish_status: 'queued_external' },
    };
    const memory = buildSocialCreativeCooldownMemory([queuedExternalRecord], {}, now);
    expect(memory.listings.find(item => item.listing_id === '77')).toBeUndefined();
    expect(memory.media.find(item => item.url === 'https://img.example.test/portrait.jpg')).toBeUndefined();

    const plan = planSocialCreativeCampaign({ listing, now, cooldownMemory: memory, records: [queuedExternalRecord], platforms: ['instagram'] });
    expect(plan.status).toBe('ready_for_review');
    expect(plan.cooldown.listing_eligible).toBe(true);
  });

  test('prunes orphaned future cooldown memory while preserving legitimate active scheduled records', () => {
    const staleMemory = buildSocialCreativeCooldownMemory([{
      id: 'future-factory-removed',
      listing_id: '77',
      scheduled_at: '2026-06-12T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/portrait.jpg' }],
    }], {}, now);
    const pruned = buildSocialCreativeCooldownMemory([], staleMemory, now);
    expect(pruned.listings.find(item => item.listing_id === '77')).toBeUndefined();
    expect(pruned.media.find(item => item.url === 'https://img.example.test/portrait.jpg')).toBeUndefined();

    const active = buildSocialCreativeCooldownMemory([{
      id: 'future-real-post',
      listing_id: '77',
      status: 'scheduled',
      scheduled_at: '2026-06-12T12:00:00.000Z',
      media_items: [{ url: 'https://img.example.test/portrait.jpg' }],
    }], staleMemory, now);
    expect(active.listings.find(item => item.listing_id === '77')).toMatchObject({ used_at: '2026-06-12T12:00:00.000Z' });
    expect(active.media.find(item => item.url === 'https://img.example.test/portrait.jpg')).toMatchObject({ used_at: '2026-06-12T12:00:00.000Z' });
  });

  test('requires persistent same-origin generated assets and builds campaign to platform variants', () => {
    const assetId = 'shmedia_1234567890abcdef12345678';
    expect(isPersistentSocialMediaUrl(`https://manager.example.test/api/social?action=mediaAsset&id=${assetId}`, 'https://manager.example.test')).toBe(true);
    expect(isPersistentSocialMediaUrl(`https://provider.example/tmp/${assetId}`, 'https://manager.example.test')).toBe(false);
    expect(isPersistentSocialMediaUrl(`https://evil.example/api/social?action=mediaAsset&id=${assetId}`, 'https://manager.example.test')).toBe(false);

    const plan = planSocialCreativeCampaign({
      listing,
      now,
      providerConfigured: true,
      context: {
        occasion: 'graduation',
        contextual_scene: true,
        media_strategy: {
          format: 'carousel',
          target_media_count: 5,
          frames: [
            { id: 'listing-lead', role: 'hook', source: 'listing_image', reference_media_rank: 1, rationale: 'Exact product evidence.' },
            { id: 'generated_hero', role: 'context', source: 'generated_image', prompt: 'Create a faithful graduation use-case scene.', reference_required: true, reference_media_rank: 1, reference_policy: 'Preserve the exact listing product.' },
            { id: 'listing-two', role: 'detail', source: 'listing_image', reference_media_rank: 6, rationale: 'Exact listing detail.' },
            { id: 'listing-three', role: 'detail', source: 'listing_image', reference_media_rank: 2, rationale: 'Exact listing detail.' },
            { id: 'listing-four', role: 'detail', source: 'listing_image', reference_media_rank: 5, rationale: 'Exact listing detail.' },
          ],
        },
      },
      platforms: ['instagram', 'facebook'],
      publicBaseUrl: 'https://manager.example.test',
      generatedMedia: [
        { id: assetId, brief_id: 'generated_hero', url: `https://manager.example.test/api/social?action=mediaAsset&id=${assetId}`, prompt: 'faithful hero', provider: 'external_ai', model: 'configured-at-runtime', permanent: true, checksum_sha256: 'a'.repeat(64) },
        { id: 'temporary', brief_id: 'generated_support', url: 'https://provider.example/tmp/image.png', provider: 'external_ai' },
      ],
    });

    expect(plan.generation_decision.use_generation).toBe(true);
    expect(plan.generated_media).toHaveLength(1);
    expect(plan.generated_media[0]).toMatchObject({ permanent: true, checksum_sha256: 'a'.repeat(64) });
    expect(plan.rejected_generated_media_count).toBe(1);
    expect(plan.storyboard).toHaveLength(5);
    expect(plan.storyboard[0]).toMatchObject({ order: 1, role: 'hook', status: 'ready', media: { source: 'listing_image' } });
    expect(plan.storyboard[0].rationale).toContain('Exact product evidence');
    expect(plan.storyboard[1]).toMatchObject({ order: 2, role: 'context', status: 'ready', media: { source: 'generated_image' } });
    expect(plan.carousel_storyboard[0]).toMatchObject({ order: 1, role: 'hook', source: 'listing_image' });
    expect(plan.storyboard.filter(frame => frame.media?.source === 'listing_image')).toHaveLength(4);
    expect(plan.variants).toHaveLength(2);
    expect(plan.variants.every(variant => variant.variant_of === plan.campaign_id)).toBe(true);
    expect(plan.variants.find(v => v.platform === 'facebook').caption).toContain(listing.url);
    expect(plan.variants.find(v => v.platform === 'instagram').caption).not.toContain(listing.url);
    expect(plan.provenance.ranking_signal_mode).toBe('metadata_only');
    expect(plan.provenance.generated_prompts[0].prompt).toContain('No prices, discounts, reviews');
  });

  test('creative planner rejects generated media missing checksum/permanent even on mediaAsset URL', () => {
    const assetId = 'shmedia_abcdefabcdefabcdefabcdef';
    const plan = planSocialCreativeCampaign({
      listing,
      now,
      providerConfigured: true,
      context: {
        contextual_scene: true,
        media_strategy: {
          format: 'single',
          target_media_count: 1,
          frames: [{ id: 'generated_hero', role: 'hook', source: 'generated_image', prompt: 'Create a faithful product hero.', reference_required: true, reference_media_rank: 1, reference_policy: 'Preserve the exact listing product.' }],
        },
      },
      platforms: ['instagram'],
      publicBaseUrl: 'https://manager.example.test',
      generatedMedia: [
        { id: assetId, brief_id: 'generated_hero', url: `https://manager.example.test/api/social?action=mediaAsset&id=${assetId}`, permanent: true },
      ],
    });

    expect(plan.generated_media).toEqual([]);
    expect(plan.rejected_generated_media_count).toBe(1);
    expect(plan.storyboard[0]).toMatchObject({ status: 'pending_generation', brief_id: 'generated_hero' });
    expect(plan.variants.every(variant => variant.readiness === 'blocked_pending_generation')).toBe(true);
  });

  test('social factory path blocks plain listing images from acting as the hero without vision analysis', () => {
    const plan = planSocialCreativeCampaign({
      listing: { ...listing, listing_understanding: null },
      now,
      providerConfigured: true,
      context: {
        social_factory_path: true,
        require_vision_for_social_hero: true,
        factory_path: 'social_autonomous_content_factory',
      },
      platforms: ['instagram', 'facebook'],
    });

    expect(plan.status).toBe('blocked_ai_listing_understanding_required');
    expect(plan.image_selection.visual_analysis_used).toBe(false);
    expect(plan.generation_decision).toMatchObject({
      use_generation: false,
      status: 'blocked_ai_listing_understanding_required',
    });
    expect(plan.storyboard).toEqual([]);
    expect(plan.variants).toEqual([]);
    expect(plan.generated_frame_briefs).toEqual([]);
  });

  test('autonomous factory fails closed when AI media strategy selects an uninspected listing gallery', () => {
    const plan = planSocialCreativeCampaign({
      listing,
      now,
      providerConfigured: true,
      context: {
        social_factory_path: true,
        require_vision_for_social_hero: true,
        factory_path: 'social_autonomous_content_factory',
      },
      platforms: ['instagram', 'facebook'],
    });

    expect(plan.status).toBe('blocked_ai_media_selection');
    expect(plan.image_selection.visual_analysis_used).toBe(false);
    expect(plan.media_strategy_selection_issues).toEqual(expect.arrayContaining([
      expect.stringContaining('was not approved by AI vision for this lead role'),
    ]));
    expect(plan.variants.every(variant => variant.readiness === 'blocked_ai_media_selection')).toBe(true);
  });

  test('creative planner does not infer a campaign moment from seasonal guidance fields', () => {
    const plan = planSocialCreativeCampaign({
      listing: { ...listing, listing_understanding: null },
      now,
      providerConfigured: false,
      context: {
        season: 'Father’s Day and early summer are strong moments for family-memory, graduation, vacation, and keepsake gifts.',
        seasonal_focus: 'Father’s Day',
      },
      platforms: ['instagram', 'facebook'],
    });

    expect(plan.concept.name).toBe('AI-required Etsy listing story');
    expect(plan.concept.occasion).toBeNull();
    expect(plan.concept.hook).toContain('needs AI understanding');
    expect(plan.concept.hook).not.toContain('strong moments for family-memory, graduation');
    expect(plan.concept.hook).not.toMatch(/thoughtful father.?s day gift planning idea/i);
    expect(plan.status).toBe('blocked_ai_media_strategy_required');
    expect(plan.variants).toEqual([]);
  });

  test('creative planner ignores broad unverified occasion prose instead of canonicalizing it locally', () => {
    const plan = planSocialCreativeCampaign({
      listing: { ...listing, listing_understanding: null },
      now,
      providerConfigured: true,
      context: {
        occasion: 'Father’s Day and early summer are strong moments for family-memory, graduation, vacation, and keepsake gifts.',
      },
      platforms: ['instagram', 'facebook'],
    });

    expect(plan.concept.name).toBe('AI-required Etsy listing story');
    expect(plan.concept.occasion).toBeNull();
    expect(plan.concept.hook).toContain('needs AI understanding');
    expect(plan.variants.map(variant => variant.caption).join('\n')).not.toMatch(/strong moments|family-memory, graduation|timely buyer moments|thoughtful father.?s day gift planning idea/i);
  });

  test('creative planner blocks captions instead of inventing copy when no AI opportunity was supplied', () => {
    const plan = planSocialCreativeCampaign({
      listing: { ...listing, listing_understanding: null },
      now,
      providerConfigured: true,
      context: {
        seasonal_focus: 'Father’s Day',
        listing_understanding: {
          ...listing.listing_understanding,
          platform_captions: {},
          media_strategy: aiListingMediaStrategy(['instagram', 'facebook'], [1]),
        },
      },
      platforms: ['instagram', 'facebook'],
    });

    const instagram = plan.variants.find(variant => variant.platform === 'instagram').caption;
    const facebook = plan.variants.find(variant => variant.platform === 'facebook').caption;
    expect(instagram).toBe('');
    expect(facebook).toBe('');
    expect(plan.status).toBe('blocked_ai_caption_required');
    expect(plan.variants.every(variant => variant.readiness === 'blocked_ai_caption_required')).toBe(true);
  });

  test('schedule honors an AI revise verdict instead of a local phrase blacklist', async () => {
    const { res, captured } = mockResponse();
    const originalEnv = {
      SOCIAL_HERMES_API_TOKEN: process.env.SOCIAL_HERMES_API_TOKEN,
      SOCIAL_HERMES_OWNER_TELEGRAM_ID: process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    process.env.SOCIAL_HERMES_API_TOKEN = 'bridge-token';
    process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID = 'owner-1';
    process.env.PUBLIC_BASE_URL = 'https://manager.example.test';

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'schedule',
        id: 'generic-fathers-day-hook-regression',
        approved: true,
        approved_by: 'owner-1',
        platform: 'facebook',
        listing_id: '4389878231',
        listing_title: 'Photo Restoration and Colorization Service',
        caption: 'A thoughtful father’s day gift planning idea that feels personal, not generic.\n\nThis is visible queue copy.\n\nSee the listing here:\nhttps://www.etsy.com/listing/4389878231/old-photo-restoration-colorization',
        metadata: {
          ai_caption_quality_review_required: true,
          ai_caption_quality_review: {
            approved: false,
            decision: 'revise',
            reviewed_caption: 'A thoughtful father’s day gift planning idea that feels personal, not generic.\n\nThis is visible queue copy.\n\nSee the listing here:\nhttps://www.etsy.com/listing/4389878231/old-photo-restoration-colorization',
            rationale: 'The caption is generic and does not explain the listing-specific value.',
          },
        },
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        media_items: [{ url: 'https://img.example.test/restoration.jpg', type: 'image', source: 'listing_image' }],
      },
    }, res);

    try {
      expect(captured.statusCode).toBe(400);
      expect(captured.payload).toMatchObject({
        success: false,
        code: 'AI_REVIEW_ARTIFACT_REQUIRED',
      });
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('schedule requires a rationale with an approving AI caption review', async () => {
    const { res, captured } = mockResponse();
    const originalEnv = {
      SOCIAL_HERMES_API_TOKEN: process.env.SOCIAL_HERMES_API_TOKEN,
      SOCIAL_HERMES_OWNER_TELEGRAM_ID: process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    process.env.SOCIAL_HERMES_API_TOKEN = 'bridge-token';
    process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID = 'owner-1';
    process.env.PUBLIC_BASE_URL = 'https://manager.example.test';

    await socialHandler({
      method: 'POST',
      headers: { authorization: 'Bearer bridge-token' },
      query: {},
      body: {
        action: 'schedule',
        id: 'seasonal-guidance-fragment-regression',
        approved: true,
        approved_by: 'owner-1',
        platform: 'facebook',
        listing_id: '4517826856',
        listing_title: 'Family Generations Portrait',
        caption: 'Father’s Day and early summer are strong moments for family-memory, graduation, vacation, and keepsake gifts.\n\nSee the listing here:\nhttps://www.etsy.com/listing/4517826856',
        metadata: {
          ai_caption_quality_review_required: true,
          ai_caption_quality_review: {
            approved: true,
            decision: 'approve',
            reviewed_caption: 'Father’s Day and early summer are strong moments for family-memory, graduation, vacation, and keepsake gifts.\n\nSee the listing here:\nhttps://www.etsy.com/listing/4517826856',
            rationale: '',
          },
        },
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        media_items: [{ url: 'https://img.example.test/portrait-guidance.jpg', type: 'image', source: 'listing_image' }],
      },
    }, res);

    try {
      expect(captured.statusCode).toBe(400);
      expect(captured.payload).toMatchObject({
        success: false,
        code: 'AI_REVIEW_ARTIFACT_REQUIRED',
      });
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('blocks a Facebook variant when the required raw Etsy URL is absent', () => {
    const plan = planSocialCreativeCampaign({
      listing: { ...listing, url: '' },
      now,
      providerConfigured: false,
      platforms: ['facebook'],
    });
    expect(plan.variants).toHaveLength(1);
    expect(plan.variants[0]).toMatchObject({
      platform: 'facebook',
      link_policy: 'raw_etsy_listing_url_required',
      readiness: 'blocked_missing_listing_url',
    });
  });

  test('candidate planner scans past a cooldown-blocked listing and keeps platform-specific variants only', () => {
    const blocked = {
      ...listing,
      listing_id: 'blocked-1',
      url: 'https://www.etsy.com/listing/blocked-1',
      title: 'Cooldown listing',
      listing_campaign_fit: { source: 'unit_ai', decision: 'acceptable_fit', should_use_listing: true, confidence: 0.82, rationale: 'AI verified a natural fit for this test campaign.' },
    };
    const eligible = {
      ...listing,
      listing_id: 'eligible-2',
      url: 'https://www.etsy.com/listing/eligible-2',
      title: 'Eligible listing',
      listing_campaign_fit: { source: 'unit_ai', decision: 'acceptable_fit', should_use_listing: true, confidence: 0.86, rationale: 'AI verified a natural fit for this test campaign.' },
      media_items: [
        ...listing.media_items,
        { id: 'wide', url: 'https://img.example.test/wide-eligible.jpg', width: 1800, height: 1200, rank: 4, alt: 'Wide graduation invitation flat lay' },
        { id: 'square-two', url: 'https://img.example.test/square-two-eligible.jpg', width: 1600, height: 1600, rank: 3, alt: 'Second square invitation detail crop' },
        { id: 'portrait-three', url: 'https://img.example.test/portrait-three-eligible.jpg', width: 1400, height: 1800, rank: 3, alt: 'Third portrait invitation display crop' },
      ],
    };
    const plan = planSocialCreativeCampaignForCandidates({
      listingCandidates: [blocked, eligible],
      now,
      providerConfigured: false,
      platforms: ['all', 'instagram', 'facebook', 'pinterest'],
      records: [{ listing_id: 'blocked-1', platform: 'instagram', scheduled_at: now, status: 'approved_scheduled' }],
    });

    expect(plan.listing_id).toBe('eligible-2');
    expect(plan.status).toBe('ready_for_review');
    expect(plan.generation_decision).toMatchObject({ use_generation: false, status: 'not_needed' });
    expect(plan.candidate_selection).toMatchObject({
      mode: 'scanned_listing_candidates',
      selected_listing_id: 'eligible-2',
      skipped_before_selection: 1,
      total_candidates: 2,
    });
    expect(plan.candidate_selection.attempts[0]).toMatchObject({ listing_id: 'blocked-1', listing_eligible: false });
    expect(plan.variants.map(variant => variant.platform).sort()).toEqual(['facebook', 'instagram', 'pinterest']);
    expect(plan.variants.every(variant => variant.platform !== 'all' && variant.readiness === 'media_ready')).toBe(true);
    expect(plan.variants.find(variant => variant.platform === 'pinterest').media_items).toHaveLength(1);
  });

  test('candidate planner scans past AI campaign-fit mismatches without topic hardcoding', () => {
    const mismatch = {
      ...listing,
      listing_id: 'semantic-mismatch-1',
      url: 'https://www.etsy.com/listing/semantic-mismatch-1',
      title: 'High quality media but wrong campaign fit',
      listing_campaign_fit: {
        source: 'unit_ai',
        decision: 'mismatch',
        should_use_listing: false,
        confidence: 0.88,
        rationale: 'The listing can be promoted, but the supplied campaign moment is not a natural match.',
      },
    };
    const fit = {
      ...listing,
      listing_id: 'semantic-fit-2',
      url: 'https://www.etsy.com/listing/semantic-fit-2',
      title: 'Good semantic campaign fit',
      listing_campaign_fit: {
        source: 'unit_ai',
        decision: 'acceptable_fit',
        should_use_listing: true,
        confidence: 0.84,
        rationale: 'A normal shopper would understand the campaign/listing connection.',
      },
    };
    const plan = planSocialCreativeCampaignForCandidates({
      listingCandidates: [mismatch, fit],
      context: { occasion: 'operator supplied campaign moment', campaign_context: 'Use the candidate only if the connection is natural.' },
      now,
      providerConfigured: false,
      platforms: ['instagram', 'facebook'],
    });

    expect(plan.listing_id).toBe('semantic-fit-2');
    expect(plan.status).toBe('ready_for_review');
    expect(plan.candidate_selection).toMatchObject({
      mode: 'scanned_listing_candidates',
      selected_listing_id: 'semantic-fit-2',
      selected_attempt_index: 1,
      skipped_before_selection: 1,
      total_candidates: 2,
    });
    expect(plan.candidate_selection.attempts[0]).toMatchObject({
      listing_id: 'semantic-mismatch-1',
      status: 'blocked_campaign_mismatch',
      campaign_fit_decision: 'mismatch',
      campaign_fit_confidence: 0.88,
    });
  });

  test('candidate planner blocks candidates without AI campaign fit instead of failing open', () => {
    const plan = planSocialCreativeCampaignForCandidates({
      listingCandidates: [{
        ...listing,
        listing_id: 'missing-fit-1',
        url: 'https://www.etsy.com/listing/missing-fit-1',
        title: 'Listing with no semantic fit proof',
      }],
      context: { occasion: 'operator supplied campaign moment', campaign_context: 'Use only if AI proves the connection is natural.' },
      now,
      providerConfigured: false,
      platforms: ['instagram', 'facebook'],
    });

    expect(plan.status).toBe('blocked_no_campaign_fit_candidate');
    expect(plan.listing_id).toBe('');
    expect(plan.candidate_selection).toMatchObject({
      mode: 'blocked_no_campaign_fit_candidate',
      total_candidates: 1,
    });
    expect(plan.candidate_selection.attempts[0]).toMatchObject({
      listing_id: 'missing-fit-1',
      status: 'blocked_campaign_mismatch',
      campaign_fit_decision: '',
    });
  });

  test('candidate planner keeps scanning past generation-blocked candidates until media-ready variants exist', () => {
    const needsGeneration = {
      listing_id: 'needs-generation-1',
      url: 'https://www.etsy.com/listing/needs-generation-1',
      title: 'Sparse listing needs generated support',
      listing_campaign_fit: { source: 'unit_ai', decision: 'acceptable_fit', should_use_listing: true, confidence: 0.8, rationale: 'AI verified a natural fit for this test campaign.' },
      media_items: [
        { id: 'only', url: 'https://img.example.test/only-one.jpg', width: 500, height: 280, rank: 1, alt: '' },
      ],
      listing_understanding: {
        available: true,
        source: 'unit_ai',
        what_is_sold: 'A sparse listing requiring generated campaign media.',
        caption_body: 'A campaign idea that needs purpose-built visual explanation.',
        platform_captions: {
          instagram: 'This campaign idea needs purpose-built visual explanation before it is ready for owner review. #CreativePlanning',
          facebook: 'This campaign idea needs purpose-built visual explanation before it is ready for owner review.',
        },
        media_strategy: {
          format: 'carousel',
          target_media_count: 2,
          platform_variants: {
            instagram: { format: 'carousel', frame_ids: ['generated-hook', 'generated-proof'] },
            facebook: { format: 'multi_image', frame_ids: ['generated-hook', 'generated-proof'] },
          },
          frames: [
            { id: 'generated-hook', role: 'hook', source: 'generated_image', prompt: 'Create the campaign hook frame.', reference_required: false, reference_policy: 'No listing reference is required for this conceptual hook.', aspect_ratio: '4:5', rationale: 'Purpose-built campaign hook.' },
            { id: 'generated-proof', role: 'support', source: 'generated_image', prompt: 'Create the campaign support frame.', reference_required: false, reference_policy: 'No listing reference is required for this conceptual support frame.', aspect_ratio: '4:5', rationale: 'Purpose-built campaign support.' },
          ],
        },
      },
    };
    const ready = {
      listing_id: 'ready-2',
      url: 'https://www.etsy.com/listing/ready-2',
      title: 'Ready listing',
      listing_campaign_fit: { source: 'unit_ai', decision: 'acceptable_fit', should_use_listing: true, confidence: 0.87, rationale: 'AI verified a natural fit for this test campaign.' },
      media_items: [
        ...listing.media_items,
        { id: 'square-extra', url: 'https://img.example.test/square-extra-ready.jpg', width: 1600, height: 1600, rank: 5, alt: 'Extra ready listing detail crop' },
      ],
      listing_understanding: {
        available: true,
        source: 'unit_ai',
        what_is_sold: 'A listing with three campaign-ready product views.',
        caption_body: 'Three exact product views explain the ready listing clearly.',
        platform_captions: {
          instagram: 'Three exact product views explain this ready listing clearly for owner review. #EtsyListing #ProductStory',
          facebook: 'Three exact product views explain this ready listing clearly for owner review. https://www.etsy.com/listing/ready-2',
        },
        media_strategy: {
          format: 'carousel',
          target_media_count: 3,
          platform_variants: {
            instagram: { format: 'carousel', frame_ids: ['ready-one', 'ready-two', 'ready-three'] },
            facebook: { format: 'multi_image', frame_ids: ['ready-one', 'ready-two', 'ready-three'] },
          },
          frames: [
            { id: 'ready-one', role: 'hook', source: 'listing_image', reference_media_rank: 1, rationale: 'Exact product lead.' },
            { id: 'ready-two', role: 'support', source: 'listing_image', reference_media_rank: 6, rationale: 'Exact product detail.' },
            { id: 'ready-three', role: 'support', source: 'listing_image', reference_media_rank: 2, rationale: 'Exact product detail.' },
          ],
        },
      },
    };

    const plan = planSocialCreativeCampaignForCandidates({
      listingCandidates: [needsGeneration, ready],
      now,
      providerConfigured: true,
      platforms: ['instagram', 'facebook'],
    });

    expect(plan.listing_id).toBe('ready-2');
    expect(plan.status).toBe('ready_for_review');
    expect(plan.candidate_selection).toMatchObject({
      selected_listing_id: 'ready-2',
      selected_attempt_index: 1,
      skipped_before_selection: 1,
    });
    expect(plan.candidate_selection.attempts[0]).toMatchObject({
      listing_id: 'needs-generation-1',
      status: 'needs_generation',
      pending_generation_frames: 2,
    });
    expect(plan.variants.every(variant => variant.readiness === 'media_ready' && variant.media_items.length >= 3)).toBe(true);

    const generationTarget = planSocialCreativeCampaignForCandidates({
      listingCandidates: [needsGeneration],
      now,
      providerConfigured: true,
      platforms: ['instagram', 'facebook'],
    });
    expect(generationTarget).toMatchObject({
      listing_id: 'needs-generation-1',
      status: 'needs_generation',
      candidate_selection: {
        mode: 'scanned_listing_candidates_generation_target',
        selected_listing_id: 'needs-generation-1',
        selected_attempt_index: 0,
      },
    });
    expect(generationTarget.generated_frame_briefs.map(brief => brief.id)).toEqual(['generated-hook', 'generated-proof']);
  });

  test('strong original listing media stays schedulable when optional generation is unavailable', () => {
    const plan = planSocialCreativeCampaign({
      listing,
      now,
      providerConfigured: true,
      platforms: ['instagram', 'facebook'],
    });

    expect(plan.status).toBe('ready_for_review');
    expect(plan.generation_decision).toMatchObject({
      use_generation: false,
      materially_improves: false,
      status: 'not_needed',
    });
    expect(plan.generated_frame_briefs).toEqual([]);
    expect(plan.storyboard.filter(frame => frame.status === 'ready')).toHaveLength(4);
    expect(plan.variants).toHaveLength(2);
    expect(plan.variants.every(variant => variant.readiness === 'media_ready' && variant.media_items.length >= 3)).toBe(true);
  });

  test('planner blocks missing AI captions instead of synthesizing title-spam copy', () => {
    const plan = planSocialCreativeCampaign({
      listing: {
        listing_id: '4517826856',
        title: 'Family Generations Portrait | America 250 Anniversary Custom Picture | Immigrant Roots Photo Merge |',
        url: 'https://www.etsy.com/listing/4517826856/family-generations-portrait-america-250',
        media_items: [
          { id: 'hero', url: 'https://img.example.test/hero.jpg', width: 1600, height: 2000, rank: 1, alt: 'Finished family generations portrait example' },
          { id: 'detail', url: 'https://img.example.test/detail.jpg', width: 1600, height: 1600, rank: 2, alt: 'Close detail of family portrait edit' },
          { id: 'support', url: 'https://img.example.test/support.jpg', width: 1400, height: 1800, rank: 3, alt: 'Custom portrait keepsake display' },
        ],
      },
      now,
      providerConfigured: true,
      platforms: ['instagram', 'facebook', 'pinterest'],
      context: {
        listing_understanding: {
          available: true,
          source: 'unit_ai',
          what_is_sold: 'A custom digital family generations portrait service.',
          platform_captions: {},
          media_strategy: aiListingMediaStrategy(['instagram', 'facebook', 'pinterest'], [1, 2, 3]),
        },
      },
    });

    const instagram = plan.variants.find(variant => variant.platform === 'instagram');
    const facebook = plan.variants.find(variant => variant.platform === 'facebook');
    const pinterest = plan.variants.find(variant => variant.platform === 'pinterest');
    const rawTitle = 'Family Generations Portrait | America 250 Anniversary Custom Picture';
    expect(plan.status).toBe('blocked_ai_caption_required');
    expect([instagram, facebook, pinterest].every(variant => variant.caption === '' && variant.readiness === 'blocked_ai_caption_required')).toBe(true);
    expect(plan.variants.map(variant => variant.caption).join('\n')).not.toContain(rawTitle);
  });

  test('planner leaves instructional-vs-hero meaning to AI vision instead of keyword penalties', () => {
    const ranking = rankSocialListingMedia({
      listing: {
        listing_id: 'digital-file-ranking',
        title: 'Hawaii 2026 Png file, Islands Family Vacation 2026',
        media_items: [
          { id: 'instructions', url: 'https://img.example.test/digital-file-instructions.jpg', width: 2000, height: 2000, rank: 1, alt: 'Digital file download instructions and what you get' },
          { id: 'design', url: 'https://img.example.test/design-preview.jpg', width: 1600, height: 2000, rank: 2, alt: 'Hawaii family vacation shirt design preview with tropical flowers' },
        ],
      },
      now,
    });

    expect(ranking.ranked.find(item => item.id === 'instructions').rationale.join(' ')).not.toContain('penalized');
    expect(ranking.honesty_note).toContain('Pixels were not analyzed');
  });

  test('high-resolution original carousels remain schedulable even when Etsy alt text is missing', () => {
    const noAltListing = {
      listing_id: 'no-alt-square-gallery',
      title: 'No alt but high resolution listing gallery',
      url: 'https://www.etsy.com/listing/no-alt-square-gallery',
      media_items: [
        { id: 'square-a', url: 'https://img.example.test/square-a.jpg', width: 1254, height: 1254, rank: 1, alt: '' },
        { id: 'square-b', url: 'https://img.example.test/square-b.jpg', width: 1254, height: 1254, rank: 2, alt: '' },
        { id: 'square-c', url: 'https://img.example.test/square-c.jpg', width: 1254, height: 1254, rank: 3, alt: '' },
        { id: 'square-d', url: 'https://img.example.test/square-d.jpg', width: 1254, height: 1254, rank: 4, alt: '' },
      ],
      listing_understanding: {
        available: true,
        source: 'unit_ai',
        what_is_sold: 'a product represented by four exact square listing views',
        buyer_use_case: 'reviewing the exact product gallery before purchase',
        marketing_angle: 'Show the complete exact product gallery without generated filler.',
        caption_body: 'Four exact listing views give buyers a clear product overview.',
        platform_captions: {
          instagram: 'Four exact listing views give buyers a clear product overview without generated filler. #EtsyFind #ProductGallery',
          facebook: 'Four exact listing views give buyers a clear product overview. https://www.etsy.com/listing/no-alt-square-gallery',
        },
        media_strategy: {
          format: 'carousel',
          target_media_count: 4,
          frames: [1, 2, 3, 4].map(rank => ({ id: `no-alt-${rank}`, role: rank === 1 ? 'hero' : 'support', source: 'listing_image', reference_media_rank: rank, rationale: `AI selected exact listing image rank ${rank}.` })),
          platform_variants: {
            instagram: { format: 'carousel', frame_ids: ['no-alt-1', 'no-alt-2', 'no-alt-3', 'no-alt-4'] },
            facebook: { format: 'multi_image', frame_ids: ['no-alt-1', 'no-alt-2', 'no-alt-3', 'no-alt-4'] },
          },
        },
        confidence: 0.9,
      },
    };

    const plan = planSocialCreativeCampaign({
      listing: noAltListing,
      now,
      providerConfigured: true,
      platforms: ['instagram', 'facebook'],
    });

    expect(plan.status).toBe('ready_for_review');
    expect(plan.generation_decision).toMatchObject({
      use_generation: false,
      status: 'not_needed',
    });
    expect(plan.generated_frame_briefs).toEqual([]);
    expect(plan.storyboard.filter(frame => frame.status === 'ready')).toHaveLength(4);
    expect(plan.variants.every(variant => variant.readiness === 'media_ready' && variant.media_items.length >= 3)).toBe(true);
  });

  test('creative planner includes Pinterest variant when requested without platform=all fallback', () => {
    const plan = planSocialCreativeCampaignForCandidates({
      listingCandidates: [{
        ...listing,
        listing_campaign_fit: { source: 'unit_ai', decision: 'acceptable_fit', should_use_listing: true, confidence: 0.88, rationale: 'AI verified a natural fit for this test campaign.' },
      }],
      now,
      providerConfigured: true,
      platforms: ['all', 'instagram', 'facebook', 'pinterest'],
    });

    expect(plan.status).toBe('ready_for_review');
    expect(plan.variants.map(variant => variant.platform).sort()).toEqual(['facebook', 'instagram', 'pinterest']);
    expect(plan.variants.find(variant => variant.platform === 'pinterest')).toMatchObject({ readiness: 'media_ready', link_policy: 'platform_link_supported' });
  });
});

test.describe('scheduled all-platform expansion', () => {
  let originalEnv;
  let originalFetch;
  let kv = new Map();
  let lists = new Map();
  let locks = new Map();

  test.beforeEach(() => {
    originalEnv = {
      SITE_PASSWORD: process.env.SITE_PASSWORD,
      SESSION_SECRET: process.env.SESSION_SECRET,
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      ETSY_SHOP_ID: process.env.ETSY_SHOP_ID,
    };
    originalFetch = global.fetch;
    delete process.env.SITE_PASSWORD;
    delete process.env.SESSION_SECRET;
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-kv-token';
    process.env.ETSY_SHOP_ID = 'unit-shop';
    kv = new Map();
    lists = new Map();
    locks = new Map();
    global.fetch = async (url) => {
      const parsed = new URL(String(url));
      const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const command = String(parts[0] || '').toUpperCase();
      const key = parts[1] || '';
      const lockResponse = schedulerRedisLockCommand(parts, { lists, locks });
      if (lockResponse) return lockResponse;
      if (command === 'GET') return new Response(JSON.stringify({ result: kv.get(key) ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (command === 'SET') { kv.set(key, parts[2] || ''); return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (command === 'DEL') { kv.delete(key); lists.delete(key); return new Response(JSON.stringify({ result: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (command === 'LPUSH') {
        const list = lists.get(key) || [];
        for (const value of parts.slice(2)) list.unshift(value);
        lists.set(key, list);
        return new Response(JSON.stringify({ result: list.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'RENAME') {
        lists.set(parts[2], lists.get(key) || []);
        lists.delete(key);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LRANGE') {
        const list = lists.get(key) || [];
        const start = parseInt(parts[2] || '0', 10);
        const stop = parseInt(parts[3] || '-1', 10);
        const end = stop < 0 ? list.length : stop + 1;
        return new Response(JSON.stringify({ result: list.slice(start, end) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (command === 'LTRIM' || command === 'PING') return new Response(JSON.stringify({ result: 'OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ error: `unsupported ${command}` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    };
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('saveScheduledPost expands platform=all into UI-configured concrete records', async () => {
    const socialConfigs = {
      ig_config: { token: 'ig-secret', ig_id: 'ig_1' },
      fb_posts_config: { page_id: 'page_1', token: 'fb-secret' },
      make_config: { webhook_url: 'https://hook.example.test/pinterest?token=hidden' },
      tiktok_config: { invalid: true, last_error: 'expired' },
    };
    // api/kv.js captures SHOP_ID at module import time in this unit file, before
    // this test mutates ETSY_SHOP_ID, so the in-memory mock uses the default key.
    kv.set('default:social_configs', encodeURIComponent(JSON.stringify(socialConfigs)));

    const captured = await callKv({
      action: 'saveScheduledPost',
      value: {
        id: 'unit-all-expand',
        caption: 'Expanded all-platform calendar record',
        platform: 'all',
        scheduled_at: '2026-06-12T12:00:00.000Z',
        status: 'scheduled',
        listing_image_url: 'https://img.example.test/item.jpg',
      },
    });

    expect(captured.statusCode).toBe(200);
    expect(captured.payload.data.map(post => post.platform).sort()).toEqual(['facebook', 'instagram', 'pinterest']);
    expect(captured.payload.data.every(post => post.platform !== 'all')).toBe(true);
    expect(captured.payload.data.every(post => post.metadata.expanded_from_platform === 'all')).toBe(true);
    expect(captured.payload.data.every(post => post.metadata.all_platform_target.join(',') === 'facebook,instagram,pinterest')).toBe(true);
    expect(JSON.stringify(captured.payload)).not.toContain('ig-secret');
    expect(JSON.stringify(captured.payload)).not.toContain('fb-secret');
    expect(JSON.stringify(captured.payload)).not.toContain('hidden');

    const saved = (lists.get('default:scheduled:posts') || []).map(decodeScheduledQueueTestRecord);
    expect(saved.map(post => post.platform).sort()).toEqual(['facebook', 'instagram', 'pinterest']);
  });

  test('updateScheduledPost rejects platform=all instead of creating an unpublishable record', async () => {
    lists.set('default:scheduled:posts', [
      encodeURIComponent(JSON.stringify({ id: 'unit-update-platform', status: 'draft', platform: 'instagram' })),
    ]);

    const captured = await callKv({
      action: 'updateScheduledPost',
      value: { id: 'unit-update-platform', platform: 'all' },
    });

    expect(captured.statusCode).toBe(400);
    expect(captured.payload.code).toBe('ALL_PLATFORM_UPDATE_NOT_ALLOWED');
    const stored = (lists.get('default:scheduled:posts') || []).map(decodeScheduledQueueTestRecord);
    expect(stored).toEqual([{ id: 'unit-update-platform', status: 'draft', platform: 'instagram' }]);
  });

  test('saveScheduledPost strips forged publish approval and terminal publish state', async () => {
    const captured = await callKv({
      action: 'saveScheduledPost',
      value: {
        id: 'unit-forged-approval',
        caption: 'Unapproved operator draft',
        platform: 'instagram',
        scheduled_at: '2030-07-22T14:00:00.000Z',
        status: 'approved_scheduled',
        approved_for_publish: true,
        approved_by: 'forged-owner',
        approved_at: '2030-07-20T10:00:00.000Z',
        approval_source: 'forged-source',
        publish_result: { published: true },
        post_url: 'https://example.test/forged',
      },
    });

    expect(captured.statusCode).toBe(200);
    expect(captured.payload.data).toMatchObject({
      id: 'unit-forged-approval',
      status: 'scheduled',
      approved_for_publish: false,
      approved_by: null,
      approved_at: null,
      approval_source: null,
      publish_result: null,
      post_url: null,
    });
  });

  test('updateScheduledPost ignores forged approval-only fields', async () => {
    lists.set('default:scheduled:posts', [
      encodeURIComponent(JSON.stringify({
        id: 'unit-forged-update',
        status: 'scheduled',
        platform: 'facebook',
        approved_for_publish: false,
        approved_by: null,
      })),
    ]);

    const captured = await callKv({
      action: 'updateScheduledPost',
      value: {
        id: 'unit-forged-update',
        approved_for_publish: true,
        approved_by: 'forged-owner',
        approved_at: '2030-07-20T10:00:00.000Z',
        approval_source: 'forged-source',
      },
    });

    expect(captured.statusCode).toBe(200);
    expect(captured.payload.data).toMatchObject({
      id: 'unit-forged-update',
      status: 'scheduled',
      approved_for_publish: false,
      approved_by: null,
    });
    expect(typeof captured.payload.data.updated_at).toBe('number');
  });

  test('getScheduledPosts hides duplicate ids left by legacy queue writes', async () => {
    const duplicate = encodeURIComponent(JSON.stringify({ id: 'legacy-duplicate', status: 'draft', platform: 'instagram' }));
    lists.set('default:scheduled:posts', [
      duplicate,
      duplicate,
      encodeURIComponent(JSON.stringify({ id: 'unique-record', status: 'draft', platform: 'facebook' })),
    ]);

    const captured = await callKv({ action: 'getScheduledPosts' });

    expect(captured.statusCode).toBe(200);
    expect(captured.payload.data.map(post => post.id)).toEqual(['legacy-duplicate', 'unique-record']);
  });
});
