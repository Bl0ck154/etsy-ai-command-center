// api/login.js - Login / logout / status endpoint
// GET /api/login -> { authenticated: true/false }
// POST /api/login -> { username, password } -> sets HttpOnly cookie on success
// DELETE /api/login -> clears cookie and revokes the current session

import { authConfigStatus, authenticateUser, isAuthenticated, requireAuth, setSessionCookie, clearSessionCookie } from './_auth.js';
import { writeSecurityAudit } from './_security-audit.js';

export default function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    if (!isAuthenticated(req)) return res.json({ authenticated: false, requires_username: Boolean(process.env.AUTH_USERS_B64) });
    requireAuth(req, res);
    return res.json({ authenticated: true, user: req.auth?.user || null, requires_username: Boolean(process.env.AUTH_USERS_B64) });
  }

  if (req.method === 'POST') {
    const authStatus = authConfigStatus();
    if (authStatus === 'deny-all') {
      return res.status(503).json({ error: 'Authentication is not configured' });
    }
    if (authStatus === 'open-dev') {
      return res.json({ success: true });
    }

    const { username, password } = req.body || {};
    const user = authenticateUser(username, password);
    if (!user) {
      writeSecurityAudit(req, 'auth.login.failed', { username: String(username || '').trim().toLowerCase().slice(0, 64) });
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    setSessionCookie(res, user);
    req.auth = { user };
    writeSecurityAudit(req, 'auth.login.succeeded');
    return res.json({ success: true, user });
  }

  if (req.method === 'DELETE') {
    if (isAuthenticated(req)) requireAuth(req, res);
    writeSecurityAudit(req, 'auth.logout');
    clearSessionCookie(req, res);
    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
