import { expect, test } from '@playwright/test';
import { analyzeSocialListingImages } from '../api/_social-media-quality.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function listingImages(count = 10) {
  return Array.from({ length: count }, (_, index) => ({
    rank: index + 1,
    url: `https://i.etsystatic.com/123/listing-rank-${index + 1}.png`,
  }));
}

function visionResponseFor(body) {
  const content = body.messages[0].content;
  if (typeof content === 'string') {
    const marker = 'Complete gallery evidence: ';
    const facts = JSON.parse(content.slice(content.indexOf(marker) + marker.length));
    const images = facts.batch_pixel_analysis.flatMap(batch => batch.images).map(item => ({
      rank: item.rank,
      social_use_decision: item.batch_decision,
      quality_score: item.batch_quality_score,
      concept_relevance_score: item.batch_concept_relevance_score,
      visible_summary: item.visible_summary,
      rationale: item.rationale,
      concerns: item.concerns,
    }));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        overall_summary: `Adjudicated exact ranks ${images.map(item => item.rank).join(', ')}.`,
        images,
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  const ranks = content
    .filter(part => part.type === 'text' && /^Listing image rank \d+:$/.test(part.text))
    .map(part => Number(part.text.match(/\d+/)[0]));
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      overall_summary: `Analyzed exact ranks ${ranks.join(', ')}.`,
      images: ranks.map(rank => ({
        rank,
        social_use_decision: rank >= 9 ? 'hero' : 'support',
        quality_score: 70 + rank,
        concept_relevance_score: 60 + rank,
        visible_summary: `Visible evidence from Etsy gallery rank ${rank}.`,
        rationale: `Decision based on pixels for rank ${rank}.`,
        concerns: [],
      })),
    }) } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test.describe('bounded Etsy listing gallery vision', () => {
  let originalFetch;
  let originalEnv;

  test.beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = {
      EXTERNAL_AI_BASE_URL: process.env.EXTERNAL_AI_BASE_URL,
      EXTERNAL_AI_API_KEY: process.env.EXTERNAL_AI_API_KEY,
      EXTERNAL_VISION_MODEL: process.env.EXTERNAL_VISION_MODEL,
    };
    process.env.EXTERNAL_AI_BASE_URL = 'https://vision.example.test/v1';
    process.env.EXTERNAL_AI_API_KEY = 'vision-token';
    process.env.EXTERNAL_VISION_MODEL = 'reasoning-vision-model';
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('analyzes ranks 9 and 10 in bounded batches and preserves exact rank and URL', async () => {
    const providerBatches = [];
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('i.etsystatic.com')) {
        return new Response(ONE_PIXEL_PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      const body = JSON.parse(options.body);
      providerBatches.push(body);
      return visionResponseFor(body);
    };

    const result = await analyzeSocialListingImages({
      listing: { listing_id: 'gallery-10', title: 'Ten-image listing', images: listingImages(10) },
      campaignContext: { goal: 'Choose social evidence using AI vision.' },
    });

    expect(result).toMatchObject({ available: true, complete: true, analyzed_count: 10, expected_count: 10, batch_count: 3 });
    expect(providerBatches
      .filter(body => Array.isArray(body.messages[0].content))
      .map(body => body.messages[0].content.filter(part => part.type === 'image_url').length))
      .toEqual([4, 4, 2]);
    expect(result.images.find(item => item.rank === 9)).toMatchObject({
      rank: 9,
      url: 'https://i.etsystatic.com/123/listing-rank-9.png',
      social_use_decision: 'hero',
    });
    expect(result.images.find(item => item.rank === 10)).toMatchObject({
      rank: 10,
      url: 'https://i.etsystatic.com/123/listing-rank-10.png',
      social_use_decision: 'hero',
    });
  });

  test('analyzes every gallery rank exactly once', async () => {
    const requestedRanks = [];
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('i.etsystatic.com')) {
        return new Response(ONE_PIXEL_PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      const body = JSON.parse(options.body);
      if (Array.isArray(body.messages[0].content)) {
        const ranks = body.messages[0].content
          .filter(part => part.type === 'text' && /^Listing image rank \d+:$/.test(part.text))
          .map(part => Number(part.text.match(/\d+/)[0]));
        requestedRanks.push(...ranks);
      }
      return visionResponseFor(body);
    };

    const result = await analyzeSocialListingImages({ listing: { images: listingImages(10) } });

    expect(requestedRanks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(requestedRanks).size).toBe(10);
    expect(result.images.map(item => item.rank)).toEqual(requestedRanks);
  });

  test('fails closed when any batch fails instead of returning a partial complete result', async () => {
    let providerCall = 0;
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('i.etsystatic.com')) {
        return new Response(ONE_PIXEL_PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      providerCall += 1;
      if (providerCall === 2) {
        return new Response(JSON.stringify({ error: { message: 'vision batch unavailable' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return visionResponseFor(JSON.parse(options.body));
    };

    await expect(analyzeSocialListingImages({ listing: { images: listingImages(10) } }))
      .rejects.toThrow('Listing vision batch 2 of 3 failed: vision batch unavailable');
    expect(providerCall).toBe(2);
  });
});
