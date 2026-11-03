import fs from 'node:fs';
import { expect, test } from '@playwright/test';

import {
  AUDIT_SYSTEM,
  buildFullListingAuditPrompt,
  buildSeoAuditPrompt,
} from '../public/components/seo-audit-contracts.js';

const componentSource = fs.readFileSync(new URL('../public/components/seo-audit.js', import.meta.url), 'utf8');
const contractSource = fs.readFileSync(new URL('../public/components/seo-audit-contracts.js', import.meta.url), 'utf8');

test('compact SEO audit contract preserves JSON schema and grading rules', () => {
  expect(AUDIT_SYSTEM).toContain('Return ONLY valid JSON, no markdown:');
  expect(AUDIT_SYSTEM).toContain('"status": "pass|warn|fail"');
  expect(AUDIT_SYSTEM).toContain('Title (length, keywords, front-loading)');
  expect(AUDIT_SYSTEM).toContain('Score 0-100. Grade: A=90+, B=75+, C=60+, D=below 60.');
});

test('compact audit prompt preserves listing projection, truncation and price math', () => {
  const prompt = buildSeoAuditPrompt({
    title: 'Example title',
    description: 'x'.repeat(650),
    tags: ['one', 'two'],
    materials: ['PNG', 'SVG'],
    price: { amount: 1299, divisor: 100 },
    listing_type: 'download',
    images: [{}, {}, {}],
    views: 42,
    num_favorers: 7,
  });

  expect(prompt).toContain('Title: Example title');
  expect(prompt).toContain(`Description (first 600 chars): ${'x'.repeat(600)}`);
  expect(prompt).not.toContain('x'.repeat(601));
  expect(prompt).toContain('Tags (2/13): one, two');
  expect(prompt).toContain('Materials: PNG, SVG');
  expect(prompt).toContain('Price: $12.99');
  expect(prompt).toContain('Type: download');
  expect(prompt).toContain('Images: 3');
  expect(prompt).toContain('Views: 42');
  expect(prompt).toContain('Favorites: 7');
  expect(prompt).toContain('Shop niche: Canva templates, SVG/PNG sublimation bundles, AI photo services, custom portraits. US market.');
});

test('compact audit prompt preserves unknown image fallback and price divisor fallback', () => {
  const prompt = buildSeoAuditPrompt({ price: { amount: 500 } });
  expect(prompt).toContain('Price: $5.00');
  expect(prompt).toContain('Images: unknown');
});

test('full audit contract preserves 2026 field scoring and 300-char description slice', () => {
  const prompt = buildFullListingAuditPrompt({
    title: 'Title',
    tags: ['tag-a'],
    price: { amount: 2500, divisor: 100 },
    listing_type: 'physical',
    is_personalizable: true,
    description: 'd'.repeat(350),
  });

  expect(prompt).toContain('Etsy listing full audit (2026 algorithm):');
  expect(prompt).toContain('Title (5/140): "Title"');
  expect(prompt).toContain('Tags (1/13): tag-a');
  expect(prompt).toContain('Price: $25.00');
  expect(prompt).toContain('Has personalization: yes');
  expect(prompt).toContain(`Description (350 chars): "${'d'.repeat(300)}..."`);
  expect(prompt).toContain('## Overall Score: X/100');
  expect(prompt).toContain('## Top 5 Priority Improvements (ranked by impact)');
  expect(prompt).toContain('## Rewritten first 160 chars (Google snippet)');
});

test('SEO audit component delegates prompt ownership without changing transport/render ownership', () => {
  expect(componentSource).toContain("from './seo-audit-contracts.js'");
  expect(componentSource).toContain('_rawPrompt: buildSeoAuditPrompt(listing)');
  expect(componentSource).toContain('_rawSystem: AUDIT_SYSTEM');
  expect(componentSource).toContain('_rawPrompt: buildFullListingAuditPrompt(listing)');
  expect(componentSource).toContain("postJson('/api/ai'");
  expect(componentSource).toContain('renderAuditModal(listing, data.data)');
  expect(componentSource).not.toContain('Return ONLY valid JSON, no markdown:');
  expect(componentSource).not.toContain('Etsy listing full audit (2026 algorithm):');
  expect(contractSource).not.toContain('document.');
  expect(contractSource).not.toContain('openModal(');
});
