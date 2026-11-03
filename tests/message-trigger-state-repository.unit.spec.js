import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  createMessageTriggerStateRepository,
} from '../api/messages/trigger-state-repository.js';

const execFileAsync = promisify(execFile);

async function withTempDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etsy-trigger-state-repository-'));
  try {
    return await operation(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('state repository serializes mutations across separate Node processes', async () => {
  await withTempDirectory(async directory => {
    const stateFile = path.join(directory, 'state.json');
    const repositoryUrl = pathToFileURL(
      path.resolve('api/messages/trigger-state-repository.js'),
    ).href;
    const childScript = `
      import { createMessageTriggerStateRepository } from ${JSON.stringify(repositoryUrl)};
      const repository = createMessageTriggerStateRepository({
        stateFile: process.env.TEST_MESSAGE_TRIGGER_STATE_FILE,
        lockWaitMs: 10000,
      });
      for (let index = 0; index < 25; index += 1) {
        await repository.mutateState(state => {
          state.concurrent_counter = (Number(state.concurrent_counter) || 0) + 1;
        });
      }
    `;
    const child = () => execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      childScript,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_MESSAGE_TRIGGER_STATE_FILE: stateFile,
      },
    });

    await Promise.all([child(), child()]);

    const stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    expect(stored).toMatchObject({
      version: 1,
      concurrent_counter: 50,
    });
  });
});

test('state repository reclaims an expired filesystem lock without deleting a new owner lock', async () => {
  await withTempDirectory(async directory => {
    const stateFile = path.join(directory, 'state.json');
    const lockFile = `${stateFile}.lock`;
    await fs.writeFile(lockFile, JSON.stringify({
      version: 1,
      token: 'crashed-process-token',
      pid: 2147483647,
      acquired_at: '2026-07-28T07:00:00.000Z',
      expires_at: '2026-07-28T07:00:01.000Z',
    }));
    const repository = createMessageTriggerStateRepository({
      stateFile,
      lockFile,
      lockWaitMs: 500,
      lockTtlMs: 50,
      lockRetryMs: 5,
    });

    await repository.mutateState(state => {
      state.recovered = true;
    });

    await expect(repository.readState()).resolves.toMatchObject({
      version: 1,
      recovered: true,
    });
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('a live process keeps lock ownership beyond TTL and the next process mutates only after release', async () => {
  await withTempDirectory(async directory => {
    const stateFile = path.join(directory, 'state.json');
    const startedFile = path.join(directory, 'first-operation-started');
    const repositoryUrl = pathToFileURL(
      path.resolve('api/messages/trigger-state-repository.js'),
    ).href;
    const childScript = `
      import fs from 'node:fs/promises';
      import { createMessageTriggerStateRepository } from ${JSON.stringify(repositoryUrl)};
      const repository = createMessageTriggerStateRepository({
        stateFile: process.env.TEST_MESSAGE_TRIGGER_STATE_FILE,
        lockTtlMs: 30,
        lockWaitMs: 2000,
        lockRetryMs: 5,
      });
      await repository.mutateState(async state => {
        await fs.writeFile(process.env.TEST_MESSAGE_TRIGGER_STARTED_FILE, 'started');
        await new Promise(resolve => setTimeout(resolve, 200));
        state.first_process = 'completed';
      });
    `;
    const firstProcess = execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      childScript,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_MESSAGE_TRIGGER_STATE_FILE: stateFile,
        TEST_MESSAGE_TRIGGER_STARTED_FILE: startedFile,
      },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await fs.stat(startedFile).then(() => true).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(await fs.stat(startedFile).then(() => true).catch(() => false)).toBe(true);

    const secondRepository = createMessageTriggerStateRepository({
      stateFile,
      lockTtlMs: 30,
      lockWaitMs: 2000,
      lockRetryMs: 5,
    });
    await secondRepository.mutateState(state => {
      state.second_process = 'completed';
    });
    await firstProcess;

    await expect(secondRepository.readState()).resolves.toMatchObject({
      first_process: 'completed',
      second_process: 'completed',
    });
  });
});

test('worker status is persisted atomically with an explicit schema version', async () => {
  await withTempDirectory(async directory => {
    const repository = createMessageTriggerStateRepository({
      stateFile: path.join(directory, 'state.json'),
      workerStatusFile: path.join(directory, 'worker-status.json'),
    });

    await repository.writeWorkerStatus({
      enabled: true,
      running: false,
      interval_ms: 30000,
      last_tick_at: '2026-07-28T08:00:00.000Z',
      last_completed_at: '2026-07-28T08:00:03.000Z',
      last_processed: 2,
      last_result_counts: { AWAITING_APPROVAL: 2 },
      last_error: null,
    });

    await expect(repository.readWorkerStatus()).resolves.toMatchObject({
      version: 1,
      enabled: true,
      running: false,
      last_processed: 2,
      last_result_counts: { AWAITING_APPROVAL: 2 },
    });
  });
});
