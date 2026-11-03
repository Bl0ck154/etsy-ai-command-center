import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  createSecurityAuditStore,
  SECURITY_AUDIT_RECORD_TYPE,
  SECURITY_AUDIT_SCHEMA_VERSION,
} from '../api/platform/observability/security-audit-store.js';

const execFileAsync = promisify(execFile);
const storeUrl = pathToFileURL(
  path.resolve('api/platform/observability/security-audit-store.js'),
).href;

async function withTempDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etsy-security-audit-'));
  try {
    return await operation(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function auditRecord(event, index = 0) {
  return {
    at: `2026-08-09T12:00:${String(index).padStart(2, '0')}.000Z`,
    event,
    user_id: 'owner',
    ip: '127.0.0.1',
    user_agent: 'test',
    details: { index },
  };
}

function parseLines(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

test('security audit store writes a versioned envelope without leaking it on read', async () => {
  await withTempDirectory(async directory => {
    const store = createSecurityAuditStore({ directory });
    const expected = auditRecord('auth.login.succeeded');

    store.append(expected, new Date(expected.at));

    const persisted = parseLines(await fs.readFile(path.join(directory, '2026-08.ndjson'), 'utf8'));
    expect(persisted).toEqual([{
      schema_version: SECURITY_AUDIT_SCHEMA_VERSION,
      record_type: SECURITY_AUDIT_RECORD_TYPE,
      record: expected,
    }]);
    expect(store.readMonth('2026-08')).toEqual([expected]);
    expect(store.readMonth('2026-08')[0]).not.toHaveProperty('schema_version');
  });
});

test('legacy security audit lines migrate atomically and preserve order', async () => {
  await withTempDirectory(async directory => {
    const first = auditRecord('gpt.oauth.login.succeeded', 1);
    const second = auditRecord('gpt.oauth.token.issued', 2);
    const file = path.join(directory, '2026-08.ndjson');
    await fs.writeFile(file, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, 'utf8');
    const store = createSecurityAuditStore({ directory });

    expect(store.readMonth('2026-08')).toEqual([first, second]);
    const migrated = parseLines(await fs.readFile(file, 'utf8'));
    expect(migrated).toEqual([first, second].map(record => ({
      schema_version: SECURITY_AUDIT_SCHEMA_VERSION,
      record_type: SECURITY_AUDIT_RECORD_TYPE,
      record,
    })));
    expect((await fs.readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
  });
});

test('unsupported or corrupt schema fails closed without replacing the audit file', async () => {
  await withTempDirectory(async directory => {
    const file = path.join(directory, '2026-08.ndjson');
    const unsupported = `${JSON.stringify({
      schema_version: 999,
      record_type: SECURITY_AUDIT_RECORD_TYPE,
      record: auditRecord('unsupported'),
    })}\n`;
    await fs.writeFile(file, unsupported, 'utf8');
    const store = createSecurityAuditStore({ directory });

    let unsupportedError;
    try {
      store.append(auditRecord('must.not.append'), new Date('2026-08-09T12:00:00Z'));
    } catch (error) {
      unsupportedError = error;
    }
    expect(unsupportedError).toMatchObject({ code: 'SECURITY_AUDIT_SCHEMA_UNSUPPORTED' });
    expect(await fs.readFile(file, 'utf8')).toBe(unsupported);

    await fs.writeFile(file, '{broken-json\n', 'utf8');
    const corrupt = await fs.readFile(file, 'utf8');
    let corruptError;
    try {
      store.readMonth('2026-08');
    } catch (error) {
      corruptError = error;
    }
    expect(corruptError).toMatchObject({ code: 'SECURITY_AUDIT_CORRUPT' });
    expect(await fs.readFile(file, 'utf8')).toBe(corrupt);
  });
});

test('independent processes append without lost or interleaved records', async () => {
  await withTempDirectory(async directory => {
    const childScript = `
      import { createSecurityAuditStore } from ${JSON.stringify(storeUrl)};
      const store = createSecurityAuditStore({
        directory: process.env.TEST_AUDIT_DIRECTORY,
        lockWaitMs: 10000,
      });
      for (let index = 0; index < 10; index += 1) {
        const at = new Date(Date.UTC(2026, 7, 9, 12, 0, index));
        store.append({
          at: at.toISOString(),
          event: 'concurrent.append',
          user_id: process.env.TEST_WRITER,
          ip: '',
          user_agent: '',
          details: { id: process.env.TEST_WRITER + '-' + index },
        }, at);
      }
    `;
    const writer = name => execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      childScript,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_AUDIT_DIRECTORY: directory,
        TEST_WRITER: name,
      },
      timeout: 20_000,
    });

    await Promise.all([writer('writer-a'), writer('writer-b')]);

    const store = createSecurityAuditStore({ directory });
    const records = store.readMonth('2026-08');
    expect(records).toHaveLength(20);
    expect(new Set(records.map(record => record.details.id)).size).toBe(20);
    expect(parseLines(await fs.readFile(path.join(directory, '2026-08.ndjson'), 'utf8')))
      .toHaveLength(20);
  });
});

test('a live writer remains the owner beyond lock TTL and commits before the waiter', async () => {
  await withTempDirectory(async directory => {
    const marker = path.join(directory, 'slow-writer-ready');
    const slowWriterScript = `
      import fs from 'node:fs';
      import { createSecurityAuditStore } from ${JSON.stringify(storeUrl)};
      const store = createSecurityAuditStore({
        directory: process.env.TEST_AUDIT_DIRECTORY,
        lockTtlMs: 40,
        lockWaitMs: 5000,
        beforeAtomicReplace: () => {
          fs.writeFileSync(process.env.TEST_REPLACE_MARKER, 'ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        },
      });
      const at = new Date('2026-08-09T12:00:01.000Z');
      store.append({ at: at.toISOString(), event: 'slow.writer', user_id: 'slow', ip: '', user_agent: '', details: {} }, at);
    `;
    const slowWriter = spawn(process.execPath, ['--input-type=module', '--eval', slowWriterScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_AUDIT_DIRECTORY: directory,
        TEST_REPLACE_MARKER: marker,
      },
      stdio: 'ignore',
    });
    const slowExit = new Promise((resolve, reject) => slowWriter.once('exit', code => (
      code === 0 ? resolve() : reject(new Error(`slow writer exited with ${code}`))
    )));
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await fs.stat(marker).then(() => true).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(await fs.stat(marker).then(() => true).catch(() => false)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 75));

    const waiterScript = `
      import { createSecurityAuditStore } from ${JSON.stringify(storeUrl)};
      const store = createSecurityAuditStore({ directory: process.env.TEST_AUDIT_DIRECTORY, lockTtlMs: 40, lockWaitMs: 5000 });
      const at = new Date('2026-08-09T12:00:02.000Z');
      store.append({ at: at.toISOString(), event: 'waiting.writer', user_id: 'waiter', ip: '', user_agent: '', details: {} }, at);
    `;
    const waiter = execFileAsync(process.execPath, ['--input-type=module', '--eval', waiterScript], {
      cwd: process.cwd(),
      env: { ...process.env, TEST_AUDIT_DIRECTORY: directory },
      timeout: 10_000,
    });

    await Promise.all([slowExit, waiter]);

    const store = createSecurityAuditStore({ directory });
    expect(store.readMonth('2026-08').map(record => record.event)).toEqual([
      'slow.writer',
      'waiting.writer',
    ]);
  });
});

test('crash before atomic replace preserves prior records and allows stale-lock recovery', async () => {
  await withTempDirectory(async directory => {
    const marker = path.join(directory, 'replace-ready');
    const stable = auditRecord('stable.before.crash', 1);
    const recovered = auditRecord('recovered.after.crash', 2);
    const store = createSecurityAuditStore({ directory, lockTtlMs: 50, lockWaitMs: 5_000 });
    store.append(stable, new Date(stable.at));

    const childScript = `
      import fs from 'node:fs';
      import { createSecurityAuditStore } from ${JSON.stringify(storeUrl)};
      const store = createSecurityAuditStore({
        directory: process.env.TEST_AUDIT_DIRECTORY,
        lockTtlMs: 50,
        lockWaitMs: 5000,
        beforeAtomicReplace: () => {
          fs.writeFileSync(process.env.TEST_REPLACE_MARKER, 'ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        },
      });
      const at = new Date('2026-08-09T12:00:03.000Z');
      store.append({ at: at.toISOString(), event: 'crashing.append', user_id: 'child', ip: '', user_agent: '', details: {} }, at);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_AUDIT_DIRECTORY: directory,
        TEST_REPLACE_MARKER: marker,
      },
      stdio: 'ignore',
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await fs.stat(marker).then(() => true).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(await fs.stat(marker).then(() => true).catch(() => false)).toBe(true);
    child.kill();
    await exited;
    await new Promise(resolve => setTimeout(resolve, 75));

    store.append(recovered, new Date(recovered.at));

    expect(store.readMonth('2026-08')).toEqual([stable, recovered]);
    const names = await fs.readdir(directory);
    expect(names.some(name => name.endsWith('.tmp'))).toBe(false);
    expect(names.some(name => name.endsWith('.lock'))).toBe(false);
  });
});
