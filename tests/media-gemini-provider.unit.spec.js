import { expect, test } from '@playwright/test';

import { generateViaContent } from '../api/media/gemini-provider.js';

test('Gemini image transport preserves multimodal request and extracts image chunks', async () => {
  let request = null;
  const images = await generateViaContent(
    'test-key',
    'gemini-image-model',
    'Make a cover',
    '4:5',
    1,
    { base64: 'reference-data', mimeType: 'image/png' },
    null,
    async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ([{
          candidates: [{
            content: {
              parts: [
                { text: 'done' },
                { inlineData: { mimeType: 'image/png', data: 'generated-data' } },
              ],
            },
          }],
        }]),
      };
    },
  );

  expect(request.url).toContain('/v1beta/models/gemini-image-model:streamGenerateContent');
  expect(request.options.method).toBe('POST');
  expect(request.options.headers['x-goog-api-key']).toBe('test-key');
  expect(request.body.contents[0].parts).toEqual([
    { inlineData: { mimeType: 'image/png', data: 'reference-data' } },
    { text: 'Make a cover AR 4:5' },
  ]);
  expect(request.body.generationConfig).toEqual({
    responseModalities: ['IMAGE', 'TEXT'],
    thinkingConfig: { thinkingLevel: 'MINIMAL' },
    imageConfig: { imageSize: '1K' },
  });
  expect(images).toEqual([{ base64: 'generated-data', mimeType: 'image/png' }]);
});

test('Gemini image transport preserves non-retryable provider errors', async () => {
  await expect(generateViaContent(
    'test-key',
    'gemini-image-model',
    'Prompt',
    '1:1',
    1,
    null,
    null,
    async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad request' } }),
    }),
  )).rejects.toThrow('bad request');
});
