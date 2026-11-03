const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const RECEIPT_ID_PATTERN = /^[0-9]{5,32}$/;

function cleanReceiptId(value) {
  const receiptId = String(value ?? '').trim();
  if (!RECEIPT_ID_PATTERN.test(receiptId)) {
    const error = new Error('Etsy receipt_id must contain 5 to 32 digits');
    error.status = 400;
    error.code = 'ORDER_CONTEXT_INVALID_RECEIPT_ID';
    throw error;
  }
  return receiptId;
}

function normalizedBaseUrl(value = process.env.ORDER_CONTEXT_API_URL) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) {
    const error = new Error('IONOS Order Context API is not configured');
    error.status = 503;
    error.code = 'ORDER_CONTEXT_NOT_CONFIGURED';
    throw error;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const error = new Error('ORDER_CONTEXT_API_URL is invalid');
    error.status = 503;
    error.code = 'ORDER_CONTEXT_NOT_CONFIGURED';
    throw error;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    const error = new Error(
      'ORDER_CONTEXT_API_URL must be an HTTP(S) origin without credentials or query parameters',
    );
    error.status = 503;
    error.code = 'ORDER_CONTEXT_NOT_CONFIGURED';
    throw error;
  }
  return parsed.toString().replace(/\/+$/, '');
}

function requiredToken(value = process.env.ORDER_CONTEXT_API_TOKEN) {
  const token = String(value || '').trim();
  if (Buffer.byteLength(token, 'utf8') < 32) {
    const error = new Error('IONOS Order Context API credential is not configured');
    error.status = 503;
    error.code = 'ORDER_CONTEXT_NOT_CONFIGURED';
    throw error;
  }
  return token;
}

function validIsoDate(value) {
  return Boolean(value && Number.isFinite(Date.parse(String(value))));
}

function validateExactResponse(data, receiptId) {
  if (
    !data
    || typeof data !== 'object'
    || Array.isArray(data)
    || data.schema_version !== 1
    || !validIsoDate(data.generated_at)
    || data.match?.status !== 'exact'
    || Number(data.match?.confidence) !== 1
    || !data.context
    || typeof data.context !== 'object'
    || String(data.context?.order?.order_id || '') !== receiptId
  ) {
    const error = new Error(
      'IONOS Order Context API did not return an exact matching receipt',
    );
    error.status = 502;
    error.code = 'ORDER_CONTEXT_INVALID_RESPONSE';
    throw error;
  }
  return data;
}

export function orderContextConfig() {
  const url = String(process.env.ORDER_CONTEXT_API_URL || '').trim();
  const token = String(process.env.ORDER_CONTEXT_API_TOKEN || '').trim();
  return {
    configured: Boolean(url && Buffer.byteLength(token, 'utf8') >= 32),
    timeout_ms: Math.max(
      1_000,
      Math.min(
        Number.parseInt(process.env.ORDER_CONTEXT_API_TIMEOUT_MS, 10)
          || DEFAULT_TIMEOUT_MS,
        60_000,
      ),
    ),
    lookup_mode: 'exact_receipt_id_only',
    read_only: true,
  };
}

export async function fetchOrderContextByReceiptId(receiptIdValue, options = {}) {
  const receiptId = cleanReceiptId(receiptIdValue);
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const token = requiredToken(options.token);
  const timeoutMs = Math.max(
    1_000,
    Math.min(
      Number(options.timeoutMs)
        || Number.parseInt(process.env.ORDER_CONTEXT_API_TIMEOUT_MS, 10)
        || DEFAULT_TIMEOUT_MS,
      60_000,
    ),
  );
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const error = new Error('HTTP client is unavailable');
    error.status = 503;
    error.code = 'ORDER_CONTEXT_UNAVAILABLE';
    throw error;
  }

  const endpoint = new URL(
    `${baseUrl}/internal/v1/orders/${encodeURIComponent(receiptId)}/context`,
  );
  if (options.checkEmailClaim === true) {
    endpoint.searchParams.set('gmail_claim_check', '1');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(
      endpoint.toString(),
      {
        method: 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      },
    );
  } catch (error) {
    const wrapped = new Error(
      error?.name === 'AbortError'
        ? `IONOS Order Context API timed out after ${Math.round(timeoutMs / 1_000)}s`
        : 'IONOS Order Context API is unavailable',
    );
    wrapped.status = 503;
    wrapped.code = error?.name === 'AbortError'
      ? 'ORDER_CONTEXT_TIMEOUT'
      : 'ORDER_CONTEXT_UNAVAILABLE';
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    const error = new Error('IONOS Order Context API response is too large');
    error.status = 502;
    error.code = 'ORDER_CONTEXT_INVALID_RESPONSE';
    throw error;
  }

  const raw = await response.text().catch(() => '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    const error = new Error('IONOS Order Context API response is too large');
    error.status = 502;
    error.code = 'ORDER_CONTEXT_INVALID_RESPONSE';
    throw error;
  }

  let data = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      const error = new Error('IONOS Order Context API returned invalid JSON');
      error.status = 502;
      error.code = 'ORDER_CONTEXT_INVALID_RESPONSE';
      throw error;
    }
  }

  if (response.status === 404) {
    const error = new Error(`Order ${receiptId} was not found in verified IONOS data`);
    error.status = 404;
    error.code = 'ORDER_CONTEXT_NOT_FOUND';
    throw error;
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error('IONOS Order Context API authentication failed');
    error.status = 503;
    error.code = 'ORDER_CONTEXT_AUTH_FAILED';
    throw error;
  }
  if (!response.ok) {
    const error = new Error('IONOS Order Context API request failed');
    error.status = 503;
    error.code = 'ORDER_CONTEXT_UPSTREAM_ERROR';
    error.upstream_status = response.status;
    throw error;
  }

  return validateExactResponse(data, receiptId);
}

export function exactReceiptIdFromBridgeConversation(value) {
  const conversation = value?.conversation || value || {};
  const ids = new Set([
    ...(Array.isArray(conversation.receipt_ids) ? conversation.receipt_ids : []),
    ...(Array.isArray(conversation.order_refs)
      ? conversation.order_refs.map(reference => reference?.receipt_id)
      : []),
  ].map(item => String(item || '').trim()).filter(
    item => RECEIPT_ID_PATTERN.test(item),
  ));

  if (ids.size !== 1) {
    const error = new Error(
      ids.size
        ? 'Conversation contains multiple receipt IDs; select one explicitly'
        : 'Conversation has no exact Etsy receipt_id',
    );
    error.status = 409;
    error.code = ids.size
      ? 'ORDER_CONTEXT_AMBIGUOUS_RECEIPT_ID'
      : 'ORDER_CONTEXT_RECEIPT_ID_UNAVAILABLE';
    throw error;
  }
  return [...ids][0];
}

export { cleanReceiptId as normalizeReceiptId };
