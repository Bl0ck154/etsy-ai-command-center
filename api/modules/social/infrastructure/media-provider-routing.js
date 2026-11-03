function splitConfiguredList(value = '') {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function uniqueConfiguredList(items = []) {
  return [...new Set(items.map(item => String(item || '').trim()).filter(Boolean))];
}

export function socialMediaImageModelsForTier(
  tier = 'cheap',
  requestedModel = '',
  providerConfig = {},
  env = process.env,
) {
  const requested = String(requestedModel || '').trim();
  const envByTier = {
    cheap: splitConfiguredList(env.SOCIAL_HERMES_IMAGE_MODELS_CHEAP || env.EXTERNAL_IMAGE_MODELS_CHEAP),
    standard: splitConfiguredList(env.SOCIAL_HERMES_IMAGE_MODELS_STANDARD || env.EXTERNAL_IMAGE_MODELS_STANDARD),
    high: splitConfiguredList(env.SOCIAL_HERMES_IMAGE_MODELS_HIGH || env.EXTERNAL_IMAGE_MODELS_HIGH),
  };
  const broadFallbacks = splitConfiguredList(
    env.SOCIAL_HERMES_IMAGE_MODELS_FALLBACK || env.EXTERNAL_IMAGE_MODELS_FALLBACK,
  );
  return uniqueConfiguredList([
    requested,
    ...envByTier[tier],
    providerConfig.imageModel,
    ...broadFallbacks,
  ]).slice(0, 3);
}

export function socialMediaTimeoutForTier(
  tier = 'cheap',
  override = null,
  providerConfig = {},
  env = process.env,
) {
  const maxTimeoutMs = 900_000;
  const parsedOverride = Number(override);
  if (Number.isFinite(parsedOverride) && parsedOverride >= 5_000 && parsedOverride <= maxTimeoutMs) {
    return parsedOverride;
  }
  const configured = Number(
    env.SOCIAL_HERMES_IMAGE_TIMEOUT_MS
    || providerConfig.imageTimeoutMs
    || env.EXTERNAL_IMAGE_TIMEOUT_MS
    || env.OMNIROUTE_IMAGE_TIMEOUT_MS
    || env.OMNIROUTE_TIMEOUT_MS,
  );
  if (Number.isFinite(configured) && configured >= 5_000 && configured <= maxTimeoutMs) return configured;
  if (tier === 'cheap') return 18_000;
  if (tier === 'standard') return 24_000;
  return 30_000;
}

export function socialMediaSafeProviderEndpoint(value = '') {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || '').split('?')[0];
  }
}

export function socialMediaProviderErrorDiagnostics(error, fallback = {}) {
  const endpoint = socialMediaSafeProviderEndpoint(error?.endpoint || fallback.endpoint || '');
  const out = {
    error: error?.message || fallback.error || 'Generated media failed.',
    provider: fallback.provider || error?.provider || undefined,
    endpoint: endpoint || undefined,
    http_status: error?.status || error?.http_status || fallback.http_status || undefined,
    response_shape: error?.response_shape || fallback.response_shape || undefined,
    parser_stage: error?.parser_stage || fallback.parser_stage || undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined && value !== ''));
}

export function createSocialMediaProviderRouter({
  hasImageConfig,
  getRuntimeConfig,
  buildProviderUrl,
  generateImages,
  env = process.env,
} = {}) {
  for (const [name, dependency] of Object.entries({
    hasImageConfig,
    getRuntimeConfig,
    buildProviderUrl,
    generateImages,
  })) {
    if (typeof dependency !== 'function') throw new TypeError(`${name} dependency is required`);
  }

  const resolve = async ({ tier, requestedModel = '', timeoutOverride = null } = {}) => {
    const configured = await hasImageConfig().catch(() => false);
    const runtime = configured ? await getRuntimeConfig().catch(() => null) : null;
    const modelCandidates = socialMediaImageModelsForTier(tier, requestedModel, runtime || {}, env);
    const attemptTimeoutMs = socialMediaTimeoutForTier(tier, timeoutOverride, runtime || {}, env);
    const endpoint = runtime
      ? socialMediaSafeProviderEndpoint(
        buildProviderUrl(runtime.imageBaseUrl || runtime.baseUrl, runtime.imagePath),
      )
      : '';
    return { configured, runtime, modelCandidates, attemptTimeoutMs, endpoint };
  };

  const generate = async (args, timeoutMs, label) => {
    const controller = new AbortController();
    let timer;
    try {
      timer = setTimeout(
        () => controller.abort(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      );
      return await generateImages({ ...args, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    errorDiagnostics: socialMediaProviderErrorDiagnostics,
    generate,
    resolve,
    safeEndpoint: socialMediaSafeProviderEndpoint,
  };
}
