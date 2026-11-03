import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { createSocialListingUnderstandingAiStrategy } from '../api/modules/social/infrastructure/listing-understanding-ai.js';

function normalizeText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeStrategy(overrides = {}) {
  const calls = {
    compact: [],
    configured: 0,
    generate: [],
    normalize: [],
    outputSchema: [],
    primaryPrompt: 0,
    repairPrompt: 0,
    review: [],
    usable: [],
    problems: [],
    preview: [],
  };

  const dependencies = {
    normalizeText,
    responsePreview: (value, max) => {
      calls.preview.push([value, max]);
      return `preview:${value?.id || value?.kind || String(value)}`;
    },
    normalizeUnderstanding: (raw, source) => {
      calls.normalize.push([raw, source]);
      if (!raw || typeof raw !== 'object') return null;
      return { ...raw, available: true, source };
    },
    compactListing: (listing, visualAnalysis) => {
      calls.compact.push([listing, visualAnalysis]);
      return {
        listing_id: String(listing.listing_id || ''),
        title: listing.title || 'Listing title',
        description: listing.description || '',
        tags: Array.isArray(listing.tags) ? listing.tags : [],
        media: [{ rank: 1 }, { rank: 2 }],
      };
    },
    isAiConfigured: async () => {
      calls.configured += 1;
      return true;
    },
    generateWithAi: async (...args) => {
      calls.generate.push(args);
      return { id: `raw-${calls.generate.length}`, accept: true };
    },
    buildOutputSchema: (...args) => {
      calls.outputSchema.push(args);
      return { schema: true };
    },
    buildPrimaryPrompt: () => {
      calls.primaryPrompt += 1;
      return 'PRIMARY PROMPT';
    },
    buildRepairPrompt: () => {
      calls.repairPrompt += 1;
      return 'REPAIR PROMPT';
    },
    reviewCaptions: async input => {
      calls.review.push(input);
      return {
        ...input.understanding,
        platform_caption_reviews: { instagram: { approved: true, marker: input.understanding.id } },
        caption_review_source: 'external_ai_caption_critic',
      };
    },
    isUsable: (...args) => {
      calls.usable.push(args);
      return args[0]?.accept === true;
    },
    validationProblems: (...args) => {
      calls.problems.push(args);
      return [`problem-${calls.problems.length}`];
    },
    ...overrides,
  };

  return {
    strategy: createSocialListingUnderstandingAiStrategy(dependencies),
    calls,
  };
}

test('listing-understanding AI reuses a supplied understanding without touching AI when legacy fast-path gates pass', async () => {
  const supplied = {
    what_is_sold: 'Portrait',
    accept: true,
    visual_analysis: { applied: true, provider: 'old-vision', image_count: 2 },
  };
  const { strategy, calls } = makeStrategy();
  const visualAnalysis = { available: true, provider: 'new-vision', images: [{ rank: 1 }] };

  const result = await strategy.understand({
    listing: { listing_understanding: supplied },
    context: {},
    visualAnalysis,
  });

  expect(result).toMatchObject({
    what_is_sold: 'Portrait',
    source: 'caller_supplied',
    visual_analysis: { applied: true, provider: 'old-vision', image_count: 2 },
  });
  expect(calls.configured).toBe(0);
  expect(calls.compact).toEqual([]);
  expect(calls.generate).toEqual([]);
  expect(calls.usable).toHaveLength(1);
});

test('owner revision and media feedback independently disable the supplied fast path', async () => {
  for (const context of [
    { owner_feedback: 'Change the hero' },
    { media_quality_feedback: [{ issue: 'crop' }] },
  ]) {
    const { strategy, calls } = makeStrategy({
      generateWithAi: async (...args) => {
        calls.generate.push(args);
        return { id: 'primary', accept: true };
      },
    });
    const result = await strategy.understand({
      listing: { listing_understanding: { what_is_sold: 'Portrait', accept: true } },
      context,
    });
    expect(result.source).toBe('external_ai');
    expect(calls.generate).toHaveLength(1);
  }
});

test('AI configuration rejection fails closed as ai_unavailable before compact payload construction', async () => {
  const { strategy, calls } = makeStrategy({
    isAiConfigured: async () => {
      calls.configured += 1;
      throw new Error('config lookup failed');
    },
  });

  const result = await strategy.understand({ listing: {}, context: {} });

  expect(result).toEqual({
    available: false,
    source: 'ai_unavailable',
    reason: 'External text AI is not configured.',
  });
  expect(calls.configured).toBe(1);
  expect(calls.compact).toEqual([]);
  expect(calls.generate).toEqual([]);
});

test('insufficient compact listing context fails before prompt/schema/AI construction', async () => {
  const { strategy, calls } = makeStrategy({
    compactListing: (listing, visualAnalysis) => {
      calls.compact.push([listing, visualAnalysis]);
      return { title: '', description: '', tags: [], media: [] };
    },
  });

  const result = await strategy.understand({ listing: {}, context: {} });

  expect(result).toEqual({
    available: false,
    source: 'insufficient_listing_context',
    reason: 'Listing title/description/tags are missing.',
  });
  expect(calls.primaryPrompt).toBe(0);
  expect(calls.outputSchema).toEqual([]);
  expect(calls.generate).toEqual([]);
});

test('primary success preserves schema inputs, prompt context cleanup, task contract and vision proof', async () => {
  const { strategy, calls } = makeStrategy({
    generateWithAi: async (...args) => {
      calls.generate.push(args);
      return { id: 'primary', accept: true };
    },
  });
  const visualAnalysis = {
    available: true,
    provider: ' vision-provider ',
    images: [{ rank: 1 }, { rank: 2 }],
  };
  const context = {
    platforms: ['instagram', 'facebook'],
    listing_understanding: { what_is_sold: 'Old', accept: false },
    campaign_context: 'Campaign',
    media_generation_resolution: {
      accepted_assets: [
        { brief_id: ' asset-a ' },
        { brief_id: 'asset-a' },
        { brief_id: 'asset-b' },
      ],
    },
  };

  const result = await strategy.understand({
    listing: { listing_id: '44', title: 'Portrait' },
    context,
    visualAnalysis,
  });

  expect(calls.generate).toHaveLength(1);
  expect(calls.generate[0][0]).toBe('PRIMARY PROMPT');
  expect(calls.generate[0][2]).toEqual({ schema: true });
  expect(calls.generate[0][3]).toEqual({ task: 'creative_listing_understanding', maxTokens: 12_000 });
  const userPayload = JSON.parse(calls.generate[0][1]);
  expect(userPayload.campaign_context).toEqual(expect.objectContaining({
    platforms: ['instagram', 'facebook'],
    campaign_context: 'Campaign',
  }));
  expect(userPayload.campaign_context).not.toHaveProperty('listing_understanding');
  expect(userPayload.existing_listing_understanding).toMatchObject({ source: 'caller_supplied' });
  expect(calls.outputSchema).toEqual([[['instagram', 'facebook'], ['asset-a', 'asset-b'], [1, 2]]]);
  expect(result).toMatchObject({
    id: 'primary',
    source: 'external_ai',
    visual_analysis: { applied: true, provider: 'vision-provider', image_count: 2 },
  });
  expect(calls.repairPrompt).toBe(0);
});

test('caption review is applied before usability and its feedback is passed into repair attempt one', async () => {
  let generated = 0;
  const { strategy, calls } = makeStrategy({
    generateWithAi: async (...args) => {
      calls.generate.push(args);
      generated += 1;
      return generated === 1
        ? { id: 'primary', accept: false }
        : { id: 'repair-1', accept: true };
    },
  });

  const result = await strategy.understand({
    listing: { title: 'Portrait' },
    context: { platforms: ['instagram'], require_ai_caption_quality_review: true },
  });

  expect(result).toMatchObject({
    id: 'repair-1',
    source: 'external_ai_repair_1',
    repair_used: true,
    repair_attempts: 1,
    raw_preview: 'preview:primary',
    repair_response_preview: 'preview:repair-1',
  });
  expect(calls.review).toHaveLength(2);
  expect(calls.generate).toHaveLength(2);
  expect(calls.generate[1][0]).toBe('REPAIR PROMPT');
  expect(calls.generate[1][3]).toEqual({ task: 'creative_listing_repair_1', maxTokens: 12_000 });
  const repairPayload = JSON.parse(calls.generate[1][1]);
  expect(repairPayload).toMatchObject({
    validation_errors: ['problem-1'],
    repair_attempt: 1,
    repairs_remaining_including_this_one: 2,
    caption_review_feedback: { instagram: { approved: true, marker: 'primary' } },
  });
  expect(repairPayload.previous_response).toEqual({ id: 'primary', accept: false });
});

test('second repair uses the first repaired response/diagnostics and remains bounded at exactly two repairs', async () => {
  const responses = [
    { id: 'primary', accept: false },
    { id: 'repair-1', accept: false, platform_caption_reviews: { instagram: { marker: 'r1' } } },
    { id: 'repair-2', accept: true },
  ];
  const { strategy, calls } = makeStrategy({
    generateWithAi: async (...args) => {
      calls.generate.push(args);
      return responses[calls.generate.length - 1];
    },
  });

  const result = await strategy.understand({ listing: { title: 'Portrait' }, context: {} });

  expect(calls.generate).toHaveLength(3);
  expect(calls.generate.map(call => call[3].task)).toEqual([
    'creative_listing_understanding',
    'creative_listing_repair_1',
    'creative_listing_repair_2',
  ]);
  const secondRepairPayload = JSON.parse(calls.generate[2][1]);
  expect(secondRepairPayload.previous_response).toEqual(responses[1]);
  expect(secondRepairPayload.validation_errors).toEqual(['problem-2']);
  expect(secondRepairPayload.repair_attempt).toBe(2);
  expect(secondRepairPayload.repairs_remaining_including_this_one).toBe(1);
  expect(result).toMatchObject({
    id: 'repair-2',
    source: 'external_ai_repair_2',
    repair_used: true,
    repair_attempts: 2,
  });
});

test('two unusable repairs return the legacy invalid-response shape from the final normalized attempt', async () => {
  const responses = [
    { id: 'primary', accept: false },
    { id: 'repair-1', accept: false },
    {
      id: 'repair-2',
      accept: false,
      media_strategy: { format: 'single' },
      platform_captions: { instagram: 'Caption' },
      platform_caption_reviews: { instagram: { approved: false } },
      caption_review_source: 'external_ai_caption_critic_error',
    },
  ];
  const { strategy, calls } = makeStrategy({
    generateWithAi: async (...args) => {
      calls.generate.push(args);
      return responses[calls.generate.length - 1];
    },
    validationProblems: (...args) => {
      calls.problems.push(args);
      return calls.problems.length === 3 ? ['final-one', 'final-two'] : [`problem-${calls.problems.length}`];
    },
  });

  const result = await strategy.understand({ listing: { title: 'Portrait' }, context: {} });

  expect(calls.generate).toHaveLength(3);
  expect(result).toEqual({
    available: false,
    source: 'ai_invalid_response',
    reason: 'External AI did not return a usable listing understanding after 2 repair attempts: final-one; final-two',
    validation_problems: ['final-one', 'final-two'],
    media_strategy: { format: 'single' },
    platform_captions: { instagram: 'Caption' },
    platform_caption_reviews: { instagram: { approved: false } },
    caption_review_source: 'external_ai_caption_critic_error',
    raw_preview: 'preview:primary',
    repair_response_preview: 'preview:repair-2',
  });
});

test('AI/normalization/review failures inside the legacy try boundary become ai_error', async () => {
  const { strategy } = makeStrategy({
    generateWithAi: async () => { throw new Error('provider timeout'); },
  });

  await expect(strategy.understand({ listing: { title: 'Portrait' }, context: {} })).resolves.toEqual({
    available: false,
    source: 'ai_error',
    reason: 'provider timeout',
  });
});

test('pre-AI payload failures remain outside the legacy try boundary and still reject', async () => {
  const { strategy } = makeStrategy({
    compactListing: () => { throw new Error('payload builder failed'); },
  });

  await expect(strategy.understand({ listing: { title: 'Portrait' }, context: {} }))
    .rejects.toThrow('payload builder failed');
});

test('listing-understanding AI strategy owns no queue, publish, approval or HTTP behavior', () => {
  const source = readFileSync(new URL('../api/modules/social/infrastructure/listing-understanding-ai.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(35_000);
  expect(source).not.toMatch(/getScheduledPosts|saveScheduledPost|publishSocialHermes|approveScheduledPost|AUTOPUBLISH|REAL_PUBLISH_RELEASE_APPROVED|express|\breq\b|\bres\b/);
  expect(source).toContain('for (let repairAttempt = 1; repairAttempt <= 2; repairAttempt += 1)');
});
