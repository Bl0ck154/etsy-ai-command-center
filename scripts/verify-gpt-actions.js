import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFullGptOpenApi,
  buildGptOpenApi,
  GPT_COMPACT_OPERATION_IDS,
} from '../api/gpt/openapi.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function operations(schema) {
  return Object.entries(schema.paths).flatMap(([routePath, pathItem]) =>
    Object.entries(pathItem).map(([method, operation]) => ({ routePath, method, operation })),
  );
}

function operationById(schema, id) {
  return operations(schema).find(item => item.operation.operationId === id)?.operation;
}

const compact = buildGptOpenApi();
const full = buildFullGptOpenApi();
const compactOperations = operations(compact);
const compactIds = compactOperations.map(item => item.operation.operationId);

assert.equal(compact.openapi, '3.1.0');
assert.ok(compactOperations.length <= 30, `compact GPT schema has ${compactOperations.length} operations`);
assert.deepEqual([...compactIds].sort(), [...GPT_COMPACT_OPERATION_IDS].sort());
assert.equal(new Set(compactIds).size, compactIds.length, 'compact operation IDs must be unique');
assert.ok(!compact.paths['/gpt/openapi.json'], 'Builder schema must not include itself');
assert.ok(!compact.paths['/gpt/privacy'], 'Builder schema must not include the privacy page');
assert.ok(compactOperations.every(item => item.operation.summary.length <= 300 && item.operation.description.length <= 300));
for (const { operation } of compactOperations.filter(item => item.operation['x-openai-isConsequential'] === true)) {
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  const resolved = bodySchema?.$ref ? compact.components.schemas[bodySchema.$ref.split('/').at(-1)] : bodySchema;
  assert.match(JSON.stringify(resolved), /"confirmation"/, `${operation.operationId} lacks confirmation in its request schema`);
  assert.match(JSON.stringify(resolved), /"const":true/, `${operation.operationId} does not require literal confirmation=true`);
}

const routerSource = fs.readFileSync(path.join(projectRoot, 'api', 'gpt', 'router.js'), 'utf8');
const routerContracts = [...routerSource.matchAll(/route\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*\/\^(.+?)\$\/[a-z]*\s*,\s*'([^']+)'/gs)]
  .map(match => ({
    method: match[1].toLowerCase(),
    routePath: `/api/gpt${match[2].replace(/\\\//g, '/').replace(/\(\\d\+\)/g, '{}')}`,
    id: match[3],
  }));
const fullContracts = operations(full)
  .filter(item => !['getGptOpenApi', 'getGptPrivacyPolicy'].includes(item.operation.operationId));
const fullIds = fullContracts
  .map(item => item.operation.operationId)
  .filter(id => !['getGptOpenApi', 'getGptPrivacyPolicy'].includes(id));
assert.deepEqual([...new Set(routerContracts.map(item => item.id))].sort(), [...new Set(fullIds)].sort(), 'full schema and router operation IDs differ');
for (const contract of fullContracts) {
  const routerContract = routerContracts.find(item => item.id === contract.operation.operationId);
  assert.ok(routerContract, `${contract.operation.operationId} has no router contract`);
  assert.equal(routerContract.method, contract.method, `${contract.operation.operationId} method differs`);
  assert.equal(routerContract.routePath, contract.routePath.replace(/\{[^}]+\}/g, '{}'), `${contract.operation.operationId} path differs`);
}

const resourceSource = fs.readFileSync(path.join(projectRoot, 'api', 'gpt', 'resource-operations.js'), 'utf8');
for (const schemaName of [
  'ReadEtsyResourceInput',
  'ManageShopResourceInput',
  'ManageAdvancedListingInput',
  'DeleteAdvancedListingInput',
  'ManageListingMediaInput',
  'DeleteListingMediaInput',
  'ReadFinancialResourceInput',
  'ManageDiscountResourceInput',
]) {
  const actions = full.components.schemas[schemaName].properties.action.enum;
  const variants = full.components.schemas[schemaName].allOf?.[0]?.oneOf || [];
  assert.deepEqual(variants.map(variant => variant.properties?.action?.const).sort(), [...actions].sort(), `${schemaName} action variants differ from enum`);
  for (const action of actions) {
    assert.match(resourceSource, new RegExp(`case ['"]${action}['"]:`), `${schemaName} action ${action} has no dispatch case`);
  }
}

const search = operationById(compact, 'searchListings');
assert.ok(search.parameters.some(parameter => parameter.in === 'query' && parameter.name === 'keyword'));
assert.equal(operationById(compact, 'previewListingChange').requestBody.content['application/json'].schema.$ref, '#/components/schemas/DraftListingPatch');
const expectedFileDescription = 'Images generated or uploaded in the current ChatGPT conversation. Attach 1–10 image files.';
for (const operationId of ['uploadListingImages', 'createCompleteDraft']) {
  const bodySchema = operationById(compact, operationId).requestBody.content['application/json'].schema;
  assert.ok(bodySchema.properties?.openaiFileIdRefs, `${operationId} must expose top-level openaiFileIdRefs`);
  assert.deepEqual(bodySchema.properties.openaiFileIdRefs.items, { type: 'string' });
  assert.equal(bodySchema.properties.openaiFileIdRefs.type, 'array');
  assert.equal(bodySchema.properties.openaiFileIdRefs.description, expectedFileDescription);
  assert.ok(!JSON.stringify(bodySchema).match(/"(?:oneOf|anyOf)"/), `${operationId} file contract must not use oneOf/anyOf`);
}
assert.ok(operationById(compact, 'uploadListingImages').requestBody.content['application/json'].schema.properties.file_metadata);
assert.equal(compact.components.schemas.VideoUploadInput.properties.openaiFileIdRefs.maxItems, 1);
assert.equal(compact.components.schemas.DigitalFileUploadInput.properties.openaiFileIdRefs.maxItems, 5);
assert.ok(!compact.components.schemas.FileUploadInput);
assert.ok(!compact.components.schemas.WorkflowDigitalFileInput);
assert.equal(operationById(compact, 'uploadListingVideo').requestBody.content['application/json'].schema.$ref, '#/components/schemas/VideoUploadInput');
assert.equal(operationById(compact, 'uploadDigitalListingFiles').requestBody.content['application/json'].schema.$ref, '#/components/schemas/DigitalFileUploadInput');
assert.ok(compact.components.schemas.DraftListingPatch.anyOf.every(item => item.required?.[0] !== 'idempotency_key'));
assert.ok(!compact.components.schemas.ListingPatchPayload.properties.idempotency_key);
assert.deepEqual(compact.components.schemas.ManageAdvancedListingInput.properties.language.enum, ['de', 'en', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt']);
assert.equal(compact.components.schemas.ReadFinancialResourceInput.properties.offset.maximum, 100000);
assert.equal(compact.components.schemas.ReadFinancialResourceInput.properties.max_created.maximum, 4102444800);
assert.deepEqual(operationById(compact, 'manageAdvancedListingResource').security, [{ OAuth2: ['listings:write'] }]);
assert.deepEqual(operationById(compact, 'deleteAdvancedListingResource').security, [{ OAuth2: ['listings:delete'] }]);
assert.deepEqual(operationById(compact, 'manageListingMedia').security, [{ OAuth2: ['files:write'] }]);
assert.deepEqual(operationById(compact, 'deleteListingMediaResource').security, [{ OAuth2: ['listings:delete'] }]);
const completeDraft = operationById(compact, 'createCompleteDraft').requestBody.content['application/json'].schema;
assert.ok(completeDraft.properties.atomic);
assert.ok(completeDraft.properties.verify);
assert.ok(completeDraft.properties.openaiFileIdRefs);
assert.equal(completeDraft.properties.file_metadata.items.$ref, '#/components/schemas/CompleteDraftFileMetadata');
assert.ok(!completeDraft.properties.images);
assert.ok(!completeDraft.properties.video);
assert.ok(!completeDraft.properties.digital_files);
assert.ok(compact.components.schemas.DuplicateListingInput.properties.inventory);
assert.ok(compact.components.schemas.BulkCreateInput.properties.items);
assert.ok(!compact.components.schemas.BulkCreateItem.properties.images);
assert.ok(!compact.components.schemas.BulkCreateItem.properties.video);
assert.ok(!compact.components.schemas.BulkCreateItem.properties.digital_files);
assert.ok(compact.components.schemas.BulkUpdateInput.properties.dry_run);

process.stdout.write(`GPT Actions contract OK: ${compactOperations.length} compact operations, ${fullIds.length} routed operations.\n`);
