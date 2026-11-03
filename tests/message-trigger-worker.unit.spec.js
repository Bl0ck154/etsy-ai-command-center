import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import { createMessageTriggerWorker } from '../api/messages/trigger-worker.js';

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

test('worker shutdown waits for an active tick and flushes the final stopped status', async () => {
  let releaseRun;
  let markRunStarted;
  const runStarted = new Promise(resolve => { markRunStarted = resolve; });
  const runRelease = new Promise(resolve => { releaseRun = resolve; });
  const statuses = [];
  const worker = createMessageTriggerWorker({
    isEnabled: () => true,
    runDue: async () => {
      markRunStarted();
      await runRelease;
      return { processed: 1, candidates: [{ status: 'AWAITING_APPROVAL' }] };
    },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    setTimeoutFn: () => ({ unref() {} }),
    persistStatus: async status => { statuses.push(status); },
    logger: { log() {}, error() {} },
  });

  expect(worker.start()).toBe(true);
  const tick = worker.tick();
  await runStarted;
  let shutdownFinished = false;
  const shutdown = worker.shutdown().then(result => {
    shutdownFinished = true;
    return result;
  });
  await Promise.resolve();
  expect(shutdownFinished).toBe(false);

  releaseRun();
  await tick;
  await expect(shutdown).resolves.toMatchObject({
    enabled: false,
    running: false,
    last_processed: 1,
    last_result_counts: { AWAITING_APPROVAL: 1 },
  });
  expect(statuses.at(-1)).toMatchObject({
    enabled: false,
    running: false,
    last_processed: 1,
    last_result_counts: { AWAITING_APPROVAL: 1 },
  });
});

test('disabled worker entrypoint remains supervised and SIGTERM flushes persisted status', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etsy-message-trigger-worker-'));
  const stateFile = path.join(directory, 'state.json');
  const statusFile = path.join(directory, 'worker-status.json');
  const output = [];
  const workerUrl = pathToFileURL(path.resolve('workers/message-trigger.js')).href;
  const childScript = `
    const onMessage = message => {
      if (message === 'SIGTERM') process.emit('SIGTERM');
    };
    process.on('message', onMessage);
    await import(${JSON.stringify(workerUrl)});
    process.off('message', onMessage);
    process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MESSAGE_TRIGGER_RUNNER_ENABLED: 'false',
      MESSAGE_TRIGGER_STATE_FILE: stateFile,
      MESSAGE_TRIGGER_WORKER_STATUS_FILE: statusFile,
      MESSAGE_LEARNING_DATA_DIR: directory,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));

  try {
    const disabledStatus = await waitFor(async () => {
      try {
        return JSON.parse(await fs.readFile(statusFile, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
      }
    });
    expect(disabledStatus).toMatchObject({
      version: 1,
      status: 'disabled',
      enabled: false,
      running: false,
    });
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(child.exitCode).toBeNull();

    child.send('SIGTERM');
    const [exitCode, signal] = await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('message trigger worker did not stop after SIGTERM')),
        5_000,
      )),
    ]);
    expect(exitCode).toBe(0);
    expect(signal).toBeNull();

    const stoppedStatus = JSON.parse(await fs.readFile(statusFile, 'utf8'));
    expect(stoppedStatus).toMatchObject({
      version: 1,
      enabled: false,
      running: false,
      pid: child.pid,
    });
    expect(output.join('')).toContain('"event":"disabled"');
    expect(output.join('')).toContain('"event":"stopped"');
  } finally {
    if (child.exitCode === null) child.kill();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
