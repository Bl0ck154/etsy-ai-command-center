import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test('deploy runs GPT contract and unit suites before copying runtime files', () => {
  const deploy = fs.readFileSync(new URL('../scripts/deploy-vps-staging.sh', import.meta.url), 'utf8');
  const contractGate = deploy.indexOf('npm --prefix "$SOURCE_DIR" run test:gpt:contract');
  const unitGate = deploy.match(/npm --prefix "\$SOURCE_DIR" run test:gpt \\\r?\n/)?.index ?? -1;
  const firstRuntimeCopy = deploy.indexOf('sudo install -d -o etsy-manager -g etsy-manager -m 0750 "$BACKUP_DIR"');

  expect(contractGate).toBeGreaterThan(0);
  expect(unitGate).toBeGreaterThan(contractGate);
  expect(firstRuntimeCopy).toBeGreaterThan(unitGate);
});
