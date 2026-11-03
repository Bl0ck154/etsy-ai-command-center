import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseDotEnv } from 'dotenv';

import {
  authConfigStatus,
  authenticateUser,
  clearSessionCookie,
  hashAuthPassword,
  isAuthenticated,
  setSessionCookie,
} from '../api/_auth.js';
import { browserMutationBlocked } from '../api/_browser-security.js';
import etsyHandler from '../api/etsy.js';

function withEnv(nextEnv, fn) {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    HOST: process.env.HOST,
    SITE_PASSWORD: process.env.SITE_PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET,
    AUTH_USERS_B64: process.env.AUTH_USERS_B64,
    AUTH_SESSIONS_FILE: process.env.AUTH_SESSIONS_FILE,
    AUTH_SESSION_MAX_AGE_SECONDS: process.env.AUTH_SESSION_MAX_AGE_SECONDS,
  };
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, nextEnv);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(previous)) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

function responseRecorder() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
  };
}

function jsonResponseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  };
}

function reqWithCookie(cookie = '') {
  return { headers: { cookie } };
}

test('auth fails closed in production when credentials are missing', () => {
  withEnv({ NODE_ENV: 'production', HOST: '127.0.0.1' }, () => {
    expect(authConfigStatus()).toBe('deny-all');
    expect(isAuthenticated(reqWithCookie())).toBe(false);

    const res = responseRecorder();
    setSessionCookie(res);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

test('missing credentials are open only for local development', () => {
  withEnv({ NODE_ENV: 'development', HOST: '127.0.0.1' }, () => {
    expect(authConfigStatus()).toBe('open-dev');
    expect(isAuthenticated(reqWithCookie())).toBe(true);
  });
});

test('configured auth creates unique revocable sessions', () => {
  withEnv({
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    SITE_PASSWORD: 'correct horse battery staple',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  }, () => {
    const first = responseRecorder();
    const second = responseRecorder();
    setSessionCookie(first);
    setSessionCookie(second);

    const firstCookie = first.headers['set-cookie'];
    const secondCookie = second.headers['set-cookie'];
    expect(firstCookie).toContain('HttpOnly');
    expect(firstCookie).toContain('Max-Age=2592000');
    expect(firstCookie).not.toBe(secondCookie);

    const firstPair = firstCookie.split(';')[0];
    const firstReq = reqWithCookie(firstPair);
    expect(isAuthenticated(firstReq)).toBe(true);

    const logout = responseRecorder();
    clearSessionCookie(firstReq, logout);
    expect(isAuthenticated(firstReq)).toBe(false);
  });
});

test('individual users use scrypt hashes and persistent sessions never store bearer cookies', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-auth-'));
  const sessionsFile = path.join(tempDir, 'sessions.json');
  const users = [
    { id: 'illia', name: 'Illia', passwordHash: hashAuthPassword('a-very-long-owner-password') },
    { id: 'manager2', name: 'Manager 2', passwordHash: hashAuthPassword('another-very-long-password') },
  ];
  withEnv({
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    AUTH_USERS_B64: Buffer.from(JSON.stringify(users)).toString('base64url'),
    AUTH_SESSIONS_FILE: sessionsFile,
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  }, () => {
    expect(authenticateUser('illia', 'a-very-long-owner-password')).toEqual({ id: 'illia', name: 'Illia' });
    expect(authenticateUser('illia', 'wrong-password-value')).toBeNull();
    expect(authenticateUser('', 'a-very-long-owner-password')).toBeNull();

    const res = responseRecorder();
    setSessionCookie(res, { id: 'illia', name: 'Illia' });
    const cookiePair = res.headers['set-cookie'].split(';')[0];
    expect(isAuthenticated(reqWithCookie(cookiePair))).toBe(true);
    const stored = fs.readFileSync(sessionsFile, 'utf8');
    expect(stored).not.toContain(cookiePair.split('=')[1]);
    if (process.platform !== 'win32') expect(fs.statSync(sessionsFile).mode & 0o777).toBe(0o600);

    users[0].disabled = true;
    process.env.AUTH_USERS_B64 = Buffer.from(JSON.stringify(users)).toString('base64url');
    expect(isAuthenticated(reqWithCookie(cookiePair))).toBe(false);
  });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('invalid user configuration fails closed in production', () => {
  withEnv({
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    AUTH_USERS_B64: Buffer.from('{broken-json').toString('base64url'),
    SITE_PASSWORD: 'legacy-password-must-not-bypass-invalid-users',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  }, () => {
    expect(authConfigStatus()).toBe('deny-all');
  });
});

test('browser mutation guard rejects cross-origin and same-site cross-subdomain requests', () => {
  const request = (origin, fetchSite = 'cross-site') => ({
    method: 'POST',
    headers: { cookie: 'etsy_mgr_session=fake' },
    get(name) {
      if (name === 'origin') return origin;
      if (name === 'sec-fetch-site') return fetchSite;
      return '';
    },
  });
  const sameOrigin = (_req, origin) => origin === 'https://dashboard.example.test';
  expect(browserMutationBlocked(request('https://evil.example'), sameOrigin)).toBe(true);
  expect(browserMutationBlocked(request('https://evil.dashboard.example.test', 'same-site'), sameOrigin)).toBe(true);
  expect(browserMutationBlocked(request('https://dashboard.example.test', 'same-origin'), sameOrigin)).toBe(false);
  expect(browserMutationBlocked({ ...request('https://evil.example'), method: 'GET' }, sameOrigin)).toBe(false);
  expect(browserMutationBlocked({ method: 'POST', headers: {}, get: () => '' }, sameOrigin)).toBe(false);
});

test('Etsy write actions cannot be invoked through GET', async () => {
  const previous = Object.fromEntries(['NODE_ENV', 'HOST', 'SITE_PASSWORD', 'SESSION_SECRET', 'AUTH_USERS_B64'].map(key => [key, process.env[key]]));
  process.env.NODE_ENV = 'production';
  process.env.HOST = '127.0.0.1';
  process.env.SITE_PASSWORD = 'correct horse battery staple';
  process.env.SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  delete process.env.AUTH_USERS_B64;
  try {
    const login = responseRecorder();
    setSessionCookie(login);
    const req = {
      method: 'GET',
      query: { action: 'deleteListing', listing_id: '123' },
      headers: { cookie: login.headers['set-cookie'].split(';')[0] },
    };
    const res = jsonResponseRecorder();
    await etsyHandler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.body.code).toBe('WRITE_REQUIRES_POST');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('login UI sends a username and never opens the app after an auth network failure', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'public/app.js'), 'utf8');
  expect(source).toContain('id="login-username"');
  expect(source).toContain('JSON.stringify({ username, password })');
  expect(source).toContain("return { authenticated: false, requires_username: true }");
});

test('auth provisioning creates two hashed users and stores generated credentials separately', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-auth-provision-'));
  const envFile = path.join(tempDir, 'runtime.env');
  const credentialsFile = path.join(tempDir, 'credentials.txt');
  fs.writeFileSync(envFile, 'SITE_PASSWORD=old-shared-password\nSESSION_SECRET=test-secret\n', 'utf8');
  try {
    const result = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'provision-auth-users.mjs'),
      '--env', envFile,
      '--credentials-out', credentialsFile,
      '--primary-id', 'illia',
      '--secondary-id', 'manager2',
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const runtime = parseDotEnv(fs.readFileSync(envFile, 'utf8'));
    const users = JSON.parse(Buffer.from(runtime.AUTH_USERS_B64, 'base64url').toString('utf8'));
    expect(users.map(user => user.id)).toEqual(['illia', 'manager2']);
    expect(users.every(user => user.passwordHash.startsWith('scrypt$'))).toBe(true);
    expect(runtime.SITE_PASSWORD).toBe('');
    const credentials = fs.readFileSync(credentialsFile, 'utf8');
    expect(credentials).toContain('username=illia');
    expect(credentials).toContain('username=manager2');
    expect(fs.readFileSync(envFile, 'utf8')).not.toContain(credentials.match(/password=([^\n]+)/)?.[1] || 'never');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
