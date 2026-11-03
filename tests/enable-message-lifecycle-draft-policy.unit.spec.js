import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(
  ROOT,
  'scripts',
  'enable-message-lifecycle-draft-policy.js',
);

function policyFixture() {
  return {
    version: 1,
    shops: {
      23207964: {
        revision: 6,
        policy: {
          enabled: true,
          delivery_mode: 'draft_only',
          human_approval_required: true,
          rules: [{
            id: 'new_message_send_files',
            label: 'Send files',
            enabled: true,
            event: 'new_message',
            scenario: 'how_to_send_files',
            delay_minutes: 0,
            cooldown_minutes: 720,
            require_order_context: false,
          }, {
            id: 'new_message_how_to_order',
            label: 'How to order',
            enabled: true,
            event: 'new_message',
            scenario: 'how_to_order',
            delay_minutes: 0,
            cooldown_minutes: 720,
            require_order_context: false,
          }, {
            id: 'order_paid_missing_materials',
            label: 'Missing materials',
            enabled: true,
            event: 'order_paid',
            scenario: 'missing_materials',
            delay_minutes: 1_440,
            cooldown_minutes: 10_080,
            require_order_context: true,
          }],
        },
      },
    },
  };
}

function playbookFixture() {
  return {
    version: 1,
    shops: {
      23207964: {
        revision: 4,
        playbook: {
          tone: {
            summary: 'Keep existing tone.',
            response_length: 'One paragraph.',
            language_policy: 'Use buyer language.',
            signature: '',
          },
          hard_rules: ['Keep existing hard rule.'],
          avoid_phrases: [],
          scenarios: {},
          examples: [{
            id: 'keep_me',
            scenario: 'freeform',
            customer_message: 'Hello',
            ideal_reply: 'Hi',
          }],
        },
      },
    },
  };
}

test('prepares all six draft-only scenarios and preserves manager training', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-policy-'));
  const policyFile = path.join(directory, 'policy.json');
  const playbookFile = path.join(directory, 'playbook.json');
  await fs.writeFile(policyFile, JSON.stringify(policyFixture()), 'utf8');
  await fs.writeFile(playbookFile, JSON.stringify(playbookFixture()), 'utf8');

  const applied = spawnSync(process.execPath, [
    SCRIPT,
    '--policy-file', policyFile,
    '--playbook-file', playbookFile,
    '--apply',
  ], { cwd: ROOT, encoding: 'utf8' });

  expect(applied.status).toBe(0);
  expect(applied.stderr).toBe('');
  expect(JSON.parse(applied.stdout)).toMatchObject({
    mode: 'applied',
    policy_revision: 7,
    playbook_revision: 5,
    enabled_rule_ids: [
      'listing_deadline_no_materials',
      'new_message_how_to_order',
      'new_message_materials_sent_by_email',
      'new_message_send_files',
      'order_completed_review',
      'order_paid_missing_materials',
    ],
    missing_materials_delay_minutes: 1_440,
    review_delay_minutes: 20_160,
    human_approval_required: true,
  });

  const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'))
    .shops['23207964'].policy;
  expect(policy.delivery_mode).toBe('draft_only');
  expect(policy.human_approval_required).toBe(true);
  expect(policy.rules.find(
    rule => rule.id === 'new_message_materials_sent_by_email',
  )).toMatchObject({
    event: 'new_message',
    scenario: 'materials_sent_by_email',
    delay_minutes: 0,
    require_order_context: true,
  });
  expect(policy.rules.find(
    rule => rule.id === 'listing_deadline_no_materials',
  )).toMatchObject({
    event: 'listing_deadline',
    scenario: 'deadline_no_materials',
    delay_minutes: 0,
    require_order_context: true,
  });
  expect(policy.rules.find(
    rule => rule.id === 'order_completed_review',
  )).toMatchObject({
    event: 'order_completed',
    scenario: 'review_request',
    delay_minutes: 20_160,
    require_order_context: true,
  });

  const playbook = JSON.parse(await fs.readFile(playbookFile, 'utf8'))
    .shops['23207964'].playbook;
  expect(playbook.tone.summary).toBe('Keep existing tone.');
  expect(playbook.hard_rules).toEqual(['Keep existing hard rule.']);
  expect(playbook.examples.some(example => example.id === 'keep_me')).toBe(true);
  expect(playbook.scenarios.deadline_no_materials.enabled).toBe(true);
  expect(playbook.scenarios.review_request.enabled).toBe(true);
  expect(playbook.scenarios.materials_sent_by_email.enabled).toBe(true);
});

test('dry-run is non-mutating and wrong shop is refused', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-policy-'));
  const policyFile = path.join(directory, 'policy.json');
  const playbookFile = path.join(directory, 'playbook.json');
  const initialPolicy = policyFixture();
  const initialPlaybook = playbookFixture();
  await fs.writeFile(policyFile, JSON.stringify(initialPolicy), 'utf8');
  await fs.writeFile(playbookFile, JSON.stringify(initialPlaybook), 'utf8');

  const dryRun = spawnSync(process.execPath, [
    SCRIPT,
    '--policy-file', policyFile,
    '--playbook-file', playbookFile,
  ], { cwd: ROOT, encoding: 'utf8' });
  expect(dryRun.status).toBe(0);
  expect(JSON.parse(dryRun.stdout).mode).toBe('dry_run');
  expect(JSON.parse(await fs.readFile(policyFile, 'utf8'))).toEqual(initialPolicy);
  expect(JSON.parse(await fs.readFile(playbookFile, 'utf8'))).toEqual(initialPlaybook);

  const refused = spawnSync(process.execPath, [
    SCRIPT,
    '--shop-id', '999',
    '--policy-file', policyFile,
    '--playbook-file', playbookFile,
    '--apply',
  ], { cwd: ROOT, encoding: 'utf8' });
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('shop must be exactly 23207964');
});
