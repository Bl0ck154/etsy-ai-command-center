import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { stripMarkdownForEtsy } from '../api/etsy-text/plain-text.js';
import {
  sanitizeEtsyMaterials,
  sanitizeEtsyTags,
  sanitizeEtsyTitle,
} from '../api/etsy-text/field-sanitizers.js';
import { sanitizeListingAiResult } from '../api/etsy-text/listing-ai-sanitizer.js';

const facade = fs.readFileSync(new URL('../api/_etsy-text.js', import.meta.url), 'utf8');

test('plain-text normalization preserves readable content while removing markup', () => {
  expect(stripMarkdownForEtsy('## Details\n- **Soft** wool\n[Shop](https://etsy.com)')).toBe('Details\n• Soft wool\nShop https://etsy.com');
  expect(stripMarkdownForEtsy('<p>Hello&nbsp;<strong>world</strong></p>')).toBe('Hello world');
});

test('tags keep historical limits, case-insensitive dedupe and 20-char clamp', () => {
  const tags = sanitizeEtsyTags(['#Portrait', 'portrait', 'this tag is definitely much longer than twenty chars', ...Array.from({ length: 20 }, (_, i) => `tag ${i}`)]);
  expect(tags[0]).toBe('Portrait');
  expect(tags[1].length).toBeLessThanOrEqual(20);
  expect(tags.length).toBe(13);
});

test('title preserves first punctuation occurrence and expands later duplicates', () => {
  expect(sanitizeEtsyTitle('A & B & C + D + E')).toBe('A & B and C + D plus E');
});

test('materials strip punctuation, dedupe and retain 13-item cap', () => {
  const materials = sanitizeEtsyMaterials(['Cotton!', 'cotton', 'Silver / plated', ...Array.from({ length: 20 }, (_, i) => `Material ${i}`)]);
  expect(materials[0]).toBe('Cotton');
  expect(materials[1]).toBe('Silver plated');
  expect(materials.length).toBe(13);
});

test('listing AI sanitizer composes field policies without mutating source', () => {
  const source = {
    title: '**Portrait** & Art & Gift',
    description: '### Hello',
    tags: ['#Gift', 'gift'],
    materials: ['Paper!'],
    personalization_questions: [{ question_text: '**Name**', instructions: '<b>Tell us</b>', options: ['**One**'] }],
  };
  const clean = sanitizeListingAiResult(source);
  expect(clean).not.toBe(source);
  expect(clean.title).toBe('Portrait & Art and Gift');
  expect(clean.description).toBe('Hello');
  expect(clean.tags).toEqual(['Gift']);
  expect(clean.materials).toEqual(['Paper']);
  expect(clean.personalization_questions[0]).toMatchObject({ question_text: 'Name', instructions: 'Tell us', options: ['One'] });
  expect(source.title).toContain('**');
});

test('_etsy-text stays a compatibility facade', () => {
  expect(facade.split('\n').length).toBeLessThan(12);
  expect(facade).not.toContain('text.replace');
  expect(facade).toContain("from './etsy-text/plain-text.js'");
  expect(facade).toContain("from './etsy-text/field-sanitizers.js'");
});
