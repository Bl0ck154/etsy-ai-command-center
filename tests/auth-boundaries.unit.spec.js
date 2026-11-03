import { test, expect } from '@playwright/test';
import fs from 'node:fs';

import {
  authConfigStatus,
  authenticateUser,
  configuredAuthUsers,
  hashAuthPassword,
  verifyAuthPassword,
} from '../api/auth/credentials.js';
import {
  clearSessionCookie,
  isAuthenticated,
  requireAuth,
  setSessionCookie,
} from '../api/auth/browser-session.js';
import { requireSocialHermesAuth } from '../api/auth/service-auth.js';

function withEnv(nextEnv, fn) {
  const keys = [
    'NODE_ENV', 'HOST', 'SITE_PASSWORD', 'SESSION_SECRET', 'AUTH_USERS_B64',
    'AUTH_SESSION_MAX_AGE_SECONDS', 'SOCIAL_HERMES_API_TOKEN',
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, nextEnv);
  try { return fn(); }
  finally {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  };
}

test('credential module preserves scrypt contract and default role convention', () => {
  const ownerHash = hashAuthPassword('a-very-long-owner-password', 'fixed-owner-salt');
  const viewerHash = hashAuthPassword('a-very-long-viewer-password', 'fixed-viewer-salt');
  expect(ownerHash.startsWith('scrypt$16384$8$1$fixed-owner-salt$')).toBe(true);
  expect(verifyAuthPassword('a-very-long-owner-password', ownerHash)).toBe(true);
  expect(verifyAuthPassword('wrong-password-value', ownerHash)).toBe(false);

  withEnv({
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    AUTH_USERS_B64: Buffer.from(JSON.stringify([
      { id: 'Owner.User', name: 'Owner', passwordHash: ownerHash },
      { id: 'viewer', name: 'Viewer', passwordHash: viewerHash },
    ])).toString('base64url'),
  }, () => {
    expect(configuredAuthUsers().map(user => ({ id: user.id, role: user.role }))).toEqual([
      { id: 'owner.user', role: 'owner' },
      { id: 'viewer', role: 'viewer' },
    ]);
    expect(authenticateUser('OWNER.USER', 'a-very-long-owner-password')).toEqual({
      id: 'owner.user', name: 'Owner',
    });
    expect(authConfigStatus()).toBe('configured');
  });
});

test('browser session owner preserves legacy cookie creation, auth and revocation', () => {
  withEnv({
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    SITE_PASSWORD: 'correct horse battery staple',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    AUTH_SESSION_MAX_AGE_SECONDS: '7200',
  }, () => {
    const login = responseRecorder();
    const session = setSessionCookie(login);
    expect(session.user).toMatchObject({ id: 'owner', role: 'owner' });
    expect(login.headers['set-cookie']).toContain('Max-Age=7200');
    const cookie = login.headers['set-cookie'].split(';')[0];
    const req = { headers: { cookie } };
    expect(isAuthenticated(req)).toBe(true);

    const authenticated = responseRecorder();
    expect(requireAuth(req, authenticated)).toBe(true);
    expect(req.auth.user).toMatchObject({ id: 'owner', role: 'owner' });

    const logout = responseRecorder();
    clearSessionCookie(req, logout);
    expect(isAuthenticated(req)).toBe(false);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
  });
});

test('browser session owner keeps production fail-closed and localhost open-dev behavior', () => {
  withEnv({ NODE_ENV: 'production', HOST: '127.0.0.1' }, () => {
    expect(authConfigStatus()).toBe('deny-all');
    const res = responseRecorder();
    expect(requireAuth({ headers: {} }, res)).toBe(false);
    expect(res).toMatchObject({ statusCode: 401, body: { error: 'Unauthorized', code: 'AUTH_REQUIRED' } });
  });
  withEnv({ NODE_ENV: 'development', HOST: 'localhost' }, () => {
    const req = { headers: {} };
    const res = responseRecorder();
    expect(requireAuth(req, res)).toBe(true);
    expect(req.auth.user).toEqual({ id: 'local-dev', name: 'Local development' });
  });
});

test('service bearer owner preserves not-configured, unauthorized and accepted outcomes', () => {
  withEnv({}, () => {
    const res = responseRecorder();
    expect(requireSocialHermesAuth({ headers: {} }, res)).toBe(false);
    expect(res).toMatchObject({
      statusCode: 503,
      body: { code: 'SOCIAL_HERMES_AUTH_NOT_CONFIGURED' },
    });
  });
  withEnv({ SOCIAL_HERMES_API_TOKEN: 'service-secret' }, () => {
    const denied = responseRecorder();
    expect(requireSocialHermesAuth({ headers: { authorization: 'Bearer wrong' } }, denied)).toBe(false);
    expect(denied).toMatchObject({ statusCode: 401, body: { code: 'SOCIAL_HERMES_AUTH_REQUIRED' } });
    expect(requireSocialHermesAuth({
      headers: { authorization: 'Bearer service-secret' },
    }, responseRecorder())).toBe(true);
  });
});

test('public auth facade stays compatibility-only and does not regain implementation state', () => {
  const facade = fs.readFileSync(new URL('../api/_auth.js', import.meta.url), 'utf8');
  expect(facade).toContain("from './auth/credentials.js'");
  expect(facade).toContain("from './auth/browser-session.js'");
  expect(facade).toContain("from './auth/service-auth.js'");
  expect(facade).not.toContain('legacyActiveSessions');
  expect(facade).not.toContain('scryptSync');
  expect(facade).not.toContain('createHmac');
  expect(facade).not.toContain('SOCIAL_HERMES_API_TOKEN');
});
