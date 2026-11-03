import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  createAgentAuditRepository,
} from '../api/jobs/agent-audit-repository.js';

const execFileAsync = promisify(execFile);
const repositoryUrl = pathToFileURL(
  path.resolve('api/jobs/agent-audit-repository.js'),
).href;

async function withTempDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etsy-agent-audit-'));
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

function record(index, writer = 'main') {
  return {
    schema: 'agent_turn_audit_v1',
    at: new Date(Date.UTC(2026, 7, 13, 12, 0, index % 60)).toISOString(),
    event: 'completed',
    job_id: `job_agent_${writer}_${index}`,
    status: 'done',
    writer,
    payload: writer.repeat(200),
  };
}

test('new Agent audit appends add store schema metadata without changing existing audit markers', async () => {
  await withTempDirectory(async directory => {
    const repository = createAgentAuditRepository({ directory });
    const timestamp = Date.UTC(2026, 7, 13, 12, 0, 0);

    const persisted = await repository.append(record(1), timestamp);
    const file = repository.fileForTimestamp(timestamp);
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(persisted);
    expect(persisted).toMatchObject({
      schema_version: 1,
      record_type: 'agent_turn_audit_event',
      schema: 'agent_turn_audit_v1',
      event: 'completed',
      status: 'done',
    });
    expect((await fs.readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false);
  });
});

test('same-process concurrent appends preserve every complete JSONL record', async () => {
  await withTempDirectory(async directory => {
    const repository = createAgentAuditRepository({ directory });
    const timestamp = Date.UTC(2026, 7, 13, 12, 0, 0);

    await Promise.all(Array.from({ length: 40 }, (_, index) => (
      repository.append(record(index), timestamp)
    )));

    const lines = (await fs.readFile(repository.fileForTimestamp(timestamp), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(lines).toHaveLength(40);
    expect(new Set(lines.map(item => item.job_id)).size).toBe(40);
    expect(lines.every(item => item.schema_version === 1)).toBe(true);
  });
});

test('separate writer processes serialize appends without corrupting or dropping records', async () => {
  await withTempDirectory(async directory => {
    const timestamp = Date.UTC(2026, 7, 13, 12, 0, 0);
    const childScript = `
      import { createAgentAuditRepository } from ${JSON.stringify(repositoryUrl)};
      const repository = createAgentAuditRepository({ directory: process.env.TEST_AUDIT_DIRECTORY });
      const timestamp = Number(process.env.TEST_AUDIT_TIMESTAMP);
      const writer = process.env.TEST_WRITER;
      for (let index = 0; index < 30; index += 1) {
        await repository.append({
          schema: 'agent_turn_audit_v1',
          at: new Date(timestamp + index * 1000).toISOString(),
          event: 'completed',
          job_id: 'job_agent_' + writer.toLowerCase() + '_' + index,
          status: 'done',
          writer,
          payload: writer.repeat(400),
        }, timestamp);
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
        TEST_AUDIT_TIMESTAMP: String(timestamp),
        TEST_WRITER: name,
      },
    });

    await Promise.all([writer('A'), writer('B')]);

    const file = path.join(directory, 'agent-turns-2026-08-13.jsonl');
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(60);
    expect(new Set(lines.map(item => item.job_id)).size).toBe(60);
    expect(lines.every(item => item.payload === item.writer.repeat(400))).toBe(true);
    expect((await fs.readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false);
  });
});

test('dead stale append lock is reclaimed before the next writer appends', async () => {
  await withTempDirectory(async directory => {
    const observedAt = Date.UTC(2026, 7, 13, 12, 0, 0);
    const repository = createAgentAuditRepository({
      directory,
      now: () => observedAt,
      lockTtlMs: 1_000,
      lockWaitMs: 200,
      lockRetryMs: 5,
    });
    const file = repository.fileForTimestamp(observedAt);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(`${file}.lock`, `${JSON.stringify({
      schema_version: 1,
      token: 'dead-owner',
      pid: 2_147_483_647,
      hostname: os.hostname(),
      acquired_at: new Date(observedAt - 5_000).toISOString(),
      expires_at: new Date(observedAt - 4_000).toISOString(),
    })}\n`, 'utf8');

    await repository.append(record(7), observedAt);

    const stored = JSON.parse((await fs.readFile(file, 'utf8')).trim());
    expect(stored.job_id).toBe('job_agent_main_7');
    await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('cleanup removes only expired Agent audit day files under the same mutation fence', async () => {
  await withTempDirectory(async directory => {
    const repository = createAgentAuditRepository({ directory });
    const oldTimestamp = Date.UTC(2026, 6, 1, 12, 0, 0);
    const recentTimestamp = Date.UTC(2026, 7, 13, 12, 0, 0);
    const oldFile = repository.fileForTimestamp(oldTimestamp);
    const recentFile = repository.fileForTimestamp(recentTimestamp);
    await repository.append(record(1, 'old'), oldTimestamp);
    await repository.append(record(2, 'recent'), recentTimestamp);
    const oldMtime = new Date('2026-07-01T12:00:00.000Z');
    const recentMtime = new Date('2026-08-13T12:00:00.000Z');
    await fs.utimes(oldFile, oldMtime, oldMtime);
    await fs.utimes(recentFile, recentMtime, recentMtime);

    const result = await repository.cleanup(Date.parse('2026-08-01T00:00:00.000Z'));

    expect(result).toEqual({ removed: 1 });
    await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(recentFile)).resolves.toBeTruthy();
    expect((await fs.readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false);
  });
});
