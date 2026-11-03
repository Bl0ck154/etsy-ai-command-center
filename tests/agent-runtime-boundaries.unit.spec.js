import fs from 'node:fs';
import { expect, test } from '@playwright/test';

test('agent runtime contract entry stays a compatibility facade', () => {
  const source = fs.readFileSync(new URL('../public/utils/agent-runtime-contract.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(30);
  expect(source).not.toContain('FAULT_DOMAINS');
  expect(source).not.toContain('function listingWorkflowSnapshot');
  expect(source).not.toContain('for (let index = 0; index < candidates.length; index++)');
  expect(source).toContain("./agent-runtime/faults.js");
  expect(source).toContain("./agent-runtime/listing-workflow.js");
  expect(source).toContain("./agent-runtime/recovery.js");
});

test('focused runtime owners do not absorb browser persistence or transport', () => {
  for (const path of [
    '../public/utils/agent-runtime/faults.js',
    '../public/utils/agent-runtime/listing-workflow.js',
    '../public/utils/agent-runtime/recovery.js',
  ]) {
    const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|jobs\.|kv\.|etsy\./);
  }
});
