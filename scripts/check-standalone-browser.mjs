import fs from 'node:fs/promises';
import { parse } from 'dotenv';
import { chromium } from '@playwright/test';

const conf = parse(await fs.readFile('.env', 'utf8'));
const origin = 'http://127.0.0.1:' + (process.env.PORT || 3010);
const browser = await chromium.launch({ headless: true });
await fs.mkdir('artifacts', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const failures = [];
  page.on('pageerror', e => failures.push(e.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-form').waitFor({ timeout: 12000 });
  if (await page.locator('#login-username').isVisible()) {
    throw new Error('Single-account login unexpectedly requires a username');
  }
  await page.screenshot({ path: 'artifacts/standalone-login.png' });
  await page.locator('#login-password').fill(conf.SITE_PASSWORD);
  await page.locator('#login-btn').click();
  await page.locator('#sidebar').waitFor({ timeout: 18000 });
  await page.locator('#main-area .page-title').getByText('Settings').waitFor({ timeout: 20000 });
  await page.locator('#settings-tab-content').getByText('Etsy API credentials').waitFor();
  await page.waitForFunction(() => document.getElementById('token-timer')?.textContent?.includes('Not connected'), { timeout: 12000 });
  const title = await page.title();
  if (!title.includes('AI Command Center')) throw new Error('Product branding missing');
  await page.screenshot({ path: 'artifacts/standalone-settings.png' });
  await page.locator('.nav-item[data-page="agent"]').click();
  await page.locator('#agent-messages').waitFor({ timeout: 20000 });
  await page.screenshot({ path: 'artifacts/standalone-workspace.png' });
  await page.locator('.nav-item[data-page="settings"]').click();
  await page.locator('#settings-tab-content').getByText('Etsy API credentials').waitFor({ timeout: 20000 });
  if (!(await page.locator('#main-area').innerText()).includes('New installation?')) {
    throw new Error('First-run setup guidance is missing');
  }
  if (failures.length) throw new Error('Browser uncaught errors: ' + failures.slice(0, 3).join('; '));
  console.log('Real browser login, workspace and Settings: PASS');
} finally {
  await browser.close();
}
