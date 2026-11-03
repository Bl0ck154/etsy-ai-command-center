import { orderContextConfig } from './order-context-client.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function normalizedBaseUrl() {
  const value = String(
    process.env.ETSY_MESSAGES_BRIDGE_URL || 'http://127.0.0.1:8787',
  ).trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('ETSY_MESSAGES_BRIDGE_URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('ETSY_MESSAGES_BRIDGE_URL must use HTTP or HTTPS');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function messageAutomationConfig() {
  const orderLinkingConfigured = boolEnv(
    'MESSAGE_ORDER_LINKING_ENABLED',
    false,
  );
  const automaticTriggersConfigured = boolEnv(
    'MESSAGE_AUTO_TRIGGERS_ENABLED',
    false,
  );
  const triggerRunnerEnabled = boolEnv(
    'MESSAGE_TRIGGER_RUNNER_ENABLED',
    false,
  );
  const orderContext = orderContextConfig();
  const eventIngestConfigured = Buffer.byteLength(
    String(process.env.MESSAGE_EVENT_INGEST_TOKEN || '').trim(),
    'utf8',
  ) >= 32;
  return {
    bridge_configured: Boolean(
      String(process.env.ETSY_MESSAGES_BRIDGE_TOKEN || '').trim(),
    ),
    approval_credential_configured: Boolean(
      String(process.env.ETSY_MESSAGES_BRIDGE_APPROVAL_TOKEN || '').trim(),
    ),
    order_linking_configured: orderLinkingConfigured,
    order_context_configured: orderContext.configured,
    order_linking_enabled:
      orderLinkingConfigured && orderContext.configured,
    automatic_triggers_configured: automaticTriggersConfigured,
    automatic_triggers_enabled:
      automaticTriggersConfigured
      && triggerRunnerEnabled
      && eventIngestConfigured,
    automatic_trigger_runtime: 'draft_only_available',
    universal_assistant_enabled: boolEnv(
      'MESSAGE_UNIVERSAL_ASSISTANT_ENABLED',
      false,
    ),
    trigger_runner_enabled: triggerRunnerEnabled,
    event_ingest_configured: eventIngestConfigured,
    telegram_notifications_enabled: boolEnv(
      'MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED',
      false,
    ),
  };
}

function safeBridgePath(pathname) {
  const value = String(pathname || '');
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new Error('Bridge path must be an absolute local API path');
  }
  return value;
}

export async function bridgeRequest(pathname, options = {}) {
  const token = String(process.env.ETSY_MESSAGES_BRIDGE_TOKEN || '').trim();
  if (!token) {
    const error = new Error('Etsy Messages Bridge is not configured');
    error.status = 503;
    error.code = 'MESSAGE_BRIDGE_NOT_CONFIGURED';
    throw error;
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(
    1_000,
    Math.min(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 180_000),
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (options.approvalCredential) {
    const approvalToken = String(
      process.env.ETSY_MESSAGES_BRIDGE_APPROVAL_TOKEN || '',
    ).trim();
    if (!approvalToken) {
      const error = new Error('Message approval credential is not configured');
      error.status = 503;
      error.code = 'MESSAGE_APPROVAL_CREDENTIAL_NOT_CONFIGURED';
      throw error;
    }
    headers['X-Bridge-Approval-Token'] = approvalToken;
  }

  let response;
  try {
    response = await fetch(`${normalizedBaseUrl()}${safeBridgePath(pathname)}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    const wrapped = new Error(
      error?.name === 'AbortError'
        ? `Etsy Messages Bridge timed out after ${Math.round(timeoutMs / 1000)}s`
        : 'Etsy Messages Bridge is unavailable',
    );
    wrapped.status = 503;
    wrapped.code = error?.name === 'AbortError'
      ? 'MESSAGE_BRIDGE_TIMEOUT'
      : 'MESSAGE_BRIDGE_UNAVAILABLE';
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text().catch(() => '');
  let data = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      const error = new Error('Etsy Messages Bridge returned invalid JSON');
      error.status = 502;
      error.code = 'MESSAGE_BRIDGE_INVALID_RESPONSE';
      throw error;
    }
  }
  if (!response.ok) {
    const detail = data?.detail || data?.error || `HTTP ${response.status}`;
    const error = new Error(`Etsy Messages Bridge rejected the request: ${detail}`);
    error.status = response.status >= 500 ? 503 : response.status;
    error.code = data?.code || 'MESSAGE_BRIDGE_REQUEST_FAILED';
    error.bridge_status = response.status;
    throw error;
  }
  return data;
}

export async function bridgeBinaryRequest(pathname, options = {}) {
  const token = String(process.env.ETSY_MESSAGES_BRIDGE_TOKEN || '').trim();
  if (!token) {
    const error = new Error('Etsy Messages Bridge is not configured');
    error.status = 503;
    error.code = 'MESSAGE_BRIDGE_NOT_CONFIGURED';
    throw error;
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(
    1_000,
    Math.min(Number(options.timeoutMs) || 60_000, 180_000),
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${normalizedBaseUrl()}${safeBridgePath(pathname)}`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'image/jpeg,image/png,image/gif,image/webp,application/pdf',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(
        response.status === 404
          ? 'Attachment content is not available locally'
          : `Etsy Messages Bridge rejected the attachment request: HTTP ${response.status}`,
      );
      error.status = response.status === 404 ? 404 : 503;
      error.code = response.status === 404
        ? 'MESSAGE_ATTACHMENT_NOT_FOUND'
        : 'MESSAGE_BRIDGE_REQUEST_FAILED';
      throw error;
    }

    const mimeType = String(response.headers.get('content-type') || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      const error = new Error('Attachment has an unsupported content type');
      error.status = 502;
      error.code = 'MESSAGE_ATTACHMENT_UNSUPPORTED';
      throw error;
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_ATTACHMENT_BYTES) {
      const error = new Error('Attachment is too large');
      error.status = 413;
      error.code = 'MESSAGE_ATTACHMENT_TOO_LARGE';
      throw error;
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length || body.length > MAX_ATTACHMENT_BYTES) {
      const error = new Error('Attachment is empty or too large');
      error.status = body.length ? 413 : 404;
      error.code = body.length
        ? 'MESSAGE_ATTACHMENT_TOO_LARGE'
        : 'MESSAGE_ATTACHMENT_NOT_FOUND';
      throw error;
    }
    return { body, mimeType };
  } catch (error) {
    if (error?.status) throw error;
    const wrapped = new Error(
      error?.name === 'AbortError'
        ? `Etsy Messages Bridge attachment request timed out after ${Math.round(timeoutMs / 1000)}s`
        : 'Etsy Messages Bridge attachment is unavailable',
    );
    wrapped.status = 503;
    wrapped.code = error?.name === 'AbortError'
      ? 'MESSAGE_BRIDGE_TIMEOUT'
      : 'MESSAGE_BRIDGE_UNAVAILABLE';
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

export function bridgeQuery(pathname, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return bridgeRequest(`${pathname}${suffix ? `?${suffix}` : ''}`);
}

export function bridgePost(pathname, body = {}, headers = {}, timeoutMs) {
  return bridgeRequest(pathname, {
    method: 'POST',
    body,
    headers,
    timeoutMs,
  });
}

export function bridgeApprovalPost(pathname, body = {}, timeoutMs) {
  return bridgeRequest(pathname, {
    method: 'POST',
    body,
    approvalCredential: true,
    timeoutMs,
  });
}
