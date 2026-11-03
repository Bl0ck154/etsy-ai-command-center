import fs from 'node:fs';

import {
  clearSessionCookie,
  setSessionCookie,
  validateAuthSessionStore,
} from '../../api/_auth.js';
import { createAuthSessionRepository } from '../../api/platform/auth/session-repository.js';

const [action, encodedPayload, readyFile, goFile] = process.argv.slice(2);
const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

function waitForBarrier() {
  fs.writeFileSync(readyFile, `${process.pid}\n`, 'utf8');
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for auth test barrier');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function recorder() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
  };
}

try {
  waitForBarrier();
  let value;
  if (action === 'create') {
    const response = recorder();
    value = setSessionCookie(response, payload.user);
    value = { session: value, cookie: response.headers['set-cookie'].split(';')[0] };
  } else if (action === 'revoke') {
    const response = recorder();
    clearSessionCookie({ headers: { cookie: payload.cookie } }, response);
    value = { revoked: true };
  } else if (action === 'validate') {
    value = { valid: validateAuthSessionStore() };
  } else if (action === 'crash') {
    const repository = createAuthSessionRepository({
      file: process.env.AUTH_SESSIONS_FILE,
      lockTtlMs: 100,
      beforeAtomicReplace() { process.exit(73); },
    });
    repository.create(payload.hash, payload.session);
  } else {
    throw new Error(`Unknown auth child action: ${action}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message || String(error), code: error?.code || '' }));
}
