import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const authSource = await fs.readFile(new URL('../api/auth.js', import.meta.url), 'utf8');
const tokenRuntimeSource = await fs.readFile(new URL('../api/etsy-auth/token-runtime.js', import.meta.url), 'utf8');
const kvSource = await fs.readFile(new URL('../api/kv.js', import.meta.url), 'utf8');
const serverSource = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');

test('token runtime uses the revisioned token-state owner and fences external completions', () => {
  expect(tokenRuntimeSource).toContain("from '../_etsy-token-state.js'");
  expect(tokenRuntimeSource).toContain('etsyTokenStateRepository.readSnapshot()');
  expect(tokenRuntimeSource).toContain('etsyTokenStateRepository.compareAndReplace(expectedRevision, tokenCache)');
  expect(tokenRuntimeSource).not.toContain("kvGet('etsy_oauth_tokens')");
  expect(tokenRuntimeSource).not.toContain("kvSet('etsy_oauth_tokens'");

  expect(authSource).toContain("from './etsy-auth/token-runtime.js'");
  expect(authSource).not.toContain('etsyTokenStateRepository.');
  expect(authSource).not.toContain("kvGet('etsy_oauth_tokens')");
  expect(authSource).not.toContain("kvSet('etsy_oauth_tokens'");
});

test('public KV route sends Settings token mutation through the revisioned owner', () => {
  expect(kvSource).toContain("case 'setEtsyTokens'");
  expect(kvSource).toContain('etsyTokenStateRepository.update(');
  expect(kvSource).not.toContain("kvSet('etsy_oauth_tokens'");
  expect(kvSource).not.toContain("kvGet('etsy_oauth_tokens'");
});

test('server keeps the public KV facade as the routed handler', () => {
  expect(serverSource).toContain("import kvHandler from './api/kv.js'");
  expect(kvSource).toContain('export default async function handler(req, res)');
});
