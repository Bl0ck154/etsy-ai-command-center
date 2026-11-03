import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  createDraftRepository,
} from '../api/drafts/draft-repository.js';

const execFileAsync = promisify(execFile);
const repositoryUrl = pathToFileURL(
  path.resolve('api/drafts/draft-repository.js'),
).href;

async function withTempDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etsy-drafts-'));
  try {
    return await operation(directory);
  } finally {
    await fs.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
}

const identity = Object.freeze({
  shopId: '12345678',
  userId: 'owner',
  key: 'create_draft',
});

function record(value) {
  return {
    key: 'create_draft',
    shop_id: '12345678',
    user_id: 'owner',
    updated_at: value.serverSavedAt,
    value,
  };
}

test('draft repository stores a versioned record without leaking the wrapper on read', async () => {
  await withTempDirectory(async directory => {
    const repository = createDraftRepository({ directory });
    const expected = record({
      draft_id: 'draft-one',
      title: 'Saved draft',
      revision: 100,
      savedAt: 100,
      serverSavedAt: 100,
    });
    await repository.mutate(identity, context => context.write(expected));

    const persisted = JSON.parse(await fs.readFile(
      path.join(directory, '12345678-owner-create_draft.json'),
      'utf8',
    ));
    expect(persisted).toEqual({
      schema_version: 1,
      record_type: 'create_draft',
      record: expected,
    });
    await expect(repository.read(identity)).resolves.toEqual(expected);
    expect(await repository.read(identity)).not.toHaveProperty('schema_version');
  });
});

test('legacy unwrapped records are read and migrated to the explicit schema', async () => {
  await withTempDirectory(async directory => {
    const legacy = record({
      title: 'Legacy draft',
      revision: 41,
      savedAt: 41,
      serverSavedAt: 41,
    });
    const file = path.join(directory, '12345678-owner-create_draft.json');
    await fs.writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`);
    const repository = createDraftRepository({ directory });

    await expect(repository.read(identity)).resolves.toEqual(legacy);
    const migrated = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(migrated).toEqual({
      schema_version: 1,
      record_type: 'create_draft',
      record: legacy,
    });
  });
});

test('legacy shop-only filenames move to the user scope and migrate once', async () => {
  await withTempDirectory(async directory => {
    const legacy = record({
      title: 'Shop legacy draft',
      revision: 52,
      savedAt: 52,
      serverSavedAt: 52,
    });
    const legacyFile = path.join(directory, '12345678-create_draft.json');
    await fs.writeFile(legacyFile, `${JSON.stringify(legacy, null, 2)}\n`);
    const repository = createDraftRepository({ directory });

    await expect(repository.read(identity)).resolves.toEqual(legacy);
    await expect(fs.stat(legacyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const migrated = JSON.parse(await fs.readFile(
      path.join(directory, '12345678-owner-create_draft.json'),
      'utf8',
    ));
    expect(migrated).toMatchObject({
      schema_version: 1,
      record: { value: { title: 'Shop legacy draft', revision: 52 } },
    });
  });
});

test('per-file mutations observe prior writes in invocation order', async () => {
  await withTempDirectory(async directory => {
    const repository = createDraftRepository({ directory });
    const observed = [];
    await Promise.all([
      repository.mutate(identity, async context => {
        observed.push(context.value?.revision || 0);
        await context.write(record({ revision: 1, serverSavedAt: 1 }));
      }),
      repository.mutate(identity, async context => {
        observed.push(context.value?.revision || 0);
        await context.write(record({ revision: 2, serverSavedAt: 2 }));
      }),
    ]);

    expect(observed).toEqual([0, 1]);
    await expect(repository.read(identity)).resolves.toMatchObject({
      value: { revision: 2 },
    });
  });
});

test('two writer processes cannot both commit the same expected revision', async () => {
  await withTempDirectory(async directory => {
    const repository = createDraftRepository({ directory });
    await repository.mutate(identity, context => context.write(record({
      title: 'Initial',
      revision: 10,
      serverSavedAt: 10,
    })));
    const childScript = `
      import { createDraftRepository } from ${JSON.stringify(repositoryUrl)};
      const repository = createDraftRepository({
        directory: process.env.TEST_DRAFTS_DIRECTORY,
        lockTtlMs: 30,
        lockWaitMs: 2000,
      });
      const identity = { shopId: '12345678', userId: 'owner', key: 'create_draft' };
      const result = await repository.mutate(identity, async context => {
        if (Number(context.value?.revision || 0) !== 10) {
          return { committed: false, current_revision: Number(context.value?.revision || 0) };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        await context.write({
          key: 'create_draft',
          shop_id: '12345678',
          user_id: 'owner',
          updated_at: 11,
          value: { title: process.env.TEST_WRITER, revision: 11, serverSavedAt: 11 },
        });
        return { committed: true };
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const writer = name => execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      childScript,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_DRAFTS_DIRECTORY: directory,
        TEST_WRITER: name,
      },
    });

    const results = await Promise.all([writer('Writer A'), writer('Writer B')]);
    const parsed = results.map(result => JSON.parse(result.stdout));
    expect(parsed.filter(result => result.committed)).toHaveLength(1);
    expect(parsed.filter(result => !result.committed)).toEqual([
      { committed: false, current_revision: 11 },
    ]);
    await expect(repository.read(identity)).resolves.toMatchObject({
      value: { revision: 11 },
    });
  });
});

test('a process crash before rename preserves the prior draft and stale lock is reclaimed', async () => {
  await withTempDirectory(async directory => {
    const marker = path.join(directory, 'replace-ready');
    const repository = createDraftRepository({ directory });
    await repository.mutate(identity, context => context.write(record({
      title: 'Stable draft',
      revision: 20,
      serverSavedAt: 20,
    })));
    const childScript = `
      import fs from 'node:fs/promises';
      import { createDraftRepository } from ${JSON.stringify(repositoryUrl)};
      const repository = createDraftRepository({
        directory: process.env.TEST_DRAFTS_DIRECTORY,
        lockTtlMs: 30,
        lockWaitMs: 2000,
        beforeAtomicReplace: async () => {
          await fs.writeFile(process.env.TEST_REPLACE_MARKER, 'ready');
          await new Promise(() => {});
        },
      });
      await repository.mutate(
        { shopId: '12345678', userId: 'owner', key: 'create_draft' },
        context => context.write({
          key: 'create_draft',
          shop_id: '12345678',
          user_id: 'owner',
          updated_at: 21,
          value: { title: 'Crashing draft', revision: 21, serverSavedAt: 21 },
        }),
      );
    `;
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      childScript,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_DRAFTS_DIRECTORY: directory,
        TEST_REPLACE_MARKER: marker,
      },
      stdio: 'ignore',
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await fs.stat(marker).then(() => true).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(await fs.stat(marker).then(() => true).catch(() => false)).toBe(true);
    child.kill();
    await exited;
    await new Promise(resolve => setTimeout(resolve, 40));

    await repository.mutate(identity, async context => {
      expect(context.value).toMatchObject({ title: 'Stable draft', revision: 20 });
      await context.write(record({
        title: 'Recovered draft',
        revision: 21,
        serverSavedAt: 21,
      }));
    });

    await expect(repository.read(identity)).resolves.toMatchObject({
      value: { title: 'Recovered draft', revision: 21 },
    });
    const entries = await fs.readdir(directory);
    expect(entries.some(name => name.endsWith('.tmp'))).toBe(false);
    expect(entries.some(name => name.endsWith('.lock'))).toBe(false);
  });
});
