import { requireAuth } from './_auth.js';
import {
  approveEtsyGuidanceCandidateV2,
  dismissEtsyGuidanceCandidateV2,
  getEtsyGuidanceStatusV2,
  refreshEtsyGuidanceV2,
  restoreBundledEtsyGuidanceV2,
} from './etsy-guidance/stateful-service.js';

export const maxDuration = 120;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const input = req.method === 'GET' ? req.query : req.body;
  const action = String(input?.action || 'status');
  const actorId = String(req.auth?.user?.id || 'owner');

  try {
    if (action === 'status' && ['GET', 'POST'].includes(req.method)) {
      return res.json({ success: true, data: await getEtsyGuidanceStatusV2() });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (action === 'refresh') {
      const data = await refreshEtsyGuidanceV2({ force: input?.force === true });
      return res.json({ success: true, data });
    }
    if (action === 'approve') {
      const data = await approveEtsyGuidanceCandidateV2({
        actorId,
        candidateId: String(input?.candidate_id || ''),
        digest: String(input?.candidate_sha256 || ''),
      });
      return res.json({ success: true, data });
    }
    if (action === 'dismiss') {
      const data = await dismissEtsyGuidanceCandidateV2({
        actorId,
        candidateId: String(input?.candidate_id || ''),
        digest: String(input?.candidate_sha256 || ''),
      });
      return res.json({ success: true, data });
    }
    if (action === 'restore_bundled') {
      const data = await restoreBundledEtsyGuidanceV2(actorId);
      return res.json({ success: true, data });
    }
    return res.status(400).json({ error: 'Unknown Etsy guidance action' });
  } catch (error) {
    const status = Number(error?.status || 0) || (/candidate|integrity/i.test(String(error?.message || '')) ? 409 : 500);
    return res.status(status).json({
      error: status >= 500 ? 'Etsy guidance refresh failed' : error.message,
      ...(process.env.NODE_ENV !== 'production' ? { detail: error?.message || String(error) } : {}),
    });
  }
}
