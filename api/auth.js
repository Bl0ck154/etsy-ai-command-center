// api/auth.js — Etsy OAuth token HTTP facade plus shared Hub adapter.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { requireAuth } from './_auth.js';
import { sendPublicError } from './_errors.js';
import {
  ETSY_OAUTH_API_KEY,
  ETSY_OAUTH_CLIENT_SECRET,
} from './etsy-auth/oauth-client.js';
import {
  exchangeAuthorizationCode,
  getEtsyTokenStatus as getLegacyEtsyTokenStatus,
  getValidToken as getLegacyValidToken,
  refreshAccessToken as refreshLegacyAccessToken,
  resetEtsyTokenCacheForTests,
} from './etsy-auth/token-runtime.js';

// The optional external Etsy API Hub is never implicitly tied to a host path.
// A standalone public install works with the built-in legacy-token route.

let hubModulePromise = null;
let hubTokenStorePromise = null;
let hubClientPromise = null;

export function etsyApiHubEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.ETSY_API_HUB_ENABLED || ''));
}

function hubRoot(env = process.env) {
  const value = String(env.ETSY_API_HUB_ROOT || '').trim();
  if (value) return value;
  const error = new Error(
    'ETSY_API_HUB_ROOT is required when ETSY_API_HUB_ENABLED=true; configure the optional Hub path or disable the Hub adapter.'
  );
  error.code = 'ETSY_API_HUB_NOT_CONFIGURED';
  throw error;
}

function hubCredentialFile(env = process.env) {
  const value = String(env.ETSY_API_HUB_CREDENTIAL_FILE || '').trim();
  if (value) return value;
  const error = new Error(
    'ETSY_API_HUB_CREDENTIAL_FILE is required when ETSY_API_HUB_TOKEN_SOURCE=hub.'
  );
  error.code = 'ETSY_API_HUB_CREDENTIAL_STORE_NOT_CONFIGURED';
  throw error;
}

function hubTokenSource(env = process.env) {
  return String(env.ETSY_API_HUB_TOKEN_SOURCE || 'legacy').trim().toLowerCase();
}

async function loadHubModule() {
  if (!hubModulePromise) {
    const entry = path.join(hubRoot(), 'src', 'index.mjs');
    hubModulePromise = import(pathToFileURL(entry).href);
  }
  return hubModulePromise;
}

class LegacyTokenStoreAdapter {
  async apiKeyHeader() {
    const key = String(process.env.ETSY_API_KEY || '').trim();
    const secret = String(process.env.ETSY_CLIENT_SECRET || '').trim();
    if (!key || !secret) throw new Error('ETSY_API_KEY/ETSY_CLIENT_SECRET are required for Hub legacy-token mode');
    return `${key}:${secret}`;
  }

  async accessToken() {
    return getLegacyValidToken();
  }

  async refresh() {
    const result = await refreshLegacyAccessToken();
    return result?.access_token || getLegacyValidToken();
  }
}

async function getHubTokenStore() {
  if (!hubTokenStorePromise) {
    hubTokenStorePromise = (async () => {
      if (hubTokenSource() === 'legacy') return new LegacyTokenStoreAdapter();
      if (hubTokenSource() !== 'hub') throw new Error('ETSY_API_HUB_TOKEN_SOURCE must be legacy or hub');
      const { TokenFileStore } = await loadHubModule();
      return new TokenFileStore(hubCredentialFile());
    })();
  }
  return hubTokenStorePromise;
}

async function getHubClient() {
  if (!hubClientPromise) {
    hubClientPromise = Promise.all([loadHubModule(), getHubTokenStore()]).then(([{ EtsyClient }, tokenStore]) => (
      new EtsyClient({ tokenStore })
    ));
  }
  return hubClientPromise;
}

async function hubGetValidToken() {
  return (await getHubTokenStore()).accessToken();
}

async function hubRefreshAccessToken() {
  const store = await getHubTokenStore();
  const refreshed = await store.refresh();
  if (hubTokenSource() === 'legacy') {
    const status = await getLegacyEtsyTokenStatus();
    return {
      access_token: refreshed,
      expires_at: status.expires_at,
      refresh_token: status.has_refresh_token ? '[managed-by-legacy-token-runtime]' : '',
      source: 'etsy-manager-pro-revisioned-kv',
    };
  }
  return store.read();
}

async function hubGetEtsyTokenStatus() {
  if (hubTokenSource() === 'legacy') {
    return {
      ...(await getLegacyEtsyTokenStatus()),
      source: 'etsy-manager-pro-revisioned-kv',
    };
  }
  const store = await getHubTokenStore();
  const data = await store.read();
  const expiresAt = Number(data.expires_at || 0);
  const secondsLeft = expiresAt > 0
    ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
    : null;
  return {
    valid: Boolean(data.access_token) && (secondsLeft === null || secondsLeft > 0),
    expires_in_seconds: secondsLeft,
    expires_at: expiresAt || null,
    has_refresh_token: Boolean(data.refresh_token),
    last_error: '',
    source: 'etsy-api-hub',
  };
}

export async function hubEtsyRequest(pathname, options = {}) {
  const raw = String(pathname || '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    const error = new Error('Etsy API path must start with one slash');
    error.status = 400;
    error.code = 'INVALID_ETSY_PATH';
    throw error;
  }
  const client = await getHubClient();
  const result = await client.request({
    method: options.method || 'GET',
    apiPath: `/application${raw}`,
    body: options.body,
    headers: options.headers || {},
  });
  return result.data;
}

export async function getValidToken() {
  return etsyApiHubEnabled() ? hubGetValidToken() : getLegacyValidToken();
}

export async function refreshAccessToken() {
  return etsyApiHubEnabled() ? hubRefreshAccessToken() : refreshLegacyAccessToken();
}

export { resetEtsyTokenCacheForTests };

async function getEtsyTokenStatus() {
  return etsyApiHubEnabled() ? hubGetEtsyTokenStatus() : getLegacyEtsyTokenStatus();
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    if (req.query?.action === 'oauth-config') {
      return res.json({
        api_key: ETSY_OAUTH_API_KEY || '',
        has_client_secret: Boolean(ETSY_OAUTH_CLIENT_SECRET),
      });
    }
    try {
      return res.json(await getEtsyTokenStatus());
    } catch (err) {
      return sendPublicError(res, err);
    }
  }

  if (req.method === 'POST' && req.body?.action === 'exchange') {
    const { code, verifier, api_key, client_secret, redirect_uri } = req.body;
    if (!code || !verifier) return res.status(400).json({ error: 'code and verifier required' });
    try {
      return res.json(await exchangeAuthorizationCode({
        code,
        verifier,
        apiKey: api_key,
        clientSecret: client_secret,
        redirectUri: redirect_uri,
      }));
    } catch (err) {
      if (err?.code === 'ETSY_TOKEN_STATE_CHANGED') {
        return res.status(err.status || 409).json({ error: err.message, code: err.code });
      }
      return sendPublicError(res, err);
    }
  }

  if (req.method === 'POST') {
    try {
      const token = await refreshAccessToken();
      const expiresAt = token.expires_at;
      const secondsLeft = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      return res.json({
        success: true,
        expires_in_seconds: secondsLeft,
        expires_at: expiresAt,
      });
    } catch (err) {
      return sendPublicError(res, err);
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
