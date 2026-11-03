import { test, expect } from '@playwright/test';
import fs from 'node:fs';

import { hasMetaAiApiToken } from '../api/meta-ai/auth.js';
import { metaAi403Message, metaAiCookieDiagnostics } from '../api/meta-ai/diagnostics.js';

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('service token remains an optional constant-time auth path', () => {
  withEnv('META_AI_API_TOKEN', undefined, () => {
    expect(hasMetaAiApiToken({ headers: { authorization: 'Bearer anything' } })).toBe(false);
  });
  withEnv('META_AI_API_TOKEN', 'secret-token', () => {
    expect(hasMetaAiApiToken({ headers: { authorization: 'Bearer wrong' } })).toBe(false);
    expect(hasMetaAiApiToken({ headers: { Authorization: 'Bearer secret-token' } })).toBe(true);
  });
});

test('cookie diagnostics detect minimal required cookies and proxy configuration', () => {
  withEnv('META_AI_PROXY_SERVER', '', () => {
    const diagnostics = metaAiCookieDiagnostics('ecto_1_sess=a; rd_challenge=b');
    expect(diagnostics).toMatchObject({
      cookieCount: 2,
      onlyMinimalCookies: true,
      proxyConfigured: false,
    });
    expect(diagnostics.cookieNames).toEqual(['ecto_1_sess', 'rd_challenge']);
  });
  withEnv('META_AI_PROXY_SERVER', 'http://proxy.example:8080', () => {
    expect(metaAiCookieDiagnostics('ecto_1_sess=a; rd_challenge=b; extra=c').proxyConfigured).toBe(true);
  });
});

test('403 guidance preserves minimal-cookie and general rejection messages', () => {
  const err = new Error('Meta returned 403');
  expect(metaAi403Message(err, { onlyMinimalCookies: true })).toContain('Saved cookies are minimal');
  expect(metaAi403Message(err, { onlyMinimalCookies: false })).toContain('Configure META_AI_PROXY_SERVER');
});

test('Meta AI route delegates auth, actions and diagnostics to focused owners', () => {
  const route = fs.readFileSync(new URL('../api/meta-ai.js', import.meta.url), 'utf8');
  expect(route).toContain("from './meta-ai/auth.js'");
  expect(route).toContain("from './meta-ai/application.js'");
  expect(route).toContain("from './meta-ai/diagnostics.js'");
  expect(route).toContain('metaAiApplication.execute');
  expect(route).not.toContain('function timingSafeEqual(');
  expect(route).not.toContain('function metaAiCookieDiagnostics(');
  expect(route).not.toContain('getMetaAiSession({ cookieHeader: activeCookieHeader })');
});
