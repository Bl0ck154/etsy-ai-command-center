// @ts-check
import { defineConfig } from '@playwright/test';

// Isolated unit-style suites do not require a running Etsy AI Command Center
// service or SITE_PASSWORD. Most are pure Node tests; a small set launches a
// local Playwright Chromium instance to exercise browser modules in isolation.
// Authenticated live/browser acceptance suites continue to use
// playwright.config.js and its fail-fast global setup.
export default defineConfig({
  testDir: './tests',
  testMatch: ['unit.spec.js', '**/*.unit.spec.js'],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'off',
    screenshot: 'off',
  },
});
