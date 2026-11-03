import fs from 'node:fs';
import { expect, test } from '@playwright/test';

import { redactJobAuditText, summarizeJobInput } from '../api/jobs/agent-audit.js';

const route = fs.readFileSync(new URL('../api/jobs.js', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('../api/jobs/job-store.js', import.meta.url), 'utf8');
const audit = fs.readFileSync(new URL('../api/jobs/agent-audit.js', import.meta.url), 'utf8');
const listing = fs.readFileSync(new URL('../api/jobs/listing-generation-application.js', import.meta.url), 'utf8');
const image = fs.readFileSync(new URL('../api/jobs/image-generation-application.js', import.meta.url), 'utf8');

test('jobs HTTP facade preserves public exports and stays thin', () => {
  expect(route).toContain('createBackgroundJob,');
  expect(route).toContain('getBackgroundJob,');
  expect(route).toContain('updateBackgroundJob,');
  expect(route).toContain('recordAgentRuntimeFault,');
  expect(route).toContain('resolveImageJobTimeoutMs,');
  expect(route).toContain('startListingGenerationJob,');
  expect(route).not.toContain('generateMediaImages(');
  expect(route).not.toContain("generate('listing'");
  expect(route).not.toContain('REDACTED_TOKEN');
  expect(route).not.toContain('IMAGE_JOB_CONCURRENCY');
  expect(route.split('\n').length).toBeLessThan(90);
});

test('job store, audit and runners have distinct implementation ownership', () => {
  expect(store).toContain('createBackgroundJobWithStatus');
  expect(store).toContain('writeBackgroundJob');
  expect(store).not.toContain('generateMediaImages');
  expect(audit).toContain('appendAgentAuditRecord');
  expect(audit).toContain('agent_runtime_fault_v1');
  expect(listing).toContain("generate('listing', params, provider)");
  expect(image).toContain('IMAGE_JOB_CONCURRENCY = 6');
  expect(image).toContain('generateMediaImages');
});

test('audit projection keeps secret/contact redaction and input shape', () => {
  const redacted = redactJobAuditText(
    'authorization=super-secret-token-value-12345678901234567890 email=test@example.com https://example.com/path',
    500,
  );
  expect(redacted.text).toContain('[REDACTED_TOKEN]');
  expect(redacted.text).not.toContain('super-secret-token-value');
  expect(redacted.text).toContain('[REDACTED_EMAIL]');
  expect(redacted.text).toContain('[REDACTED_URL]');

  expect(summarizeJobInput({
    description: 'description',
    listing_type: 'digital',
    provider: 'external',
    prompt: 'prompt',
    count: 3,
  })).toEqual({
    description: 'description',
    listingType: 'digital',
    provider: 'external',
    prompt: 'prompt',
    count: 3,
  });
});
