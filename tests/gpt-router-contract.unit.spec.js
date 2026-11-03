import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashAuthPassword } from '../api/_auth.js';
import { resetEtsyTokenCacheForTests } from '../api/auth.js';
import { buildGptOpenApi } from '../api/gpt/openapi.js';
import gptRouter, { prepareCompleteDraftAttachments, prepareListingImageFiles, preparedFiles } from '../api/gpt/router.js';
import { createAuthorizationCode, exchangeAuthorizationCode, GPT_SCOPES } from '../api/gpt/oauth-store.js';

const ENV_KEYS = [
  'NODE_ENV',
  'AUTH_USERS_B64',
  'SESSION_SECRET',
  'ETSY_ACCESS_TOKEN',
  'ETSY_SHOP_ID',
  'GPT_OAUTH_CLIENT_ID',
  'GPT_OAUTH_CLIENT_SECRET',
  'GPT_OAUTH_REDIRECT_URIS',
  'GPT_OAUTH_STORE_FILE',
  'GPT_IDEMPOTENCY_STORE_FILE',
  'GPT_OAUTH_TOKEN_HASH_SECRET',
  'SECURITY_AUDIT_DIR',
];

function recorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    type(value) { this.headers['content-type'] = value; return this; },
    send(value) { this.body = typeof value === 'string' ? JSON.parse(value) : value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

function request(pathValue, { method = 'GET', token = '', query = {}, body = {} } = {}) {
  return {
    method,
    path: pathValue,
    url: pathValue,
    query,
    body,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ip: '127.0.0.1',
  };
}

function operationById(schema, operationId) {
  for (const [routePath, pathItem] of Object.entries(schema.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation.operationId === operationId) return { routePath, method, operation };
    }
  }
  throw new Error(`OpenAPI operation not found: ${operationId}`);
}

function createRouterEnvironment({ scopes = [...GPT_SCOPES] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-router-contract-'));
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const previousFetch = global.fetch;
  const user = {
    id: 'contract-owner',
    name: 'Contract Owner',
    role: 'owner',
    scopes: [],
    passwordHash: hashAuthPassword('contract-owner-password-at-least-20-characters'),
  };
  const redirectUri = 'https://chatgpt.com/aip/g-contract/oauth/callback';
  Object.assign(process.env, {
    NODE_ENV: 'test',
    AUTH_USERS_B64: Buffer.from(JSON.stringify([user])).toString('base64url'),
    SESSION_SECRET: 'contract-session-secret-at-least-32-characters',
    ETSY_ACCESS_TOKEN: 'contract-etsy-access-token',
    ETSY_SHOP_ID: '123',
    GPT_OAUTH_CLIENT_ID: 'contract-client',
    GPT_OAUTH_CLIENT_SECRET: 'contract-client-secret-at-least-32-characters',
    GPT_OAUTH_REDIRECT_URIS: redirectUri,
    GPT_OAUTH_STORE_FILE: path.join(directory, 'oauth.json'),
    GPT_IDEMPOTENCY_STORE_FILE: path.join(directory, 'idempotency.json'),
    GPT_OAUTH_TOKEN_HASH_SECRET: 'contract-hash-secret-at-least-32-characters',
    SECURITY_AUDIT_DIR: path.join(directory, 'audit'),
  });
  resetEtsyTokenCacheForTests({ accessToken: process.env.ETSY_ACCESS_TOKEN });
  const code = createAuthorizationCode({
    clientId: process.env.GPT_OAUTH_CLIENT_ID,
    redirectUri,
    user,
    scopes,
  });
  const token = exchangeAuthorizationCode({
    code,
    clientId: process.env.GPT_OAUTH_CLIENT_ID,
    redirectUri,
  }).access_token;

  return {
    token,
    auditDirectory: process.env.SECURITY_AUDIT_DIR,
    mockEtsy(handler) { global.fetch = handler; },
    restore() {
      global.fetch = previousFetch;
      resetEtsyTokenCacheForTests();
      for (const key of ENV_KEYS) delete process.env[key];
      for (const [key, value] of Object.entries(previous)) {
        if (value !== undefined) process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function jsonResponse(data, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: status === 204 ? {} : { 'Content-Type': 'application/json' },
  });
}

function readSecurityAuditRecords(directory) {
  return fs.readdirSync(directory)
    .map(name => path.join(directory, name))
    .flatMap(file => fs.readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .map(entry => entry.record || entry));
}

test('imported GPT Actions schema stays within the conservative 30-operation budget', () => {
  const schema = buildGptOpenApi();
  const operations = Object.entries(schema.paths).flatMap(([routePath, pathItem]) =>
    Object.entries(pathItem).map(([method, operation]) => ({ routePath, method, operation })),
  );

  expect(operations.length).toBeLessThanOrEqual(30);
  expect(operations.map(item => item.routePath)).not.toContain('/gpt/openapi.json');
  expect(operations.map(item => item.routePath)).not.toContain('/gpt/privacy');
});

test('searchListings uses its declared OpenAPI query name all the way through to Etsy', async () => {
  const schema = buildGptOpenApi();
  const { operation } = operationById(schema, 'searchListings');
  const queryNames = (operation.parameters || [])
    .filter(parameter => parameter.in === 'query')
    .map(parameter => parameter.name);
  const keywordParameter = queryNames.find(name => name === 'keyword' || name === 'keywords');
  expect(keywordParameter).toBeTruthy();

  const environment = createRouterEnvironment();
  const calls = [];
  environment.mockEtsy(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ count: 1, results: [{ listing_id: 77, title: 'Silver ring' }] });
  });
  try {
    const response = recorder();
    await gptRouter(request('/api/gpt/listings/search', {
      token: environment.token,
      query: { [keywordParameter]: 'silver ring', limit: '7' },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.operation_id).toBe('searchListings');
    expect(calls).toHaveLength(1);
    const upstream = new URL(calls[0].url);
    expect(upstream.pathname).toBe('/v3/application/shops/123/listings/active');
    expect(upstream.searchParams.get('keywords')).toBe('silver ring');
    expect(upstream.searchParams.get('limit')).toBe('7');
  } finally {
    environment.restore();
  }
});

test('previewListingChange accepts the body shape advertised by OpenAPI', async () => {
  const schema = buildGptOpenApi();
  const { operation } = operationById(schema, 'previewListingChange');
  const requestSchema = operation.requestBody.content['application/json'].schema;
  expect(requestSchema.$ref).toBe('#/components/schemas/DraftListingPatch');

  const environment = createRouterEnvironment();
  environment.mockEtsy(async url => {
    const value = String(url);
    if (value.includes('/listings/batch/inventory')) {
      return jsonResponse({ results: [{ listing_id: 88, inventory: { products: [] } }] });
    }
    return jsonResponse({ listing_id: 88, state: 'draft', title: 'Before', price: 12 });
  });
  try {
    const response = recorder();
    await gptRouter(request('/api/gpt/listings/88/preview', {
      method: 'POST',
      token: environment.token,
      body: { title: 'After', price: 24.99 },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.operation_id).toBe('previewListingChange');
    expect(response.body.data).toMatchObject({ dry_run: true, listing_id: 88, has_changes: true });
    expect(response.body.data.diff.map(item => item.field)).toEqual(expect.arrayContaining(['title', 'price']));
  } finally {
    environment.restore();
  }
});

test('shop stats use declared kind and days without calling a nonexistent Etsy stats endpoint', async () => {
  const schema = buildGptOpenApi();
  let statsOperation;
  try {
    statsOperation = operationById(schema, 'getShopStats').operation;
  } catch {
    // The compact Builder schema may expose stats through a grouped financial
    // read operation; the full server route must still retain this contract.
  }
  if (statsOperation) {
    const queryNames = (statsOperation.parameters || [])
      .filter(parameter => parameter.in === 'query')
      .map(parameter => parameter.name);
    expect(queryNames).toEqual(expect.arrayContaining(['kind', 'days']));
  }

  const environment = createRouterEnvironment();
  const calls = [];
  environment.mockEtsy(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({
      count: 2,
      results: [
        { receipt_id: 1, was_paid: true, was_shipped: true },
        { receipt_id: 2, was_paid: true, was_shipped: false },
      ],
    });
  });
  try {
    const response = recorder();
    await gptRouter(request('/api/gpt/stats', {
      token: environment.token,
      query: { kind: 'orders', days: '7' },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toMatchObject({
      kind: 'orders',
      days: 7,
      source: 'etsy_receipts',
      count: 2,
      paid: 2,
      shipped: 1,
    });
    expect(calls).toHaveLength(1);
    const upstream = new URL(calls[0].url);
    expect(upstream.pathname).toBe('/v3/application/shops/123/receipts');
    expect(upstream.searchParams.get('limit')).toBe('100');
    expect(upstream.searchParams.has('min_created')).toBe(true);
    expect(calls.every(call => !call.url.includes('/stats'))).toBe(true);
  } finally {
    environment.restore();
  }
});

test('createDraftListing accepts its advertised direct body and forces draft state', async () => {
  const schema = buildGptOpenApi();
  const { operation } = operationById(schema, 'createDraftListing');
  const requestSchema = operation.requestBody.content['application/json'].schema;
  expect(requestSchema.$ref).toBe('#/components/schemas/DraftListingInput');

  const environment = createRouterEnvironment();
  const calls = [];
  environment.mockEtsy(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ listing_id: 99, state: 'draft' });
  });
  try {
    const response = recorder();
    await gptRouter(request('/api/gpt/listings', {
      method: 'POST',
      token: environment.token,
      body: {
        title: 'Contract draft',
        description: 'Created only against the mocked Etsy endpoint.',
        price: 19.5,
        quantity: 1,
        taxonomy_id: 1,
        listing_type: 'download',
      },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.operation_id).toBe('createDraftListing');
    expect(calls).toHaveLength(1);
    expect(calls[0].url.endsWith('/shops/123/listings?legacy=false')).toBe(true);
    expect(JSON.parse(calls[0].options.body)).toMatchObject({
      title: 'Contract draft',
      price: 19.5,
      state: 'draft',
    });
  } finally {
    environment.restore();
  }
});

test('file and workflow request schemas expose router-supported metadata and controls', () => {
  const schema = buildGptOpenApi();
  const fileInput = operationById(schema, 'uploadListingImages').operation.requestBody.content['application/json'].schema;
  const metadata = schema.components.schemas.FileMetadata;
  const completeDraft = operationById(schema, 'createCompleteDraft').operation.requestBody.content['application/json'].schema;
  const duplicate = schema.components.schemas.DuplicateListingInput;
  const bulkCreate = schema.components.schemas.BulkCreateInput;
  const bulkUpdate = schema.components.schemas.BulkUpdateInput;

  expect(fileInput.additionalProperties).toBe(false);
  expect(fileInput.properties).toHaveProperty('file_metadata');
  expect(fileInput.properties.file_metadata.items.$ref).toBe('#/components/schemas/FileMetadata');
  expect(metadata.properties).toMatchObject({
    name: expect.any(Object),
    rank: expect.any(Object),
    alt_text: expect.any(Object),
    target: expect.any(Object),
  });
  expect(completeDraft.properties).toHaveProperty('atomic');
  expect(completeDraft.properties).toHaveProperty('verify');
  expect(completeDraft.properties).toHaveProperty('openaiFileIdRefs');
  expect(completeDraft.properties.file_metadata.items.$ref).toBe('#/components/schemas/CompleteDraftFileMetadata');
  expect(completeDraft.dependentRequired.openaiFileIdRefs).toContain('file_metadata');
  expect(completeDraft.properties).not.toHaveProperty('images');
  expect(completeDraft.properties).not.toHaveProperty('video');
  expect(completeDraft.properties).not.toHaveProperty('digital_files');
  expect(duplicate.properties).toHaveProperty('inventory');
  expect(duplicate.properties).toHaveProperty('personalization_questions');
  expect(duplicate.properties).toHaveProperty('atomic');
  expect(duplicate.properties).toHaveProperty('verify');
  expect(bulkCreate.properties).toHaveProperty('items');
  expect(bulkCreate.properties).toHaveProperty('atomic_per_item');
  expect(bulkCreate.properties).toHaveProperty('verify');
  expect(Boolean(bulkUpdate.properties.items || bulkUpdate.properties.updates)).toBe(true);
  expect(bulkUpdate.properties).toHaveProperty('dry_run');
});

test('uploadListingImages distinguishes missing, empty, and malformed ChatGPT refs before Etsy calls', async () => {
  const cases = [
    { body: {}, code: 'GPT_FILE_INPUT_MISSING' },
    { body: { openaiFileIdRefs: [] }, code: 'GPT_FILE_REFS_EMPTY' },
    { body: { openaiFileIdRefs: [{ id: 'runtime-without-link', name: 'image.webp', mime_type: 'image/webp' }] }, code: 'GPT_FILE_REFS_MALFORMED' },
  ];
  for (const scenario of cases) {
    const environment = createRouterEnvironment({ scopes: ['files:write'] });
    let etsyCalled = false;
    environment.mockEtsy(async () => {
      etsyCalled = true;
      return jsonResponse({ listing_id: 4549050824, state: 'draft' });
    });
    try {
      const response = recorder();
      await gptRouter(request('/api/gpt/listings/4549050824/images', {
        method: 'POST', token: environment.token, body: scenario.body,
      }), response);
      expect(response.statusCode, scenario.code).toBe(400);
      expect(response.body.error, scenario.code).toBe(scenario.code);
      expect(etsyCalled, scenario.code).toBe(false);
      const records = readSecurityAuditRecords(environment.auditDirectory);
      expect(records.find(record => record.event === 'gpt.operation.failed')?.details.error_code).toBe(scenario.code);
      expect(records.find(record => record.event === 'gpt.file_input.received')?.details.operation).toBe('uploadListingImages');
    } finally {
      environment.restore();
    }
  }
});

test('runtime object refs are accepted and non-image prepared files get a specific code', async () => {
  const environment = createRouterEnvironment({ scopes: ['files:write'] });
  const runtimeBody = { openaiFileIdRefs: [{
    name: 'generated.webp',
    id: 'runtime-file-id',
    mime_type: 'image/webp',
    download_link: 'https://files.oaiusercontent.com/signed-value',
  }] };
  try {
    const req = request('/api/gpt/listings/4549050824/images', { method: 'POST', body: runtimeBody });
    const files = await prepareListingImageFiles(req, '4549050824', {
      requireDraftImpl: async () => ({ listing_id: 4549050824, state: 'draft' }),
      prepareImpl: async (body, target) => {
        expect(body).toBe(runtimeBody);
        expect(target).toBe('listing_image');
        return [{ kind: 'image', mimeType: 'image/jpeg', buffer: Buffer.from('prepared') }];
      },
    });
    expect(files).toHaveLength(1);

    await expect(prepareListingImageFiles(req, '4549050824', {
      requireDraftImpl: async () => ({ listing_id: 4549050824, state: 'draft' }),
      prepareImpl: async () => [{ kind: 'file', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') }],
    })).rejects.toMatchObject({ code: 'GPT_FILE_NOT_IMAGE', status: 415 });

    const auditFiles = fs.readdirSync(environment.auditDirectory).map(name => path.join(environment.auditDirectory, name));
    const auditText = auditFiles.map(file => fs.readFileSync(file, 'utf8')).join('');
    const records = auditText.trim().split('\n').filter(Boolean).map(line => {
      const entry = JSON.parse(line);
      return entry.record || entry;
    });
    const received = records.find(record => record.event === 'gpt.file_input.received');
    expect(received.details.reference_entries).toEqual([{
      entry_type: 'object',
      has_name: true,
      has_id: true,
      has_mime_type: true,
      has_download_link: true,
    }]);
    expect(auditText).not.toContain('runtime-file-id');
    expect(auditText).not.toContain('generated.webp');
    expect(auditText).not.toContain('signed-value');
  } finally {
    environment.restore();
  }
});

test('complete draft routes top-level ChatGPT files by same-order metadata targets', async () => {
  const body = {
    openaiFileIdRefs: [
      { id: 'image', download_link: 'https://files.oaiusercontent.com/image' },
      { id: 'video', download_link: 'https://files.oaiusercontent.com/video' },
      { id: 'file', download_link: 'https://files.oaiusercontent.com/file' },
    ],
    file_metadata: [
      { target: 'listing_image', rank: 1 },
      { target: 'listing_video' },
      { target: 'digital_file', rank: 1 },
    ],
  };
  const calls = [];
  const prepared = await prepareCompleteDraftAttachments(body, async (input, target, options) => {
    calls.push({ input, target, options });
    return [
      { kind: 'image', target: 'listing_image' },
      { kind: 'video', target: 'listing_video' },
      { kind: 'file', target: 'digital_file' },
    ];
  });

  expect(calls).toEqual([{ input: body, target: '', options: { allowMetadataTargets: true } }]);
  expect(prepared.map(file => file.target)).toEqual(['listing_image', 'listing_video', 'digital_file']);
  await expect(prepareCompleteDraftAttachments({
    openaiFileIdRefs: body.openaiFileIdRefs,
    file_metadata: [{ target: 'listing_image' }],
  }, async () => [])).rejects.toThrow(/exactly one entry per top-level file/i);
  await expect(prepareCompleteDraftAttachments({
    ...body,
    images: { source_url: 'https://files.oaiusercontent.com/legacy' },
  }, async () => [])).rejects.toThrow(/not both/i);
});

test('complete-draft file preflight failure does not create an Etsy draft', async () => {
  const environment = createRouterEnvironment({ scopes: ['listings:write'] });
  const calls = [];
  environment.mockEtsy(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    return jsonResponse({ listing_id: 999, state: 'draft' });
  });
  try {
    const response = recorder();
    await gptRouter(request('/api/gpt/workflows/complete-draft', {
      method: 'POST',
      token: environment.token,
      body: {
        listing: { title: 'Must not be created', description: 'Preflight first', price: 10, quantity: 1, taxonomy_id: 1, listing_type: 'physical' },
        openaiFileIdRefs: [{ id: 'local-file', download_link: 'sandbox:/mnt/data/generated.webp' }],
        file_metadata: [{ target: 'listing_image', rank: 1, alt_text: 'Generated product image' }],
        atomic: true,
        verify: true,
      },
    }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('GPT_FILE_LOCAL_SANDBOX_UNREACHABLE');
    expect(calls).toEqual([]);
  } finally {
    environment.restore();
  }
});

test('rejected listing file audit records source, scheme and hostname without URL secrets', async () => {
  const environment = createRouterEnvironment({ scopes: ['files:write'] });
  environment.mockEtsy(async url => {
    if (String(url).includes('/listings/batch/inventory')) {
      return jsonResponse({ results: [{ listing_id: 4549050824, inventory: { products: [] } }] });
    }
    return jsonResponse({ listing_id: 4549050824, state: 'draft' });
  });
  try {
    const response = recorder();
    await gptRouter(request('/api/gpt/listings/4549050824/images', {
      method: 'POST',
      token: environment.token,
      body: { source_urls: ['sandbox:/mnt/data/generated.webp?signature=must-not-leak'] },
    }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('GPT_FILE_LOCAL_SANDBOX_UNREACHABLE');
    const records = readSecurityAuditRecords(environment.auditDirectory);
    const received = records.find(record => record.event === 'gpt.file_input.received');
    expect(received.details).toMatchObject({
      operation: 'uploadListingImages',
      listing_id: '4549050824',
      request_body_present: true,
      recognized_body_fields: ['source_urls'],
      has_openaiFileIdRefs: false,
      openaiFileIdRefs_is_array: false,
      reference_count: 0,
      reference_entries: [],
      has_source_url: false,
      has_source_urls: true,
      file_metadata_count: 0,
      prepared_file_count: null,
      prepared_kinds: [],
    });
    const failure = records.find(record => record.event === 'gpt.operation.failed');
    expect(failure.details).toMatchObject({
      operation: 'uploadListingImages',
      error_code: 'GPT_FILE_LOCAL_SANDBOX_UNREACHABLE',
      resource_id: '4549050824',
      listing_id: '4549050824',
      file_source_field: 'source_urls',
      file_scheme: 'sandbox',
      file_hostname: '',
      file_index: 0,
    });
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain('/mnt/data');
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('download_link');
  } finally {
    environment.restore();
  }
});

test('accepted supported-image MIME mismatch writes only safe warning metadata to audit', async () => {
  const environment = createRouterEnvironment({ scopes: ['files:write'] });
  const downloadLink = 'https://files.oaiusercontent.com/private/path?signature=must-not-leak';
  try {
    const req = request('/api/gpt/listings/4549050824/images', {
      method: 'POST',
      body: {
        openaiFileIdRefs: [{
          id: 'must-not-leak-id',
          name: 'must-not-leak-name.webp',
          mime_type: 'image/png',
          download_link: downloadLink,
        }],
      },
    });
    const files = await prepareListingImageFiles(req, '4549050824', {
      requireDraftImpl: async () => ({ listing_id: 4549050824, state: 'draft' }),
      prepareImpl: async () => [{
        kind: 'image',
        mimeType: 'image/jpeg',
        buffer: Buffer.from([0xff, 0xd8, 0xff]),
        mimeWarning: {
          warning_code: 'GPT_FILE_IMAGE_MIME_MISMATCH_ACCEPTED',
          source_field: 'openaiFileIdRefs',
          file_index: 0,
          declared_mime: 'image/png',
          response_mime: 'image/webp',
          detected_mime: 'image/jpeg',
        },
      }],
    });
    expect(files).toHaveLength(1);

    const records = readSecurityAuditRecords(environment.auditDirectory);
    const warning = records.find(record => record.event === 'gpt.file.mime_mismatch_accepted');
    expect(warning.details).toMatchObject({
      operation: 'uploadListingImages',
      resource_id: '4549050824',
      listing_id: '4549050824',
      outcome: 'warning',
      status: 200,
      warning_code: 'GPT_FILE_IMAGE_MIME_MISMATCH_ACCEPTED',
      file_source_field: 'openaiFileIdRefs',
      file_index: 0,
      declared_mime: 'image/png',
      response_mime: 'image/webp',
      detected_mime: 'image/jpeg',
    });
    const serialized = JSON.stringify(warning);
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('download_link');
    expect(serialized).not.toContain('/private/path');
  } finally {
    environment.restore();
  }
});

test('file metadata targets cannot override dedicated route policy and ranks are scoped by target', async () => {
  const mixedBody = {
    source_urls: ['https://files.oaiusercontent.com/image', 'https://files.oaiusercontent.com/file'],
    file_metadata: [
      { target: 'listing_image', rank: 1 },
      { target: 'digital_file', rank: 1 },
    ],
  };
  const files = await preparedFiles(mixedBody, '', {
    allowMetadataTargets: true,
    prepareImpl: async () => [
      { kind: 'image', name: 'image.jpg' },
      { kind: 'file', name: 'download.pdf' },
    ],
  });
  expect(files.map(file => [file.target, file.rank])).toEqual([
    ['listing_image', 1],
    ['digital_file', 1],
  ]);

  await expect(preparedFiles({
    source_url: 'https://files.oaiusercontent.com/file',
    file_metadata: [{ target: 'listing_video' }],
  }, 'digital_file', {
    prepareImpl: async () => { throw new Error('must reject before download'); },
  })).rejects.toThrow(/target must be digital_file/i);
});

test('draft inventory updates use the grouped inventory action without confirmation and audit the listing', async () => {
  const environment = createRouterEnvironment({ scopes: ['listings:write'] });
  const calls = [];
  const inventory = {
    products: [{
      property_values: [{ property_id: 513, property_name: 'Size', value_ids: [1], values: ['Large'] }],
      offerings: [{ price: 25, quantity: 4, is_enabled: true }],
    }],
    price_on_property: [513],
    quantity_on_property: [],
    sku_on_property: [],
  };
  environment.mockEtsy(async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.includes('/listings/batch/inventory')) {
      return jsonResponse({ results: [{ listing_id: 456, inventory: { products: [] } }] });
    }
    if (new URL(value).pathname.endsWith('/listings/456/inventory')) {
      return jsonResponse(inventory);
    }
    if ((options.method || 'GET') === 'GET') {
      return jsonResponse({ listing_id: 456, state: 'draft' });
    }
    return jsonResponse(inventory);
  });
  try {
    const response = recorder();
    await gptRouter(request('/api/gpt/resources/listing/manage', {
      method: 'POST',
      token: environment.token,
      body: { action: 'update_inventory', listing_id: 456, data: inventory },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.operation_id).toBe('manageAdvancedListingResource');
    expect(response.body.data).toMatchObject({ listing_id: 456, updated: true, verified: true });
    const write = calls.find(call => call.options.method === 'PUT');
    expect(write).toBeTruthy();
    expect(new URL(write.url).pathname).toBe('/v3/application/listings/456/inventory');
    expect(JSON.parse(write.options.body)).toMatchObject({
      price_on_property: [513],
      products: [{ offerings: [{ price: 25, quantity: 4, is_enabled: true }] }],
    });

    const audit = readSecurityAuditRecords(environment.auditDirectory)
      .find(record => record.event === 'gpt.operation.succeeded');
    expect(audit.details).toMatchObject({
      operation: 'manageAdvancedListingResource',
      resource_id: '456',
      listing_id: '456',
      resource_action: 'update_inventory',
      outcome: 'succeeded',
      status: 200,
    });
  } finally {
    environment.restore();
  }
});

test('draft inventory update does not report success when Etsy read-back differs', async () => {
  const environment = createRouterEnvironment({ scopes: ['listings:write'] });
  environment.mockEtsy(async (url, options = {}) => {
    const value = String(url);
    if (value.includes('/listings/batch/inventory')) {
      return jsonResponse({ results: [{ listing_id: 456, inventory: { products: [] } }] });
    }
    if (new URL(value).pathname.endsWith('/listings/456/inventory')) {
      if (options.method === 'PUT') return jsonResponse({ ok: true });
      return jsonResponse({
        products: [{
          property_values: [{ property_id: 513, property_name: 'Size', values: ['Small'] }],
          offerings: [{ price: 10, quantity: 1, is_enabled: true }],
        }],
        price_on_property: [513],
      });
    }
    return jsonResponse({ listing_id: 456, state: 'draft' });
  });
  try {
    const response = recorder();
    await gptRouter(request('/api/gpt/resources/listing/manage', {
      method: 'POST',
      token: environment.token,
      body: {
        action: 'update_inventory',
        listing_id: 456,
        data: {
          products: [{
            property_values: [{ property_id: 513, property_name: 'Size', values: ['Large'] }],
            offerings: [{ price: 25, quantity: 4, is_enabled: true }],
          }],
          price_on_property: [513],
        },
      },
    }), response);

    expect(response.statusCode).toBe(502);
    expect(response.body.error).toBe('INVENTORY_VERIFICATION_FAILED');
    const failed = readSecurityAuditRecords(environment.auditDirectory)
      .find(record => record.event === 'gpt.operation.failed');
    expect(failed.details).toMatchObject({
      operation: 'manageAdvancedListingResource',
      resource_id: '456',
      listing_id: '456',
      resource_action: 'update_inventory',
      error_code: 'INVENTORY_VERIFICATION_FAILED',
    });
  } finally {
    environment.restore();
  }
});

test('metadata patch rejects inventory fields instead of reporting partial success', async () => {
  const environment = createRouterEnvironment({ scopes: ['listings:write'] });
  const calls = [];
  environment.mockEtsy(async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.includes('/listings/batch/inventory')) {
      return jsonResponse({ results: [{ listing_id: 456, inventory: { products: [] } }] });
    }
    return jsonResponse({ listing_id: 456, state: 'draft' });
  });
  try {
    const response = recorder();
    await gptRouter(request('/api/gpt/listings/456', {
      method: 'PATCH',
      token: environment.token,
      body: {
        description: 'This metadata must not be partially applied.',
        products: [{ offerings: [{ price: 99, quantity: 1, is_enabled: true }] }],
      },
    }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('INVENTORY_REQUIRES_DEDICATED_OPERATION');
    expect(calls.some(call => call.options.method === 'PATCH')).toBe(false);
    const failed = readSecurityAuditRecords(environment.auditDirectory)
      .find(record => record.event === 'gpt.operation.failed');
    expect(failed.details).toMatchObject({
      operation: 'updateDraftListing',
      resource_id: '456',
      listing_id: '456',
      error_code: 'INVENTORY_REQUIRES_DEDICATED_OPERATION',
    });
  } finally {
    environment.restore();
  }
});

test('grouped listing deletes cannot bypass the listings:delete scope', async () => {
  const environment = createRouterEnvironment({ scopes: ['listings:write'] });
  let called = false;
  environment.mockEtsy(async () => {
    called = true;
    return jsonResponse({ listing_id: 456, state: 'draft' });
  });
  try {
    const response = recorder();
    await gptRouter(request('/api/gpt/resources/listing/delete', {
      method: 'POST',
      token: environment.token,
      body: { action: 'delete_personalization', listing_id: 456, confirmation: true },
    }), response);
    expect(response.statusCode).toBe(403);
    expect(called).toBe(false);
  } finally {
    environment.restore();
  }
});
