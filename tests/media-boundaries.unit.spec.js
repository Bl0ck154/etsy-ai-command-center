import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const route = fs.readFileSync(new URL('../api/media.js', import.meta.url), 'utf8');
const application = fs.readFileSync(new URL('../api/media/application.js', import.meta.url), 'utf8');
const imageGeneration = fs.readFileSync(new URL('../api/media/image-generation.js', import.meta.url), 'utf8');
const geminiProvider = fs.readFileSync(new URL('../api/media/gemini-provider.js', import.meta.url), 'utf8');
const reviewProxy = fs.readFileSync(new URL('../api/media/review-image-proxy.js', import.meta.url), 'utf8');

test('media HTTP entry remains a thin action adapter with compatibility export', () => {
  expect(route).toContain("export { generateMediaImages } from './media/image-generation.js';");
  expect(route).toContain("from './media/application.js'");
  expect(route).toContain("from './media/review-image-proxy.js'");
  expect(route).not.toContain('generativelanguage.googleapis.com');
  expect(route).not.toContain('process.env.GEMINI_API_KEY');
  expect(route).not.toContain('generateImagesWithExternalAi');
  expect(route).not.toContain('getMetaAiCookieHeader');
  expect(route).not.toContain('streamGenerateContent');
  expect(route.split('\n').length).toBeLessThan(90);
});

test('analyzeImage retains the historical explicit missing-key response', () => {
  expect(route).toContain("err?.message === 'GEMINI_API_KEY not configured'");
  expect(route).toContain("res.status(500).json({ error: 'GEMINI_API_KEY not configured' })");
});

test('media application owns video, animation and vision action orchestration', () => {
  expect(application).toContain('async function generateVideoAction(');
  expect(application).toContain('async function animateImageAction(');
  expect(application).toContain('async function analyzeImageAction(');
  expect(application).toContain("prompt: input.prompt || 'Animate this image into a short video.'");
});

test('provider selection and Gemini transport have separate owners', () => {
  expect(imageGeneration).toContain('hasExternalImageConfigAsync');
  expect(imageGeneration).toContain('EXTERNAL_IMAGE_BATCH_INCOMPLETE');
  expect(imageGeneration).toContain('generateGeminiMediaImages');
  expect(geminiProvider).toContain('GEMINI_API_KEY_');
  expect(geminiProvider).toContain(':streamGenerateContent');
  expect(geminiProvider).toContain("thinkingLevel: 'MINIMAL'");
});

test('review proxy security remains isolated from generation providers', () => {
  expect(reviewProxy).toContain("url.hostname === 'i.etsystatic.com'");
  expect(reviewProxy).toContain('MAX_REVIEW_IMAGE_BYTES');
  expect(reviewProxy).toContain("'X-Content-Type-Options'");
  expect(reviewProxy).not.toContain('GEMINI_API_KEY');
  expect(reviewProxy).not.toContain('generateMetaAi');
});
