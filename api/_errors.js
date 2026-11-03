function sanitizeProviderDetails(message) {
  let text = String(message || '').trim();
  if (!text) return text;
  if (/JSON\.parse|Unexpected end of JSON input|unexpected end of data/i.test(text)) {
    return 'The provider returned an empty or invalid response. Please try again or check the provider status.';
  }
  text = text
    .replace(/OmniRoute/gi, 'the external provider')
    .replace(/omniroute/gi, 'external-provider')
    .replace(/Pollinations/gi, 'the external provider')
    .replace(/pollinations/gi, 'external-provider')
    .replace(/\b(?:gpt-image-2|flux|chatgpt-web\/[^\s,)]+)/gi, 'the configured image model')
    .replace(/https?:\/\/[^\s,)]+/gi, '[provider endpoint]')
    .replace(/\bExternal image AI\b/g, 'Image provider')
    .replace(/\bExternal AI\b/g, 'AI provider');
  return text;
}

export function publicErrorMessage(err, status = 500, fallback = 'Internal server error') {
  if (status < 500 || process.env.NODE_ENV !== 'production') {
    return sanitizeProviderDetails(err?.message || fallback);
  }
  return fallback;
}

export function sendPublicError(res, err, fallback = 'Internal server error') {
  const status = err?.status || err?.statusCode || 500;
  return res.status(status).json({ error: publicErrorMessage(err, status, fallback) });
}
