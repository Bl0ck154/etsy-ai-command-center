import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { buildSocialOwnerReviewGenerationRequest } from '../api/modules/social/application/build-owner-review-generation-request.js';

function reviewCardDesign() {
  return {
    style: 'modern_poster',
    heading: 'What an Etsy buyer said',
    highlight_phrase: 'looked natural',
    background_color: '#DDEFE7',
    surface_color: '#FFFDF8',
    text_color: '#17251F',
    accent_color: '#E85D3F',
  };
}

test('generated request without reference never uses a listing image or planner fallback policy', () => {
  const { payload, problem } = buildSocialOwnerReviewGenerationRequest({
    brief: {
      id: 'context',
      role: 'ordering context',
      prompt: 'Show a buyer choosing a pet photo for a portrait.',
      image_model: 'antigravity/gemini-3.1-flash-image',
      aspect_ratio: '4:5',
      reference_required: false,
      reference_policy: 'Planner fallback that must not be forwarded.',
    },
    strategyFrame: {
      id: 'context',
      source: 'generated_image',
      image_model: 'antigravity/gemini-3.1-flash-image',
      reference_required: false,
    },
    title: 'Custom Pet Portrait',
  });

  expect(problem).toBe('');
  expect(payload).toMatchObject({
    brief_id: 'context',
    model: 'antigravity/gemini-3.1-flash-image',
    aspect_ratio: '4:5',
    crop_focus: 'attention',
    count: 1,
    format: 'single',
    require_visual_quality_review: true,
    quality_context: {
      frame_role: 'ordering context',
      reference_required: false,
      reference_policy: '',
    },
  });
  expect(payload).not.toHaveProperty('reference_image_url');
  expect(payload).not.toHaveProperty('reference_policy');
});

test('reference-backed generation forwards the AI-selected URL and strategy policy verbatim', () => {
  const { payload, problem } = buildSocialOwnerReviewGenerationRequest({
    brief: {
      id: 'hero',
      role: 'product hero',
      prompt: 'Show the selected portrait example in a clean setting.',
      image_model: 'codex/gpt-5.6-terra',
      aspect_ratio: '1:1',
      reference_required: true,
      reference_image_url: 'https://img.example.test/ai-selected-reference.jpg',
      reference_policy: 'Brief-local fallback that must not win.',
    },
    strategyFrame: {
      id: 'hero',
      source: 'generated_image',
      image_model: 'codex/gpt-5.6-terra',
      reference_required: true,
      reference_policy: 'Preserve the selected portrait style exactly.',
    },
    title: 'Custom Pet Portrait',
  });

  expect(problem).toBe('');
  expect(payload.reference_image_url).toBe('https://img.example.test/ai-selected-reference.jpg');
  expect(payload.reference_policy).toBe('Preserve the selected portrait style exactly.');
  expect(payload.model).toBe('codex/gpt-5.6-terra');
});

test('generated request fails closed when brief changes model or reference decisions', () => {
  const baseBrief = {
    id: 'hero',
    prompt: 'Show the selected result.',
    image_model: 'model-a',
    aspect_ratio: '4:5',
    reference_required: true,
    reference_image_url: 'https://img.example.test/reference.jpg',
  };
  const baseFrame = {
    id: 'hero',
    source: 'generated_image',
    image_model: 'model-a',
    reference_required: true,
    reference_policy: 'Keep the exact supplied result.',
  };

  expect(buildSocialOwnerReviewGenerationRequest({
    brief: { ...baseBrief, image_model: 'model-b' },
    strategyFrame: baseFrame,
  }).problem).toContain('image_model');
  expect(buildSocialOwnerReviewGenerationRequest({
    brief: { ...baseBrief, reference_required: false },
    strategyFrame: baseFrame,
  }).problem).toContain('reference_required');
  expect(buildSocialOwnerReviewGenerationRequest({
    brief: { ...baseBrief, reference_image_url: '' },
    strategyFrame: baseFrame,
  }).problem).toContain('reference image URL');
  expect(buildSocialOwnerReviewGenerationRequest({
    brief: baseBrief,
    strategyFrame: { ...baseFrame, reference_policy: '' },
  }).problem).toContain('reference policy');
});

test('generated request rejects a supplied reference when AI decided reference_required=false', () => {
  const { payload, problem } = buildSocialOwnerReviewGenerationRequest({
    brief: {
      id: 'context',
      prompt: 'Create context.',
      image_model: '',
      aspect_ratio: '4:5',
      reference_required: false,
      reference_image_url: 'https://img.example.test/not-selected.jpg',
    },
    strategyFrame: {
      id: 'context',
      source: 'generated_image',
      image_model: '',
      reference_required: false,
    },
  });
  expect(payload).toBeNull();
  expect(problem).toContain('reference_required is false');
});

test('review-card request preserves exact selected evidence, design and deterministic render fingerprint', () => {
  const design = reviewCardDesign();
  const evidence = {
    review_id: 'review-42',
    listing_id: 'listing-42',
    exact_quote: 'The result looked natural.',
    rating: 5,
  };
  const { payload, problem } = buildSocialOwnerReviewGenerationRequest({
    brief: {
      id: 'review-proof',
      role: 'customer proof',
      renderer: 'review_card',
      context_note: 'Custom digital family photo composition service',
      review_card_design: design,
      render_spec_sha256: 'c'.repeat(64),
      aspect_ratio: '2:3',
      review_evidence: evidence,
      shop_name: 'Shop Name',
      heading: 'Buyer proof',
    },
    strategyFrame: {
      id: 'review-proof',
      source: 'review_card',
      review_id: 'review-42',
      context_note: 'Custom digital family photo composition service',
      review_card_design: { ...design },
      aspect_ratio: '2:3',
    },
    title: 'Custom Family Photo Composition',
  });

  expect(problem).toBe('');
  expect(payload).toMatchObject({
    renderer: 'review_card',
    brief_id: 'review-proof',
    context_note: 'Custom digital family photo composition service',
    render_spec_sha256: 'c'.repeat(64),
    review_card_design: design,
    review_evidence: evidence,
    aspect_ratio: '2:3',
    count: 1,
    format: 'single',
  });
  expect(payload).not.toHaveProperty('reference_image_url');
});

test('review-card request fails closed when evidence, art direction or aspect ratio diverges from strategy', () => {
  const design = reviewCardDesign();
  const brief = {
    id: 'review-proof',
    renderer: 'review_card',
    context_note: 'Exact context',
    review_card_design: design,
    render_spec_sha256: 'c'.repeat(64),
    aspect_ratio: '1:1',
    review_evidence: { review_id: 'review-42', exact_quote: 'Great result', rating: 5 },
  };
  const frame = {
    id: 'review-proof',
    source: 'review_card',
    review_id: 'review-42',
    context_note: 'Exact context',
    review_card_design: design,
    aspect_ratio: '1:1',
  };

  expect(buildSocialOwnerReviewGenerationRequest({
    brief: { ...brief, review_evidence: { ...brief.review_evidence, review_id: 'other' } },
    strategyFrame: frame,
  }).problem).toContain('review_id');
  expect(buildSocialOwnerReviewGenerationRequest({
    brief: { ...brief, review_card_design: { ...design, heading: 'Changed' } },
    strategyFrame: frame,
  }).problem).toContain('art direction');
  expect(buildSocialOwnerReviewGenerationRequest({
    brief: { ...brief, aspect_ratio: '4:5' },
    strategyFrame: frame,
  }).problem).toContain('aspect ratio');
});

test('generation request contract has no provider call, HTTP, queue, worker or publisher dependency', () => {
  const source = readFileSync(new URL('../api/modules/social/application/build-owner-review-generation-request.js', import.meta.url), 'utf8');
  expect(source).not.toMatch(/generateWith|external-ai|fetch\s*\(|api\/social|queue\.js|workers\/|publishDue|social-publisher/i);
});
