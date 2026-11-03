import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { mergeCreateDraftPatch } from '../api/drafts.js';
import { classifyAgentRuntimeError } from '../public/utils/agent-runtime-contract.js';
import {
  listingReadiness,
  migrateLegacyVariationPrices,
  moneyNumber,
  variationPriceSummary,
} from '../public/utils/listing-readiness.js';
import { buildDraftVariations, draftVariationPriceRows, draftVariationsToInventoryPayload } from '../public/utils/etsy-variations.js';

async function withUploaderGlobals(run) {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = {};
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ textContent: '' }),
    head: { appendChild: () => {} },
  };
  try {
    const { ImageUploader } = await import('../public/components/image-uploader.js');
    return await run(ImageUploader);
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
  }
}

test('agent draft patch preserves content and media while updating type and variations', () => {
  const current = {
    title: 'Personalized portrait',
    listingType: 'download',
    draftImages: [{ id: 'image-1', dataUrl: 'data:image/png;base64,AAAA' }],
    revision: 10,
  };
  const variations = {
    enabled: true,
    properties: [{ property_id: 200, name: 'Color', options: [{ value_id: 1, name: 'Blue' }] }],
    products: [{ price: 25, quantity: 999, offerings: [{ property_id: 200, value_id: 1 }] }],
    priceOnProperty: [200],
  };
  const result = mergeCreateDraftPatch(current, { listingType: 'physical', variations });

  expect(result).toMatchObject({ title: current.title, listingType: 'physical', variations });
  expect(result.draftImages).toEqual(current.draftImages);
  expect(current.listingType).toBe('download');
});

test('agent draft patch persists the complete physical listing setup', () => {
  const result = mergeCreateDraftPatch({ title: 'Physical keepsake' }, {
    listingType: 'physical',
    price: 30,
    taxonomy_id: 77,
    taxonomy_category: 'Art & Collectibles > Drawing & Illustration > Digital',
    shipping_profile_id: 148610403760,
    readiness_state_id: 1405042501851,
    return_policy_id: 1074832365360,
    shop_section_id: 53935278,
    quantity: 999,
  });

  expect(result).toMatchObject({
    listingType: 'physical',
    price: '30',
    taxonomy_id: 77,
    shipping_profile_id: 148610403760,
    readiness_state_id: 1405042501851,
    quantity: 999,
  });
});

test('legacy variation adjustments migrate to final buyer prices', () => {
  const legacy = {
    enabled: true,
    products: [
      { price: 0, quantity: 999, is_enabled: true },
      { price: 5, quantity: 999, is_enabled: true },
    ],
  };
  const migrated = migrateLegacyVariationPrices(legacy, '$30.00');
  expect(migrated.migrated).toBe(true);
  expect(migrated.variations.products.map(product => product.price)).toEqual([30, 35]);
  expect(variationPriceSummary(migrated.variations)).toMatchObject({ valid: true, min: 30, max: 35 });
});

test('agent variation plans convert to Etsy inventory with final prices and processing profile', () => {
  const variations = buildDraftVariations({
    base_price: 30,
    properties: [
      { name: 'Video length', pricing_mode: 'final_price', options: [{ name: 'Up to 1 minute', amount: 30 }, { name: 'Up to 2 minutes', amount: 37 }] },
      { name: 'Colorization', pricing_mode: 'surcharge', options: [{ name: 'Restoration only', amount: 0 }, { name: 'Add colorization', amount: 5 }] },
    ],
  });
  const inventory = draftVariationsToInventoryPayload(variations, 1405042501863);

  expect(inventory.products.map(product => product.offerings[0].price)).toEqual([30, 35, 37, 42]);
  expect(inventory.products.every(product => product.offerings[0].readiness_state_id === 1405042501863)).toBe(true);
  expect(inventory.products[0].property_values.map(property => property.property_id)).toEqual([513, 514]);
  expect(inventory.price_on_property).toEqual([513, 514]);
});

test('legacy mixed price fields resolve to an unambiguous final price matrix', () => {
  const rows = draftVariationPriceRows({
    base_price: 30,
    properties: [
      { name: 'Video length', options: [{ name: 'Up to 1 minute', price: 30 }, { name: 'Up to 2 minutes', price: 40 }] },
      { name: 'Colorization', options: [
        { name: 'Restoration only', price: 30, price_adjustment: 0 },
        { name: 'Add colorization', price: 30, price_adjustment: 10 },
      ] },
    ],
  });
  expect(rows.map(row => row.price)).toEqual([30, 40, 40, 50]);
});

test('publish readiness reports missing physical requirements and invalid variants', () => {
  const report = listingReadiness({
    title: 'Physical keepsake',
    listingType: 'physical',
    basePrice: '$30.00',
    taxonomyId: 77,
    variations: { enabled: true, products: [{ price: 0, is_enabled: true }] },
  });
  expect(moneyNumber('$30.00')).toBe(30);
  expect(report.ready).toBe(false);
  expect(report.blockers.map(blocker => blocker.key)).toEqual(['shipping', 'processing', 'variations']);
});

test('rate limit errors are not collapsed into APP_INTERNAL_ERROR', () => {
  const fault = classifyAgentRuntimeError(new Error('Request failed: HTTP 429 Too many requests'), { operation: 'agent_turn_request' });
  expect(fault).toMatchObject({ code: 'APP_RATE_LIMITED', retryable: true, operation: 'agent_turn_request' });
});

test('Create autosave is dirty-only and is cleaned up before navigation', () => {
  const createSource = fs.readFileSync(new URL('../public/pages/create.js', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const agentSource = fs.readFileSync(new URL('../public/pages/agent.js', import.meta.url), 'utf8');
  expect(createSource).toContain("setInterval(() => saveDraft({ skipIfClean: true }), 5000)");
  expect(createSource).toContain("window.__pageCleanup = async () =>");
  expect(appSource).toContain("await cleanup()");
  expect(agentSource).toContain("`${LAST_AGENT_DRAFT_KEY}:${_currentSessionId || 'unassigned'}`");
  expect(agentSource).toContain('restoreLatestAgentDraftFromMessages(agentMessages)');
});

test('restoring and reopening drafts cannot replay stale snapshots', () => {
  const createSource = fs.readFileSync(new URL('../public/pages/create.js', import.meta.url), 'utf8');
  const agentSource = fs.readFileSync(new URL('../public/pages/agent.js', import.meta.url), 'utf8');

  expect(createSource).toContain('if (state.generated && !state.restoringDraft)');
  expect(createSource).toContain('state.restoringDraft = false;');
  expect(createSource).not.toContain('setTimeout(async () => {\n      const titleEl');
  expect(agentSource).toContain("await window.navigate('create', { restoreDraft: true })");
  expect(agentSource).toContain('const restoredSnapshot = Boolean(options.restored && params.generated)');
  expect(agentSource).toContain("card.querySelectorAll('button').forEach(button => { button.disabled = true; })");
});

test('Create review keeps optional media compact and personalization full width', () => {
  const createSource = fs.readFileSync(new URL('../public/pages/create.js', import.meta.url), 'utf8');
  const agentSource = fs.readFileSync(new URL('../public/pages/agent.js', import.meta.url), 'utf8');
  expect(createSource).not.toContain('id="animate-video-btn"');
  expect(createSource).toContain('class="create-video-panel"');
  expect(createSource).toContain('${personalizationMarkup}');
  expect(createSource).not.toContain('create-readiness-card" id="publish-readiness"');
  expect(createSource).toContain('if (state.restoringDraft) await hydrateRestoredDraftImages()');
  expect(createSource).toContain('etsyDraftListingId: Number(state.publishedId || 0) || null');
  expect(createSource).toContain("btn.innerHTML = 'Retry remaining steps'");
  expect(agentSource).not.toContain('100 + index');
  expect(agentSource).toContain("from '../utils/etsy-variations.js'");
  const createCall = createSource.indexOf('result = await etsy.createListing(payload)');
  const inventoryCall = createSource.indexOf('await etsy.updateListingInventory(result.listing_id', createCall);
  const imageUpload = createSource.indexOf('await uploadPendingImagesWithProgress(result.listing_id', createCall);
  expect(createCall).toBeGreaterThan(-1);
  expect(inventoryCall).toBeGreaterThan(createCall);
  expect(imageUpload).toBeGreaterThan(inventoryCall);
});

test('restored Etsy CDN images are copied to the new listing and bound to its ID', async () => {
  await withUploaderGlobals(async ImageUploader => {
    let requestBody = null;
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ data: { listing_image_id: 991, url_fullxfull: 'https://i.etsystatic.com/new.jpg' } }),
      };
    };
    const uploader = new ImageUploader('test-uploader');
    uploader.addRemoteImages([{ id: 123, sourceUrl: 'https://i.etsystatic.com/old.jpg', rank: 1 }]);

    await uploader.uploadAllPending(4540996015);

    expect(requestBody).toMatchObject({
      action: 'uploadImageFromUrl',
      listing_id: 4540996015,
      imageUrl: 'https://i.etsystatic.com/old.jpg',
      rank: 1,
    });
    expect(uploader.getUnattachedImages(4540996015)).toEqual([]);
    expect(uploader.images[0]).toMatchObject({ isExisting: true, etsyListingId: 4540996015, sourceUrl: null });
  });
});

test('image upload failures reject instead of reporting false success', async () => {
  await withUploaderGlobals(async ImageUploader => {
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'Etsy upload rejected' }) });
    const uploader = new ImageUploader('test-uploader');
    uploader.addRemoteImages([{ sourceUrl: 'https://i.etsystatic.com/old.jpg' }]);

    await expect(uploader.uploadAllPending(4540996015)).rejects.toThrow('Etsy upload rejected');
    expect(uploader.images[0]).toMatchObject({ isExisting: false, error: 'Etsy upload rejected' });
  });
});

test('Create verifies Etsy image attachment and offers direct post-create editing', () => {
  const createSource = fs.readFileSync(new URL('../public/pages/create.js', import.meta.url), 'utf8');
  expect(createSource).toContain('etsyListingId: Number(img?.etsyListingId || 0) || null');
  expect(createSource).toContain('state.imageUploader.addRemoteImages(pendingRemoteImages)');
  expect(createSource).toContain('await etsy.getListingImages(listingId)');
  expect(createSource).toContain('Continue editing in Etsy AI Command Center');
  expect(createSource).toContain("window.navigate('create', {listing_id:");
  expect(createSource).toContain("source: state.mode === 'edit' ? 'etsy_listing' : 'local_draft'");
});
