const DEFAULT_SERVER_URL = 'https://dashboard.example.test';

export const GPT_OAUTH_SCOPES = Object.freeze({
  'gpt:read': 'Read shop, listing, order, taxonomy, review, stats, media, and discount data.',
  'financial:read': 'Read receipts, transactions, payments, ledger entries, and computed sales summaries.',
  'shop:write': 'Manage shop settings, sections, shipping profiles, and return policies.',
  'listings:write': 'Create and edit draft listings, inventory, personalization, and sections.',
  'listings:publish': 'Publish or deactivate a listing after explicit confirmation.',
  'listings:delete': 'Delete listings or listing media after explicit confirmation.',
  'files:write': 'Upload listing images, videos, and digital files.',
  'orders:write': 'Submit shipment updates after explicit confirmation.',
  'discounts:write': 'Create, update, or delete discounts after explicit confirmation.',
});

const JSON_CONTENT = 'application/json';
const GPT_LANGUAGES = ['de', 'en', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt'];
const idempotencyProperty = () => ({ $ref: '#/components/schemas/IdempotencyKey' });

const CHATGPT_IMAGE_FILE_DESCRIPTION = 'Images generated or uploaded in the current ChatGPT conversation. Attach 1–10 image files.';

function fileInputSchema(maxItems, { idempotency = false, fileDescription } = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      openaiFileIdRefs: { type: 'array', minItems: 1, maxItems, items: { type: 'string' }, description: fileDescription || `Attach 1–${maxItems} files from the current ChatGPT conversation.` },
      source_url: { type: 'string', format: 'uri', description: 'Temporary HTTPS fallback URL on an explicitly allowlisted public host.' },
      source_urls: { type: 'array', minItems: 1, maxItems, items: { type: 'string', format: 'uri' }, description: 'Ordered temporary HTTPS fallback URLs on explicitly allowlisted public hosts.' },
      file_metadata: { type: 'array', minItems: 1, maxItems, description: 'Metadata by file index; preserves independent rank, alt text, name, and workflow target.', items: { $ref: '#/components/schemas/FileMetadata' } },
      rank: { type: 'integer', minimum: 1, maximum: 20 },
      alt_text: { type: 'string', maxLength: 250 },
      ...(idempotency ? { idempotency_key: idempotencyProperty() } : {}),
    },
  };
}

function actionVariant(action, required = [], properties = {}) {
  return { required: ['action', ...required], properties: { action: { const: action }, ...properties } };
}

function exactData(allowed, required = []) {
  return { type: 'object', additionalProperties: false, required, properties: Object.fromEntries(allowed.map(name => [name, {}])) };
}

function listingSchema({ patch = false, idempotency = false } = {}) {
  const properties = {
    title: { type: 'string', minLength: 1, maxLength: 140 },
    description: { type: 'string', minLength: 1, maxLength: 50000 },
    price: { type: 'number', minimum: 0.2 },
    quantity: { type: 'integer', minimum: 1, maximum: 999 },
    taxonomy_id: { type: 'integer', minimum: 1 },
    who_made: { type: 'string', enum: ['i_did', 'collective', 'someone_else'] },
    when_made: { type: 'string' },
    listing_type: { type: 'string', enum: ['physical', 'download'] },
    language: { type: 'string', enum: GPT_LANGUAGES },
    is_supply: { type: 'boolean' },
    should_auto_renew: { type: 'boolean' },
    processing_min: { type: 'integer', minimum: 1 },
    processing_max: { type: 'integer', minimum: 1 },
    tags: { type: 'array', maxItems: 13, items: { type: 'string', maxLength: 20 } },
    materials: { type: 'array', maxItems: 13, items: { type: 'string' } },
    shipping_profile_id: { type: 'integer', minimum: 1 },
    return_policy_id: { type: 'integer', minimum: 1 },
    readiness_state_id: { type: 'integer', minimum: 1 },
    shop_section_id: { type: 'integer', minimum: 1 },
    ...(idempotency ? { idempotency_key: idempotencyProperty() } : {}),
  };
  const actualFields = Object.keys(properties).filter(name => name !== 'idempotency_key');
  return {
    type: 'object',
    additionalProperties: false,
    ...(patch
      ? { anyOf: actualFields.map(name => ({ required: [name] })) }
      : { required: ['title', 'description', 'price', 'quantity', 'taxonomy_id', 'who_made', 'when_made', 'listing_type'] }),
    properties,
  };
}

function completeDraftSchema() {
  const files = fileInputSchema(10).properties;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['listing'],
    dependentRequired: {
      openaiFileIdRefs: ['file_metadata'],
      source_url: ['file_metadata'],
      source_urls: ['file_metadata'],
    },
    properties: {
      listing: { $ref: '#/components/schemas/ListingDraftPayload' },
      inventory: { $ref: '#/components/schemas/InventoryInput' },
      personalization: { $ref: '#/components/schemas/PersonalizationInput' },
      personalization_questions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object' } },
      openaiFileIdRefs: {
        ...files.openaiFileIdRefs,
        description: CHATGPT_IMAGE_FILE_DESCRIPTION,
      },
      source_url: files.source_url,
      source_urls: files.source_urls,
      file_metadata: {
        ...files.file_metadata,
        description: 'Required same-order routing metadata for every supplied file.',
        items: { $ref: '#/components/schemas/CompleteDraftFileMetadata' },
      },
      atomic: { type: 'boolean', default: true },
      verify: { type: 'boolean', default: true },
      idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' },
    },
  };
}
const successResponse = {
  description: 'Successful response.',
  content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/SuccessResponse' } } },
};
const acceptedResponse = {
  description: 'The bounded workflow completed or returned a structured partial result.',
  content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/SuccessResponse' } } },
};
const errorResponses = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': { $ref: '#/components/responses/Forbidden' },
  '429': { $ref: '#/components/responses/RateLimited' },
};

function operation({
  id,
  summary,
  description,
  tag,
  scopes = ['gpt:read'],
  publicAccess = false,
  consequential = false,
  parameters,
  body,
  accepted = false,
  responses,
}) {
  return {
    operationId: id,
    summary,
    description,
    tags: [tag],
    security: publicAccess ? [] : [{ OAuth2: scopes }],
    'x-openai-isConsequential': consequential,
    ...(parameters?.length ? { parameters } : {}),
    ...(body ? {
      requestBody: {
        required: true,
        content: { [JSON_CONTENT]: { schema: body } },
      },
    } : {}),
    responses: responses || {
      '200': accepted ? acceptedResponse : successResponse,
      ...errorResponses,
    },
  };
}

const pathId = (name, description) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'integer', minimum: 1 },
});
const listingId = pathId('listing_id', 'Positive Etsy listing ID.');
const imageId = pathId('image_id', 'Positive Etsy listing image ID.');
const videoId = pathId('video_id', 'Positive Etsy listing video ID.');
const fileId = pathId('file_id', 'Positive Etsy digital listing file ID.');
const receiptId = pathId('receipt_id', 'Positive Etsy receipt ID.');
const taxonomyId = pathId('taxonomy_id', 'Positive Etsy seller taxonomy node ID.');
const discountId = pathId('discount_id', 'Positive Etsy discount ID.');

const confirmationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmation'],
  properties: {
    confirmation: {
      const: true,
      description: 'Must be true only after the user explicitly confirms this consequential change.',
    },
    idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' },
  },
};

const pagination = [
  { name: 'limit', in: 'query', description: 'Page size from 1 to 100.', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
  { name: 'offset', in: 'query', description: 'Zero-based result offset.', schema: { type: 'integer', minimum: 0, default: 0 } },
];

function cleanServerUrl(value) {
  try {
    const url = new URL(String(value || DEFAULT_SERVER_URL));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return DEFAULT_SERVER_URL;
    return url.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

export function buildFullGptOpenApi({ serverUrl = process.env.GPT_OAUTH_ISSUER || DEFAULT_SERVER_URL } = {}) {
  const server = cleanServerUrl(serverUrl);
  const read = ['gpt:read'];
  const listingWrite = ['listings:write'];
  const fileWrite = ['files:write'];

  return {
    openapi: '3.1.0',
    info: {
      title: 'Etsy AI Command Center GPT Actions',
      version: '1.0.0',
      description: 'Scoped Etsy shop management API for ChatGPT. Draft-only writes are separated from consequential publish, delete, shipment, and discount operations.',
    },
    servers: [{ url: server }],
    externalDocs: { description: 'Privacy policy', url: `${server}/gpt/privacy` },
    tags: [
      { name: 'Public', description: 'Public integration metadata.' },
      { name: 'Shop', description: 'Shop configuration and statistics.' },
      { name: 'Listings', description: 'Listing reads and explicitly bounded changes.' },
      { name: 'Media', description: 'Listing images, videos, and digital files.' },
      { name: 'Workflows', description: 'Bounded synchronous draft workflows.' },
      { name: 'Orders', description: 'Receipts, transactions, and shipment updates.' },
      { name: 'Catalog', description: 'Taxonomy, properties, and reviews.' },
      { name: 'Discounts', description: 'Discount reads and confirmed financial changes.' },
    ],
    paths: {
      '/gpt/openapi.json': {
        get: operation({
          id: 'getGptOpenApi', summary: 'Get the GPT Actions schema', description: 'Returns this public OpenAPI schema.', tag: 'Public', publicAccess: true,
          responses: { '200': { description: 'OpenAPI 3.1 schema.', content: { [JSON_CONTENT]: { schema: { type: 'object', additionalProperties: true } } } } },
        }),
      },
      '/gpt/privacy': {
        get: operation({
          id: 'getGptPrivacyPolicy', summary: 'Get the privacy policy', description: 'Returns the public privacy policy for this GPT integration.', tag: 'Public', publicAccess: true,
          responses: { '200': { description: 'Human-readable privacy policy.', content: { 'text/html': { schema: { type: 'string' } } } } },
        }),
      },
      '/api/gpt/status': {
        get: operation({
          id: 'getGptIntegrationStatus', summary: 'Get GPT integration status', description: 'Reports non-secret readiness flags for OAuth and Etsy connectivity.', tag: 'Public', publicAccess: true,
          responses: { '200': successResponse },
        }),
      },

      '/api/gpt/resources/read': {
        post: operation({ id: 'readEtsyResource', summary: 'Read an allowlisted Etsy resource', description: 'Reads one explicitly enumerated shop, listing, catalog, media, or discount resource. It never accepts an arbitrary URL or HTTP method.', tag: 'Catalog', scopes: read, body: { $ref: '#/components/schemas/ReadEtsyResourceInput' } }),
      },
      '/api/gpt/resources/shop/manage': {
        post: operation({ id: 'manageShopResource', summary: 'Manage an allowlisted shop resource', description: 'Creates, updates, or deletes an enumerated shop setting, section, shipping profile, or return policy after confirmation.', tag: 'Shop', scopes: ['shop:write'], consequential: true, body: { $ref: '#/components/schemas/ManageShopResourceInput' } }),
      },
      '/api/gpt/resources/listing/manage': {
        post: operation({ id: 'manageAdvancedListingResource', summary: 'Update draft variations or advanced fields', description: 'Draft-only and non-publishing. For options, combinations, prices, quantities, or SKUs, first read listing_inventory, then use action=update_inventory with the complete replacement inventory. Never use updateDraftListing for inventory.', tag: 'Listings', scopes: listingWrite, body: { $ref: '#/components/schemas/ManageAdvancedListingInput' } }),
      },
      '/api/gpt/resources/listing/delete': {
        post: operation({ id: 'deleteAdvancedListingResource', summary: 'Delete an advanced draft resource', description: 'Deletes draft personalization or one property only after explicit confirmation.', tag: 'Listings', scopes: ['listings:delete'], consequential: true, body: { $ref: '#/components/schemas/DeleteAdvancedListingInput' } }),
      },
      '/api/gpt/resources/media/manage': {
        post: operation({ id: 'manageListingMedia', summary: 'Manage existing listing media', description: 'Associates or annotates one enumerated existing image, video, or digital file on a draft after confirmation.', tag: 'Media', scopes: fileWrite, consequential: true, body: { $ref: '#/components/schemas/ManageListingMediaInput' } }),
      },
      '/api/gpt/resources/media/delete': {
        post: operation({ id: 'deleteListingMediaResource', summary: 'Delete listing media', description: 'Deletes one existing image, video, or digital file from a draft after explicit confirmation.', tag: 'Media', scopes: ['listings:delete'], consequential: true, body: { $ref: '#/components/schemas/DeleteListingMediaInput' } }),
      },
      '/api/gpt/resources/financial/read': {
        post: operation({ id: 'readFinancialResource', summary: 'Read an allowlisted financial resource', description: 'Reads receipts, transactions, payments, ledger entries, or bounded computed summaries. It never performs financial writes.', tag: 'Orders', scopes: ['financial:read'], body: { $ref: '#/components/schemas/ReadFinancialResourceInput' } }),
      },
      '/api/gpt/resources/discounts/manage': {
        post: operation({ id: 'manageDiscountResource', summary: 'Manage an allowlisted discount', description: 'Creates, updates, or deletes a discount through an enumerated action after explicit confirmation.', tag: 'Discounts', scopes: ['discounts:write'], consequential: true, body: { $ref: '#/components/schemas/ManageDiscountResourceInput' } }),
      },

      '/api/gpt/profile': {
        get: operation({ id: 'getEtsyUserProfile', summary: 'Get the connected Etsy profile', description: 'Returns the Etsy user profile associated with the server-side Etsy authorization.', tag: 'Shop', scopes: read }),
      },

      '/api/gpt/shop': {
        get: operation({ id: 'getShopProfile', summary: 'Get the Etsy shop', description: 'Returns the connected Etsy shop profile.', tag: 'Shop', scopes: read }),
      },
      '/api/gpt/shop/sections': {
        get: operation({ id: 'listShopSections', summary: 'List shop sections', description: 'Returns sections configured for the connected shop.', tag: 'Shop', scopes: read }),
        post: operation({ id: 'createShopSection', summary: 'Create a shop section', description: 'Creates a named section without changing any listing.', tag: 'Shop', scopes: ['shop:write'], body: { $ref: '#/components/schemas/ShopSectionInput' } }),
      },
      '/api/gpt/shipping-profiles': {
        get: operation({ id: 'listShippingProfiles', summary: 'List shipping profiles', description: 'Returns shipping profiles usable by physical listings.', tag: 'Shop', scopes: read }),
      },
      '/api/gpt/return-policies': {
        get: operation({ id: 'listReturnPolicies', summary: 'List return policies', description: 'Returns shop return policies.', tag: 'Shop', scopes: read }),
      },
      '/api/gpt/readiness-states': {
        get: operation({ id: 'listReadinessStates', summary: 'List readiness states', description: 'Returns processing readiness definitions for listings.', tag: 'Shop', scopes: read }),
      },
      '/api/gpt/stats': {
        get: operation({
          id: 'getShopStats', summary: 'Get shop statistics', description: 'Computes bounded shop, listing, order, or gross-revenue summaries from documented Etsy resources.', tag: 'Shop', scopes: ['financial:read'],
          parameters: [{ name: 'kind', in: 'query', required: true, description: 'Statistic group to return.', schema: { type: 'string', enum: ['shop', 'listings', 'orders', 'revenue'] } }, { name: 'days', in: 'query', description: 'Bounded lookback period.', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } }],
        }),
      },

      '/api/gpt/listings/search': {
        get: operation({
          id: 'searchListings', summary: 'Search Etsy listings', description: 'Searches Etsy active listings by keywords.', tag: 'Listings', scopes: read,
          parameters: [{ name: 'keyword', in: 'query', required: true, description: 'Search phrase.', schema: { type: 'string', minLength: 1, maxLength: 140 } }, { name: 'limit', in: 'query', description: 'Result limit.', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }],
        }),
      },
      '/api/gpt/listings': {
        get: operation({
          id: 'listShopListings', summary: 'List shop listings', description: 'Returns a bounded page of shop listings.', tag: 'Listings', scopes: read,
          parameters: [...pagination, { name: 'state', in: 'query', description: 'Listing state filter.', schema: { type: 'string', enum: ['active', 'draft', 'inactive', 'expired', 'sold_out'] } }],
        }),
        post: operation({ id: 'createDraftListing', summary: 'Create a draft listing', description: 'Creates one listing in draft state only.', tag: 'Listings', scopes: listingWrite, body: { $ref: '#/components/schemas/DraftListingInput' } }),
      },
      '/api/gpt/listings/{listing_id}': {
        get: operation({ id: 'getListing', summary: 'Get a listing', description: 'Returns a listing with inventory, images, video, and personalization associations.', tag: 'Listings', scopes: read, parameters: [listingId] }),
        patch: operation({ id: 'updateDraftListing', summary: 'Update draft metadata only', description: 'Updates metadata only. It never changes variation options, combinations, offering prices, quantities, or SKUs. Use manageAdvancedListingResource action=update_inventory for every inventory change.', tag: 'Listings', scopes: listingWrite, parameters: [listingId], body: { $ref: '#/components/schemas/DraftListingPatch' } }),
      },
      '/api/gpt/listings/{listing_id}/preview': {
        post: operation({ id: 'previewListingChange', summary: 'Preview a metadata change', description: 'Previews metadata only without writing. Variation options and offering prices must be read and replaced through inventory operations.', tag: 'Listings', scopes: read, parameters: [listingId], body: { $ref: '#/components/schemas/DraftListingPatch' } }),
      },
      '/api/gpt/listings/{listing_id}/publish': {
        post: operation({ id: 'publishListing', summary: 'Publish a draft listing', description: 'Publishes a listing only after explicit confirmation.', tag: 'Listings', scopes: ['listings:publish'], consequential: true, parameters: [listingId], body: confirmationSchema }),
      },
      '/api/gpt/listings/{listing_id}/deactivate': {
        post: operation({ id: 'deactivateListing', summary: 'Deactivate a listing', description: 'Deactivates an active listing only after explicit confirmation.', tag: 'Listings', scopes: ['listings:publish'], consequential: true, parameters: [listingId], body: confirmationSchema }),
      },
      '/api/gpt/listings/{listing_id}/delete': {
        post: operation({ id: 'deleteListing', summary: 'Delete a listing', description: 'Permanently deletes a listing only after explicit confirmation.', tag: 'Listings', scopes: ['listings:delete'], consequential: true, parameters: [listingId], body: confirmationSchema }),
      },
      '/api/gpt/listings/{listing_id}/inventory': {
        get: operation({ id: 'getListingInventory', summary: 'Get listing inventory', description: 'Returns products, offerings, variations, and SKUs.', tag: 'Listings', scopes: read, parameters: [listingId] }),
        put: operation({ id: 'updateDraftListingInventory', summary: 'Update draft inventory', description: 'Replaces inventory for a draft listing and validates variation structure.', tag: 'Listings', scopes: listingWrite, parameters: [listingId], body: { $ref: '#/components/schemas/InventoryWriteInput' } }),
      },
      '/api/gpt/listings/{listing_id}/personalization': {
        get: operation({ id: 'getListingPersonalization', summary: 'Get personalization', description: 'Returns listing personalization questions.', tag: 'Listings', scopes: read, parameters: [listingId] }),
        put: operation({ id: 'updateDraftPersonalization', summary: 'Update draft personalization', description: 'Replaces personalization questions for a draft listing.', tag: 'Listings', scopes: listingWrite, parameters: [listingId], body: { $ref: '#/components/schemas/PersonalizationWriteInput' } }),
      },
      '/api/gpt/listings/{listing_id}/personalization/delete': {
        post: operation({ id: 'deleteListingPersonalization', summary: 'Delete personalization', description: 'Deletes personalization only after explicit confirmation.', tag: 'Listings', scopes: ['listings:delete'], consequential: true, parameters: [listingId], body: confirmationSchema }),
      },

      '/api/gpt/listings/{listing_id}/images': {
        get: operation({ id: 'listListingImages', summary: 'List listing images', description: 'Returns ordered image metadata and alt text.', tag: 'Media', scopes: read, parameters: [listingId] }),
        post: operation({ id: 'uploadListingImages', summary: 'Upload listing images', description: 'Immediately downloads up to 10 ChatGPT files in order, normalizes images, and uploads them to a draft.', tag: 'Media', scopes: fileWrite, parameters: [listingId], body: { $ref: '#/components/schemas/ImageUploadInput' } }),
      },
      '/api/gpt/listings/{listing_id}/images/{image_id}/alt-text': {
        patch: operation({ id: 'updateListingImageAltText', summary: 'Update image alt text', description: 'Updates validated Etsy image alt text.', tag: 'Media', scopes: fileWrite, parameters: [listingId, imageId], body: { $ref: '#/components/schemas/AltTextInput' } }),
      },
      '/api/gpt/listings/{listing_id}/images/{image_id}/delete': {
        post: operation({ id: 'deleteListingImage', summary: 'Delete a listing image', description: 'Deletes a listing image only after explicit confirmation.', tag: 'Media', scopes: ['listings:delete'], consequential: true, parameters: [listingId, imageId], body: confirmationSchema }),
      },
      '/api/gpt/listings/{listing_id}/videos': {
        get: operation({ id: 'listListingVideos', summary: 'List listing videos', description: 'Returns listing video metadata.', tag: 'Media', scopes: read, parameters: [listingId] }),
        post: operation({ id: 'uploadListingVideo', summary: 'Upload a listing video', description: 'Downloads and uploads one validated ChatGPT video to a draft listing.', tag: 'Media', scopes: fileWrite, parameters: [listingId], body: { $ref: '#/components/schemas/VideoUploadInput' } }),
      },
      '/api/gpt/listings/{listing_id}/videos/{video_id}/delete': {
        post: operation({ id: 'deleteListingVideo', summary: 'Delete a listing video', description: 'Deletes a listing video only after explicit confirmation.', tag: 'Media', scopes: ['listings:delete'], consequential: true, parameters: [listingId, videoId], body: confirmationSchema }),
      },
      '/api/gpt/listings/{listing_id}/files': {
        get: operation({ id: 'listDigitalListingFiles', summary: 'List digital listing files', description: 'Returns digital file metadata without exposing private source URLs.', tag: 'Media', scopes: read, parameters: [listingId] }),
        post: operation({ id: 'uploadDigitalListingFiles', summary: 'Upload digital listing files', description: 'Downloads and uploads up to five ordered validated ChatGPT files to a draft digital listing.', tag: 'Media', scopes: fileWrite, parameters: [listingId], body: { $ref: '#/components/schemas/DigitalFileUploadInput' } }),
      },
      '/api/gpt/listings/{listing_id}/files/{file_id}/delete': {
        post: operation({ id: 'deleteDigitalListingFile', summary: 'Delete a digital file', description: 'Deletes a digital listing file only after explicit confirmation.', tag: 'Media', scopes: ['listings:delete'], consequential: true, parameters: [listingId, fileId], body: confirmationSchema }),
      },

      '/api/gpt/workflows/complete-draft': {
        post: operation({ id: 'createCompleteDraft', summary: 'Create a complete draft', description: 'Creates one draft with bounded inventory, personalization, and media steps; rolls back the new draft on failure.', tag: 'Workflows', scopes: listingWrite, body: { $ref: '#/components/schemas/CompleteDraftInput' }, accepted: true }),
      },
      '/api/gpt/workflows/duplicate-listing': {
        post: operation({ id: 'duplicateAndCustomizeListing', summary: 'Duplicate and customize a listing', description: 'Copies one listing into a draft and applies validated draft-safe changes.', tag: 'Workflows', scopes: listingWrite, body: { $ref: '#/components/schemas/DuplicateListingInput' }, accepted: true }),
      },
      '/api/gpt/workflows/bulk-create-drafts': {
        post: operation({ id: 'bulkCreateDrafts', summary: 'Create multiple drafts', description: 'Creates at most five drafts sequentially and returns per-item results within the Action timeout.', tag: 'Workflows', scopes: listingWrite, body: { $ref: '#/components/schemas/BulkCreateInput' }, accepted: true }),
      },
      '/api/gpt/workflows/bulk-update-listings': {
        post: operation({ id: 'bulkUpdateListings', summary: 'Update multiple listings', description: 'Updates bounded fields on at most ten listings after explicit confirmation and returns per-item results.', tag: 'Workflows', scopes: listingWrite, consequential: true, body: { $ref: '#/components/schemas/BulkUpdateInput' }, accepted: true }),
      },

      '/api/gpt/receipts': {
        get: operation({ id: 'listReceipts', summary: 'List Etsy receipts', description: 'Returns a bounded page of receipts with transaction summaries.', tag: 'Orders', scopes: ['financial:read'], parameters: pagination }),
      },
      '/api/gpt/receipts/{receipt_id}': {
        get: operation({ id: 'getReceipt', summary: 'Get an Etsy receipt', description: 'Returns one receipt with transactions and lifecycle state.', tag: 'Orders', scopes: ['financial:read'], parameters: [receiptId] }),
      },
      '/api/gpt/transactions': {
        get: operation({ id: 'listTransactions', summary: 'List Etsy transactions', description: 'Returns a bounded page of shop transactions.', tag: 'Orders', scopes: ['financial:read'], parameters: pagination }),
      },
      '/api/gpt/receipts/{receipt_id}/shipment': {
        post: operation({ id: 'updateReceiptShipment', summary: 'Submit a shipment update', description: 'Adds tracking and buyer notification only after explicit confirmation.', tag: 'Orders', scopes: ['orders:write'], consequential: true, parameters: [receiptId], body: { $ref: '#/components/schemas/ShipmentInput' } }),
      },

      '/api/gpt/taxonomy': {
        get: operation({ id: 'listSellerTaxonomy', summary: 'List seller taxonomy', description: 'Returns Etsy seller taxonomy nodes.', tag: 'Catalog', scopes: read }),
      },
      '/api/gpt/taxonomy/{taxonomy_id}/properties': {
        get: operation({ id: 'listTaxonomyProperties', summary: 'List taxonomy properties', description: 'Returns properties allowed for a seller taxonomy node.', tag: 'Catalog', scopes: read, parameters: [taxonomyId] }),
      },
      '/api/gpt/reviews': {
        get: operation({ id: 'listShopReviews', summary: 'List shop reviews', description: 'Returns a bounded page of Etsy shop reviews.', tag: 'Catalog', scopes: read, parameters: pagination }),
      },

      '/api/gpt/discounts': {
        get: operation({ id: 'listDiscounts', summary: 'List discounts', description: 'Returns shop discounts.', tag: 'Discounts', scopes: read }),
        post: operation({ id: 'createDiscount', summary: 'Create a discount', description: 'Creates a financially consequential discount only after explicit confirmation.', tag: 'Discounts', scopes: ['discounts:write'], consequential: true, body: { $ref: '#/components/schemas/DiscountInput' } }),
      },
      '/api/gpt/discounts/{discount_id}': {
        get: operation({ id: 'getDiscount', summary: 'Get a discount', description: 'Returns one shop discount.', tag: 'Discounts', scopes: read, parameters: [discountId] }),
        patch: operation({ id: 'updateDiscount', summary: 'Update a discount', description: 'Updates a financially consequential discount only after explicit confirmation.', tag: 'Discounts', scopes: ['discounts:write'], consequential: true, parameters: [discountId], body: { $ref: '#/components/schemas/DiscountInput' } }),
      },
      '/api/gpt/discounts/{discount_id}/delete': {
        post: operation({ id: 'deleteDiscount', summary: 'Delete a discount', description: 'Deletes a discount only after explicit confirmation.', tag: 'Discounts', scopes: ['discounts:write'], consequential: true, parameters: [discountId], body: confirmationSchema }),
      },
    },
    components: {
      securitySchemes: {
        OAuth2: {
          type: 'oauth2',
          description: 'Authorization Code flow for ChatGPT; separate from Etsy OAuth.',
          flows: {
            authorizationCode: {
              authorizationUrl: `${server}/oauth/authorize`,
              tokenUrl: `${server}/oauth/token`,
              refreshUrl: `${server}/oauth/token`,
              scopes: GPT_OAUTH_SCOPES,
            },
          },
        },
      },
      responses: {
        BadRequest: { description: 'Request validation failed.', content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        Unauthorized: { description: 'OAuth access token is missing, invalid, revoked, or expired.', content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        Forbidden: { description: 'The token lacks the required scope.', content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        RateLimited: { description: 'Rate limit exceeded; retry later.', content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
      schemas: {
        SuccessResponse: {
          type: 'object', required: ['success'], properties: { success: { type: 'boolean', const: true }, data: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'], description: 'Bounded raw operation result.' } },
        },
        ErrorResponse: {
          type: 'object', required: ['error'], properties: { error: { type: 'string' }, code: { type: 'string' }, details: { type: ['object', 'array', 'string', 'null'] } },
        },
        IdempotencyKey: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: 'Stable key reused only when retrying the same write.' },
        ShopSectionInput: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 24 }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        DraftListingInput: listingSchema({ idempotency: true }),
        ListingDraftPayload: listingSchema(),
        DraftListingPatch: listingSchema({ patch: true, idempotency: true }),
        ListingPatchPayload: listingSchema({ patch: true }),
        InventoryInput: { type: 'object', additionalProperties: true, required: ['products'], properties: { products: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } }, price_on_property: { type: 'array', items: { type: 'integer' } }, quantity_on_property: { type: 'array', items: { type: 'integer' } }, sku_on_property: { type: 'array', items: { type: 'integer' } } } },
        InventoryWriteInput: { type: 'object', additionalProperties: true, required: ['products'], properties: { products: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } }, price_on_property: { type: 'array', items: { type: 'integer' } }, quantity_on_property: { type: 'array', items: { type: 'integer' } }, sku_on_property: { type: 'array', items: { type: 'integer' } }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        PersonalizationInput: { type: 'object', additionalProperties: false, required: ['personalization_questions'], properties: { personalization_questions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object' } } } },
        PersonalizationWriteInput: { type: 'object', additionalProperties: false, required: ['personalization_questions'], properties: { personalization_questions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object' } }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        FileUploadInput: fileInputSchema(10),
        ImageUploadInput: fileInputSchema(10, { idempotency: true, fileDescription: CHATGPT_IMAGE_FILE_DESCRIPTION }),
        VideoUploadInput: fileInputSchema(1, { idempotency: true }),
        DigitalFileUploadInput: fileInputSchema(5, { idempotency: true }),
        WorkflowVideoInput: fileInputSchema(1),
        WorkflowDigitalFileInput: fileInputSchema(5),
        FileMetadata: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, rank: { type: 'integer', minimum: 1, maximum: 20 }, alt_text: { type: 'string', maxLength: 250 }, target: { type: 'string', enum: ['listing_image', 'listing_video', 'digital_file'] } } },
        CompleteDraftFileMetadata: { allOf: [{ $ref: '#/components/schemas/FileMetadata' }], required: ['target'] },
        AltTextInput: { type: 'object', additionalProperties: false, required: ['alt_text'], properties: { alt_text: { type: 'string', minLength: 1, maxLength: 250 }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        CompleteDraftInput: completeDraftSchema(),
        DuplicateListingInput: { type: 'object', additionalProperties: false, required: ['listing_id'], properties: { listing_id: { type: 'integer', minimum: 1 }, changes: { $ref: '#/components/schemas/ListingPatchPayload' }, inventory: { $ref: '#/components/schemas/InventoryInput' }, personalization_questions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object' } }, copy_images: { type: 'boolean', default: true }, copy_video: { type: 'boolean', default: true }, copy_digital_files: { type: 'boolean', default: true }, atomic: { type: 'boolean', default: true }, verify: { type: 'boolean', default: true }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        BulkCreateItem: { type: 'object', additionalProperties: false, required: ['listing'], properties: { listing: { $ref: '#/components/schemas/ListingDraftPayload' }, inventory: { $ref: '#/components/schemas/InventoryInput' }, personalization: { $ref: '#/components/schemas/PersonalizationInput' }, personalization_questions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object' } }, images: { $ref: '#/components/schemas/FileUploadInput' }, video: { $ref: '#/components/schemas/WorkflowVideoInput' }, digital_files: { $ref: '#/components/schemas/WorkflowDigitalFileInput' } } },
        BulkCreateInput: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', minItems: 1, maxItems: 5, items: { $ref: '#/components/schemas/BulkCreateItem' } }, atomic_per_item: { type: 'boolean', default: true }, verify: { type: 'boolean', default: false }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        BulkUpdateItem: { type: 'object', additionalProperties: false, required: ['listing_id'], anyOf: [{ required: ['changes'] }, { required: ['inventory'] }, { required: ['personalization_questions'] }], properties: { listing_id: { type: 'integer', minimum: 1 }, changes: { $ref: '#/components/schemas/ListingPatchPayload' }, inventory: { $ref: '#/components/schemas/InventoryInput' }, personalization_questions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object' } } } },
        BulkUpdateInput: { type: 'object', additionalProperties: false, required: ['confirmation', 'updates'], properties: { confirmation: { const: true, description: 'Must be true after explicit user confirmation.' }, updates: { type: 'array', minItems: 1, maxItems: 10, items: { $ref: '#/components/schemas/BulkUpdateItem' } }, dry_run: { type: 'boolean', default: false }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        ReadEtsyResourceInput: { type: 'object', additionalProperties: false, allOf: [{ oneOf: [
          actionVariant('shop'), actionVariant('shop_sections'), actionVariant('shop_section', ['section_id']),
          actionVariant('shipping_profiles'), actionVariant('shipping_profile', ['shipping_profile_id']), actionVariant('shipping_destinations', ['shipping_profile_id']), actionVariant('shipping_upgrades', ['shipping_profile_id']),
          actionVariant('return_policies'), actionVariant('return_policy', ['return_policy_id']), actionVariant('return_policy_listings', ['return_policy_id']),
          actionVariant('readiness_states'), actionVariant('production_partners'), actionVariant('featured_listings'),
          actionVariant('listing_inventory', ['listing_id']), actionVariant('listing_product', ['listing_id', 'product_id']), actionVariant('listing_offering', ['listing_id', 'product_id', 'offering_id']),
          actionVariant('listing_personalization', ['listing_id']), actionVariant('listing_images', ['listing_id']), actionVariant('listing_image', ['listing_id', 'image_id']), actionVariant('listing_videos', ['listing_id']),
          actionVariant('digital_files', ['listing_id']), actionVariant('digital_file', ['listing_id', 'file_id']), actionVariant('variation_images', ['listing_id']), actionVariant('listing_properties', ['listing_id']), actionVariant('listing_property', ['listing_id', 'property_id']), actionVariant('listing_translation', ['listing_id', 'language']),
          actionVariant('seller_taxonomy'), actionVariant('taxonomy_properties', ['taxonomy_id']), actionVariant('reviews'), actionVariant('discounts'), actionVariant('discount', ['discount_id']),
        ] }], properties: { action: { type: 'string', enum: ['shop', 'shop_sections', 'shop_section', 'shipping_profiles', 'shipping_profile', 'shipping_destinations', 'shipping_upgrades', 'return_policies', 'return_policy', 'return_policy_listings', 'readiness_states', 'production_partners', 'featured_listings', 'listing_inventory', 'listing_product', 'listing_offering', 'listing_personalization', 'listing_images', 'listing_image', 'listing_videos', 'digital_files', 'digital_file', 'variation_images', 'listing_properties', 'listing_property', 'listing_translation', 'seller_taxonomy', 'taxonomy_properties', 'reviews', 'discounts', 'discount'] }, shop_id: { type: 'integer', minimum: 1 }, section_id: { type: 'integer', minimum: 1 }, shipping_profile_id: { type: 'integer', minimum: 1 }, return_policy_id: { type: 'integer', minimum: 1 }, listing_id: { type: 'integer', minimum: 1 }, product_id: { type: 'integer', minimum: 1 }, offering_id: { type: 'integer', minimum: 1 }, image_id: { type: 'integer', minimum: 1 }, file_id: { type: 'integer', minimum: 1 }, property_id: { type: 'integer', minimum: 1 }, taxonomy_id: { type: 'integer', minimum: 1 }, discount_id: { type: 'integer', minimum: 1 }, language: { type: 'string', enum: GPT_LANGUAGES }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0, maximum: 100000 } } },
        ShopResourceData: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, announcement: { type: 'string' }, sale_message: { type: 'string' }, digital_sale_message: { type: 'string' }, policy_additional: { type: 'string' }, origin_country_iso: { type: 'string', minLength: 2, maxLength: 2 }, primary_cost: { type: 'number', minimum: 0 }, secondary_cost: { type: 'number', minimum: 0 }, min_processing_time: { type: 'integer', minimum: 1 }, max_processing_time: { type: 'integer', minimum: 1 }, processing_time_unit: { type: 'string', enum: ['business_days', 'weeks'] }, destination_country_iso: { type: 'string', minLength: 2, maxLength: 2 }, destination_region: { type: 'string', enum: ['eu', 'non_eu', 'none'] }, origin_postal_code: { type: 'string' }, shipping_carrier_id: { type: 'integer', minimum: 0 }, mail_class: { type: 'string' }, min_delivery_days: { type: 'integer', minimum: 1 }, max_delivery_days: { type: 'integer', minimum: 1 }, type: { type: 'integer', enum: [0, 1] }, upgrade_name: { type: 'string' }, price: { type: 'number', minimum: 0 }, secondary_price: { type: 'number', minimum: 0 }, accepts_returns: { type: 'boolean' }, accepts_exchanges: { type: 'boolean' }, return_deadline: { type: 'integer', enum: [7, 14, 21, 30, 45, 60, 90] } } },
        ManageShopResourceInput: { type: 'object', additionalProperties: false, required: ['confirmation'], allOf: [{ oneOf: [
          actionVariant('update_shop', ['data']), actionVariant('create_section', ['data'], { data: exactData(['title'], ['title']) }), actionVariant('update_section', ['section_id', 'data'], { data: exactData(['title'], ['title']) }), actionVariant('delete_section', ['section_id']),
          actionVariant('create_shipping_profile', ['data']), actionVariant('update_shipping_profile', ['shipping_profile_id', 'data']), actionVariant('delete_shipping_profile', ['shipping_profile_id']),
          actionVariant('create_shipping_destination', ['shipping_profile_id', 'data']), actionVariant('update_shipping_destination', ['shipping_profile_id', 'destination_id', 'data']), actionVariant('delete_shipping_destination', ['shipping_profile_id', 'destination_id']),
          actionVariant('create_shipping_upgrade', ['shipping_profile_id', 'data']), actionVariant('update_shipping_upgrade', ['shipping_profile_id', 'upgrade_id', 'data']), actionVariant('delete_shipping_upgrade', ['shipping_profile_id', 'upgrade_id']),
          actionVariant('create_return_policy', ['data']), actionVariant('update_return_policy', ['return_policy_id', 'data']), actionVariant('delete_return_policy', ['return_policy_id']), actionVariant('consolidate_return_policies', ['source_return_policy_id', 'destination_return_policy_id']),
        ] }], properties: { action: { type: 'string', enum: ['update_shop', 'create_section', 'update_section', 'delete_section', 'create_shipping_profile', 'update_shipping_profile', 'delete_shipping_profile', 'create_shipping_destination', 'update_shipping_destination', 'delete_shipping_destination', 'create_shipping_upgrade', 'update_shipping_upgrade', 'delete_shipping_upgrade', 'create_return_policy', 'update_return_policy', 'delete_return_policy', 'consolidate_return_policies'] }, confirmation: { const: true }, shop_id: { type: 'integer', minimum: 1 }, section_id: { type: 'integer', minimum: 1 }, shipping_profile_id: { type: 'integer', minimum: 1 }, destination_id: { type: 'integer', minimum: 1 }, upgrade_id: { type: 'integer', minimum: 1 }, return_policy_id: { type: 'integer', minimum: 1 }, source_return_policy_id: { type: 'integer', minimum: 1 }, destination_return_policy_id: { type: 'integer', minimum: 1 }, data: { $ref: '#/components/schemas/ShopResourceData' }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        AdvancedListingData: { type: 'object', additionalProperties: false, description: 'Action-specific draft data. update_inventory is a complete replacement, not a partial patch. Translation actions require title and description. upsert_property requires matching value_ids and values.', properties: { products: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } }, price_on_property: { type: 'array', items: { type: 'integer' } }, quantity_on_property: { type: 'array', items: { type: 'integer' } }, sku_on_property: { type: 'array', items: { type: 'integer' } }, personalization_questions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object' } }, variation_images: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['property_id', 'value_id', 'image_id'], properties: { property_id: { type: 'integer', minimum: 1 }, value_id: { type: 'integer', minimum: 1 }, image_id: { type: 'integer', minimum: 1 } } } }, title: { type: 'string', minLength: 1, maxLength: 140 }, description: { type: 'string', minLength: 1, maxLength: 50000 }, tags: { type: 'array', maxItems: 13, items: { type: 'string' } }, value_ids: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } }, values: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1, pattern: '^[^()]+$' } }, scale_id: { type: 'integer', minimum: 1 } } },
        ManageAdvancedListingInput: { type: 'object', additionalProperties: false, required: ['listing_id'], allOf: [{ oneOf: [
          actionVariant('update_inventory', ['data'], { data: { $ref: '#/components/schemas/InventoryInput' } }), actionVariant('update_personalization', ['data'], { data: exactData(['personalization_questions'], ['personalization_questions']) }), actionVariant('set_variation_images', ['data'], { data: exactData(['variation_images'], ['variation_images']) }),
          actionVariant('create_translation', ['language', 'data'], { data: exactData(['title', 'description', 'tags'], ['title', 'description']) }), actionVariant('update_translation', ['language', 'data'], { data: exactData(['title', 'description', 'tags'], ['title', 'description']) }),
          actionVariant('upsert_property', ['property_id', 'data'], { data: exactData(['value_ids', 'values', 'scale_id'], ['value_ids', 'values']) }),
        ] }], properties: { action: { type: 'string', enum: ['update_inventory', 'update_personalization', 'set_variation_images', 'create_translation', 'update_translation', 'upsert_property'] }, shop_id: { type: 'integer', minimum: 1 }, listing_id: { type: 'integer', minimum: 1 }, property_id: { type: 'integer', minimum: 1 }, language: { type: 'string', enum: GPT_LANGUAGES }, data: { $ref: '#/components/schemas/AdvancedListingData' }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        DeleteAdvancedListingInput: { type: 'object', additionalProperties: false, required: ['confirmation', 'listing_id'], allOf: [{ oneOf: [actionVariant('delete_personalization'), actionVariant('delete_property', ['property_id'])] }], properties: { action: { type: 'string', enum: ['delete_personalization', 'delete_property'] }, confirmation: { const: true }, shop_id: { type: 'integer', minimum: 1 }, listing_id: { type: 'integer', minimum: 1 }, property_id: { type: 'integer', minimum: 1 }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        ManageListingMediaInput: { type: 'object', additionalProperties: false, required: ['confirmation', 'listing_id'], allOf: [{ oneOf: [actionVariant('update_image_alt_text', ['image_id', 'alt_text']), actionVariant('associate_image', ['image_id']), actionVariant('associate_video', ['video_id']), actionVariant('associate_digital_file', ['file_id'])] }], properties: { action: { type: 'string', enum: ['update_image_alt_text', 'associate_image', 'associate_video', 'associate_digital_file'] }, confirmation: { const: true }, shop_id: { type: 'integer', minimum: 1 }, listing_id: { type: 'integer', minimum: 1 }, image_id: { type: 'integer', minimum: 1 }, video_id: { type: 'integer', minimum: 1 }, file_id: { type: 'integer', minimum: 1 }, rank: { type: 'integer', minimum: 1, maximum: 20 }, alt_text: { type: 'string', maxLength: 250 }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        DeleteListingMediaInput: { type: 'object', additionalProperties: false, required: ['confirmation', 'listing_id'], allOf: [{ oneOf: [actionVariant('delete_image', ['image_id']), actionVariant('delete_video', ['video_id']), actionVariant('delete_digital_file', ['file_id'])] }], properties: { action: { type: 'string', enum: ['delete_image', 'delete_video', 'delete_digital_file'] }, confirmation: { const: true }, shop_id: { type: 'integer', minimum: 1 }, listing_id: { type: 'integer', minimum: 1 }, image_id: { type: 'integer', minimum: 1 }, video_id: { type: 'integer', minimum: 1 }, file_id: { type: 'integer', minimum: 1 }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        ReadFinancialResourceInput: { type: 'object', additionalProperties: false, allOf: [{ oneOf: [
          actionVariant('aggregated_stats'), actionVariant('receipts'), actionVariant('receipt', ['receipt_id']), actionVariant('transactions'), actionVariant('transaction', ['transaction_id']), actionVariant('listing_transactions', ['listing_id']), actionVariant('receipt_transactions', ['receipt_id']),
          actionVariant('payments', ['payment_ids']), actionVariant('receipt_payments', ['receipt_id']), actionVariant('ledger_entries', ['min_created', 'max_created']), actionVariant('ledger_entry', ['ledger_entry_id']), actionVariant('ledger_entry_payments', ['ledger_entry_ids']),
        ] }], properties: { action: { type: 'string', enum: ['aggregated_stats', 'receipts', 'receipt', 'transactions', 'transaction', 'listing_transactions', 'receipt_transactions', 'payments', 'receipt_payments', 'ledger_entries', 'ledger_entry', 'ledger_entry_payments'] }, shop_id: { type: 'integer', minimum: 1 }, kind: { type: 'string', enum: ['shop', 'listings', 'orders', 'revenue'] }, days: { type: 'integer', minimum: 1, maximum: 365, default: 30 }, receipt_id: { type: 'integer', minimum: 1 }, transaction_id: { type: 'integer', minimum: 1 }, listing_id: { type: 'integer', minimum: 1 }, payment_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'integer', minimum: 1 } }, ledger_entry_id: { type: 'integer', minimum: 1 }, ledger_entry_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'integer', minimum: 1 } }, min_created: { type: 'integer', minimum: 946684800, maximum: 4102444800 }, max_created: { type: 'integer', minimum: 946684800, maximum: 4102444800 }, was_paid: { type: 'boolean' }, was_shipped: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0, maximum: 100000 } } },
        DiscountData: { type: 'object', additionalProperties: false, properties: { discount_name: { type: 'string', maxLength: 100 }, discount_type: { type: 'string' }, discount_value: { type: 'number', minimum: 0 }, min_order_quantity_type: { type: 'string' }, min_order_quantity: { type: 'integer', minimum: 1 }, start_date: { type: 'integer', minimum: 946684800 }, end_date: { type: 'integer', minimum: 946684800 }, seller_active: { type: 'boolean' } } },
        ManageDiscountResourceInput: { type: 'object', additionalProperties: false, required: ['confirmation'], allOf: [{ oneOf: [actionVariant('create', ['data']), actionVariant('update', ['discount_id', 'data']), actionVariant('delete', ['discount_id'])] }], properties: { action: { type: 'string', enum: ['create', 'update', 'delete'] }, confirmation: { const: true }, shop_id: { type: 'integer', minimum: 1 }, discount_id: { type: 'integer', minimum: 1 }, data: { $ref: '#/components/schemas/DiscountData' }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        ShipmentInput: { type: 'object', additionalProperties: false, required: ['confirmation', 'tracking_code', 'carrier_name'], properties: { confirmation: { const: true, description: 'Must be true after explicit user confirmation.' }, tracking_code: { type: 'string', minLength: 1, maxLength: 100 }, carrier_name: { type: 'string', minLength: 1, maxLength: 100 }, note_to_buyer: { type: 'string', maxLength: 500 }, send_bcc: { type: 'boolean', default: true }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
        DiscountInput: { type: 'object', additionalProperties: false, required: ['confirmation'], properties: { confirmation: { const: true, description: 'Must be true after explicit user confirmation.' }, discount_name: { type: 'string', maxLength: 100 }, discount_type: { type: 'string' }, discount_value: { type: 'number', minimum: 0 }, min_order_quantity: { type: 'integer', minimum: 0 }, start_date: { type: 'integer', minimum: 0 }, end_date: { type: 'integer', minimum: 0 }, seller_active: { type: 'boolean' }, idempotency_key: { $ref: '#/components/schemas/IdempotencyKey' } } },
      },
    },
  };
}

export const GPT_COMPACT_OPERATION_IDS = Object.freeze([
  'getEtsyUserProfile',
  'getShopProfile',
  'listShopListings',
  'searchListings',
  'getListing',
  'createDraftListing',
  'updateDraftListing',
  'previewListingChange',
  'publishListing',
  'deactivateListing',
  'deleteListing',
  'uploadListingImages',
  'uploadListingVideo',
  'uploadDigitalListingFiles',
  'createCompleteDraft',
  'duplicateAndCustomizeListing',
  'bulkCreateDrafts',
  'bulkUpdateListings',
  'updateReceiptShipment',
  'readEtsyResource',
  'manageShopResource',
  'manageAdvancedListingResource',
  'deleteAdvancedListingResource',
  'manageListingMedia',
  'deleteListingMediaResource',
  'readFinancialResource',
  'manageDiscountResource',
]);

function referencedSchemaNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) referencedSchemaNames(item, names);
    return names;
  }
  if (!value || typeof value !== 'object') return names;
  const ref = typeof value.$ref === 'string' ? value.$ref : '';
  const prefix = '#/components/schemas/';
  if (ref.startsWith(prefix)) names.add(ref.slice(prefix.length));
  for (const item of Object.values(value)) referencedSchemaNames(item, names);
  return names;
}

function schemasReferencedBy(document, availableSchemas) {
  const names = referencedSchemaNames(document);
  const pending = [...names];
  while (pending.length) {
    const name = pending.pop();
    const schema = availableSchemas[name];
    if (!schema) continue;
    for (const dependency of referencedSchemaNames(schema)) {
      if (names.has(dependency)) continue;
      names.add(dependency);
      pending.push(dependency);
    }
  }
  return Object.fromEntries(Object.entries(availableSchemas).filter(([name]) => names.has(name)));
}

export function buildGptOpenApi(options = {}) {
  const full = buildFullGptOpenApi(options);
  const included = new Set(GPT_COMPACT_OPERATION_IDS);
  const paths = {};
  for (const [path, pathItem] of Object.entries(full.paths)) {
    const operations = Object.fromEntries(Object.entries(pathItem)
      .filter(([, value]) => value?.operationId && included.has(value.operationId)));
    if (Object.keys(operations).length) paths[path] = operations;
  }
  const compact = {
    ...full,
    info: {
      ...full.info,
      title: 'Etsy AI Command Center GPT Actions — Compact',
      version: '1.1.0',
      description: 'Compact GPT Builder schema. The server retains a larger explicit Etsy API, while secondary capabilities are grouped by strict action enums.',
    },
    paths,
    components: {
      ...full.components,
      schemas: {},
    },
  };
  const compactSchemaCatalog = structuredClone(full.components.schemas);
  // GPT Actions only documents special openaiFileIdRefs substitution at the
  // request-body top level. Keep nested bulk media support in the full backend
  // schema, but do not advertise an integration shape Builder may not populate.
  delete compactSchemaCatalog.BulkCreateItem?.properties?.images;
  delete compactSchemaCatalog.BulkCreateItem?.properties?.video;
  delete compactSchemaCatalog.BulkCreateItem?.properties?.digital_files;
  // Keep ChatGPT's special file placeholder directly on the compact action
  // request body. Builder sees array<string>; the runtime replaces its entries
  // with temporary file-reference objects before calling the backend.
  compact.paths['/api/gpt/listings/{listing_id}/images'].post.requestBody.content[JSON_CONTENT].schema =
    structuredClone(compactSchemaCatalog.ImageUploadInput);
  compact.paths['/api/gpt/workflows/complete-draft'].post.requestBody.content[JSON_CONTENT].schema =
    structuredClone(compactSchemaCatalog.CompleteDraftInput);
  compact.components.schemas = schemasReferencedBy(compact, compactSchemaCatalog);
  return compact;
}

export function gptOpenApiJson(options) {
  return JSON.stringify(buildGptOpenApi(options));
}

export default buildGptOpenApi;
