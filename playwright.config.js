// @ts-check
import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { readFileSync } from 'fs';

// Load .env.test if it exists (contains SITE_PASSWORD and BASE_URL)
try {
  const envFile = readFileSync(new URL('.env.test', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const [k, ...v] = line.split('=');
    if (k?.trim() && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
  }
} catch { /* no .env.test — use env vars directly */ }

const BASE_URL    = process.env.BASE_URL || 'http://127.0.0.1:3000';
const AUTH_STATE  = path.join(process.cwd(), 'tests/.auth-state.json');

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,        // AI generation + competitor research can take up to 2 min
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,             // one at a time — avoid AI rate limits
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],

  globalSetup: './tests/global-setup.js',

  use: {
    baseURL: BASE_URL,
    storageState: AUTH_STATE,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    navigationTimeout: 20_000,
  },

  // The application is self-hosted. Point BASE_URL at your environment for
  // authenticated UI tests, or at a local Node server for isolated work.
  webServer: undefined,

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
