import { test, expect } from '@playwright/test';

const enabled = String(process.env.GPT_LIVE_DRAFT_TEST_ENABLED || '').toLowerCase() === 'true';
const baseUrl = String(process.env.GPT_LIVE_BASE_URL || '').replace(/\/+$/, '');
const accessToken = String(process.env.GPT_LIVE_ACCESS_TOKEN || '');
const fileUrl = String(process.env.GPT_LIVE_DRAFT_FILE_URL || '');
const listingJson = String(process.env.GPT_LIVE_DRAFT_LISTING_JSON || '');

function requiredConfiguration() {
  expect(baseUrl, 'GPT_LIVE_BASE_URL is required when the live draft test is enabled').toMatch(/^https:\/\//);
  expect(accessToken, 'GPT_LIVE_ACCESS_TOKEN is required when the live draft test is enabled').not.toBe('');
  expect(fileUrl, 'GPT_LIVE_DRAFT_FILE_URL must be a temporary public PNG URL accepted by the deployed allowlist').toMatch(/^https:\/\//);
  expect(listingJson, 'GPT_LIVE_DRAFT_LISTING_JSON must contain a shop-valid draft payload').not.toBe('');
}

async function action(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  return { response, payload };
}

test.describe('explicit opt-in live GPT draft lifecycle', () => {
  test.skip(!enabled, 'Set GPT_LIVE_DRAFT_TEST_ENABLED=true explicitly to allow real Etsy draft writes.');

  test('create draft, upload one ChatGPT-style PNG reference, verify, then delete', async () => {
    requiredConfiguration();
    const template = JSON.parse(listingJson);
    const suffix = ` GPT live canary ${Date.now()}`;
    const listing = {
      ...template,
      title: `${String(template.title || 'GPT Actions test draft').slice(0, 140 - suffix.length)}${suffix}`,
    };
    const runId = `live-draft-${Date.now()}`;
    let listingId = null;
    let primaryError = null;

    try {
      const created = await action('/api/gpt/workflows/complete-draft', {
        method: 'POST',
        body: {
          listing,
          openaiFileIdRefs: [{
            id: `${runId}-file`,
            name: 'gpt-live-tiny.png',
            mime_type: 'image/png',
            download_link: fileUrl,
          }],
          file_metadata: [{
            target: 'listing_image',
            rank: 1,
            alt_text: 'Temporary GPT Actions lifecycle test image',
          }],
          atomic: true,
          verify: true,
          idempotency_key: `${runId}-complete`,
        },
      });
      expect(created.response.status, JSON.stringify(created.payload)).toBe(200);
      listingId = Number(created.payload?.data?.listing_id);
      expect(listingId).toBeGreaterThan(0);
      expect(created.payload?.data?.stages).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'create_draft', status: 'succeeded' }),
        expect.objectContaining({ stage: 'image', status: 'succeeded' }),
        expect.objectContaining({ stage: 'verify', status: 'succeeded' }),
      ]));
      expect(created.payload?.data?.verification?.image_count).toBeGreaterThanOrEqual(1);

      const verified = await action(`/api/gpt/listings/${listingId}`);
      expect(verified.response.status, JSON.stringify(verified.payload)).toBe(200);
      expect(verified.payload?.data).toMatchObject({ listing_id: listingId, state: 'draft' });

      const images = await action(`/api/gpt/listings/${listingId}/images`);
      expect(images.response.status, JSON.stringify(images.payload)).toBe(200);
      expect(images.payload?.data?.results?.length).toBeGreaterThanOrEqual(1);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (listingId) {
        const deleted = await action(`/api/gpt/listings/${listingId}/delete`, {
          method: 'POST',
          body: { confirmation: true, idempotency_key: `${runId}-delete` },
        });
        if (!primaryError) expect(deleted.response.status, JSON.stringify(deleted.payload)).toBe(200);
      }
    }
  });
});
