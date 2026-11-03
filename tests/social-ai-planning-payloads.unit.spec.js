import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { createSocialAiPlanningPayloadBuilder } from '../api/modules/social/domain/ai-planning-payloads.js';

function normalizeText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeStringList(value, maxItems = 8, maxChars = 120) {
  return (Array.isArray(value) ? value : [])
    .map(item => normalizeText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function makeBuilder() {
  return createSocialAiPlanningPayloadBuilder({ normalizeText, normalizeStringList });
}

test('campaign payload preserves legacy aliases and source-opportunity fallback order', () => {
  const builder = makeBuilder();
  const payload = builder.compactCampaignContext({
    currentDate: ' 2026-08-11 ',
    currentYear: '2026',
    now: ' 2026-08-11T13:00:00Z ',
    campaign_moment: ' Summer gifting ',
    marketing_context: '  Seasonal context  ',
    source_opportunity: {
      type: ' trend ',
      source: ' calendar ',
      label: ' Late summer ',
      moment: ' August moment ',
      reason: ' Opportunity reason ',
    },
  });

  expect(payload).toEqual({
    current_date: '2026-08-11',
    current_year: 2026,
    current_iso: '2026-08-11T13:00:00Z',
    occasion: 'Summer gifting',
    reason: 'Opportunity reason',
    campaign_context: 'Seasonal context',
    local_signal: {
      type: 'trend',
      source: 'calendar',
      label: 'Late summer',
      moment: 'August moment',
    },
  });
});

test('campaign payload keeps direct context values ahead of source-opportunity fallbacks', () => {
  const builder = makeBuilder();
  const payload = builder.compactCampaignContext({
    current_date: '2026-08-12',
    current_year: 2027,
    current_iso: 'direct-iso',
    occasion: 'Direct occasion',
    reason: 'Direct reason',
    campaign_context: 'Direct context',
    source_opportunity: { label: 'Fallback', moment: 'Fallback moment', reason: 'Fallback reason' },
  });

  expect(payload).toMatchObject({
    current_date: '2026-08-12',
    current_year: 2027,
    current_iso: 'direct-iso',
    occasion: 'Direct occasion',
    reason: 'Direct reason',
    campaign_context: 'Direct context',
  });
});

test('listing payload preserves media_items precedence and listing aliases', () => {
  const builder = makeBuilder();
  const currentAvailability = { active_variation_combinations: [{ Size: 'A4' }] };
  const payload = builder.compactListingForUnderstanding({
    id: 42,
    listing_title: '  Custom portrait ',
    description_plain: ' Listing description ',
    tags: ['portrait', ' gift '],
    category: 'Art > Portraits',
    type: 'physical',
    materials: ['paper', ' ink '],
    amount: '29.00',
    listing_url: 'https://etsy.test/listing/42',
    current_availability: currentAvailability,
    media_items: [{
      rank: 7,
      alt_text: ' Main listing image ',
      full_width: 1200,
      full_height: 1500,
      role: 'hero',
      url_fullxfull: 'https://img.test/main.jpg',
    }],
    images: [{ url: 'https://img.test/ignored.jpg' }],
    image_urls: ['https://img.test/also-ignored.jpg'],
  });

  expect(payload).toMatchObject({
    listing_id: '42',
    title: 'Custom portrait',
    description: 'Listing description',
    tags: ['portrait', 'gift'],
    taxonomy: 'Art > Portraits',
    listing_type: 'physical',
    materials: ['paper', 'ink'],
    price: '29.00',
    url: 'https://etsy.test/listing/42',
    current_availability: currentAvailability,
    media: [{
      rank: 7,
      alt: 'Main listing image',
      width: 1200,
      height: 1500,
      source: 'hero',
      url: 'https://img.test/main.jpg',
    }],
    visual_analysis: null,
  });
});

test('listing payload falls back to images plus image_urls and caps media at ten', () => {
  const builder = makeBuilder();
  const images = Array.from({ length: 8 }, (_, index) => ({
    title: `Image ${index + 1}`,
    url_570xN: `https://img.test/${index + 1}.jpg`,
  }));
  const imageUrls = Array.from({ length: 5 }, (_, index) => `https://img.test/fallback-${index + 1}.jpg`);
  const payload = builder.compactListingForUnderstanding({ images, image_urls: imageUrls });

  expect(payload.media).toHaveLength(10);
  expect(payload.media[0]).toMatchObject({ rank: 1, alt: 'Image 1', url: 'https://img.test/1.jpg' });
  expect(payload.media[8]).toMatchObject({ rank: 9, url: 'https://img.test/fallback-1.jpg' });
  expect(payload.media[9]).toMatchObject({ rank: 10, url: 'https://img.test/fallback-2.jpg' });
});

test('visual-analysis payload preserves fields, raw scores and ten-image bound', () => {
  const builder = makeBuilder();
  const images = Array.from({ length: 12 }, (_, index) => ({
    rank: index === 0 ? '0' : String(index + 1),
    url: ` https://img.test/${index}.jpg `,
    social_use_decision: ' hero ',
    visible_summary: ' Visible product ',
    rationale: ' Strong evidence ',
    concerns: [' crop ', ' glare '],
    quality_score: index === 0 ? 0 : undefined,
    concept_relevance_score: index === 1 ? false : 0.75,
  }));
  const payload = builder.compactListingForUnderstanding({}, { provider: ' vision-provider ', images });

  expect(payload.visual_analysis.provider).toBe('vision-provider');
  expect(payload.visual_analysis.images).toHaveLength(10);
  expect(payload.visual_analysis.images[0]).toMatchObject({
    rank: null,
    social_use_decision: 'hero',
    visible_summary: 'Visible product',
    rationale: 'Strong evidence',
    concerns: ['crop', 'glare'],
    quality_score: 0,
    concept_relevance_score: 0.75,
  });
  expect(payload.visual_analysis.images[1].concept_relevance_score).toBe(false);
});

test('AI planning payload builder owns no AI transport, queue, publish, approval or HTTP behavior', () => {
  const source = readFileSync(new URL('../api/modules/social/domain/ai-planning-payloads.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(25_000);
  expect(source).not.toMatch(/generateWithExternalAi|generateWithSocialAi|getScheduledPosts|saveScheduledPost|publishSocialHermes|approveScheduledPost|AUTOPUBLISH|REAL_PUBLISH_RELEASE_APPROVED|express|\breq\b|\bres\b/);
});
