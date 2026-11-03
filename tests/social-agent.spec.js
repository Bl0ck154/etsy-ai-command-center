import { test, expect, request as requestFactory } from '@playwright/test';
import { createServer } from 'node:http';
import { requireSocialHermesAuth } from '../api/_auth.js';
import socialHandler from '../api/social.js';

const TOKEN = 'phase2a-test-token';
const CRON_SECRET = 'phase2a-cron-secret';
const OWNER_TELEGRAM_ID = process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID || '1234567890';
const authHeaders = { Authorization: `Bearer ${TOKEN}` };
const cronHeaders = { Authorization: `Bearer ${CRON_SECRET}` };
const KV_PORT = Number(process.env.PHASE2A_KV_MOCK_PORT || 32145);
const EXTERNAL_PORT = Number(process.env.PHASE2A_EXTERNAL_MOCK_PORT || 32146);

let kvServer;
let externalServer;
let externalRequests = [];
const kvStore = new Map();
const lists = new Map();

function mockResponse() {
  const captured = { statusCode: 200, payload: null, headers: {}, body: null, ended: false };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    setHeader(name, value) { captured.headers[String(name).toLowerCase()] = value; return this; },
    json(payload) { captured.payload = payload; return payload; },
    end(body) { captured.body = body ?? null; captured.ended = true; return undefined; },
  };
  return { res, captured };
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function startMockKvServer() {
  kvServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${KV_PORT}`);
    let parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'POST' && parts.length === 0) {
        const body = await readBody(req);
        parts = Array.isArray(body) ? body.map(value => String(value)) : [];
      }
      const command = decodeURIComponent(parts[0] || '').toUpperCase();
      const args = parts.slice(1);
      const key = args[0] ? decodeURIComponent(args[0]) : '';
      if (command === 'PING') return json(res, 200, { result: 'PONG' });
      if (command === 'GET') return json(res, 200, { result: kvStore.get(key) ?? null });
      if (command === 'SET') { kvStore.set(key, args[1] || ''); return json(res, 200, { result: 'OK' }); }
      if (command === 'DEL') { kvStore.delete(key); lists.delete(key); return json(res, 200, { result: 1 }); }
      if (command === 'LPUSH') {
        const list = lists.get(key) || [];
        for (const value of args.slice(1)) list.unshift(value);
        lists.set(key, list);
        return json(res, 200, { result: list.length });
      }
      if (command === 'LRANGE') {
        const list = lists.get(key) || [];
        const start = parseInt(args[1] || '0', 10);
        const stop = parseInt(args[2] || '-1', 10);
        const end = stop < 0 ? list.length : stop + 1;
        return json(res, 200, { result: list.slice(start, end) });
      }
      if (command === 'LTRIM') {
        const list = lists.get(key) || [];
        const start = parseInt(args[1] || '0', 10);
        const stop = parseInt(args[2] || '-1', 10);
        const end = stop < 0 ? list.length : stop + 1;
        lists.set(key, list.slice(start, end));
        return json(res, 200, { result: 'OK' });
      }
      return json(res, 400, { error: `unsupported mock command ${command}` });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });
  return new Promise(resolve => kvServer.listen(KV_PORT, '127.0.0.1', resolve));
}

function startExternalMockServer() {
  externalServer = createServer(async (req, res) => {
    const body = await readBody(req);
    externalRequests.push({ method: req.method, url: req.url, body });
    if (req.url.includes('/v1/chat/completions')) {
      if (body.model === 'timeout-model') {
        // Keep the socket open until the caller aborts, simulating a hung primary provider/model.
        req.on('close', () => {});
        return;
      }
      return json(res, 200, {
        choices: [{
          message: {
            content: '![image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=)',
          },
        }],
      });
    }
    json(res, 200, { ok: true });
  });
  return new Promise(resolve => externalServer.listen(EXTERNAL_PORT, '127.0.0.1', resolve));
}

test.beforeAll(async () => {
  process.env.SOCIAL_HERMES_API_TOKEN = TOKEN;
  process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID = OWNER_TELEGRAM_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.KV_REST_API_URL = `http://127.0.0.1:${KV_PORT}`;
  process.env.KV_REST_API_TOKEN = 'test-kv-token';
  process.env.ETSY_SHOP_ID = '123456789';
  process.env.EXTERNAL_AI_BASE_URL = `http://127.0.0.1:${EXTERNAL_PORT}/v1`;
  process.env.EXTERNAL_AI_API_KEY = 'test-external-key';
  process.env.EXTERNAL_AI_IMAGE_PATH = '/v1/chat/completions';
  process.env.EXTERNAL_IMAGE_MODEL = 'test-image-model';
  await Promise.all([startMockKvServer(), startExternalMockServer()]);
});

test.afterAll(async () => {
  await Promise.all([
    kvServer ? new Promise(resolve => kvServer.close(resolve)) : Promise.resolve(),
    externalServer ? new Promise(resolve => externalServer.close(resolve)) : Promise.resolve(),
  ]);
});

async function resetBridgeState(request) {
  const contextRes = await request.get('/api/social?action=context', { headers: authHeaders });
  expect(contextRes.status()).toBe(200);
  const context = await contextRes.json();
  for (const post of context.data.scheduled_posts || []) {
    if (String(post.id || '').startsWith('phase2a-')) {
      await request.post('/api/social', {
        headers: authHeaders,
        data: {
          action: 'deleteScheduled',
          id: post.id,
          approved: true,
          approved_by: OWNER_TELEGRAM_ID,
        },
      });
    }
  }
}

test.describe('Social Hermes Phase 2A bridge', () => {
  test.beforeEach(async ({ request }) => {
    externalRequests = [];
    await resetBridgeState(request);
  });

  test('missing Social Hermes service token returns safe auth error', async () => {
    const oldToken = process.env.SOCIAL_HERMES_API_TOKEN;
    delete process.env.SOCIAL_HERMES_API_TOKEN;
    const req = { headers: { authorization: `Bearer ${TOKEN}` } };
    let statusCode = null;
    let payload = null;
    const res = { status: code => ({ json: body => { statusCode = code; payload = body; } }) };
    const ok = requireSocialHermesAuth(req, res);
    process.env.SOCIAL_HERMES_API_TOKEN = oldToken;
    expect(ok).toBe(false);
    expect(statusCode).toBe(503);
    expect(payload).toMatchObject({ code: 'SOCIAL_HERMES_AUTH_NOT_CONFIGURED' });
  });

  test('missing owner Telegram env returns safe config error', async () => {
    const oldToken = process.env.SOCIAL_HERMES_API_TOKEN;
    const oldOwner = process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID;
    process.env.SOCIAL_HERMES_API_TOKEN = TOKEN;
    delete process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID;

    const { res, captured } = mockResponse();
    await socialHandler({
      method: 'POST',
      headers: authHeaders,
      query: {},
      body: {
        action: 'saveDraft',
        id: 'phase2a-missing-owner',
        caption: 'Should not save without owner config',
        approved: true,
        approved_by: OWNER_TELEGRAM_ID,
      },
    }, res);

    if (oldToken === undefined) delete process.env.SOCIAL_HERMES_API_TOKEN;
    else process.env.SOCIAL_HERMES_API_TOKEN = oldToken;
    if (oldOwner === undefined) delete process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID;
    else process.env.SOCIAL_HERMES_OWNER_TELEGRAM_ID = oldOwner;

    expect(captured.statusCode).toBe(503);
    expect(captured.payload).toMatchObject({ code: 'SOCIAL_HERMES_OWNER_NOT_CONFIGURED' });
  });

  test('service auth failure and browser cookie isolation', async ({ request }) => {
    const noAuth = await request.get('/api/social?action=context');
    expect(noAuth.status()).toBe(401);
    expect(await noAuth.json()).toMatchObject({ code: 'SOCIAL_HERMES_AUTH_REQUIRED' });

    const wrong = await request.get('/api/social?action=context', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(wrong.status()).toBe(401);

    const isolated = await requestFactory.newContext({
      baseURL: process.env.BASE_URL || 'http://127.0.0.1:3000',
      extraHTTPHeaders: authHeaders,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const kvAttempt = await isolated.post('/api/kv', {
        data: { action: 'getScheduledPosts' },
      });
      // SOCIAL_HERMES_API_TOKEN is intentionally scoped to /api/social only.
      expect(kvAttempt.status()).toBe(401);
    } finally {
      await isolated.dispose();
    }
  });

  test('service auth success returns safe context without secret fields', async ({ request }) => {
    const res = await request.get('/api/social?action=context', { headers: authHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.owner.telegram_user_id).toBe(OWNER_TELEGRAM_ID);
    expect(body.data.bridge.assistant_name).toBe('Social Ops Hermes');
    expect(body.data.bridge.profile).toBe('social');
    expect(body.data.bridge.publish_now_available).toBe(false);
    expect(body.data.bridge.direct_etsy_messages_available).toBe(false);
    expect(body.data.bridge.direct_meta_write_available).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/access_token|refresh_token|SOCIAL_HERMES_API_TOKEN|KV_REST_API_TOKEN/i);
  });

  test('mediaOptions returns candidates without a first-image recommendation', async ({ request }) => {
    const res = await request.post('/api/social', {
      headers: authHeaders,
      data: { action: 'mediaOptions', listing_id: '' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.recommended_media).toBeUndefined();
    expect(body.data.catalog_listings).toEqual([]);
    expect(body.data.listing_media_items).toEqual([]);
    expect(body.data.selection_policy).toContain('AI creativePlan');
  });

  test('Phase 3E generateMedia uses tier routing and returns public fetchable mediaAsset URL', async ({ request }) => {
    const cheap = await request.post('/api/social', {
      headers: authHeaders,
      data: {
        action: 'generateMedia',
        prompt: 'clean Etsy product photo cleanup social image, no people',
        image_model_tier: 'cheap',
        dry_run: false,
      },
    });
    expect(cheap.status()).toBe(200);
    const cheapBody = await cheap.json();
    expect(cheapBody.success).toBe(true);
    expect(cheapBody.data.image_model_tier).toBe('cheap');
    expect(cheapBody.data.public_url_available).toBe(true);
    expect(cheapBody.data.images[0].url).toContain('/api/social?action=mediaAsset&id=');
    expect(cheapBody.data.images[0].source).toBe('generated_image');
    expect(cheapBody.data.images[0].source).not.toBe('generated_fallback');

    const assetUrl = new URL(cheapBody.data.images[0].url);
    const asset = await request.get(`${assetUrl.pathname}${assetUrl.search}`);
    expect(asset.status()).toBe(200);
    expect(asset.headers()['content-type']).toMatch(/^image\//);
    expect((await asset.body()).length).toBeGreaterThan(0);

    const publicContext = await requestFactory.newContext({ baseURL: process.env.BASE_URL || 'http://127.0.0.1:3000' });
    try {
      const noAuthAsset = await publicContext.get(`${assetUrl.pathname}${assetUrl.search}`, { headers: {} });
      expect(noAuthAsset.status()).toBe(200);
      expect(noAuthAsset.headers()['content-type']).toMatch(/^image\//);
      expect((await noAuthAsset.body()).length).toBeGreaterThan(0);
    } finally {
      await publicContext.dispose();
    }

    const standard = await request.post('/api/social', {
      headers: authHeaders,
      data: {
        action: 'generateMedia',
        prompt: 'premium Etsy product photo cleanup social image, no people',
        image_model_tier: 'standard',
        dry_run: false,
      },
    });
    expect(standard.status()).toBe(200);
    const standardBody = await standard.json();
    expect(standardBody.success).toBe(true);
    expect(standardBody.data.image_model_tier).toBe('standard');
    expect(standardBody.data.public_url_available).toBe(true);
    expect(standardBody.data.images[0].url).toContain('/api/social?action=mediaAsset&id=');
  });

  test('Phase 3E generateMedia falls back after primary timeout without technical PNG', async ({ request }) => {
    const oldModels = process.env.SOCIAL_HERMES_IMAGE_MODELS_CHEAP;
    const oldTimeout = process.env.SOCIAL_HERMES_IMAGE_TIMEOUT_MS;
    process.env.SOCIAL_HERMES_IMAGE_MODELS_CHEAP = 'timeout-model,test-fallback-model';
    process.env.SOCIAL_HERMES_IMAGE_TIMEOUT_MS = '5000';
    try {
      const res = await request.post('/api/social', {
        headers: authHeaders,
        data: {
          action: 'generateMedia',
          prompt: 'fallback routing test product photo cleanup image',
          image_model_tier: 'cheap',
          timeout_ms: 5000,
          dry_run: false,
        },
        timeout: 45_000,
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.selected_model).toBe('test-fallback-model');
      expect(body.data.fallback_used).toBe(true);
      expect(body.data.provider_attempts[0]).toMatchObject({ model: 'timeout-model', success: false });
      expect(body.data.images[0].source).toBe('generated_image');
      expect(body.data.images[0].source).not.toBe('generated_fallback');
    } finally {
      if (oldModels === undefined) delete process.env.SOCIAL_HERMES_IMAGE_MODELS_CHEAP;
      else process.env.SOCIAL_HERMES_IMAGE_MODELS_CHEAP = oldModels;
      if (oldTimeout === undefined) delete process.env.SOCIAL_HERMES_IMAGE_TIMEOUT_MS;
      else process.env.SOCIAL_HERMES_IMAGE_TIMEOUT_MS = oldTimeout;
    }
  });

  test('saveDraft requires explicit Telegram owner approval and never publishes', async ({ request }) => {
    const id = 'phase2a-draft-1';
    const noApproval = await request.post('/api/social', {
      headers: authHeaders,
      data: { action: 'saveDraft', id, caption: 'Draft caption' },
    });
    expect(noApproval.status()).toBe(400);
    expect(await noApproval.json()).toMatchObject({ code: 'APPROVAL_REQUIRED' });

    const wrongApprover = await request.post('/api/social', {
      headers: authHeaders,
      data: { action: 'saveDraft', id, caption: 'Draft caption', approved: true, approved_by: '123' },
    });
    expect(wrongApprover.status()).toBe(403);

    const res = await request.post('/api/social', {
      headers: authHeaders,
      data: {
        action: 'saveDraft',
        id,
        caption: 'Owner-approved draft caption',
        platform: 'instagram',
        listing_id: '111222333',
        listing_title: 'Test listing',
        media_items: [{ url: 'https://example.test/image.jpg', type: 'image' }],
        approved: true,
        approved_by: OWNER_TELEGRAM_ID,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.published).toBe(false);
    expect(body.data).toMatchObject({ id, status: 'draft', platform: 'instagram', publish_method: null, post_url: null });
  });

  test('saveDraft expands platform=all using platform-specific captions', async ({ request }) => {
    kvStore.set(`${process.env.ETSY_SHOP_ID}:social_configs`, encodeURIComponent(JSON.stringify({
      instagram_config: { access_token: 'test-instagram-token' },
      facebook_config: { page_id: 'test-facebook-page' },
      make_config: { webhook_url: 'https://make.example.test/hook' },
    })));

    const id = 'phase2a-platform-drafts';
    const listingUrl = 'https://www.etsy.com/listing/1136019810/panama-city-beach-2026-png-family';
    const res = await request.post('/api/social', {
      headers: authHeaders,
      data: {
        action: 'saveDraft',
        id,
        caption: 'Matching trip shirts are easier when the artwork is ready before the blanks are picked.',
        platform: 'all',
        listing_id: '1136019810',
        listing_title: 'Panama City Beach 2026 vacation design',
        media_items: [{ url: 'https://example.test/panama.jpg', type: 'image', source: 'listing_image' }],
        platform_caption_variants: [
          { platform: 'instagram', caption: 'Matching trip shirts are easier when the artwork is ready before the blanks are picked. Swipe to see the actual design first, then product mockup ideas for beach-trip projects. #vacationshirts #beachtrip #sublimationdesign #pngdesign #familyvacation #etsyshop' },
          { platform: 'facebook', caption: `This digital design can help makers plan matching vacation shirts, mugs, tote bags, and sublimation projects. The draft starts with the actual listing image, then uses mockups to show finished-product ideas. Etsy listing: ${listingUrl}` },
          { platform: 'pinterest', caption: `Vacation shirt design idea for matching beach-trip projects, mugs, totes, stickers, and sublimation planning. Save this for summer craft inspiration. ${listingUrl}` },
        ],
        approved: true,
        approved_by: OWNER_TELEGRAM_ID,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.published).toBe(false);
    expect(body.data).toMatchObject({ count: 3 });
    const records = body.data.records;
    expect(records.map(record => record.platform).sort()).toEqual(['facebook', 'instagram', 'pinterest']);
    expect(records.find(record => record.platform === 'instagram')).toMatchObject({
      id: `${id}-instagram`,
      caption: 'Matching trip shirts are easier when the artwork is ready before the blanks are picked. Swipe to see the actual design first, then product mockup ideas for beach-trip projects. #vacationshirts #beachtrip #sublimationdesign #pngdesign #familyvacation #etsyshop',
      status: 'draft',
      approved_for_publish: false,
    });
    expect(records.find(record => record.platform === 'facebook')?.caption).toContain('Etsy listing: https://www.etsy.com/listing/1136019810');
    expect(records.find(record => record.platform === 'pinterest')?.caption).toContain('Save this for summer craft inspiration.');
    expect(records.every(record => Array.isArray(record.platform_caption_variants) && record.platform_caption_variants.length === 3)).toBe(true);
  });

  test('schedule stores approved scheduled post using compatible schema', async ({ request }) => {
    const id = 'phase2a-scheduled-1';
    const scheduledAt = new Date(Date.now() + 86400_000).toISOString();
    const res = await request.post('/api/social', {
      headers: authHeaders,
      data: {
        action: 'schedule',
        id,
        caption: 'Owner-approved scheduled caption',
        platform: 'pinterest',
        listing_id: '444555666',
        listing_title: 'Scheduled listing',
        listing_image_url: 'https://example.test/listing.jpg',
        scheduled_at: scheduledAt,
        approved: true,
        approved_by: OWNER_TELEGRAM_ID,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id,
      caption: 'Owner-approved scheduled caption',
      platform: 'pinterest',
      listing_id: '444555666',
      listing_title: 'Scheduled listing',
      listing_image_url: 'https://example.test/listing.jpg',
      scheduled_at: scheduledAt,
      status: 'scheduled',
      publish_method: null,
      post_url: null,
      publish_result: null,
      last_error: null,
    });
  });

  test('deleteScheduled requires approval-style payload', async ({ request }) => {
    const id = 'phase2a-delete-1';
    await request.post('/api/social', {
      headers: authHeaders,
      data: {
        action: 'saveDraft',
        id,
        caption: 'Delete me',
        approved: true,
        approved_by: OWNER_TELEGRAM_ID,
      },
    });

    const denied = await request.post('/api/social', {
      headers: authHeaders,
      data: { action: 'deleteScheduled', id, approved: true, approved_by: '999' },
    });
    expect(denied.status()).toBe(403);

    const res = await request.post('/api/social', {
      headers: authHeaders,
      data: { action: 'deleteScheduled', id, approved: true, approved_by: OWNER_TELEGRAM_ID },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(id);
    expect(body.published).toBe(false);
  });

  test('no publishNow or direct publish actions are exposed before approval', async ({ request }) => {
    for (const action of ['publishNow', 'postInstagram', 'postFacebook', 'postPinterest', 'smartPost']) {
      const res = await request.post('/api/social', {
        headers: authHeaders,
        data: { action, approved: true, approved_by: OWNER_TELEGRAM_ID },
      });
      expect(res.status()).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'UNSUPPORTED_ACTION' });
    }
  });

  test('AUTOPUBLISH_ENABLED=false skips unapproved overdue posts and blocks external social calls', async ({ request }) => {
    const id = 'phase2a-due-1';
    const dueAt = new Date(Date.now() - 3600_000).toISOString();
    await request.post('/api/social', {
      headers: authHeaders,
      data: {
        action: 'schedule',
        id,
        caption: 'Due but should not publish',
        platform: 'facebook',
        scheduled_at: dueAt,
        approved: true,
        approved_by: OWNER_TELEGRAM_ID,
      },
    });

    const res = await request.post('/api/social', {
      headers: cronHeaders,
      data: { action: 'publishDueScheduled', limit: 10 },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.autopublish_enabled).toBe(false);
    expect(body.publish_blocked).toBe(true);
    expect(body.results.some(p => p.id === id)).toBe(false);
    expect(body.skipped_unapproved_count).toBeGreaterThanOrEqual(1);
    expect(externalRequests).toHaveLength(0);

    const contextRes = await request.get('/api/social?action=context', { headers: authHeaders });
    const context = await contextRes.json();
    const stored = context.data.scheduled_posts.find(p => p.id === id);
    expect(stored.status).toBe('scheduled');
    expect(stored.publish_method).toBeNull();
    expect(stored.post_url).toBeNull();
    expect(stored.publish_result).toBeNull();
  });

  test('admin approval creates the only publishable scheduled state and editing clears approval', async ({ request }) => {
    const id = 'phase2a-approved-1';
    const scheduledAt = new Date(Date.now() + 3600_000).toISOString();
    await request.post('/api/social', {
      headers: authHeaders,
      data: {
        action: 'schedule',
        id,
        caption: 'Future canary candidate',
        platform: 'facebook',
        scheduled_at: scheduledAt,
        approved: true,
        approved_by: OWNER_TELEGRAM_ID,
      },
    });

    const approval = await request.post('/api/social', {
      data: { action: 'approveScheduledPost', id, approved_by: 'test-admin' },
    });
    expect(approval.status()).toBe(200);
    const approvalBody = await approval.json();
    expect(approvalBody.data).toMatchObject({
      status: 'approved_scheduled',
      approved_for_publish: true,
      approved_by: 'test-admin',
      queue_state: 'approved_scheduled',
    });

    const contextRes = await request.get('/api/social?action=context', { headers: authHeaders });
    const context = await contextRes.json();
    const stored = context.data.scheduled_posts.find(p => p.id === id);
    expect(stored.status).toBe('approved_scheduled');
    expect(stored.approved_for_publish).toBe(true);

    const edited = await request.post('/api/social', {
      headers: authHeaders,
      data: {
        action: 'updateScheduled',
        id,
        status: 'scheduled',
        caption: 'Edited future canary candidate',
        approved: true,
        approved_by: OWNER_TELEGRAM_ID,
      },
    });
    expect(edited.status()).toBe(200);
    const editedBody = await edited.json();
    expect(editedBody.data.status).toBe('scheduled');
    expect(editedBody.data.approved_for_publish).toBe(false);
    expect(editedBody.data.approved_by).toBeNull();
  });
});
