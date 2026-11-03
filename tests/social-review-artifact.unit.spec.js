import { test, expect } from '@playwright/test';
import {
  consumeSocialHermesReviewArtifact,
  createSocialReviewArtifactService,
  issueSocialHermesReviewArtifact,
  socialHermesReviewContentDigest,
} from '../api/modules/social/index.js';
import {
  consumeSocialHermesReviewArtifactForTest as consumeReviewArtifactFromFacade,
  issueSocialHermesReviewArtifactForTest as issueReviewArtifactFromFacade,
  socialHermesReviewContentDigest as socialHermesReviewContentDigestFromFacade,
} from '../api/social.js';

function kvFetchStore() {
  const store = new Map();
  const calls = [];
  const fetch = async url => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    calls.push(parts);
    const command = String(parts[0] || '').toUpperCase();
    const key = parts[1] || '';
    if (command === 'GET') {
      return new Response(JSON.stringify({ result: store.get(key) ?? null }), { status: 200 });
    }
    if (command === 'SET') {
      if (parts.includes('NX') && store.has(key)) {
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }
      store.set(key, parts[2]);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  };
  return { calls, fetch, store };
}

function reviewedPlanAndVariant() {
  const caption = 'A real family keepsake story, prepared for owner review.';
  const media = [{
    url: 'https://i.etsystatic.com/123/family.jpg',
    type: 'image',
    source: 'listing_image',
    checksum_sha256: 'a'.repeat(64),
  }];
  const captionReview = {
    approved: true,
    decision: 'approve',
    reviewed_caption: caption,
    rationale: 'The exact caption is factual and platform appropriate.',
  };
  const campaignReview = {
    approved: true,
    decision: 'approve',
    quality_contract_version: 2,
    campaign_goal_met: true,
    blocking_reasons: [],
    rationale: 'The image visibly supports the campaign.',
    platform_reviews: [{ platform: 'facebook', decision: 'approve', rationale: 'Strong evidence.' }],
  };
  const mediaStrategy = {
    frames: [{ id: 'proof', source: 'listing_image' }],
    platform_variants: { facebook: { format: 'single', frame_ids: ['proof'] } },
  };
  const variant = {
    platform: 'facebook',
    caption,
    media_items: media,
    readiness: 'media_ready',
    caption_quality_review: captionReview,
  };
  return {
    plan: {
      status: 'ready_for_review',
      campaign_quality_review: campaignReview,
      media_strategy: mediaStrategy,
    },
    variant,
  };
}

test.describe('server-issued Social Hermes AI review artifacts', () => {
  const originalFetch = global.fetch;
  const savedEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    SESSION_SECRET: process.env.SESSION_SECRET,
  };

  test.beforeEach(() => {
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'kv-token';
    process.env.SESSION_SECRET = 'server-only-review-artifact-secret-for-tests';
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('restores only server-reviewed metadata and rejects artifact replay', async () => {
    const kv = kvFetchStore();
    global.fetch = kv.fetch;
    const { plan, variant } = reviewedPlanAndVariant();
    const token = await issueSocialHermesReviewArtifact(plan, variant);
    const artifactId = token.split('.')[0];
    expect(kv.calls.some(parts => parts[0] === 'SET'
      && parts[1].endsWith(`:social_review_artifact:${artifactId}`)
      && parts.at(-2) === 'EX'
      && parts.at(-1) === '21600')).toBe(true);
    const forgedReview = { approved: true, decision: 'approve', reviewed_caption: variant.caption, rationale: 'forged' };
    const verified = await consumeSocialHermesReviewArtifact(variant, {
      ai_review_artifact: token,
      ai_caption_quality_review: forgedReview,
      media_strategy: { forged: true },
    });

    expect(verified.verified).toBe(true);
    expect(verified.metadata.ai_caption_quality_review).toEqual(variant.caption_quality_review);
    expect(verified.metadata.media_strategy).toEqual(plan.media_strategy);
    expect(verified.metadata.ai_review_artifact_id).toMatch(/^sra_[a-f0-9]{32}$/);
    expect(kv.calls.some(parts => parts[0] === 'SET'
      && parts[1].endsWith(`:social_review_artifact_consumed:${artifactId}`)
      && parts.includes('NX')
      && parts.at(-2) === 'EX'
      && parts.at(-1) === '21600')).toBe(true);
    await expect(consumeSocialHermesReviewArtifact(variant, { ai_review_artifact: token }))
      .rejects.toMatchObject({ code: 'AI_REVIEW_ARTIFACT_REPLAYED' });
  });

  test('rejects changed caption or media after server review', async () => {
    const kv = kvFetchStore();
    global.fetch = kv.fetch;
    const { plan, variant } = reviewedPlanAndVariant();
    const token = await issueSocialHermesReviewArtifact(plan, variant);
    await expect(consumeSocialHermesReviewArtifact({ ...variant, caption: `${variant.caption} Changed.` }, {
      ai_review_artifact: token,
    })).rejects.toMatchObject({ code: 'AI_REVIEW_ARTIFACT_CONTENT_CHANGED' });
  });

  test('strips caller-supplied approval metadata when no artifact exists', async () => {
    const { variant } = reviewedPlanAndVariant();
    const result = await consumeSocialHermesReviewArtifact(variant, {
      ai_caption_quality_review_required: true,
      ai_caption_quality_review: variant.caption_quality_review,
      ai_campaign_visual_quality_review_required: true,
      ai_campaign_visual_quality_review: { approved: true, decision: 'approve' },
      media_strategy: { forged: true },
      harmless_campaign_label: 'keep me',
    });
    expect(result.verified).toBe(false);
    expect(result.metadata).toEqual({ harmless_campaign_label: 'keep me' });
  });

  test('plain-data service preserves invalid, expired, and obsolete error codes', async () => {
    const artifacts = new Map();
    const claims = new Set();
    let now = Date.parse('2026-08-09T12:00:00.000Z');
    const repository = {
      getArtifact: async id => artifacts.get(id) || null,
      saveArtifact: async (id, artifact) => artifacts.set(id, artifact),
      claimArtifact: async id => claims.has(id) ? false : (claims.add(id), true),
    };
    const service = createSocialReviewArtifactService({
      repository,
      secret: 'plain-data-review-artifact-secret-for-tests',
      now: () => now,
      randomBytes: () => Buffer.alloc(16, 0xab),
    });
    const { plan, variant } = reviewedPlanAndVariant();

    await expect(service.consume(variant, { ai_review_artifact: 'malformed' }))
      .rejects.toMatchObject({ code: 'AI_REVIEW_ARTIFACT_INVALID' });

    const expiredToken = await service.issue(plan, variant);
    now += (6 * 60 * 60 * 1000) + 1;
    await expect(service.consume(variant, { ai_review_artifact: expiredToken }))
      .rejects.toMatchObject({ code: 'AI_REVIEW_ARTIFACT_EXPIRED' });

    now = Date.parse('2026-08-09T12:00:00.000Z');
    const obsoleteToken = await service.issue(plan, variant);
    artifacts.get(obsoleteToken.split('.')[0]).version = 1;
    await expect(service.consume(variant, { ai_review_artifact: obsoleteToken }))
      .rejects.toMatchObject({ code: 'AI_REVIEW_ARTIFACT_OBSOLETE' });
  });

  test('legacy social facade preserves the review-artifact public contract', async () => {
    const kv = kvFetchStore();
    global.fetch = kv.fetch;
    const { plan, variant } = reviewedPlanAndVariant();
    const token = await issueReviewArtifactFromFacade(plan, variant);
    const verified = await consumeReviewArtifactFromFacade(variant, { ai_review_artifact: token });

    expect(verified.verified).toBe(true);
    expect(verified.metadata.ai_review_artifact_id).toMatch(/^sra_[a-f0-9]{32}$/);
    expect(socialHermesReviewContentDigestFromFacade(variant)).toBe(socialHermesReviewContentDigest(variant));
  });
});
