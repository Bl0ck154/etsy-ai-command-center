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
  'bootstrap-send-files-playbook.js',
);

function fixture() {
  return {
    version: 1,
    shops: {
      23207964: {
        revision: 4,
        updated_at: '2026-07-28T08:00:00.000Z',
        updated_by: 'fixture',
        playbook: {
          tone: {
            summary: 'Keep this exact tone.',
            response_length: 'Keep this exact length.',
            language_policy: 'Keep this exact language policy.',
            signature: 'Keep this signature.',
          },
          hard_rules: ['Keep this hard rule.'],
          avoid_phrases: ['keep this avoided phrase'],
          scenarios: {
            how_to_send_files: {
              label: 'Existing send-files label',
              enabled: true,
              requires_order_context: false,
              instructions: 'Old instructions.',
            },
            how_to_order: {
              label: 'Existing order label',
              enabled: false,
              requires_order_context: false,
              instructions: 'Keep this order instruction.',
            },
          },
          examples: [{
            id: 'existing_example',
            scenario: 'how_to_order',
            customer_message: 'How do I order?',
            ideal_reply: 'Keep this example.',
            context: 'Existing context.',
            notes: 'Existing notes.',
          }],
        },
        history: [{
          revision: 4,
          updated_at: '2026-07-28T08:00:00.000Z',
          updated_by: 'fixture',
        }],
      },
    },
  };
}

test('bootstrap safely adds only the Etsy-conversation guidance and example', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-playbook-'));
  const playbookFile = path.join(directory, 'playbook.json');
  const initial = fixture();
  await fs.writeFile(playbookFile, JSON.stringify(initial), 'utf8');

  const dryRun = spawnSync(
    process.execPath,
    [SCRIPT, '--playbook-file', playbookFile],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(dryRun.status).toBe(0);
  expect(JSON.parse(dryRun.stdout)).toMatchObject({
    mode: 'dry_run',
    shop_id: '23207964',
    current_revision: 4,
    how_to_send_files: {
      enabled: true,
      requires_order_context: true,
      uses_current_etsy_conversation: true,
      asks_buyer_to_report_unavailable_control: true,
    },
    approved_example: {
      id: 'how_to_send_photos_in_etsy_conversation',
      scenario: 'how_to_send_files',
      present: true,
    },
  });
  expect(JSON.parse(await fs.readFile(playbookFile, 'utf8'))).toEqual(initial);

  const applied = spawnSync(
    process.execPath,
    [SCRIPT, '--playbook-file', playbookFile, '--apply'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(applied.status).toBe(0);
  expect(applied.stderr).toBe('');
  expect(JSON.parse(applied.stdout)).toMatchObject({
    mode: 'applied',
    revision: 5,
    updated_by: 'operator:bootstrap-send-files-playbook',
  });

  const saved = JSON.parse(await fs.readFile(playbookFile, 'utf8'))
    .shops['23207964'];
  expect(saved.revision).toBe(5);
  expect(saved.playbook.tone).toEqual(initial.shops['23207964'].playbook.tone);
  expect(saved.playbook.hard_rules).toEqual(
    initial.shops['23207964'].playbook.hard_rules,
  );
  expect(saved.playbook.avoid_phrases).toEqual(
    initial.shops['23207964'].playbook.avoid_phrases,
  );
  expect(saved.playbook.scenarios.how_to_send_files).toMatchObject({
    label: 'Existing send-files label',
    enabled: true,
    requires_order_context: true,
  });
  expect(saved.playbook.scenarios.how_to_send_files.instructions).toContain(
    'send the files here in the current Etsy conversation',
  );
  expect(saved.playbook.scenarios.how_to_order).toMatchObject({
    label: 'Existing order label',
    enabled: false,
    instructions: 'Keep this order instruction.',
  });
  expect(saved.playbook.examples).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'existing_example' }),
    expect.objectContaining({
      id: 'how_to_send_photos_in_etsy_conversation',
      scenario: 'how_to_send_files',
      customer_message: 'Can I send you the photos here?',
    }),
  ]));
});

test('bootstrap refuses any other shop scope', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-playbook-'));
  const playbookFile = path.join(directory, 'playbook.json');
  const initial = fixture();
  await fs.writeFile(playbookFile, JSON.stringify(initial), 'utf8');

  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--playbook-file',
      playbookFile,
      '--shop-id',
      '99999999',
      '--apply',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('shop must be exactly 23207964');
  expect(JSON.parse(await fs.readFile(playbookFile, 'utf8'))).toEqual(initial);
});
