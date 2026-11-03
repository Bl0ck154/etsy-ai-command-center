import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_SCRIPT = path.join(
  ROOT,
  'scripts',
  'prepare-how-to-order-policy.js',
);
const PLAYBOOK_SCRIPT = path.join(
  ROOT,
  'scripts',
  'bootstrap-how-to-order-playbook.js',
);

function policyFixture() {
  return {
    version: 1,
    shops: {
      23207964: {
        revision: 2,
        updated_at: '2026-07-28T08:00:00.000Z',
        updated_by: 'fixture',
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
            conditions: 'Keep this.',
            owner_notes: 'Keep this.',
          }, {
            id: 'new_message_how_to_order',
            label: 'How to order',
            enabled: true,
            event: 'new_message',
            scenario: 'how_to_order',
            delay_minutes: 0,
            cooldown_minutes: 720,
            require_order_context: false,
            conditions: 'Old broad condition.',
            owner_notes: 'Old notes.',
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
        updated_at: '2026-07-28T08:00:00.000Z',
        updated_by: 'fixture',
        playbook: {
          tone: {
            summary: 'Preserve tone.',
            response_length: 'Preserve length.',
            language_policy: 'English.',
            signature: '',
          },
          hard_rules: ['Preserve hard rule.'],
          avoid_phrases: [],
          scenarios: {
            how_to_send_files: {
              label: 'Files',
              enabled: true,
              requires_order_context: false,
              instructions: 'Preserve files instructions.',
            },
            how_to_order: {
              label: 'Order',
              enabled: true,
              requires_order_context: false,
              instructions: 'Old order instructions.',
            },
          },
          examples: [{
            id: 'preserved',
            scenario: 'how_to_send_files',
            customer_message: 'Files?',
            ideal_reply: 'Reply.',
            context: '',
            notes: '',
          }],
        },
        history: [],
      },
    },
  };
}

test('policy preparation narrows and disables only how-to-order rule', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'order-policy-'));
  const file = path.join(directory, 'policy.json');
  const initial = policyFixture();
  await fs.writeFile(file, JSON.stringify(initial), 'utf8');

  const dry = spawnSync(
    process.execPath,
    [POLICY_SCRIPT, '--policy-file', file],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(dry.status).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({
    mode: 'dry_run',
    rule_id: 'new_message_how_to_order',
    enabled: false,
    narrow_conditions_present: true,
    clarification_only_without_listing: true,
  });
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(initial);

  const applied = spawnSync(
    process.execPath,
    [POLICY_SCRIPT, '--policy-file', file, '--apply'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(applied.status).toBe(0);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    .shops['23207964'];
  expect(saved.revision).toBe(3);
  expect(saved.policy.rules[0]).toEqual(initial.shops['23207964'].policy.rules[0]);
  expect(saved.policy.rules[1]).toMatchObject({
    id: 'new_message_how_to_order',
    enabled: false,
  });
  expect(saved.policy.rules[1].conditions).toContain(
    'exact newest unanswered incoming buyer message',
  );
  expect(saved.policy.rules[1].conditions).toContain('mixed-intent');
  expect(saved.policy.rules[1].owner_notes).toContain(
    'exactly one concise clarification question',
  );
});
test('playbook bootstrap adds exact-listing and clarification examples', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'order-playbook-'));
  const file = path.join(directory, 'playbook.json');
  const initial = playbookFixture();
  await fs.writeFile(file, JSON.stringify(initial), 'utf8');

  const applied = spawnSync(
    process.execPath,
    [PLAYBOOK_SCRIPT, '--playbook-file', file, '--apply'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(applied.status).toBe(0);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    .shops['23207964'];
  expect(saved.revision).toBe(5);
  expect(saved.playbook.tone).toEqual(
    initial.shops['23207964'].playbook.tone,
  );
  expect(saved.playbook.scenarios.how_to_send_files).toEqual({
    ...initial.shops['23207964'].playbook.scenarios.how_to_send_files,
    requires_order_context: true,
  });
  expect(saved.playbook.scenarios.how_to_order).toMatchObject({
    enabled: true,
    requires_order_context: false,
  });
  expect(saved.playbook.scenarios.how_to_order.instructions).toContain(
    'exact verified listing facts',
  );
  expect(saved.playbook.examples.map(example => example.id)).toEqual(
    expect.arrayContaining([
      'preserved',
      'how_to_order_without_exact_listing',
      'how_to_order_with_exact_listing_options',
    ]),
  );
});

test('how-to-order preparation refuses another shop', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'order-scope-'));
  const policyFile = path.join(directory, 'policy.json');
  const playbookFile = path.join(directory, 'playbook.json');
  await fs.writeFile(policyFile, JSON.stringify(policyFixture()), 'utf8');
  await fs.writeFile(playbookFile, JSON.stringify(playbookFixture()), 'utf8');

  for (const [script, flag, file] of [
    [POLICY_SCRIPT, '--policy-file', policyFile],
    [PLAYBOOK_SCRIPT, '--playbook-file', playbookFile],
  ]) {
    const result = spawnSync(
      process.execPath,
      [script, flag, file, '--shop-id', '99999999', '--apply'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('shop must be exactly 23207964');
  }
});

test('deploy bundle includes how-to-order preparation helpers', async () => {
  const deploy = await fs.readFile(
    path.join(ROOT, 'scripts', 'deploy-vps-staging.sh'),
    'utf8',
  );
  expect(deploy).toContain('scripts/bootstrap-how-to-order-playbook.js');
  expect(deploy).toContain('scripts/prepare-how-to-order-policy.js');
});
