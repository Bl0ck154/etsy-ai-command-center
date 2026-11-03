import { expect, test } from '@playwright/test';
import { mkdtempSync, copyFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('first-run setup generates private credentials and refuses to overwrite them', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'etsy-new-user-'));
  try {
    copyFileSync(path.join(root, '.env.example'), path.join(folder, '.env.example'));
    const first = spawnSync(process.execPath, [path.join(root, 'scripts/setup.mjs')], {
      cwd: folder,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(first.status, first.stderr).toBe(0);
    const local = path.join(folder, '.env');
    const settings = parse(readFileSync(local));
    expect(settings.KV_BACKEND).toBe('local');
    expect(settings.SITE_PASSWORD.length).toBeGreaterThanOrEqual(25);
    expect(settings.SESSION_SECRET.length).toBeGreaterThanOrEqual(45);
    expect(statSync(local).mode & 0o077).toBe(0);
    const second = spawnSync(process.execPath, [path.join(root, 'scripts/setup.mjs')], {
      cwd: folder,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(second.status).toBe(1);
    expect(parse(readFileSync(local)).SITE_PASSWORD).toBe(settings.SITE_PASSWORD);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
