import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('every model tool has an explicit runtime scope and a dispatcher handler', async () => {
  const { TOOLS } = await import(`../api/agent.js?tool_contracts=${Date.now()}`);
  const { AGENT_TOOL_RUNTIME_CONTRACTS } = await import(`../api/agent/tools-schema.js?runtime_contracts=${Date.now()}`);
  const source = readFileSync(new URL('../api/agent/tools-dispatch.js', import.meta.url), 'utf8');
  const names = TOOLS.map(tool => tool.name).sort();

  expect(Object.keys(AGENT_TOOL_RUNTIME_CONTRACTS).sort()).toEqual(names);
  for (const name of names) {
    expect(source, `${name} must have an executeTool or dispatchTool branch`).toContain(`'${name}'`);
    const contract = AGENT_TOOL_RUNTIME_CONTRACTS[name];
    expect(contract.execution).toBeTruthy();
    expect(contract.targets?.length).toBeGreaterThan(0);
    if (contract.execution === 'owner_approval') expect(contract.response_field).toMatch(/^pending_/);
  }
});

test('page-only tools declare page or draft scope instead of claiming Etsy writes', async () => {
  const { AGENT_TOOL_RUNTIME_CONTRACTS } = await import(`../api/agent/tools-schema.js?page_contracts=${Date.now()}`);
  expect(AGENT_TOOL_RUNTIME_CONTRACTS.fill_ui_fields).toMatchObject({ execution: 'owner_approval', targets: ['current_page'] });
  expect(AGENT_TOOL_RUNTIME_CONTRACTS.open_current_draft_image_generator).toMatchObject({ execution: 'client_action', targets: ['create_draft'] });
  expect(AGENT_TOOL_RUNTIME_CONTRACTS.set_variations.targets).toEqual(['etsy_listing', 'create_draft']);
  expect(AGENT_TOOL_RUNTIME_CONTRACTS.generate_listing_content.targets).toEqual(['etsy_listing', 'create_draft']);
});

test('existing listing content generation retains the exact Etsy target and becomes an approval workflow', async () => {
  const { dispatchToolForTest } = await import(`../api/agent.js?existing_content=${Date.now()}`);
  const listingId = 4540982802;
  const listing = {
    listing_id: listingId,
    title: 'Current photo restoration service',
    description: 'Current factual product description.',
    tags: ['photo restoration'],
    price: 30,
    listing_type: 'physical',
    taxonomy_id: 77,
    shipping_profile_id: 701,
    readiness_state_id: 801,
  };
  const { result, state } = await dispatchToolForTest('generate_listing_content', {
    target_type: 'etsy_listing',
    listing_id: listingId,
    listing_title: listing.title,
    description: listing.description,
    extra: 'Improve clarity and Etsy SEO without changing the product facts.',
  }, { listing_details: { [listingId]: listing } });

  expect(result).toMatchObject({ status: 'generating' });
  expect(state.pendingGenerateListing).toMatchObject({
    target_type: 'etsy_listing',
    listing_id: listingId,
    listing_title: listing.title,
    description: listing.description,
    current_values: {
      title: listing.title,
      description: listing.description,
      tags: listing.tags,
      price: 30,
    },
  });
  expect(state.pendingGenerateListing.workflow_id).toContain(`listing_update_${listingId}_`);
});

test('listing content generation rejects an ambiguous target contract', async () => {
  const { dispatchToolForTest } = await import(`../api/agent.js?ambiguous_content=${Date.now()}`);
  const { result, state } = await dispatchToolForTest('generate_listing_content', {
    description: 'Improve this listing',
  }, {});
  expect(result.error).toContain('target_type is required');
  expect(state.pendingGenerateListing).toBeNull();
});

test('taxonomy retrieval returns numeric leaf candidates without choosing for the model', async () => {
  const { sellerTaxonomyCandidates } = await import(`../api/agent.js?taxonomy_candidates=${Date.now()}`);
  const candidates = sellerTaxonomyCandidates([{
    id: 1,
    name: 'Art',
    children: [{ id: 77, name: 'Digital Prints', children: [] }, { id: 78, name: 'Paintings', children: [] }],
  }], 'digital print', 5);
  expect(candidates[0]).toMatchObject({ taxonomy_id: 77, name: 'Digital Prints', path: 'Art > Digital Prints' });
});

test('variation removal fails closed when collapsed rows have conflicting prices', async () => {
  const { dispatchToolForTest } = await import(`../api/agent.js?variation_conflict=${Date.now()}`);
  const listingId = 1234567890;
  const inventory = {
    products: [
      { sku: '', property_values: [{ property_id: 1, property_name: 'Length', values: ['1 min'] }, { property_id: 2, property_name: 'Color', values: ['BW'] }], offerings: [{ price: 30, quantity: 5, is_enabled: true, readiness_state_id: 801 }] },
      { sku: '', property_values: [{ property_id: 1, property_name: 'Length', values: ['1 min'] }, { property_id: 2, property_name: 'Color', values: ['Color'] }], offerings: [{ price: 35, quantity: 5, is_enabled: true, readiness_state_id: 801 }] },
    ],
    price_on_property: [1, 2],
  };
  const { result, state } = await dispatchToolForTest('propose_remove_variation_property', {
    property_name: 'Color',
    listings: [{ listing_id: listingId, listing_title: 'Photo service' }],
  }, { inventory_by_listing_id: { [listingId]: inventory } });

  expect(result.fault).toMatchObject({
    code: 'AGENT_VARIATION_COLLAPSE_REQUIRES_PRICING',
    required_transition: 'ask_owner_for_resulting_variation_values',
  });
  expect(state.pendingRemoveVariationProperty).toBeNull();
});

test('clearing variations preserves a shared processing profile', async () => {
  const { buildClearVariationsPlan } = await import(`../api/agent.js?clear_readiness=${Date.now()}`);
  const listingId = 1234567890;
  const plan = buildClearVariationsPlan([{ listing_id: listingId, listing_title: 'Photo service', price: 30 }], {
    [listingId]: {
      products: [
        { property_values: [{ property_id: 1, values: ['1 min'] }], offerings: [{ price: 30, quantity: 5, is_enabled: true, readiness_state_id: 801 }] },
        { property_values: [{ property_id: 1, values: ['2 min'] }], offerings: [{ price: 37, quantity: 5, is_enabled: true, readiness_state_id: 801 }] },
      ],
      price_on_property: [1],
    },
  })[0];
  expect(plan.fault).toBeUndefined();
  expect(plan.clear_to.products[0].offerings[0]).toMatchObject({ price: 30, quantity: 10, readiness_state_id: 801 });
});
