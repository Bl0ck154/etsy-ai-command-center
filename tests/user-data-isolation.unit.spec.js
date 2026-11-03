import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('client workspace keys separate authenticated users in the same shop', async () => {
  const { workspaceScopeFor } = await import(`../public/utils/user-scope.js?isolation=${Date.now()}`);
  expect(workspaceScopeFor('illia', '23207964')).toBe('illia:23207964');
  expect(workspaceScopeFor('second-admin', '23207964')).toBe('second-admin:23207964');
  expect(workspaceScopeFor('illia', '23207964')).not.toBe(workspaceScopeFor('second-admin', '23207964'));
});

test('server create draft filenames include both shop and authenticated user', async () => {
  const { draftStorageFilename } = await import(`../api/drafts.js?isolation=${Date.now()}`);
  expect(draftStorageFilename({ shopId: '23207964', userId: 'illia' })).toBe('23207964-illia-create_draft.json');
  expect(draftStorageFilename({ shopId: '23207964', userId: 'second-admin' })).toBe('23207964-second-admin-create_draft.json');
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
    const created = jobs.createBackgroundJob(id, 'agent_turn', { description: 'Private turn' }, 'illia');
    expect(created?.owner_id).toBe('illia');
    expect(await jobs.getBackgroundJob(id, 'illia')).toBeTruthy();
    expect(await jobs.getBackgroundJob(id, 'second-admin')).toBeNull();
    expect(jobs.createBackgroundJob(id, 'agent_turn', { description: 'Collision' }, 'second-admin')).toBeNull();
  } finally {
    if (previousJobsDir === undefined) delete process.env.JOBS_DIR;
    else process.env.JOBS_DIR = previousJobsDir;
    if (previousAuditDir === undefined) delete process.env.AGENT_AUDIT_DIR;
    else process.env.AGENT_AUDIT_DIR = previousAuditDir;
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('deployment includes the shared user-scope module and gallery metadata is user-scoped', () => {
  const deploy = fs.readFileSync(new URL('../scripts/deploy-vps-staging.sh', import.meta.url), 'utf8');
  const kv = fs.readFileSync(new URL('../api/kv.js', import.meta.url), 'utf8');
  expect(deploy).toContain('public/utils/user-scope.js');
  expect(kv).toContain('`${SHOP_ID}:user:${userId}:gallery:meta`');
  expect(kv).toContain('`${SHOP_ID}:user:${userId}:gallery:videos`');
});
