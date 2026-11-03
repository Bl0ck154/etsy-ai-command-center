import { expect, test } from '@playwright/test';

import {
  loadVerifiedListingFactsForExactOrder,
  loadVerifiedListingFactsForConversation,
  resolveExactConversationListingReference,
  resolveExactOrderListingReference,
} from '../api/messages/listing-context-evidence.js';

function ref(listingId, sourceMessageId = 'buyer-new') {
  return {
    listing_id: String(listingId),
    listing_url: `https://www.etsy.com/listing/${listingId}`,
    source: 'inline_listing_ids',
    source_message_id: sourceMessageId,
  };
}

test('exact trigger listing reference wins over older conversation refs', () => {
  const result = resolveExactConversationListingReference({
    listing_refs: [
      ref('1111111111', 'buyer-old'),
      ref('2222222222', 'buyer-new'),
    ],
  }, 'buyer-new');

  expect(result).toEqual({
    ok: true,
    scope: 'trigger_message',
    reference: ref('2222222222', 'buyer-new'),
  });
});
test('resolver fails closed for ambiguous or untrusted listing metadata', () => {
  expect(resolveExactConversationListingReference({
    listing_refs: [
      ref('1111111111', 'buyer-one'),
      ref('2222222222', 'buyer-two'),
    ],
  })).toMatchObject({
    ok: false,
    reason: 'The Etsy conversation references multiple listings',
  });

  expect(resolveExactConversationListingReference({
    listing_refs: [{
      ...ref('1111111111'),
      listing_url: 'https://example.test/listing/1111111111',
    }, {
      ...ref('2222222222'),
      source: 'parsed_from_message_text',
    }],
  })).toMatchObject({
    ok: false,
    reason: 'No exact Etsy inline listing reference is cached',
  });
});

test('official Etsy listing response becomes bounded verified listing facts', async () => {
  const facts = await loadVerifiedListingFactsForConversation({
    conversation: { listing_refs: [ref('4517826856')] },
    sourceMessageId: 'buyer-new',
  }, {
    now: '2026-07-28T12:00:00.000Z',
    fetchListing: async (listingId, includes) => {
      expect(listingId).toBe('4517826856');
      expect(includes).toEqual(['Personalization']);
      return {
        listing_id: 4517826856,
        title: 'Verified family portrait',
        description: 'Send files here or to Studio@Example.com after ordering.',
        state: 'active',
        inventory: {
          products: [{
            property_values: [{
              property_name: 'People',
              values: ['2 people'],
            }, {
              property_name: 'Format',
              values: ['Digital'],
            }],
            offerings: [{ is_enabled: true, price: { amount: 5000 } }],
          }, {
            property_values: [{
              property_name: 'People',
              values: ['3 people'],
            }],
            offerings: [{ is_enabled: false }],
          }],
        },
        personalization: {
          personalization_questions: [{
            question_type: 'dropdown',
            question_text: 'Background',
            instructions: 'Choose one background.',
            required: true,
            options: [{ label: 'Light', enabled: true }, { label: 'Dark' }],
          }],
        },
      };
    },
  });

  expect(facts).toEqual({
    listing: {
      verified: true,
      listing_id: '4517826856',
      title: 'Verified family portrait',
      description: 'Send files here or to Studio@Example.com after ordering.',
      url: 'https://www.etsy.com/listing/4517826856',
      active: true,
      state: 'active',
      variations: [{
        name: 'People',
        enabled_values: ['2 people'],
      }, {
        name: 'Format',
        enabled_values: ['Digital'],
      }],
      personalization_fields: [{
        type: 'dropdown',
        question: 'Background',
        instructions: 'Choose one background.',
        required: true,
        max_characters: null,
        enabled_options: ['Light', 'Dark'],
      }],
      file_delivery_policy: {
        etsy_conversation_allowed: true,
        verified_email_addresses: [{
          address: 'studio@example.com',
          source_fields: ['description'],
        }],
      },
      checked_at: '2026-07-28T12:00:00.000Z',
      provenance: {
        source: 'official_etsy_api',
        reference_source: 'bridge_inline_listing_ids',
        reference_scope: 'trigger_message',
        source_message_id: 'buyer-new',
      },
    },
    unavailable_reason: null,
  });
  expect(JSON.stringify(facts)).not.toContain('5000');
});

test('exact paid order listing ID loads description and personalization facts', async () => {
  const verifiedOrderFacts = {
    order: {
      linked: true,
      paid: true,
      automation_facts_verified: true,
      receipt_id: '4130532997',
      listing_ids: ['4517826856'],
    },
  };
  expect(resolveExactOrderListingReference(verifiedOrderFacts)).toMatchObject({
    ok: true,
    scope: 'exact_paid_order',
    reference: {
      listing_id: '4517826856',
      receipt_id: '4130532997',
    },
  });

  const facts = await loadVerifiedListingFactsForExactOrder({
    verifiedOrderFacts,
  }, {
    now: '2026-07-30T10:00:00.000Z',
    fetchListing: async listingId => ({
      listing_id: listingId,
      title: 'Add Person or Pet to Photo',
      description: 'After purchase, email photos to files@example.com.',
      state: 'active',
      personalization_instructions:
        'You can also send files to artwork@example.com.',
      is_personalizable: true,
    }),
  });

  expect(facts.listing).toMatchObject({
    verified: true,
    listing_id: '4517826856',
    title: 'Add Person or Pet to Photo',
    description: 'After purchase, email photos to files@example.com.',
    personalization_fields: [{
      instructions: 'You can also send files to artwork@example.com.',
    }],
    file_delivery_policy: {
      etsy_conversation_allowed: true,
      verified_email_addresses: [{
        address: 'files@example.com',
        source_fields: ['description'],
      }, {
        address: 'artwork@example.com',
        source_fields: ['personalization_instructions'],
      }],
    },
    provenance: {
      source: 'official_etsy_api',
      reference_source: 'verified_order_listing_ids',
      receipt_id: '4130532997',
    },
  });
});

test('order listing context fails closed for missing, ambiguous, or mismatched facts', async () => {
  for (const order of [{
    linked: true,
    paid: true,
    automation_facts_verified: false,
    listing_ids: ['4517826856'],
  }, {
    linked: true,
    paid: true,
    automation_facts_verified: true,
    listing_ids: ['4517826856', '4517826857'],
  }]) {
    let called = false;
    const facts = await loadVerifiedListingFactsForExactOrder({
      verifiedOrderFacts: { order },
    }, {
      fetchListing: async () => {
        called = true;
      },
    });
    expect(facts.listing).toBeNull();
    expect(facts.unavailable_reason).toBeTruthy();
    expect(called).toBe(false);
  }

  await expect(loadVerifiedListingFactsForExactOrder({
    verifiedOrderFacts: {
      order: {
        linked: true,
        paid: true,
        automation_facts_verified: true,
        receipt_id: '4130532997',
        listing_ids: ['4517826856'],
      },
    },
  }, {
    fetchListing: async () => ({ listing_id: '9999999999' }),
  })).rejects.toMatchObject({
    code: 'MESSAGE_ORDER_LISTING_CONTEXT_MISMATCH',
  });
});

test('missing exact reference does not call Etsy and returns clarification context', async () => {
  let called = false;
  const facts = await loadVerifiedListingFactsForConversation({
    conversation: { listing_refs: [] },
  }, {
    fetchListing: async () => {
      called = true;
    },
  });

  expect(called).toBe(false);
  expect(facts).toEqual({
    listing: null,
    unavailable_reason: 'No exact Etsy inline listing reference is cached',
  });
});

test('official Etsy listing ID mismatch fails closed', async () => {
  await expect(loadVerifiedListingFactsForConversation({
    conversation: { listing_refs: [ref('4517826856')] },
  }, {
    fetchListing: async () => ({ listing_id: 4389878231 }),
  })).rejects.toMatchObject({
    code: 'MESSAGE_LISTING_CONTEXT_MISMATCH',
  });
});
