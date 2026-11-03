import { requireAuth } from './_auth.js';
import { sendPublicError } from './_errors.js';
import {
  buildCookieHeader,
  generateMetaAiVideo,
  getMetaAiCookieHeader,
  getMetaAiSession,
  getSafeMetaAiStatus,
  probeMetaAiGateway,
} from './_meta-ai.js';
import { hasMetaAiApiToken } from './meta-ai/auth.js';
import { createMetaAiApplication } from './meta-ai/application.js';
import { metaAi403Message, metaAiCookieDiagnostics } from './meta-ai/diagnostics.js';

export const maxDuration = 150;

const metaAiApplication = createMetaAiApplication({
  buildCookieHeader,
  getMetaAiCookieHeader,
  getMetaAiSession,
  getSafeMetaAiStatus,
  probeMetaAiGateway,
  generateMetaAiVideo,
});

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!hasMetaAiApiToken(req) && !requireAuth(req, res)) return;

  const input = req.method === 'GET' ? req.query : req.body || {};
  const action = String(input.action || 'status');

  try {
    const result = await metaAiApplication.execute(action, input);
    if (result.kind === 'video') return res.json({ success: true, video: result.video });
    return res.json({ success: true, data: result.data });
  } catch (err) {
    if (err?.code?.startsWith?.('META_AI_')) {
      const diagnostics = err.metaAiCookieHeader
        ? metaAiCookieDiagnostics(err.metaAiCookieHeader)
        : null;
      const metaAi403 = err.status === 403 || err.statusCode === 403;
      return res.status(err.status || err.statusCode || 500).json({
        success: false,
        error: metaAi403 ? metaAi403Message(err, diagnostics) : err.message,
        code: err.code,
        stage: err.stage || '',
        cookieDiagnostics: diagnostics,
      });
    }
    return sendPublicError(res, err);
  }
}
