export const ETSY_OAUTH_API_KEY = process.env.ETSY_API_KEY;
export const ETSY_OAUTH_CLIENT_SECRET = process.env.ETSY_CLIENT_SECRET || '';
export const ETSY_OAUTH_API_KEY_FULL = ETSY_OAUTH_CLIENT_SECRET
  ? `${ETSY_OAUTH_API_KEY}:${ETSY_OAUTH_CLIENT_SECRET}`
  : ETSY_OAUTH_API_KEY;

const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const OPENAPI_BASE = 'https://openapi.etsy.com/v3/application';

export function createEtsyOAuthClient({ fetchImpl = fetch } = {}) {
  async function refreshToken({
    refreshToken,
    apiKey = ETSY_OAUTH_API_KEY,
    clientSecret = ETSY_OAUTH_CLIENT_SECRET,
  } = {}) {
    const apiKeyFull = clientSecret ? `${apiKey}:${clientSecret}` : apiKey;
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-api-key': apiKeyFull,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: apiKey,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });
    return { ok: response.ok, status: response.status, data: await response.json() };
  }

  async function exchangeCode({
    code,
    verifier,
    apiKey = ETSY_OAUTH_API_KEY,
    clientSecret = ETSY_OAUTH_CLIENT_SECRET,
    redirectUri = '',
  } = {}) {
    const apiKeyFull = clientSecret ? `${apiKey}:${clientSecret}` : apiKey;
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-api-key': apiKeyFull,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: apiKey,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    });
    return {
      ok: response.ok,
      status: response.status,
      data: await response.json(),
      apiKeyFull,
    };
  }

  async function resolveShopId(accessToken, apiKeyFull = ETSY_OAUTH_API_KEY_FULL) {
    try {
      const meResponse = await fetchImpl(`${OPENAPI_BASE}/users/me`, {
        headers: { 'x-api-key': apiKeyFull, Authorization: `Bearer ${accessToken}` },
      });
      const me = await meResponse.json();
      const shopResponse = await fetchImpl(`${OPENAPI_BASE}/users/${me.user_id}/shops`, {
        headers: { 'x-api-key': apiKeyFull, Authorization: `Bearer ${accessToken}` },
      });
      const shops = await shopResponse.json();
      return String(shops?.results?.[0]?.shop_id || shops?.shop_id || '');
    } catch {
      return '';
    }
  }

  return { exchangeCode, refreshToken, resolveShopId };
}

export const etsyOAuthClient = createEtsyOAuthClient();
