const PROVIDER_ORDERS = {
  auto: ['external', 'claude', 'gemini'],
  external: ['external', 'gemini', 'claude'],
  claude: ['claude', 'external', 'gemini'],
  gemini: ['gemini', 'external', 'claude'],
};

export function resolveTextProvider(requested = 'auto', capabilities = {}) {
  const normalized = String(requested || 'auto').trim().toLowerCase();
  const order = PROVIDER_ORDERS[normalized] || PROVIDER_ORDERS.auto;
  const available = {
    external: capabilities.hasExternal === true,
    claude: capabilities.hasClaude === true,
    gemini: capabilities.hasGemini === true,
  };
  return order.find(provider => available[provider]) || 'none';
}
