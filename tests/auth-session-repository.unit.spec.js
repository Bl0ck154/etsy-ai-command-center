import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hashAuthPassword,
  isAuthenticated,
  setSessionCookie,
  validateAuthSessionStore,
} from '../api/_auth.js';
import {
  AUTH_SESSION_RECORD_TYPE,
  AUTH_SESSION_SCHEMA_VERSION,
  createAuthSessionRepository,
  MAX_SESSION_AGE_MS,
} from '../api/platform/auth/session-repository.js';

const helper = fileURLToPath(new URL('./support/auth-session-process.mjs', import.meta.url));

function authEnv() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-session-repository-'));
  const keys = [
    'NODE_ENV', 'HOST', 'SITE_PASSWORD', 'SESSION_SECRET', 'AUTH_USERS_B64',
    'AUTH_SESSIONS_FILE', 'AUTH_SESSION_MAX_AGE_SECONDS',
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const user = {
    id: 'illia', name: 'Illia', role: 'owner',
    passwordHash: hashAuthPassword('a-very-long-owner-password'),
  };
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: 'production', HOST: '127.0.0.1',
    SESSION_SECRET: 'session-secret-that-is-at-least-32-characters',
    AUTH_USERS_B64: Buffer.from(JSON.stringify([user])).toString('base64url'),
    AUTH_SESSIONS_FILE: path.join(directory, 'auth-sessions.json'),
  });
  return {
    directory,
    file: process.env.AUTH_SESSIONS_FILE,
    user: { id: user.id, name: user.name },
    restore() {
      for (const key of keys) delete process.env[key];
      for (const [key, value] of Object.entries(previous)) if (value !== undefined) process.env[key] = value;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function responseRecorder() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
  };
}

function waitForFiles(files, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (files.every(file => fs.existsSync(file))) return resolve();
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for auth child readiness'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function child(action, payload, readyFile, goFile, { expectedExit = 0 } = {}) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const processHandle = spawn(process.execPath, [helper, action, encoded, readyFile, goFile], {
    cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  processHandle.stdout.on('data', chunk => { stdout += chunk; });
  processHandle.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('close', code => {
      if (code !== expectedExit) return reject(new Error(`Auth child exited ${code}: ${stderr}`));
      if (expectedExit !== 0) return resolve({ ok: false, exitCode: code });
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid auth child output: ${stdout} ${stderr}`)); }
    });
  });
}

async function releaseChildren(directory, actions) {
  const goFile = path.join(directory, `go-${crypto.randomUUID()}`);
  const readyFiles = actions.map((_, index) => path.join(directory, `ready-${crypto.randomUUID()}-${index}`));
  const results = actions.map((action, index) => child(
    action.name, action.payload, readyFiles[index], goFile, action.options,
  ));
  await waitForFiles(readyFiles);
  fs.writeFileSync(goFile, 'go');
  return Promise.all(results);
}

test('legacy sessions migrate to the explicit envelope and expired records are cleaned', async () => {
  const env = authEnv();
  try {
    const now = Date.now();
    const validHash = 'a'.repeat(64);
    const expiredHash = 'b'.repeat(64);
    fs.writeFileSync(env.file, JSON.stringify({ version: 1, sessions: {
      [validHash]: { userId: 'illia', createdAt: now - 1_000, expiresAt: now + 60_000 },
      [expiredHash]: { userId: 'illia', createdAt: now - 120_000, expiresAt: now - 60_000 },
    } }));
    const [outcome] = await releaseChildren(env.directory, [{ name: 'validate', payload: {} }]);
    expect(outcome).toMatchObject({ ok: true, value: { valid: true } });
    expect(JSON.parse(fs.readFileSync(env.file, 'utf8'))).toEqual({
      schema_version: AUTH_SESSION_SCHEMA_VERSION,
      record_type: AUTH_SESSION_RECORD_TYPE,
      sessions: {
        [validHash]: { userId: 'illia', createdAt: now - 1_000, expiresAt: now + 60_000 },
      },
    });
  } finally {
    env.restore();
  }
});

test('legacy adjacent Date.now drift is clamped while current records remain strict', () => {
  const env = authEnv();
  try {
    const hash = 'd'.repeat(64);
    const createdAt = Date.now();
    fs.writeFileSync(env.file, JSON.stringify({
      version: 1,
      sessions: {
        [hash]: { userId: 'illia', createdAt, expiresAt: createdAt + MAX_SESSION_AGE_MS + 1 },
      },
    }));

    expect(validateAuthSessionStore()).toBe(true);
    expect(JSON.parse(fs.readFileSync(env.file, 'utf8')).sessions[hash].expiresAt)
      .toBe(createdAt + MAX_SESSION_AGE_MS);

    fs.writeFileSync(env.file, JSON.stringify({
      version: 1,
      sessions: {
        [hash]: { userId: 'illia', createdAt, expiresAt: createdAt + MAX_SESSION_AGE_MS + 1_001 },
      },
    }));
    expect(() => validateAuthSessionStore()).toThrow(/record is invalid/i);
  } finally {
    env.restore();
  }
});

test('startup validation fails closed for corrupt, unsupported, and overlong session records', () => {
  const env = authEnv();
  try {
    fs.writeFileSync(env.file, '{broken');
    expect(() => validateAuthSessionStore()).toThrow(/invalid JSON/i);
    fs.writeFileSync(env.file, JSON.stringify({
      schema_version: 2, record_type: AUTH_SESSION_RECORD_TYPE, sessions: {},
    }));
    expect(() => validateAuthSessionStore()).toThrow(/unsupported/i);
    fs.writeFileSync(env.file, JSON.stringify({
      schema_version: 1, record_type: AUTH_SESSION_RECORD_TYPE,
      sessions: { ['c'.repeat(64)]: { userId: 'illia', createdAt: 1, expiresAt: 1 + MAX_SESSION_AGE_MS + 1 } },
    }));
    expect(() => validateAuthSessionStore()).toThrow(/record is invalid/i);
  } finally {
    env.restore();
  }
});

test('configured session lifetime remains capped at exactly 30 days', () => {
  const env = authEnv();
  try {
    process.env.AUTH_SESSION_MAX_AGE_SECONDS = String(365 * 24 * 60 * 60);
    const response = responseRecorder();
    const session = setSessionCookie(response, env.user);
    expect(response.headers['set-cookie']).toContain('Max-Age=2592000');
    expect(session.expiresAt - session.createdAt).toBe(MAX_SESSION_AGE_MS);
  } finally {
    env.restore();
  }
});

test('legacy shared-password sessions preserve their process-local behavior', () => {
  const env = authEnv();
  try {
    delete process.env.AUTH_USERS_B64;
    process.env.SITE_PASSWORD = 'correct horse battery staple';
    const response = responseRecorder();
    setSessionCookie(response);
    const cookie = response.headers['set-cookie'].split(';')[0];
    expect(isAuthenticated({ headers: { cookie } })).toBe(true);
    expect(fs.existsSync(env.file)).toBe(false);
  } finally {
    env.restore();
  }
});

test('concurrent session creation preserves both process results', async () => {
  const env = authEnv();
  try {
    const outcomes = await releaseChildren(env.directory, [
      { name: 'create', payload: { user: env.user } },
      { name: 'create', payload: { user: env.user } },
    ]);
    expect(outcomes.every(outcome => outcome.ok)).toBe(true);
    const cookies = outcomes.map(outcome => outcome.value.cookie);
    expect(new Set(cookies).size).toBe(2);
    expect(cookies.every(cookie => isAuthenticated({ headers: { cookie } }))).toBe(true);
    expect(Object.keys(JSON.parse(fs.readFileSync(env.file, 'utf8')).sessions)).toHaveLength(2);
  } finally {
    env.restore();
  }
});

test('concurrent create and revoke do not resurrect the revoked session or lose the new one', async () => {
  const env = authEnv();
  try {
    const response = responseRecorder();
    setSessionCookie(response, env.user);
    const originalCookie = response.headers['set-cookie'].split(';')[0];
    const outcomes = await releaseChildren(env.directory, [
      { name: 'revoke', payload: { cookie: originalCookie } },
      { name: 'create', payload: { user: env.user } },
    ]);
    expect(outcomes.every(outcome => outcome.ok)).toBe(true);
    const newCookie = outcomes[1].value.cookie;
    expect(isAuthenticated({ headers: { cookie: originalCookie } })).toBe(false);
    expect(isAuthenticated({ headers: { cookie: newCookie } })).toBe(true);
  } finally {
    env.restore();
  }
});

test('a crashed writer is reclaimed without replacing the last valid store', async () => {
  const env = authEnv();
  try {
    const initial = {
      schema_version: 1, record_type: AUTH_SESSION_RECORD_TYPE, sessions: {},
    };
    fs.writeFileSync(env.file, `${JSON.stringify(initial)}\n`);
    const now = Date.now();
    const [crash] = await releaseChildren(env.directory, [{
      name: 'crash',
      payload: {
        hash: 'd'.repeat(64),
        session: { userId: 'illia', createdAt: now, expiresAt: now + 60_000 },
      },
      options: { expectedExit: 73 },
    }]);
    expect(crash.exitCode).toBe(73);
    expect(JSON.parse(fs.readFileSync(env.file, 'utf8'))).toEqual(initial);
    await new Promise(resolve => setTimeout(resolve, 125));
    const repository = createAuthSessionRepository({ file: env.file, lockWaitMs: 500 });
    expect(repository.validate()).toBe(true);
    expect(fs.existsSync(`${env.file}.lock`)).toBe(false);
    expect(fs.readdirSync(env.directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    env.restore();
  }
});

test('live-PID TTL protection and token fencing reject stale overwrite', () => {
  const env = authEnv();
  try {
    const initial = { schema_version: 1, record_type: AUTH_SESSION_RECORD_TYPE, sessions: {} };
    fs.writeFileSync(env.file, `${JSON.stringify(initial)}\n`);
    fs.writeFileSync(`${env.file}.lock`, JSON.stringify({
      token: 'live-owner', pid: process.pid, hostname: os.hostname(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }));
    const blocked = createAuthSessionRepository({ file: env.file, lockWaitMs: 30, lockRetryMs: 5 });
    expect(() => blocked.validate()).toThrow(/timed out waiting/i);
    fs.rmSync(`${env.file}.lock`, { force: true });

    const now = Date.now();
    const fenced = createAuthSessionRepository({
      file: env.file,
      beforeAtomicReplace() {
        fs.writeFileSync(`${env.file}.lock`, JSON.stringify({ token: 'replacement-owner' }));
      },
    });
    expect(() => fenced.create('e'.repeat(64), {
      userId: 'illia', createdAt: now, expiresAt: now + 60_000,
    })).toThrow(/ownership was lost/i);
    expect(JSON.parse(fs.readFileSync(env.file, 'utf8')).sessions).toEqual({});
  } finally {
    env.restore();
  }
});
