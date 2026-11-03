import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import {
  collectSocialOwnerReviewGenerationBatchOutcomes,
  mergeSocialOwnerReviewGeneratedMediaByBrief,
  mergeSocialOwnerReviewGenerationDiagnostics,
  mergeSocialOwnerReviewGenerationFailures,
  pendingSocialOwnerReviewGenerationBriefs,
  preserveSocialOwnerReviewApprovedMediaForReplan,
  reconcileSocialOwnerReviewGeneratedMediaWithAiDecisions,
  socialOwnerReviewAiQualityReplanFeedback,
  socialOwnerReviewGeneratedMediaHasApprovedAiQuality,
  socialOwnerReviewGenerationFailureFact,
  socialOwnerReviewGenerationRequestFingerprint,
  updateSocialOwnerReviewGenerationResolutionContext,
} from '../api/modules/social/application/owner-review-generation-state.js';

function persistentGenerated(overrides = {}) {
  return {
    id: 'shmedia-approved',
    url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia-approved',
    source: 'generated_image',
    permanent: true,
    checksum_sha256: 'a'.repeat(64),
    quality_review: { decision: 'approve', approved: true },
    ...overrides,
  };
}

test('generation replan keeps already approved persistent frames and explicit empty replacement can clear them', () => {
  const approved = [persistentGenerated({ brief_id: 'hook' })];
  const planBody = { generated_media: [], context: {} };

  preserveSocialOwnerReviewApprovedMediaForReplan(planBody, approved);
  expect(planBody.generated_media).toEqual(approved);

  preserveSocialOwnerReviewApprovedMediaForReplan(planBody, []);
  expect(planBody.generated_media).toEqual([]);
});

test('generated media merge keeps AI order positions while later success replaces the same brief', () => {
  const existing = [{ id: 'old', brief_id: 'hero', url: 'https://manager.example.test/media/old.png' }];
  const laterBatch = [
    { id: 'support', brief_id: 'support', url: 'https://manager.example.test/media/support.png' },
    { id: 'new', brief_id: 'hero', url: 'https://manager.example.test/media/new.png' },
  ];

  const merged = mergeSocialOwnerReviewGeneratedMediaByBrief(existing, laterBatch);

  expect(merged.map(item => item.brief_id)).toEqual(['hero', 'support']);
  expect(merged[0].id).toBe('new');
});

test('AI discard decision removes only the explicitly named accepted asset', () => {
  const media = [
    { brief_id: 'hero', url: 'https://manager.example.test/hero.png' },
    { brief_id: 'support', url: 'https://manager.example.test/support.png' },
  ];
  const plan = {
    media_strategy: {
      accepted_asset_decisions: [
        { brief_id: 'hero', decision: 'reuse', rationale: 'Strong lead.' },
        { brief_id: 'support', decision: 'discard', rationale: 'No longer needed.' },
      ],
    },
  };

  expect(reconcileSocialOwnerReviewGeneratedMediaWithAiDecisions(media, plan)).toEqual([media[0]]);
  expect(reconcileSocialOwnerReviewGeneratedMediaWithAiDecisions(media, {})).toEqual(media);
});

test('generation resolution carries accepted assets and bounded failure ledger into replan context', () => {
  const approved = [{ brief_id: 'hero', url: 'https://manager.example.test/hero.png' }];
  const failed = [{ brief_id: 'support', attempts: 2, outcome: 'generate_media_timeout', error: 'timed out' }];
  const planBody = { generated_media: [], context: {} };

  updateSocialOwnerReviewGenerationResolutionContext({
    planBody,
    generatedMedia: approved,
    failedBriefs: failed,
    generationRound: 2,
    generationRoundLimit: 2,
    priorCampaignRepair: { attempted: true, resolved: false },
  });

  expect(planBody.generated_media).toEqual(approved);
  expect(planBody.context.media_generation_resolution).toEqual({
    phase: 'post_generation_replan',
    generation_round: 2,
    generation_round_limit: 2,
    remaining_generation_rounds: 0,
    generation_budget_exhausted: true,
    failed_or_exhausted_briefs: failed,
    prior_campaign_quality_repair: {
      attempted: true,
      resolved: false,
      consumed_after_generation_round: 2,
    },
  });
});

test('failure ledger deduplicates a brief, preserves max attempts and refreshes recency before bounded trim', () => {
  const first = socialOwnerReviewGenerationFailureFact(
    { code: 'MEDIA_QUALITY_REJECTED', error: 'weak evidence' },
    { id: 'hero', role: 'lead' },
    1,
  );
  const second = socialOwnerReviewGenerationFailureFact(
    { code: 'GENERATE_MEDIA_TIMEOUT', error: 'timed out' },
    { id: 'hero', role: 'lead' },
    2,
  );
  const mergedSingle = mergeSocialOwnerReviewGenerationFailures([first], [second]);
  expect(mergedSingle).toHaveLength(1);
  expect(mergedSingle[0]).toMatchObject({
    brief_id: 'hero',
    attempts: 2,
    outcome: 'generate_media_timeout',
    failed_brief: { role: 'lead' },
  });
  expect(mergedSingle[0].brief_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/);

  const existing = Array.from({ length: 12 }, (_, index) => ({
    brief_id: `brief-${index}`,
    attempts: 1,
    outcome: 'failed',
  }));
  const bounded = mergeSocialOwnerReviewGenerationFailures(existing, [{
    brief_id: 'brief-0',
    attempts: 2,
    outcome: 'failed_again',
  }, {
    brief_id: 'brief-new',
    attempts: 1,
    outcome: 'failed',
  }]);
  expect(bounded).toHaveLength(12);
  expect(bounded.map(item => item.brief_id)).not.toContain('brief-1');
  expect(bounded.at(-2).brief_id).toBe('brief-0');
  expect(bounded.at(-1).brief_id).toBe('brief-new');
});

test('rejected preview diagnostics survive a later successful repair and remain non-publishable', () => {
  const rejected = socialOwnerReviewGenerationFailureFact({
    code: 'MEDIA_QUALITY_REJECTED',
    error: 'The output is visually ambiguous.',
    data: {
      rejected_previews: [{
        id: 'shmedia-rejected',
        url: 'https://manager.example.test/api/social?action=mediaAsset&id=shmedia-rejected',
        source: 'quality_rejected_preview',
        quality_review: {
          decision: 'regenerate',
          owner_summary_uk: 'Телефон виглядає як статичне фото, а не як готове відео.',
          rationale: 'The phone looks like a static photo.',
          issues: ['The advertised video result is not visible.'],
          specific_revision: 'Show an unmistakable finished montage.',
        },
      }],
    },
  }, { id: 'hero', role: 'Instagram transformation hero' }, 1);

  const diagnostics = mergeSocialOwnerReviewGenerationDiagnostics([], [rejected]);
  let currentFailures = mergeSocialOwnerReviewGenerationFailures([], [rejected]);
  const acceptedIds = new Set(['hero']);
  currentFailures = currentFailures.filter(item => !acceptedIds.has(item.brief_id));

  expect(currentFailures).toEqual([]);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].rejected_previews[0]).toMatchObject({
    id: 'shmedia-rejected',
    publishable: false,
    issues: ['The advertised video result is not visible.'],
    owner_summary_uk: 'Телефон виглядає як статичне фото, а не як готове відео.',
  });
  expect(mergeSocialOwnerReviewGenerationDiagnostics(diagnostics, [rejected])).toEqual(diagnostics);
});

test('generation request fingerprint changes only with the provider execution contract', () => {
  const brief = { id: 'hero', role: 'lead' };
  const payload = {
    brief_id: 'hero',
    prompt: 'Show the finished transformation clearly.',
    aspect_ratio: '4:5',
    reference_required: false,
  };

  const first = socialOwnerReviewGenerationRequestFingerprint(brief, payload);
  const identical = socialOwnerReviewGenerationRequestFingerprint(
    { ...brief, unrelated_debug: 'ignored' },
    { ...payload, count: 1, alt: 'ignored operational copy' },
  );
  const revised = socialOwnerReviewGenerationRequestFingerprint(
    brief,
    { ...payload, prompt: 'Show distinct source photos becoming one finished portrait.' },
  );

  expect(first).toBe(identical);
  expect(first).not.toBe(revised);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
});

test('provider execution selects only storyboard briefs still marked pending_generation', () => {
  const plan = {
    generated_frame_briefs: [
      { id: 'accepted_hook', prompt: 'Reuse the accepted hook.' },
      { id: 'new_support', prompt: 'Create a new support frame.' },
    ],
    storyboard: [
      { frame_id: 'accepted_hook', status: 'ready', media: { brief_id: 'accepted_hook' } },
      { frame_id: 'new_support', brief_id: 'new_support', status: 'pending_generation' },
    ],
  };

  expect(pendingSocialOwnerReviewGenerationBriefs(plan)).toEqual([
    { id: 'new_support', prompt: 'Create a new support frame.' },
  ]);
});

test('generated media quality requires explicit AI approval except persistent deterministic review cards', () => {
  const base = persistentGenerated({ quality_review: undefined });
  expect(socialOwnerReviewGeneratedMediaHasApprovedAiQuality(base)).toBe(false);
  expect(socialOwnerReviewGeneratedMediaHasApprovedAiQuality({
    ...base,
    quality_review: { decision: 'regenerate', approved: false },
  })).toBe(false);
  expect(socialOwnerReviewGeneratedMediaHasApprovedAiQuality({
    ...base,
    quality_review: { decision: 'approve', approved: true },
  })).toBe(true);
  expect(socialOwnerReviewGeneratedMediaHasApprovedAiQuality({
    source: 'review_card',
    url: 'https://manager.example.test/api/social?action=mediaAsset&id=review-card',
    permanent: true,
    checksum_sha256: 'b'.repeat(64),
  })).toBe(true);
});

test('AI media quality rejection feedback is preserved for one model replan', () => {
  const feedback = socialOwnerReviewAiQualityReplanFeedback({
    code: 'MEDIA_QUALITY_REJECTED',
    data: {
      quality_reviews: [{
        decision: 'regenerate',
        rationale: 'The actual pixels do not communicate the custom service.',
        issues: ['The focal point is unrelated to the offer.'],
        specific_revision: 'Use a concrete result-oriented scene tied to the supplied service facts.',
      }],
    },
  }, { id: 'hook-frame', role: 'hook' });

  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toMatchObject({
    brief_id: 'hook-frame',
    decision: 'regenerate',
  });
  expect(feedback[0].specific_revision).toContain('result-oriented');
  expect(socialOwnerReviewAiQualityReplanFeedback({ code: 'GENERATE_MEDIA_FAILED' }, {})).toEqual([]);
});

test('generation batch outcome collector retains mixed successes, review-card evidence and failures before replan', () => {
  const requests = [
    [{ id: 'rejected', role: 'lead' }, { brief_id: 'rejected' }],
    [{ id: 'approved', role: 'proof' }, { brief_id: 'approved' }],
    [{
      id: 'review',
      role: 'customer proof',
      renderer: 'review_card',
      context_note: 'Custom portrait service',
      aspect_ratio: '1:1',
      render_spec_sha256: 'c'.repeat(64),
      review_evidence: { review_id: 'review-42' },
      review_card_design: { style: 'modern_poster' },
    }, { brief_id: 'review', renderer: 'review_card' }],
  ];
  const responses = [
    {
      success: false,
      code: 'MEDIA_QUALITY_REJECTED',
      error: 'weak visual',
      data: { quality_reviews: [{ decision: 'regenerate', rationale: 'Needs stronger proof.' }] },
    },
    { success: true, data: { images: [persistentGenerated({ id: 'approved-media' })] } },
    { success: true, data: { images: [{
      id: 'review-media',
      url: 'https://manager.example.test/media/review.png',
      source: 'review_card',
      permanent: true,
      checksum_sha256: 'd'.repeat(64),
    }] } },
  ];

  const result = collectSocialOwnerReviewGenerationBatchOutcomes(
    requests,
    responses,
    { rejected: 1, approved: 1, review: 1 },
  );

  expect(result.failures).toHaveLength(1);
  expect(result.failures[0].brief_id).toBe('rejected');
  expect(result.quality_feedback).toHaveLength(1);
  expect(result.approved_media.map(item => item.brief_id)).toEqual(['approved', 'review']);
  expect(result.approved_media[1]).toMatchObject({
    review_id: 'review-42',
    context_note: 'Custom portrait service',
    review_card_design: { style: 'modern_poster' },
    aspect_ratio: '1:1',
    render_spec_sha256: 'c'.repeat(64),
  });
});

test('generation state contract has no HTTP, AI provider, queue, worker or publisher dependency', () => {
  const source = readFileSync(new URL('../api/modules/social/application/owner-review-generation-state.js', import.meta.url), 'utf8');
  expect(source).not.toMatch(/fetch\s*\(|external-ai|generateWith|api\/social|queue\.js|workers\/|publishDue|social-publisher/i);
});
