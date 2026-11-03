// api/_config.js — Central AI model config
// Change defaults here OR override individually via runtime environment variables.

import { DEFAULT_MODELS } from '../public/utils/models.js';

export const MODEL = {
  // Gemini text model (listing generation, agent, streaming chat)
  gemini:     process.env.GEMINI_MODEL       || DEFAULT_MODELS.gemini,
  // Gemini image generation model
  geminiImage:process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview',
  // Claude main model (listing generation, social copy)
  claude:     process.env.CLAUDE_MODEL       || DEFAULT_MODELS.claude,
  // Claude fast model (agent, inline streaming assist)
  claudeFast: process.env.CLAUDE_FAST_MODEL  || 'claude-sonnet-4-6',
  // Claude chat model (AI Assistant page)
  claudeChat: process.env.CLAUDE_CHAT_MODEL  || 'claude-sonnet-4-6',
  // External OpenAI-compatible text/chat model. Runtime env can override the
  // project default, but a configured external provider always has a stable id.
  external:   process.env.EXTERNAL_AI_MODEL || process.env.OMNIROUTE_TEXT_MODEL || DEFAULT_MODELS.external,
  // External image model. The image adapter still controls whether this
  // capability is advertised and which protocol is used.
  externalImage: process.env.EXTERNAL_IMAGE_MODEL || process.env.OMNIROUTE_IMAGE_MODEL || DEFAULT_MODELS.externalImage,
};

export const EXTERNAL_AI = {
  // Generic OpenAI-compatible external gateway. Every runtime capability is
  // configured explicitly; possession of a credential does not select a host.
  baseUrl: (process.env.EXTERNAL_AI_BASE_URL || process.env.OMNIROUTE_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.EXTERNAL_AI_API_KEY || process.env.OMNIROUTE_API_KEY || '',
  method: (process.env.EXTERNAL_AI_METHOD || 'openai').toLowerCase(),
  textPath: process.env.EXTERNAL_AI_TEXT_PATH || '/v1/chat/completions',
  imagePath: process.env.EXTERNAL_AI_IMAGE_PATH || '/v1/chat/completions',
};
