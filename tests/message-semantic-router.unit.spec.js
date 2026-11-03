import { expect, test } from '@playwright/test';

import {
  classifyBuyerEmailTransferClaim,
  classifyExplicitBuyerFileTransferIntent,
  classifyNewMessageScenario,
} from '../api/messages/semantic-router.js';
import { DEFAULT_MESSAGE_PLAYBOOK } from '../api/messages/playbook.js';

function sendFilesRule(overrides = {}) {
  return {
    id: 'new_message_send_files',
    label: 'Buyer asks how to send files',
    scenario: 'how_to_send_files',
    conditions: 'Buyer asks how or where to send required files.',
    ...overrides,
  };
}

function emailClaimRule(overrides = {}) {
  return {
    id: 'new_message_materials_sent_by_email',
    label: 'Buyer says files were emailed',
    scenario: 'materials_sent_by_email',
    conditions: 'Buyer says files or photos were already sent.',
    ...overrides,
  };
}

function howToOrderRule(overrides = {}) {
  return {
    id: 'new_message_how_to_order',
    label: 'How to order',
    scenario: 'how_to_order',
    conditions: 'The pre-sale buyer needs to place an order first.',
    ...overrides,
  };
}

function conversation(body) {
  return {
    participant: 'Buyer',
    messages: [{
      source_id: 'trigger-1',
      direction: 'incoming',
      sender: 'Buyer',
      body,
      attachments: [],
    }],
  };
}

test.describe('explicit buyer file-transfer intent', () => {
  for (const body of [
    'Can I send media?',
    'Could I send you two photos so you can see whether this is possible?',
    'Would it be okay to share my pictures here?',
    'Where should I upload the image files?',
    'How do the reference photos need to be attached?',
    'How many photos can I send?',
    'Do you accept artwork files?',
    'Are PNG attachments accepted?',
  ]) {
    test(`recognizes: ${body}`, () => {
      expect(classifyExplicitBuyerFileTransferIntent(body)).toMatchObject({
        intent: 'buyer_requests_file_transfer_instructions_or_permission',
      });
    });
  }

  for (const body of [
    'Can you send me the photos?',
    'I can send photos tomorrow.',
    'I already sent the files.',
    'Can you make this product from a photo?',
    'Where can I see your product images?',
    'Thanks for your help!',
  ]) {
    test(`does not over-route: ${body}`, () => {
      expect(classifyExplicitBuyerFileTransferIntent(body)).toBeNull();
    });
  }
});

test('recognizes an already-sent email claim separately from asking how to send', async () => {
  expect(classifyBuyerEmailTransferClaim(
    'Hi, I already emailed the photos to you.',
  )).toMatchObject({
    intent: 'buyer_claims_materials_already_sent_by_email',
  });
  const value = conversation('Hi, I already emailed the photos to you.');
  value.receipt_ids = ['4053136295'];
  const result = await classifyNewMessageScenario({
    conversation: value,
    sourceMessageId: 'trigger-1',
    rules: [emailClaimRule(), sendFilesRule()],
    playbook: DEFAULT_MESSAGE_PLAYBOOK,
    generate: async () => {
      throw new Error('deterministic email claim route should not call AI');
    },
  });
  expect(result).toMatchObject({
    decision: 'route',
    rule_id: 'new_message_materials_sent_by_email',
    scenario: 'materials_sent_by_email',
  });
});

test('router treats freeform as the universal fallback for ordinary buyer questions', async () => {
  let systemPrompt = '';
  const fallbackRule = {
    id: 'new_message_universal_assistant',
    label: 'Universal AI assistant fallback',
    scenario: 'freeform',
    conditions: 'Fallback only when no narrower scenario applies.',
  };
  const result = await classifyNewMessageScenario({
    conversation: conversation('Can you make the background a little lighter?'),
    sourceMessageId: 'trigger-1',
    rules: [howToOrderRule(), fallbackRule],
    playbook: DEFAULT_MESSAGE_PLAYBOOK,
    generate: async prompt => {
      systemPrompt = prompt;
      return {
        decision: 'route',
        rule_id: fallbackRule.id,
        scenario: 'freeform',
        confidence: 0.94,
        rationale: 'The buyer asks for a normal edit and expects a reply.',
      };
    },
  });

  expect(systemPrompt).toContain('universal assistant fallback');
  expect(systemPrompt).toContain('no_action');
  expect(result).toMatchObject({
    decision: 'route',
    rule_id: 'new_message_universal_assistant',
    scenario: 'freeform',
  });
});

test('router refuses pre-sale file guidance when no order rule is available', async () => {
  let aiCalled = false;
  const result = await classifyNewMessageScenario({
    conversation: conversation(
      'Can I send you two images so you can check if the design is possible?',
    ),
    sourceMessageId: 'trigger-1',
    rules: [sendFilesRule()],
    playbook: {
      scenarios: {
        how_to_send_files: { instructions: 'Explain the accepted method.' },
      },
    },
    generate: async () => {
      aiCalled = true;
      throw new Error('AI should not be needed for explicit high-confidence intent');
    },
  });

  expect(aiCalled).toBe(false);
  expect(result).toMatchObject({
    decision: 'no_action',
    rule_id: '',
    scenario: '',
    confidence: 1,
  });
});

test('router fails closed on a pre-sale file request even when how-to-order exists', async () => {
  let aiCalled = false;
  const result = await classifyNewMessageScenario({
    conversation: conversation(
      'Can I send you two images so you can check if the design is possible?',
    ),
    sourceMessageId: 'trigger-1',
    rules: [sendFilesRule(), howToOrderRule()],
    playbook: { scenarios: {} },
    generate: async () => {
      aiCalled = true;
      throw new Error('Explicit pre-sale intent should route deterministically');
    },
  });
  expect(aiCalled).toBe(false);
  expect(result).toMatchObject({
    decision: 'no_action',
    rule_id: '',
    scenario: '',
    confidence: 1,
  });
});

test('router refuses ambiguous file guidance across multiple linked orders', async () => {
  const result = await classifyNewMessageScenario({
    conversation: {
      ...conversation('Where should I upload the photos?'),
      receipt_ids: ['4053136295', '4053136296'],
    },
    sourceMessageId: 'trigger-1',
    rules: [sendFilesRule()],
    playbook: { scenarios: {} },
    generate: async () => {
      throw new Error('Ambiguous linked orders must fail closed before AI');
    },
  });
  expect(result).toMatchObject({
    decision: 'no_action',
    rule_id: '',
    scenario: '',
    confidence: 1,
  });
});

test('exact trigger is classified outside the recent 30-message window', async () => {
  const messages = [{
    source_id: 'trigger-old',
    direction: 'incoming',
    sender: 'Buyer',
    body: 'Can I send media?',
  }, ...Array.from({ length: 35 }, (_, index) => ({
    source_id: `later-${index + 1}`,
    direction: 'incoming',
    sender: 'Buyer',
    body: `Later cached message ${index + 1}`,
  }))];
  let aiCalled = false;
  const result = await classifyNewMessageScenario({
    conversation: {
      participant: 'Buyer',
      receipt_ids: ['4053136295'],
      messages,
    },
    sourceMessageId: 'trigger-old',
    rules: [sendFilesRule()],
    playbook: { scenarios: {} },
    generate: async () => {
      aiCalled = true;
      throw new Error('Explicit exact trigger must route without AI');
    },
  });

  expect(aiCalled).toBe(false);
  expect(result).toMatchObject({
    decision: 'route',
    rule_id: 'new_message_send_files',
    scenario: 'how_to_send_files',
  });
});

test('duplicate matching rules preserve exactly-one safety and defer to no_action', async () => {
  let payload = '';
  const result = await classifyNewMessageScenario({
    conversation: {
      ...conversation('Can I send media?'),
      receipt_ids: ['4053136295'],
    },
    sourceMessageId: 'trigger-1',
    rules: [
      sendFilesRule(),
      sendFilesRule({ id: 'another_send_files_rule' }),
    ],
    playbook: { scenarios: {} },
    generate: async (system, input) => {
      payload = `${system}\n${input}`;
      return {
        decision: 'no_action',
        rule_id: '',
        scenario: '',
        confidence: 0.8,
        rationale: 'Two overlapping configured rules prevent one safe choice.',
      };
    },
  });

  expect(payload).toContain('triggering_message');
  expect(result).toMatchObject({
    decision: 'no_action',
    rule_id: '',
    scenario: '',
  });
});

test('unrelated and ambiguous text keeps AI no_action', async () => {
  const result = await classifyNewMessageScenario({
    conversation: conversation('Can you make this product from a photo?'),
    sourceMessageId: 'trigger-1',
    rules: [sendFilesRule()],
    playbook: { scenarios: {} },
    generate: async system => {
      expect(system).toContain(
        'feasibility questions, and other photo-product questions should be interpreted by their actual meaning',
      );
      return {
        decision: 'no_action',
        rule_id: '',
        scenario: '',
        confidence: 0.99,
        rationale: 'The buyer asks about product feasibility, not file transfer.',
      };
    },
  });

  expect(result).toMatchObject({
    decision: 'no_action',
    rule_id: '',
    scenario: '',
    confidence: 0.99,
  });
});

test('router receives only trusted canonical inline listing references', async () => {
  let parsed;
  const convo = conversation('Which option should I order?');
  convo.listing_refs = [{
    listing_id: '4517826856',
    listing_url: 'https://www.etsy.com/listing/4517826856',
    source: 'inline_listing_ids',
    source_message_id: 'trigger-1',
  }, {
    listing_id: '9999999999',
    listing_url: 'https://example.test/listing/9999999999',
    source: 'inline_listing_ids',
    source_message_id: 'trigger-1',
  }, {
    listing_id: '4389878231',
    listing_url: 'https://www.etsy.com/listing/4389878231',
    source: 'parsed_from_message_text',
    source_message_id: 'trigger-1',
  }];
  await classifyNewMessageScenario({
    conversation: convo,
    sourceMessageId: 'trigger-1',
    rules: [{
      id: 'new_message_how_to_order',
      label: 'How to order',
      scenario: 'how_to_order',
      conditions: 'Explicit pre-purchase order question.',
    }],
    playbook: { scenarios: {} },
    generate: async (system, input) => {
      parsed = JSON.parse(input);
      return {
        decision: 'no_action',
        rule_id: '',
        scenario: '',
        confidence: 0.8,
        rationale: 'Fixture route result.',
      };
    },
  });

  expect(parsed.trusted_inline_listing_refs).toEqual([{
    listing_id: '4517826856',
    source: 'inline_listing_ids',
    source_message_id: 'trigger-1',
  }]);
});

test('default buyer language policy is valid UTF-8 without mojibake', () => {
  const languagePolicy = DEFAULT_MESSAGE_PLAYBOOK.tone.language_policy;
  expect(languagePolicy).toContain('buyer’s language');
  expect(languagePolicy).not.toContain('вЂ');
  expect(languagePolicy).not.toContain('\uFFFD');
});


test('attachment-only follow-up can route to freeform from surrounding conversation context', async () => {
  let payload;
  let systemPrompt;
  const fallbackRule = {
    id: 'new_message_universal_assistant',
    label: 'Universal AI assistant fallback',
    scenario: 'freeform',
    conditions: 'Use context to decide whether a shop response is useful.',
  };
  const result = await classifyNewMessageScenario({
    conversation: {
      participant: 'Buyer',
      messages: [{
        source_id: 'm1',
        direction: 'incoming',
        sender: 'Buyer',
        body: 'Could you make an animation of the two people interacting?',
        attachments: [],
      }, {
        source_id: 'trigger-attachment',
        direction: 'incoming',
        sender: 'Buyer',
        body: '',
        attachments: [{ filename: 'reference.jpg', mime_type: 'image/jpeg' }],
      }],
    },
    sourceMessageId: 'trigger-attachment',
    rules: [fallbackRule],
    playbook: DEFAULT_MESSAGE_PLAYBOOK,
    generate: async (prompt, input) => {
      systemPrompt = prompt;
      payload = JSON.parse(input);
      return {
        decision: 'route',
        rule_id: fallbackRule.id,
        scenario: 'freeform',
        confidence: 0.93,
        rationale: 'The attachment is the reference for the immediately preceding request and a reply is useful.',
      };
    },
  });

  expect(systemPrompt).toContain('Ambiguous wording is not by itself a reason for no_action');
  expect(payload.recent_conversation.map(message => message.source_id))
    .toEqual(['m1', 'trigger-attachment']);
  expect(payload.triggering_message.attachment_count).toBe(1);
  expect(result).toMatchObject({
    decision: 'route',
    rule_id: 'new_message_universal_assistant',
    scenario: 'freeform',
  });
});
