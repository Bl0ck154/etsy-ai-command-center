import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function runDoctor(extraConfig) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'etsy-public-doctor-'));
  const file = path.join(temp, '.env');
  writeFileSync(file, extraConfig);
  try {
    return spawnSync(process.execPath, ['scripts/config-doctor.mjs'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'development',
        CONFIG_DOCTOR_ENV_FILE: file,
      },
      encoding: 'utf8',
      timeout: 12_000,
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('config doctor reports missing setup without printing values', () => {
  const result = runDoctor('ETSY_API_KEY=SYNTHETIC_SECRET_VALUE_ABC\nNODE_ENV=development\n');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('NEEDS-SETUP');
  expect(result.stdout).toContain('OAuth persistence');
  expect(result.stdout).not.toContain('SYNTHETIC_SECRET_VALUE_ABC');
});

test('optional Hub fails its preflight when enabled without a path', () => {
  const result = runDoctor('ETSY_API_HUB_ENABLED=true\nETSY_API_HUB_ROOT=\nNODE_ENV=development\n');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('external Hub (optional)');
  expect(result.stdout).toContain('NEEDS-SETUP');
});

test('production refuses missing login and signing credentials', () => {
  const result = runDoctor('NODE_ENV=production\nSITE_PASSWORD=\nSESSION_SECRET=\n');
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('SYNTHETIC_SECRET');
});
