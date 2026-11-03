import { test, expect } from '@playwright/test';

test.describe('existing Etsy listing variation contract', () => {
  test('fulfillment profile tool uses the dedicated Etsy shop endpoints', async () => {
    const { TOOLS, fetchShopFulfillmentProfiles } = await import(`../api/agent.js?existing_profiles=${Date.now()}`);
    const calls = [];
    const fetcher = async path => {
      calls.push(path);
      if (path.endsWith('/shipping-profiles')) {
        return { results: [{ shipping_profile_id: 701, title: 'Digital service delivery', origin_country_iso: 'US' }] };
      }
      return {
        results: [{
          readiness_state_id: 801,
          readiness_state: 'made_to_order',
          min_processing_days: 1,
          max_processing_days: 3,
        }],
      };
    };

    const result = await fetchShopFulfillmentProfiles(fetcher, '23207964');

    expect(TOOLS.find(tool => tool.name === 'get_shop_fulfillment_profiles')).toBeTruthy();
    expect(calls).toEqual([
      '/shops/23207964/shipping-profiles',
      '/shops/23207964/readiness-state-definitions?limit=100',
    ]);
    expect(result).toEqual({
      shipping_profiles: [{ id: 701, title: 'Digital service delivery', origin_country: 'US' }],
      readiness_profiles: [{ id: 801, state: 'made_to_order', processing_time: '1-3 days' }],
    });
  });

  test('listing details expose current shipping and inventory-derived readiness IDs', async () => {
    const { listingDetailsForAgent } = await import(`../api/agent.js?existing_details=${Date.now()}`);
    const details = listingDetailsForAgent({
      listing_id: 4540982802,
      title: 'Custom combined photo and video service',
      listing_type: 'physical',
      taxonomy_id: 2078,
      shipping_profile_id: 701,
      price: { amount: 3000, divisor: 100 },
      inventory: {
        products: [{
          property_values: [],
          offerings: [{ price: { amount: 3000, divisor: 100 }, quantity: 999, is_enabled: true, readiness_state_id: 801 }],
        }],
      },
    });

    expect(details).toMatchObject({
      listing_id: 4540982802,
      listing_type: 'physical',
      shipping_profile_id: 701,
      readiness_state_id: 801,
      inventory_readiness_state_ids: [801],
      price: 30,
    });
  });

  test('existing listing variation plan does not require an active Create draft and preserves current profiles', async () => {
    const { dispatchToolForTest } = await import(`../api/agent.js?existing_variations=${Date.now()}`);
    const listing = {
      listing_id: 4540982802,
      title: 'Custom combined photo and video service',
      listing_type: 'physical',
      taxonomy_id: 2078,
      shipping_profile_id: 701,
      readiness_state_id: 801,
      inventory_readiness_state_ids: [801],
      price: 30,
      state: 'draft',
      personalization_questions: [],
      inventory_summary: { product_count: 1, properties: [], price_min: 30, price_max: 30 },
    };

    const { result, state } = await dispatchToolForTest('set_variations', {
      target_type: 'etsy_listing',
      listing_id: 4540982802,
      listing_title: listing.title,
      current_listing_type: 'physical',
      listing_type: 'physical',
      base_price: 30,
      shipping_profile_id: 999999,
      readiness_state_id: 999998,
      properties: [
        {
          name: 'Video length',
          pricing_mode: 'final_price',
          options: [
            { name: 'Up to 1 minute', amount: 30 },
            { name: 'Up to 2 minutes', amount: 37 },
          ],
        },
        {
          name: 'Colorization',
          pricing_mode: 'surcharge',
          options: [
            { name: 'Restoration only', amount: 0 },
            { name: 'Add colorization', amount: 5 },
          ],
        },
      ],
      personalization_questions: [{
        question_type: 'file_upload',
        question_text: 'Upload the source photos to combine',
        required: true,
        max_allowed_files: 10,
      }],
    }, {
      listing_details: { 4540982802: listing },
    });

    expect(result).toMatchObject({
      status: 'shown_to_user',
      awaiting_confirmation: true,
      target_type: 'etsy_listing',
      listing_id: 4540982802,
    });
    expect(state.pendingVariations).toMatchObject({
      target_type: 'etsy_listing',
      listing_id: 4540982802,
      listing_title: listing.title,
      shipping_profile_id: 701,
      readiness_state_id: 801,
      fulfillment_profile_source: 'current_listing',
      personalization_questions: [{
        question_type: 'file_upload',
        question_text: 'Upload the source photos to combine',
        required: true,
      }],
    });
    expect(state.pendingVariations.properties).toHaveLength(2);
  });

  test('existing listing only requests profile selection when current IDs are truly absent', async () => {
    const { dispatchToolForTest } = await import(`../api/agent.js?existing_missing_profiles=${Date.now()}`);
    const { result, state } = await dispatchToolForTest('set_variations', {
      target_type: 'etsy_listing',
      listing_id: 4540982802,
      listing_title: 'Custom combined photo and video service',
      listing_type: 'physical',
      base_price: 30,
      properties: [{ name: 'Video length', pricing_mode: 'final_price', options: [{ name: 'Up to 1 minute', amount: 30 }] }],
    }, {
      listing_details: {
        4540982802: {
          listing_id: 4540982802,
          title: 'Custom combined photo and video service',
          listing_type: 'physical',
          taxonomy_id: 2078,
          shipping_profile_id: null,
          readiness_state_id: null,
          price: 30,
        },
      },
    });

    expect(result.fault).toMatchObject({
      code: 'AGENT_EXISTING_LISTING_FULFILLMENT_REQUIRED',
      required_transition: 'get_shop_fulfillment_profiles',
    });
    expect(result.fault.safe_message).toContain('Read the shop fulfillment profiles');
    expect(result.fault.safe_message).not.toContain('open');
    expect(state.pendingVariations).toBeNull();
  });

  test('empty personalization is rejected before an approval card can call Etsy', async () => {
    const { dispatchToolForTest } = await import(`../api/agent.js?empty_personalization=${Date.now()}`);
    const { result, state } = await dispatchToolForTest('set_variations', {
      target_type: 'etsy_listing',
      listing_id: 4540982802,
      listing_title: 'Video restoration service',
      listing_type: 'physical',
      base_price: 30,
      properties: [{
        name: 'Video length',
        pricing_mode: 'final_price',
        options: [{ name: 'Up to 1 minute', amount: 30 }],
      }],
      personalization_questions: [],
    }, {
      listing_details: {
        4540982802: {
          listing_id: 4540982802,
          title: 'Video restoration service',
          listing_type: 'physical',
          taxonomy_id: 77,
          shipping_profile_id: 701,
          readiness_state_id: 801,
          price: 30,
        },
      },
    });

    expect(result.error).toContain('Omit personalization_questions');
    expect(state.pendingVariations).toBeNull();
  });

  test('standalone existing-listing personalization proposal passes the specialized safety contract', async () => {
    const { dispatchToolForTest } = await import(`../api/agent.js?existing_personalization=${Date.now()}`);
    const listingId = 4540982802;
    const { result, state } = await dispatchToolForTest('propose_updates', {
      summary: 'Add buyer photo upload',
      updates: [{
        listing_id: listingId,
        listing_title: 'Custom combined photo and video service',
        personalization_questions: [{
          question_type: 'file_upload',
          question_text: 'Upload the source photos to combine',
          required: true,
          max_allowed_files: 10,
        }],
      }],
    }, {
      listing_details: {
        [listingId]: {
          listing_id: listingId,
          title: 'Custom combined photo and video service',
          state: 'draft',
          personalization_questions: [],
        },
      },
    });

    expect(result).toMatchObject({ status: 'shown_to_user', awaiting_confirmation: true, count: 1 });
    expect(state.pendingUpdates.updates[0].personalization_questions[0]).toMatchObject({
      question_type: 'file_upload',
      question_text: 'Upload the source photos to combine',
    });
  });

  test('system prompt distinguishes existing listings and avoids duplicate personalization selections', async () => {
    const { AGENT_SYSTEM } = await import(`../api/agent.js?existing_prompt=${Date.now()}`);
    expect(AGENT_SYSTEM).toContain('target_type: "etsy_listing"');
    expect(AGENT_SYSTEM).toContain('Never ask the owner to open an editor for a resolved existing listing.');
    expect(AGENT_SYSTEM).toContain('only when the owner explicitly asked to add or replace personalization');
    expect(AGENT_SYSTEM).toContain('never send an empty array');
    expect(AGENT_SYSTEM).toContain('Do not create personalization questions for duration, color, size, finish');
    expect(AGENT_SYSTEM).toContain('Only when an existing listing truly lacks a required profile ID');
  });

  test('variation tool schema has one typed amount instead of conflicting price fields', async () => {
    const { TOOLS } = await import(`../api/agent.js?variation_schema=${Date.now()}`);
    const tool = TOOLS.find(item => item.name === 'set_variations');
    const propertySchema = tool.input_schema.properties.properties.items;
    const optionSchema = propertySchema.properties.options.items;
    expect(propertySchema.required).toContain('pricing_mode');
    expect(optionSchema.required).toContain('amount');
    expect(optionSchema.properties).not.toHaveProperty('price');
    expect(optionSchema.properties).not.toHaveProperty('price_adjustment');
    expect(tool.input_schema.properties.personalization_questions.minItems).toBe(1);
  });
});
