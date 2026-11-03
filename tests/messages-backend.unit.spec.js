import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import messagesHandler from '../api/messages.js';
import {
  bridgeBinaryRequest,
  messageAutomationConfig,
} from '../api/messages/bridge-client.js';
import {
  loadMessagePlaybook,
  normalizeMessagePlaybook,
  saveMessagePlaybook,
} from '../api/messages/playbook.js';
import { validateDraftResult } from '../api/messages/draft-agent.js';
import {
  loadMessageAutomationPolicy,
  normalizeMessageAutomationPolicy,
  saveMessageAutomationPolicy,
} from '../api/messages/automation-policy.js';
import {
  getMessageConversationForAgent,
  prepareMessageDraftForAgent,
} from '../api/messages/agent-tools.js';

test.describe.configure({ mode: 'serial' });

test('operator-selected message scenario remains authoritative over model metadata', () => {
  const result = validateDraftResult({
    status: 'ready',
    scenario: 'review_request',
    reply_body: 'Thanks for your message.',
    requires_human_approval: true,
    confidence: 0.8,
    warnings: [],
    facts_used: [],
  }, 'freeform');

  expect(result.scenario).toBe('freeform');
  expect(result.reply_body).toBe('Thanks for your message.');
});

test('no-action structured result must contain a reason and no reply text', () => {
  expect(validateDraftResult({
    status: 'no_action',
    scenario: 'freeform',
    reply_body: '',
    requires_human_approval: true,
    confidence: 0.9,
    warnings: [],
    facts_used: [],
    block_reason: 'The buyer only acknowledged the previous answer.',
  }, 'freeform')).toMatchObject({
    status: 'no_action',
    reply_body: '',
  });

  expect(() => validateDraftResult({
    status: 'no_action',
    scenario: 'freeform',
    reply_body: 'You are welcome!',
    requires_human_approval: true,
    confidence: 0.9,
    warnings: [],
    facts_used: [],
    block_reason: 'No reply is needed.',
  }, 'freeform')).toThrow(
    'Message agent returned reply text for a non-ready result',
  );
});

const ENV_KEYS = [
  'NODE_ENV',
  'HOST',
  'ETSY_SHOP_ID',
  'SITE_PASSWORD',
  'SESSION_SECRET',
  'AUTH_USERS_B64',
  'ETSY_MESSAGES_BRIDGE_URL',
  'ETSY_MESSAGES_BRIDGE_TOKEN',
  'ETSY_MESSAGES_BRIDGE_APPROVAL_TOKEN',
  'MESSAGE_ORDER_LINKING_ENABLED',
  'MESSAGE_AUTO_TRIGGERS_ENABLED',
  'MESSAGE_TRIGGER_RUNNER_ENABLED',
  'MESSAGE_EVENT_INGEST_TOKEN',
  'MESSAGE_TRIGGER_STATE_FILE',
  'ORDER_CONTEXT_API_URL',
  'ORDER_CONTEXT_API_TOKEN',
  'ORDER_CONTEXT_API_TIMEOUT_MS',
  'MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED',
  'MESSAGE_APPROVER_USER_IDS',
  'MESSAGE_PLAYBOOK_FILE',
  'MESSAGE_AUTOMATION_POLICY_FILE',
];

async function withEnv(values, operation) {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined && value !== null) process.env[key] = String(value);
  }
  try {
    return await operation();
  } finally {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

test('message automation policy stays draft-only and uses revision checks', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-message-policy-'));
  const file = path.join(directory, 'policies.json');
  await withEnv({ MESSAGE_AUTOMATION_POLICY_FILE: file }, async () => {
    const initial = await loadMessageAutomationPolicy('12345678');
    expect(initial).toMatchObject({
      revision: 0,
      policy: {
        enabled: false,
        delivery_mode: 'draft_only',
        human_approval_required: true,
      },
    });

    const saved = await saveMessageAutomationPolicy('12345678', {
      enabled: true,
      delivery_mode: 'automatic_send',
      human_approval_required: false,
      rules: [{
        id: 'new-message',
        enabled: true,
        event: 'new_message',
        scenario: 'freeform',
        delay_minutes: 2,
        cooldown_minutes: 30,
      }],
    }, { expectedRevision: 0, updatedBy: 'agent:test' });

    expect(saved.revision).toBe(1);
    expect(saved.policy.delivery_mode).toBe('draft_only');
    expect(saved.policy.human_approval_required).toBe(true);
    expect(saved.policy.rules[0]).toMatchObject({
      id: 'new-message',
      event: 'new_message',
      delay_minutes: 2,
      cooldown_minutes: 30,
    });
    await expect(saveMessageAutomationPolicy('12345678', saved.policy, {
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: 'MESSAGE_AUTOMATION_REVISION_CONFLICT' });
  });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('message automation normalization drops unknown events and scenarios', () => {
  const policy = normalizeMessageAutomationPolicy({
    enabled: true,
    rules: [
      { event: 'unknown', scenario: 'freeform' },
      { event: 'new_message', scenario: 'unknown' },
    ],
  });
  expect(policy.rules).toEqual([]);
});

function jsonResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
      return this;
    },
    end(value) {
      this.body = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

function request(method, body = {}, query = {}) {
  return {
    method,
    body,
    query,
    headers: {},
  };
}

function developmentBridgeEnv(extra = {}) {
  return {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    ETSY_MESSAGES_BRIDGE_URL: 'http://bridge.test',
    ETSY_MESSAGES_BRIDGE_TOKEN: 'test-bridge-token',
    ETSY_MESSAGES_BRIDGE_APPROVAL_TOKEN: 'test-approval-token',
    ...extra,
  };
}

test('automation config keeps order linking and the draft runner behind independent release gates', async () => {
  await withEnv(developmentBridgeEnv({
    MESSAGE_ORDER_LINKING_ENABLED: 'false',
    MESSAGE_AUTO_TRIGGERS_ENABLED: 'true',
    MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
  }), async () => {
    expect(messageAutomationConfig()).toMatchObject({
      bridge_configured: true,
      order_linking_configured: false,
      order_linking_enabled: false,
      order_context_configured: false,
      automatic_triggers_configured: true,
      automatic_triggers_enabled: false,
      automatic_trigger_runtime: 'draft_only_available',
      trigger_runner_enabled: false,
      telegram_notifications_enabled: true,
    });
  });
});

test('messages backend saves automation rules and returns live runner status shape', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-message-automation-api-'));
  try {
    await withEnv(developmentBridgeEnv({
      MESSAGE_AUTOMATION_POLICY_FILE: path.join(directory, 'policies.json'),
      MESSAGE_TRIGGER_STATE_FILE: path.join(directory, 'trigger-state.json'),
      MESSAGE_AUTO_TRIGGERS_ENABLED: 'true',
      MESSAGE_TRIGGER_RUNNER_ENABLED: 'false',
      ETSY_SHOP_ID: '12345678',
    }), async () => {
      const saveRes = jsonResponse();
      await messagesHandler(request('POST', {
        action: 'saveAutomationPolicy',
        expected_revision: 0,
        policy: {
          enabled: true,
          delivery_mode: 'automatic_send',
          human_approval_required: false,
          rules: [{
            id: 'files-question',
            label: 'File upload question',
            enabled: true,
            event: 'new_message',
            scenario: 'how_to_send_files',
            delay_minutes: 1,
            cooldown_minutes: 120,
            conditions: 'Buyer asks how to send files.',
          }],
        },
      }), saveRes);
      expect(saveRes.body.data).toMatchObject({
        revision: 1,
        policy: {
          enabled: true,
          delivery_mode: 'draft_only',
          human_approval_required: true,
        },
      });

      const statusRes = jsonResponse();
      await messagesHandler(request('GET', {}, {
        action: 'getAutomationStatus',
      }), statusRes);
      expect(statusRes.body.data).toMatchObject({
        runtime: {
          implemented: true,
          enabled: false,
          worker_state: 'PAUSED',
          delivery_mode: 'draft_only',
          human_approval_required: true,
        },
        policy: {
          revision: 1,
          policy: {
            enabled: true,
            rules: [expect.objectContaining({ id: 'files-question' })],
          },
        },
        recent_events: [],
      });
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('automation status separates configured intent from the draft-only runner release gate', async () => {
  await withEnv(developmentBridgeEnv({
    MESSAGE_ORDER_LINKING_ENABLED: 'true',
    MESSAGE_AUTO_TRIGGERS_ENABLED: 'true',
  }), async () => {
    expect(messageAutomationConfig()).toMatchObject({
      order_linking_configured: true,
      order_linking_enabled: false,
      automatic_triggers_configured: true,
      automatic_triggers_enabled: false,
      automatic_trigger_runtime: 'draft_only_available',
      trigger_runner_enabled: false,
    });
  });
});

test('draft-only trigger runner requires both configuration intent and its release gate', async () => {
  await withEnv(developmentBridgeEnv({
    MESSAGE_AUTO_TRIGGERS_ENABLED: 'true',
    MESSAGE_TRIGGER_RUNNER_ENABLED: 'true',
    MESSAGE_EVENT_INGEST_TOKEN: 'event-test-token-12345678901234567',
  }), async () => {
    expect(messageAutomationConfig()).toMatchObject({
      automatic_triggers_configured: true,
      automatic_triggers_enabled: true,
      automatic_trigger_runtime: 'draft_only_available',
      trigger_runner_enabled: true,
      event_ingest_configured: true,
    });
  });
});

test('order linking is released only with exact-context configuration', async () => {
  await withEnv(developmentBridgeEnv({
    MESSAGE_ORDER_LINKING_ENABLED: 'true',
    ORDER_CONTEXT_API_URL: 'https://orders.internal.test',
    ORDER_CONTEXT_API_TOKEN: 'x'.repeat(32),
  }), async () => {
    expect(messageAutomationConfig()).toMatchObject({
      order_linking_configured: true,
      order_context_configured: true,
      order_linking_enabled: true,
    });
  });
});

test('agent conversation reader paginates the full local history and deduplicates source IDs', async () => {
  const originalFetch = global.fetch;
  const requestedCursors = [];
  global.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/conversations/9001') {
      return Response.json({ source_id: '9001', participant: 'Buyer' });
    }
    const cursor = Number(parsed.searchParams.get('cursor') || 0);
    requestedCursors.push(cursor);
    if (cursor === 0) {
      return Response.json({
        items: [
          { source_id: 'm1', body: 'First' },
          { source_id: 'm2', body: 'Old copy' },
        ],
        next_cursor: 2,
      });
    }
    return Response.json({
      items: [
        { source_id: 'm2', body: 'Updated copy' },
        { source_id: 'm3', body: 'Newest' },
      ],
      next_cursor: null,
    });
  };
  try {
    await withEnv(developmentBridgeEnv(), async () => {
      const result = await getMessageConversationForAgent('9001');
      expect(requestedCursors).toEqual([0, 2]);
      expect(result.messages).toEqual([
        { source_id: 'm1', body: 'First' },
        { source_id: 'm2', body: 'Updated copy' },
        { source_id: 'm3', body: 'Newest' },
      ]);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('agent cannot create an order-dependent draft while verified order linking is disabled', async () => {
  await withEnv(developmentBridgeEnv({
    MESSAGE_ORDER_LINKING_ENABLED: 'false',
  }), async () => {
    await expect(prepareMessageDraftForAgent({
      conversation_id: '9001',
      shop_id: '12345678',
      scenario: 'missing_materials',
      body: 'Please send the files.',
    }, 'owner-1', 'request-1')).rejects.toMatchObject({
      code: 'MESSAGE_ORDER_CONTEXT_DISABLED',
    });
  });
});

test('agent how-to-order draft uses the same exact-listing safety gate', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-order-agent-'));
  const playbookFile = path.join(directory, 'playbooks.json');
  await withEnv(developmentBridgeEnv({
    MESSAGE_PLAYBOOK_FILE: playbookFile,
  }), async () => {
    const baseDependencies = {
      loadConversation: async () => ({
        conversation: {
          source_id: '9001',
          listing_refs: [],
        },
        messages: [],
      }),
      loadListingFacts: async () => ({
        listing: null,
        unavailable_reason: 'No exact Etsy inline listing reference is cached',
      }),
      postDraft: async () => {
        throw new Error('Unsafe draft must not reach Bridge');
      },
    };
    await expect(prepareMessageDraftForAgent({
      conversation_id: '9001',
      shop_id: '12345678',
      scenario: 'how_to_order',
      body: 'Choose the Premium listing for $50.',
    }, 'owner-1', 'request-1', baseDependencies)).rejects.toMatchObject({
      code: 'MESSAGE_DRAFT_UNVERIFIED_PRICE_CLAIM',
      status: 409,
    });

    let posted;
    const safe = await prepareMessageDraftForAgent({
      conversation_id: '9001',
      shop_id: '12345678',
      scenario: 'how_to_order',
      body: 'Which product and number of people would you like to order?',
    }, 'owner-1', 'request-2', {
      ...baseDependencies,
      postDraft: async (pathname, payload, headers) => {
        posted = { pathname, payload, headers };
        return { id: 'draft-safe' };
      },
    });

    expect(safe).toEqual({ id: 'draft-safe' });
    expect(posted).toMatchObject({
      pathname: '/v1/outbox/drafts',
      payload: {
        scenario: 'how_to_order',
        submit_for_approval: true,
        metadata: {
          generator: 'dashboard_internal_agent',
          listing_context: {
            listing_id: null,
            exact_reference_available: false,
          },
        },
      },
    });
  });
});

test('playbook persistence normalizes immutable scenario safety and rejects stale revisions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-message-playbook-'));
  const file = path.join(directory, 'playbooks.json');
  try {
    await withEnv({ MESSAGE_PLAYBOOK_FILE: file }, async () => {
      const initial = await loadMessagePlaybook('12345678');
      expect(initial.revision).toBe(0);
      expect(initial.playbook.scenarios.review_request.enabled).toBe(false);

      const saved = await saveMessagePlaybook('12345678', {
        tone: { summary: 'Friendly and direct.' },
        hard_rules: ['Use verified facts only.'],
        avoid_phrases: ['guaranteed'],
        scenarios: {
          missing_materials: {
            enabled: true,
            requires_order_context: false,
            instructions: 'Ask only for the verified missing files.',
          },
        },
        examples: [{
          scenario: 'missing_materials',
          customer_message: 'What do you need?',
          ideal_reply: 'Please send the two verified missing photos.',
        }],
      }, {
        expectedRevision: 0,
        updatedBy: 'owner-1',
      });

      expect(saved.revision).toBe(1);
      expect(saved.updated_by).toBe('owner-1');
      expect(saved.playbook.scenarios.missing_materials.requires_order_context).toBe(true);
      expect(saved.playbook.examples).toHaveLength(1);

      const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(persisted.shops['12345678'].playbook.tone.summary).toBe(
        'Friendly and direct.',
      );

      await expect(saveMessagePlaybook('12345678', saved.playbook, {
        expectedRevision: 0,
        updatedBy: 'stale-editor',
      })).rejects.toMatchObject({
        status: 409,
        code: 'MESSAGE_PLAYBOOK_REVISION_CONFLICT',
      });
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('playbook normalization cannot enable unknown scenarios or retain empty examples', () => {
  const normalized = normalizeMessagePlaybook({
    scenarios: {
      unknown_dangerous_action: {
        enabled: true,
        requires_order_context: false,
        instructions: 'Send immediately.',
      },
    },
    examples: [
      { scenario: 'freeform', customer_message: '', ideal_reply: 'No source.' },
      { scenario: 'unknown', customer_message: 'Hi', ideal_reply: 'Hello' },
    ],
  });

  expect(normalized.scenarios.unknown_dangerous_action).toBeUndefined();
  expect(normalized.examples).toEqual([
    expect.objectContaining({
      scenario: 'freeform',
      customer_message: 'Hi',
      ideal_reply: 'Hello',
    }),
  ]);
});

test('reserve account blocks order-dependent live drafts before conversation or AI access', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      account: { label: 'reserve-shop', mode: 'reserve' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withEnv(developmentBridgeEnv({
      MESSAGE_ORDER_LINKING_ENABLED: 'true',
      MESSAGE_AUTO_TRIGGERS_ENABLED: 'true',
    }), async () => {
      const req = request('POST', {
        action: 'generateDraft',
        shop_id: '12345678',
        conversation_id: '1250240141',
        scenario: 'missing_materials',
      });
      const res = jsonResponse();

      await expect(messagesHandler(req, res)).rejects.toMatchObject({
        status: 409,
        code: 'MESSAGE_ORDER_CONTEXT_DISABLED',
      });
      expect(calls).toEqual(['http://bridge.test/v1/status']);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('agent file guidance requires one exact verified paid Etsy order', async () => {
  await withEnv(developmentBridgeEnv({
    MESSAGE_ORDER_LINKING_ENABLED: 'true',
    ORDER_CONTEXT_API_URL: 'https://orders.internal.test',
    ORDER_CONTEXT_API_TOKEN: 'x'.repeat(32),
  }), async () => {
    const baseInput = {
      conversation_id: '9001',
      shop_id: '12345678',
      scenario: 'how_to_send_files',
      source_message_id: 'buyer-files-1',
      body: 'Hi, yes, you can attach the photos here in this Etsy conversation.',
    };
    await expect(prepareMessageDraftForAgent(
      baseInput,
      'owner-1',
      'request-files-1',
      {
        loadConversation: async () => ({
          source_id: '9001',
          receipt_ids: [],
          messages: [],
        }),
      },
    )).rejects.toMatchObject({
      code: 'MESSAGE_VERIFIED_PAID_ORDER_REQUIRED',
      status: 409,
    });

    let posted;
    const created = await prepareMessageDraftForAgent(
      baseInput,
      'owner-1',
      'request-files-2',
      {
        loadConversation: async () => ({
          source_id: '9001',
          receipt_ids: ['4053136295'],
          messages: [{
            source_id: 'buyer-files-1',
            direction: 'incoming',
            sender: 'Buyer',
            body: 'Can I send the photos here?',
          }],
        }),
        loadOrderFacts: async () => ({
          order: {
            linked: true,
            paid: true,
            receipt_id: '4053136295',
            checked_at: '2026-07-28T08:00:00.000Z',
          },
        }),
        postDraft: async (pathname, payload) => {
          posted = { pathname, payload };
          return { id: 'paid-files-draft' };
        },
      },
    );
    expect(created).toEqual({ id: 'paid-files-draft' });
    expect(posted).toMatchObject({
      pathname: '/v1/outbox/drafts',
      payload: {
        scenario: 'how_to_send_files',
        metadata: {
          order_context: {
            receipt_id: '4053136295',
            paid: true,
          },
        },
      },
    });
  });
});

test('conversation preview refreshes the exact thread and returns no-action without AI or queue writes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-message-preview-'));
  const playbookFile = path.join(directory, 'playbooks.json');
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
    });
    if (parsed.pathname.endsWith('/status')) {
      return new Response(JSON.stringify({
        account: { label: 'main-shop', mode: 'production' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (parsed.pathname.endsWith('/history/sync')) {
      return new Response(JSON.stringify({
        status: 'OK',
        mode: 'conversation_recent',
        coverage: { reached_history_tail: true, overlap_found: true },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (parsed.pathname.endsWith('/messages')) {
      return new Response(JSON.stringify({
        items: [{
          source_id: 'buyer-old',
          direction: 'incoming',
          sender: 'buyer-id',
          sent_at: '2026-07-28T10:00:00Z',
          body: 'Old buyer question',
        }, {
          source_id: 'shop-newest',
          direction: 'outgoing',
          sender: 'self',
          sent_at: '2026-07-28T10:05:00Z',
          body: 'Already answered',
        }],
        next_cursor: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      source_id: '1250240141',
      participant: 'Buyer',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await withEnv(developmentBridgeEnv({
      ETSY_SHOP_ID: '12345678',
      MESSAGE_PLAYBOOK_FILE: playbookFile,
    }), async () => {
      const res = jsonResponse();
      await messagesHandler(request('POST', {
        action: 'previewDraft',
        conversation_id: '1250240141',
        scenario: 'freeform',
      }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({
        status: 'no_action',
        preview_only: true,
        queued: false,
        sent: false,
        block_reason: 'The newest authored message is already a shop reply',
        conversation_check: {
          no_action: true,
          code: 'MESSAGE_DRAFT_ALREADY_ANSWERED',
        },
      });
      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: '/v1/conversations/1250240141/history/sync?wait=true&full=false',
          method: 'POST',
        }),
      ]));
      expect(calls.some(call => call.path.includes('/v1/outbox/drafts'))).toBe(false);
    });
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('approval draft generation fails closed when refreshed conversation is already answered', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
    });
    if (parsed.pathname.endsWith('/status')) {
      return new Response(JSON.stringify({
        account: { label: 'main-shop', mode: 'production' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (parsed.pathname.endsWith('/history/sync')) {
      return new Response(JSON.stringify({ status: 'OK' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (parsed.pathname.endsWith('/messages')) {
      return new Response(JSON.stringify({
        items: [{
          source_id: 'buyer-old',
          direction: 'incoming',
          sent_at: '2026-07-28T10:00:00Z',
        }, {
          source_id: 'shop-newest',
          direction: 'outgoing',
          sent_at: '2026-07-28T10:05:00Z',
        }],
        next_cursor: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      source_id: '1250240141',
      participant: 'Buyer',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await withEnv(developmentBridgeEnv(), async () => {
      await expect(messagesHandler(request('POST', {
        action: 'generateDraft',
        conversation_id: '1250240141',
        scenario: 'freeform',
      }), jsonResponse())).rejects.toMatchObject({
        status: 409,
        code: 'MESSAGE_DRAFT_ALREADY_ANSWERED',
      });
      expect(calls.some(call => call.path.includes('/v1/outbox/drafts'))).toBe(false);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('manual freeform draft is allowed on reserve account but only enters approval outbox', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null,
      headers: options.headers || {},
    };
    calls.push(call);
    if (call.url.endsWith('/v1/status')) {
      return new Response(JSON.stringify({
        account: { label: 'reserve-shop', mode: 'reserve' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      id: 41,
      status: 'AWAITING_APPROVAL',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withEnv(developmentBridgeEnv(), async () => {
      const req = request('POST', {
        action: 'createManualDraft',
        shop_id: '12345678',
        conversation_id: '1250240141',
        scenario: 'freeform',
        body: 'Thanks for your message.',
        client_request_id: 'manual-one',
      });
      const res = jsonResponse();
      await messagesHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.body.data.status).toBe('AWAITING_APPROVAL');
      expect(calls.map(call => call.url)).toEqual([
        'http://bridge.test/v1/status',
        'http://bridge.test/v1/outbox/drafts',
      ]);
      expect(calls[1].body).toMatchObject({
        conversation_id: '1250240141',
        body: 'Thanks for your message.',
        scenario: 'freeform',
        created_by: 'local-dev',
        submit_for_approval: true,
      });
      expect(calls[1].headers['Idempotency-Key']).toBe(
        'dashboard-draft-manual-one',
      );
      expect(calls.some(call => call.url.endsWith('/send'))).toBe(false);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('attachment proxy keeps the Bridge token server-side and returns only allowed local content', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '4',
      },
    });
  };

  try {
    await withEnv(developmentBridgeEnv(), async () => {
      const direct = await bridgeBinaryRequest('/v1/attachments/42/content');
      expect(direct.mimeType).toBe('image/png');
      expect([...direct.body]).toEqual([0x89, 0x50, 0x4e, 0x47]);

      const res = jsonResponse();
      await messagesHandler(request('GET', {}, {
        action: 'getAttachment',
        attachment_id: '42',
      }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers).toMatchObject({
        'content-type': 'image/png',
        'content-disposition': 'inline; filename="etsy-attachment-42.png"',
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      });
      expect([...res.body]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(calls).toHaveLength(2);
      expect(calls[1].url).toBe('http://bridge.test/v1/attachments/42/content');
      expect(calls[1].options.headers.Authorization).toBe('Bearer test-bridge-token');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('attachment proxy rejects unsupported MIME and invalid IDs', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('<html>not an attachment</html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
  try {
    await withEnv(developmentBridgeEnv(), async () => {
      await expect(bridgeBinaryRequest('/v1/attachments/42/content')).rejects.toMatchObject({
        status: 502,
        code: 'MESSAGE_ATTACHMENT_UNSUPPORTED',
      });
      await expect(messagesHandler(request('GET', {}, {
        action: 'getAttachment',
        attachment_id: '../42',
      }), jsonResponse())).rejects.toMatchObject({ status: 400 });
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('conversation BFF preserves attachments and normalizes only explicit message direction', async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    if (String(url).endsWith('/messages?limit=500&cursor=0')) {
      return new Response(JSON.stringify({
        items: [{
          id: 1,
          source_id: 'm1',
          sender: '123456789',
          direction: 'outbound',
          body: 'Seller message',
          attachments: [{
            id: 42,
            filename: 'portrait.png',
            mime_type: 'image/png',
            local_path: true,
          }],
        }, {
          id: 2,
          source_id: 'm2',
          sender: '987654321',
          body: 'Numeric sender without direction',
          attachments: [],
        }, {
          id: 3,
          source_id: 'm3',
          sender: 'self',
          body: 'DOM-classified seller message',
          attachments: [],
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      id: '1250240141',
      source_id: '1250240141',
      participant: 'Buyer',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withEnv(developmentBridgeEnv(), async () => {
      const res = jsonResponse();
      await messagesHandler(request('GET', {}, {
        action: 'getConversation',
        conversation_id: '1250240141',
      }), res);
      expect(res.body.data.messages.map(message => message.direction)).toEqual([
        'outgoing',
        'unknown',
        'outgoing',
      ]);
      expect(res.body.data.messages[0].attachments[0]).toMatchObject({
        id: 42,
        filename: 'portrait.png',
        local_path: true,
      });
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('conversation BFF loads every cached message page from the Bridge', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async url => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname + parsed.search);
    if (parsed.pathname.endsWith('/messages')) {
      const cursor = Number(parsed.searchParams.get('cursor') || 0);
      const items = cursor === 0
        ? Array.from({ length: 500 }, (_, index) => ({
          id: index + 1,
          source_id: `m${index + 1}`,
          direction: index % 2 ? 'outgoing' : 'incoming',
        }))
        : [{ id: 501, source_id: 'm501', direction: 'incoming' }];
      return new Response(JSON.stringify({
        items,
        next_cursor: cursor === 0 ? 500 : null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      id: '1250240141',
      source_id: '1250240141',
      participant: 'Buyer',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withEnv(developmentBridgeEnv(), async () => {
      const res = jsonResponse();
      await messagesHandler(request('GET', {}, {
        action: 'getConversation',
        conversation_id: '1250240141',
      }), res);
      expect(res.body.data.messages).toHaveLength(501);
      expect(res.body.data.messages.at(-1)).toMatchObject({
        source_id: 'm501',
        direction: 'incoming',
      });
      expect(calls.filter(url => url.includes('/messages?'))).toEqual([
        '/v1/conversations/1250240141/messages?limit=500&cursor=0',
        '/v1/conversations/1250240141/messages?limit=500&cursor=500',
      ]);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('syncInbox refreshes the lightweight index and returns only the first bounded page', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).includes('/v1/inbox/index/sync?')) {
      return new Response(JSON.stringify({ status: 'OK', mode: 'inbox_index' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const items = Array.from({ length: 50 }, (_, index) => ({
        id: index + 1,
        source_id: index === 0 ? '1250240141' : String(2_000_000_000 + index),
      }));
    return new Response(JSON.stringify({
      items,
      next_cursor: 50,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withEnv(developmentBridgeEnv(), async () => {
      const req = request('POST', {
        action: 'syncInbox',
        needs_attention: 'true',
      });
      const res = jsonResponse();
      await messagesHandler(req, res);

      expect(res.body.data.sync).toMatchObject({ status: 'OK', mode: 'inbox_index' });
      expect(res.body.data.conversations.items[0]).toMatchObject({
        id: 1,
        source_id: '1250240141',
      });
      expect(res.body.data.conversations.items).toHaveLength(50);
      expect(res.body.data.conversations.next_cursor).toBe(50);
      expect(calls).toEqual([
        {
          url: 'http://bridge.test/v1/inbox/index/sync?wait=true',
          method: 'POST',
        },
        {
          url: 'http://bridge.test/v1/conversations?needs_attention=true&limit=50&cursor=0',
          method: 'GET',
        },
      ]);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('approveDraft records the authenticated actor and never sends', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({
      url: target,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null,
      headers: options.headers || {},
    });
    let payload;
    if (target.endsWith('/v1/outbox/drafts/9')) {
      payload = {
        id: 9,
        status: 'AWAITING_APPROVAL',
        conversation_source_id: '1250240141',
        created_at: '2026-07-28T10:00:00Z',
        metadata: { source_message_id: 'message-1' },
      };
    } else if (target.includes('/history/sync')) {
      payload = { status: 'OK' };
    } else if (target.endsWith('/v1/conversations/1250240141')) {
      payload = { source_id: '1250240141', participant: 'Buyer' };
    } else if (target.includes('/messages?')) {
      payload = {
        items: [{
          source_id: 'message-1',
          direction: 'INCOMING',
          sender: 'buyer',
          body: 'Question',
          sent_at: '2026-07-28T09:00:00Z',
        }],
        next_cursor: null,
      };
    } else {
      payload = { id: 9, status: 'APPROVED' };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withEnv(developmentBridgeEnv(), async () => {
      const req = request('POST', {
        action: 'approveDraft',
        draft_id: '9',
        approved_by: 'forged-browser-user',
        body: 'Exact edited text',
      });
      const res = jsonResponse();
      await messagesHandler(req, res);

      expect(res.body.data.status).toBe('APPROVED');
      expect(calls.at(-1)).toEqual({
        url: 'http://bridge.test/v1/outbox/drafts/9/approve',
        method: 'POST',
        body: {
          approved_by: 'local-dev',
          body: 'Exact edited text',
        },
        headers: expect.objectContaining({
          Authorization: 'Bearer test-bridge-token',
          'X-Bridge-Approval-Token': 'test-approval-token',
        }),
      });
      expect(calls.map(call => call.url)).toEqual([
        'http://bridge.test/v1/outbox/drafts/9',
        'http://bridge.test/v1/conversations/1250240141/history/sync?wait=true&full=false',
        'http://bridge.test/v1/conversations/1250240141',
        'http://bridge.test/v1/conversations/1250240141/messages?limit=500&cursor=0',
        'http://bridge.test/v1/outbox/drafts/9/approve',
      ]);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('approveDraft rejects an explicitly empty edited body before Bridge access', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await withEnv(developmentBridgeEnv(), async () => {
      const res = jsonResponse();
      await messagesHandler(request('POST', {
        action: 'approveDraft',
        draft_id: '9',
        body: '   ',
      }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Approved message text is required');
      expect(calls).toEqual([]);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('draft freshness check skips a draft after a newer Etsy shop reply', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({
      url: target,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null,
    });
    let payload;
    if (target.endsWith('/v1/outbox/drafts/9')) {
      payload = {
        id: 9,
        status: 'AWAITING_APPROVAL',
        conversation_source_id: '1250240141',
        created_at: '2026-07-28T10:00:00Z',
        metadata: { source_message_id: 'buyer-message-1' },
      };
    } else if (target.includes('/history/sync')) {
      payload = { status: 'OK' };
    } else if (target.endsWith('/v1/conversations/1250240141')) {
      payload = { source_id: '1250240141', participant: 'Buyer' };
    } else if (target.includes('/messages?')) {
      payload = {
        items: [{
          source_id: 'buyer-message-1',
          direction: 'INCOMING',
          sender: 'buyer',
          body: 'Question',
          sent_at: '2026-07-28T09:00:00Z',
        }, {
          source_id: 'shop-message-2',
          direction: 'OUTGOING',
          sender: 'self',
          body: 'Answered directly on Etsy',
          sent_at: '2026-07-28T11:00:00Z',
        }],
        next_cursor: null,
      };
    } else if (target.endsWith('/skip')) {
      payload = { id: 9, status: 'SKIPPED' };
    } else {
      payload = {};
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withEnv(developmentBridgeEnv(), async () => {
      const res = jsonResponse();
      await messagesHandler(request('POST', {
        action: 'refreshDraftForReview',
        draft_id: '9',
      }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({
        draft: { id: 9, status: 'SKIPPED' },
        freshness: {
          current: false,
          stale: true,
          code: 'MESSAGE_DRAFT_ALREADY_ANSWERED',
          baseline_source_message_id: 'buyer-message-1',
          current_source_message_id: 'shop-message-2',
        },
      });
      expect(calls.at(-1)).toMatchObject({
        url: 'http://bridge.test/v1/outbox/drafts/9/skip',
        method: 'POST',
        body: {
          actor: 'local-dev',
          reason: 'The newest authored message is already a shop reply',
        },
      });
      expect(calls.some(call => call.url.endsWith('/approve'))).toBe(false);
      expect(calls.some(call => call.url.endsWith('/send'))).toBe(false);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('sendApprovedDraft is a separate explicit action and approver allowlist fails closed', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({
      url: target,
      method: options.method || 'GET',
      headers: options.headers || {},
    });
    let payload;
    if (target.endsWith('/v1/outbox/drafts/9')) {
      payload = {
        id: 9,
        status: 'APPROVED',
        conversation_source_id: '1250240141',
        created_at: '2026-07-28T10:00:00Z',
        metadata: { source_message_id: 'message-1' },
      };
    } else if (target.includes('/history/sync')) {
      payload = { status: 'OK' };
    } else if (target.endsWith('/v1/conversations/1250240141')) {
      payload = { source_id: '1250240141', participant: 'Buyer' };
    } else if (target.includes('/messages?')) {
      payload = {
        items: [{
          source_id: 'message-1',
          direction: 'INCOMING',
          sender: 'buyer',
          body: 'Question',
          sent_at: '2026-07-28T09:00:00Z',
        }],
        next_cursor: null,
      };
    } else {
      payload = { id: 9, status: 'SENT' };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withEnv(developmentBridgeEnv({
      MESSAGE_APPROVER_USER_IDS: 'owner-only',
    }), async () => {
      const deniedReq = request('POST', {
        action: 'sendApprovedDraft',
        draft_id: '9',
      });
      await expect(messagesHandler(deniedReq, jsonResponse())).rejects.toMatchObject({
        status: 403,
        code: 'MESSAGE_APPROVER_REQUIRED',
      });
      expect(calls).toEqual([]);
    });

    await withEnv(developmentBridgeEnv(), async () => {
      const req = request('POST', {
        action: 'sendApprovedDraft',
        draft_id: '9',
      });
      const res = jsonResponse();
      await messagesHandler(req, res);

      expect(res.body.data.status).toBe('SENT');
      expect(calls.at(-1)).toEqual({
        url: 'http://bridge.test/v1/outbox/drafts/9/send',
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-bridge-token',
          'X-Bridge-Approval-Token': 'test-approval-token',
        }),
      });
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('operator skip and block actions reconcile matching trigger candidates', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-message-reconcile-api-'));
  const stateFile = path.join(directory, 'trigger-state.json');
  const baseCandidate = {
    event_id: 'event-1',
    rule_id: 'rule-1',
    event: 'new_message',
    scenario: 'freeform',
    shop_id: '12345678',
    conversation_id: '1250240141',
    status: 'AWAITING_APPROVAL',
    due_at: '2026-07-28T08:00:00.000Z',
    attempts: 1,
    created_at: '2026-07-28T08:00:00.000Z',
    updated_at: '2026-07-28T08:00:00.000Z',
  };
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    events: {},
    candidates: {
      skip: { ...baseCandidate, id: 'skip', draft_id: '81' },
      block: { ...baseCandidate, id: 'block', draft_id: '82' },
    },
  }));
  const originalFetch = global.fetch;
  global.fetch = async url => {
    const id = String(url).includes('/81/') ? 81 : 82;
    return new Response(JSON.stringify({
      id,
      status: id === 81 ? 'SKIPPED' : 'BLOCKED',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withEnv(developmentBridgeEnv({
      MESSAGE_TRIGGER_STATE_FILE: stateFile,
    }), async () => {
      const skipped = jsonResponse();
      await messagesHandler(request('POST', {
        action: 'skipDraft',
        draft_id: '81',
        reason: 'No response needed',
      }), skipped);
      expect(skipped.body).toMatchObject({
        success: true,
        data: { id: 81, status: 'SKIPPED' },
        trigger_reconciliation: { status: 'RECONCILED', matched: 1 },
      });

      const blocked = jsonResponse();
      await messagesHandler(request('POST', {
        action: 'blockDraft',
        draft_id: '82',
        reason: 'Needs manual context',
      }), blocked);
      expect(blocked.body).toMatchObject({
        success: true,
        data: { id: 82, status: 'BLOCKED' },
        trigger_reconciliation: { status: 'RECONCILED', matched: 1 },
      });
    });

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(saved.candidates.skip).toMatchObject({
      status: 'SKIPPED',
      draft_status: 'SKIPPED',
      draft_resolution_history: [
        expect.objectContaining({
          action: 'skipDraft',
          reason: 'No response needed',
        }),
      ],
    });
    expect(saved.candidates.block).toMatchObject({
      status: 'BLOCKED',
      draft_status: 'BLOCKED',
      draft_resolution_history: [
        expect.objectContaining({
          action: 'blockDraft',
          reason: 'Needs manual context',
        }),
      ],
    });
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('successful Bridge action remains successful when trigger reconciliation fails closed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-message-reconcile-error-'));
  const stateFile = path.join(directory, 'trigger-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    events: {},
    candidates: {
      candidate: {
        id: 'candidate',
        event_id: 'event-1',
        rule_id: 'rule-1',
        event: 'new_message',
        scenario: 'freeform',
        shop_id: '12345678',
        conversation_id: '1250240141',
        status: 'AWAITING_APPROVAL',
        draft_id: '83',
        due_at: '2026-07-28T08:00:00.000Z',
        attempts: 1,
        created_at: '2026-07-28T08:00:00.000Z',
        updated_at: '2026-07-28T08:00:00.000Z',
      },
    },
  }));
  const originalFetch = global.fetch;
  const originalError = console.error;
  const warnings = [];
  global.fetch = async url => {
    const target = String(url);
    let payload;
    if (target.endsWith('/v1/outbox/drafts/83')) {
      payload = {
        id: 83,
        status: 'APPROVED',
        conversation_source_id: '1250240141',
        created_at: '2026-07-28T10:00:00Z',
        metadata: { source_message_id: 'message-1' },
      };
    } else if (target.includes('/history/sync')) {
      payload = { status: 'OK' };
    } else if (target.endsWith('/v1/conversations/1250240141')) {
      payload = { source_id: '1250240141' };
    } else if (target.includes('/messages?')) {
      payload = {
        items: [{
          source_id: 'message-1',
          direction: 'INCOMING',
          sender: 'buyer',
          body: 'Question',
          sent_at: '2026-07-28T09:00:00Z',
        }],
        next_cursor: null,
      };
    } else {
      payload = { id: 83, status: 'APPROVED' };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  console.error = (...args) => warnings.push(args);

  try {
    await withEnv(developmentBridgeEnv({
      MESSAGE_TRIGGER_STATE_FILE: stateFile,
    }), async () => {
      const res = jsonResponse();
      await messagesHandler(request('POST', {
        action: 'sendApprovedDraft',
        draft_id: '83',
      }), res);
      expect(res.body).toMatchObject({
        success: true,
        data: { id: 83, status: 'APPROVED' },
        trigger_reconciliation: {
          status: 'ERROR',
          matched: 0,
          error_code: 'MESSAGE_TRIGGER_DRAFT_STATUS_MISMATCH',
        },
      });
    });
    expect(warnings).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(saved.candidates.candidate).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: '83',
    });
    expect(saved.candidates.candidate.draft_resolution_history).toBeUndefined();
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('approveAndSendDraft refreshes twice, sends once, and is idempotent after SENT', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let draftStatus = 'AWAITING_APPROVAL';
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({
      url: target,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null,
      headers: options.headers || {},
    });
    let payload;
    if (target.endsWith('/v1/outbox/drafts/19')) {
      payload = {
        id: 19,
        status: draftStatus,
        conversation_source_id: '1250240141',
        body: 'Exact answer',
        created_at: '2026-07-28T10:00:00Z',
        metadata: { source_message_id: 'buyer-message-1' },
      };
    } else if (target.includes('/history/sync')) {
      payload = { status: 'OK', mode: 'conversation_overlap' };
    } else if (target.endsWith('/v1/conversations/1250240141')) {
      payload = { source_id: '1250240141', participant: 'Buyer' };
    } else if (target.includes('/messages?')) {
      payload = {
        items: [{
          source_id: 'buyer-message-1',
          direction: 'INCOMING',
          sender: 'buyer',
          body: 'Question',
          sent_at: '2026-07-28T09:00:00Z',
        }],
        next_cursor: null,
      };
    } else if (target.endsWith('/approve')) {
      draftStatus = 'APPROVED';
      payload = {
        id: 19,
        status: 'APPROVED',
        conversation_source_id: '1250240141',
        body: 'Exact answer',
      };
    } else if (target.endsWith('/send')) {
      draftStatus = 'SENT';
      payload = {
        id: 19,
        status: 'SENT',
        conversation_source_id: '1250240141',
        body: 'Exact answer',
      };
    } else {
      throw new Error(`Unexpected mocked Bridge request: ${target}`);
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await withEnv(developmentBridgeEnv(), async () => {
      const first = jsonResponse();
      await messagesHandler(request('POST', {
        action: 'approveAndSendDraft',
        draft_id: '19',
        body: 'Exact answer',
        client_request_id: 'manager-click-0001',
      }), first);
      expect(first.body.data).toMatchObject({
        draft: { id: 19, status: 'SENT' },
        outcome: 'SENT',
        sent: true,
        idempotent_replay: false,
        delivery_attempted: true,
        retry_allowed: false,
        operation_id: 'approve-send-19-manager-click-0001',
      });
      expect(calls.filter(call => call.url.endsWith('/history/sync?wait=true&full=false')))
        .toHaveLength(2);
      expect(calls.filter(call => call.url.endsWith('/approve'))).toHaveLength(1);
      expect(calls.filter(call => call.url.endsWith('/send'))).toHaveLength(1);
      expect(calls.find(call => call.url.endsWith('/send')).headers)
        .toEqual(expect.objectContaining({
          Authorization: 'Bearer test-bridge-token',
          'X-Bridge-Approval-Token': 'test-approval-token',
          'Idempotency-Key': 'approve-send-19-manager-click-0001',
        }));

      const replay = jsonResponse();
      await messagesHandler(request('POST', {
        action: 'approveAndSendDraft',
        draft_id: '19',
        body: 'Exact answer',
        client_request_id: 'manager-click-0001',
      }), replay);
      expect(replay.body.data).toMatchObject({
        draft: { id: 19, status: 'SENT' },
        outcome: 'SENT',
        sent: true,
        idempotent_replay: true,
        delivery_attempted: false,
        retry_allowed: false,
      });
      expect(calls.filter(call => call.url.endsWith('/approve'))).toHaveLength(1);
      expect(calls.filter(call => call.url.endsWith('/send'))).toHaveLength(1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('approveAndSendDraft blocks stale, outgoing-head, and unknown-direction threads', async () => {
  const originalFetch = global.fetch;
  try {
    for (const example of [{
      name: 'outgoing',
      sourceId: 'shop-message-2',
      direction: 'OUTGOING',
      sender: 'self',
      expectedCode: 'MESSAGE_DRAFT_ALREADY_ANSWERED',
      expectSkip: true,
    }, {
      name: 'unknown',
      sourceId: 'unknown-message-2',
      direction: 'UNKNOWN',
      sender: '987654321',
      expectedCode: 'MESSAGE_DRAFT_LATEST_DIRECTION_UNVERIFIED',
      expectSkip: false,
    }, {
      name: 'stale incoming',
      sourceId: 'buyer-message-2',
      direction: 'INCOMING',
      sender: 'buyer',
      expectedCode: 'MESSAGE_DRAFT_CONVERSATION_CHANGED',
      expectSkip: true,
    }]) {
      const calls = [];
      global.fetch = async (url, options = {}) => {
        const target = String(url);
        calls.push({ url: target, method: options.method || 'GET' });
        let payload;
        if (target.endsWith('/v1/outbox/drafts/20')) {
          payload = {
            id: 20,
            status: 'AWAITING_APPROVAL',
            conversation_source_id: '1250240141',
            body: 'Must not send',
            created_at: '2026-07-28T10:00:00Z',
            metadata: { source_message_id: 'buyer-message-1' },
          };
        } else if (target.includes('/history/sync')) {
          payload = { status: 'OK' };
        } else if (target.endsWith('/v1/conversations/1250240141')) {
          payload = { source_id: '1250240141', participant: 'Buyer' };
        } else if (target.includes('/messages?')) {
          payload = {
            items: [{
              source_id: example.sourceId,
              direction: example.direction,
              sender: example.sender,
              body: example.name,
              sent_at: '2026-07-28T11:00:00Z',
            }],
            next_cursor: null,
          };
        } else if (target.endsWith('/skip')) {
          payload = { id: 20, status: 'SKIPPED' };
        } else {
          throw new Error(`Unexpected mocked Bridge request: ${target}`);
        }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      await withEnv(developmentBridgeEnv(), async () => {
        await expect(messagesHandler(request('POST', {
          action: 'approveAndSendDraft',
          draft_id: '20',
          body: 'Must not send',
          client_request_id: `blocked-${example.name}`,
        }), jsonResponse())).rejects.toMatchObject({
          status: 409,
          code: example.expectedCode,
        });
      });
      expect(calls.some(call => call.url.includes('/history/sync?wait=true&full=false')))
        .toBe(true);
      expect(calls.some(call => call.url.endsWith('/approve'))).toBe(false);
      expect(calls.some(call => call.url.endsWith('/send'))).toBe(false);
      expect(calls.some(call => call.url.endsWith('/skip'))).toBe(example.expectSkip);
    }
  } finally {
    global.fetch = originalFetch;
  }
});
