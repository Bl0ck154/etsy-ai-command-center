import { expect, test } from '@playwright/test';

import {
  exactReceiptIdFromBridgeConversation,
  fetchOrderContextByReceiptId,
} from '../api/messages/order-context-client.js';
import {
  loadVerifiedOrderFactsForConversation,
  mergeOrderContextEvidence,
} from '../api/messages/order-context-evidence.js';

const TOKEN = 'test-order-context-token-that-is-long-enough';
const GENERATED_AT = '2026-07-28T10:00:00.000Z';

function upstreamResponse(overrides = {}) {
  return {
    schema_version: 1,
    generated_at: GENERATED_AT,
    match: {
      status: 'exact',
      confidence: 1,
      method: 'order_id_runtime_map',
    },
    context: {
      order: {
        order_id: '4053136295',
        workflow: {
          status: 'IN_PROGRESS',
          completed: false,
          provenance: [{
            source: 'trello_card',
            reference: 'card-1',
            observed_at: '2026-07-28T09:55:00Z',
          }],
        },
        deadline: {
          at: '2026-07-29T10:00:00Z',
          state: 'due_soon',
          provenance: [{
            source: 'trello_card',
            reference: 'card-1',
            field: 'due',
          }],
        },
      },
      materials: {
        sources: {
          trello_attachments: {
            state: 'not_found',
            count: 0,
            items: [],
            coverage: 'card_attachments_except_listing_cover',
          },
          email_attachments: {
            state: 'not_found',
            count: 0,
            items: [],
            coverage: 'emails_already_matched_and_mirrored_to_trello',
          },
          google_drive: {
            state: 'not_found',
            count: 0,
            items: [],
            coverage: 'direct_files_in_order_folder',
          },
        },
      },
      variants: {
        prepared: {
          state: 'not_found',
          count: 0,
          items: [],
          link: null,
        },
      },
    },
    ...overrides,
  };
}

function bridgeConversation(overrides = {}) {
  return {
    conversation: {
      source_id: 'conversation-1',
      receipt_ids: ['4053136295'],
      history_synced_at: '2026-07-28T09:58:00Z',
      ...overrides.conversation,
    },
    messages: overrides.messages || [],
  };
}

test('read-only client sends an authenticated exact receipt GET', async () => {
  const calls = [];
  const data = upstreamResponse();
  const result = await fetchOrderContextByReceiptId('4053136295', {
    baseUrl: 'http://127.0.0.1:8092/',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  expect(result).toEqual(data);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(
    'http://127.0.0.1:8092/internal/v1/orders/4053136295/context',
  );
  expect(calls[0].options).toMatchObject({
    method: 'GET',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
    },
  });
  expect(calls[0].options.body).toBeUndefined();
});

test('on-demand email claim check lets IONOS derive verified paid_at', async () => {
  let requestedUrl = '';
  await fetchOrderContextByReceiptId('4053136295', {
    baseUrl: 'http://127.0.0.1:8092',
    token: TOKEN,
    checkEmailClaim: true,
    fetchImpl: async url => {
      requestedUrl = String(url);
      return new Response(JSON.stringify(upstreamResponse()), { status: 200 });
    },
  });
  const parsed = new URL(requestedUrl);
  expect(parsed.pathname).toBe(
    '/internal/v1/orders/4053136295/context',
  );
  expect(parsed.searchParams.get('gmail_claim_check')).toBe('1');
  expect(parsed.searchParams.has('gmail_after')).toBe(false);
});

test('client rejects invalid IDs before making a network request', async () => {
  let called = false;
  await expect(fetchOrderContextByReceiptId('../resolve', {
    baseUrl: 'http://127.0.0.1:8092',
    token: TOKEN,
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  })).rejects.toMatchObject({
    status: 400,
    code: 'ORDER_CONTEXT_INVALID_RECEIPT_ID',
  });
  expect(called).toBe(false);
});

test('client rejects non-exact and mismatched upstream responses', async () => {
  const fetchImpl = async () => new Response(JSON.stringify(upstreamResponse({
    match: { status: 'unique', confidence: 0.9 },
  })), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await expect(fetchOrderContextByReceiptId('4053136295', {
    baseUrl: 'http://127.0.0.1:8092',
    token: TOKEN,
    fetchImpl,
  })).rejects.toMatchObject({
    status: 502,
    code: 'ORDER_CONTEXT_INVALID_RESPONSE',
  });
});

test('client maps not-found and authentication failures without leaking details', async () => {
  await expect(fetchOrderContextByReceiptId('4053136295', {
    baseUrl: 'http://127.0.0.1:8092',
    token: TOKEN,
    fetchImpl: async () => new Response('{"detail":"missing"}', { status: 404 }),
  })).rejects.toMatchObject({
    status: 404,
    code: 'ORDER_CONTEXT_NOT_FOUND',
  });

  await expect(fetchOrderContextByReceiptId('4053136295', {
    baseUrl: 'http://127.0.0.1:8092',
    token: TOKEN,
    fetchImpl: async () => new Response(
      '{"detail":"token invalid: do not expose this"}',
      { status: 401 },
    ),
  })).rejects.toMatchObject({
    status: 503,
    code: 'ORDER_CONTEXT_AUTH_FAILED',
    message: 'IONOS Order Context API authentication failed',
  });
});

test('exact receipt helper fails closed for zero or multiple receipts', () => {
  expect(exactReceiptIdFromBridgeConversation({
    receipt_ids: ['4053136295'],
    order_refs: [{ receipt_id: '4053136295' }],
  })).toBe('4053136295');
  expect(() => exactReceiptIdFromBridgeConversation({
    receipt_ids: [],
  })).toThrow(/no exact Etsy receipt_id/i);
  expect(() => exactReceiptIdFromBridgeConversation({
    receipt_ids: ['4053136295', '4053136296'],
  })).toThrow(/multiple receipt IDs/i);
});

test('merger treats an explicitly empty Trello operational record as missing without Gmail', () => {
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: upstreamResponse(),
    bridgeConversation: bridgeConversation(),
  });

  expect(facts.order).toMatchObject({
    linked: true,
    receipt_id: '4053136295',
    checked_at: GENERATED_AT,
  });
  expect(facts.materials).toMatchObject({
    missing: true,
    operational_record_checked: true,
    absence_basis: 'trello_operational_record_empty',
    all_channels_checked: false,
    sources: {
      etsy: { checked: true, received: false },
      listing_upload: { checked: true, received: false },
      email: {
        checked: false,
        received: null,
        reason: 'negative_coverage_is_not_comprehensive',
      },
      drive: { checked: true, received: false },
    },
  });
});

test('merger proves missing materials when the new Gmail source is exhaustive', () => {
  const response = upstreamResponse();
  response.context.materials.sources.gmail_attachments = {
    state: 'not_found',
    count: 0,
    items: [],
    coverage: 'all_order_emails_searched',
  };
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: response,
    bridgeConversation: bridgeConversation(),
  });

  expect(facts.materials).toMatchObject({
    missing: true,
    all_channels_checked: true,
    sources: {
      etsy: { checked: true, received: false },
      listing_upload: { checked: true, received: false },
      email: { checked: true, received: false },
      drive: { checked: true, received: false },
    },
  });
});

test('legacy partial email mirror does not override the empty Trello operational record', () => {
  const response = upstreamResponse();
  response.context.materials.sources.email_attachments.coverage = (
    'all_order_emails_searched'
  );
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: response,
    bridgeConversation: bridgeConversation(),
  });

  expect(facts.materials.missing).toBe(true);
  expect(facts.materials.sources.email).toMatchObject({
    checked: false,
    received: null,
  });
});

test('merger treats an incoming Etsy attachment as positive material evidence', () => {
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: upstreamResponse(),
    bridgeConversation: bridgeConversation({
      messages: [{
        source_id: 'message-1',
        direction: 'incoming',
        sent_at: '2026-07-28T09:30:00Z',
        attachments: [{
          id: 42,
          source_id: 'etsy-attachment-1',
          filename: 'buyer-photo.png',
        }],
      }],
    }),
  });

  expect(facts.materials.missing).toBe(false);
  expect(facts.materials.sources.etsy).toMatchObject({
    checked: true,
    received: true,
    provenance: [{
      source: 'etsy_message_attachment',
      reference: 'etsy-attachment-1',
      name: 'buyer-photo.png',
      source_message_id: 'message-1',
    }],
  });
});

test('empty Trello operational record remains authoritative when Etsy history is incomplete', () => {
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: upstreamResponse(),
    bridgeConversation: bridgeConversation({
      conversation: { history_synced_at: null },
    }),
  });

  expect(facts.materials.missing).toBe(true);
  expect(facts.materials.all_channels_checked).toBe(false);
  expect(facts.materials.sources.etsy).toMatchObject({
    checked: false,
    received: null,
    reason: 'bridge_history_sync_required',
  });
});

test('merger preserves external positive provenance', () => {
  const response = upstreamResponse();
  response.context.materials.sources.email_attachments = {
    state: 'present',
    count: 1,
    coverage: 'emails_already_matched_and_mirrored_to_trello',
    items: [{
      source: 'gmail_via_trello_comment',
      reference: 'comment-1',
      observed_at: '2026-07-28T09:40:00Z',
      evidence: 'email_attachment_section',
    }],
  };
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: response,
    bridgeConversation: bridgeConversation(),
  });

  expect(facts.materials.missing).toBe(false);
  expect(facts.materials.sources.email).toMatchObject({
    checked: true,
    received: true,
    provenance: [{
      source: 'gmail_via_trello_comment',
      reference: 'comment-1',
      evidence: 'email_attachment_section',
    }],
  });
});

test('new Gmail positive evidence wins even when the partial mirror is empty', () => {
  const response = upstreamResponse();
  response.context.materials.sources.gmail_attachments = {
    state: 'present',
    count: 1,
    coverage: 'all_order_emails_searched',
    items: [{
      source: 'gmail_attachment',
      reference: 'gmail-message-1:photo.jpg',
      observed_at: '2026-07-28T09:42:00Z',
      name: 'photo.jpg',
    }],
  };
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: response,
    bridgeConversation: bridgeConversation(),
  });

  expect(facts.materials.missing).toBe(false);
  expect(facts.materials.sources.email).toMatchObject({
    checked: true,
    received: true,
    coverage: 'all_order_emails_searched',
    provenance: [{
      source: 'gmail_attachment',
      reference: 'gmail-message-1:photo.jpg',
      name: 'photo.jpg',
    }],
  });
});

test('merger exposes only safe personal-sender confirmation metadata', () => {
  const response = upstreamResponse();
  response.context.materials.sources.gmail_attachments = {
    state: 'candidate',
    received: null,
    count: 0,
    coverage: 'gmail_private_attachment_candidate_from_order_paid_at',
    reason: 'possible_personal_sender_requires_review',
    search_since: '2026-07-20T10:00:00Z',
    search_basis: 'verified_order_paid_at',
    confirmation_candidates: [{
      source: 'gmail_personal_sender_candidate',
      reference: 'gmail-message-1',
      observed_at: '2026-07-28T09:20:00Z',
      sender_name: 'Federica Wasilewska',
      attachment_count: 1,
      attachments: [{ name: 'photo.jpg', mime_type: 'image/jpeg', size: 123 }],
    }],
  };
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: response,
    bridgeConversation: bridgeConversation(),
  });
  expect(facts.materials.email_claim).toMatchObject({
    checked: true,
    checked_since: '2026-07-20T10:00:00.000Z',
    possible_match_requires_review: true,
    confirmation_required: false,
    exact_customer_attachments_received: false,
    candidates: [{
      sender_name: 'Federica Wasilewska',
      attachment_count: 1,
    }],
  });
});

test('merger verifies variant delivery only from an exact outgoing Etsy link', () => {
  const response = upstreamResponse();
  response.context.variants.prepared = {
    state: 'present',
    count: 1,
    link: 'https://drive.google.com/drive/folders/result-1',
    items: [{
      source: 'google_drive_result_folder',
      reference: 'result-file',
    }],
  };
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: response,
    bridgeConversation: bridgeConversation({
      messages: [{
        source_id: 'seller-message-1',
        direction: 'outgoing',
        sent_at: '2026-07-28T09:45:00Z',
        body: (
          'Here are your variants: '
          + 'https://drive.google.com/drive/folders/result-1'
        ),
      }],
    }),
  });

  expect(facts.variants).toMatchObject({
    prepared: true,
    sent: true,
    result_url: 'https://drive.google.com/drive/folders/result-1',
    provenance: [{
      source: 'etsy_outgoing_message',
      reference: 'seller-message-1',
    }],
  });
});

test('operational Trello due date and review eligibility remain fail-closed', () => {
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: upstreamResponse(),
    bridgeConversation: bridgeConversation(),
  });

  expect(facts.deadline).toMatchObject({
    verified: false,
    reached_or_approaching: false,
    kind: 'trello_operational_due',
    due_at: '2026-07-29T10:00:00.000Z',
  });
  expect(facts.review).toMatchObject({
    eligible: false,
    already_requested: false,
    checked_at: '2026-07-28T09:58:00.000Z',
  });
  expect(facts.order.has_active_issue).toBeNull();
});

test('review evidence recognizes a positive buyer ending before a final shop acknowledgement', () => {
  const facts = mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: upstreamResponse(),
    bridgeConversation: bridgeConversation({
      messages: [
        {
          source_id: 'buyer-positive',
          direction: 'incoming',
          sent_at: '2026-07-28T09:50:00Z',
          body: 'Muchas gracias, me encanta. Perfecto!',
        },
        {
          source_id: 'shop-follow-up',
          direction: 'outgoing',
          sent_at: '2026-07-28T09:51:00Z',
          body: 'You are very welcome!',
        },
      ],
    }),
  });

  expect(facts.review).toMatchObject({
    positive_conversation_ending: true,
    latest_message_id: 'shop-follow-up',
  });
  expect(facts.review.active_issue_signal).toBe(false);
});

test('late-materials policy is released only by explicit owner runtime config', () => {
  const previous = process.env.MESSAGE_LATE_MATERIALS_ALLOWED;
  try {
    delete process.env.MESSAGE_LATE_MATERIALS_ALLOWED;
    const blocked = mergeOrderContextEvidence({
      receiptId: '4053136295',
      orderContextResponse: upstreamResponse(),
      bridgeConversation: bridgeConversation(),
    });
    expect(blocked.shop_policy).toMatchObject({
      late_materials_allowed: null,
      checked_at: null,
      source: null,
    });

    process.env.MESSAGE_LATE_MATERIALS_ALLOWED = 'true';
    const released = mergeOrderContextEvidence({
      receiptId: '4053136295',
      orderContextResponse: upstreamResponse(),
      bridgeConversation: bridgeConversation(),
    });
    expect(released.shop_policy).toMatchObject({
      late_materials_allowed: true,
      source: 'owner_runtime_policy',
    });
    expect(Date.parse(released.shop_policy.checked_at)).toBeGreaterThan(0);
  } finally {
    if (previous === undefined) delete process.env.MESSAGE_LATE_MATERIALS_ALLOWED;
    else process.env.MESSAGE_LATE_MATERIALS_ALLOWED = previous;
  }
});

test('loader verifies every paid physical order listing is made to order', async () => {
  const response = upstreamResponse();
  response.context.order.automation_facts = {
    verified: true,
    is_paid: true,
    all_items_physical: true,
    listing_ids: ['4517826856', '4517826857'],
    paid_at: '2026-07-27T08:00:00Z',
    checked_at: '2026-07-28T08:00:00Z',
  };
  const facts = await loadVerifiedOrderFactsForConversation({
    receiptId: '4053136295',
    bridgeConversation: bridgeConversation(),
  }, {
    fetchImpl: async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    baseUrl: 'http://127.0.0.1:8092',
    token: TOKEN,
    fetchListing: async listingId => ({
      listing_id: listingId,
      when_made: 'made_to_order',
    }),
  });

  expect(facts.order).toMatchObject({
    paid: true,
    all_items_physical: true,
    listing_ids: ['4517826856', '4517826857'],
    made_to_order: true,
    made_to_order_verified: true,
  });
});

test('merger rejects receipt mismatches from either source', () => {
  expect(() => mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: upstreamResponse(),
    bridgeConversation: bridgeConversation({
      conversation: { receipt_ids: ['4053136296'] },
    }),
  })).toThrow(/not linked to this Bridge conversation/i);

  const response = upstreamResponse();
  response.context.order.order_id = '4053136296';
  expect(() => mergeOrderContextEvidence({
    receiptId: '4053136295',
    orderContextResponse: response,
    bridgeConversation: bridgeConversation(),
  })).toThrow(/does not exactly match/i);
});
