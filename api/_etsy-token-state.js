import { createEtsyRevisionedStateRepository } from './modules/etsy/index.js';

const SHOP_ID = process.env.ETSY_SHOP_ID || 'default';
const STORAGE_KEY = `${SHOP_ID}:etsy_oauth_tokens`;

function getKvCreds() {
  const url = (process.env.KV_REST_API_URL || '').replace(/^["']|["']$/g, '');
  const token = (process.env.KV_REST_API_TOKEN || '').replace(/^["']|["']$/g, '');
  return { url, token };
}

async function callKv(command, ...args) {
  const { url, token } = getKvCreds();
  if (!url || !token) {
    throw new Error('KV_REST_API_URL or KV_REST_API_TOKEN not configured. Add an Upstash-compatible Redis REST endpoint to the runtime environment.');
  }
  const response = await fetch(`${url}/${[command, ...args].join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export const etsyTokenStateRepository = createEtsyRevisionedStateRepository({
  callKv,
  key: STORAGE_KEY,
});

export function mergeEtsyTokenSettings(current = {}, input = {}, now = Date.now) {
  const existing = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const cfg = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const timestamp = Number(typeof now === 'function' ? now() : now);
  const expiresInSeconds = Math.max(parseInt(cfg.expires_in, 10) || 3600, 60);
  return {
    access_token: String(cfg.access_token || existing.access_token || '').trim(),
    refresh_token: String(cfg.refresh_token || existing.refresh_token || '').trim(),
    expires_at: timestamp + expiresInSeconds * 1000,
    last_error: '',
    last_failed_access_token: '',
    invalid_refresh_token: '',
  };
}

export function tokenStateChangedError(operation = 'update') {
  const error = new Error(`Etsy token state changed while ${operation} was in progress. Retry the request.`);
  error.code = 'ETSY_TOKEN_STATE_CHANGED';
  error.status = 409;
  return error;
}
