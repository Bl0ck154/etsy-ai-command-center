import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { TOOLS } from '../api/agent/tools-schema.js';
import { agentProgressElapsedMs, formatAgentDuration, formatAgentProgress } from '../public/utils/agent-progress.js';

test('VPS deploy bundle includes the agent progress module', () => {
  const deployScript = fs.readFileSync(path.join(process.cwd(), 'scripts/deploy-vps-staging.sh'), 'utf8');
  expect(deployScript).toContain('  public/utils/agent-progress.js');
});

test('mini agent uses the shared full agent renderer instead of a second send pipeline', () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), 'public/app.js'), 'utf8');
  expect(appSource).toContain("renderAgent(host, { compact: true })");
  expect(appSource).not.toContain('window.__floatSend');
  expect(appSource).not.toContain("fetch('/api/ai'");
});

test('every agent tool requires model-authored owner progress copy', () => {
  expect(TOOLS.length).toBeGreaterThan(20);
  for (const tool of TOOLS) {
    expect(tool.input_schema.required, tool.name).toContain('progress_message');
    expect(tool.input_schema.properties.progress_message.description, tool.name)
      .toContain("shop owner's current conversation language");
    expect(tool.input_schema.properties.progress_message.description, tool.name)
      .toContain('noun-style label');
  }
});

test('agent progress formats actual lifecycle events and elapsed time', () => {
  expect(formatAgentDuration(0)).toBe('0s');
  expect(formatAgentDuration(450)).toBe('450ms');
  expect(formatAgentDuration(Number.NaN)).toBe('0s');
  expect(formatAgentDuration(65_900)).toBe('1:05');

  expect(formatAgentProgress({ type: 'model', model: 'gpt-5.4' }, 65_900))
    .toBe('gpt-5.4 · 1:05');
  expect(formatAgentProgress({
    type: 'tool',
    name: 'analyze_listing_images',
    message: 'Аналіз зображень лістингу',
  }, 4_200)).toBe('Аналіз зображень лістингу · 4s');

  expect(formatAgentProgress({
    type: 'tool_result',
    name: 'analyze_listing_images',
    message: 'Аналіз зображень лістингу',
    duration_ms: 2_800,
    status: 'ok',
  }, 8_000)).toBe('✓ Аналіз зображень лістингу · 2s');
});

test('agent progress elapsed time rejects invalid and future timestamps', () => {
  expect(agentProgressElapsedMs(1_000, 4_500)).toBe(3_500);
  expect(agentProgressElapsedMs('not-a-time', 4_500)).toBe(0);
  expect(agentProgressElapsedMs(5_000, 4_500)).toBe(0);
  expect(agentProgressElapsedMs(undefined, 4_500)).toBe(0);
});
