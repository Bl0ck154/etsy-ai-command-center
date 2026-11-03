import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import authHandler from './api/auth.js';
import etsyHandler from './api/etsy.js';
import aiHandler from './api/ai.js';
import socialHandler from './api/social.js';
import uploadHandler from './api/upload.js';
import statsHandler from './api/stats.js';
import mediaHandler from './api/media.js';
import kvHandler from './api/kv.js';
import jobsHandler from './api/jobs.js';
import draftsHandler from './api/drafts.js';
import chatHandler from './api/chat.js';
import checkoutHandler from './api/checkout.js';
import agentHandler from './api/agent.js';
import loginHandler from './api/login.js';
import metaAiHandler from './api/meta-ai.js';
import etsyGuidanceHandler from './api/etsy-guidance.js';
import messagesHandler from './api/messages.js';
import messageEventsHandler from './api/message-events.js';
import messageTelegramFeedbackHandler from './api/message-telegram-feedback.js';
import { validateMessageAutomationPolicyStore } from './api/messages/automation-policy.js';
import { validateMessagePlaybookStore } from './api/messages/playbook.js';
import {
  messageLearningStoreRequired,
  validateMessageLearningStore,
} from './api/messages/learning-runtime.js';
import gptRouter from './api/gpt/router.js';
import { validateIdempotencyStore } from './api/gpt/idempotency.js';
import { validateOAuthStore } from './api/gpt/oauth-store.js';
import { buildFullGptOpenApi, buildGptOpenApi } from './api/gpt/openapi.js';
import {
  oauthAuthorizeHandler,
  oauthRevokeHandler,
  oauthTokenHandler,
} from './api/gpt/oauth-handler.js';
import { browserMutationBlocked } from './api/_browser-security.js';
import { authConfigStatus, validateAuthSessionStore } from './api/_auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const BODY_LIMIT = process.env.BODY_LIMIT || '25mb';

try {
  validateAuthSessionStore();
} catch (error) {
  console.error('[server] CRITICAL: Auth session store validation failed:', error?.message || error);
  process.exit(1);
}

try {
  validateIdempotencyStore();
} catch (error) {
  console.error('[server] CRITICAL: GPT idempotency store validation failed:', error?.message || error);
  process.exit(1);
}

try {
  validateOAuthStore();
} catch (error) {
  console.error('[server] CRITICAL: GPT OAuth store validation failed:', error?.message || error);
  process.exit(1);
}

try {
  await Promise.all([
    validateMessageAutomationPolicyStore(),
    validateMessagePlaybookStore(),
    ...(messageLearningStoreRequired() ? [validateMessageLearningStore()] : []),
  ]);
} catch (error) {
  console.error('[server] CRITICAL: Messages policy/playbook/learning store validation failed:', error?.message || error);
  process.exit(1);
}

const isLocalHostBind = HOST === '127.0.0.1' || HOST === 'localhost';
if ((process.env.NODE_ENV === 'production' || !isLocalHostBind) && authConfigStatus() !== 'configured') {
  console.error('[server] CRITICAL: AUTH_USERS_B64 (or legacy SITE_PASSWORD) and SESSION_SECRET must be set in production.');
  process.exit(1);
}

// Safe self-hosted default: scheduled publishing is disabled. Even if an old
// systemd override or .env value says AUTOPUBLISH=true, real publishing remains
// off unless a separate owner-approved release flag is set intentionally.
const realPublishReleaseApproved = process.env.REAL_PUBLISH_RELEASE_APPROVED === 'true';
if (!realPublishReleaseApproved) {
  process.env.AUTOPUBLISH_ENABLED = 'false';
  process.env.AUTOPUBLISH = 'false';
} else {
  process.env.AUTOPUBLISH_ENABLED = process.env.AUTOPUBLISH_ENABLED === 'true' ? 'true' : 'false';
  process.env.AUTOPUBLISH = process.env.AUTOPUBLISH === 'true' ? 'true' : 'false';
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://i.etsystatic.com', 'https://*.etsystatic.com'],
      mediaSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  frameguard: { action: 'deny' },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

const configuredCorsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

function isSameOrigin(req, origin) {
  try {
    const parsed = new URL(origin);
    return parsed.host === req.get('host') && parsed.protocol === `${req.protocol}:`;
  } catch {
    return false;
  }
}

app.use((req, res, next) => cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (configuredCorsOrigins.includes(origin)) return callback(null, true);
    if (isSameOrigin(req, origin)) return callback(null, true);
    const err = new Error('CORS not allowed');
    err.status = 403;
    return callback(err);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-shop-id'],
  credentials: true,
  optionsSuccessStatus: 200,
})(req, res, next));

const rateLimitMessage = { error: 'Too many requests, please try again later' };
const localDevRateLimitMax = Number(process.env.LOCAL_DEV_RATE_LIMIT_MAX || 5000);
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV !== 'production' && isLocalHostBind ? localDevRateLimitMax : 200,
  skip: req => req.method === 'GET' && (!req.path.startsWith('/api/') || req.path.startsWith('/api/jobs/')) && req.path !== '/checkout',
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI rate limit exceeded' },
});

const messageAiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  skip: req => req.method !== 'POST'
    || !['previewDraft', 'generateDraft'].includes(req.body?.action),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Message drafting rate limit exceeded' },
});

const messageBrowserLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  skip: req => req.method !== 'POST'
    || !['syncInbox', 'syncConversationHistory'].includes(req.body?.action),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Message browser action rate limit exceeded' },
});

const messageEventLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Message event rate limit exceeded' },
});

const messageTelegramFeedbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many Telegram feedback requests' },
});

const oauthExchangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  skip: req => req.method === 'OPTIONS' || !(req.method === 'POST' && req.body?.action === 'exchange'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OAuth exchange attempts' },
});

const gptAuthorizeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded', error_description: 'Too many authorization requests' },
});

const gptTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded', error_description: 'Too many token requests' },
});

const gptRevokeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded', error_description: 'Too many revocation requests' },
});

const gptApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded', error_description: 'GPT Actions API rate limit exceeded' },
});

const gptWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  skip: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded', error_description: 'GPT Actions write rate limit exceeded' },
});

app.use(globalLimiter);

app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// Browser cookie requests may mutate state only from this exact origin. Service
// clients use scoped bearer tokens and are not affected by this browser guard.
app.use((req, res, next) => {
  if (browserMutationBlocked(req, isSameOrigin)) {
    return res.status(403).json({ error: 'Cross-origin state change blocked', code: 'CSRF_BLOCKED' });
  }
  return next();
});

function adaptApiHandler(handler) {
  return async (req, res, next) => {
    try {
      req.query = req.query || {};
      req.body = req.body || {};
      await handler(req, res);
    } catch (err) {
      next(err);
    }
  };
}

const apiRoutes = {
  '/api/auth': authHandler,
  '/api/etsy': etsyHandler,
  '/api/ai': aiHandler,
  '/api/social': socialHandler,
  '/api/upload': uploadHandler,
  '/api/stats': statsHandler,
  '/api/media': mediaHandler,
  '/api/kv': kvHandler,
  '/api/jobs': jobsHandler,
  '/api/drafts': draftsHandler,
  '/api/chat': chatHandler,
  '/api/checkout': checkoutHandler,
  '/api/agent': agentHandler,
  '/api/login': loginHandler,
  '/api/meta-ai': metaAiHandler,
  '/api/etsy-guidance': etsyGuidanceHandler,
  '/api/messages': messagesHandler,
  '/api/message-events': messageEventsHandler,
  '/api/message-telegram-feedback': messageTelegramFeedbackHandler,
  '/checkout': checkoutHandler,
};

const routeLimiters = {
  '/api/login': [loginLimiter],
  '/api/ai': [aiLimiter],
  '/api/chat': [aiLimiter],
  '/api/agent': [aiLimiter],
  '/api/auth': [oauthExchangeLimiter],
  '/api/messages': [messageAiLimiter, messageBrowserLimiter],
  '/api/message-events': [messageEventLimiter],
  '/api/message-telegram-feedback': [messageTelegramFeedbackLimiter],
};

for (const [route, handler] of Object.entries(apiRoutes)) {
  const limiters = routeLimiters[route] || [];
  app.all(route, ...limiters, adaptApiHandler(handler));
  if (route.startsWith('/api/')) {
    app.all(`${route}.js`, ...limiters, adaptApiHandler(handler));
  }
}

app.all('/oauth/authorize', gptAuthorizeLimiter, adaptApiHandler(oauthAuthorizeHandler));
app.all('/oauth/token', gptTokenLimiter, adaptApiHandler(oauthTokenHandler));
app.all('/oauth/revoke', gptRevokeLimiter, adaptApiHandler(oauthRevokeHandler));
app.all('/api/gpt/*', gptApiLimiter, gptWriteLimiter, adaptApiHandler(gptRouter));

app.get('/gpt/openapi.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(buildGptOpenApi());
});

app.get('/gpt/openapi-full.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(buildFullGptOpenApi());
});

app.get('/gpt/privacy', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Etsy AI Command Center GPT Privacy</title></head>
<body style="max-width:760px;margin:48px auto;padding:0 20px;font:16px/1.6 system-ui,sans-serif;color:#26221f">
<h1>Etsy AI Command Center GPT Actions privacy policy</h1>
<p>This private integration uses your Etsy AI Command Center account to perform only the Etsy operations you request through ChatGPT.</p>
<p>OAuth codes and tokens are stored only as cryptographic hashes. Etsy API credentials and Etsy access or refresh tokens are never returned to ChatGPT.</p>
<p>Operational security logs record the authenticated user, operation, resource identifier, outcome, IP address, and user agent. They do not record OAuth tokens, passwords, file download URLs, or uploaded file contents.</p>
<p><strong>Retention.</strong> Authorization-code hashes expire after use or normally 5 minutes (never more than 10 minutes). Access-token hashes expire normally after 1 hour (never more than 24 hours). Refresh-token hashes and rotation tombstones expire normally after 30 days (never more than 180 days). Expired OAuth records are removed during subsequent OAuth activity. Idempotency records expire after 24 hours and are removed during subsequent write activity. Security audit events are written to monthly files and retained by the service owner for security investigation until they are manually deleted or a valid deletion request is completed.</p>
<p>Files supplied through ChatGPT are downloaded immediately from short-lived, allowlisted HTTPS URLs, validated, used for the requested Etsy upload, and not retained as a separate GPT file archive.</p>
<p>You can revoke ChatGPT access at any time through the configured OAuth revocation endpoint or by asking the service owner.</p>
<p><strong>Contact and data deletion.</strong> Contact the service owner through the same private channel that granted your Etsy AI Command Center access and request “GPT Actions data deletion”, identifying the account to remove. The owner will verify the request, revoke the account's GPT OAuth token family, remove its OAuth and idempotency records, delete matching security-audit entries unless preservation is legally required, and confirm completion. No Etsy listing, order, or shop data is deleted unless the request explicitly asks for that separate Etsy operation.</p>
</body></html>`);
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    service: 'etsy-ai-command-center',
    runtime: 'node',
    autopublish_enabled: process.env.AUTOPUBLISH_ENABLED === 'true',
    autopublish: process.env.AUTOPUBLISH === 'true',
  });
});

app.use(express.static(publicDir, {
  extensions: ['html'],
  maxAge: process.env.STATIC_MAX_AGE || '1h',
  setHeaders(res, filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const ext = path.extname(filePath).toLowerCase();
    if (
      normalized.endsWith('/index.html')
      || normalized.endsWith('/sw.js')
      || ['.js', '.css'].includes(ext)
    ) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// SPA-style fallback for clean client routes while preserving 404s for missing API routes.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[server]', err?.stack || err?.message || err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? (err.message || 'Bad request') : 'Internal server error';
  res.status(status).json({ error: message });
});

app.listen(PORT, HOST, () => {
  console.log(`[server] Etsy AI Command Center listening on http://${HOST}:${PORT}`);
  console.log(`[server] AUTOPUBLISH_ENABLED=${process.env.AUTOPUBLISH_ENABLED}`);
});
