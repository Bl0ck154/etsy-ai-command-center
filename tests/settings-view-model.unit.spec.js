import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  etsyGuidanceStatusPresentation,
  guidanceDateLabel,
  guidanceRuleDiffMarkup,
} from '../public/utils/settings-view-model.js';

test('guidance date labels preserve empty and invalid status values', () => {
  expect(guidanceDateLabel(null)).toBe('Not checked yet');
  expect(guidanceDateLabel('legacy-check-label')).toBe('legacy-check-label');
  expect(guidanceDateLabel('2026-08-09T10:00:00.000Z')).not.toBe('2026-08-09T10:00:00.000Z');
});

test('guidance status normalization follows error, candidate, stale, current precedence', () => {
  expect(etsyGuidanceStatusPresentation({
    candidate: { id: 'candidate' },
    monitor: { stale: true, lastError: 'network failed' },
  })).toMatchObject({
    statusText: 'Last check failed',
    statusColor: 'var(--red-text)',
  });
  expect(etsyGuidanceStatusPresentation({
    candidate: { id: 'candidate' },
    monitor: { stale: true },
  })).toMatchObject({
    statusText: 'Update awaiting review',
    statusColor: 'var(--orange)',
  });
  expect(etsyGuidanceStatusPresentation({ monitor: { stale: true } })).toMatchObject({
    statusText: 'Official sources need checking',
    statusColor: 'var(--orange)',
  });
  expect(etsyGuidanceStatusPresentation({ monitor: {} })).toMatchObject({
    statusText: 'Current',
    statusColor: 'var(--green-text)',
  });
});

test('guidance rule diff marks only rules absent from the active revision', () => {
  const markup = guidanceRuleDiffMarkup({
    rules: {
      title: ['USE CLEAR TITLES', '<Add buyer language>'],
      discovery: [],
      description: [],
      photos: [],
    },
  }, {
    rules: { title: ['Use clear titles'] },
  });

  expect(markup).toContain('Titles');
  expect(markup).toContain('<li>USE CLEAR TITLES</li>');
  expect(markup).toContain('New:</strong> &lt;Add buyer language&gt;');
  expect(markup.match(/New:<\/strong>/g)).toHaveLength(1);
  expect(guidanceRuleDiffMarkup(null, null)).toBe('');
});

test('candidate presentation includes evidence, controls, sources, and fallback action', () => {
  const presentation = etsyGuidanceStatusPresentation({
    active: {
      reviewedAt: '2026-07-01',
      origin: 'approved-monitor',
      rules: { title: ['Existing rule'] },
    },
    candidate: {
      id: 'candidate-2',
      changeSummary: '<Official change>',
      rules: { title: ['Existing rule', 'New rule'] },
      evidence: [{ excerpt: 'one' }, { excerpt: 'two' }],
    },
    monitor: {
      lastCheckedAt: '2026-08-09T10:00:00.000Z',
      nextAutomaticCheck: 'weekly',
    },
    officialSources: [
      { url: 'https://etsy.test/guidance?a=1&b=2', label: '<Etsy guidance>' },
    ],
  }, {
    formatDate: () => 'Aug 9, 2026',
  });

  expect(presentation.markup).toContain('Proposed revision: candidate-2');
  expect(presentation.markup).toContain('&lt;Official change&gt;');
  expect(presentation.markup).toContain('2 source excerpts validated.');
  expect(presentation.markup).toContain('id="etsy-guidance-approve"');
  expect(presentation.markup).toContain('id="etsy-guidance-dismiss"');
  expect(presentation.markup).toContain('Restore bundled fallback');
  expect(presentation.markup).toContain('https://etsy.test/guidance?a=1&amp;b=2');
  expect(presentation.markup).toContain('&lt;Etsy guidance&gt;');
  expect(presentation.markup).toContain('Aug 9, 2026');
});

test('bundled current presentation omits review and restore controls', () => {
  const presentation = etsyGuidanceStatusPresentation({
    active: { reviewedAt: 'Bundled fallback', origin: 'bundled' },
    monitor: { lastCheckedAt: null },
  });

  expect(presentation.markup).toContain('Not checked yet');
  expect(presentation.markup).not.toContain('etsy-guidance-approve');
  expect(presentation.markup).not.toContain('Restore bundled fallback');
});

test('Settings page delegates presentation without moving credential or API flows', async () => {
  const pageSource = await fs.readFile(new URL('../public/pages/settings.js', import.meta.url), 'utf8');
  const viewModelSource = await fs.readFile(
    new URL('../public/utils/settings-view-model.js', import.meta.url),
    'utf8',
  );

  expect(pageSource).toContain("from '../utils/settings-view-model.js'");
  expect(pageSource).not.toContain('function formatGuidanceDate(');
  expect(pageSource).not.toContain('function renderGuidanceRuleDiff(');
  expect(pageSource).toContain('etsyGuidanceStatusPresentation(data, { escapeHtml: escHtml })');
  expect(viewModelSource).not.toMatch(/localStorage|sessionStorage|fetchJson|etsyGuidance\.|getTokenStatus|apiKey/i);
});
