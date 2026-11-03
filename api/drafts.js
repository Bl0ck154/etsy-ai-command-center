// api/drafts.js - server-side page draft persistence

import { requireAuth } from './_auth.js';
import { getShopId } from './_etsy.js';
import {
  createCreateDraftApplication,
  mergeCreateDraftPatch,
} from './drafts/create-draft-application.js';
import {
  draftStorageFilename,
  mutateDraftRecord,
  readDraftRecord,
  safeDraftSegment,
} from './drafts/draft-repository.js';

export { mergeCreateDraftPatch };
export { draftStorageFilename, safeDraftSegment };

export const maxDuration = 10;

const ALLOWED_KEYS = new Set(['create_draft']);
const createDraftApplication = createCreateDraftApplication({
  readDraftRecord,
  mutateDraftRecord,
});

function draftKey(req, key) {
  const normalizedKey = safeDraftSegment(key);
  if (!ALLOWED_KEYS.has(normalizedKey)) return null;
  const shopId = safeDraftSegment(req.headers?.['x-shop-id'] || getShopId() || 'default_shop');
  const userId = safeDraftSegment(req.auth?.user?.id || 'anonymous');
  return {
    key: normalizedKey,
    shopId,
    userId,
  };
}

function sendDraftMutationResponse(res, result) {
  if (result.status && result.status !== 200) {
    return res.status(result.status).json(result.payload);
  }
  return res.json(result.payload);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const source = req.method === 'GET' ? req.query : req.body || {};
  const action = String(source.action || '').trim();
  const keyInfo = draftKey(req, source.key || 'create_draft');
  if (!keyInfo) return res.status(400).json({ error: 'Unsupported draft key' });

  try {
    if (action === 'get') {
      return sendDraftMutationResponse(
        res,
        await createDraftApplication.get(keyInfo),
      );
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    if (action === 'set') {
      return sendDraftMutationResponse(
        res,
        await createDraftApplication.set(keyInfo, source),
      );
    }

    if (action === 'patch') {
      return sendDraftMutationResponse(
        res,
        await createDraftApplication.patch(keyInfo, source),
      );
    }

    if (action === 'delete') {
      return sendDraftMutationResponse(
        res,
        await createDraftApplication.remove(keyInfo, source),
      );
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[drafts] request failed:', err?.message || err);
    return res.status(err?.status || 500).json({ error: err?.message || 'Draft storage failed' });
  }
}
