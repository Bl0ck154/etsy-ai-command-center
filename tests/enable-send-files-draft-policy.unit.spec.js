import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(
  ROOT,
  'scripts',
  'enable-send-files-draft-policy.js',
);

function fixture() {
  return {
    version: 1,
    shops: {
      23207964: {
        revision: 7,
        updated_at: '2026-07-28T08:00:00.000Z',
        updated_by: 'fixture',
        policy: {
          enabled: false,
          delivery_mode: 'draft_only',
          human_approval_required: true,
          rules: [{
            id: 'new_message_send_files',
            label: 'Buyer asks how to send files',
            enabled: false,
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
            enabled: true,
            event: 'order_paid',
            scenario: 'missing_materials',
            delay_minutes: 1440,
            cooldown_minutes: 10080,
            require_order_context: true,
            conditions: '',
            owner_notes: '',
          }],
        },
      },
    },
  };
}

test('one-time policy script atomically enables only send-files draft rule', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-policy-'));
  const policyFile = path.join(directory, 'policy.json');
  await fs.writeFile(policyFile, JSON.stringify(fixture()), 'utf8');

  const dryRun = spawnSync(
    process.execPath,
    [SCRIPT, '--policy-file', policyFile],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(dryRun.status).toBe(0);
  expect(JSON.parse(dryRun.stdout)).toMatchObject({
    mode: 'dry_run',
    shop_id: '23207964',
    current_revision: 7,
    delivery_mode: 'draft_only',
    human_approval_required: true,
    enabled_rule_ids: ['new_message_send_files'],
    all_other_rules_disabled: true,
  });
  expect(JSON.parse(await fs.readFile(policyFile, 'utf8'))).toEqual(fixture());

  const applied = spawnSync(
    process.execPath,
    [SCRIPT, '--policy-file', policyFile, '--apply'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(applied.status).toBe(0);
  expect(applied.stderr).toBe('');
  expect(JSON.parse(applied.stdout)).toMatchObject({
    mode: 'applied',
    shop_id: '23207964',
    revision: 8,
    delivery_mode: 'draft_only',
    human_approval_required: true,
    enabled_rule_ids: ['new_message_send_files'],
    all_other_rules_disabled: true,
  });

  const saved = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  expect(saved.shops['23207964'].revision).toBe(8);
  expect(saved.shops['23207964'].policy).toMatchObject({
    enabled: true,
    delivery_mode: 'draft_only',
    human_approval_required: true,
  });
  expect(saved.shops['23207964'].policy.rules.map(rule => ({
    id: rule.id,
    enabled: rule.enabled,
  }))).toEqual([
    { id: 'new_message_send_files', enabled: true },
    { id: 'new_message_how_to_order', enabled: false },
    { id: 'order_paid_missing_materials', enabled: false },
  ]);
});

test('one-time policy script refuses any other shop scope', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-policy-'));
  const policyFile = path.join(directory, 'policy.json');
  await fs.writeFile(policyFile, JSON.stringify(fixture()), 'utf8');

  const result = spawnSync(
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
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('shop must be exactly 23207964');
  expect(JSON.parse(await fs.readFile(policyFile, 'utf8'))).toEqual(fixture());
});

test('activation and deploy preserve the service-owned runtime boundary', () => {
  const activation = fsSync.readFileSync(SCRIPT, 'utf8');
  const deploy = fsSync.readFileSync(
    path.join(ROOT, 'scripts', 'deploy-vps-staging.sh'),
    'utf8',
  );

  expect(activation).toContain("typeof process.getuid === 'function'");
  expect(activation).toContain('currentUid !== policyStat.uid');
  expect(activation).toContain('run --apply as the existing policy file owner');
  expect(deploy).toContain('scripts/enable-send-files-draft-policy.js');
  expect(deploy).toContain('MESSAGE_RUNTIME_FILES=(');
  expect(deploy).toContain(
    'sudo chown etsy-manager:etsy-manager "$LIVE_DIR/data/$runtime_file"',
  );
  expect(deploy).toContain(
    'sudo chmod 0600 "$LIVE_DIR/data/$runtime_file"',
  );
  expect(deploy).toContain(
    'sudo install -d -o etsy-manager -g etsy-manager -m 0750 "$LIVE_DIR/data/drafts"',
  );
  expect(deploy).toContain(
    'sudo install -d -o etsy-manager -g etsy-manager -m 0750 "$LIVE_DIR/data/jobs"',
  );
});
