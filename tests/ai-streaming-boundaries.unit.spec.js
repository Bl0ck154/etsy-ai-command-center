import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../api/ai.js', import.meta.url), 'utf8');
const streaming = fs.readFileSync(new URL('../api/ai/streaming-service.js', import.meta.url), 'utf8');

test('AI route delegates provider streaming infrastructure', () => {
  expect(route).toContain("from './ai/streaming-service.js'");
  expect(route).toContain('aiStreaming.streamRawPrompt');
  expect(route).not.toContain('api.anthropic.com');
  expect(route).not.toContain('generativelanguage.googleapis.com');
  expect(route).not.toContain('.body.getReader()');
  expect(route).not.toContain("evt.type === 'content_block_delta'");
});

test('streaming service owns provider URLs, SSE decoding and fallback', () => {
  expect(streaming).toContain("const CLAUDE_URL = 'https://api.anthropic.com/v1/messages'");
  expect(streaming).toContain("const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'");
  expect(streaming).toContain('response.body.getReader()');
  expect(streaming).toContain('const fallback = preferGemini');
});
