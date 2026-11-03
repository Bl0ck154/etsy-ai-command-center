import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  resolveAccessToken,
  validateOAuthStore,
} from '../api/gpt/oauth-store.js';
import {
  createGptOAuthRepository,
  GPT_OAUTH_RECORD_TYPE,
  GPT_OAUTH_SCHEMA_VERSION,
} from '../api/modules/gpt/infrastructure/oauth-repository.js';

const helper = fileURLToPath(new URL('./support/gpt-oauth-process.mjs', import.meta.url));
const owner = { id: 'owner', name: 'Owner', role: 'owner', scopes: [] };
const clientId = 'chatgpt-etsy-manager';
const redirectUri = 'https://chatgpt.com/aip/g-example/oauth/callback';

function emptyEnvelope() {
  return {
    schema_version: GPT_OAUTH_SCHEMA_VERSION,
    record_type: GPT_OAUTH_RECORD_TYPE,
    codes: {}, access_tokens: {}, refresh_tokens: {}, families: {},
  };
}

function oauthEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-repository-'));
  const keys = ['SESSION_SECRET', 'GPT_OAUTH_TOKEN_HASH_SECRET', 'GPT_OAUTH_STORE_FILE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    SESSION_SECRET: 'test-session-secret-that-is-long-enough',
    GPT_OAUTH_TOKEN_HASH_SECRET: 'test-oauth-hash-secret-that-is-long-enough',
    GPT_OAUTH_STORE_FILE: path.join(dir, 'oauth.json'),
  });
  return {
    dir,
    file: process.env.GPT_OAUTH_STORE_FILE,
    restore() {
      for (const key of keys) delete process.env[key];
      for (const [key, value] of Object.entries(previous)) if (value !== undefined) process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function waitForFiles(files, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (files.every(file => fs.existsSync(file))) return resolve();
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for child readiness'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function child(action, payload, readyFile, goFile) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const processHandle = spawn(process.execPath, [helper, action, encoded, readyFile, goFile], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  processHandle.stdout.on('data', chunk => { stdout += chunk; });
  processHandle.stderr.on('data', chunk => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('close', code => {
      if (code !== 0) return reject(new Error(`OAuth child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid OAuth child output: ${stdout} ${stderr}`)); }
    });
  });
  return { processHandle, result };
}

test('startup validation migrates the exact legacy version 1 store to the current envelope', () => {
  const env = oauthEnv();
  try {
    fs.writeFileSync(env.file, JSON.stringify({
      version: 1, codes: {}, access_tokens: {}, refresh_tokens: {}, families: {},
    }));
    expect(validateOAuthStore()).toBe(true);
    expect(JSON.parse(fs.readFileSync(env.file, 'utf8'))).toEqual(emptyEnvelope());
  } finally {
    env.restore();
  }
});

test('startup validation fails closed for corrupt, unsupported, and structurally invalid stores', () => {
  const env = oauthEnv();
  try {
    fs.writeFileSync(env.file, '{broken');
    expect(() => validateOAuthStore()).toThrow(/invalid JSON/i);

    fs.writeFileSync(env.file, JSON.stringify({ ...emptyEnvelope(), schema_version: 2 }));
    expect(() => validateOAuthStore()).toThrow(/unsupported/i);

    fs.writeFileSync(env.file, JSON.stringify({ ...emptyEnvelope(), codes: [] }));
    expect(() => validateOAuthStore()).toThrow(/authorization code/i);
  } finally {
    env.restore();
  }
});

test('a crash before atomic replace preserves the last valid OAuth store and removes the temp file', () => {
  const env = oauthEnv();
  try {
    const original = `${JSON.stringify(emptyEnvelope())}\n`;
    fs.writeFileSync(env.file, original);
    const repository = createGptOAuthRepository({
      file: env.file,
      beforeAtomicReplace() { throw new Error('simulated crash'); },
    });
    expect(() => repository.transact(store => {
      store.families.example = { created_at: 1, expires_at: 2 };
      return { write: true, value: null };
    })).toThrow(/simulated crash/);
    expect(fs.readFileSync(env.file, 'utf8')).toBe(original);
    expect(fs.readdirSync(env.dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(fs.existsSync(`${env.file}.lock`)).toBe(false);
  } finally {
    env.restore();
  }
});

test('commit fencing rejects a writer that loses its lock before replace', () => {
  const env = oauthEnv();
  try {
    fs.writeFileSync(env.file, `${JSON.stringify(emptyEnvelope())}\n`);
    const repository = createGptOAuthRepository({
      file: env.file,
      beforeAtomicReplace() {
        fs.writeFileSync(`${env.file}.lock`, JSON.stringify({ token: 'replacement-owner' }));
      },
    });
    expect(() => repository.transact(store => {
      store.families.example = { created_at: 1, expires_at: 2 };
      return { write: true, value: null };
    })).toThrow(/ownership was lost/i);
    expect(JSON.parse(fs.readFileSync(env.file, 'utf8')).families).toEqual({});
  } finally {
    env.restore();
  }
});

test('an expired lock owned by a live same-host process cannot be reclaimed', () => {
  const env = oauthEnv();
  try {
    fs.writeFileSync(`${env.file}.lock`, JSON.stringify({
      token: 'live-owner', pid: process.pid, hostname: os.hostname(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }));
    const repository = createGptOAuthRepository({ file: env.file, lockWaitMs: 30, lockRetryMs: 5 });
    expect(() => repository.validate()).toThrow(/timed out waiting/i);
    expect(JSON.parse(fs.readFileSync(`${env.file}.lock`, 'utf8')).token).toBe('live-owner');
  } finally {
    env.restore();
  }
});

test('startup validation reclaims an expired lock left by a crashed process', () => {
  const env = oauthEnv();
  try {
    fs.writeFileSync(env.file, `${JSON.stringify(emptyEnvelope())}\n`);
    fs.writeFileSync(`${env.file}.lock`, JSON.stringify({
      token: 'crashed-owner', pid: 99999999, hostname: os.hostname(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }));
    const repository = createGptOAuthRepository({ file: env.file, lockWaitMs: 100 });
    expect(repository.validate()).toBe(true);
    expect(fs.existsSync(`${env.file}.lock`)).toBe(false);
  } finally {
    env.restore();
  }
});

test('two processes cannot exchange the same authorization code', async () => {
  const env = oauthEnv();
  try {
    const code = createAuthorizationCode({ clientId, redirectUri, user: owner, scopes: ['gpt:read'] });
    const go = path.join(env.dir, 'exchange.go');
    const ready = [path.join(env.dir, 'exchange-1.ready'), path.join(env.dir, 'exchange-2.ready')];
    const payload = { code, clientId, redirectUri };
    const children = ready.map(file => child('exchange', payload, file, go));
    await waitForFiles(ready);
    fs.writeFileSync(go, 'go');
    const outcomes = await Promise.all(children.map(item => item.result));
    expect(outcomes.filter(item => item.ok)).toHaveLength(1);
    expect(outcomes.filter(item => !item.ok)).toHaveLength(1);
    expect(outcomes.find(item => item.ok)?.value.access_token).toMatch(/^gpta_/);
  } finally {
    env.restore();
  }
});

test('concurrent refresh rotation detects replay and revokes the winning token family', async () => {
  const env = oauthEnv();
  try {
    const code = createAuthorizationCode({ clientId, redirectUri, user: owner, scopes: ['gpt:read'] });
    const first = exchangeAuthorizationCode({ code, clientId, redirectUri });
    const go = path.join(env.dir, 'refresh.go');
    const ready = [path.join(env.dir, 'refresh-1.ready'), path.join(env.dir, 'refresh-2.ready')];
    const payload = { refreshToken: first.refresh_token, clientId };
    const children = ready.map(file => child('rotate', payload, file, go));
    await waitForFiles(ready);
    fs.writeFileSync(go, 'go');
    const outcomes = await Promise.all(children.map(item => item.result));
    const successes = outcomes.filter(item => item.ok);
    expect(successes).toHaveLength(1);
    expect(outcomes.find(item => !item.ok)?.error).toMatch(/reuse detected/i);
    expect(resolveAccessToken(successes[0].value.access_token)).toBeNull();
    expect(resolveAccessToken(first.access_token)).toBeNull();
  } finally {
    env.restore();
  }
});
