import crypto from 'node:crypto';

const AUTH_ROLES = new Set(['owner', 'editor', 'viewer']);
let cachedUsersRaw = null;
let cachedUsers = [];

function normalizeUser(value, index = 0) {
  const id = String(value?.id || '').trim().toLowerCase();
  const name = String(value?.name || value?.id || '').trim();
  const passwordHash = String(value?.passwordHash || value?.password_hash || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) || !name || !passwordHash) return null;
  const fallbackRole = index === 0 ? 'owner' : 'viewer';
  const requestedRole = String(value?.role || '').trim().toLowerCase();
  const role = AUTH_ROLES.has(requestedRole) ? requestedRole : fallbackRole;
  const scopes = Array.isArray(value?.scopes)
    ? [...new Set(value.scopes.map(scope => String(scope || '').trim()).filter(Boolean))]
    : [];
  return {
    id,
    name: name.slice(0, 80),
    passwordHash,
    disabled: value?.disabled === true,
    role,
    scopes,
  };
}

export function configuredAuthUsers() {
  const raw = String(process.env.AUTH_USERS_B64 || '').trim();
  if (raw === cachedUsersRaw) return cachedUsers;
  cachedUsersRaw = raw;
  cachedUsers = [];
  if (!raw) return cachedUsers;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) return cachedUsers;
    const ids = new Set();
    cachedUsers = parsed
      .map(normalizeUser)
      .filter(user => user && !ids.has(user.id) && ids.add(user.id));
  } catch {
    cachedUsers = [];
  }
  return cachedUsers;
}

export function personalAuthDeclared() {
  return Boolean(String(process.env.AUTH_USERS_B64 || '').trim());
}

export function hashAuthPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const value = String(password || '');
  if (value.length < 16) throw new Error('Password must be at least 16 characters');
  const derived = crypto.scryptSync(value, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt}$${derived.toString('base64url')}`;
}

export function verifyAuthPassword(password, encodedHash) {
  const parts = String(encodedHash || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, salt, expectedRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (N !== 16384 || r !== 8 || p !== 1 || !salt || !expectedRaw) return false;
  try {
    const expected = Buffer.from(expectedRaw, 'base64url');
    const actual = crypto.scryptSync(String(password || ''), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function authenticateUser(username, password) {
  const users = configuredAuthUsers();
  if (personalAuthDeclared()) {
    const id = String(username || '').trim().toLowerCase();
    const user = users.find(candidate => candidate.id === id && !candidate.disabled);
    if (!user || !verifyAuthPassword(password, user.passwordHash)) return null;
    return { id: user.id, name: user.name };
  }

  const legacyPassword = process.env.SITE_PASSWORD || '';
  if (!legacyPassword || !password) return null;
  const submittedHash = crypto.createHash('sha256').update(String(password)).digest();
  const passwordHash = crypto.createHash('sha256').update(legacyPassword).digest();
  if (!crypto.timingSafeEqual(submittedHash, passwordHash)) return null;
  return { id: 'owner', name: 'Owner' };
}

function hasRequiredAuthConfig() {
  const credentialsReady = personalAuthDeclared()
    ? configuredAuthUsers().length > 0
    : Boolean(process.env.SITE_PASSWORD);
  return Boolean(credentialsReady && process.env.SESSION_SECRET);
}

function allowsOpenDevAuth() {
  const host = process.env.HOST || '127.0.0.1';
  return process.env.NODE_ENV !== 'production'
    && (host === '127.0.0.1' || host === 'localhost');
}

export function authConfigStatus() {
  if (hasRequiredAuthConfig()) return 'configured';
  return allowsOpenDevAuth() ? 'open-dev' : 'deny-all';
}

export function activeAuthUser(userId) {
  const users = configuredAuthUsers();
  if (!personalAuthDeclared()) {
    return userId === 'owner' && process.env.SITE_PASSWORD
      ? { id: 'owner', name: 'Owner', role: 'owner', scopes: [] }
      : null;
  }
  const user = users.find(candidate => candidate.id === userId && !candidate.disabled);
  return user
    ? { id: user.id, name: user.name, role: user.role, scopes: user.scopes }
    : null;
}
