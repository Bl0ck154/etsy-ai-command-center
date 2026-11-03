import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('client workspace keys separate authenticated users in the same shop', async () => {
  const { workspaceScopeFor } = await import(`../public/utils/user-scope.js?isolation=${Date.now()}`);
  expect(workspaceScopeFor('seller-a', '12345678')).toBe('seller-a:12345678');
  expect(workspaceScopeFor('seller-b', '12345678')).toBe('seller-b:12345678');
  expect(workspaceScopeFor('seller-a', '12345678')).not.toBe(workspaceScopeFor('seller-b', '12345678'));
});

test('server create draft filenames include both shop and authenticated user', async () => {
  const { draftStorageFilename } = await import(`../api/drafts.js?isolation=${Date.now()}`);
  expect(draftStorageFilename({ shopId: '12345678', userId: 'seller-a' })).toBe('12345678-seller-a-create_draft.json');
  expect(draftStorageFilename({ shopId: '12345678', userId: 'seller-b' })).toBe('12345678-seller-b-create_draft.json');
});

test('background jobs cannot be read or claimed by another authenticated user', async () => {
  const previousJobsDir = process.env.JOBS_DIR;
  const previousAuditDir = process.env.AGENT_AUDIT_DIR;
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-manager-jobs-'));
  process.env.JOBS_DIR = jobsDir;
  process.env.AGENT_AUDIT_DIR = path.join(jobsDir, 'audit');
  try {
    const jobs = await import(`../api/jobs.js?isolation=${Date.now()}`);
    const id = `job_agent_isolation_${Date.now().toString(36)}`;
    const created = jobs.createBackgroundJob(id, 'agent_turn', { description: 'Private turn' }, 'seller-a');
    expect(created?.owner_id).toBe('seller-a');
    expect(await jobs.getBackgroundJob(id, 'seller-a')).toBeTruthy();
    expect(await jobs.getBackgroundJob(id, 'seller-b')).toBeNull();
    expect(jobs.createBackgroundJob(id, 'agent_turn', { description: 'Collision' }, 'seller-b')).toBeNull();
  } finally {
    if (previousJobsDir === undefined) delete process.env.JOBS_DIR;
    else process.env.JOBS_DIR = previousJobsDir;
    if (previousAuditDir === undefined) delete process.env.AGENT_AUDIT_DIR;
    else process.env.AGENT_AUDIT_DIR = previousAuditDir;
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(jobsDir, { recursive: true, force: true });
  }
});
