import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  claimIdempotency,
  completeIdempotency,
  failIdempotency,
  validateIdempotencyStore,
} from '../api/gpt/idempotency.js';
import {
  createGptIdempotencyRepository,
  GPT_IDEMPOTENCY_RECORD_TYPE,
  GPT_IDEMPOTENCY_SCHEMA_VERSION,
} from '../api/modules/gpt/infrastructure/idempotency-repository.js';

const execFileAsync = promisify(execFile);
const repositoryUrl = pathToFileURL(
  path.resolve('api/modules/gpt/infrastructure/idempotency-repository.js'),
).href;
const idempotencyUrl = pathToFileURL(path.resolve('api/gpt/idempotency.js')).href;

async function withTempDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etsy-gpt-idempotency-'));
  try {
    return await operation(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function request(key, title = 'Draft') {
  return {
    method: 'POST',
    path: '/api/gpt/listings',
    query: {},
    body: { idempotency_key: key, title },
    auth: { user: { id: 'owner' } },
  };
}

function storedRecord(overrides = {}) {
  return {
    operation_id: 'createDraftListing',
    user_id: 'owner',
    fingerprint: 'b'.repeat(64),
    claim_token: 'claim-token',
    consequential: false,
    status: 'running',
    created_at: 100,
    expires_at: 100 + 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function withIdempotencyEnvironment(file, operation) {
  const previous = {
    file: process.env.GPT_IDEMPOTENCY_STORE_FILE,
    secret: process.env.GPT_OAUTH_TOKEN_HASH_SECRET,
  };
  process.env.GPT_IDEMPOTENCY_STORE_FILE = file;
  process.env.GPT_OAUTH_TOKEN_HASH_SECRET = 'repository-test-secret-at-least-32-characters';
  try {
    return operation();
  } finally {
    if (previous.file === undefined) delete process.env.GPT_IDEMPOTENCY_STORE_FILE;
    else process.env.GPT_IDEMPOTENCY_STORE_FILE = previous.file;
    if (previous.secret === undefined) delete process.env.GPT_OAUTH_TOKEN_HASH_SECRET;
    else process.env.GPT_OAUTH_TOKEN_HASH_SECRET = previous.secret;
  }
}

test('startup validation migrates the legacy version 1 store to the explicit envelope', async () => {
  await withTempDirectory(async directory => {
    const file = path.join(directory, 'state.json');
    const key = 'a'.repeat(64);
    const record = storedRecord({
      status: 'completed',
      completed_at: 200,
      data: { listing_id: 123 },
    });
    await fs.writeFile(file, `${JSON.stringify({ version: 1, records: { [key]: record } })}\n`, 'utf8');

    withIdempotencyEnvironment(file, () => expect(validateIdempotencyStore()).toBe(true));

    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      schema_version: GPT_IDEMPOTENCY_SCHEMA_VERSION,
      record_type: GPT_IDEMPOTENCY_RECORD_TYPE,
      records: { [key]: record },
    });
  });
});

test('unsupported and corrupt stores fail closed without replacement', async () => {
  await withTempDirectory(async directory => {
    const file = path.join(directory, 'state.json');
    const unsupported = `${JSON.stringify({
      schema_version: 999,
      record_type: GPT_IDEMPOTENCY_RECORD_TYPE,
      records: {},
    })}\n`;
    await fs.writeFile(file, unsupported, 'utf8');
    const repository = createGptIdempotencyRepository({ file });

    let unsupportedError;
    try { repository.validate(); } catch (error) { unsupportedError = error; }
    expect(unsupportedError).toMatchObject({ code: 'GPT_IDEMPOTENCY_SCHEMA_UNSUPPORTED' });
    expect(await fs.readFile(file, 'utf8')).toBe(unsupported);

    await fs.writeFile(file, '{broken-json\n', 'utf8');
    const corrupt = await fs.readFile(file, 'utf8');
    let corruptError;
    try { repository.validate(); } catch (error) { corruptError = error; }
    expect(corruptError).toMatchObject({ code: 'GPT_IDEMPOTENCY_STORE_CORRUPT' });
    expect(await fs.readFile(file, 'utf8')).toBe(corrupt);
  });
});

test('claim persistence keeps the exact 24 hour TTL and failure semantics', async () => {
  await withTempDirectory(async directory => {
    const file = path.join(directory, 'state.json');
    withIdempotencyEnvironment(file, () => {
      const consequential = claimIdempotency(request('publish-key-ttl'), 'publishListing', true);
      failIdempotency(consequential, Object.assign(new Error('timeout'), { code: 'TIMEOUT' }), true);
      const ordinary = claimIdempotency(request('draft-key-remove'), 'createDraftListing', false);
      failIdempotency(ordinary, new Error('validation'), false);
    });

    const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
    const records = Object.values(persisted.records);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation_id: 'publishListing',
      consequential: true,
      status: 'failed',
      error_code: 'TIMEOUT',
    });
    expect(records[0].expires_at - records[0].created_at).toBe(24 * 60 * 60 * 1000);
  });
});

test('independent processes preserve distinct concurrent claims', async () => {
  await withTempDirectory(async directory => {
    const file = path.join(directory, 'state.json');
    const childScript = `
      import { claimIdempotency } from ${JSON.stringify(idempotencyUrl)};
      const claim = claimIdempotency({
        method: 'POST', path: '/api/gpt/listings', query: {},
        body: { idempotency_key: process.env.TEST_KEY, title: process.env.TEST_KEY },
        auth: { user: { id: 'owner' } },
      }, 'createDraftListing', false);
      process.stdout.write(JSON.stringify({ cached: claim.cached }));
    `;
    const writer = key => execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GPT_IDEMPOTENCY_STORE_FILE: file,
        GPT_OAUTH_TOKEN_HASH_SECRET: 'multi-process-secret-at-least-32-characters',
        TEST_KEY: key,
      },
      timeout: 10_000,
    });

    await Promise.all([writer('process-key-a'), writer('process-key-b')]);

    const repository = createGptIdempotencyRepository({ file });
    const records = repository.transact(store => ({ write: false, value: store.records }));
    expect(Object.keys(records)).toHaveLength(2);
    expect(Object.values(records).map(record => record.status)).toEqual(['running', 'running']);
  });
});

test('two processes cannot both claim the same idempotency key', async () => {
  await withTempDirectory(async directory => {
    const file = path.join(directory, 'state.json');
    const childScript = `
      import { claimIdempotency } from ${JSON.stringify(idempotencyUrl)};
      try {
        claimIdempotency({
          method: 'POST', path: '/api/gpt/listings', query: {},
          body: { idempotency_key: 'same-process-key', title: 'Same' },
          auth: { user: { id: 'owner' } },
        }, 'createDraftListing', false);
        process.stdout.write(JSON.stringify({ result: 'claimed' }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ result: 'rejected', code: error.code }));
      }
    `;
    const writer = () => execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GPT_IDEMPOTENCY_STORE_FILE: file,
        GPT_OAUTH_TOKEN_HASH_SECRET: 'same-key-secret-at-least-32-characters',
      },
      timeout: 10_000,
    });

    const results = await Promise.all([writer(), writer()]);
    expect(results.map(result => JSON.parse(result.stdout))).toEqual(expect.arrayContaining([
      { result: 'claimed' },
      { result: 'rejected', code: 'IDEMPOTENCY_IN_PROGRESS' },
    ]));
  });
});

test('stale completion cannot complete a replacement claim', async () => {
  await withTempDirectory(async directory => {
    const file = path.join(directory, 'state.json');
    withIdempotencyEnvironment(file, () => {
      const staleClaim = claimIdempotency(request('stale-completion-key'), 'createDraftListing', false);
      const repository = createGptIdempotencyRepository({ file });
      repository.transact(store => {
        store.records[staleClaim.recordKey].claim_token = 'replacement-claim-token';
        return { write: true, value: undefined };
      });
      completeIdempotency(staleClaim, { listing_id: 999 });
      const record = repository.transact(store => ({
        write: false,
        value: store.records[staleClaim.recordKey],
      }));
      expect(record).toMatchObject({ status: 'running', claim_token: 'replacement-claim-token' });
      expect(record).not.toHaveProperty('data');
    });
  });
});

test('crash before atomic replace preserves the prior store and reclaims the stale lock', async () => {
  await withTempDirectory(async directory => {
    const file = path.join(directory, 'state.json');
    const marker = path.join(directory, 'replace-ready');
    const stableKey = '1'.repeat(64);
    const recoveredKey = '2'.repeat(64);
    const crashingKey = '3'.repeat(64);
    const repository = createGptIdempotencyRepository({ file, lockTtlMs: 50, lockWaitMs: 5_000 });
    repository.transact(store => {
      store.records[stableKey] = storedRecord({ claim_token: 'stable' });
      return { write: true, value: undefined };
    });

    const childScript = `
      import fs from 'node:fs';
      import { createGptIdempotencyRepository } from ${JSON.stringify(repositoryUrl)};
      const repository = createGptIdempotencyRepository({
        file: process.env.TEST_STORE_FILE,
        lockTtlMs: 50,
        lockWaitMs: 5000,
        beforeAtomicReplace: () => {
          fs.writeFileSync(process.env.TEST_REPLACE_MARKER, 'ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        },
      });
      repository.transact(store => {
        store.records[${JSON.stringify(crashingKey)}] = ${JSON.stringify(storedRecord({ claim_token: 'crashing' }))};
        return { write: true };
      });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
      cwd: process.cwd(),
      env: { ...process.env, TEST_STORE_FILE: file, TEST_REPLACE_MARKER: marker },
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

    repository.transact(store => {
      store.records[recoveredKey] = storedRecord({ claim_token: 'recovered' });
      return { write: true, value: undefined };
    });

    const records = repository.transact(store => ({ write: false, value: store.records }));
    expect(Object.keys(records).sort()).toEqual([stableKey, recoveredKey].sort());
    const names = await fs.readdir(directory);
    expect(names.some(name => name.endsWith('.tmp'))).toBe(false);
    expect(names.some(name => name.endsWith('.lock'))).toBe(false);
  });
});
