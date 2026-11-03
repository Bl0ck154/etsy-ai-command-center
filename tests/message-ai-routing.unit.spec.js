import { expect, test } from '@playwright/test';

const ENV_KEYS = [
  'EXTERNAL_AI_BASE_URL',
  'EXTERNAL_AI_API_KEY',
  'EXTERNAL_AI_MODEL',
  'EXTERNAL_AI_PROVIDERS_JSON',
  'FALLBACK_BASE_URL',
  'FALLBACK_API_KEY',
  'MESSAGE_AI_PRIMARY_MODEL',
  'MESSAGE_AI_FALLBACK_MODEL',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
];

function restore(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

test('Messages uses Gemini 3.1 Pro High first and Terra Medium only as retryable fallback', async () => {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    process.env.EXTERNAL_AI_BASE_URL = 'https://codex.example/v1';
    process.env.EXTERNAL_AI_API_KEY = 'codex-secret';
    process.env.EXTERNAL_AI_MODEL = 'codex/gpt-5.6-terra-medium';
    process.env.FALLBACK_BASE_URL = 'https://antigravity.example/v1';
    process.env.FALLBACK_API_KEY = 'antigravity-secret';
    process.env.EXTERNAL_AI_PROVIDERS_JSON = JSON.stringify([{
      id: 'omniroute-antigravity',
      baseUrlEnv: 'FALLBACK_BASE_URL',
      apiKeyEnv: 'FALLBACK_API_KEY',
      text: {
        model: 'antigravity/gemini-3.1-pro-high',
        path: '/v1/chat/completions',
      },
    }]);
    process.env.MESSAGE_AI_PRIMARY_MODEL = 'antigravity/gemini-3.1-pro-high';
    process.env.MESSAGE_AI_FALLBACK_MODEL = 'codex/gpt-5.6-terra-medium';
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;

    const calls = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), model: body.model });
      if (String(url).includes('antigravity.example')) {
        return new Response(JSON.stringify({
          error: { message: 'temporary gateway failure' },
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'fallback-ok' } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { generateWithMessageAi } = await import(
      `../api/messages/message-ai.js?model-order=${Date.now()}`
    );
    await expect(generateWithMessageAi('system', 'user')).resolves.toBe(
      'fallback-ok',
    );
    expect(calls.map(call => call.model)).toEqual([
      'antigravity/gemini-3.1-pro-high',
      'codex/gpt-5.6-terra-medium',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restore(saved);
  }
});

test('Messages falls back to Terra when Gemini output fails caller validation', async () => {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    process.env.EXTERNAL_AI_BASE_URL = 'https://codex.example/v1';
    process.env.EXTERNAL_AI_API_KEY = 'codex-secret';
    process.env.EXTERNAL_AI_MODEL = 'codex/gpt-5.6-terra-medium';
    process.env.FALLBACK_BASE_URL = 'https://antigravity.example/v1';
    process.env.FALLBACK_API_KEY = 'antigravity-secret';
    process.env.EXTERNAL_AI_PROVIDERS_JSON = JSON.stringify([{
      id: 'omniroute-antigravity',
      baseUrlEnv: 'FALLBACK_BASE_URL',
      apiKeyEnv: 'FALLBACK_API_KEY',
      text: {
        model: 'antigravity/gemini-3.1-pro-high',
        path: '/v1/chat/completions',
      },
    }]);
    process.env.MESSAGE_AI_PRIMARY_MODEL = 'antigravity/gemini-3.1-pro-high';
    process.env.MESSAGE_AI_FALLBACK_MODEL = 'codex/gpt-5.6-terra-medium';
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;

    const calls = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), model: body.model });
      const content = String(url).includes('antigravity.example')
        ? '{"decision":"malformed"}'
        : '{"decision":"no_action","confidence":1}';
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { generateWithMessageAi } = await import(
      `../api/messages/message-ai.js?validated-model-order=${Date.now()}`
    );
    const result = await generateWithMessageAi('system', 'user', '', {
      validateResult: candidate => {
        if (candidate?.decision !== 'no_action') {
          throw new Error('invalid semantic decision');
        }
        return candidate;
      },
    });

    expect(result).toEqual({ decision: 'no_action', confidence: 1 });
    expect(calls.map(call => call.model)).toEqual([
      'antigravity/gemini-3.1-pro-high',
      'codex/gpt-5.6-terra-medium',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restore(saved);
  }
});
