// global-setup.js — runs once before all tests, handles login + saves auth state
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BASE_URL   = process.env.BASE_URL   || 'http://127.0.0.1:3000';
const PASSWORD   = process.env.SITE_PASSWORD || '';
const USERNAME   = process.env.SITE_USERNAME || 'illia';
const STATE_FILE = path.join(process.cwd(), 'tests/.auth-state.json');

export function requireSitePassword({ password = PASSWORD, stateFile = STATE_FILE } = {}) {
  if (!password) {
    try {
      fs.rmSync(stateFile, { force: true });
    } catch {
      // Best effort only — stale auth state should not mask missing credentials.
    }
    throw new Error('SITE_PASSWORD unavailable: refusing to run Playwright or save unauthenticated auth state.');
  }
}

export default async function globalSetup() {
  // Validate before any network/browser work. Posting an empty password to an
  // open site's /api/login can look successful and create misleading auth state.
  requireSitePassword();

  // Try API-level login first (faster, no browser needed)
  const loginUrl = `${BASE_URL}/api/login`;
  try {
    const res = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });

    if (res.ok) {
      // Extract the Set-Cookie header and build a storage state file
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        // Parse the cookie
        const cookieMatch = setCookie.match(/etsy_mgr_session=([^;]+)/);
        if (cookieMatch) {
          const parsedBaseUrl = new URL(BASE_URL);
          const domain = parsedBaseUrl.hostname;
          const state = {
            cookies: [{
              name: 'etsy_mgr_session',
              value: cookieMatch[1],
              domain,
              path: '/',
              httpOnly: true,
              secure: parsedBaseUrl.protocol === 'https:',
              sameSite: 'Strict',
              expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90, // 90 days
            }],
            origins: [],
          };
          fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
          fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
          console.log('\n✅ Auth state saved via API login');
          return;
        }
      }
    }
  } catch (e) {
    console.warn('API login failed, falling back to browser login:', e.message);
  }

  // Fallback: use browser to fill the login form
  const browser = await chromium.launch();
  try {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(BASE_URL);

    // Check if the actual login form appears
    const loginForm = page.locator('#login-form');
    const hasLogin  = await loginForm.isVisible({ timeout: 8_000 }).catch(() => false);
    if (hasLogin) {
      const userInput = page.locator('#login-username');
      if (await userInput.isVisible().catch(() => false)) await userInput.fill(USERNAME);
      const pwInput = page.locator('#login-password, input[type="password"]').first();
      await pwInput.fill(PASSWORD);
      await page.locator('#login-btn, button[type="submit"]').first().click();
      await page.waitForSelector('.sidebar-brand', { timeout: 15_000 });
      console.log('\n✅ Logged in via browser form');
    } else {
      console.log('\n✅ Site is open (no login required)');
    }

    // Save storage state (cookies + localStorage)
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    await ctx.storageState({ path: STATE_FILE });
  } finally {
    await browser.close();
  }
}
