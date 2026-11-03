import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { createSocialOwnerReviewCampaignPreparationCoordinator } from '../api/modules/social/application/coordinate-owner-review-campaign-preparation.js';

const NOW = new Date('2026-08-13T10:00:00.000Z');
const DEADLINE = '2026-08-13T10:20:00.000Z';

function generatedBrief(id, prompt = `Generate ${id}`) {
  return {
    id,
    role: `${id} role`,
    prompt,
    image_model: 'model-one',
    aspect_ratio: '4:5',
    crop_focus: 'attention',
    reference_required: false,
  };
}

function generatedFrame(id, prompt = `Generate ${id}`) {
  return {
    id,
    role: `${id} role`,
    rationale: 'AI selected this exact frame.',
    source: 'generated_image',
    prompt,
    image_model: 'model-one',
    aspect_ratio: '4:5',
    crop_focus: 'attention',
    reference_required: false,
    communication_goal: 'Show the exact buyer outcome.',
    visible_buyer_evidence: 'The finished result is visible.',
    evidence_strength: 'primary',
  };
}

function needsGenerationPlan(briefs, overrides = {}) {
  const list = Array.isArray(briefs) ? briefs : [briefs];
  return {
    status: 'needs_generation',
    concept: { hook: 'Exact AI hook' },
    generated_frame_briefs: list,
    storyboard: list.map(brief => ({
      frame_id: brief.id,
      brief_id: brief.id,
      role: brief.role,
      status: 'pending_generation',
    })),
    media_strategy: {
      format: list.length > 1 ? 'carousel' : 'single',
      target_media_count: list.length,
      required_visible_evidence: 'The exact buyer outcome.',
      frames: list.map(brief => generatedFrame(brief.id, brief.prompt)),
      platform_variants: {
        instagram: {
          format: list.length > 1 ? 'carousel' : 'single',
          frame_ids: list.map(brief => brief.id),
          buyer_evidence_frame_ids: [list[0].id],
        },
      },
    },
    ...overrides,
  };
}

function readyPlan(overrides = {}) {
  return {
    status: 'ready_for_review',
    media_strategy: {
      format: 'single',
      target_media_count: 1,
      required_visible_evidence: 'The exact buyer outcome.',
      frames: [generatedFrame('hero')],
      platform_variants: {
        instagram: {
          format: 'single',
          frame_ids: ['hero'],
          buyer_evidence_frame_ids: ['hero'],
        },
      },
    },
    ...overrides,
  };
}

function persistentMedia(id, overrides = {}) {
  return {
    id: `asset-${id}`,
    url: `https://manager.example.test/api/social?action=mediaAsset&id=${id}`,
    source: 'generated_image',
    permanent: true,
    checksum_sha256: 'a'.repeat(64),
    quality_review: { decision: 'approve', approved: true, rationale: 'Clear buyer evidence.' },
    ...overrides,
  };
}

function harness({ plans, generate, planValidator, coordinatorOptions = {} }) {
  const planCalls = [];
  const generationCalls = [];
  const planQueue = [...plans];
  const creativePlanService = {
    planCreativeCampaign: async (body, execution) => {
      planCalls.push({
        body: structuredClone(body),
        execution,
        qualityFeedbackDuringCall: structuredClone(body.context?.media_quality_feedback || null),
      });
      const next = planQueue.shift();
      if (next instanceof Error) throw next;
      return structuredClone(next);
    },
  };
  const mediaGenerationService = {
    generateMedia: async (payload, execution) => {
      generationCalls.push({ payload: structuredClone(payload), execution });
      return generate ? generate(payload, execution, generationCalls.length) : {
        success: true,
        images: [persistentMedia(payload.brief_id)],
      };
    },
  };
  const coordinator = createSocialOwnerReviewCampaignPreparationCoordinator({
    creativePlanService,
    mediaGenerationService,
    planValidator: planValidator || { validate: () => ({ valid: true }) },
    clock: () => NOW,
    ...coordinatorOptions,
  });
  return { coordinator, generationCalls, planCalls };
}

function prepareInput(overrides = {}) {
  return {
    planBody: {
      listing: { listing_id: 'listing-1', title: 'Custom portrait' },
      context: { campaign_context: 'Exact AI-selected campaign context' },
      platforms: ['instagram'],
      generated_media: [],
    },
    listing: { listing_id: 'listing-1', title: 'Custom portrait' },
    opportunity: { reason: 'Exact AI-selected campaign context' },
    platforms: ['instagram'],
    deadline_at: DEADLINE,
    ...overrides,
  };
}

test('ready_for_review on the first creativePlan call never invokes generation', async () => {
  const { coordinator, generationCalls, planCalls } = harness({ plans: [readyPlan()] });
  const result = await coordinator.prepare(prepareInput());

  expect(result).toMatchObject({ status: 'ready_for_review', generation_rounds: 0, published: false });
  expect(planCalls).toHaveLength(1);
  expect(generationCalls).toEqual([]);
});

test('one successful generation batch is persisted into the AI replan and reaches ready_for_review', async () => {
  const brief = generatedBrief('hero');
  const { coordinator, generationCalls, planCalls } = harness({
    plans: [needsGenerationPlan(brief), readyPlan()],
  });
  const result = await coordinator.prepare(prepareInput());

  expect(result.generation_rounds).toBe(1);
  expect(result.generated_media).toEqual([expect.objectContaining({ brief_id: 'hero', permanent: true })]);
  expect(generationCalls).toHaveLength(1);
  expect(generationCalls[0].payload).toMatchObject({
    brief_id: 'hero',
    model: 'model-one',
    timeout_ms: 600_000,
  });
  expect(planCalls[1].body.generated_media).toEqual([expect.objectContaining({ brief_id: 'hero' })]);
  expect(planCalls[1].body.context.media_generation_resolution).toMatchObject({
    generation_round: 1,
    generation_round_limit: 3,
    generation_budget_exhausted: false,
  });
});

test('mixed generation batch collects one success and one rejection before the replan', async () => {
  const briefs = [generatedBrief('hero'), generatedBrief('support')];
  const { coordinator, planCalls } = harness({
    plans: [needsGenerationPlan(briefs), readyPlan()],
    generate: payload => payload.brief_id === 'hero'
      ? { success: true, images: [persistentMedia('hero')] }
      : {
        success: false,
        code: 'MEDIA_QUALITY_REJECTED',
        error: 'Weak support frame.',
        quality_reviews: [{
          decision: 'regenerate',
          rationale: 'The pixels do not prove the result.',
          issues: ['Weak result evidence.'],
          specific_revision: 'Show the finished result clearly.',
        }],
        rejected_previews: [{
          id: 'rejected-support',
          url: 'https://manager.example.test/rejected-support.jpg',
          source: 'quality_rejected_preview',
          quality_review: { decision: 'regenerate', rationale: 'Weak result evidence.' },
        }],
      },
  });

  const result = await coordinator.prepare(prepareInput());
  expect(result.generated_media.map(item => item.brief_id)).toEqual(['hero']);
  expect(result.generation_diagnostics).toHaveLength(1);
  expect(result.generation_diagnostics[0].brief_id).toBe('support');
  expect(planCalls[1].body.generated_media.map(item => item.brief_id)).toEqual(['hero']);
  expect(planCalls[1].body.context.media_generation_resolution.failed_or_exhausted_briefs)
    .toEqual([expect.objectContaining({ brief_id: 'support' })]);
});

test('independent generation requests preserve input order with concurrency capped at three', async () => {
  const briefs = Array.from({ length: 5 }, (_, index) => generatedBrief(`frame-${index + 1}`));
  let active = 0;
  let maximumActive = 0;
  const completionOrder = [];
  const { coordinator } = harness({
    plans: [needsGenerationPlan(briefs), readyPlan()],
    generate: async payload => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, payload.brief_id === 'frame-1' ? 8 : 2));
      completionOrder.push(payload.brief_id);
      active -= 1;
      return { success: true, images: [persistentMedia(payload.brief_id)] };
    },
    coordinatorOptions: { generationConcurrency: 99 },
  });

  const result = await coordinator.prepare(prepareInput());
  expect(maximumActive).toBe(3);
  expect(completionOrder[0]).not.toBe('frame-1');
  expect(result.generated_media.map(item => item.brief_id)).toEqual(briefs.map(brief => brief.id));
});

test('quality feedback is supplied to exactly the next plan and then removed', async () => {
  const brief = generatedBrief('hero');
  const { coordinator, planCalls } = harness({
    plans: [needsGenerationPlan(brief), readyPlan()],
    generate: () => ({
      success: false,
      code: 'MEDIA_QUALITY_REJECTED',
      error: 'Weak visual.',
      quality_reviews: [{
        decision: 'regenerate',
        rationale: 'The result is not visible.',
        issues: ['No finished result.'],
        specific_revision: 'Make the finished result unmistakable.',
      }],
    }),
  });

  const result = await coordinator.prepare(prepareInput());
  expect(planCalls[1].qualityFeedbackDuringCall).toEqual([expect.objectContaining({
    brief_id: 'hero',
    decision: 'regenerate',
    specific_revision: 'Make the finished result unmistakable.',
  })]);
  expect(result.plan_body.context).not.toHaveProperty('media_quality_feedback');
});

test('explicit AI discard removes only the named accepted asset after replan', async () => {
  const briefs = [generatedBrief('hero'), generatedBrief('support')];
  const finalPlan = readyPlan({
    media_strategy: {
      ...readyPlan().media_strategy,
      accepted_asset_decisions: [
        { brief_id: 'hero', decision: 'reuse', rationale: 'Keep the lead.' },
        { brief_id: 'support', decision: 'discard', rationale: 'No longer serves the story.' },
      ],
    },
  });
  const { coordinator } = harness({ plans: [needsGenerationPlan(briefs), finalPlan] });
  const result = await coordinator.prepare(prepareInput());
  expect(result.generated_media.map(item => item.brief_id)).toEqual(['hero']);
});

test('unchanged failed brief is blocked by exact request fingerprint while a material revision can retry', async () => {
  const first = generatedBrief('hero', 'First exact prompt');
  const unchangedHarness = harness({
    plans: [needsGenerationPlan(first), needsGenerationPlan(first)],
    generate: () => ({ success: false, code: 'GENERATE_MEDIA_FAILED', error: 'Provider rejected.' }),
  });
  await expect(unchangedHarness.coordinator.prepare(prepareInput())).rejects.toMatchObject({
    code: 'SOCIAL_OWNER_REVIEW_GENERATION_BRIEF_REPEATED',
  });
  expect(unchangedHarness.generationCalls).toHaveLength(1);

  const revised = generatedBrief('hero', 'Materially revised exact prompt');
  const changedHarness = harness({
    plans: [needsGenerationPlan(first), needsGenerationPlan(revised), readyPlan()],
    generate: (payload, _execution, attempt) => attempt === 1
      ? { success: false, code: 'GENERATE_MEDIA_FAILED', error: 'Provider rejected.' }
      : { success: true, images: [persistentMedia(payload.brief_id)] },
  });
  const result = await changedHarness.coordinator.prepare(prepareInput());
  expect(result.generation_rounds).toBe(2);
  expect(changedHarness.generationCalls.map(call => call.payload.prompt))
    .toEqual(['First exact prompt', 'Materially revised exact prompt']);
});

test('later accepted repair clears the active failure ledger while rejected-preview diagnostics remain', async () => {
  const first = generatedBrief('hero', 'First rejected prompt');
  const revised = generatedBrief('hero', 'Revised accepted prompt');
  const { coordinator, planCalls } = harness({
    plans: [needsGenerationPlan(first), needsGenerationPlan(revised), readyPlan()],
    generate: (_payload, _execution, attempt) => attempt === 1
      ? {
        success: false,
        code: 'MEDIA_QUALITY_REJECTED',
        error: 'Weak visual.',
        quality_reviews: [{ decision: 'regenerate', rationale: 'Weak visual.' }],
        rejected_previews: [{
          id: 'rejected-hero',
          url: 'https://manager.example.test/rejected-hero.jpg',
          source: 'quality_rejected_preview',
          quality_review: { decision: 'regenerate', rationale: 'Weak visual.' },
        }],
      }
      : { success: true, images: [persistentMedia('hero')] },
  });

  const result = await coordinator.prepare(prepareInput());
  expect(planCalls[2].body.context.media_generation_resolution.failed_or_exhausted_briefs).toEqual([]);
  expect(result.generation_diagnostics).toEqual([expect.objectContaining({
    brief_id: 'hero',
    rejected_previews: [expect.objectContaining({ id: 'rejected-hero', publishable: false })],
  })]);
});

test('generation round limit stops a sequence of materially changed failed briefs', async () => {
  const prompts = ['one', 'two', 'three', 'four'];
  const { coordinator, generationCalls } = harness({
    plans: prompts.map(prompt => needsGenerationPlan(generatedBrief('hero', prompt))),
    generate: () => ({ success: false, code: 'GENERATE_MEDIA_FAILED', error: 'No approved image.' }),
  });
  await expect(coordinator.prepare(prepareInput())).rejects.toMatchObject({
    code: 'SOCIAL_OWNER_REVIEW_GENERATION_ROUND_LIMIT',
    details: { generation_round: 3, generation_round_limit: 3 },
  });
  expect(generationCalls).toHaveLength(3);
});

test('abort and expired deadline fail closed before an expensive AI call', async () => {
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('shutdown'), { code: 'TEST_ABORT' }));
  const aborted = harness({ plans: [readyPlan()] });
  await expect(aborted.coordinator.prepare(prepareInput({ signal: controller.signal })))
    .rejects.toMatchObject({ code: 'TEST_ABORT' });
  expect(aborted.planCalls).toEqual([]);

  const expired = harness({ plans: [readyPlan()] });
  await expect(expired.coordinator.prepare(prepareInput({ deadline_at: '2026-08-13T09:59:59.000Z' })))
    .rejects.toMatchObject({ code: 'SOCIAL_OWNER_REVIEW_REPLAN_BUDGET_INSUFFICIENT' });
  expect(expired.planCalls).toEqual([]);
});

test('insufficient provider budget blocks before generateMedia starts', async () => {
  const { coordinator, generationCalls, planCalls } = harness({
    plans: [needsGenerationPlan(generatedBrief('hero'))],
  });
  await expect(coordinator.prepare(prepareInput({ deadline_at: '2026-08-13T10:01:59.000Z' })))
    .rejects.toMatchObject({ code: 'SOCIAL_OWNER_REVIEW_PROVIDER_BUDGET_INSUFFICIENT' });
  expect(planCalls).toHaveLength(1);
  expect(generationCalls).toEqual([]);
});

function reviewBrief(renderSpec) {
  const design = {
    style: 'modern_poster',
    heading: 'Buyer proof',
    highlight_phrase: 'looked natural',
    background_color: '#DDEFE7',
    surface_color: '#FFFDF8',
    text_color: '#17251F',
    accent_color: '#E85D3F',
  };
  return {
    id: 'review-proof',
    role: 'buyer proof',
    renderer: 'review_card',
    context_note: 'Custom portrait service',
    review_card_design: design,
    render_spec_sha256: renderSpec,
    aspect_ratio: '1:1',
    review_evidence: { review_id: 'review-42', exact_quote: 'Beautiful result.', rating: 5 },
  };
}

function reviewPlan(brief, overrides = {}) {
  return needsGenerationPlan(brief, {
    media_strategy: {
      format: 'single',
      target_media_count: 1,
      required_visible_evidence: 'Exact buyer quote.',
      frames: [{
        id: brief.id,
        role: brief.role,
        rationale: 'AI selected exact review evidence.',
        source: 'review_card',
        review_id: brief.review_evidence.review_id,
        context_note: brief.context_note,
        review_card_design: brief.review_card_design,
        aspect_ratio: brief.aspect_ratio,
        communication_goal: 'Add exact buyer proof.',
        visible_buyer_evidence: 'Exact buyer quote and rating.',
        evidence_strength: 'supporting',
      }],
      platform_variants: {
        instagram: { format: 'single', frame_ids: [brief.id], buyer_evidence_frame_ids: [brief.id] },
      },
      ...overrides,
    },
  });
}

test('deterministic review-card guard blocks identical rerender and permits one explicit material repair', async () => {
  const first = reviewBrief('a'.repeat(64));
  const identical = harness({
    plans: [reviewPlan(first), reviewPlan(first)],
    generate: payload => ({
      success: true,
      images: [persistentMedia(payload.brief_id, { source: 'review_card', quality_review: undefined })],
    }),
  });
  await expect(identical.coordinator.prepare(prepareInput())).rejects.toMatchObject({
    code: 'SOCIAL_OWNER_REVIEW_REVIEW_CARD_REPAIR_BLOCKED',
  });
  expect(identical.generationCalls).toHaveLength(1);

  const replacement = reviewBrief('b'.repeat(64));
  const repaired = harness({
    plans: [
      reviewPlan(first),
      reviewPlan(replacement, {
        accepted_asset_decisions: [{
          brief_id: 'review-proof',
          decision: 'discard',
          rationale: 'Material art-direction repair is required.',
        }],
      }),
      readyPlan(),
    ],
    generate: payload => ({
      success: true,
      images: [persistentMedia(`${payload.brief_id}-${payload.render_spec_sha256[0]}`, {
        source: 'review_card',
        quality_review: undefined,
      })],
    }),
  });
  const result = await repaired.coordinator.prepare(prepareInput());
  expect(result.generation_rounds).toBe(2);
  expect(repaired.generationCalls.map(call => call.payload.render_spec_sha256))
    .toEqual(['a'.repeat(64), 'b'.repeat(64)]);
});

test('invalid aggregate strategy fails closed before generation', async () => {
  const invalidValidator = {
    validate: () => ({
      valid: false,
      problem: 'AI media strategy is incomplete: instagram platform_variant missing',
      problems: ['instagram platform_variant missing'],
    }),
  };
  const { coordinator, generationCalls } = harness({
    plans: [needsGenerationPlan(generatedBrief('hero'))],
    planValidator: invalidValidator,
  });
  await expect(coordinator.prepare(prepareInput())).rejects.toMatchObject({
    code: 'SOCIAL_OWNER_REVIEW_STRATEGY_INVALID',
    details: { problems: ['instagram platform_variant missing'] },
  });
  expect(generationCalls).toEqual([]);
});

test('coordinator source has no queue, Telegram, publisher, Express, worker, or fallback dependency', () => {
  const source = readFileSync(
    new URL('../api/modules/social/application/coordinate-owner-review-campaign-preparation.js', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(/queue\.js|telegram|publishDue|social-publisher|express|\breq\b|\bres\b|workers\/|fallback media/i);
});
