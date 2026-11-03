import fs from 'node:fs';

import { saveMessageAutomationPolicy } from '../../api/messages/automation-policy.js';
import { saveMessagePlaybook } from '../../api/messages/playbook.js';

const [kind, encodedPayload, readyFile, goFile] = process.argv.slice(2);
const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

try {
  fs.writeFileSync(readyFile, `${process.pid}\n`, 'utf8');
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Messages test barrier');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  const value = kind === 'policy'
    ? await saveMessageAutomationPolicy(payload.shopId, payload.value, payload.options)
    : await saveMessagePlaybook(payload.shopId, payload.value, payload.options);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    code: error?.code || '',
    status: error?.status || 0,
  }));
}
