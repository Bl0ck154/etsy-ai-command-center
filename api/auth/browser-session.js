import crypto from 'node:crypto';

import { createAuthSessionRepository } from '../platform/auth/session-repository.js';
import {
  activeAuthUser,
  authConfigStatus,
  personalAuthDeclared,
} from './credentials.js';
import { timingSafeStringEqual } from './crypto.js';

const COOKIE_NAME = 'etsy_mgr_session';
const DEFAULT_MAX_AGE = 60 * 60 * 24 * 30;
const legacyActiveSessions = new Map();
const authSessionRepository = createAuthSessionRepository();

function maxAgeSeconds() {
  const configured = Number(process.env.AUTH_SESSION_MAX_AGE_SECONDS || DEFAULT_MAX_AGE);
  return Number.isFinite(configured)
    ? Math.min(Math.max(Math.round(configured), 3600), DEFAULT_MAX_AGE)
    : DEFAULT_MAX_AGE;
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return cookies;
}

export function hasBrowserSessionCookie(req) {
  return Boolean(parseCookies(req?.headers?.cookie)[COOKIE_NAME]);
}

function signSessionId(sessionId) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(sessionId).digest('hex');
}

function sessionHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function legacySession(hash) {
  const now = Date.now();
  for (const [key, session] of legacyActiveSessions) {
    if (Number(session?.expiresAt) <= now) legacyActiveSessions.delete(key);
  }
  return legacyActiveSessions.get(hash) || null;
}

function sessionForRequest(req) {
  if (authConfigStatus() === 'open-dev') {
    return { user: { id: 'local-dev', name: 'Local development' } };
  }
  if (authConfigStatus() !== 'configured') return null;

  const token = parseCookies(req?.headers?.cookie)[COOKIE_NAME] || '';
  const [sessionId, signature] = token.split('.');
  if (!sessionId || !signature || !timingSafeStringEqual(signature, signSessionId(sessionId))) {
    return null;
  }
  const hash = sessionHash(token);
  const session = personalAuthDeclared()
    ? authSessionRepository.find(hash)
    : legacySession(hash);
  if (!session) return null;
  const user = activeAuthUser(session.userId);
  return user ? { ...session, user } : null;
}

export function isAuthenticated(req) {
  return Boolean(sessionForRequest(req));
}

export function authenticatedUser(req) {
  return sessionForRequest(req)?.user || null;
}

export function requireAuth(req, res) {
  const session = sessionForRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    return false;
  }
  req.auth = { user: session.user };
  return true;
}

export function setSessionCookie(res, user = { id: 'owner', name: 'Owner' }) {
  if (authConfigStatus() !== 'configured') return null;
  const sessionId = crypto.randomBytes(32).toString('hex');
  const token = `${sessionId}.${signSessionId(sessionId)}`;
  const maxAge = maxAgeSeconds();
  const normalizedUser = activeAuthUser(user?.id);
  if (!normalizedUser) throw new Error('Cannot create a session for an unknown or disabled user');
  const now = Date.now();
  const session = {
    userId: normalizedUser.id,
    createdAt: now,
    expiresAt: now + maxAge * 1000,
  };
  const hash = sessionHash(token);
  if (personalAuthDeclared()) authSessionRepository.create(hash, session);
  else legacyActiveSessions.set(hash, session);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
  );
  return { ...session, user: normalizedUser };
}

export function clearSessionCookie(req, res) {
  const token = parseCookies(req?.headers?.cookie)[COOKIE_NAME] || '';
  if (token) {
    const hash = sessionHash(token);
    if (personalAuthDeclared()) authSessionRepository.revoke(hash);
    else legacyActiveSessions.delete(hash);
  }
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  );
}

export function validateAuthSessionStore() {
  return authSessionRepository.validate();
}
