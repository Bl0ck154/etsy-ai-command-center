export const maxDuration = 60;

// api/ai.js — AI generation proxy

import { requireAuth } from './_auth.js';
import { sendPublicError } from './_errors.js';
import { MODEL } from './_config.js';
import { hasExternalAiConfigAsync } from './_external-ai.js';
import { resolveTextProvider } from './_provider-routing.js';
import { AUTOPILOT_SYSTEM, buildAutopilotPrompt, generate } from './_generate.js';
import { createAiStreamingService } from './ai/streaming-service.js';

process.on('unhandledRejection', err => console.error('[unhandled]', err?.message));

const aiStreaming = createAiStreamingService({
  model: MODEL,
  generate,
  hasExternalAiConfigAsync,
});

export default async function handler(req, res) {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasExternal = await hasExternalAiConfigAsync();
  if (!hasAnthropic && !hasGemini && !hasExternal) {
    return res.status(500).json({
      error: 'No AI provider configured. Add ANTHROPIC_API_KEY, GEMINI_API_KEY, or EXTERNAL_AI_BASE_URL + EXTERNAL_AI_API_KEY to the runtime environment.',
    });
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { type, provider: requestedProvider, ...params } = req.body;
  const provider = resolveTextProvider(requestedProvider, {
    hasExternal,
    hasClaude: hasAnthropic,
    hasGemini,
  });

  if (params.stream && params._rawPrompt) {
    return aiStreaming.streamRawPrompt(res, { ...params, provider });
  }

  if (params.stream && type === 'autopilot') {
    return aiStreaming.streamRawPrompt(res, {
      ...params,
      provider,
      _rawSystem: AUTOPILOT_SYSTEM,
      _rawPrompt: buildAutopilotPrompt(params),
    });
  }

  if (!['listing', 'social', 'audit', 'autopilot'].includes(type)) {
    return res.status(400).json({ error: 'type must be "listing", "social", "audit", or "autopilot"' });
  }

  if (provider === 'claude' && !process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }
  if (provider === 'gemini' && !process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }
  if (provider === 'external' && !hasExternal) {
    return res.status(500).json({ error: 'EXTERNAL_AI_BASE_URL and EXTERNAL_AI_API_KEY not configured' });
  }

  try {
    const result = await generate(type, params, provider);
    return res.json({ success: true, data: result, provider });
  } catch (err) {
    console.error('[ai.js] generate error:', err.message);
    return sendPublicError(res, err);
  }
}
