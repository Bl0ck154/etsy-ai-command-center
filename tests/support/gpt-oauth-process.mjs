import fs from 'node:fs';

import {
  exchangeAuthorizationCode,
  rotateRefreshToken,
} from '../../api/gpt/oauth-store.js';

function waitForBarrier(readyFile, goFile) {
  fs.writeFileSync(readyFile, `${process.pid}\n`, 'utf8');
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for OAuth test barrier');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

const [action, encodedPayload, readyFile, goFile] = process.argv.slice(2);
const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

try {
  waitForBarrier(readyFile, goFile);
  const value = action === 'exchange'
    ? exchangeAuthorizationCode(payload)
    : rotateRefreshToken(payload);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    code: error?.code || error?.oauthCode || '',
  }));
}
