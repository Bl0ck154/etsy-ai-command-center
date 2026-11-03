import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import messageEventsHandler from '../api/message-events.js';
import { notifyMessageDraftReady } from '../api/messages/draft-notifier.js';
import { notifyMessageEvidenceBlocked } from '../api/messages/evidence-debug-notifier.js';
import {
  buildUniversalAssistantRule,
  enqueueMessageTriggerEvent,
  getMessageTriggerStatus,
  hydrateNewMessageTriggerEvent,
  hydrateOrderLinkedTriggerEvent,
  lookupExactOrderConversationLink,
  reconcileMessageTriggerDraft,
  runDueMessageTriggerCandidates,
  messageTriggerRulesForEvent,
  messageUniversalAssistantEnabled,
  validateMessageTriggerEvidence,
} from '../api/messages/trigger-runner.js';
import { createMessageTriggerWorker } from '../api/messages/trigger-worker.js';

test.describe.configure({ mode: 'serial' });

const ENV_KEYS = [
  'MESSAGE_TRIGGER_RUNNER_ENABLED',
  'MESSAGE_AUTO_TRIGGERS_ENABLED',
  'MESSAGE_UNIVERSAL_ASSISTANT_ENABLED',
  'MESSAGE_ORDER_LINKING_ENABLED',
  'ORDER_CONTEXT_API_URL',
  'ORDER_CONTEXT_API_TOKEN',
  'MESSAGE_TRIGGER_STATE_FILE',
  'MESSAGE_TRIGGER_STATE_LOCK_FILE',
  'MESSAGE_TRIGGER_WORKER_STATUS_FILE',
  'MESSAGE_TRIGGER_LEASE_SECONDS',
  'MESSAGE_EVENT_INGEST_TOKEN',
  'MESSAGE_AUTOMATION_POLICY_FILE',
  'MESSAGE_LEARNING_ENABLED',
  'MESSAGE_LEARNING_CAPTURE_ENABLED',
  'MESSAGE_LEARNING_DATA_DIR',
  'MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED',
  'MESSAGE_EVIDENCE_DEBUG_NOTIFICATIONS_ENABLED',
  'MESSAGE_EVIDENCE_DEBUG_CHAT_ID',
  'MESSAGE_TELEGRAM_BOT_TOKEN',
  'MESSAGE_APPROVALS_CHAT_ID',
  'MESSAGE_APPROVALS_THREAD_ID',
  'MESSAGE_SUGGESTIONS_CHAT_ID',
  'MESSAGE_SUGGESTIONS_THREAD_ID',
  'TELEGRAM_BOT_TOKEN',
  'PUBLIC_BASE_URL',
];

async function withTriggerEnv(operation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-trigger-runner-'));
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.MESSAGE_TRIGGER_RUNNER_ENABLED = 'true';
  process.env.MESSAGE_AUTO_TRIGGERS_ENABLED = 'true';
  process.env.MESSAGE_ORDER_LINKING_ENABLED = 'true';
  process.env.ORDER_CONTEXT_API_URL = 'http://127.0.0.1:18092';
  process.env.ORDER_CONTEXT_API_TOKEN =
    'test-order-context-token-12345678901234567890';
  process.env.MESSAGE_TRIGGER_STATE_FILE = path.join(directory, 'state.json');
  process.env.MESSAGE_AUTOMATION_POLICY_FILE = path.join(directory, 'policies.json');
  process.env.MESSAGE_LEARNING_ENABLED = 'false';
  process.env.MESSAGE_LEARNING_CAPTURE_ENABLED = 'false';
  process.env.MESSAGE_LEARNING_DATA_DIR = directory;
  process.env.MESSAGE_EVENT_INGEST_TOKEN = 'event-service-test-token-1234567890';
  try {
    return await operation(directory);
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function policy(rules) {
  return async () => ({
    revision: 4,
    policy: {
      enabled: true,
      delivery_mode: 'draft_only',
      human_approval_required: true,
      rules,
    },
  });
}

function rule(overrides = {}) {
  return {
    id: 'reply-question',
    label: 'Reply to a buyer question',
    enabled: true,
    event: 'new_message',
    scenario: 'how_to_send_files',
    delay_minutes: 0,
    cooldown_minutes: 60,
    require_order_context: false,
    conditions: '',
    owner_notes: 'Use the verified upload instructions.',
    ...overrides,
  };
}

function newMessageEvent(overrides = {}) {
  return {
    event_id: 'mail-evt-1',
    type: 'new_message',
    shop_id: '12345678',
    conversation_id: '1250240141',
    source_message_id: 'message-9001',
    occurred_at: '2026-07-28T08:00:00.000Z',
    source: 'etsy_email_notification',
    verified_facts: {},
    ...overrides,
  };
}

function incomingConversation(overrides = {}) {
  return {
    source_id: '1250240141',
    participant: 'Ilya',
    messages: [{
      source_id: 'message-9001',
      direction: 'incoming',
      sender: 'Ilya',
      body: 'How can I send my files?',
    }],
    ...overrides,
  };
}

function readyDraft() {
  return {
    status: 'ready',
    scenario: 'how_to_send_files',
    reply_body: 'You can send the files here as attachments.',
    language: 'English',
    confidence: 0.96,
    rationale: 'Answers the buyer question.',
    facts_used: [],
    warnings: [],
    requires_human_approval: true,
    block_reason: '',
    quality_review: {
      approved: true,
      decision: 'approve',
      answers_question_directly: true,
      uses_available_context: true,
      asks_irrelevant_question: false,
      greeting_appropriate: true,
      fabricates_internal_process: false,
      unnecessarily_defers_answer: false,
      natural_and_decisive: true,
      unsupported_claims: [],
      confidence: 0.94,
      rationale: 'Direct, grounded, and appropriate.',
    },
  };
}

function routeHowToSendFiles() {
  return {
    decision: 'route',
    rule_id: 'reply-question',
    scenario: 'how_to_send_files',
    confidence: 0.97,
    rationale: 'The buyer explicitly asks how to send files.',
  };
}

test('runner is disabled unless its independent release gate is enabled', async () => {
  const previous = process.env.MESSAGE_TRIGGER_RUNNER_ENABLED;
  delete process.env.MESSAGE_TRIGGER_RUNNER_ENABLED;
  try {
    await expect(enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule()]),
    })).rejects.toMatchObject({
      status: 503,
      code: 'MESSAGE_TRIGGER_RUNNER_DISABLED',
    });
  } finally {
    if (previous === undefined) delete process.env.MESSAGE_TRIGGER_RUNNER_ENABLED;
    else process.env.MESSAGE_TRIGGER_RUNNER_ENABLED = previous;
  }
});

test('event ingestion is idempotent, honors delay, and rejects key reuse with changed payload', async () => {
  await withTriggerEnv(async () => {
    const dependencies = {
      loadPolicy: policy([rule({ delay_minutes: 30 })]),
    };
    const first = await enqueueMessageTriggerEvent(newMessageEvent(), dependencies);
    expect(first.duplicate).toBe(false);
    expect(first.candidates[0]).toMatchObject({
      status: 'PENDING',
      due_at: '2026-07-28T08:30:00.000Z',
    });

    const duplicate = await enqueueMessageTriggerEvent(newMessageEvent(), dependencies);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.candidates).toHaveLength(1);

    await expect(enqueueMessageTriggerEvent(newMessageEvent({
      conversation_id: '1250240142',
    }), dependencies)).rejects.toMatchObject({
      status: 409,
      code: 'MESSAGE_TRIGGER_IDEMPOTENCY_CONFLICT',
    });
  });
});

test('due candidate creates one draft awaiting approval and never approves or sends', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule({ scenario: 'freeform' })]),
    });
    const calls = [];
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation(),
      loadPlaybook: async () => ({
        revision: 7,
        playbook: {
          scenarios: { freeform: { enabled: true } },
        },
      }),
      classifyNewMessage: async () => ({
        decision: 'route',
        rule_id: 'reply-question',
        scenario: 'freeform',
        confidence: 0.97,
        rationale: 'A configured custom reply applies.',
      }),
      generateDraft: async input => {
        calls.push({ type: 'generate', input });
        return {
          ...readyDraft(),
          scenario: 'freeform',
          reply_body: 'A safe draft for review.',
        };
      },
      createDraft: async input => {
        calls.push({ type: 'create', input });
        return { id: 'draft-77', status: 'AWAITING_APPROVAL' };
      },
    });

    expect(result.processed).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: 'draft-77',
      attempts: 1,
    });
    expect(calls.map(call => call.type)).toEqual(['generate', 'create']);
    expect(calls[1].input.generated.requires_human_approval).toBe(true);
    expect(calls[1].input.conversation.messages[0]).toMatchObject({
      source_id: 'message-9001',
      direction: 'incoming',
    });

    const again = await runDueMessageTriggerCandidates({
      now: '2026-07-28T09:00:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation(),
      loadPlaybook: async () => ({}),
      generateDraft: async () => {
        throw new Error('must not regenerate');
      },
      createDraft: async () => {
        throw new Error('must not recreate');
      },
    });
    expect(again.processed).toBe(0);
  });
});

test('new-message candidates fail closed for outgoing or unknown message direction', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule()]),
    });
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation({
        messages: [{
          source_id: 'message-9001',
          direction: 'outgoing',
          sender: 'self',
          body: 'Shop response',
        }],
      }),
      generateDraft: async () => {
        throw new Error('AI must not run');
      },
    });
    expect(result.candidates[0]).toMatchObject({
      status: 'BLOCKED',
      block_code: 'MESSAGE_TRIGGER_SOURCE_MESSAGE_NOT_INCOMING',
    });
  });
});

test('semantic router chooses exactly one new-message rule without duplicate drafts', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([
        rule({ conditions: 'Buyer is asking how to send files.' }),
        rule({
          id: 'order-help',
          scenario: 'how_to_order',
          conditions: 'Buyer needs help choosing the right listing.',
        }),
      ]),
    });
    const createCalls = [];
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation(),
      loadPlaybook: async () => ({
        revision: 2,
        playbook: {
          scenarios: {
            how_to_send_files: { enabled: true },
            how_to_order: { enabled: true },
          },
        },
      }),
      classifyNewMessage: async ({ rules }) => {
        expect(rules.map(item => item.id)).toEqual(['reply-question', 'order-help']);
        return {
          decision: 'route',
          rule_id: 'order-help',
          scenario: 'how_to_order',
          confidence: 0.99,
          rationale: 'No order is linked, so purchase must come first.',
        };
      },
      loadListingFacts: async () => ({
        listing: null,
        unavailable_reason: 'No exact Etsy inline listing reference is cached',
      }),
      generateDraft: async () => ({
        ...readyDraft(),
        scenario: 'how_to_order',
        reply_body: 'Which product would you like to order?',
      }),
      createDraft: async input => {
        createCalls.push(input);
        return { id: 'draft-routed' };
      },
    });
    expect(result.candidates[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      rule_id: 'order-help',
      scenario: 'how_to_order',
    });
    expect(createCalls).toHaveLength(1);
  });
});

test('send-files runner enriches the exact paid order with its Etsy listing', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule()]),
    });
    const verifiedOrderFacts = {
      order: {
        linked: true,
        paid: true,
        automation_facts_verified: true,
        receipt_id: '4130532997',
        checked_at: '2026-07-28T08:01:00.000Z',
        paid_at: '2026-07-28T07:00:00.000Z',
        listing_ids: ['4517826856'],
      },
    };
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation({
        receipt_ids: ['4130532997'],
      }),
      loadPlaybook: async () => ({
        revision: 7,
        playbook: {
          scenarios: { how_to_send_files: { enabled: true } },
        },
      }),
      classifyNewMessage: async () => routeHowToSendFiles(),
      loadOrderFacts: async () => verifiedOrderFacts,
      loadOrderListingFacts: async input => {
        expect(input.verifiedOrderFacts).toEqual(verifiedOrderFacts);
        return {
          listing: {
            verified: true,
            listing_id: '4517826856',
            description: 'Send files to files@example.com after purchase.',
            personalization_fields: [],
            file_delivery_policy: {
              etsy_conversation_allowed: true,
              verified_email_addresses: [{
                address: 'files@example.com',
                source_fields: ['description'],
              }],
            },
          },
          unavailable_reason: null,
        };
      },
      generateDraft: async ({ verifiedFacts }) => {
        expect(verifiedFacts.listing).toMatchObject({
          listing_id: '4517826856',
          description: 'Send files to files@example.com after purchase.',
        });
        expect(verifiedFacts.listing_context).toEqual({
          exact_reference_available: true,
          unavailable_reason: null,
        });
        return readyDraft();
      },
      createDraft: async () => ({
        id: 'draft-order-listing-context',
        status: 'AWAITING_APPROVAL',
      }),
    });
    expect(result.candidates[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: 'draft-order-listing-context',
    });
  });
});

test('how-to-order runner attaches only exact verified listing facts', async () => {
  await withTriggerEnv(async () => {
    const orderRule = rule({
      id: 'order-help',
      scenario: 'how_to_order',
      conditions: 'Buyer explicitly asks how to order.',
    });
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([orderRule]),
    });
    let created = false;
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation({
        listing_refs: [{
          listing_id: '4517826856',
          listing_url: 'https://www.etsy.com/listing/4517826856',
          source: 'inline_listing_ids',
          source_message_id: 'message-9001',
        }],
        messages: [{
          source_id: 'message-9001',
          direction: 'incoming',
          sender: 'Ilya',
          body: 'Which option should I order?',
        }],
      }),
      loadPlaybook: async () => ({
        revision: 3,
        playbook: {
          scenarios: { how_to_order: { enabled: true } },
        },
      }),
      classifyNewMessage: async () => ({
        decision: 'route',
        rule_id: 'order-help',
        scenario: 'how_to_order',
        confidence: 0.98,
        rationale: 'Explicit order question.',
      }),
      loadListingFacts: async ({ conversation, sourceMessageId }) => {
        expect(conversation.listing_refs).toHaveLength(1);
        expect(sourceMessageId).toBe('message-9001');
        return {
          listing: {
            verified: true,
            listing_id: '4517826856',
            title: 'Verified portrait',
            url: 'https://www.etsy.com/listing/4517826856',
            active: true,
            variations: [{
              name: 'People',
              enabled_values: ['2 people'],
            }],
            personalization_fields: [],
            checked_at: '2026-07-28T08:01:00.000Z',
            provenance: { source: 'official_etsy_api' },
          },
          unavailable_reason: null,
        };
      },
      generateDraft: async ({ verifiedFacts }) => {
        expect(verifiedFacts.listing).toMatchObject({
          verified: true,
          listing_id: '4517826856',
        });
        expect(verifiedFacts.listing_context).toEqual({
          exact_reference_available: true,
          unavailable_reason: null,
        });
        return {
          ...readyDraft(),
          scenario: 'how_to_order',
          reply_body: 'For the People option, select 2 people.',
        };
      },
      createDraft: async () => {
        created = true;
        return { id: 'draft-how-to-order' };
      },
    });

    expect(result.candidates[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      rule_id: 'order-help',
      scenario: 'how_to_order',
      draft_id: 'draft-how-to-order',
    });
    expect(created).toBe(true);
  });
});

test('how-to-order runner supplies clarification-only context without listing guess', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule({
        id: 'order-help',
        scenario: 'how_to_order',
      })]),
    });
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation(),
      loadPlaybook: async () => ({
        revision: 3,
        playbook: {
          scenarios: { how_to_order: { enabled: true } },
        },
      }),
      classifyNewMessage: async () => ({
        decision: 'route',
        rule_id: 'order-help',
        scenario: 'how_to_order',
        confidence: 0.95,
        rationale: 'Explicit order question.',
      }),
      loadListingFacts: async () => ({
        listing: null,
        unavailable_reason: 'No exact Etsy inline listing reference is cached',
      }),
      generateDraft: async ({ verifiedFacts }) => {
        expect(verifiedFacts).toMatchObject({
          listing: null,
          listing_context: {
            exact_reference_available: false,
            unavailable_reason:
              'No exact Etsy inline listing reference is cached',
          },
        });
        return {
          ...readyDraft(),
          scenario: 'how_to_order',
          reply_body: 'Which product and number of people would you like?',
        };
      },
      createDraft: async () => ({ id: 'draft-clarification' }),
    });

    expect(result.candidates[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: 'draft-clarification',
    });
  });
});

test('missing-materials requires an exact receipt and accepts an empty Trello operational record', () => {
  const candidate = {
    rule: {
      id: 'missing-files',
      scenario: 'missing_materials',
      require_order_context: true,
      conditions: 'Paid made-to-order order has no materials in any verified channel.',
    },
  };
  const event = {
    type: 'materials_missing',
    verified_facts: {
      order: {
        linked: true,
        receipt_id: '555001',
        checked_at: '2026-07-28T08:00:00.000Z',
        paid: true,
        automation_facts_verified: true,
        paid_at: '2026-07-27T08:00:00.000Z',
        all_items_physical: true,
        made_to_order: true,
        made_to_order_verified: true,
        made_to_order_checked_at: '2026-07-28T08:00:00.000Z',
      },
      materials: {
        missing: true,
        sources: Object.fromEntries([
          'etsy',
          'listing_upload',
          'email',
          'drive',
        ].map(channel => [channel, {
          checked: true,
          received: false,
          checked_at: '2026-07-28T08:00:00.000Z',
        }])),
      },
    },
    rule_evidence: {},
  };

  expect(validateMessageTriggerEvidence(
    candidate,
    event,
    { receipt_ids: ['999999'], messages: [] },
  )).toMatchObject({
    ok: false,
    code: 'MESSAGE_TRIGGER_RECEIPT_MISMATCH',
  });

  expect(validateMessageTriggerEvidence(
    candidate,
    event,
    { receipt_ids: ['555001'], messages: [] },
  )).toEqual({ ok: true });

  event.verified_facts.materials.sources.email.checked = false;
  expect(validateMessageTriggerEvidence(
    candidate,
    event,
    { receipt_ids: ['555001'], messages: [] },
  )).toEqual({ ok: true });
});

test('confirmed material presence and confirmed review ineligibility are no-action outcomes', () => {
  const missingCandidate = {
    rule: {
      id: 'missing-files',
      scenario: 'missing_materials',
      require_order_context: true,
    },
  };
  const conversation = { receipt_ids: ['555001'], messages: [] };
  const materialResult = validateMessageTriggerEvidence(missingCandidate, {
    type: 'order_paid',
    verified_facts: {
      order: {
        linked: true,
        receipt_id: '555001',
        checked_at: '2026-07-28T08:00:00.000Z',
      },
      materials: {
        missing: false,
        sources: {
          etsy: { checked: true, received: true },
        },
      },
    },
  }, conversation);
  expect(materialResult).toMatchObject({
    ok: false,
    no_action: true,
    code: 'MESSAGE_TRIGGER_MATERIALS_ALREADY_PRESENT',
  });

  const reviewResult = validateMessageTriggerEvidence({
    rule: {
      id: 'review',
      scenario: 'review_request',
      require_order_context: true,
    },
  }, {
    type: 'order_completed',
    verified_facts: {
      order: {
        linked: true,
        receipt_id: '555001',
        checked_at: '2026-07-28T08:00:00.000Z',
        completed: true,
        has_active_issue: false,
      },
      review: {
        lifecycle_verified: true,
        lifecycle_eligible: true,
        already_requested: false,
        positive_conversation_ending: false,
        checked_at: '2026-07-28T08:00:00.000Z',
      },
    },
  }, conversation);
  expect(reviewResult).toMatchObject({
    ok: false,
    no_action: true,
    code: 'MESSAGE_TRIGGER_REVIEW_NOT_ELIGIBLE',
  });
});

test('unverified evidence reports every missing fact instead of one generic reason', () => {
  const result = validateMessageTriggerEvidence({
    rule: {
      id: 'missing-files',
      scenario: 'missing_materials',
      require_order_context: true,
    },
  }, {
    type: 'order_paid',
    verified_facts: {
      order: {
        linked: true,
        receipt_id: '555001',
        checked_at: '2026-07-28T08:00:00.000Z',
      },
      materials: { missing: null, sources: {} },
    },
  }, { receipt_ids: ['555001'], messages: [] });
  expect(result).toMatchObject({
    ok: false,
    code: 'MESSAGE_TRIGGER_MADE_TO_ORDER_UNVERIFIED',
  });
  expect(result.evidence_gaps).toEqual(expect.arrayContaining([
    'paid order status',
    'official receipt automation facts',
    'official listing when_made check',
  ]));
});

test('cooldown suppresses a second candidate for the same conversation and rule', async () => {
  await withTriggerEnv(async () => {
    const dependencies = {
      loadPolicy: policy([rule({
        scenario: 'freeform',
        cooldown_minutes: 120,
      })]),
    };
    await enqueueMessageTriggerEvent(newMessageEvent(), dependencies);
    await enqueueMessageTriggerEvent(newMessageEvent({
      event_id: 'mail-evt-2',
      source_message_id: 'message-9002',
      occurred_at: '2026-07-28T08:01:00.000Z',
    }), dependencies);

    const messages = [
      ...incomingConversation().messages,
      {
        source_id: 'message-9002',
        direction: 'incoming',
        sender: 'Ilya',
        body: 'One more question',
      },
    ];
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:02:00.000Z',
      limit: 10,
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation({ messages }),
      loadPlaybook: async () => ({
        revision: 1,
        playbook: {
          scenarios: { freeform: { enabled: true } },
        },
      }),
      classifyNewMessage: async () => ({
        decision: 'route',
        rule_id: 'reply-question',
        scenario: 'freeform',
        confidence: 0.97,
        rationale: 'A configured custom reply applies.',
      }),
      generateDraft: async () => ({
        ...readyDraft(),
        scenario: 'freeform',
      }),
      createDraft: async ({ candidate }) => ({
        id: `draft-${candidate.event_id}`,
      }),
    });

    expect(result.candidates.map(candidate => candidate.status)).toEqual([
      'AWAITING_APPROVAL',
      'IGNORED_COOLDOWN',
    ]);
  });
});

test('transient failures are backed off instead of looping in one worker run', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule()]),
    });
    let attempts = 0;
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
      limit: 10,
    }, {
      syncConversation: async () => {},
      loadConversation: async () => {
        attempts += 1;
        throw new Error('Bridge temporarily unavailable');
      },
    });
    expect(attempts).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      status: 'RETRYABLE_ERROR',
      attempts: 1,
      last_error: 'Bridge temporarily unavailable',
    });
  });
});

test('semantic router can choose no action without creating a draft', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule()]),
    });
    const failed = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => {
        throw new Error('Bridge temporarily unavailable');
      },
    });
    expect(failed.candidates[0]).toMatchObject({
      status: 'RETRYABLE_ERROR',
      last_error: 'Bridge temporarily unavailable',
    });
    let created = false;
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:03:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation(),
      loadPlaybook: async () => ({
        revision: 1,
        playbook: {
          scenarios: { how_to_send_files: { enabled: true } },
        },
      }),
      classifyNewMessage: async () => ({
        decision: 'no_action',
        rule_id: '',
        scenario: '',
        confidence: 0.99,
        rationale: 'The buyer only said thank you.',
      }),
      createDraft: async () => {
        created = true;
      },
    });
    expect(result.candidates[0]).toMatchObject({
      status: 'IGNORED_NO_ACTION',
      block_code: 'MESSAGE_TRIGGER_NO_ACTION',
      last_error: null,
    });
    expect(created).toBe(false);
  });
});

test('email-style hydration skips a buyer message already followed by a shop reply', async () => {
  await withTriggerEnv(async () => {
    let syncCalls = 0;
    let reconciliation = null;
    const hydrate = dependencies => hydrateNewMessageTriggerEvent({
      event_id: dependencies.eventId,
      shop_id: '12345678',
      conversation_id: '1250240141',
      occurred_at: '2026-07-28T08:02:00.000Z',
      source: 'gmail_notification',
    }, {
      syncConversation: async id => {
        expect(id).toBe('1250240141');
        syncCalls += 1;
      },
      loadConversation: async () => incomingConversation({
        messages: [{
          source_id: 'shop-last',
          direction: 'outgoing',
          sent_at: '2026-07-28T08:01:00.000Z',
        }, {
          source_id: 'buyer-old',
          direction: 'incoming',
          sent_at: '2026-07-28T07:50:00.000Z',
        }, {
          source_id: 'buyer-new',
          direction: 'incoming',
          sent_at: '2026-07-28T08:00:00.000Z',
        }],
      }),
      reconcileLearning: async input => {
        reconciliation = input;
        return { recorded: 1 };
      },
    });

    const first = await hydrate({ eventId: 'gmail-1' });
    expect(first).toMatchObject({
      event: null,
      duplicate: false,
      no_action: true,
      already_answered: true,
      reason: 'A newer explicit shop reply already follows the buyer message',
    });
    expect(syncCalls).toBe(1);
    expect(reconciliation).toMatchObject({
      shopId: '12345678',
      conversationId: '1250240141',
      conversation: { source_id: '1250240141' },
    });
  });
});

test('email-style hydration uses newest unanswered incoming and deduplicates it', async () => {
  await withTriggerEnv(async () => {
    let syncCalls = 0;
    const hydrate = eventId => hydrateNewMessageTriggerEvent({
      event_id: eventId,
      shop_id: '12345678',
      conversation_id: '1250240141',
      occurred_at: '2026-07-28T08:02:00.000Z',
      source: 'gmail_notification',
    }, {
      syncConversation: async () => {
        syncCalls += 1;
      },
      loadConversation: async () => incomingConversation({
        messages: [{
          source_id: 'buyer-old',
          direction: 'incoming',
          sender: 'Buyer',
          sent_at: '2026-07-28T07:50:00.000Z',
        }, {
          source_id: 'buyer-new',
          direction: 'incoming',
          sender: 'Buyer',
          sent_at: '2026-07-28T08:00:00.000Z',
        }],
      }),
    });
    const first = await hydrate('gmail-unanswered-1');
    expect(first.event.source_message_id).toBe('buyer-new');
    await enqueueMessageTriggerEvent(first.event, {
      loadPolicy: policy([rule()]),
    });
    const duplicateNewest = await hydrate('gmail-unanswered-2');
    expect(duplicateNewest).toMatchObject({
      event: null,
      duplicate: true,
      no_action: true,
      reason: 'The newest incoming buyer message was already ingested',
    });
    expect(syncCalls).toBe(2);
  });
});

test('email-style hydration fails closed for newer unknown direction', async () => {
  await withTriggerEnv(async () => {
    const result = await hydrateNewMessageTriggerEvent({
      event_id: 'gmail-unknown-direction',
      shop_id: '12345678',
      conversation_id: '1250240141',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation({
        messages: [{
          source_id: 'buyer-question',
          direction: 'incoming',
          sender: 'Buyer',
          sent_at: '2026-07-28T08:00:00.000Z',
        }, {
          source_id: 'uncertain-later',
          direction: 'unknown',
          sender: '',
          sent_at: '2026-07-28T08:01:00.000Z',
        }],
      }),
    });
    expect(result).toMatchObject({
      event: null,
      no_action: true,
      reason: 'A newer message has unknown direction; hydration failed closed',
    });
  });
});

test('email-style hydration rejects incoming direction with seller sender', async () => {
  await withTriggerEnv(async () => {
    const result = await hydrateNewMessageTriggerEvent({
      event_id: 'gmail-inconsistent-sender',
      shop_id: '12345678',
      conversation_id: '1250240141',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation({
        messages: [{
          source_id: 'bad-direction',
          direction: 'incoming',
          sender: 'seller',
          sent_at: '2026-07-28T08:00:00.000Z',
        }],
      }),
    });
    expect(result).toMatchObject({
      event: null,
      no_action: true,
      reason: 'Newest incoming-labelled message has an inconsistent seller sender',
    });
  });
});

test('explicit source is no-action when a later outgoing message exists', () => {
  expect(validateMessageTriggerEvidence(
    {
      rule: {
        id: 'send-files',
        scenario: 'how_to_send_files',
        conditions: '',
      },
    },
    {
      type: 'new_message',
      source_message_id: 'controlled-source',
      verified_facts: {},
      rule_evidence: {},
    },
    {
      messages: [{
        source_id: 'controlled-source',
        direction: 'incoming',
        sender: 'Buyer',
      }, {
        source_id: 'later-shop-message',
        direction: 'outgoing',
        sender: 'self',
      }],
    },
  )).toMatchObject({
    ok: false,
    no_action: true,
    already_answered: true,
    code: 'MESSAGE_TRIGGER_ALREADY_ANSWERED',
  });
});

test('old explicit source with newest outgoing skips router, AI, draft and notifier', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent({
      source_message_id: 'buyer-old',
    }), {
      loadPolicy: policy([rule()]),
    });
    const forbidden = label => async () => {
      throw new Error(`${label} must not run`);
    };
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:02:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation({
        messages: [{
          source_id: 'shop-newest',
          direction: 'outgoing',
          sender: 'self',
          sent_at: '2026-07-28T08:01:00.000Z',
        }, {
          source_id: 'buyer-old',
          direction: 'incoming',
          sender: 'Buyer',
          sent_at: '2026-07-28T08:00:00.000Z',
        }],
      }),
      loadPlaybook: forbidden('playbook'),
      classifyNewMessage: forbidden('semantic router'),
      generateDraft: forbidden('AI draft'),
      createDraft: forbidden('draft creation'),
      notifyDraftReady: forbidden('notifier'),
    });

    expect(result.candidates[0]).toMatchObject({
      status: 'IGNORED_NO_ACTION',
      block_code: 'MESSAGE_TRIGGER_ALREADY_ANSWERED',
      block_reason: 'A newer explicit shop reply already follows the buyer message',
    });
  });
});

test('incoming direction with seller sender is blocked before router or AI', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule()]),
    });
    const forbidden = label => async () => {
      throw new Error(`${label} must not run`);
    };
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation({
        messages: [{
          source_id: 'message-9001',
          direction: 'incoming',
          sender: 'seller',
          sent_at: '2026-07-28T08:00:00.000Z',
        }],
      }),
      loadPlaybook: forbidden('playbook'),
      classifyNewMessage: forbidden('semantic router'),
      generateDraft: forbidden('AI draft'),
      createDraft: forbidden('draft creation'),
      notifyDraftReady: forbidden('notifier'),
    });

    expect(result.candidates[0]).toMatchObject({
      status: 'BLOCKED',
      block_code: 'MESSAGE_TRIGGER_SOURCE_MESSAGE_NOT_INCOMING',
    });
  });
});

test('explicit event evidence blocks inconsistent incoming seller sender', () => {
  expect(validateMessageTriggerEvidence(
    {
      rule: {
        id: 'send-files',
        scenario: 'how_to_send_files',
        conditions: '',
      },
    },
    {
      type: 'new_message',
      source_message_id: 'bad-source',
      verified_facts: {},
      rule_evidence: {},
    },
    {
      messages: [{
        source_id: 'bad-source',
        direction: 'incoming',
        sender: 'seller',
      }],
    },
  )).toMatchObject({
    ok: false,
    code: 'MESSAGE_TRIGGER_SOURCE_MESSAGE_NOT_INCOMING',
  });
});

test('order lifecycle event resolves conversation only through an exact Bridge receipt link', async () => {
  const hydrated = await hydrateOrderLinkedTriggerEvent({
    event_id: 'order-paid-555001',
    type: 'order_paid',
    shop_id: '12345678',
    receipt_id: '555001',
    occurred_at: '2026-07-28T08:00:00.000Z',
  }, {
    lookupOrderLink: async receiptId => {
      expect(receiptId).toBe('555001');
      return {
        receipt_id: '555001',
        conversation_id: '1250240141',
        match: 'exact_etsy_system_message',
      };
    },
  });
  expect(hydrated).toMatchObject({
    hydrated: true,
    receipt_id: '555001',
    match: 'exact_etsy_system_message',
    event: {
      conversation_id: '1250240141',
      verified_facts: { order: { receipt_id: '555001' } },
    },
  });

  const emailHydrated = await hydrateOrderLinkedTriggerEvent({
    event_id: 'order-paid-email-555001',
    type: 'order_paid',
    shop_id: '12345678',
    receipt_id: '555001',
    conversation_id: '1250240141',
    occurred_at: '2026-07-28T08:00:00.000Z',
    verified_facts: { order: { paid: true } },
  }, {
    lookupOrderLink: async () => ({
      receipt_id: '555001',
      conversation_id: '1250240141',
      match: 'authenticated_etsy_email_subject',
    }),
  });
  expect(emailHydrated).toMatchObject({
    hydrated: true,
    receipt_id: '555001',
    match: 'authenticated_etsy_email_subject',
    event: {
      conversation_id: '1250240141',
      verified_facts: {
        order: { paid: true, receipt_id: '555001' },
      },
    },
  });

  await expect(hydrateOrderLinkedTriggerEvent({
    type: 'order_paid',
    shop_id: '12345678',
    receipt_id: '555001',
    conversation_id: '9999999999',
  }, {
    lookupOrderLink: async () => ({
      receipt_id: '555001',
      conversation_id: '1250240141',
      match: 'authenticated_etsy_email_subject',
    }),
  })).rejects.toMatchObject({
    status: 409,
    code: 'MESSAGE_TRIGGER_ORDER_CONVERSATION_MISMATCH',
  });

  await expect(hydrateOrderLinkedTriggerEvent({
    type: 'order_paid',
    shop_id: '12345678',
    receipt_id: '555001',
  }, {
    lookupOrderLink: async () => ({
      conversation_id: '1250240141',
      match: 'fuzzy_name',
    }),
  })).rejects.toMatchObject({
    status: 409,
    code: 'MESSAGE_TRIGGER_ORDER_LINK_UNVERIFIED',
  });
});

test('order link hydration resolves one exact order on cache miss then syncs only that history', async () => {
  const calls = [];
  const link = await lookupExactOrderConversationLink('555001', {
    bridgeCall: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/v1/order-links/555001') {
        const error = new Error('not found');
        error.status = 404;
        error.bridge_status = 404;
        throw error;
      }
      if (path === '/v1/order-links/555001/resolve') {
        return {
          receipt_id: '555001',
          conversation_id: '1250240141',
          match: 'exact_etsy_order_page_dom',
        };
      }
      if (
        path
        === '/v1/conversations/1250240141/history/sync?wait=true'
      ) {
        return { status: 'OK' };
      }
      throw new Error(`Unexpected Bridge call: ${path}`);
    },
  });

  expect(link).toMatchObject({
    receipt_id: '555001',
    conversation_id: '1250240141',
    match: 'exact_etsy_order_page_dom',
  });
  expect(calls).toEqual([
    { path: '/v1/order-links/555001', options: {} },
    {
      path: '/v1/order-links/555001/resolve',
      options: { method: 'POST', timeoutMs: 45_000 },
    },
    {
      path: '/v1/conversations/1250240141/history/sync?wait=true',
      options: { method: 'POST', timeoutMs: 180_000 },
    },
  ]);
});

test('order link hydration skips order-page resolution but refreshes exact cached conversation history', async () => {
  const calls = [];
  const link = await lookupExactOrderConversationLink('555001', {
    bridgeCall: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/v1/order-links/555001') {
        return {
          receipt_id: '555001',
          conversation_id: '1250240141',
          match: 'exact_etsy_system_message',
        };
      }
      if (
        path
        === '/v1/conversations/1250240141/history/sync?wait=true'
      ) {
        return { status: 'OK' };
      }
      throw new Error(`Unexpected Bridge call: ${path}`);
    },
  });

  expect(link.match).toBe('exact_etsy_system_message');
  expect(calls).toEqual([
    { path: '/v1/order-links/555001', options: {} },
    {
      path: '/v1/conversations/1250240141/history/sync?wait=true',
      options: { method: 'POST', timeoutMs: 180_000 },
    },
  ]);
});

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('event endpoint requires its scoped bearer token', async () => {
  await withTriggerEnv(async () => {
    const denied = response();
    await messageEventsHandler({
      method: 'GET',
      headers: {},
      query: {},
    }, denied);
    expect(denied.statusCode).toBe(401);
    expect(denied.body.code).toBe('MESSAGE_EVENT_AUTH_REQUIRED');

    const allowed = response();
    await messageEventsHandler({
      method: 'GET',
      headers: { authorization: 'Bearer event-service-test-token-1234567890' },
      query: {},
    }, allowed);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.data).toMatchObject({
      enabled: true,
      delivery_mode: 'draft_only',
      human_approval_required: true,
      worker: {
        version: 1,
        enabled: false,
        running: false,
        status: 'not_started',
      },
    });
  });
});

test('event endpoint accepts the Gmail relay ingestNotification payload alias', async () => {
  await withTriggerEnv(async () => {
    const res = response();
    await messageEventsHandler({
      method: 'POST',
      headers: { authorization: 'Bearer event-service-test-token-1234567890' },
      query: {},
      body: {
        action: 'ingestNotification',
        event_id: 'gmail-relay-1',
        type: 'new_message',
        shop_id: '12345678',
        conversation_id: '1250240141',
        source_message_id: 'message-9001',
        occurred_at: '2026-07-28T08:00:00.000Z',
        source: 'ionos_gmail_relay',
      },
    }, res);
    expect(res.statusCode).toBe(202);
    expect(res.body.data.queued).toMatchObject({
      duplicate: false,
      event: {
        event_id: 'gmail-relay-1',
        type: 'new_message',
        conversation_id: '1250240141',
      },
    });
    expect(res.body.data.due).toMatchObject({
      processed: 0,
      candidates: [],
      event_dispatch_scheduled: true,
      debounce_ms: 3000,
      fallback_worker: true,
    });
  });
});

test('order event without an Etsy conversation returns a bounded identity retry instead of 502', async () => {
  await withTriggerEnv(async () => {
    const res = response();
    await messageEventsHandler({
      method: 'POST',
      headers: { authorization: 'Bearer event-service-test-token-1234567890' },
      query: {},
      body: {
        action: 'ingestNotification',
        event_id: 'order-no-conversation-1',
        type: 'order_paid',
        shop_id: '12345678',
        receipt_id: '555001',
        occurred_at: '2026-07-28T08:00:00.000Z',
        process_due: false,
      },
    }, res, {
      hydrateOrderLinkedTriggerEvent: async () => {
        const error = new Error('No exact Etsy conversation link exists');
        error.status = 404;
        error.bridge_status = 404;
        throw error;
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({
      error: 'No Etsy conversation is linked to this receipt',
      code: 'MESSAGE_TRIGGER_ORDER_LINK_NOT_FOUND',
      data: { hydration: {
        hydrated: false,
        no_action: true,
        reason: 'No Etsy conversation is linked to this receipt',
      } },
    });
  });
});

test('local trigger worker does not schedule while disabled and prevents overlapping ticks', async () => {
  let intervals = 0;
  let timeouts = 0;
  const disabled = createMessageTriggerWorker({
    isEnabled: () => false,
    setIntervalFn: () => {
      intervals += 1;
      return {};
    },
    setTimeoutFn: () => {
      timeouts += 1;
      return {};
    },
  });
  expect(disabled.start()).toBe(false);
  expect(intervals).toBe(0);
  expect(timeouts).toBe(0);

  let release;
  let runs = 0;
  const persistedStatuses = [];
  const enabled = createMessageTriggerWorker({
    isEnabled: () => true,
    runDue: async () => {
      runs += 1;
      await new Promise(resolve => {
        release = resolve;
      });
      return { processed: 0, candidates: [] };
    },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    setTimeoutFn: () => ({ unref() {} }),
    persistStatus: async status => {
      persistedStatuses.push(status);
    },
    logger: { log() {}, error() {} },
  });
  expect(enabled.start()).toBe(true);
  const first = enabled.tick();
  const overlap = await enabled.tick();
  expect(overlap).toEqual({ skipped: true, reason: 'overlap' });
  expect(runs).toBe(1);
  release();
  await first;
  expect(enabled.status()).toMatchObject({
    enabled: true,
    running: false,
    last_processed: 0,
    last_error: null,
  });
  expect(enabled.stop()).toBe(true);
  await enabled.flushStatus();
  expect(persistedStatuses.some(status => status.running === true)).toBe(true);
  expect(persistedStatuses.at(-1)).toMatchObject({
    enabled: false,
    running: false,
    last_processed: 0,
  });
});

test('a crashed PROCESSING claim is reclaimed with a new token after its lease expires', async () => {
  await withTriggerEnv(async directory => {
    process.env.MESSAGE_TRIGGER_LEASE_SECONDS = '60';
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule({ scenario: 'freeform' })]),
    });
    const stateFile = path.join(directory, 'state.json');
    const crashedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const crashedCandidate = Object.values(crashedState.candidates)[0];
    crashedCandidate.status = 'PROCESSING';
    crashedCandidate.attempts = 1;
    crashedCandidate.processing_started_at = '2026-07-28T08:00:00.000Z';
    crashedCandidate.processing_claim_token = 'claim-from-crashed-process';
    fs.writeFileSync(stateFile, `${JSON.stringify(crashedState, null, 2)}\n`);

    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:02:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation(),
      loadPlaybook: async () => ({
        revision: 1,
        playbook: { scenarios: { freeform: { enabled: true } } },
      }),
      classifyNewMessage: async () => ({
        decision: 'route',
        rule_id: 'reply-question',
        scenario: 'freeform',
        confidence: 0.97,
        rationale: 'A configured custom reply applies.',
      }),
      generateDraft: async () => ({ ...readyDraft(), scenario: 'freeform' }),
      createDraft: async () => ({ id: 'draft-after-crash-reclaim' }),
      notifyDraftReady: async () => ({ delivered: true }),
    });

    expect(result.candidates[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: 'draft-after-crash-reclaim',
    });
    const recoveredState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const recoveredCandidate = Object.values(recoveredState.candidates)[0];
    expect(recoveredCandidate.attempts).toBe(2);
    expect(recoveredCandidate.processing_claim_token).toBeNull();
    expect(recoveredCandidate.processing_completed_at).toBeTruthy();
  });
});

test('a stale claimant cannot overwrite the result of a reclaimed candidate', async () => {
  await withTriggerEnv(async directory => {
    process.env.MESSAGE_TRIGGER_LEASE_SECONDS = '60';
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule({ scenario: 'freeform' })]),
    });
    let signalFirstDraftStarted;
    let releaseFirstDraft;
    const firstDraftStarted = new Promise(resolve => {
      signalFirstDraftStarted = resolve;
    });
    const firstDraftRelease = new Promise(resolve => {
      releaseFirstDraft = resolve;
    });
    const dependencies = draftId => ({
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation(),
      loadPlaybook: async () => ({
        revision: 1,
        playbook: { scenarios: { freeform: { enabled: true } } },
      }),
      classifyNewMessage: async () => ({
        decision: 'route',
        rule_id: 'reply-question',
        scenario: 'freeform',
        confidence: 0.97,
        rationale: 'A configured custom reply applies.',
      }),
      generateDraft: async () => ({ ...readyDraft(), scenario: 'freeform' }),
      createDraft: async () => ({ id: draftId }),
      notifyDraftReady: async () => ({ delivered: true }),
    });
    const firstDependencies = dependencies('draft-from-stale-claim');
    firstDependencies.createDraft = async () => {
      signalFirstDraftStarted();
      await firstDraftRelease;
      return { id: 'draft-from-stale-claim' };
    };

    const firstRun = runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, firstDependencies);
    await firstDraftStarted;

    const secondRun = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:02:01.000Z',
    }, dependencies('draft-from-reclaimed-claim'));
    expect(secondRun.candidates[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: 'draft-from-reclaimed-claim',
    });

    releaseFirstDraft();
    await firstRun;

    const finalState = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
    const finalCandidate = Object.values(finalState.candidates)[0];
    expect(finalCandidate).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: 'draft-from-reclaimed-claim',
      processing_claim_token: null,
    });
  });
});

test('notification failure retries without creating a duplicate Bridge draft', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule({ scenario: 'freeform' })]),
    });
    let draftCreates = 0;
    let notifications = 0;
    const dependencies = {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation(),
      loadPlaybook: async () => ({
        revision: 1,
        playbook: {
          scenarios: { freeform: { enabled: true } },
        },
      }),
      classifyNewMessage: async () => ({
        decision: 'route',
        rule_id: 'reply-question',
        scenario: 'freeform',
        confidence: 0.97,
        rationale: 'A configured custom reply applies.',
      }),
      generateDraft: async () => ({
        ...readyDraft(),
        scenario: 'freeform',
      }),
      createDraft: async () => {
        draftCreates += 1;
        return { id: 'draft-notification-retry' };
      },
      notifyDraftReady: async () => {
        notifications += 1;
        if (notifications === 1) throw new Error('Telegram temporarily unavailable');
        return { delivered: true, message_id: 444, chat_id: '-1001' };
      },
    };

    const first = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, dependencies);
    expect(first.candidates[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: 'draft-notification-retry',
      notification_status: 'RETRYABLE_ERROR',
    });
    expect(draftCreates).toBe(1);

    const retry = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:03:00.000Z',
    }, dependencies);
    expect(retry.processed).toBe(0);
    expect(retry.notifications_processed).toBe(1);
    expect(retry.notifications[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: 'draft-notification-retry',
      notification_status: 'SENT',
    });
    expect(draftCreates).toBe(1);
    expect(notifications).toBe(2);
  });
});

test('a newly blocked evidence check emits one durable Telegram debug notification', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule({ scenario: 'freeform' })]),
    });
    let notifications = 0;
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation({
        messages: [{
          source_id: 'message-9001',
          direction: 'unknown',
          sender: 'Ilya',
          body: 'Can I send files here?',
        }],
      }),
      notifyEvidenceBlocked: async candidate => {
        notifications += 1;
        expect(candidate).toMatchObject({
          status: 'BLOCKED',
          block_code: 'MESSAGE_TRIGGER_SOURCE_DIRECTION_UNKNOWN',
          participant: 'Ilya',
        });
        return { delivered: true, message_id: 778, chat_id: '-1001' };
      },
    });

    expect(result.candidates[0]).toMatchObject({
      status: 'BLOCKED',
      block_code: 'MESSAGE_TRIGGER_SOURCE_DIRECTION_UNKNOWN',
      debug_notification_status: 'PENDING',
    });
    expect(result.debug_notifications_processed).toBe(1);
    expect(result.debug_notifications[0]).toMatchObject({
      debug_notification_status: 'SENT',
    });
    expect(notifications).toBe(1);

    const second = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:02:00.000Z',
    }, {
      notifyEvidenceBlocked: async () => {
        notifications += 1;
        return { delivered: true };
      },
    });
    expect(second.debug_notifications_processed).toBe(0);
    expect(notifications).toBe(1);
  });
});

test('operator draft actions reconcile trigger status and retain resolution audit history', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule({ scenario: 'freeform' })]),
    });
    const dependencies = {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation(),
      loadPlaybook: async () => ({
        revision: 1,
        playbook: {
          scenarios: { freeform: { enabled: true } },
        },
      }),
      classifyNewMessage: async () => ({
        decision: 'route',
        rule_id: 'reply-question',
        scenario: 'freeform',
        confidence: 0.97,
        rationale: 'A configured custom reply applies.',
      }),
      generateDraft: async () => readyDraft(),
      createDraft: async () => ({ id: 'draft-resolution-1' }),
      notifyDraftReady: async () => ({ delivered: true }),
    };
    await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, dependencies);
    const before = (await getMessageTriggerStatus()).items[0];
    expect(before).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: 'draft-resolution-1',
    });

    const approved = await reconcileMessageTriggerDraft({
      draft_id: 'draft-resolution-1',
      action: 'approveDraft',
      actor: { id: 'manager-1', name: 'Manager One' },
      bridge_status: 'APPROVED',
      reconciled_at: '2026-07-28T08:02:00.000Z',
    });
    expect(approved.matched).toBe(1);
    expect(approved.candidates[0]).toMatchObject({
      id: before.id,
      event_id: before.event_id,
      rule_id: before.rule_id,
      draft_id: 'draft-resolution-1',
      status: 'APPROVED',
      draft_status: 'APPROVED',
      draft_reconciled_at: '2026-07-28T08:02:00.000Z',
      draft_resolution_history: [{
        action: 'approveDraft',
        status: 'APPROVED',
        bridge_status: 'APPROVED',
        actor: { id: 'manager-1', name: 'Manager One' },
        reason: null,
        reconciled_at: '2026-07-28T08:02:00.000Z',
      }],
    });

    const sent = await reconcileMessageTriggerDraft({
      draft_id: 'draft-resolution-1',
      action: 'sendApprovedDraft',
      actor: { id: 'manager-1', name: 'Manager One' },
      bridge_status: 'SENT',
      reconciled_at: '2026-07-28T08:03:00.000Z',
    });
    expect(sent.candidates[0]).toMatchObject({
      id: before.id,
      event_id: before.event_id,
      rule_id: before.rule_id,
      status: 'SENT',
      draft_status: 'SENT',
    });
    expect(sent.candidates[0].draft_resolution_history).toEqual([
      expect.objectContaining({ action: 'approveDraft', status: 'APPROVED' }),
      expect.objectContaining({ action: 'sendApprovedDraft', status: 'SENT' }),
    ]);
  });
});

test('skip and block draft reconciliation use explicit terminal statuses', async () => {
  await withTriggerEnv(async directory => {
    const stateFile = path.join(directory, 'state.json');
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
      notification_status: 'SENT',
      created_at: '2026-07-28T08:00:00.000Z',
      updated_at: '2026-07-28T08:00:00.000Z',
    };
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      events: {},
      candidates: {
        skipped: { ...baseCandidate, id: 'skipped', draft_id: '81' },
        blocked: { ...baseCandidate, id: 'blocked', draft_id: '82' },
      },
    }));

    await reconcileMessageTriggerDraft({
      draft_id: '81',
      action: 'skipDraft',
      actor: { id: 'manager-2', name: 'Manager Two' },
      reason: 'No reply needed',
      reconciled_at: '2026-07-28T08:04:00.000Z',
    });
    await reconcileMessageTriggerDraft({
      draft_id: '82',
      action: 'blockDraft',
      actor: { id: 'manager-2', name: 'Manager Two' },
      reason: 'Unsafe context',
      reconciled_at: '2026-07-28T08:05:00.000Z',
    });

    const items = (await getMessageTriggerStatus()).items;
    expect(items.find(item => item.id === 'skipped')).toMatchObject({
      status: 'SKIPPED',
      draft_status: 'SKIPPED',
      draft_resolution_history: [
        expect.objectContaining({
          action: 'skipDraft',
          reason: 'No reply needed',
        }),
      ],
    });
    expect(items.find(item => item.id === 'blocked')).toMatchObject({
      status: 'BLOCKED',
      draft_status: 'BLOCKED',
      draft_resolution_history: [
        expect.objectContaining({
          action: 'blockDraft',
          reason: 'Unsafe context',
        }),
      ],
    });
  });
});

test('universal assistant fallback is opt-in and only augments new-message rules', async () => {
  await withTriggerEnv(async () => {
    const narrowRule = rule({
      id: 'new_message_how_to_order',
      scenario: 'how_to_order',
      event: 'new_message',
    });
    expect(messageUniversalAssistantEnabled()).toBe(false);
    expect(messageTriggerRulesForEvent({ rules: [narrowRule] }, 'new_message'))
      .toEqual([narrowRule]);

    process.env.MESSAGE_UNIVERSAL_ASSISTANT_ENABLED = 'true';
    expect(messageUniversalAssistantEnabled()).toBe(true);
    const routedRules = messageTriggerRulesForEvent(
      { rules: [narrowRule] },
      'new_message',
    );
    expect(routedRules).toHaveLength(2);
    expect(routedRules[0]).toEqual(narrowRule);
    expect(routedRules[1]).toMatchObject({
      id: 'new_message_universal_assistant',
      event: 'new_message',
      scenario: 'freeform',
      enabled: true,
      require_order_context: false,
      delay_minutes: 0,
      cooldown_minutes: 0,
    });
    expect(buildUniversalAssistantRule().conditions).toContain('Fallback only');
    expect(messageTriggerRulesForEvent({ rules: [] }, 'order_paid')).toEqual([]);

    const existingFreeform = rule({
      id: 'custom-freeform',
      scenario: 'freeform',
      event: 'new_message',
    });
    expect(messageTriggerRulesForEvent(
      { rules: [narrowRule, existingFreeform] },
      'new_message',
    )).toEqual([
      narrowRule,
      existingFreeform,
      expect.objectContaining({ id: 'new_message_universal_assistant' }),
    ]);
  });
});

test('draft suggestions prefer the dedicated Telegram destination', async () => {
  await withTriggerEnv(async () => {
    process.env.MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED = 'true';
    process.env.MESSAGE_TELEGRAM_BOT_TOKEN = 'dedicated-message-token';
    process.env.MESSAGE_APPROVALS_CHAT_ID = '-100111';
    process.env.MESSAGE_APPROVALS_THREAD_ID = '77';
    process.env.MESSAGE_SUGGESTIONS_CHAT_ID = '-1004403416789';
    process.env.MESSAGE_SUGGESTIONS_THREAD_ID = '88';
    process.env.PUBLIC_BASE_URL = 'https://dashboard.example.test';
    let payload;
    const delivered = await notifyMessageDraftReady({
      draft_id: '92',
      participant: 'Buyer',
      scenario: 'freeform',
      source_message_preview: 'Can you make the background lighter?',
      draft_preview: 'Yes, I can make the background lighter.',
    }, {
      fetchImpl: async (_url, options) => {
        payload = JSON.parse(options.body);
        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 913,
            chat: { id: -1004403416789 },
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    expect(delivered).toMatchObject({
      delivered: true,
      chat_id: '-1004403416789',
      message_id: 913,
    });
    expect(payload).toMatchObject({
      chat_id: '-1004403416789',
      message_thread_id: 88,
    });
  });
});

test('draft suggestions fall back to the legacy approval chat only after an explicit Telegram rejection', async () => {
  await withTriggerEnv(async () => {
    process.env.MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED = 'true';
    process.env.MESSAGE_TELEGRAM_BOT_TOKEN = 'dedicated-message-token';
    process.env.MESSAGE_APPROVALS_CHAT_ID = '-100111';
    process.env.MESSAGE_APPROVALS_THREAD_ID = '77';
    process.env.MESSAGE_SUGGESTIONS_CHAT_ID = '-1004403416789';
    process.env.PUBLIC_BASE_URL = 'https://dashboard.example.test';
    const payloads = [];
    const delivered = await notifyMessageDraftReady({
      draft_id: '93',
      participant: 'Buyer',
      scenario: 'freeform',
      source_message_preview: 'Can you make it warmer?',
      draft_preview: 'Yes, I can make the colors warmer.',
    }, {
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body);
        payloads.push(payload);
        if (payload.chat_id === '-1004403416789') {
          return new Response(JSON.stringify({
            ok: false,
            description: 'Bad Request: chat not found',
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          ok: true,
          result: { message_id: 914, chat: { id: -100111 } },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    expect(payloads).toEqual([
      expect.objectContaining({ chat_id: '-1004403416789', message_thread_id: 77 }),
      expect.objectContaining({ chat_id: '-100111', message_thread_id: 77 }),
    ]);
    expect(delivered).toMatchObject({
      delivered: true,
      chat_id: '-100111',
      message_id: 914,
      fallback_used: true,
      preferred_chat_id: '-1004403416789',
      preferred_error: 'Bad Request: chat not found',
    });
  });
});

test('draft suggestions do not fall back after an ambiguous network failure', async () => {
  await withTriggerEnv(async () => {
    process.env.MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED = 'true';
    process.env.MESSAGE_TELEGRAM_BOT_TOKEN = 'dedicated-message-token';
    process.env.MESSAGE_APPROVALS_CHAT_ID = '-100111';
    process.env.MESSAGE_SUGGESTIONS_CHAT_ID = '-1004403416789';
    process.env.PUBLIC_BASE_URL = 'https://dashboard.example.test';
    let calls = 0;
    await expect(notifyMessageDraftReady({
      draft_id: '94',
      participant: 'Buyer',
      scenario: 'freeform',
    }, {
      fetchImpl: async () => {
        calls += 1;
        throw new Error('connection reset');
      },
    })).rejects.toMatchObject({
      code: 'MESSAGE_NOTIFICATION_DELIVERY_FAILED',
      message: 'Telegram notification request failed',
    });
    expect(calls).toBe(1);
  });
});

test('draft notification never falls back to the generic Telegram bot token', async () => {
  await withTriggerEnv(async () => {
    process.env.MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'generic-hermes-token';
    process.env.MESSAGE_APPROVALS_CHAT_ID = '-100123';
    process.env.PUBLIC_BASE_URL = 'https://dashboard.example.test';
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await expect(notifyMessageDraftReady({
      draft_id: '91',
      participant: 'Buyer',
      scenario: 'freeform',
    }, { fetchImpl })).rejects.toMatchObject({
      code: 'MESSAGE_NOTIFICATION_NOT_CONFIGURED',
      status: 503,
    });
    expect(fetchCalls).toBe(0);

    process.env.MESSAGE_TELEGRAM_BOT_TOKEN = 'dedicated-message-token';
    const urls = [];
    const payloads = [];
    const delivered = await notifyMessageDraftReady({
      draft_id: '91',
      participant: 'María',
      scenario: 'how_to_send_files',
      conversation_id: '1250240141',
      receipt_id: '4053136295',
      reason: 'The buyer asked where to attach photos.',
      source_message_preview: '¿Dónde puedo enviar las fotos?',
      draft_preview: 'You can attach the photos directly in this Etsy conversation.',
    }, {
      fetchImpl: async (url, options) => {
        urls.push(String(url));
        payloads.push(JSON.parse(options.body));
        return new Response(JSON.stringify({
          ok: true,
          result: { message_id: 812, chat: { id: -100123 } },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    expect(delivered).toMatchObject({
      delivered: true,
      message_id: 812,
      chat_id: '-100123',
    });
    expect(urls).toEqual([
      'https://api.telegram.org/botdedicated-message-token/sendMessage',
    ]);
    expect(payloads[0]).toMatchObject({
      chat_id: '-100123',
      disable_web_page_preview: true,
      parse_mode: 'HTML',
    });
    expect(payloads[0].text).toContain('💬 <b>Etsy · María</b>');
    expect(payloads[0].text).toContain('Замовлення <b>#4053136295</b>');
    expect(payloads[0].text).toContain('<b>Останні повідомлення</b>');
    expect(payloads[0].text).toContain(
      '👤 <b>Клієнт</b>: ¿Dónde puedo enviar las fotos?',
    );
    expect(payloads[0].text).toContain('✨ <b>Пропозиція відповіді</b>');
    expect(payloads[0].text).toContain(
      'You can attach the photos directly in this Etsy conversation.',
    );
    expect(payloads[0].text).toContain('Нічого не відправлено. Це лише чернетка');
    expect(payloads[0].text).not.toContain('Conversation:');
    expect(payloads[0].text).not.toContain('The buyer asked where to attach photos.');
    expect(payloads[0].reply_markup.inline_keyboard[0][0]).toEqual({
      text: 'Відкрити в Etsy AI Command Center',
      url: 'https://dashboard.example.test/#messages?tab=queue&draft_id=91',
    });
  });
});

test('draft notification rejects unsafe IDs, wrong chats, and token-bearing network errors', async () => {
  await withTriggerEnv(async () => {
    process.env.MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED = 'true';
    process.env.MESSAGE_TELEGRAM_BOT_TOKEN = 'dedicated-message-token';
    process.env.MESSAGE_APPROVALS_CHAT_ID = '-100123';
    process.env.PUBLIC_BASE_URL = 'https://dashboard.example.test';

    await expect(notifyMessageDraftReady({
      draft_id: '../91',
      participant: 'Buyer',
      scenario: 'freeform',
    }, {
      fetchImpl: async () => {
        throw new Error('must not be called');
      },
    })).rejects.toMatchObject({
      code: 'MESSAGE_NOTIFICATION_NOT_CONFIGURED',
    });

    await expect(notifyMessageDraftReady({
      draft_id: '91',
      participant: 'Buyer',
      scenario: 'freeform',
    }, {
      fetchImpl: async () => new Response(JSON.stringify({
        ok: true,
        result: { message_id: 812, chat: { id: -100999 } },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    })).rejects.toMatchObject({
      code: 'MESSAGE_NOTIFICATION_DESTINATION_MISMATCH',
    });

    await expect(notifyMessageDraftReady({
      draft_id: '91',
      participant: 'Buyer',
      scenario: 'freeform',
    }, {
      fetchImpl: async url => {
        throw new Error(`network failed for ${url}`);
      },
    })).rejects.toMatchObject({
      code: 'MESSAGE_NOTIFICATION_DELIVERY_FAILED',
      message: 'Telegram notification request failed',
    });
  });
});

test('evidence debug notification uses the dedicated Messages destination and names missing facts', async () => {
  await withTriggerEnv(async () => {
    process.env.MESSAGE_EVIDENCE_DEBUG_NOTIFICATIONS_ENABLED = 'true';
    process.env.MESSAGE_TELEGRAM_BOT_TOKEN = 'dedicated-message-token';
    process.env.MESSAGE_APPROVALS_CHAT_ID = '-100123';
    process.env.MESSAGE_EVIDENCE_DEBUG_CHAT_ID = '551234567';
    process.env.PUBLIC_BASE_URL = 'https://dashboard.example.test';
    let payload;
    const delivered = await notifyMessageEvidenceBlocked({
      participant: 'Buyer Name',
      scenario: 'missing_materials',
      conversation_id: '1250240141',
      receipt_id: '4053136295',
      block_code: 'MESSAGE_TRIGGER_MADE_TO_ORDER_UNVERIFIED',
      block_reason: 'Official listing facts are incomplete',
      evidence_gaps: [
        'official receipt automation facts',
        'official listing when_made check',
      ],
    }, {
      fetchImpl: async (_url, options) => {
        payload = JSON.parse(options.body);
        return new Response(JSON.stringify({
          ok: true,
          result: { message_id: 913, chat: { id: 551234567 } },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    expect(delivered).toMatchObject({ delivered: true, message_id: 913 });
    expect(payload.chat_id).toBe('551234567');
    expect(payload.text).toContain('потрібна перевірка даних');
    expect(payload.text).toContain('актуальні офіційні дані Etsy receipt');
    expect(payload.text).toContain('Чернетку не створено');
    expect(payload.text).toContain(
      'https://dashboard.example.test/#messages?tab=inbox&conversation_id=1250240141',
    );
  });
});

test('draft reconciliation rejects an unexpected Bridge terminal status without mutation', async () => {
  await withTriggerEnv(async directory => {
    const stateFile = path.join(directory, 'state.json');
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
          draft_id: '92',
          due_at: '2026-07-28T08:00:00.000Z',
          attempts: 1,
          created_at: '2026-07-28T08:00:00.000Z',
          updated_at: '2026-07-28T08:00:00.000Z',
        },
      },
    }));

    await expect(reconcileMessageTriggerDraft({
      draft_id: '92',
      action: 'sendApprovedDraft',
      actor: { id: 'manager-1', name: 'Manager One' },
      bridge_status: 'APPROVED',
    })).rejects.toMatchObject({
      code: 'MESSAGE_TRIGGER_DRAFT_STATUS_MISMATCH',
      status: 502,
    });
    expect((await getMessageTriggerStatus()).items[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_id: '92',
      draft_status: null,
      draft_resolution_history: [],
    });
  });
});

test('new-message processing syncs targeted overlap before load and suppresses a newly visible reply', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule()]),
    });
    const calls = [];
    let refreshed = false;
    let routerCalls = 0;
    let draftCreates = 0;
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:02:00.000Z',
    }, {
      syncConversation: async id => {
        calls.push(`sync:${id}`);
        refreshed = true;
      },
      loadConversation: async id => {
        calls.push(`load:${id}`);
        expect(refreshed).toBe(true);
        return incomingConversation({
          messages: [{
            source_id: 'shop-newer',
            direction: 'outgoing',
            sender: 'Shop',
            sent_at: '2026-07-28T08:01:00.000Z',
          }, {
            source_id: 'message-9001',
            direction: 'incoming',
            sender: 'Buyer',
            sent_at: '2026-07-28T08:00:00.000Z',
          }],
        });
      },
      classifyNewMessage: async () => {
        routerCalls += 1;
        return routeHowToSendFiles();
      },
      createDraft: async () => {
        draftCreates += 1;
        return { id: 'must-not-exist' };
      },
    });

    expect(calls).toEqual([
      'sync:1250240141',
      'load:1250240141',
    ]);
    expect(result.candidates[0]).toMatchObject({
      status: 'IGNORED_NO_ACTION',
      block_code: 'MESSAGE_TRIGGER_ALREADY_ANSWERED',
    });
    expect(routerCalls).toBe(0);
    expect(draftCreates).toBe(0);
  });
});

test('new-message processing retries closed when targeted history sync fails', async () => {
  await withTriggerEnv(async () => {
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([rule()]),
    });
    let loads = 0;
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:02:00.000Z',
    }, {
      syncConversation: async () => {
        throw new Error('Bridge overlap sync unavailable');
      },
      loadConversation: async () => {
        loads += 1;
        return incomingConversation();
      },
    });

    expect(result.candidates[0]).toMatchObject({
      status: 'RETRYABLE_ERROR',
      last_error: 'Bridge overlap sync unavailable',
    });
    expect(loads).toBe(0);
  });
});


test('universal freeform enriches exact order and listing context without making it mandatory', async () => {
  await withTriggerEnv(async () => {
    process.env.MESSAGE_UNIVERSAL_ASSISTANT_ENABLED = 'true';
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([]),
    });

    let generatedInput;
    let orderLoads = 0;
    const conversation = incomingConversation({
      receipt_ids: ['4130532997'],
      messages: [{
        source_id: 'message-9001',
        direction: 'incoming',
        sender: 'Buyer',
        body: 'Can we keep working from the version I picked?',
      }],
    });

    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => conversation,
      loadPlaybook: async () => ({
        revision: 3,
        playbook: { scenarios: { freeform: { enabled: true } } },
      }),
      classifyNewMessage: async ({ rules }) => {
        expect(rules.map(item => item.id)).toContain('new_message_universal_assistant');
        return {
          decision: 'route',
          rule_id: 'new_message_universal_assistant',
          scenario: 'freeform',
          confidence: 0.98,
          rationale: 'The buyer needs a contextual shop reply.',
        };
      },
      loadOrderFacts: async ({ receiptId }) => {
        orderLoads += 1;
        expect(receiptId).toBe('4130532997');
        return {
          order: {
            linked: true,
            paid: true,
            receipt_id: '4130532997',
            checked_at: '2026-07-28T08:00:30.000Z',
          },
        };
      },
      loadOrderListingFacts: async () => ({
        listing: {
          verified: true,
          listing_id: '1234567890',
          title: 'Custom portrait',
        },
        unavailable_reason: null,
      }),
      loadListingFacts: async () => ({ listing: null, unavailable_reason: null }),
      loadShopStyleReference: async () => ({ available: false }),
      generateDraft: async input => {
        generatedInput = input;
        return {
          ...readyDraft(),
          scenario: 'freeform',
          reply_body: 'Yes, we can continue from the version you selected.',
        };
      },
      createDraft: async () => ({ id: 'draft-freeform-context' }),
      notifyDraftReady: async () => ({ status: 'disabled' }),
    });

    expect(orderLoads).toBe(1);
    expect(generatedInput.verifiedFacts).toMatchObject({
      order: {
        linked: true,
        paid: true,
        receipt_id: '4130532997',
      },
      listing: {
        verified: true,
        listing_id: '1234567890',
      },
    });
    expect(result.candidates[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      scenario: 'freeform',
      receipt_id: '4130532997',
    });
  });
});

test('universal freeform still drafts when optional order enrichment is unavailable', async () => {
  await withTriggerEnv(async () => {
    process.env.MESSAGE_UNIVERSAL_ASSISTANT_ENABLED = 'true';
    await enqueueMessageTriggerEvent(newMessageEvent(), {
      loadPolicy: policy([]),
    });

    let generated = false;
    const result = await runDueMessageTriggerCandidates({
      now: '2026-07-28T08:01:00.000Z',
    }, {
      syncConversation: async () => {},
      loadConversation: async () => incomingConversation({
        receipt_ids: ['4130532997'],
        messages: [{
          source_id: 'message-9001',
          direction: 'incoming',
          sender: 'Buyer',
          body: 'Could you make that version a little warmer?',
        }],
      }),
      loadPlaybook: async () => ({
        revision: 3,
        playbook: { scenarios: { freeform: { enabled: true } } },
      }),
      classifyNewMessage: async () => ({
        decision: 'route',
        rule_id: 'new_message_universal_assistant',
        scenario: 'freeform',
        confidence: 0.97,
        rationale: 'Contextual revision request.',
      }),
      loadOrderFacts: async () => {
        throw new Error('temporary order context outage');
      },
      loadListingFacts: async () => {
        throw new Error('temporary listing context outage');
      },
      loadShopStyleReference: async () => ({ available: false }),
      generateDraft: async input => {
        generated = true;
        expect(input.verifiedFacts).toEqual({});
        return {
          ...readyDraft(),
          scenario: 'freeform',
          reply_body: 'Yes, I can make that version a little warmer.',
        };
      },
      createDraft: async () => ({ id: 'draft-freeform-fallback' }),
      notifyDraftReady: async () => ({ status: 'disabled' }),
    });

    expect(generated).toBe(true);
    expect(result.candidates[0]).toMatchObject({
      status: 'AWAITING_APPROVAL',
      scenario: 'freeform',
    });
  });
});
