import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';

test('analytics module can load before a shop has been configured', () => {
  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    'await import("./api/stats.js"); console.log("STATS_MODULE_OK")',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ETSY_SHOP_ID: '', ETSY_SHOP_IDS: '' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('STATS_MODULE_OK');
});
