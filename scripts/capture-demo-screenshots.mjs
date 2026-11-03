import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const output = path.resolve(process.cwd(), 'artifacts');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const demoUrl = pathToFileURL(path.resolve('docs/demo/index.html')).href;
  await page.goto(demoUrl);
  await page.locator('#page-title').getByText('Dashboard').waitFor();
  await page.screenshot({ path: path.join(output, 'demo-dashboard.png'), fullPage: true });
  await page.locator('#nav [data-page="agent"]').click();
  await page.locator('#page-title').getByText('AI Agent').waitFor();
  await page.screenshot({ path: path.join(output, 'demo-ai-approval.png'), fullPage: true });
  await page.locator('[data-approve="0"]').click();
  if (!(await page.locator('.action .status').first().textContent()).includes('Accepted in demo')) {
    throw new Error('Demo approval did not update the synthetic state');
  }
  console.log('Screenshots captured; demo navigation and simulated approval work.');
} finally {
  await browser.close();
}
