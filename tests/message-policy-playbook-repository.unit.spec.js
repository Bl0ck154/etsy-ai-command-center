import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadMessageAutomationPolicy,
  saveMessageAutomationPolicy,
  validateMessageAutomationPolicyStore,
} from '../api/messages/automation-policy.js';
import {
  loadMessagePlaybook,
  saveMessagePlaybook,
  validateMessagePlaybookStore,
} from '../api/messages/playbook.js';
import {
  createMessageRevisionedStoreRepository,
  MESSAGE_REVISIONED_STORE_SCHEMA_VERSION,
} from '../api/messages/revisioned-store-repository.js';

const helper = fileURLToPath(new URL('./support/message-revision-process.mjs', import.meta.url));
const shopId = '23207964';

function testEnv() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'message-revisioned-store-'));
  const keys = ['MESSAGE_AUTOMATION_POLICY_FILE', 'MESSAGE_PLAYBOOK_FILE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    MESSAGE_AUTOMATION_POLICY_FILE: path.join(directory, 'policies.json'),
    MESSAGE_PLAYBOOK_FILE: path.join(directory, 'playbooks.json'),
  });
  return {
    directory,
    policyFile: process.env.MESSAGE_AUTOMATION_POLICY_FILE,
    playbookFile: process.env.MESSAGE_PLAYBOOK_FILE,
    restore() {
      for (const key of keys) delete process.env[key];
      for (const [key, value] of Object.entries(previous)) if (value !== undefined) process.env[key] = value;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function waitForFiles(files, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (files.every(file => fs.existsSync(file))) return resolve();
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for child readiness'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function child(kind, payload, readyFile, goFile) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const processHandle = spawn(process.execPath, [helper, kind, encoded, readyFile, goFile], {
    cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  processHandle.stdout.on('data', chunk => { stdout += chunk; });
  processHandle.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('close', code => {
      if (code !== 0) return reject(new Error(`Messages child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid child output: ${stdout} ${stderr}`)); }
    });
  });
}

function readWithPreviousMessagesStoreContract(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed?.version === 1 && parsed.shops && typeof parsed.shops === 'object'
    ? parsed
    : { version: 1, shops: {} };
}

test('policy and playbook persist distinct envelopes without leaking them through public payloads', async () => {
  const env = testEnv();
  try {
    const policy = await saveMessageAutomationPolicy(shopId, {
      enabled: true, delivery_mode: 'automatic_send', human_approval_required: false, rules: [],
    }, { expectedRevision: 0, updatedBy: 'owner' });
    const playbook = await saveMessagePlaybook(shopId, {
      tone: { summary: 'Concise.' },
    }, { expectedRevision: 0, updatedBy: 'owner' });

    expect(policy).not.toHaveProperty('schema_version');
    expect(policy.policy).toMatchObject({ delivery_mode: 'draft_only', human_approval_required: true });
    expect(playbook).not.toHaveProperty('schema_version');
    expect(JSON.parse(fs.readFileSync(env.policyFile, 'utf8'))).toMatchObject({
      schema_version: 1, record_type: 'message_automation_policy_store',
    });
    expect(JSON.parse(fs.readFileSync(env.playbookFile, 'utf8'))).toMatchObject({
      schema_version: 1, record_type: 'message_playbook_store',
    });
  } finally {
    env.restore();
  }
});

test('current policy and playbook envelopes remain readable after rollback to the previous reader', async () => {
  const env = testEnv();
  try {
    await saveMessageAutomationPolicy(shopId, {
      enabled: true,
      rules: [{ id: 'rollback-policy', enabled: true, event: 'new_message', scenario: 'freeform' }],
    }, { expectedRevision: 0, updatedBy: 'owner' });
    await saveMessagePlaybook(shopId, {
      tone: { summary: 'Rollback-compatible.' },
    }, { expectedRevision: 0, updatedBy: 'owner' });

    const previousPolicyStore = readWithPreviousMessagesStoreContract(env.policyFile);
    const previousPlaybookStore = readWithPreviousMessagesStoreContract(env.playbookFile);
    expect(previousPolicyStore).toMatchObject({
      version: 1,
      schema_version: MESSAGE_REVISIONED_STORE_SCHEMA_VERSION,
      record_type: 'message_automation_policy_store',
      shops: { [shopId]: { revision: 1 } },
    });
    expect(previousPlaybookStore).toMatchObject({
      version: 1,
      schema_version: MESSAGE_REVISIONED_STORE_SCHEMA_VERSION,
      record_type: 'message_playbook_store',
      shops: { [shopId]: { revision: 1 } },
    });
    expect(previousPolicyStore.shops[shopId].policy.rules[0].id).toBe('rollback-policy');
    expect(previousPlaybookStore.shops[shopId].playbook.tone.summary).toBe('Rollback-compatible.');

    await expect(loadMessageAutomationPolicy(shopId)).resolves.toMatchObject({ revision: 1 });
    await expect(loadMessagePlaybook(shopId)).resolves.toMatchObject({ revision: 1 });
  } finally {
    env.restore();
  }
});

test('startup validation explicitly migrates legacy policy and playbook stores', async () => {
  const env = testEnv();
  try {
    fs.writeFileSync(env.policyFile, JSON.stringify({ version: 1, shops: {
      [shopId]: {
        revision: 1, updated_at: '2026-01-01T00:00:00.000Z', updated_by: 'legacy',
        policy: { enabled: false, rules: [] },
      },
    } }));
    fs.writeFileSync(env.playbookFile, JSON.stringify({ version: 1, shops: {
      [shopId]: {
        revision: 1, updated_at: '2026-01-01T00:00:00.000Z', updated_by: 'legacy',
        playbook: { tone: {}, scenarios: {}, examples: [] },
      },
    } }));

    await expect(validateMessageAutomationPolicyStore()).resolves.toBe(true);
    await expect(validateMessagePlaybookStore()).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(env.policyFile, 'utf8')).record_type).toBe('message_automation_policy_store');
    const migratedPlaybook = JSON.parse(fs.readFileSync(env.playbookFile, 'utf8'));
    expect(migratedPlaybook.record_type).toBe('message_playbook_store');
    expect(migratedPlaybook.shops[shopId].history).toEqual([]);
    expect((await loadMessageAutomationPolicy(shopId)).policy.human_approval_required).toBe(true);
    expect((await loadMessagePlaybook(shopId)).revision).toBe(1);
  } finally {
    env.restore();
  }
});

test('startup validation fails closed for corrupt, unsupported, and mismatched stores', async () => {
  const env = testEnv();
  try {
    fs.writeFileSync(env.policyFile, '{broken');
    await expect(validateMessageAutomationPolicyStore()).rejects.toThrow(/invalid JSON/i);
    fs.writeFileSync(env.policyFile, JSON.stringify({
      schema_version: 2, record_type: 'message_automation_policy_store', shops: {},
    }));
    await expect(validateMessageAutomationPolicyStore()).rejects.toThrow(/unsupported/i);
    fs.writeFileSync(env.policyFile, JSON.stringify({
      schema_version: 1, record_type: 'message_playbook_store', shops: {},
    }));
    await expect(validateMessageAutomationPolicyStore()).rejects.toThrow(/envelope/i);
  } finally {
    env.restore();
  }
});

for (const kind of ['policy', 'playbook']) {
  test(`two processes using the same expected revision produce one ${kind} winner`, async () => {
    const env = testEnv();
    try {
      const goFile = path.join(env.directory, `${kind}.go`);
      const readyFiles = [1, 2].map(index => path.join(env.directory, `${kind}-${index}.ready`));
      const payloads = readyFiles.map((_, index) => kind === 'policy' ? {
        shopId,
        value: { enabled: true, rules: [{ id: `rule-${index}`, enabled: true, event: 'new_message', scenario: 'freeform' }] },
        options: { expectedRevision: 0, updatedBy: `writer-${index}` },
      } : {
        shopId,
        value: { tone: { summary: `Writer ${index}` } },
        options: { expectedRevision: 0, updatedBy: `writer-${index}` },
      });
      const results = readyFiles.map((readyFile, index) => child(kind, payloads[index], readyFile, goFile));
      await waitForFiles(readyFiles);
      fs.writeFileSync(goFile, 'go');
      const outcomes = await Promise.all(results);
      expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
      const conflict = outcomes.find(outcome => !outcome.ok);
      expect(conflict).toMatchObject({ status: 409 });
      expect(conflict.code).toBe(kind === 'policy'
        ? 'MESSAGE_AUTOMATION_REVISION_CONFLICT'
        : 'MESSAGE_PLAYBOOK_REVISION_CONFLICT');
      const stored = kind === 'policy'
        ? await loadMessageAutomationPolicy(shopId)
        : await loadMessagePlaybook(shopId);
      expect(stored.revision).toBe(1);
    } finally {
      env.restore();
    }
  });
}

test('crash before replace preserves the prior store and removes the temporary file', async () => {
  const env = testEnv();
  try {
    const initial = {
      schema_version: MESSAGE_REVISIONED_STORE_SCHEMA_VERSION,
      record_type: 'message_test_store', shops: {},
    };
    fs.writeFileSync(env.policyFile, `${JSON.stringify(initial)}\n`);
    const repository = createMessageRevisionedStoreRepository({
      file: () => env.policyFile,
      recordType: 'message_test_store',
      validateRecord: record => Number.isInteger(record?.revision),
      beforeAtomicReplace: async () => { throw new Error('simulated crash'); },
    });
    await expect(repository.save(shopId, {
      expectedRevision: 0,
      conflictError: () => new Error('conflict'),
      buildRecord: () => ({ revision: 1 }),
    })).rejects.toThrow(/simulated crash/);
    expect(JSON.parse(fs.readFileSync(env.policyFile, 'utf8'))).toEqual(initial);
    expect(fs.readdirSync(env.directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(fs.existsSync(`${env.policyFile}.lock`)).toBe(false);
  } finally {
    env.restore();
  }
});

test('live owner TTL protection and token fencing prevent stale overwrite', async () => {
  const env = testEnv();
  try {
    const initial = {
      schema_version: 1, record_type: 'message_test_store', shops: {},
    };
    fs.writeFileSync(env.policyFile, `${JSON.stringify(initial)}\n`);
    fs.writeFileSync(`${env.policyFile}.lock`, JSON.stringify({
      token: 'live-owner', pid: process.pid, hostname: os.hostname(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }));
    const blocked = createMessageRevisionedStoreRepository({
      file: () => env.policyFile, recordType: 'message_test_store',
      validateRecord: record => Number.isInteger(record?.revision), lockWaitMs: 30, lockRetryMs: 5,
    });
    await expect(blocked.validate()).rejects.toThrow(/timed out waiting/i);
    fs.rmSync(`${env.policyFile}.lock`, { force: true });

    const fenced = createMessageRevisionedStoreRepository({
      file: () => env.policyFile, recordType: 'message_test_store',
      validateRecord: record => Number.isInteger(record?.revision),
      beforeAtomicReplace: async () => {
        fs.writeFileSync(`${env.policyFile}.lock`, JSON.stringify({ token: 'replacement-owner' }));
      },
    });
    await expect(fenced.save(shopId, {
      expectedRevision: 0,
      conflictError: () => new Error('conflict'),
      buildRecord: () => ({ revision: 1 }),
    })).rejects.toThrow(/ownership was lost/i);
    expect(JSON.parse(fs.readFileSync(env.policyFile, 'utf8')).shops).toEqual({});
  } finally {
    env.restore();
  }
});

test('startup validation reclaims a lock abandoned by a crashed process', async () => {
  const env = testEnv();
  try {
    fs.writeFileSync(env.policyFile, `${JSON.stringify({
      schema_version: 1, record_type: 'message_test_store', shops: {},
    })}\n`);
    fs.writeFileSync(`${env.policyFile}.lock`, JSON.stringify({
      token: 'crashed-owner', pid: 99999999, hostname: os.hostname(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }));
    const repository = createMessageRevisionedStoreRepository({
      file: () => env.policyFile, recordType: 'message_test_store',
      validateRecord: record => Number.isInteger(record?.revision), lockWaitMs: 100,
    });
    await expect(repository.validate()).resolves.toBe(true);
    expect(fs.existsSync(`${env.policyFile}.lock`)).toBe(false);
  } finally {
    env.restore();
  }
});

test('Message Trigger remains a policy/playbook reader, never a writer', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'api/messages/trigger-runner.js'), 'utf8');
  expect(source).toContain('loadMessageAutomationPolicy');
  expect(source).toContain('loadMessagePlaybook');
  expect(source).not.toContain('saveMessageAutomationPolicy');
  expect(source).not.toContain('saveMessagePlaybook');
});
