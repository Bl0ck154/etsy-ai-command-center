// Browser and service authentication compatibility facade.

export {
  configuredAuthUsers,
  hashAuthPassword,
  verifyAuthPassword,
  authenticateUser,
  authConfigStatus,
} from './auth/credentials.js';

export {
  hasBrowserSessionCookie,
  isAuthenticated,
  authenticatedUser,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
  validateAuthSessionStore,
} from './auth/browser-session.js';

export { requireSocialHermesAuth } from './auth/service-auth.js';
