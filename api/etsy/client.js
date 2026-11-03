import { etsyApiHubEnabled, getValidToken, hubEtsyRequest, refreshAccessToken } from '../auth.js';

export const ETSY_BASE = 'https://openapi.etsy.com/v3/application';

const API_KEY = process.env.ETSY_API_KEY;
const CLIENT_SECRET = process.env.ETSY_CLIENT_SECRET || '';
export const API_KEY_FULL = CLIENT_SECRET ? `${API_KEY}:${CLIENT_SECRET}` : API_KEY;
export const ETSY_TIMEOUT_MS = 20_000;

export function getShopId() {
  const raw = process.env.ETSY_SHOP_ID || '';
  return raw ? String(parseInt(raw.trim(), 10)) : '';
}

export function createEtsyApiClient({
  getToken = getValidToken,
  refreshToken = refreshAccessToken,
  fetchImpl = (...args) => fetch(...args),
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  createAbortController = () => new AbortController(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
} = {}) {
  async function request(path, options = {}, retried = false, attempt = 0) {
    const token = await getToken();

    if (options.method === 'POST' && options.body) {
      const bodyLength = typeof options.body === 'string' ? options.body.length : 0;
      logger.log?.('[etsyFetch] POST to:', path, `(body redacted, ${bodyLength} bytes)`);
    }

    const controller = createAbortController();
    const timer = setTimer(() => controller.abort(), ETSY_TIMEOUT_MS);
    let response;
    try {
      const isMultipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
      response = await fetchImpl(`${ETSY_BASE}${path}`, {
        signal: controller.signal,
        ...options,
        headers: {
          ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
          'x-api-key': API_KEY_FULL,
          Authorization: `Bearer ${token}`,
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      clearTimer(timer);
      if (error.name === 'AbortError') throw new Error(`Etsy API timeout after ${ETSY_TIMEOUT_MS / 1000}s`);
      throw error;
    }
    clearTimer(timer);

    if (response.status === 401 && !retried) {
      await refreshToken();
      return request(path, options, true, attempt);
    }

    if (response.status === 429 && attempt < 3) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '1', 10);
      const delay = Math.min(retryAfter * 1000, 500 * Math.pow(2, attempt + 1));
      await sleep(delay);
      return request(path, options, retried, attempt + 1);
    }

    if (response.status === 204) return { success: true };
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(data.error_description || data.error || `Etsy API ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  return { request };
}

const defaultEtsyApiClient = createEtsyApiClient();

export async function etsyFetch(path, options = {}, retried = false, attempt = 0) {
  if (etsyApiHubEnabled()) return hubEtsyRequest(path, options);
  return defaultEtsyApiClient.request(path, options, retried, attempt);
}
