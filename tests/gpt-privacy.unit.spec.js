import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test('GPT privacy policy discloses retention, contact, and deletion procedure', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf("app.get('/gpt/privacy'");
  const end = server.indexOf("app.get('/healthz'", start);
  const route = server.slice(start, end);

  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(route).toContain('Authorization-code hashes expire');
  expect(route).toContain('Idempotency records expire after 24 hours');
  expect(route).toContain('Security audit events are written to monthly files');
  expect(route).toContain('Contact and data deletion');
  expect(route).toContain('revoke the account\'s GPT OAuth token family');
  expect(route).toContain('delete matching security-audit entries');
});
