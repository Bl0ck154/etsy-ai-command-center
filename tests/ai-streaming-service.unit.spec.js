import { test, expect } from '@playwright/test';

import { createAiStreamingService } from '../api/ai/streaming-service.js';

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    writes: [],
    writableEnded: false,
    jsonBody: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.jsonBody = value; this.writableEnded = true; return value; },
    write(value) { this.writes.push(value); },
    end() { this.writableEnded = true; return this; },
  };
}

function sseResponse(chunks) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: new TextEncoder().encode(chunks[index++]) };
          },
        };
      },
    },
  };
}

test('external streaming uses existing audit generation and emits one delta plus done', async () => {
  const generateCalls = [];
  const service = createAiStreamingService({
    model: { claudeFast: 'claude-fast', gemini: 'gemini-fast' },
    env: {},
    hasExternalAiConfigAsync: async () => true,
    generate: async (...args) => {
      generateCalls.push(args);
      return { answer: 'ok' };
    },
  });
  const res = createRes();
  await service.streamRawPrompt(res, { provider: 'external', _rawPrompt: 'audit me' });

  expect(generateCalls).toHaveLength(1);
  expect(generateCalls[0]).toEqual([
    'audit',
    { provider: 'external', _rawPrompt: 'audit me', _thinkingLevel: 'NONE' },
    'external',
    false,
  ]);
  expect(res.headers['Content-Type']).toBe('text/event-stream');
  const events = res.writes.map(line => JSON.parse(line.slice('data: '.length)));
  expect(events[0]).toEqual({ type: 'delta', text: '{"answer":"ok"}' });
  expect(res.writes.join('')).toContain('"type":"done"');
  expect(res.writableEnded).toBe(true);
});

test('Claude stream parsing preserves request contract and text_delta events', async () => {
  const fetchCalls = [];
  const service = createAiStreamingService({
    model: { claudeFast: 'claude-haiku', gemini: 'gemini-flash' },
    env: { ANTHROPIC_API_KEY: 'claude-key' },
    hasExternalAiConfigAsync: async () => false,
    generate: async () => { throw new Error('not used'); },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n',
      ]);
    },
  });
  const res = createRes();
  await service.streamRawPrompt(res, {
    provider: 'claude',
    _rawPrompt: 'prompt',
    _rawSystem: 'system',
    _maxOutputTokens: 321,
  });

  expect(fetchCalls[0].url).toBe('https://api.anthropic.com/v1/messages');
  expect(fetchCalls[0].options.headers).toMatchObject({
    'x-api-key': 'claude-key',
    'anthropic-version': '2023-06-01',
  });
  expect(JSON.parse(fetchCalls[0].options.body)).toMatchObject({
    model: 'claude-haiku',
    max_tokens: 321,
    system: 'system',
    messages: [{ role: 'user', content: 'prompt' }],
    stream: true,
  });
  expect(res.writes.join('')).toContain('Hello ');
  expect(res.writes.join('')).toContain('world');
  expect(res.writes.join('')).toContain('"type":"done"');
});

test('preferred Gemini failure falls back once to Claude', async () => {
  const urls = [];
  const service = createAiStreamingService({
    model: { claudeFast: 'claude-haiku', gemini: 'gemini-flash' },
    env: { ANTHROPIC_API_KEY: 'claude-key', GEMINI_API_KEY: 'gemini-key' },
    hasExternalAiConfigAsync: async () => false,
    generate: async () => { throw new Error('not used'); },
    fetchImpl: async url => {
      urls.push(url);
      if (url.includes('generativelanguage.googleapis.com')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: { message: 'gemini unavailable' } }),
        };
      }
      return sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fallback"}}\n',
      ]);
    },
  });
  const res = createRes();
  await service.streamRawPrompt(res, { provider: 'gemini', _rawPrompt: 'prompt' });

  expect(urls).toHaveLength(2);
  expect(urls[0]).toContain('generativelanguage.googleapis.com');
  expect(urls[1]).toBe('https://api.anthropic.com/v1/messages');
  expect(res.writes.join('')).toContain('fallback');
  expect(res.writes.join('')).toContain('"type":"done"');
});

test('streaming fails early when no provider is configured', async () => {
  const service = createAiStreamingService({
    model: { claudeFast: 'claude', gemini: 'gemini' },
    env: {},
    hasExternalAiConfigAsync: async () => false,
    generate: async () => {},
  });
  const res = createRes();
  await service.streamRawPrompt(res, { _rawPrompt: 'prompt' });
  expect(res.statusCode).toBe(500);
  expect(res.jsonBody).toEqual({ error: 'No AI provider configured' });
});
