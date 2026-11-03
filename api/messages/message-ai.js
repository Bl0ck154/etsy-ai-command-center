import { generateWithExternalAi } from '../_external-ai.js';

const DEFAULT_PRIMARY_MODEL = 'antigravity/gemini-3.1-pro-high';
const DEFAULT_FALLBACK_MODEL = 'codex/gpt-5.6-terra-medium';

function cleanModel(value, fallback) {
  return String(value || '').trim() || fallback;
}

export function messageAiModelOrder() {
  return [
    cleanModel(process.env.MESSAGE_AI_PRIMARY_MODEL, DEFAULT_PRIMARY_MODEL),
    cleanModel(process.env.MESSAGE_AI_FALLBACK_MODEL, DEFAULT_FALLBACK_MODEL),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

export async function generateWithMessageAi(
  systemPrompt,
  userPrompt,
  _model = '',
  options = {},
) {
  const callerSuccess = options.onProviderSuccess;
  return generateWithExternalAi(systemPrompt, userPrompt, '', {
    ...options,
    preferredModelOrder: messageAiModelOrder(),
    onProviderSuccess: provider => {
      console.info('[messages-ai] generation completed', {
        provider: provider?.id || 'unknown',
        model: provider?.model || 'unknown',
      });
      callerSuccess?.(provider);
    },
  });
}
