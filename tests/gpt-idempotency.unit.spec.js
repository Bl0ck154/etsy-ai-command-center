import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claimIdempotency, completeIdempotency, failIdempotency } from '../api/gpt/idempotency.js';

function request(key, title = 'Draft') {
  return {
    method: 'POST', path: '/api/gpt/listings', query: {},
    body: { idempotency_key: key, title },
    auth: { user: { id: 'owner' } },
  };
}

test('idempotency caches successful writes and rejects key reuse with a different payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-idempotency-'));
  const previous = { file: process.env.GPT_IDEMPOTENCY_STORE_FILE, secret: process.env.GPT_OAUTH_TOKEN_HASH_SECRET };
  process.env.GPT_IDEMPOTENCY_STORE_FILE = path.join(dir, 'state.json');
  process.env.GPT_OAUTH_TOKEN_HASH_SECRET = 'idempotency-secret-at-least-32-characters';
  try {
    const first = claimIdempotency(request('draft-key-123'), 'createDraftListing', false);
    completeIdempotency(first, { listing_id: 123 });
    const replay = claimIdempotency(request('draft-key-123'), 'createDraftListing', false);
    expect(replay).toMatchObject({ cached: true, data: { listing_id: 123 } });
    expect(() => claimIdempotency(request('draft-key-123', 'Different'), 'createDraftListing', false)).toThrow(/different request/i);
    expect(fs.readFileSync(process.env.GPT_IDEMPOTENCY_STORE_FILE, 'utf8')).not.toContain('draft-key-123');
  } finally {
    if (previous.file === undefined) delete process.env.GPT_IDEMPOTENCY_STORE_FILE; else process.env.GPT_IDEMPOTENCY_STORE_FILE = previous.file;
    if (previous.secret === undefined) delete process.env.GPT_OAUTH_TOKEN_HASH_SECRET; else process.env.GPT_OAUTH_TOKEN_HASH_SECRET = previous.secret;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed consequential idempotent requests are not silently retried', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-idempotency-risk-'));
  const previous = process.env.GPT_IDEMPOTENCY_STORE_FILE;
  process.env.GPT_IDEMPOTENCY_STORE_FILE = path.join(dir, 'state.json');
  try {
    const req = request('publish-key-123');
    const claim = claimIdempotency(req, 'publishListing', true);
    failIdempotency(claim, Object.assign(new Error('timeout'), { code: 'TIMEOUT' }), true);
    expect(() => claimIdempotency(req, 'publishListing', true)).toThrow(/inspect the resource/i);
  } finally {
    if (previous === undefined) delete process.env.GPT_IDEMPOTENCY_STORE_FILE; else process.env.GPT_IDEMPOTENCY_STORE_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
