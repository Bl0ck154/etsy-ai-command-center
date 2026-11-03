import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  agentHistoryPanelPresentation,
  agentMemoryPanelsPresentation,
} from '../public/utils/agent-panel-view-model.js';

test('memory panel presentation preserves both empty states', () => {
  expect(agentMemoryPanelsPresentation([], [])).toEqual({
    total: 0,
    badgeText: '',
    personalMarkup: '<div class="agent-memory-empty">No personal preferences saved.</div>',
    shopMarkup: '<div class="agent-memory-empty">No shared shop rules saved.</div>',
  });
});

test('memory panel presentation maps categories, copy, counts, and delete targets', () => {
  const personal = [
    { id: 'personal-1', category: 'preference', text: 'Prefer <short> titles' },
    { id: 'personal-2', category: 'unknown', text: 'Keep the original facts' },
  ];
  const shop = [
    { id: 'shop-1', category: 'rule', summary: 'Shared & verified' },
    { id: 'shop-2', details: 'Fallback details' },
  ];
  const personalSnapshot = structuredClone(personal);
  const shopSnapshot = structuredClone(shop);
  const presentation = agentMemoryPanelsPresentation(personal, shop);

  expect(presentation.total).toBe(4);
  expect(presentation.badgeText).toBe('4');
  expect(presentation.personalMarkup).toContain('color:var(--orange)');
  expect(presentation.personalMarkup).toContain('color:var(--text-3)');
  expect(presentation.personalMarkup).toContain('Prefer &lt;short&gt; titles');
  expect(presentation.personalMarkup).toContain("window.__deleteMemory('personal-1')");
  expect(presentation.shopMarkup).toContain('Shared &amp; verified');
  expect(presentation.shopMarkup).toContain('Fallback details');
  expect(presentation.shopMarkup).toContain("window.__deleteShopMemory('shop-2')");
  expect(personal).toEqual(personalSnapshot);
  expect(shop).toEqual(shopSnapshot);
});

test('history panel presentation filters current session and sorts a copy newest-first', () => {
  const sessions = [
    { id: 'old', last_at: 10, preview: 'Older conversation' },
    { id: 'current', last_at: 30, preview: 'Current conversation' },
    { id: 'new', last_at: 20, preview: '<Newest archived>' },
  ];
  const snapshot = structuredClone(sessions);
  const presentation = agentHistoryPanelPresentation(sessions, 'current', {
    formatDate: value => `date:${value}`,
  });

  expect(presentation.count).toBe(2);
  expect(presentation.sessions.map(session => session.id)).toEqual(['new', 'old']);
  expect(presentation.markup.indexOf("__loadHistorySession('new')"))
    .toBeLessThan(presentation.markup.indexOf("__loadHistorySession('old')"));
  expect(presentation.markup).toContain('date:20');
  expect(presentation.markup).toContain('&lt;Newest archived&gt;');
  expect(presentation.markup).not.toContain('Current conversation');
  expect(sessions).toEqual(snapshot);
});

test('history panel presentation keeps the existing empty message', () => {
  expect(agentHistoryPanelPresentation([{ id: 'current', last_at: 1 }], 'current'))
    .toEqual({
      count: 0,
      sessions: [],
      markup: '<div style="font-size:12px;color:var(--text-3)">No past conversations.</div>',
    });
  expect(agentHistoryPanelPresentation(null, '')).toMatchObject({ count: 0, sessions: [] });
});

test('Agent page delegates saved-panel presentation across a strict UI boundary', async () => {
  const pageSource = await fs.readFile(new URL('../public/pages/agent.js', import.meta.url), 'utf8');
  const viewModelSource = await fs.readFile(
    new URL('../public/utils/agent-panel-view-model.js', import.meta.url),
    'utf8',
  );
  const historyRenderer = pageSource.slice(
    pageSource.indexOf('async function renderHistoryPanel()'),
    pageSource.indexOf("historyBtn?.addEventListener('click'"),
  );

  expect(pageSource).toContain("from '../utils/agent-panel-view-model.js'");
  expect(pageSource).not.toContain('const CATEGORY_COLOR');
  expect(historyRenderer).toContain('agentHistoryPanelPresentation(');
  expect(historyRenderer).not.toContain('.sort(');
  expect(viewModelSource).not.toMatch(
    /document\.|localStorage|sessionStorage|idbHistory|agentMessages|normalizePlanUpdate|tool[_-]?result|fetch\(|systemPrompt/i,
  );
});
