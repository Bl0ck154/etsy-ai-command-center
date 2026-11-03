import { etsyTokenStateRepository, tokenStateChangedError } from '../_etsy-token-state.js';
import {
  ETSY_OAUTH_API_KEY,
  ETSY_OAUTH_CLIENT_SECRET,
  etsyOAuthClient,
} from './oauth-client.js';

let tokenCache = {
  access_token: process.env.ETSY_ACCESS_TOKEN || '',
  refresh_token: process.env.ETSY_REFRESH_TOKEN || '',
  expires_at: Date.now() + 60 * 60 * 1000,
  last_error: '',
  invalid_refresh_token: '',
};

let refreshPromise = null;

export function resetEtsyTokenCacheForTests({
  accessToken = '',
  refreshToken = '',
  expiresAt = Date.now() + 60 * 60 * 1000,
} = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Test token reset is unavailable in production');
  tokenCache = {
    access_token: String(accessToken || ''),
    refresh_token: String(refreshToken || ''),
    expires_at: Number(expiresAt),
    last_error: '',
    last_failed_access_token: '',
    invalid_refresh_token: '',
  };
  refreshPromise = null;
}

function repositoryContractError(error) {
  return String(error?.code || '').startsWith('REVISIONED_JSON_');
}

export function isUsableRefreshToken(token) {
  const value = String(token || '').trim();
  return value
    && !/^your[_-]?refresh[_-]?token$/i.test(value)
    && !/^undefined|null$/i.test(value);
}

function isInvalidRefreshTokenError(data) {
  const message = `${data?.error || ''} ${data?.error_description || ''}`.toLowerCase();
  return message.includes('invalid_grant')
    || message.includes('refresh_token is invalid')
    || message.includes('refresh token is invalid');
}

function tokenSetupError(message = '') {
  const error = new Error(message || 'Etsy access token expired and no valid refresh token is configured. Reconnect Etsy OAuth or save a current access token + refresh token in Settings.');
  error.status = 401;
  return error;
}

function hasUsableCachedAccessToken() {
  return Boolean(tokenCache.access_token && Date.now() < Number(tokenCache.expires_at || 0) - 60_000);
}

export async function loadPersistedToken() {
  try {
    const snapshot = await etsyTokenStateRepository.readSnapshot();
    const saved = snapshot.state;
    if (!saved || typeof saved !== 'object' || !Object.keys(saved).length) return snapshot;
    tokenCache = {
      access_token: saved.access_token || tokenCache.access_token,
      refresh_token: saved.refresh_token || tokenCache.refresh_token,
      expires_at: Number(saved.expires_at) || tokenCache.expires_at,
      last_error: saved.last_error || tokenCache.last_error || '',
      last_failed_access_token: saved.last_failed_access_token || tokenCache.last_failed_access_token || '',
      invalid_refresh_token: saved.invalid_refresh_token || tokenCache.invalid_refresh_token || '',
    };
    const envAccess = process.env.ETSY_ACCESS_TOKEN || '';
    const envRefresh = process.env.ETSY_REFRESH_TOKEN || '';
    if (tokenCache.invalid_refresh_token && tokenCache.refresh_token === tokenCache.invalid_refresh_token) {
      tokenCache.refresh_token = '';
    }
    const canUseEnvAccess = envAccess && envAccess !== tokenCache.last_failed_access_token;
    const savedRefreshUsable = isUsableRefreshToken(tokenCache.refresh_token);
    if (canUseEnvAccess && (
      tokenCache.last_error
      || !tokenCache.access_token
      || (!savedRefreshUsable && tokenCache.access_token !== envAccess)
    )) {
      tokenCache = {
        access_token: envAccess,
        refresh_token: isUsableRefreshToken(envRefresh) && envRefresh !== tokenCache.invalid_refresh_token
          ? envRefresh
          : '',
        expires_at: Date.now() + 60 * 60 * 1000,
        last_error: '',
        last_failed_access_token: tokenCache.last_failed_access_token || '',
        invalid_refresh_token: tokenCache.invalid_refresh_token || '',
      };
    }
    return snapshot;
  } catch (error) {
    if (repositoryContractError(error)) throw error;
    return null;
  }
}

async function persistTokenCache({ expectedRevision = null } = {}) {
  try {
    const snapshot = Number.isInteger(expectedRevision) && expectedRevision >= 0
      ? await etsyTokenStateRepository.compareAndReplace(expectedRevision, tokenCache)
      : await etsyTokenStateRepository.update(() => ({ ...tokenCache }));
    return { written: true, conflict: false, revision: snapshot.revision };
  } catch (error) {
    if (error?.code === 'REVISIONED_JSON_REVISION_CONFLICT') {
      await loadPersistedToken();
      return { written: false, conflict: true, error };
    }
    if (repositoryContractError(error)) throw error;
    return { written: false, conflict: false, error };
  }
}

export async function getValidToken() {
  await loadPersistedToken();
  if (hasUsableCachedAccessToken()) return tokenCache.access_token;
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => { refreshPromise = null; });
  }
  await refreshPromise;
  return tokenCache.access_token;
}

export async function refreshAccessToken({ oauthClient = etsyOAuthClient } = {}) {
  const persisted = await loadPersistedToken();
  const expectedRevision = Number.isInteger(persisted?.revision) ? persisted.revision : null;
  const refreshToken = tokenCache.refresh_token || process.env.ETSY_REFRESH_TOKEN;
  if (tokenCache.invalid_refresh_token && refreshToken === tokenCache.invalid_refresh_token) {
    throw tokenSetupError('Etsy refresh token is invalid. Reconnect Etsy OAuth or save a fresh access token and refresh token.');
  }
  if (!isUsableRefreshToken(refreshToken)) throw tokenSetupError();
  if (!ETSY_OAUTH_API_KEY) throw new Error('ETSY_API_KEY not set');
  if (!ETSY_OAUTH_CLIENT_SECRET) throw new Error('ETSY_CLIENT_SECRET not set (required Feb 2026+)');

  const response = await oauthClient.refreshToken({
    refreshToken,
    apiKey: ETSY_OAUTH_API_KEY,
    clientSecret: ETSY_OAUTH_CLIENT_SECRET,
  });
  const data = response.data;
  if (!response.ok) {
    const message = data.error_description || data.error || `Token refresh failed: ${response.status}`;
    if (isInvalidRefreshTokenError(data)) {
      tokenCache = {
        ...tokenCache,
        refresh_token: '',
        expires_at: 0,
        last_error: 'Etsy refresh token is invalid. Reconnect Etsy OAuth or save a fresh access token and refresh token.',
        last_failed_access_token: tokenCache.access_token || '',
        invalid_refresh_token: refreshToken,
      };
      const persistedInvalidState = await persistTokenCache({ expectedRevision });
      if (persistedInvalidState.conflict) {
        if (hasUsableCachedAccessToken()) return tokenCache;
        throw tokenStateChangedError('refresh');
      }
      throw tokenSetupError(tokenCache.last_error);
    }
    throw new Error(message);
  }

  tokenCache = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    last_error: '',
    last_failed_access_token: '',
    invalid_refresh_token: '',
  };
  const persistedRefresh = await persistTokenCache({ expectedRevision });
  if (persistedRefresh.conflict) {
    if (hasUsableCachedAccessToken()) return tokenCache;
    throw tokenStateChangedError('refresh');
  }
  return tokenCache;
}

export async function exchangeAuthorizationCode({
  code,
  verifier,
  apiKey,
  clientSecret,
  redirectUri,
  oauthClient = etsyOAuthClient,
} = {}) {
  const persisted = await loadPersistedToken();
  const expectedRevision = Number.isInteger(persisted?.revision) ? persisted.revision : null;
  const key = apiKey || ETSY_OAUTH_API_KEY;
  const secret = clientSecret || ETSY_OAUTH_CLIENT_SECRET;
  const exchange = await oauthClient.exchangeCode({
    code,
    verifier,
    apiKey: key,
    clientSecret: secret,
    redirectUri: redirectUri || '',
  });
  if (!exchange.ok) {
    const error = new Error(exchange.data.error_description || exchange.data.error);
    error.status = 400;
    throw error;
  }

  const tokenData = exchange.data;
  const shopId = await oauthClient.resolveShopId(tokenData.access_token, exchange.apiKeyFull);
  tokenCache = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000,
    last_error: '',
    last_failed_access_token: '',
    invalid_refresh_token: '',
  };
  const persistedExchange = await persistTokenCache({ expectedRevision });
  if (persistedExchange.conflict) throw tokenStateChangedError('OAuth exchange');

  return {
    connected: true,
    expires_in: tokenData.expires_in,
    shop_id: shopId,
  };
}

export async function getEtsyTokenStatus() {
  await loadPersistedToken();
  const hasToken = Boolean(tokenCache.access_token || process.env.ETSY_ACCESS_TOKEN);
  const expiresAt = tokenCache.expires_at;
  const secondsLeft = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  const refreshToken = tokenCache.refresh_token || process.env.ETSY_REFRESH_TOKEN;
  return {
    valid: hasToken && secondsLeft > 0,
    expires_in_seconds: secondsLeft,
    expires_at: expiresAt,
    has_refresh_token: isUsableRefreshToken(refreshToken) && refreshToken !== tokenCache.invalid_refresh_token,
    last_error: tokenCache.last_error || '',
    using_env_token: Boolean(process.env.ETSY_ACCESS_TOKEN && tokenCache.access_token === process.env.ETSY_ACCESS_TOKEN),
  };
}

export function getEtsyTokenCacheSnapshotForTests() {
  if (process.env.NODE_ENV === 'production') throw new Error('Test token snapshot is unavailable in production');
  return { ...tokenCache };
}
