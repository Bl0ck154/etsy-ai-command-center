import { expect, test } from '@playwright/test';

import { generateMessageDraft } from '../api/messages/draft-agent.js';
import { validateMessageDraftSafety } from '../api/messages/draft-safety.js';

function verifiedListing(overrides = {}) {
  return {
    verified: true,
    listing_id: '4517826856',
    title: 'Verified family portrait',
    url: 'https://www.etsy.com/listing/4517826856',
    active: true,
    variations: [{
      name: 'People',
      enabled_values: ['2 people', '4 people'],
    }],
    personalization_fields: [{
      question: 'Background',
      enabled_options: ['Light', 'Dark'],
    }],
    ...overrides,
  };
}

test('email-claim draft treats a possible personal sender naturally without overstating', () => {
  const input = {
    scenario: 'materials_sent_by_email',
    sourceMessageId: 'message-1',
    conversation: {
      messages: [{
        source_id: 'message-1',
        direction: 'incoming',
        body: 'I already emailed the photos.',
      }],
    },
    verifiedFacts: {
      materials: {
        email_claim: {
          checked: true,
          possible_match_requires_review: true,
          confirmation_required: false,
          exact_customer_attachments_received: false,
          candidates: [{ sender_name: 'Federica Wasilewska' }],
        },
      },
    },
  };
  expect(validateMessageDraftSafety({
    ...input,
    replyBody: 'Hi Federica, thanks. I found an email with attachments that may match your order, and I will check it against the order details.',
  })).toEqual({ ok: true });
  expect(validateMessageDraftSafety({
    ...input,
    replyBody: 'Hi, we received your files.',
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_EMAIL_MATCH_OVERSTATED',
  });
});

test('without exact listing only one concise clarification question is allowed', () => {
  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: 'Which product and number of people would you like to order?',
    verifiedFacts: {},
  })).toEqual({ ok: true });

  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: 'Which product would you like to order? How many people should it include?',
    verifiedFacts: {},
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_CLARIFICATION_ONLY',
  });

  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: 'Order the Family Portrait listing.',
    verifiedFacts: {},
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_CLARIFICATION_ONLY',
  });
});

test('price claims are blocked because listing facts intentionally omit prices', () => {
  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: 'The total price is $50.',
    verifiedFacts: { listing: verifiedListing() },
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_UNVERIFIED_PRICE_CLAIM',
  });
});

test('only the exact verified Etsy listing URL is allowed', () => {
  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: (
      'Please order through the People options here: '
      + 'https://www.etsy.com/listing/4517826856'
    ),
    verifiedFacts: { listing: verifiedListing() },
  })).toEqual({ ok: true });

  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: 'Order using https://www.etsy.com/listing/9999999999 instead.',
    verifiedFacts: { listing: verifiedListing() },
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_UNVERIFIED_LINK_CLAIM',
  });
});

test('option and active-state claims require matching verified facts', () => {
  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: 'To order, select 2 people in the People option.',
    verifiedFacts: { listing: verifiedListing() },
  })).toEqual({ ok: true });

  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: 'To order, select the Premium option.',
    verifiedFacts: { listing: verifiedListing() },
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_UNVERIFIED_OPTION_CLAIM',
  });

  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: 'This listing is active and ready to order.',
    verifiedFacts: { listing: verifiedListing({ active: false }) },
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_UNVERIFIED_LISTING_CLAIM',
  });
});

test('file guidance requires an exact verified paid order', () => {
  expect(validateMessageDraftSafety({
    scenario: 'how_to_send_files',
    replyBody: 'Use the attachment control.',
    verifiedFacts: {},
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_VERIFIED_PAID_ORDER_REQUIRED',
  });
  expect(validateMessageDraftSafety({
    scenario: 'how_to_send_files',
    replyBody: 'Hi, yes, you can send the files here in this Etsy conversation.',
    verifiedFacts: {
      order: {
        linked: true,
        paid: true,
        receipt_id: '4053136295',
        checked_at: '2026-07-28T08:00:00.000Z',
      },
    },
    conversation: {
      messages: [{
        source_id: 'buyer-files-1',
        direction: 'incoming',
        body: 'Can I send the files here?',
      }],
    },
    sourceMessageId: 'buyer-files-1',
  })).toEqual({ ok: true });
});

test('pre-sale drafts cannot invite materials and must direct purchase first', () => {
  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: (
      'Buongiorno Vania, può inviarmi qui la foto? '
      + 'Dopo averla vista, le indicherò come procedere.'
    ),
    verifiedFacts: { listing: verifiedListing() },
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_PRE_SALE_MATERIAL_INVITATION',
  });
  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: 'Certamente, possiamo procedere con questa animazione.',
    verifiedFacts: { listing: verifiedListing() },
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_PURCHASE_FIRST_REQUIRED',
  });
  expect(validateMessageDraftSafety({
    scenario: 'how_to_order',
    replyBody: 'Per iniziare, effettui prima l ordine dalla pagina Etsy.',
    verifiedFacts: { listing: verifiedListing() },
  })).toEqual({ ok: true });
});

test('draft agent converts an unsafe ready model result into a blocked draft', async () => {
  const generated = await generateMessageDraft({
    scenario: 'how_to_order',
    conversation: { source_id: 'c1', messages: [] },
    verifiedFacts: {},
    playbook: {
      tone: {},
      hard_rules: [],
      avoid_phrases: [],
      examples: [],
      scenarios: {
        how_to_order: {
          enabled: true,
          instructions: 'Ask one concise clarification question.',
        },
      },
    },
    generate: async () => ({
      status: 'ready',
      scenario: 'how_to_order',
      reply_body: 'Choose the Premium listing for $50.',
      language: 'English',
      confidence: 0.99,
      rationale: 'Unsafe model output.',
      facts_used: [],
      warnings: [],
      requires_human_approval: true,
      block_reason: '',
    }),
  });

  expect(generated).toMatchObject({
    status: 'blocked',
    reply_body: '',
    confidence: 0,
    requires_human_approval: true,
    block_reason:
      'How-to-order drafts may not state a price without verified price facts',
  });
  expect(generated.warnings).toContain(
    'MESSAGE_DRAFT_UNVERIFIED_PRICE_CLAIM',
  );
});

test('Daphne pre-sale inquiry gets one purchase-first correction before blocking', async () => {
  const replies = [
    'Hello Daphne, yes, please send the photos here and we will review them.',
    'Hello Daphne, yes, this memorial edit is possible. Please place the order through the Etsy listing first, and we will review the details after purchase.',
  ];
  const prompts = [];
  const generated = await generateMessageDraft({
    scenario: 'how_to_order',
    conversation: {
      source_id: '1699862541',
      participant: 'daphned90',
      messages: [{
        source_id: 'daphne-message-1',
        direction: 'incoming',
        sender: 'daphned90',
        body: 'My friend lost her sister before her wedding. Can you add her sister to the wedding pictures?',
      }],
    },
    sourceMessageId: 'daphne-message-1',
    verifiedFacts: {
      listing: verifiedListing({
        listing_id: '4420886705',
        url: 'https://www.etsy.com/listing/4420886705',
      }),
    },
    playbook: {
      tone: {},
      hard_rules: [],
      avoid_phrases: [],
      examples: [],
      scenarios: {
        how_to_order: {
          enabled: true,
          instructions: 'Answer directly and require purchase before reviewing materials.',
        },
      },
    },
    generate: async systemPrompt => {
      prompts.push(systemPrompt);
      return {
        status: 'ready',
        scenario: 'how_to_order',
        reply_body: replies.shift(),
        language: 'English',
        confidence: 0.9,
        rationale: 'Direct pre-sale guidance.',
        facts_used: ['verified listing'],
        warnings: [],
        requires_human_approval: true,
        block_reason: '',
      };
    },
    reviewDraft: async () => ({
      approved: true,
      confidence: 0.9,
      rationale: 'Direct and purchase-first.',
    }),
  });

  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('Correction required');
  expect(generated).toMatchObject({
    status: 'ready',
    reply_body: expect.stringContaining('place the order'),
  });
});

test('freeform drafts allow natural formatting while template scenarios stay compact', () => {
  expect(validateMessageDraftSafety({
    scenario: 'freeform',
    replyBody: 'Yes — that works for me.\n\nPlease send the photos whenever you are ready.',
    verifiedFacts: {},
  })).toEqual({ ok: true });

  expect(validateMessageDraftSafety({
    scenario: 'freeform',
    replyBody: 'x'.repeat(2_501),
    verifiedFacts: {},
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_COMPACT_PARAGRAPH_REQUIRED',
  });

  expect(validateMessageDraftSafety({
    scenario: 'missing_materials',
    replyBody: 'Your order is ready — please send the photos.',
    verifiedFacts: {},
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_DASH_STYLE_VIOLATION',
  });

  expect(validateMessageDraftSafety({
    scenario: 'how_to_send_files',
    replyBody: 'Please attach the photos here.\nWe will check them for you.',
    verifiedFacts: {},
  })).toMatchObject({
    ok: false,
    code: 'MESSAGE_DRAFT_COMPACT_PARAGRAPH_REQUIRED',
  });
});

test('draft agent sends explicit buyer/shop direction to AI and drops unknown rows', async () => {
  let suppliedSystemPrompt = '';
  let suppliedConversation = null;
  const generated = await generateMessageDraft({
    scenario: 'freeform',
    conversation: {
      source_id: 'c1',
      messages: [{
        source_id: 'm1',
        sender: '111111',
        direction: 'incoming',
        body: 'Buyer question',
      }, {
        source_id: 'm2',
        sender: '222222',
        direction: 'outgoing',
        body: 'Shop answer',
      }, {
        source_id: 'legacy',
        sender: '333333',
        direction: 'unknown',
        body: 'Untrusted legacy row',
      }],
    },
    playbook: {
      tone: {},
      hard_rules: [],
      avoid_phrases: [],
      examples: [],
      scenarios: {
        freeform: {
          enabled: true,
          instructions: 'Prepare a concise reply.',
        },
      },
    },
    generate: async (systemPrompt, userPrompt) => {
      suppliedSystemPrompt = systemPrompt;
      suppliedConversation = JSON.parse(userPrompt).conversation.messages;
      return {
        status: 'ready',
        scenario: 'freeform',
        reply_body: 'Safe preview.',
        language: 'English',
        confidence: 0.8,
        rationale: 'Test.',
        facts_used: [],
        warnings: [],
        requires_human_approval: true,
        block_reason: '',
      };
    },
    reviewDraft: async () => ({
      approved: true,
      confidence: 0.95,
      rationale: 'Direct and grounded.',
    }),
  });

  expect(generated.status).toBe('ready');
  expect(suppliedSystemPrompt).toContain('direction="incoming"');
  expect(suppliedConversation).toEqual([
    expect.objectContaining({
      source_message_id: 'm1',
      direction: 'incoming',
      speaker: 'buyer',
      sender: '111111',
    }),
    expect.objectContaining({
      source_message_id: 'm2',
      direction: 'outgoing',
      speaker: 'shop',
      sender: '222222',
    }),
  ]);
});

test('draft agent preserves a semantic no-action decision without reply text', async () => {
  const generated = await generateMessageDraft({
    scenario: 'freeform',
    conversation: {
      source_id: 'c1',
      messages: [{
        source_id: 'm1',
        sender: 'buyer',
        direction: 'incoming',
        body: 'Thank you!',
      }],
    },
    playbook: {
      tone: {},
      hard_rules: [],
      avoid_phrases: [],
      examples: [],
      scenarios: {
        freeform: {
          enabled: true,
          instructions: 'Reply only when a reply is useful.',
        },
      },
    },
    generate: async () => ({
      status: 'no_action',
      scenario: 'freeform',
      reply_body: '',
      language: 'English',
      confidence: 0.95,
      rationale: 'The buyer closed the conversation.',
      facts_used: [],
      warnings: [],
      requires_human_approval: true,
      block_reason: 'The newest buyer message is only a thank-you.',
    }),
  });

  expect(generated).toMatchObject({
    status: 'no_action',
    reply_body: '',
    block_reason: 'The newest buyer message is only a thank-you.',
    requires_human_approval: true,
  });
});
