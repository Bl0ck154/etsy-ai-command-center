import { test, expect } from '@playwright/test';

import { buildFullGptOpenApi, buildGptOpenApi, GPT_COMPACT_OPERATION_IDS } from '../api/gpt/openapi.js';
import { GPT_OPERATION_IDS } from '../api/gpt/router.js';

function operationById(schema, operationId) {
  return Object.values(schema.paths)
    .flatMap(pathItem => Object.values(pathItem))
    .find(operation => operation.operationId === operationId);
}

test('full GPT OpenAPI is explicit and synchronized with the router', () => {
  const schema = buildFullGptOpenApi();
  expect(schema.openapi).toBe('3.1.0');
  expect(schema.servers).toEqual([{ url: 'https://dashboard.example.test' }]);
  expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(120_000);

  const operations = [];
  for (const [path, pathItem] of Object.entries(schema.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      operations.push({ path, method, ...operation });
    }
  }
  const ids = operations.map(operation => operation.operationId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain('createCompleteDraft');
  expect(ids).toContain('getEtsyUserProfile');
  expect(ids).toContain('bulkUpdateListings');
  expect(ids.filter(id => !['getGptOpenApi', 'getGptPrivacyPolicy'].includes(id)).sort()).toEqual([...GPT_OPERATION_IDS].sort());
  expect(operations.every(operation => typeof operation['x-openai-isConsequential'] === 'boolean')).toBe(true);
  expect(operations.every(operation => String(operation.summary || '').length <= 300 && String(operation.description || '').length <= 300)).toBe(true);

  for (const id of ['publishListing', 'deactivateListing', 'deleteListing', 'updateReceiptShipment', 'createDiscount', 'updateDiscount', 'deleteDiscount', 'bulkUpdateListings']) {
    const operation = operations.find(candidate => candidate.operationId === id);
    expect(operation?.['x-openai-isConsequential'], id).toBe(true);
    let requestSchema = operation?.requestBody?.content?.['application/json']?.schema;
    if (requestSchema?.$ref) requestSchema = schema.components.schemas[requestSchema.$ref.split('/').at(-1)];
    const serialized = JSON.stringify(requestSchema);
    expect(serialized, id).toContain('"confirmation"');
    expect(serialized, id).toContain('"const":true');
  }
});

test('Builder GPT OpenAPI contains only the compact allowlisted operation set', () => {
  const schema = buildGptOpenApi();
  const ids = Object.values(schema.paths).flatMap(pathItem => Object.values(pathItem).map(operation => operation.operationId));
  expect(ids).toHaveLength(GPT_COMPACT_OPERATION_IDS.length);
  expect(ids.sort()).toEqual([...GPT_COMPACT_OPERATION_IDS].sort());
  expect(ids.length).toBeLessThanOrEqual(30);
  expect(schema.paths).not.toHaveProperty('/gpt/openapi.json');
  expect(schema.paths).not.toHaveProperty('/gpt/privacy');
  expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(64_000);

  const serialized = JSON.stringify(schema);
  for (const reference of serialized.matchAll(/#\/components\/schemas\/([^"/]+)/g)) {
    expect(schema.components.schemas, `missing schema referenced by ${reference[0]}`).toHaveProperty(reference[1]);
  }
  expect(Object.keys(schema.components.schemas).length).toBeLessThan(Object.keys(buildFullGptOpenApi().components.schemas).length);
  expect(schema.components.schemas.BulkCreateItem.properties).not.toHaveProperty('images');
  expect(schema.components.schemas.BulkCreateItem.properties).not.toHaveProperty('video');
  expect(schema.components.schemas.BulkCreateItem.properties).not.toHaveProperty('digital_files');
  expect(buildFullGptOpenApi().components.schemas.BulkCreateItem.properties).toHaveProperty('images');

  const metadataUpdate = operationById(schema, 'updateDraftListing');
  expect(metadataUpdate.description).toContain('never changes variation options');
  const advancedUpdate = operationById(schema, 'manageAdvancedListingResource');
  expect(advancedUpdate['x-openai-isConsequential']).toBe(false);
  expect(advancedUpdate.description).toContain('action=update_inventory');
  const advancedInput = schema.components.schemas.ManageAdvancedListingInput;
  expect(advancedInput.required).not.toContain('confirmation');
  expect(advancedInput.properties).not.toHaveProperty('confirmation');
  expect(JSON.stringify(advancedInput.allOf)).toContain('#/components/schemas/InventoryInput');
});

test('GPT OpenAPI uses OAuth scopes and the official file-reference field shape', () => {
  const schema = buildGptOpenApi();
  const oauth = schema.components.securitySchemes.OAuth2;
  expect(oauth.flows.authorizationCode.authorizationUrl).toBe('https://dashboard.example.test/oauth/authorize');
  expect(oauth.flows.authorizationCode.tokenUrl).toBe('https://dashboard.example.test/oauth/token');
  expect(oauth.flows.authorizationCode.scopes).toHaveProperty('listings:publish');
  const expectedDescription = 'Images generated or uploaded in the current ChatGPT conversation. Attach 1–10 image files.';
  for (const operationId of ['uploadListingImages', 'createCompleteDraft']) {
    const operation = operationById(schema, operationId);
    expect(Object.keys(operation.requestBody.content)).toEqual(['application/json']);
    const requestSchema = operation.requestBody.content['application/json'].schema;
    expect(requestSchema).toHaveProperty('properties.openaiFileIdRefs');
    expect(requestSchema.properties.openaiFileIdRefs).toEqual({
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'string' },
      description: expectedDescription,
    });
    expect(JSON.stringify(requestSchema)).not.toMatch(/"(?:oneOf|anyOf)"/);
    expect(requestSchema.properties.listing?.properties).toBeUndefined();
    expect(requestSchema.properties.payload?.properties).toBeUndefined();
    expect(requestSchema.properties.files?.properties).toBeUndefined();
    expect(requestSchema.properties.media?.properties).toBeUndefined();
  }
  expect(schema.components.schemas).not.toHaveProperty('ImageUploadInput');
  expect(schema.components.schemas).not.toHaveProperty('CompleteDraftInput');
  const full = buildFullGptOpenApi();
  expect(full.paths['/gpt/openapi.json'].get.security).toEqual([]);
  expect(full.paths['/gpt/privacy'].get.security).toEqual([]);
  expect(full.paths['/api/gpt/status'].get.security).toEqual([]);
});
