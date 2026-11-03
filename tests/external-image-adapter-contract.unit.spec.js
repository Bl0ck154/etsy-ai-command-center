import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.describe.configure({ mode: 'serial' });

const ENV_KEYS = [
  'EXTERNAL_AI_BASE_URL', 'EXTERNAL_AI_API_KEY', 'EXTERNAL_AI_IMAGE_PATH',
  'EXTERNAL_IMAGE_MODEL', 'EXTERNAL_IMAGE_ADAPTER', 'EXTERNAL_AI_PROVIDERS_JSON',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN',
];

function saveEnv() {
  return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureCodexRuntime() {
  process.env.EXTERNAL_AI_BASE_URL = 'http://127.0.0.1:20128/v1';
  process.env.EXTERNAL_AI_API_KEY = 'test-key';
  process.env.EXTERNAL_IMAGE_MODEL = 'codex/gpt-5.6-terra';
  process.env.EXTERNAL_AI_IMAGE_PATH = '/v1/responses';
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.EXTERNAL_AI_PROVIDERS_JSON;
}

test('Codex runtime fails closed when the image adapter is missing or unknown', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('provider must not be called');
  };
  try {
    configureCodexRuntime();
    delete process.env.EXTERNAL_IMAGE_ADAPTER;
    const missing = await import(`../api/_external-ai.js?missing-adapter=${Date.now()}`);
    await expect(missing.generateImagesWithExternalAi({ prompt: 'hero', count: 1 }))
      .rejects.toThrow(/EXTERNAL_IMAGE_ADAPTER must be explicitly configured/);

    process.env.EXTERNAL_IMAGE_ADAPTER = 'made_up_adapter';
    const unknown = await import(`../api/_external-ai.js?unknown-adapter=${Date.now()}`);
    await expect(unknown.generateImagesWithExternalAi({ prompt: 'hero', count: 1 }))
      .rejects.toThrow(/EXTERNAL_IMAGE_ADAPTER must be explicitly configured/);
    expect(fetchCalled).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('Codex runtime accepts only the Responses route', async () => {
  const saved = saveEnv();
  try {
    configureCodexRuntime();
    process.env.EXTERNAL_IMAGE_ADAPTER = 'openai_responses';
    process.env.EXTERNAL_AI_IMAGE_PATH = '/v1/images/generations';
    const module = await import(`../api/_external-ai.js?wrong-codex-path=${Date.now()}`);
    await expect(module.generateImagesWithExternalAi({ prompt: 'hero', count: 1 }))
      .rejects.toThrow(/requires EXTERNAL_IMAGE_ADAPTER=openai_responses and EXTERNAL_AI_IMAGE_PATH=\/v1\/responses/);
  } finally {
    restoreEnv(saved);
  }
});

test('explicit non-Codex providers retain legacy adapter support', async () => {
  const saved = saveEnv();
  try {
    process.env.EXTERNAL_AI_BASE_URL = 'https://text.example/v1';
    process.env.EXTERNAL_AI_API_KEY = 'text-key';
    delete process.env.EXTERNAL_IMAGE_MODEL;
    delete process.env.EXTERNAL_IMAGE_ADAPTER;
    delete process.env.EXTERNAL_AI_IMAGE_PATH;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.EXTERNAL_AI_PROVIDERS_JSON = JSON.stringify([{
      id: 'explicit-non-codex',
      baseUrl: 'https://images.example/v1',
      apiKey: 'image-key',
      image: {
        model: 'vendor/image-model',
        path: '/v1/images/generations',
        adapter: 'openai_images_json',
      },
    }]);
    const module = await import(`../api/_external-ai.js?explicit-provider=${Date.now()}`);
    const providers = await module.getExternalAiProviderChain('image');
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 'explicit-non-codex',
      imageAdapter: 'openai_images_json',
      imagePath: '/v1/images/generations',
    });
  } finally {
    restoreEnv(saved);
  }
});

test('KV image config rejects missing and unknown adapters without rewriting them to chat', async () => {
  const { normalizeExternalImageAdapter, assertExternalImageContract } = await import(`../api/kv.js?adapter-contract=${Date.now()}`);
  expect(normalizeExternalImageAdapter('made_up_adapter')).toBe('');
  expect(normalizeExternalImageAdapter()).toBe('');
  expect(() => assertExternalImageContract({
    imageModel: 'vendor/image-model',
    imagePath: '/v1/chat/completions',
    imageAdapter: normalizeExternalImageAdapter('made_up_adapter'),
  })).toThrow(/must be explicitly configured/);
  expect(() => assertExternalImageContract({
    imageModel: 'vendor/image-model',
    imagePath: '/v1/chat/completions',
    imageAdapter: normalizeExternalImageAdapter('chat_data_uri'),
  })).not.toThrow();
});

test('Settings exposes only the production Codex Responses contract', () => {
  const settings = fs.readFileSync(new URL('../public/pages/settings.js', import.meta.url), 'utf8');
  expect(settings).toContain('id="external-image-path" value="/v1/responses" readonly');
  expect(settings).toContain('id="external-image-adapter" value="openai_responses" readonly');
  expect(settings).not.toContain('<option value="chat_data_uri">');
  expect(settings).not.toContain('<option value="openai_images">');
  expect(settings).not.toContain("imageAdapter: document.getElementById('external-image-adapter')");
  expect(settings).toContain('id="external-image-reference-mode" value="provider_native" readonly');
  expect(settings).not.toContain('id="external-image-stream"');
  expect(settings).not.toContain('id="external-image-download-prefix"');
});
