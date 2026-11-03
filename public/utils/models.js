// public/utils/models.js — Canonical model-id contract shared by browser and API.
// Runtime env/KV may override the external project model on the server; the
// browser must never override it with an old per-user localStorage value.

export const DEFAULT_MODELS = {
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-pro-latest',
  external: 'codex/gpt-5.6-terra-medium',
  externalImage: 'codex/gpt-5.6-terra',
};

/** Returns the user-selected model for a provider, falling back to default. */
export function getModel(provider) {
  if (provider === 'external' || provider === 'externalImage') return DEFAULT_MODELS[provider];
  return localStorage.getItem(`ai_model_${provider}`) || DEFAULT_MODELS[provider];
}
