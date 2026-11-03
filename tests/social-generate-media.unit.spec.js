import { readFileSync, rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';

import {
  createSocialMediaGenerationService,
  createSocialMediaProviderRouter,
  generateSocialHermesMedia,
  normalizeGeneratedSocialImageGeometry,
  normalizeSocialMediaGenerationRequest,
} from '../api/modules/social/index.js';
import { planSocialCreativeCampaign } from '../api/_social-creative-planner.js';

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

function generationHarness(overrides = {}) {
  const calls = [];
  const route = overrides.route || {
    configured: true,
    runtime: { imageReferenceMode: 'input_image' },
    modelCandidates: ['image-model'],
    attemptTimeoutMs: 18_000,
    endpoint: 'https://images.example.test/v1/responses',
  };
  const dependencies = {
    normalizeReviewCardEvidence: value => value?.review_id ? value : null,
    normalizeReviewCardDesign: value => value?.heading ? value : null,
    renderReviewCard: async options => {
      calls.push(['render-review-card', options]);
      return Buffer.from('review-card');
    },
    reviewCardRenderSpecSha256: () => 'a'.repeat(64),
    providerRouter: {
      resolve: async input => {
        calls.push(['resolve', input]);
        return route;
      },
      generate: async input => {
        calls.push(['generate', input]);
        return [{
          base64: Buffer.from('generated').toString('base64'),
          mimeType: 'image/png',
          model: 'actual-model',
          external_provider_id: 'provider-one',
          external_provider_endpoint: 'https://images.example.test/v1/responses?secret=no',
        }];
      },
      safeEndpoint: value => String(value || '').split('?')[0],
      errorDiagnostics: error => ({ error: error?.message || String(error) }),
    },
    normalizeGeneratedGeometry: async input => {
      calls.push(['geometry', input]);
      return {
        ...input,
        width: 1080,
        height: 1350,
        original_width: 1024,
        original_height: 1024,
        normalization_applied: true,
        crop_focus: 'attention',
        crop: { width: 819, height: 1024, position: 'attention' },
      };
    },
    reviewGeneratedImage: async input => {
      calls.push(['quality', input]);
      return { approved: true, rationale: 'Buyer evidence is clear.' };
    },
    storeMediaAsset: async input => {
      calls.push(['store', input]);
      return { id: `stored-${calls.filter(call => call[0] === 'store').length}`, url: `${input.publicBaseUrl}/api/social/media?id=stored` };
    },
    getReviewCardShopName: () => 'Studio Test',
    ...overrides.dependencies,
  };
  return {
    calls,
    service: createSocialMediaGenerationService(dependencies),
  };
}

test('Social module exposes a worker-safe default interface without an Express request', async () => {
  await expect(generateSocialHermesMedia({})).resolves.toEqual({
    success: false,
    code: 'PROMPT_REQUIRED',
    error: 'prompt is required',
  });
});

test('generation request contract preserves aliases, count bounds, and high-tier approval gate', () => {
  expect(normalizeSocialMediaGenerationRequest({
    image_prompt: ' Editorial image ',
    aspect_ratio: '4:5',
    cropFocus: 'north',
    tier: 'high',
    count: 99,
    reference_required: true,
    reference_image_url: 'https://etsy.example.test/listing.jpg',
  })).toMatchObject({
    prompt: 'Editorial image',
    aspectRatio: '4:5',
    cropFocus: 'north',
    requestedTier: 'high',
    imageModelTier: 'standard',
    requestedCount: 6,
    referenceRequired: true,
    referenceImage: { url: 'https://etsy.example.test/listing.jpg' },
  });
});

test('provider router preserves tier model order, sanitized endpoint, and configured timeout', async () => {
  const calls = [];
  const router = createSocialMediaProviderRouter({
    hasImageConfig: async () => true,
    getRuntimeConfig: async () => ({
      imageModel: 'runtime-model',
      imageTimeoutMs: 27_000,
      imageBaseUrl: 'https://provider.example.test',
      imagePath: '/v1/responses?token=hidden',
    }),
    buildProviderUrl: (base, path) => `${base}${path}`,
    generateImages: async input => {
      calls.push(input);
      return [];
    },
    env: {
      SOCIAL_HERMES_IMAGE_MODELS_STANDARD: 'tier-model,runtime-model',
      SOCIAL_HERMES_IMAGE_MODELS_FALLBACK: 'fallback-model',
    },
  });

  const route = await router.resolve({ tier: 'standard', requestedModel: 'owner-model' });
  expect(route).toEqual({
    configured: true,
    runtime: expect.objectContaining({ imageModel: 'runtime-model' }),
    modelCandidates: ['owner-model', 'tier-model', 'runtime-model'],
    attemptTimeoutMs: 27_000,
    endpoint: 'https://provider.example.test/v1/responses',
  });
  await router.generate({ prompt: 'image' }, 5_000, 'generation');
  expect(calls[0].signal).toBeInstanceOf(AbortSignal);
});

test('provider timeout records sanitized diagnostics and attempts the next model', async () => {
  const providerCalls = [];
  const timedRouter = createSocialMediaProviderRouter({
    hasImageConfig: async () => true,
    getRuntimeConfig: async () => ({ imageModel: 'unused-runtime-model' }),
    buildProviderUrl: () => 'https://provider.example.test/v1/responses',
    generateImages: async input => {
      providerCalls.push(input.model);
      if (input.model === 'timeout-model') {
        return new Promise((resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      }
      return [{
        base64: Buffer.from('generated-after-timeout').toString('base64'),
        mimeType: 'image/png',
        model: input.model,
        external_provider_id: 'provider-after-timeout',
        external_provider_endpoint: 'https://provider.example.test/v1/responses?token=hidden',
      }];
    },
  });
  const providerRouter = {
    ...timedRouter,
    resolve: async () => ({
      configured: true,
      runtime: { imageReferenceMode: 'input_image' },
      modelCandidates: ['timeout-model', 'success-model'],
      attemptTimeoutMs: 15,
      endpoint: 'https://provider.example.test/v1/responses?api_key=must-not-leak',
    }),
  };
  const { service } = generationHarness({ dependencies: { providerRouter } });

  const result = await service.generateMedia({ prompt: 'Retry the next configured model.' }, {
    publicBaseUrl: 'https://manager.example.test',
  });

  expect(providerCalls).toEqual(['timeout-model', 'success-model']);
  expect(result).toMatchObject({
    success: true,
    selected_model: 'success-model',
    selected_provider: 'provider-after-timeout',
    fallback_used: true,
    provider_attempts: [
      {
        model: 'timeout-model',
        success: false,
        endpoint: 'https://provider.example.test/v1/responses',
        error: expect.stringContaining('timed out'),
      },
      {
        model: 'success-model',
        success: true,
        endpoint: 'https://provider.example.test/v1/responses',
      },
    ],
    published: false,
  });
  expect(JSON.stringify(result.provider_attempts)).not.toContain('must-not-leak');
  expect(JSON.stringify(result.provider_attempts)).not.toContain('token=hidden');
});

test('application requires a public media base before provider generation or storage', async () => {
  const { calls, service } = generationHarness();

  const result = await service.generateMedia({
    prompt: 'Do not generate pixels without a persistent public media URL.',
  });

  expect(result).toMatchObject({
    success: false,
    code: 'REQUEST_CONTEXT_REQUIRED',
    generated: false,
    public_url_available: false,
    images: [],
    published: false,
  });
  expect(calls.filter(call => call[0] === 'generate')).toHaveLength(0);
  expect(calls.filter(call => call[0] === 'store')).toHaveLength(0);
});

test('generateMedia refuses forced synthetic fallback outside explicit e2e mode', async () => {
  const generated = await generateSocialHermesMedia({
    prompt: 'must not create blank beige fallback media',
    allow_fallback: true,
    force_fallback: true,
  }, { publicBaseUrl: 'https://manager.example.test' });

  expect(generated).toMatchObject({
    success: false,
    code: 'FALLBACK_MEDIA_NOT_ALLOWED',
    published: false,
  });
  expect(generated.images).toEqual([]);
});

test('generateMedia fails closed before provider call when reference preservation is unsupported', async () => {
  const saved = Object.fromEntries([
    'EXTERNAL_AI_BASE_URL',
    'EXTERNAL_AI_API_KEY',
    'EXTERNAL_IMAGE_MODEL',
    'EXTERNAL_AI_IMAGE_PATH',
    'EXTERNAL_IMAGE_ADAPTER',
    'EXTERNAL_IMAGE_REFERENCE_MODE',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
  ].map(key => [key, process.env[key]]));
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.EXTERNAL_AI_BASE_URL = 'https://provider.example.test/v1';
  process.env.EXTERNAL_AI_API_KEY = 'provider-token';
  process.env.EXTERNAL_IMAGE_MODEL = 'image-model';
  process.env.EXTERNAL_AI_IMAGE_PATH = '/v1/chat/completions';
  process.env.EXTERNAL_IMAGE_ADAPTER = 'chat_data_uri';
  process.env.EXTERNAL_IMAGE_REFERENCE_MODE = 'unsupported';
  const originalFetch = global.fetch;
  let providerCalled = false;
  global.fetch = async () => {
    providerCalled = true;
    throw new Error('provider must not be called');
  };
  let generated;
  try {
    generated = await generateSocialHermesMedia({
      prompt: 'Create a faithful product mockup.',
      reference_required: true,
      reference_image_url: 'https://i.etsystatic.com/reference.jpg',
      require_visual_quality_review: true,
    }, { publicBaseUrl: 'https://manager.example.test' });
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  expect(generated).toMatchObject({
    success: false,
    code: 'REFERENCE_IMAGE_GENERATION_UNSUPPORTED',
    published: false,
  });
  expect(providerCalled).toBe(false);
});

test('generateMedia persists AI-rejected pixels only as a non-publishable diagnostic preview', async () => {
  const envKeys = [
    'EXTERNAL_AI_BASE_URL', 'EXTERNAL_AI_API_KEY', 'EXTERNAL_AI_MODEL', 'EXTERNAL_VISION_MODEL',
    'EXTERNAL_IMAGE_BASE_URL', 'EXTERNAL_IMAGE_API_KEY', 'EXTERNAL_IMAGE_MODEL',
    'EXTERNAL_AI_IMAGE_PATH', 'EXTERNAL_IMAGE_ADAPTER', 'EXTERNAL_IMAGE_REFERENCE_MODE', 'PUBLIC_BASE_URL',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'SOCIAL_HERMES_MEDIA_STORAGE_DIR',
  ];
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.EXTERNAL_AI_BASE_URL = 'https://provider.example.test/v1';
  process.env.EXTERNAL_AI_API_KEY = 'text-token';
  process.env.EXTERNAL_AI_MODEL = 'reasoning-model';
  process.env.EXTERNAL_VISION_MODEL = 'vision-model';
  process.env.EXTERNAL_IMAGE_BASE_URL = 'https://provider.example.test/v1';
  process.env.EXTERNAL_IMAGE_API_KEY = 'image-token';
  process.env.EXTERNAL_IMAGE_MODEL = 'pollinations/gpt-image-2';
  process.env.EXTERNAL_AI_IMAGE_PATH = '/v1/chat/completions';
  process.env.EXTERNAL_IMAGE_ADAPTER = 'chat_data_uri';
  process.env.EXTERNAL_IMAGE_REFERENCE_MODE = 'unsupported';
  process.env.PUBLIC_BASE_URL = 'https://manager.example.test';
  process.env.SOCIAL_HERMES_MEDIA_STORAGE_DIR = 'tmp/test-social-media-assets';
  const diagnosticStorageDir = process.env.SOCIAL_HERMES_MEDIA_STORAGE_DIR;
  const originalFetch = global.fetch;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  global.fetch = async (_url, options = {}) => {
    const request = JSON.parse(options.body);
    if (request.model === 'pollinations/gpt-image-2') {
      return new Response(JSON.stringify({ choices: [{ message: { content: `data:image/png;base64,${png}` } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      decision: 'regenerate',
      confidence: 0.99,
      communication_goal_met: false,
      persuasive_evidence_visible: false,
      persuasive_evidence_strength: 'absent',
      offer_fidelity: 'The scene is relevant but the rendered headline is malformed.',
      attention_quality: 'The typo damages trust.',
      reference_fidelity: 'No reference was required.',
      text_assessment: 'The requested word The was rendered as he.',
      issues: ['Malformed headline typography.'],
      blocking_issues: ['Malformed headline typography.'],
      rationale: 'Do not show this frame to the owner as publishable media.',
      specific_revision: 'Regenerate with corrected typography or communicate the hook without embedded text.',
    }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  let diagnostic = null;
  try {
    const generated = await generateSocialHermesMedia({
      prompt: 'Create a campaign frame with the exact headline The family story.',
      require_visual_quality_review: true,
      quality_context: { campaign_goal: 'Explain the service clearly', frame_role: 'hook' },
    }, { publicBaseUrl: 'https://manager.example.test' });
    diagnostic = generated.rejected_previews?.[0] || null;
    expect(generated).toMatchObject({
      success: false,
      code: 'MEDIA_QUALITY_REJECTED',
      published: false,
      images: [],
      rejected_preview_available: true,
      rejected_previews: [expect.objectContaining({
        source: 'quality_rejected_preview',
        permanent: true,
        publishable: false,
        width: 1,
        height: 1,
        requested_aspect_ratio: '1:1',
      })],
    });
    expect(diagnostic.quality_review.text_assessment).toContain('rendered as he');
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (diagnostic?.id) {
      rmSync(`${diagnosticStorageDir}/${diagnostic.id}.png`, { force: true });
      rmSync(`${diagnosticStorageDir}/${diagnostic.id}.json`, { force: true });
    }
  }
});

test('application persists an accepted generated image without leaking request objects', async () => {
  const { calls, service } = generationHarness();
  const result = await service.generateMedia({
    prompt: 'Editorial product image',
    aspect_ratio: '4:5',
    require_visual_quality_review: true,
  }, { publicBaseUrl: 'https://manager.example.test' });

  expect(result).toMatchObject({
    success: true,
    generated: true,
    generated_via: 'external_ai_model_tier_routing',
    selected_model: 'actual-model',
    selected_provider: 'provider-one',
    public_url_available: true,
    published: false,
    images: [{
      id: 'stored-1',
      provider: 'provider-one',
      model: 'actual-model',
      rank: 1,
      image_model_tier: 'cheap',
    }],
  });
  expect(calls.find(call => call[0] === 'store')[1]).toMatchObject({
    publicBaseUrl: 'https://manager.example.test',
    source: 'generated_image',
  });
});

test('review-card application path preserves validation, request-context, and storage contracts', async () => {
  const { calls, service } = generationHarness();
  const body = {
    renderer: 'review_card',
    review_evidence: { review_id: 'review-one', exact_quote: 'Beautiful.', rating: 5 },
    review_card_design: { heading: 'Loved by buyers' },
    aspect_ratio: '1:1',
  };
  await expect(service.generateMedia(body)).resolves.toMatchObject({
    success: false,
    code: 'REQUEST_CONTEXT_REQUIRED',
    published: false,
  });

  const result = await service.generateMedia(body, { publicBaseUrl: 'https://manager.example.test' });
  expect(result).toMatchObject({
    success: true,
    renderer: 'review_card',
    generated_via: 'etsy_manager_review_card_renderer',
    images: [{ rank: 1, render_spec_sha256: 'a'.repeat(64) }],
    published: false,
  });
  expect(calls.find(call => call[0] === 'store')[1]).toMatchObject({
    publicBaseUrl: 'https://manager.example.test',
    source: 'review_card',
  });
});

test('AI-selected review card is rendered and persisted without calling an image model', async () => {
  const listing = {
    listing_id: 'review-listing-42',
    title: 'Custom family photo composition',
    url: 'https://www.etsy.com/listing/review-listing-42',
    listing_understanding: {
      source: 'unit_ai',
      what_is_sold: 'A custom family photo composition service.',
      buyer_use_case: 'Combining supplied family photos into one natural keepsake.',
      target_buyer: 'Families preserving a shared memory.',
      marketing_angle: 'Show exact anonymous customer feedback about the natural result.',
      caption_body: 'A careful edit should feel like the family was photographed together from the start.',
      platform_captions: {
        instagram: 'A buyer noticed the natural result and careful details in this custom family photo composition. #FamilyKeepsake #PhotoEditing',
      },
      visual_brief: 'Use truthful customer proof.',
      media_strategy: {
        format: 'single',
        target_media_count: 1,
        platform_variants: {
          instagram: { format: 'single', frame_ids: ['review-proof'] },
        },
        frames: [{
          id: 'review-proof',
          role: 'customer proof',
          source: 'review_card',
          review_id: 'review-42',
          context_note: 'Custom digital family photo composition service',
          review_card_design: testReviewCardDesign(),
          aspect_ratio: '1:1',
          rationale: 'The exact review gives buyers specific, factual social proof.',
        }],
      },
      confidence: 0.94,
    },
  };
  const selectedReview = {
    review_id: 'review-42',
    listing_id: 'review-listing-42',
    rating: 5,
    exact_quote: 'The result looked natural and the details were handled with care.',
  };
  const context = {
    social_factory_path: true,
    factory_path: 'social_autonomous_content_factory',
    selected_review: selectedReview,
    listing_understanding: listing.listing_understanding,
  };
  const initial = planSocialCreativeCampaign({
    listing,
    context,
    platforms: ['instagram'],
    providerConfigured: false,
    publicBaseUrl: 'https://manager.example.test',
    now: '2026-07-10T12:00:00.000Z',
  });
  expect(initial.status).toBe('needs_generation');
  expect(initial.generated_frame_briefs).toEqual([
    expect.objectContaining({
      id: 'review-proof',
      renderer: 'review_card',
      context_note: 'Custom digital family photo composition service',
      review_card_design: testReviewCardDesign(),
      render_spec_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      review_evidence: expect.objectContaining({
        review_id: 'review-42',
        exact_quote: selectedReview.exact_quote,
        rating: 5,
      }),
    }),
  ]);

  const originalEnv = {
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    SOCIAL_HERMES_MEDIA_STORAGE_DIR: process.env.SOCIAL_HERMES_MEDIA_STORAGE_DIR,
  };
  process.env.PUBLIC_BASE_URL = 'https://manager.example.test';
  process.env.SOCIAL_HERMES_MEDIA_STORAGE_DIR = `tmp/test-review-card-assets-${process.pid}`;
  let media = null;
  try {
    const generated = await generateSocialHermesMedia(initial.generated_frame_briefs[0], {
      publicBaseUrl: 'https://manager.example.test',
    });
    expect(generated, JSON.stringify(generated)).toMatchObject({ success: true, published: false });
    media = generated.images[0];
    expect(media).toMatchObject({
      source: 'review_card',
      permanent: true,
      brief_id: 'review-proof',
      context_note: 'Custom digital family photo composition service',
      review_card_design: testReviewCardDesign(),
      render_spec_sha256: initial.generated_frame_briefs[0].render_spec_sha256,
    });
    expect(media.url).toContain('/api/social?action=mediaAsset');

    const ready = planSocialCreativeCampaign({
      listing,
      context,
      platforms: ['instagram'],
      providerConfigured: false,
      generatedMedia: [media],
      publicBaseUrl: 'https://manager.example.test',
      now: '2026-07-10T12:00:00.000Z',
    });
    expect(ready.status).toBe('ready_for_review');
    expect(ready.variants[0].media_items).toEqual([
      expect.objectContaining({ source: 'review_card', permanent: true }),
    ]);

    const revisedListing = {
      ...listing,
      listing_understanding: {
        ...listing.listing_understanding,
        media_strategy: {
          ...listing.listing_understanding.media_strategy,
          frames: listing.listing_understanding.media_strategy.frames.map(frame => ({
            ...frame,
            context_note: 'Custom digital memorial photo composition service',
          })),
        },
      },
    };
    const revisedContext = {
      ...context,
      listing_understanding: revisedListing.listing_understanding,
    };
    const staleAssetPlan = planSocialCreativeCampaign({
      listing: revisedListing,
      context: revisedContext,
      platforms: ['instagram'],
      providerConfigured: false,
      generatedMedia: [media],
      publicBaseUrl: 'https://manager.example.test',
      now: '2026-07-10T12:00:00.000Z',
    });
    expect(staleAssetPlan.status).toBe('needs_generation');
    expect(staleAssetPlan.storyboard[0]).toMatchObject({
      frame_id: 'review-proof',
      status: 'pending_generation',
    });
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (media?.id) {
      rmSync(`tmp/test-review-card-assets-${process.pid}/${media.id}.png`, { force: true });
      rmSync(`tmp/test-review-card-assets-${process.pid}/${media.id}.json`, { force: true });
    }
  }
});

test('geometry adapter center-crops provider pixels to the requested ratio', async () => {
  const input = await sharp({
    create: { width: 1200, height: 1200, channels: 4, background: '#7b4b2a' },
  }).png().toBuffer();
  const normalized = await normalizeGeneratedSocialImageGeometry({
    base64: input.toString('base64'),
    mimeType: 'image/png',
    aspectRatio: '4:5',
    cropFocus: 'center',
  });

  expect(normalized).toMatchObject({
    width: 960,
    height: 1200,
    requested_aspect_ratio: '4:5',
    normalization_applied: true,
    normalization_mode: 'center_cover_crop',
    crop_focus: 'center',
  });
});

test('2K JPEG social media stays JPEG instead of expanding into an oversized PNG', async () => {
  const source = await sharp({
    create: { width: 1792, height: 2400, channels: 3, background: { r: 168, g: 46, b: 52 } },
  }).jpeg({ quality: 92 }).toBuffer();
  const normalized = await normalizeGeneratedSocialImageGeometry({
    base64: source.toString('base64'),
    mimeType: 'image/jpeg',
    aspectRatio: '3:4',
  });
  const bytes = Buffer.from(normalized.base64, 'base64');
  const metadata = await sharp(bytes).metadata();

  expect(normalized).toMatchObject({
    mimeType: 'image/jpeg',
    width: 1792,
    height: 2400,
    requested_aspect_ratio: '3:4',
    normalization_applied: false,
  });
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
  expect(metadata.format).toBe('jpeg');
});

test('extraction boundary keeps application request-free and all focused production files below 50KB', () => {
  const files = [
    'api/modules/social/application/generate-media.js',
    'api/modules/social/domain/media-generation-contracts.js',
    'api/modules/social/infrastructure/media-provider-routing.js',
    'api/modules/social/infrastructure/media-geometry.js',
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    expect(Buffer.byteLength(source), file).toBeLessThan(50 * 1024);
  }
  const applicationSource = readFileSync(files[0], 'utf8');
  expect(applicationSource).not.toMatch(/from\s+['"]express|\breq\.|\bres\.|api\/social\.js/i);

  const facadeSource = readFileSync('api/social.js', 'utf8');
  const bridgeAction = facadeSource.slice(
    facadeSource.indexOf("case 'generateMedia':"),
    facadeSource.indexOf("case 'ideaPreview':"),
  );
  const adminAction = facadeSource.slice(
    facadeSource.indexOf("case 'adminGenerateMedia':"),
    facadeSource.indexOf("case 'postBuffer':"),
  );
  for (const action of [bridgeAction, adminAction]) {
    expect(action).toContain('generateSocialHermesMedia');
    expect(action).not.toMatch(/sharp|renderSocialReviewCard|reviewGeneratedSocialImage|generateImagesWithExternalAi/);
  }
});
