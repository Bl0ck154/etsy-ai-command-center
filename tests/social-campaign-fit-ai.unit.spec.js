import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import {
  createSocialCampaignFitAiStrategy,
  SOCIAL_CAMPAIGN_FIT_OUTPUT_SCHEMA,
  SOCIAL_CAMPAIGN_FIT_REPAIR_SYSTEM_PROMPT,
  SOCIAL_CAMPAIGN_FIT_SYSTEM_PROMPT,
} from '../api/modules/social/index.js';

function normalizeFit(raw, source) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!['strong_fit', 'acceptable_fit', 'weak_fit', 'mismatch'].includes(raw.decision)) return null;
  if (typeof raw.should_use_listing !== 'boolean') return null;
  return {
    available: true,
    source,
    decision: raw.decision,
    should_use_listing: raw.should_use_listing,
    confidence: Number(raw.confidence) || 0,
    rationale: String(raw.rationale || ''),
    natural_connection: String(raw.natural_connection || ''),
    safer_angle: String(raw.safer_angle || ''),
    risks: Array.isArray(raw.risks) ? raw.risks : [],
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
  };
}

function makeStrategy(overrides = {}) {
  const calls = [];
  const strategy = createSocialCampaignFitAiStrategy({
    normalizeListingCampaignFit: normalizeFit,
    compactCampaignContext: value => ({ moment: value?.moment || '' }),
    compactListing: value => ({ listing_id: String(value?.listing_id || ''), title: value?.title || '' }),
    isAiConfigured: async () => true,
    generateWithAi: async (...args) => {
      calls.push(args);
      return {
        decision: 'strong_fit',
        should_use_listing: true,
        confidence: 0.91,
        rationale: 'Direct semantic connection.',
        natural_connection: 'The listing directly serves the moment.',
        safer_angle: 'Stay on the listing facts.',
        risks: [],
        evidence: ['listing.title', 'campaign.moment'],
      };
    },
    responsePreview: value => JSON.stringify(value).slice(0, 600),
    text: (value, max = 1000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max),
    ...overrides,
  });
  return { strategy, calls };
}

test('campaign-fit AI strategy trusts a normalized caller-supplied decision without calling AI', async () => {
  const { strategy, calls } = makeStrategy();
  const result = await strategy.evaluate({
    listing: {
      listing_id: '11',
      listing_campaign_fit: {
        decision: 'acceptable_fit',
        should_use_listing: true,
        confidence: 0.8,
        rationale: 'Already reviewed.',
        natural_connection: 'Supported.',
        safer_angle: '',
        risks: [],
        evidence: ['listing_id'],
      },
    },
  });
  expect(result).toMatchObject({
    source: 'caller_supplied',
    decision: 'acceptable_fit',
    should_use_listing: true,
  });
  expect(calls).toHaveLength(0);
});

test('campaign-fit AI strategy fails closed when text AI is unavailable', async () => {
  const { strategy, calls } = makeStrategy({ isAiConfigured: async () => false });
  const result = await strategy.evaluate({ listing: { listing_id: '12' } });
  expect(result).toEqual({
    available: false,
    source: 'ai_unavailable',
    decision: 'unverified',
    should_use_listing: false,
    reason: 'External text AI is not configured.',
  });
  expect(calls).toHaveLength(0);
});

test('campaign-fit AI strategy sends only a classifier task and preserves the primary output contract', async () => {
  const { strategy, calls } = makeStrategy();
  const result = await strategy.evaluate({
    listing: { listing_id: '13', title: 'Custom photo restoration' },
    listingUnderstanding: { what_is_sold: 'Photo restoration service' },
    context: { moment: 'Family history month' },
  });

  expect(result).toMatchObject({
    source: 'external_ai',
    decision: 'strong_fit',
    should_use_listing: true,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe(SOCIAL_CAMPAIGN_FIT_SYSTEM_PROMPT);
  expect(calls[0][2]).toBe(SOCIAL_CAMPAIGN_FIT_OUTPUT_SCHEMA);
  expect(calls[0][3]).toEqual({ task: 'campaign_fit', maxTokens: 4_000 });
  expect(JSON.parse(calls[0][1])).toEqual({
    campaign: { moment: 'Family history month' },
    listing: { listing_id: '13', title: 'Custom photo restoration' },
    listing_understanding: { what_is_sold: 'Photo restoration service' },
  });
  expect(SOCIAL_CAMPAIGN_FIT_SYSTEM_PROMPT).toContain('Do not write campaign copy, captions, headlines, markdown, or recommendations.');
});

test('campaign-fit AI strategy repairs an invalid primary response without changing campaign/listing facts', async () => {
  const generated = [];
  const { strategy } = makeStrategy({
    generateWithAi: async (...args) => {
      generated.push(args);
      if (generated.length === 1) return { Primary_Caption: 'Buy this now' };
      return {
        decision: 'weak_fit',
        should_use_listing: false,
        confidence: 0.72,
        rationale: 'Connection is generic.',
        natural_connection: 'Only broad seasonal overlap.',
        safer_angle: 'Use an evergreen listing story instead.',
        risks: ['Forced seasonal tie-in'],
        evidence: ['listing.title'],
      };
    },
  });

  const result = await strategy.evaluate({
    listing: { listing_id: '14', title: 'Portrait edit' },
    context: { moment: 'Generic summer moment' },
  });

  expect(result).toMatchObject({
    source: 'external_ai_repair',
    decision: 'weak_fit',
    should_use_listing: false,
    repair_used: true,
  });
  expect(generated).toHaveLength(2);
  expect(generated[1][0]).toBe(SOCIAL_CAMPAIGN_FIT_REPAIR_SYSTEM_PROMPT);
  expect(generated[1][3]).toEqual({ task: 'campaign_fit_repair', maxTokens: 4_000 });
  const repairPayload = JSON.parse(generated[1][1]);
  expect(repairPayload).toMatchObject({
    campaign: { moment: 'Generic summer moment' },
    listing: { listing_id: '14', title: 'Portrait edit' },
    previous_response: { Primary_Caption: 'Buy this now' },
  });
});

test('campaign-fit AI strategy keeps an invalid repair explicitly unverified', async () => {
  const { strategy } = makeStrategy({
    generateWithAi: async () => ({ caption: 'not a classifier response' }),
  });
  const result = await strategy.evaluate({ listing: { listing_id: '15' } });
  expect(result).toMatchObject({
    available: false,
    source: 'ai_invalid_response',
    decision: 'unverified',
    should_use_listing: false,
  });
  expect(result.raw_preview).toContain('caption');
  expect(result.repair_response_preview).toContain('caption');
});

test('campaign-fit AI strategy keeps provider errors fail closed', async () => {
  const { strategy } = makeStrategy({
    generateWithAi: async () => { throw new Error('provider timeout'); },
  });
  await expect(strategy.evaluate({ listing: { listing_id: '16' } })).resolves.toEqual({
    available: false,
    source: 'ai_error',
    decision: 'unverified',
    should_use_listing: false,
    reason: 'provider timeout',
  });
});

test('campaign-fit adapter owns no route, queue, publish or approval behavior', () => {
  const source = readFileSync(new URL('../api/modules/social/infrastructure/campaign-fit-ai.js', import.meta.url), 'utf8');
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(50_000);
  expect(source).not.toMatch(/express|\breq\b|\bres\b|getScheduledPosts|saveScheduledPost|publish|approve|AUTOPUBLISH|REAL_PUBLISH_RELEASE_APPROVED/i);
  expect(source).toContain("task: 'campaign_fit'");
  expect(source).toContain("task: 'campaign_fit_repair'");
});
