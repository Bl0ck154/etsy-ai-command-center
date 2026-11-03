import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  socialHistoryPresentation,
  socialPagerHtml,
} from '../public/utils/social-history-view.js';

const platforms = [
  { id: 'instagram', name: 'Instagram', color: '#C13584' },
  { id: 'pinterest', name: 'Pinterest', color: '#E60023' },
];

const publicRoot = path.resolve(process.cwd(), 'public');
let server;
let baseUrl;

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://local').pathname;
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><body></body></html>');
      return;
    }

    const requested = path.resolve(publicRoot, `.${pathname}`);
    if (!requested.startsWith(publicRoot + path.sep)) {
      response.statusCode = 403;
      response.end();
      return;
    }

    try {
      response.setHeader(
        'Content-Type',
        requested.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8',
      );
      response.end(await fs.readFile(requested));
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('history presentation preserves workflow counts, status labels, escaping, and links', () => {
  const history = [
    {
      id: 'published',
      platform: 'instagram',
      listing: '<Launch>',
      service: 'make',
      status: 'published',
      _postedAt: 30,
      post_url: 'https://social.example/post/1',
    },
    {
      id: 'queued',
      platform: 'pinterest',
      listing: 'Queued item',
      service: 'direct',
      status: 'queued_external',
      _postedAt: 20,
      review_url: '/#schedule?post_id=queued',
    },
    {
      id: 'failed',
      platform: 'instagram',
      listing: 'Failed item',
      status: 'failed',
      error: '<provider unavailable>',
      _postedAt: 10,
    },
  ];
  const snapshot = structuredClone(history);
  const result = socialHistoryPresentation(history, {
    platforms,
    formatDate: value => `date:${value}`,
  });

  expect(result.currentPage).toBe(1);
  expect(result.totalPages).toBe(1);
  expect(result.html).toContain('Published: 1');
  expect(result.html).toContain('Sending: 1');
  expect(result.html).toContain('Failed: 1');
  expect(result.html).toContain('&lt;Launch&gt;');
  expect(result.html).toContain('Instagram');
  expect(result.html).toContain('date:30');
  expect(result.html).toContain('https://social.example/post/1');
  expect(result.html).toContain('Review in Schedule');
  expect(result.html).toContain('&lt;provider unavailable&gt;');
  expect(result.html).toContain('>published<');
  expect(result.html).toContain('>sending<');
  expect(history).toEqual(snapshot);
});

test('history presentation filters before pagination and clamps stale pages', () => {
  const history = Array.from({ length: 25 }, (_, index) => ({
    id: `item-${index + 1}`,
    platform: index % 2 ? 'pinterest' : 'instagram',
    listing: `Listing ${index + 1}`,
    status: index % 3 ? 'published' : 'queued_external',
    _postedAt: index + 1,
  }));
  const result = socialHistoryPresentation(history, {
    platform: 'instagram',
    status: 'published',
    sort: 'oldest',
    page: 99,
    pageSize: 3,
    platforms,
    formatDate: String,
  });

  expect(result.currentPage).toBe(result.totalPages);
  expect(result.html).toContain(`Page ${result.totalPages}/${result.totalPages}`);
  expect((result.html.match(/data-social-history-item/g) || []).length).toBeLessThanOrEqual(3);
  expect(result.html).not.toContain('Pinterest</span>');
  expect(result.html).not.toContain('>sending<');
});

test('history and pager empty states preserve the existing Social Hub copy', () => {
  expect(socialHistoryPresentation([]).html)
    .toContain('Published and queued posts will appear here');
  expect(socialHistoryPresentation([{ platform: 'instagram', status: 'published' }], {
    platform: 'pinterest',
  }).html).toContain('No posts match these filters');
  expect(socialPagerHtml({ currentPage: 1, totalPages: 1, start: 1, end: 1, total: 1 }))
    .toContain('1-1 of 1');
  expect(socialPagerHtml({
    currentPage: 2,
    totalPages: 3,
    start: 11,
    end: 20,
    total: 25,
    onPage: 'window.__page',
    label: 'History <pages>',
  })).toContain('aria-label="History &lt;pages&gt;"');
});

test('Social page delegates read-only history rendering through a strict UI boundary', async () => {
  const pageSource = await fs.readFile(new URL('../public/pages/social.js', import.meta.url), 'utf8');
  const viewSource = await fs.readFile(
    new URL('../public/utils/social-history-view.js', import.meta.url),
    'utf8',
  );

  expect(pageSource).toContain("from '../utils/social-history-view.js'");
  expect(pageSource).toContain('socialHistoryPresentation(state.history, {');
  expect(pageSource).not.toContain('data-social-history-item style=');
  expect(pageSource).not.toMatch(/function socialPagerHtml\(/);
  expect(viewSource).not.toMatch(
    /fetch\(|localStorage|sessionStorage|saveScheduledPost|generateId|selectedListing|autopilot|opportunit|taxonomy|approve|publishToPlatform|sendTo/i,
  );
});

test('browser mounts the existing history workflow and pagination markup', async ({ page }) => {
  await page.goto(baseUrl);
  await page.evaluate(async () => {
    const { socialHistoryPresentation } = await import('/utils/social-history-view.js');
    const history = Array.from({ length: 15 }, (_, index) => ({
      id: `record-${index + 1}`,
      platform: index % 2 ? 'pinterest' : 'instagram',
      listing: `Listing ${index + 1}`,
      service: 'make',
      status: index % 3 ? 'published' : 'queued_external',
      _postedAt: index + 1,
      review_url: index === 14 ? '/#schedule?post_id=record-15' : '',
    }));
    const presentation = socialHistoryPresentation(history, {
      page: 1,
      pageSize: 10,
      platforms: [
        { id: 'instagram', name: 'Instagram', color: '#C13584' },
        { id: 'pinterest', name: 'Pinterest', color: '#E60023' },
      ],
      formatDate: value => `date:${value}`,
    });
    const mount = document.createElement('section');
    mount.id = 'social-history-view-test';
    mount.innerHTML = presentation.html;
    document.body.replaceChildren(mount);
  });

  const history = page.locator('#social-history-view-test');
  await expect(history.locator('[data-social-history-item]')).toHaveCount(10);
  await expect(history).toContainText('1-10 of 15 · Page 1/2');
  await expect(history.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await expect(history.getByRole('button', { name: 'Next page' })).toBeEnabled();
  await expect(history).toContainText('Published: 10');
  await expect(history).toContainText('Sending: 5');
  await expect(history.getByRole('link', { name: 'Review in Schedule' })).toHaveAttribute(
    'href',
    '/#schedule?post_id=record-15',
  );
});
