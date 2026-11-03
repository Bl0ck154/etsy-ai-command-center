import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertRuntimeFileOwner } from '../api/messages/runtime-file-owner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(
  ROOT,
  'scripts',
  'enable-missing-materials-draft-policy.js',
);

function fixture() {
  return {
    version: 1,
    shops: {
      23207964: {
        revision: 9,
        updated_at: '2026-07-28T08:00:00.000Z',
        updated_by: 'fixture',
        policy: {
          enabled: true,
          delivery_mode: 'draft_only',
          human_approval_required: true,
          rules: [{
            id: 'new_message_send_files',
            label: 'Buyer asks how to send files',
            enabled: true,
            event: 'new_message',
            scenario: 'how_to_send_files',
            delay_minutes: 0,
            cooldown_minutes: 720,
            require_order_context: false,
            conditions: 'Buyer asks how to send files.',
            owner_notes: '',
          }, {
            id: 'new_message_how_to_order',
            label: 'Buyer asks how to order',
            enabled: true,
            event: 'new_message',
            scenario: 'how_to_order',
            delay_minutes: 0,
            cooldown_minutes: 720,
            require_order_context: false,
            conditions: 'Buyer asks how to order.',
            owner_notes: '',
          }, {
            id: 'order_paid_missing_materials',
            label: 'Paid order still has no materials',
            enabled: false,
            event: 'order_paid',
            scenario: 'missing_materials',
            delay_minutes: 60,
            cooldown_minutes: 120,
            require_order_context: false,
            conditions: 'Verified paid order still has no materials.',
            owner_notes: '',
          }, {
            id: 'order_completed_review',
            label: 'Ask for a review',
            enabled: true,
            event: 'order_completed',
            scenario: 'review_request',
            delay_minutes: 4_320,
            cooldown_minutes: 10_080,
            require_order_context: true,
            conditions: 'Order completed.',
            owner_notes: '',
          }],
        },
      },
    },
  };
}

test('activation enables only send-files and delayed missing-materials drafts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-policy-'));
  const policyFile = path.join(directory, 'policy.json');
  const initial = fixture();
  await fs.writeFile(policyFile, JSON.stringify(initial), 'utf8');

  const dryRun = spawnSync(
    process.execPath,
    [SCRIPT, '--policy-file', policyFile],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(dryRun.status).toBe(0);
  expect(JSON.parse(dryRun.stdout)).toMatchObject({
    mode: 'dry_run',
    shop_id: '23207964',
    current_revision: 9,
    delivery_mode: 'draft_only',
    human_approval_required: true,
    enabled_rule_ids: [
      'new_message_send_files',
      'order_paid_missing_materials',
    ],
    how_to_order_enabled: false,
    missing_materials: {
      delay_minutes: 1_440,
      cooldown_minutes: 10_080,
      require_order_context: true,
    },
    all_other_rules_disabled: true,
  });
  expect(JSON.parse(await fs.readFile(policyFile, 'utf8'))).toEqual(initial);

  const applied = spawnSync(
    process.execPath,
    [SCRIPT, '--policy-file', policyFile, '--apply'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(applied.status).toBe(0);
  expect(applied.stderr).toBe('');
  expect(JSON.parse(applied.stdout)).toMatchObject({
    mode: 'applied',
    revision: 10,
    enabled_rule_ids: [
      'new_message_send_files',
      'order_paid_missing_materials',
    ],
    how_to_order_enabled: false,
  });

  const saved = JSON.parse(await fs.readFile(policyFile, 'utf8'))
    .shops['23207964'];
  expect(saved.updated_by).toBe(
    'operator:enable-missing-materials-draft-policy',
  );
  expect(saved.policy).toMatchObject({
    enabled: true,
    delivery_mode: 'draft_only',
    human_approval_required: true,
  });
  expect(saved.policy.rules.map(rule => ({
    id: rule.id,
    enabled: rule.enabled,
  }))).toEqual([
    { id: 'new_message_send_files', enabled: true },
    { id: 'new_message_how_to_order', enabled: false },
    { id: 'order_paid_missing_materials', enabled: true },
    { id: 'order_completed_review', enabled: false },
  ]);
  expect(saved.policy.rules.find(
    rule => rule.id === 'order_paid_missing_materials',
  )).toMatchObject({
    delay_minutes: 1_440,
    cooldown_minutes: 10_080,
    require_order_context: true,
  });
});

test('activation refuses a different shop and requires an explicit policy file', async () => {
  const withoutFile = spawnSync(
    process.execPath,
    [SCRIPT, '--apply'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(withoutFile.status).toBe(1);
  expect(withoutFile.stderr).toContain(
    '--policy-file must be provided explicitly',
  );

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-policy-'));
  const policyFile = path.join(directory, 'policy.json');
  await fs.writeFile(policyFile, JSON.stringify(fixture()), 'utf8');
  const wrongShop = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--policy-file',
      policyFile,
      '--shop-id',
      '99999999',
      '--apply',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(wrongShop.status).toBe(1);
  expect(wrongShop.stderr).toContain('shop must be exactly 23207964');
});

test('runtime owner guard refuses a mismatched uid', () => {
  expect(() => assertRuntimeFileOwner({
    currentUid: 1001,
    fileUid: 1002,
    label: 'policy file',
  })).toThrow(/file uid 1002, current uid 1001/);

  expect(() => assertRuntimeFileOwner({
    currentUid: 1001,
    fileUid: 1001,
    label: 'policy file',
  })).not.toThrow();
});

test('deploy includes the activation helper and its owner guard', () => {
  const deploy = fsSync.readFileSync(
    path.join(ROOT, 'scripts', 'deploy-vps-staging.sh'),
    'utf8',
  );
  const source = fsSync.readFileSync(SCRIPT, 'utf8');

  expect(deploy).toContain('scripts/enable-missing-materials-draft-policy.js');
  expect(source).toContain('assertRuntimeFileOwner');
  expect(source).toContain('expectedRevision: Number(current.revision) || 0');
  expect(source).toContain("process.argv.includes('--apply')");
});
