import { readJsonResponse, userFacingErrorMessage } from './api.js';

function currentShopHeaders(storage = globalThis.sessionStorage) {
  try {
    const id = storage?.getItem?.('etsy_mgr_active_shop');
    return id ? { 'x-shop-id': id } : {};
  } catch {
    return {};
  }
}

export function createMessagesTransport({
  fetchImpl = globalThis.fetch,
  readJson = readJsonResponse,
  presentError = userFacingErrorMessage,
  storage = globalThis.sessionStorage,
  createAbortController = () => new AbortController(),
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  async function request(method, action, values = {}, timeoutMs = 60_000) {
    const controller = createAbortController();
    const timer = setTimer(() => controller.abort(), timeoutMs);
    const isGet = method === 'GET';
    const query = isGet
      ? `?${new URLSearchParams({ action, ...values }).toString()}`
      : '';

    try {
      const response = await fetchImpl(`/api/messages${query}`, {
        method,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...currentShopHeaders(storage),
        },
        body: isGet ? undefined : JSON.stringify({ action, ...values }),
      });
      const data = await readJson(response, 'Messages');
      return data.data !== undefined ? data.data : data;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('Messages request timed out. No message was sent.');
      }
      throw new Error(presentError(error?.message || error));
    } finally {
      clearTimer(timer);
    }
  }

  return {
    get: (action, values) => request('GET', action, values),
    post: (action, values, timeoutMs) => request('POST', action, values, timeoutMs),
  };
}

export const messagesTransport = createMessagesTransport();
