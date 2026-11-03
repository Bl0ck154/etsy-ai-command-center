import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  createBackgroundJobRepository,
} from '../api/jobs/job-repository.js';

const execFileAsync = promisify(execFile);
const repositoryUrl = pathToFileURL(
  path.resolve('api/jobs/job-repository.js'),
).href;

async function withTempDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etsy-background-jobs-'));
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

function job(id, patch = {}) {
  return {
    id,
    type: 'agent_turn',
    status: 'queued',
    progress: 0,
    message: 'Queued',
    input_summary: {},
    result: null,
    error: null,
    owner_id: 'owner',
    created_at: 100,
    updated_at: 100,
    ...patch,
  };
}

async function waitForFile(file, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await fs.stat(file).then(() => true).catch(() => false)) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return false;
}

test('new writes use a versioned envelope while reads return only the API-compatible job', async () => {
  await withTempDirectory(async directory => {
    const repository = createBackgroundJobRepository({ directory });
    const expected = job('job_versioned', {
      status: 'done',
      progress: 100,
      result: { message: 'Complete' },
    });

    await repository.write(expected);

    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, 'job_versioned.json'), 'utf8'),
    );
    expect(persisted).toEqual({
      schema_version: 1,
      record_type: 'background_job',
      job: expected,
    });
    await expect(repository.read(expected.id)).resolves.toEqual(expected);
    expect(await repository.read(expected.id)).not.toHaveProperty('schema_version');
    expect((await fs.readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false);
  });
});

test('legacy interrupted jobs are restored as errors and migrated without leaking the envelope', async () => {
  await withTempDirectory(async directory => {
    const id = 'job_legacy_running';
    await fs.writeFile(
      path.join(directory, `${id}.json`),
      `${JSON.stringify(job(id, { status: 'running', progress: 40 }))}\n`,
      'utf8',
    );
    const repository = createBackgroundJobRepository({
      directory,
      now: () => 500,
    });

    const restored = await repository.read(id);

    expect(restored).toMatchObject({
      id,
      status: 'error',
      progress: 100,
      message: 'The server restarted before this job completed',
      error: 'The background job was interrupted by a server restart. Retry the action.',
      updated_at: 500,
    });
    expect(restored).not.toHaveProperty('schema_version');
    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, `${id}.json`), 'utf8'),
    );
    expect(persisted).toMatchObject({
      schema_version: 1,
      record_type: 'background_job',
      job: { id, status: 'error', progress: 100, updated_at: 500 },
    });
  });
});

test('concurrent writes for one job are serialized in invocation order', async () => {
  await withTempDirectory(async directory => {
    const repository = createBackgroundJobRepository({ directory });
    const id = 'job_concurrent';

    await Promise.all([
      repository.write(job(id)),
      repository.write(job(id, { status: 'running', progress: 50, updated_at: 200 })),
      repository.write(job(id, {
        status: 'done',
        progress: 100,
        result: { final: true },
        updated_at: 300,
      })),
    ]);

    await expect(repository.read(id)).resolves.toMatchObject({
      status: 'done',
      progress: 100,
      result: { final: true },
      updated_at: 300,
    });
  });
});

test('separate writer processes leave one complete atomic job envelope', async () => {
  await withTempDirectory(async directory => {
    const childScript = `
      import { createBackgroundJobRepository } from ${JSON.stringify(repositoryUrl)};
      const repository = createBackgroundJobRepository({
        directory: process.env.TEST_JOBS_DIRECTORY,
      });
      for (let index = 0; index < 20; index += 1) {
        await repository.write({
          id: 'job_cross_process',
          type: 'agent_turn',
          status: 'done',
          progress: 100,
          message: process.env.TEST_WRITER,
          result: {
            writer: process.env.TEST_WRITER,
            payload: process.env.TEST_WRITER.repeat(2000),
            index,
          },
          created_at: 100,
          updated_at: index,
        });
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
        TEST_JOBS_DIRECTORY: directory,
        TEST_WRITER: name,
      },
    });

    await Promise.all([writer('A'), writer('B')]);

    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, 'job_cross_process.json'), 'utf8'),
    );
    expect(persisted).toMatchObject({
      schema_version: 1,
      record_type: 'background_job',
      job: { id: 'job_cross_process', status: 'done', progress: 100 },
    });
    expect(['A', 'B']).toContain(persisted.job.result.writer);
    expect(persisted.job.result.payload).toBe(
      persisted.job.result.writer.repeat(2000),
    );
    expect((await fs.readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false);
  });
});

test('a cross-process writer waits for the current token-owned mutation lock', async () => {
  await withTempDirectory(async directory => {
    const lockedMarker = path.join(directory, 'writer-a-locked');
    const releaseMarker = path.join(directory, 'writer-a-release');
    const childScript = `
      import fs from 'node:fs/promises';
      import { createBackgroundJobRepository } from ${JSON.stringify(repositoryUrl)};
      const repository = createBackgroundJobRepository({
        directory: process.env.TEST_JOBS_DIRECTORY,
        lockTtlMs: 5_000,
        lockWaitMs: 5_000,
        beforeAtomicReplace: process.env.TEST_WRITER === 'A' ? async () => {
          await fs.writeFile(process.env.TEST_LOCKED_MARKER, 'locked');
          while (!await fs.stat(process.env.TEST_RELEASE_MARKER).then(() => true).catch(() => false)) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        } : async () => {},
      });
      await repository.write({
        id: 'job_ordered_cross_process',
        type: 'agent_turn',
        status: 'done',
        progress: 100,
        message: process.env.TEST_WRITER,
        result: { writer: process.env.TEST_WRITER },
        created_at: 100,
        updated_at: process.env.TEST_WRITER === 'A' ? 200 : 300,
      });
    `;
    const spawnWriter = name => spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      childScript,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_JOBS_DIRECTORY: directory,
        TEST_WRITER: name,
        TEST_LOCKED_MARKER: lockedMarker,
        TEST_RELEASE_MARKER: releaseMarker,
      },
      stdio: 'ignore',
    });

    const writerA = spawnWriter('A');
    const writerAExited = new Promise(resolve => writerA.once('exit', resolve));
    expect(await waitForFile(lockedMarker)).toBe(true);

    const writerB = spawnWriter('B');
    let writerBExited = false;
    const writerBExit = new Promise(resolve => writerB.once('exit', code => {
      writerBExited = true;
      resolve(code);
    }));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(writerBExited).toBe(false);

    await fs.writeFile(releaseMarker, 'release');
    expect(await writerAExited).toBe(0);
    expect(await writerBExit).toBe(0);

    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, 'job_ordered_cross_process.json'), 'utf8'),
    );
    expect(persisted.job).toMatchObject({
      message: 'B',
      result: { writer: 'B' },
      updated_at: 300,
    });
  });
});

test('a live local lock owner is not reclaimed even when lock metadata is expired', async () => {
  await withTempDirectory(async directory => {
    const id = 'job_live_lock';
    const file = path.join(directory, `${id}.json`);
    await fs.writeFile(`${file}.lock`, `${JSON.stringify({
      schema_version: 1,
      token: 'live-owner',
      pid: process.pid,
      hostname: os.hostname(),
      acquired_at: new Date(0).toISOString(),
      expires_at: new Date(1).toISOString(),
    })}\n`);
    const repository = createBackgroundJobRepository({
      directory,
      lockWaitMs: 30,
      lockRetryMs: 5,
    });

    await expect(repository.write(job(id))).rejects.toMatchObject({
      code: 'BACKGROUND_JOB_LOCK_TIMEOUT',
      status: 503,
    });
    const lock = JSON.parse(await fs.readFile(`${file}.lock`, 'utf8'));
    expect(lock.token).toBe('live-owner');
  });
});

test('an expired dead-owner lock is reclaimed before mutation', async () => {
  await withTempDirectory(async directory => {
    const id = 'job_dead_lock';
    const file = path.join(directory, `${id}.json`);
    await fs.writeFile(`${file}.lock`, `${JSON.stringify({
      schema_version: 1,
      token: 'dead-owner',
      pid: 99999999,
      hostname: os.hostname(),
      acquired_at: new Date(0).toISOString(),
      expires_at: new Date(1).toISOString(),
    })}\n`);
    const repository = createBackgroundJobRepository({ directory });

    await repository.write(job(id, { status: 'done', progress: 100 }));

    await expect(repository.read(id)).resolves.toMatchObject({ status: 'done', progress: 100 });
    await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('a failed atomic replace preserves the previous complete record', async () => {
  await withTempDirectory(async directory => {
    const id = 'job_crash_safe';
    const stableRepository = createBackgroundJobRepository({ directory });
    await stableRepository.write(job(id, {
      status: 'running',
      progress: 25,
    }));
    const crashingRepository = createBackgroundJobRepository({
      directory,
      beforeAtomicReplace: async () => {
        const error = new Error('simulated process crash before rename');
        error.code = 'SIMULATED_CRASH';
        throw error;
      },
    });

    await expect(crashingRepository.write(job(id, {
      status: 'done',
      progress: 100,
    }))).rejects.toMatchObject({ code: 'SIMULATED_CRASH' });

    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, `${id}.json`), 'utf8'),
    );
    expect(persisted.job).toMatchObject({ status: 'running', progress: 25 });
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.lock'))).toEqual([]);
  });
});

test('a writer process crash before rename preserves the prior record and cleanup reclaims its stale lock and temp', async () => {
  await withTempDirectory(async directory => {
    const id = 'job_process_crash';
    const marker = path.join(directory, 'replace-ready');
    const repository = createBackgroundJobRepository({
      directory,
      lockTtlMs: 50,
      lockWaitMs: 1_000,
      lockRetryMs: 5,
    });
    await repository.write(job(id, { status: 'running', progress: 25 }));
    const childScript = `
      import fs from 'node:fs/promises';
      import { createBackgroundJobRepository } from ${JSON.stringify(repositoryUrl)};
      const repository = createBackgroundJobRepository({
        directory: process.env.TEST_JOBS_DIRECTORY,
        lockTtlMs: 50,
        beforeAtomicReplace: async () => {
          await fs.writeFile(process.env.TEST_REPLACE_MARKER, 'ready');
          await new Promise(() => {});
        },
      });
      await repository.write({
        id: 'job_process_crash',
        type: 'agent_turn',
        status: 'done',
        progress: 100,
        created_at: 100,
        updated_at: 200,
      });
    `;
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      childScript,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_JOBS_DIRECTORY: directory,
        TEST_REPLACE_MARKER: marker,
      },
      stdio: 'ignore',
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    expect(await waitForFile(marker)).toBe(true);
    child.kill();
    await exited;

    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, `${id}.json`), 'utf8'),
    );
    expect(persisted.job).toMatchObject({ status: 'running', progress: 25 });
    expect((await fs.readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(true);
    expect((await fs.readdir(directory)).some(name => name.endsWith('.lock'))).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 70));
    await repository.cleanup(Date.now() + 1_000);
    expect((await fs.readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
    expect((await fs.readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false);
  });
});

test('cleanup removes expired job records and orphaned atomic temps only', async () => {
  await withTempDirectory(async directory => {
    const repository = createBackgroundJobRepository({ directory });
    const expired = path.join(directory, 'job_expired.json');
    const current = path.join(directory, 'job_current.json');
    const orphan = path.join(directory, 'job_orphan.json.123.deadbeef.tmp');
    const unrelated = path.join(directory, 'operator-notes.json');
    await Promise.all([
      fs.writeFile(expired, '{}'),
      fs.writeFile(current, '{}'),
      fs.writeFile(orphan, '{}'),
      fs.writeFile(unrelated, '{}'),
    ]);
    const old = new Date(1_000);
    await Promise.all([
      fs.utimes(expired, old, old),
      fs.utimes(orphan, old, old),
      fs.utimes(unrelated, old, old),
    ]);

    await repository.cleanup(2_000);

    await expect(fs.stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(current)).resolves.toBeTruthy();
    await expect(fs.stat(unrelated)).resolves.toBeTruthy();
  });
});
