// api/upload.js — Image upload HTTP compatibility facade

import { getValidToken, refreshAccessToken } from './auth.js';
import { requireAuth } from './_auth.js';
import { sendPublicError } from './_errors.js';
import { ETSY_BASE, API_KEY_FULL, getShopId } from './_etsy.js';
import { createUploadApplication } from './upload/application.js';

export {
  MAX_REMOTE_IMAGE_BYTES,
  REMOTE_IMAGE_TIMEOUT_MS,
  uploadImageAction,
  isAllowedEtsyImageUrl,
  downloadEtsyListingImage,
  uploadListingImageBuffer,
} from './upload/image-transfer.js';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

process.on('unhandledRejection', err => console.error('[unhandled]', err?.message));

const uploadApplication = createUploadApplication({
  etsyBase: ETSY_BASE,
  apiKey: API_KEY_FULL,
  shopId: getShopId(),
});

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const token = await getValidToken();
    const result = await uploadApplication.execute(req.body || {}, { token });
    if (result.kind === 'delete') return res.json(result.data);
    return res.json({ success: true, data: result.data });
  } catch (err) {
    const isTokenError = err.message?.includes('401')
      || err.status === 401
      || err.message?.toLowerCase().includes('expired')
      || err.message?.toLowerCase().includes('access token');
    if (isTokenError) {
      try {
        await refreshAccessToken();
        return handler(req, res);
      } catch (retryErr) {
        console.error('[upload.js] retry failed:', retryErr.message);
        return res.status(401).json({ error: 'Token refresh failed: ' + retryErr.message });
      }
    }
    console.error('[upload.js]', err.message);
    return sendPublicError(res, err);
  }
}
