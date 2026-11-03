import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test.describe.configure({ mode: 'serial' });

const CONFIG_KEYS = [
  'EXTERNAL_AI_BASE_URL', 'EXTERNAL_AI_API_KEY', 'EXTERNAL_AI_MODEL', 'EXTERNAL_AI_TEXT_PATH', 'EXTERNAL_AI_IMAGE_PATH',
  'EXTERNAL_IMAGE_BASE_URL', 'EXTERNAL_IMAGE_API_KEY', 'EXTERNAL_IMAGE_MODEL', 'EXTERNAL_IMAGE_ADAPTER',
  'EXTERNAL_IMAGE_REFERENCE_MODE', 'EXTERNAL_IMAGE_RESPONSE_FORMAT', 'EXTERNAL_AI_PROVIDERS_JSON', 'EXTERNAL_AI_PRIMARY_PROVIDER_ID',
  'OMNIROUTE_BASE_URL', 'OMNIROUTE_API_KEY', 'OMNIROUTE_TEXT_MODEL', 'OMNIROUTE_IMAGE_MODEL',
  'FALLBACK_BASE_URL', 'FALLBACK_API_KEY', 'FALLBACK_IMAGE_BASE_URL', 'FALLBACK_IMAGE_API_KEY',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN',
];

function saveEnv() {
  return Object.fromEntries(CONFIG_KEYS.map(key => [key, process.env[key]]));
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureProviderChain({ fallbackToolCalling = false } = {}) {
  process.env.EXTERNAL_AI_BASE_URL = 'https://primary.example/v1';
  process.env.EXTERNAL_AI_API_KEY = 'primary-secret';
  process.env.EXTERNAL_AI_MODEL = 'primary/reasoning';
  process.env.EXTERNAL_AI_TEXT_PATH = '/v1/chat/completions';
  process.env.EXTERNAL_IMAGE_BASE_URL = 'https://primary.example';
  process.env.EXTERNAL_IMAGE_MODEL = 'primary/image';
  process.env.EXTERNAL_AI_IMAGE_PATH = '/images/generations';
  process.env.EXTERNAL_IMAGE_ADAPTER = 'openai_images_json';
  process.env.EXTERNAL_IMAGE_REFERENCE_MODE = 'provider_native';
  process.env.FALLBACK_BASE_URL = 'https://fallback.example/v1';
  process.env.FALLBACK_IMAGE_BASE_URL = 'https://fallback.example';
  process.env.FALLBACK_API_KEY = 'fallback-secret';
  process.env.EXTERNAL_AI_PROVIDERS_JSON = JSON.stringify([{
    id: 'omniroute-antigravity',
    baseUrlEnv: 'FALLBACK_BASE_URL',
    apiKeyEnv: 'FALLBACK_API_KEY',
    text: {
      model: 'antigravity/gemini-3.1-pro-high',
      path: '/v1/chat/completions',
      toolCalling: fallbackToolCalling,
      timeoutMs: 120000,
    },
    image: {
      baseUrlEnv: 'FALLBACK_IMAGE_BASE_URL',
      apiKeyEnv: 'FALLBACK_API_KEY',
      model: 'antigravity/gemini-3.1-flash-image',
      path: '/api/v1/images/generations',
      adapter: 'openai_images_json',
      referenceMode: 'unsupported',
      size: '1024x1024',
      imageSize: '2K',
      responseFormat: 'b64_json',
      outputFormat: 'preserve',
      timeoutMs: 420000,
    },
  }]);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}

test('server-side external chain keeps primary first and exposes the verified OmniRoute fallback identities', async () => {
  const saved = saveEnv();
  try {
    configureProviderChain();
    const { getExternalAiProviderChain } = await import(`../api/_external-ai.js?chain=${Date.now()}`);
    const text = await getExternalAiProviderChain('text');
    const agent = await getExternalAiProviderChain('agent');
    const image = await getExternalAiProviderChain('image');

    expect(text.map(provider => [provider.id, provider.textModel])).toEqual([
      ['primary', 'primary/reasoning'],
      ['omniroute-antigravity', 'antigravity/gemini-3.1-pro-high'],
    ]);
    expect(agent.map(provider => provider.id)).toEqual(['primary']);
    expect(image.map(provider => [provider.id, provider.imageModel])).toEqual([
      ['primary', 'primary/image'],
      ['omniroute-antigravity', 'antigravity/gemini-3.1-flash-image'],
    ]);
    expect(image[1]).toMatchObject({
      imageAdapter: 'openai_images_json',
      imageReferenceMode: 'unsupported',
      imageGenerationSize: '2K',
      imageOutputFormat: 'preserve',
    });
  } finally {
    restoreEnv(saved);
  }
});

test('retryable text failure advances to fallback with the identical system/user contract, while non-retryable failure stops', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  try {
    configureProviderChain();
    const calls = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body });
      if (String(url).includes('primary.example')) {
        return new Response(JSON.stringify({ error: { message: 'gateway overloaded' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"English Etsy title","description":"English body","tags":["gift"]}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { generateWithExternalAi } = await import(`../api/_external-ai.js?text-fallback=${Date.now()}`);
    const result = await generateWithExternalAi('SYSTEM CONTRACT', 'Український intent → English Etsy output');
    expect(result).toEqual({ title: 'English Etsy title', description: 'English body', tags: ['gift'] });
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.body.model)).toEqual(['primary/reasoning', 'antigravity/gemini-3.1-pro-high']);
    expect(calls[0].body.messages).toEqual(calls[1].body.messages);
    expect(calls[1].body.stream).toBe(false);

    calls.length = 0;
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ error: { message: 'invalid API key' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    };
    await expect(generateWithExternalAi('SYSTEM CONTRACT', 'intent')).rejects.toThrow('invalid API key');
    expect(calls).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('structured text generation forces one tool call and returns its JSON arguments', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  try {
    configureProviderChain();
    let capturedBody = null;
    globalThis.fetch = async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        usage: { prompt_tokens: 321, completion_tokens: 87, total_tokens: 408 },
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_social_result',
              type: 'function',
              function: {
                name: 'submit_structured_result',
                arguments: '{"status":"selected","selected_opportunities":[{"id":"alpha"}]}',
              },
            }],
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const { generateWithExternalAi } = await import(`../api/_external-ai.js?structured=${Date.now()}`);
    let capturedUsage = null;
    const result = await generateWithExternalAi('Return a selection.', 'alpha', '', {
      structuredOutput: true,
      onUsage: usage => { capturedUsage = usage; },
    });

    expect(capturedBody.response_format).toBeUndefined();
    expect(capturedBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'submit_structured_result' },
    });
    expect(capturedBody.tools?.[0]?.function?.parameters).toEqual({
      type: 'object',
      additionalProperties: true,
    });
    expect(result).toEqual({ status: 'selected', selected_opportunities: [{ id: 'alpha' }] });
    expect(capturedUsage).toMatchObject({
      provider_id: 'primary',
      model: 'primary/reasoning',
      prompt_tokens: 321,
      completion_tokens: 87,
      total_tokens: 408,
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('agent fallback keeps one prompt and one tool schema across providers without an output interceptor', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  try {
    configureProviderChain({ fallbackToolCalling: true });
    const calls = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body });
      if (String(url).includes('primary.example')) {
        return new Response(JSON.stringify({ error: { message: 'temporary gateway error' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Готово: англомовний Etsy draft prepared.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { runWithExternal } = await import(`../api/agent/helpers.js?agent-fallback=${Date.now()}`);
    const events = [];
    const result = await runWithExternal([{ role: 'user', content: 'Зроби англомовний Etsy draft.' }], {}, event => events.push(event));

    expect(result.message).toContain('Etsy draft');
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.body.model)).toEqual(['primary/reasoning', 'antigravity/gemini-3.1-pro-high']);
    expect(calls[0].body.messages).toEqual(calls[1].body.messages);
    expect(calls[0].body.tools).toEqual(calls[1].body.tools);
    expect(calls[0].body.tool_choice).toBe('auto');
    expect(events.filter(event => event.type === 'model').map(event => event.model)).toEqual(['primary/reasoning', 'antigravity/gemini-3.1-pro-high']);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('image fallback retries only after a retryable primary failure, sends Antigravity geometry, generates independent requests in parallel, and preserves compact JPEG output', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  try {
    configureProviderChain();
    const sharp = (await import('sharp')).default;
    const sourceJpeg = (await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 100, g: 110, b: 120 } } }).jpeg().toBuffer()).toString('base64');
    const primaryCalls = [];
    const fallbackCalls = [];
    let activeFallbackCalls = 0;
    let maxActiveFallbackCalls = 0;
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (String(url).includes('primary.example')) {
        primaryCalls.push(body);
        return new Response(JSON.stringify({ error: { message: 'temporary upstream failure' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      fallbackCalls.push(body);
      activeFallbackCalls += 1;
      maxActiveFallbackCalls = Math.max(maxActiveFallbackCalls, activeFallbackCalls);
      await new Promise(resolve => setTimeout(resolve, 20));
      activeFallbackCalls -= 1;
      return new Response(JSON.stringify({ data: [{ b64_json: sourceJpeg }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { generateImagesWithExternalAi } = await import(`../api/_external-ai.js?image-fallback=${Date.now()}`);
    const images = await generateImagesWithExternalAi({
      prompts: ['first independent frame', 'second independent frame'],
      count: 2,
      aspectRatio: '3:4',
    });

    expect(primaryCalls).toHaveLength(2);
    expect(fallbackCalls).toHaveLength(2);
    expect(maxActiveFallbackCalls).toBeGreaterThan(1);
    for (const body of fallbackCalls) {
      expect(body).toMatchObject({
        model: 'antigravity/gemini-3.1-flash-image',
        n: 1,
        size: '1024x1024',
        aspect_ratio: '3:4',
        image_size: '2K',
        response_format: 'b64_json',
      });
    }
    expect(images).toHaveLength(2);
    expect(images.every(image => image.mimeType === 'image/jpeg'
      && Buffer.from(image.base64, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])))).toBe(true);
    expect(images.providerAttempts).toEqual([
      { id: 'primary', success: false, retryable: true },
      { id: 'omniroute-antigravity', model: 'antigravity/gemini-3.1-flash-image', success: true },
    ]);

    primaryCalls.length = 0;
    fallbackCalls.length = 0;
    globalThis.fetch = async (url, options) => {
      primaryCalls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ error: { message: 'invalid image request' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    };
    await expect(generateImagesWithExternalAi({ prompt: 'one frame' })).rejects.toThrow('invalid image request');
    expect(primaryCalls).toHaveLength(1);
    expect(fallbackCalls).toHaveLength(0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('requested Antigravity model routes directly to its provider-specific endpoint and payload', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  try {
    configureProviderChain();
    const sharp = (await import('sharp')).default;
    const sourcePng = (await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 40, g: 80, b: 120 } } }).png().toBuffer()).toString('base64');
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: sourcePng }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const { generateImagesWithExternalAi } = await import(`../api/_external-ai.js?reference-filter=${Date.now()}`);
    const images = await generateImagesWithExternalAi({
      prompt: 'Create a reference-free editorial hero.',
      aspectRatio: '3:4',
      model: 'antigravity/gemini-3.1-flash-image',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('fallback.example');
    expect(calls[0].url).toContain('/api/v1/images/generations');
    expect(calls[0].body.model).toBe('antigravity/gemini-3.1-flash-image');
    expect(calls[0].body).toMatchObject({
      n: 1,
      size: '1024x1024',
      aspect_ratio: '3:4',
      image_size: '2K',
      response_format: 'b64_json',
    });
    expect(images.providerAttempts).toEqual([
      { id: 'omniroute-antigravity', model: 'antigravity/gemini-3.1-flash-image', success: true },
    ]);

    calls.length = 0;
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ error: { message: 'Antigravity temporarily unavailable' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await expect(generateImagesWithExternalAi({
      prompt: 'Create a reference-free editorial hero.',
      model: 'antigravity/gemini-3.1-flash-image',
    })).rejects.toThrow('Antigravity temporarily unavailable');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('fallback.example');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('reference generation ignores a requested non-reference model and uses the reference-capable provider', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  try {
    configureProviderChain();
    const sharp = (await import('sharp')).default;
    const sourcePng = (await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 40, g: 80, b: 120 } } }).png().toBuffer()).toString('base64');
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: sourcePng }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const { generateImagesWithExternalAi } = await import(`../api/_external-ai.js?reference-provider=${Date.now()}`);
    const images = await generateImagesWithExternalAi({
      prompt: 'Preserve this exact design in a product mockup.',
      referenceImage: { base64: sourcePng, mimeType: 'image/png' },
      model: 'antigravity/gemini-3.1-flash-image',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('primary.example');
    expect(calls[0].body.model).toBe('primary/image');
    expect(images.providerAttempts).toEqual([
      { id: 'primary', model: 'primary/image', success: true },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('external image generation does not contain a hidden cross-provider fallback', () => {
  const configSource = fs.readFileSync(path.join(process.cwd(), 'api/_external-ai.js'), 'utf8');
  const mediaSource = fs.readFileSync(path.join(process.cwd(), 'api/media/image-generation.js'), 'utf8');
  expect(configSource).not.toContain('localStorage');
  expect(mediaSource).not.toContain("model: 'configured-fallback'");
  expect(mediaSource).not.toContain('using secondary image capability');
  expect(mediaSource).toContain('no cross-provider fallback is allowed');
});

test('server job state persists independently from the agent Clear data/new-chat control', async () => {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-external-failover-job-'));
  const previousJobsDir = process.env.JOBS_DIR;
  try {
    process.env.JOBS_DIR = jobsDir;
    const jobs = await import(`../api/jobs.js?external-persist=${Date.now()}`);
    const id = `job_external_${Date.now().toString(36)}`;
    jobs.createBackgroundJob(id, 'image_generation', { description: 'Generate a fallback image', provider: 'external' });
    jobs.updateBackgroundJob(id, {
      status: 'done',
      progress: 100,
      message: 'Image generation complete',
      result: { images: [{ provider: 'external', model: 'codex/gpt-5.6-terra' }] },
    });
    await new Promise(resolve => setTimeout(resolve, 75));
    const persisted = JSON.parse(fs.readFileSync(path.join(jobsDir, `${id}.json`), 'utf8'));
    expect(persisted).toMatchObject({
      schema_version: 1,
      record_type: 'background_job',
      job: {
        id,
        status: 'done',
        progress: 100,
        result: { images: [{ model: 'codex/gpt-5.6-terra' }] },
      },
    });

    const agentSource = fs.readFileSync(path.join(process.cwd(), 'public/pages/agent.js'), 'utf8');
    const clearBlock = agentSource.slice(agentSource.indexOf('clearBtn.onclick = () =>'), agentSource.indexOf('await _initSession();'));
    expect(clearBlock).toContain("agentSessionStorage.setItem(HISTORY_KEY, '[]')");
    expect(clearBlock).not.toMatch(/\/api\/jobs|deleteBackgroundJob|removeItem\([^)]*job/i);
    expect(agentSource).toContain('void resumeTrackedTurn();');
  } finally {
    if (previousJobsDir === undefined) delete process.env.JOBS_DIR;
    else process.env.JOBS_DIR = previousJobsDir;
    fs.rmSync(jobsDir, { recursive: true, force: true });
  }
});
