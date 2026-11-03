import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';

test('public install defaults to the built-in Etsy auth route', () => {
  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    'const m = await import("./api/auth.js"); console.log("HUB_ENABLED=" + m.etsyApiHubEnabled());',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ETSY_API_HUB_ENABLED: '', ETSY_API_HUB_ROOT: '' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('HUB_ENABLED=false');
});

test('enabling external Hub without path fails clearly, not at a private server path', () => {
  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    'const m = await import("./api/auth.js"); try { await m.hubEtsyRequest("/shops/1"); process.exit(4); } catch (e) { console.log(e.code + ": " + e.message); }',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ETSY_API_HUB_ENABLED: 'true', ETSY_API_HUB_ROOT: '', ETSY_API_HUB_TOKEN_SOURCE: 'legacy' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('ETSY_API_HUB_NOT_CONFIGURED');
  expect(child.stdout).toContain('ETSY_API_HUB_ROOT is required');
  expect(child.stdout).not.toContain('/opt/');
});
