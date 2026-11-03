import { test, expect } from '@playwright/test';

import {
  bridgeApprovalPost,
  bridgePost,
  bridgeRequest,
} from '../api/messages/bridge-client.js';

test.describe.configure({ mode: 'serial' });

const BRIDGE_ENV_KEYS = [
  'ETSY_MESSAGES_BRIDGE_URL',
  'ETSY_MESSAGES_BRIDGE_TOKEN',
  'ETSY_MESSAGES_BRIDGE_APPROVAL_TOKEN',
];

async function withBridgeEnv(values, operation) {
  const previous = Object.fromEntries(
    BRIDGE_ENV_KEYS.map(key => [key, process.env[key]]),
  );
  for (const key of BRIDGE_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined && value !== null) process.env[key] = String(value);
  }
  try {
    return await operation();
  } finally {
    for (const key of BRIDGE_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

function configuredBridgeEnv(extra = {}) {
  return {
    ETSY_MESSAGES_BRIDGE_URL: 'http://bridge.test',
    ETSY_MESSAGES_BRIDGE_TOKEN: 'test-bridge-token',
    ETSY_MESSAGES_BRIDGE_APPROVAL_TOKEN: 'test-approval-token',
    ...extra,
  };
}

test('Hub consumer sends the Bridge contract path, bearer token, idempotency key, and bounded JSON body', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ status: 'created' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withBridgeEnv(configuredBridgeEnv(), async () => {
      const result = await bridgePost(
        '/v1/outbox/drafts',
        { conversation_id: '123', body: 'Hello' },
        { 'Idempotency-Key': 'draft-123' },
      );

      expect(result).toEqual({ status: 'created' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://bridge.test/v1/outbox/drafts');
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].options.headers).toMatchObject({
        Authorization: 'Bearer test-bridge-token',
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'draft-123',
      });
      expect(JSON.parse(calls[0].options.body)).toEqual({
        conversation_id: '123',
        body: 'Hello',
      });
      expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('approved delivery uses the separate Bridge approval credential without exposing it in the body', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ status: 'sent' }), { status: 200 });
  };

  try {
    await withBridgeEnv(configuredBridgeEnv(), async () => {
      await bridgeApprovalPost('/v1/outbox/drafts/draft-123/send', {
        expected_body_sha256: 'a'.repeat(64),
      });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.headers).toMatchObject({
      Authorization: 'Bearer test-bridge-token',
      'X-Bridge-Approval-Token': 'test-approval-token',
    });
    expect(calls[0].options.body).not.toContain('test-approval-token');

    calls.length = 0;
    await withBridgeEnv(configuredBridgeEnv({
      ETSY_MESSAGES_BRIDGE_APPROVAL_TOKEN: undefined,
    }), async () => {
      await expect(bridgeApprovalPost('/v1/outbox/drafts/draft-123/send', {}))
        .rejects.toMatchObject({
          status: 503,
          code: 'MESSAGE_APPROVAL_CREDENTIAL_NOT_CONFIGURED',
        });
    });
    expect(calls).toHaveLength(0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Hub consumer fails closed for missing credentials, non-local paths, and invalid provider JSON', async () => {
  await withBridgeEnv({ ETSY_MESSAGES_BRIDGE_URL: 'http://bridge.test' }, async () => {
    await expect(bridgeRequest('/v1/status')).rejects.toMatchObject({
      status: 503,
      code: 'MESSAGE_BRIDGE_NOT_CONFIGURED',
    });
  });

  await withBridgeEnv(configuredBridgeEnv(), async () => {
    await expect(bridgeRequest('v1/status')).rejects.toMatchObject({
      status: 503,
      code: 'MESSAGE_BRIDGE_UNAVAILABLE',
    });
  });

  const originalFetch = global.fetch;
  global.fetch = async () => new Response('<html>not json</html>', { status: 200 });
  try {
    await withBridgeEnv(configuredBridgeEnv(), async () => {
      await expect(bridgeRequest('/v1/status')).rejects.toMatchObject({
        status: 502,
        code: 'MESSAGE_BRIDGE_INVALID_RESPONSE',
      });
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('provider rejection and unavailable outcomes remain explicit and are never retried by the transport', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  try {
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({
        detail: 'approval body no longer matches',
        code: 'OUTBOX_BODY_MISMATCH',
      }), { status: 409 });
    };
    await withBridgeEnv(configuredBridgeEnv(), async () => {
      await expect(bridgeRequest('/v1/outbox/drafts/draft-123/send', {
        method: 'POST',
        body: {},
      })).rejects.toMatchObject({
        status: 409,
        bridge_status: 409,
        code: 'OUTBOX_BODY_MISMATCH',
      });
    });
    expect(calls).toBe(1);

    calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw new TypeError('connection reset');
    };
    await withBridgeEnv(configuredBridgeEnv(), async () => {
      await expect(bridgeRequest('/v1/status')).rejects.toMatchObject({
        status: 503,
        code: 'MESSAGE_BRIDGE_UNAVAILABLE',
      });
    });
    expect(calls).toBe(1);
  } finally {
    global.fetch = originalFetch;
  }
});
