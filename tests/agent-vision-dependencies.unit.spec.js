import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

const VISION_PATH = new URL('../api/agent/vision.js', import.meta.url);
const HELPERS_PATH = new URL('../api/agent/helpers.js', import.meta.url);

test('vision module does not statically depend on broad Agent helpers or tool dispatcher', async () => {
  const source = await fs.readFile(VISION_PATH, 'utf8');

  expect(source).not.toMatch(/from\s+['"]\.\/helpers\.js['"]/);
  expect(source).not.toMatch(/from\s+['"]\.\/tools-dispatch\.js['"]/);
  expect(source).toContain("from './listing-language.js'");
});

test('listing-detail fallback keeps the existing dispatcher behind a lazy boundary', async () => {
  const source = await fs.readFile(VISION_PATH, 'utf8');

  expect(source).toContain("await import('./tools-dispatch.js')");
  expect(source).toContain("executeTool('get_listing_details'");
});

test('broad helper facade re-exports the focused listing-language owner without compatibility copies', async () => {
  const source = await fs.readFile(HELPERS_PATH, 'utf8');

  expect(source).toContain("from './listing-language.js'");
  for (const helper of [
    'hasCyrillic',
    'listingContentHasCyrillic',
    'fallbackEnglishDuplicateTitle',
    'fallbackEnglishDuplicateDescription',
    'englishFileUploadQuestions',
    'latestUserText',
  ]) {
    expect(source).not.toMatch(new RegExp(`export\\s+function\\s+${helper}\\s*\\(`));
  }
});
