import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { formatAgentProgress } from '../public/utils/agent-progress.js';
import { DEFAULT_MODELS } from '../public/utils/models.js';
import { resolveTextProvider } from '../api/_provider-routing.js';

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('shared Auto routing prefers external and never treats auto as Gemini', () => {
  expect(resolveTextProvider('auto', { hasExternal: true, hasClaude: true, hasGemini: true })).toBe('external');
  expect(resolveTextProvider('auto', { hasExternal: false, hasClaude: true, hasGemini: true })).toBe('claude');
  expect(resolveTextProvider('auto', { hasExternal: false, hasClaude: false, hasGemini: true })).toBe('gemini');
  expect(resolveTextProvider('auto', {})).toBe('none');
});


test('Auto prefers the configured external provider and only falls back when it is unavailable', async () => {
  const keys = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.ANTHROPIC_API_KEY = 'claude-key';
    process.env.GEMINI_API_KEY = 'gemini-key';
    const { selectAgentProvider } = await import(`../api/agent/helpers.js?route=${Date.now()}`);

    expect(selectAgentProvider('auto', [], { _hasExternal: true })).toBe('external');
    expect(selectAgentProvider('external', [], { _hasExternal: false })).toBe('gemini');

    delete process.env.GEMINI_API_KEY;
    expect(selectAgentProvider('external', [], { _hasExternal: false })).toBe('claude');
  } finally {
    restoreEnv(saved);
  }
});

test('external agent execution uses the saved runtime model, never a browser override', async () => {
  const keys = ['EXTERNAL_AI_BASE_URL', 'EXTERNAL_AI_API_KEY', 'EXTERNAL_AI_MODEL', 'OMNIROUTE_TEXT_MODEL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    process.env.EXTERNAL_AI_BASE_URL = 'https://provider.example/v1';
    process.env.EXTERNAL_AI_API_KEY = 'test-key';
    process.env.EXTERNAL_AI_MODEL = 'codex/gpt-5.6-terra-medium';
    delete process.env.OMNIROUTE_TEXT_MODEL;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const events = [];
    const { runWithExternal } = await import(`../api/agent/helpers.js?runtime-model=${Date.now()}`);
    const result = await runWithExternal([{ role: 'user', content: 'hello' }], {}, event => events.push(event), {
      external: 'gemini/gemini-2.5-pro',
    });

    expect(result.message).toBe('OK');
    expect(calls).toHaveLength(1);
    expect(calls[0].body.model).toBe('codex/gpt-5.6-terra-medium');
    expect(events).toContainEqual({ type: 'model', provider: 'external', model: 'codex/gpt-5.6-terra-medium' });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('progress labels show the provider and actual model identity', () => {
  expect(formatAgentProgress({ type: 'model', provider: 'external', model: 'codex/gpt-5.6-terra-medium' }, 1_100))
    .toBe('External AI · codex/gpt-5.6-terra-medium · 1s');
  expect(formatAgentProgress({ type: 'model', provider: 'gemini', model: 'gemini-2.5-pro' }, 0))
    .toBe('Gemini · gemini-2.5-pro · 0s');
});

test('external project model is not restored from browser localStorage', () => {
  const settingsSource = fs.readFileSync(path.join(process.cwd(), 'public/pages/settings.js'), 'utf8');
  expect(settingsSource).not.toContain("saveAIModelPref('external'");
  expect(settingsSource).toContain("localStorage.removeItem('ai_model_external')");
  expect(settingsSource).toContain('value="${DEFAULT_MODELS.external}"');
  expect(settingsSource).not.toContain('Verified project model');
});

test('external text and image defaults come from one shared model contract', () => {
  expect(DEFAULT_MODELS.external).toBe('codex/gpt-5.6-terra-medium');
  expect(DEFAULT_MODELS.externalImage).toBe('codex/gpt-5.6-terra');
});

test('generic external text generation prioritizes runtime model over request hint', async () => {
  const saved = {};
  for (const key of ['EXTERNAL_AI_BASE_URL', 'EXTERNAL_AI_API_KEY', 'EXTERNAL_AI_MODEL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) saved[key] = process.env[key];
  const originalFetch = globalThis.fetch;
  let requestBody;
  try {
    process.env.EXTERNAL_AI_BASE_URL = 'https://provider.example/v1';
    process.env.EXTERNAL_AI_API_KEY = 'test-key';
    process.env.EXTERNAL_AI_MODEL = 'codex/gpt-5.6-terra-medium';
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const { generateWithExternalAi } = await import(`../api/_external-ai.js?runtime-priority=${Date.now()}`);
    await generateWithExternalAi('system', 'user', 'gemini/gemini-2.5-pro');
    expect(requestBody.model).toBe('codex/gpt-5.6-terra-medium');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});
