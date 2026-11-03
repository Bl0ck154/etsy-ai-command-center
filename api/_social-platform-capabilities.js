const PLATFORM_ALIASES = {
  fb: 'facebook',
  fb_posts: 'facebook',
  facebook_posts: 'facebook',
  ig: 'instagram',
  insta: 'instagram',
  instagram_business: 'instagram',
  make: 'pinterest',
  make_com: 'pinterest',
  pin: 'pinterest',
  pins: 'pinterest',
  tik_tok: 'tiktok',
};

const CONNECTOR_CONFIG_KEYS = new Set(['buffer_config', 'metricool_config', 'zapier_config']);
const CONNECTOR_NAMES = new Set(['buffer', 'metricool', 'zapier', 'make', 'make_com']);
const NON_CONNECTING_CONFIG_KEYS = new Set(['invalid', 'last_error', 'error', 'errors', 'checked_at', 'updated_at', 'created_at']);

const SOCIAL_FEED_MEDIA_CONTRACTS = Object.freeze({
  instagram: Object.freeze({
    surface: 'feed_or_carousel',
    allowed_aspect_ratios: Object.freeze(['1:1', '4:5', '16:9']),
    preferred_aspect_ratios: Object.freeze(['4:5', '1:1']),
    max_media_items: 10,
    note: 'Use 4:5 or 1:1 for Instagram feed/carousel. Do not reuse a Pinterest-first 2:3 or taller frame.',
  }),
  facebook: Object.freeze({
    surface: 'feed',
    allowed_aspect_ratios: Object.freeze(['1:1', '4:5', '3:4', '2:3', '16:9']),
    preferred_aspect_ratios: Object.freeze(['4:5', '1:1']),
    max_media_items: 10,
    note: 'Choose a feed composition that remains legible without relying on an Instagram or Pinterest crop.',
  }),
  pinterest: Object.freeze({
    surface: 'standard_pin',
    allowed_aspect_ratios: Object.freeze(['1:1', '4:5', '3:4', '2:3']),
    preferred_aspect_ratios: Object.freeze(['2:3']),
    max_media_items: 1,
    note: 'The configured Make route creates one standard Pin; a dedicated 2:3 frame is preferred when the composition benefits from it.',
  }),
  tiktok: Object.freeze({
    surface: 'vertical_post',
    allowed_aspect_ratios: Object.freeze(['1:1', '4:5', '9:16']),
    preferred_aspect_ratios: Object.freeze(['9:16']),
    max_media_items: 1,
    note: 'Use a dedicated vertical frame for TikTok instead of sharing a Pinterest or feed crop by default.',
  }),
});

export function normalizeSocialPlatformToken(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_config$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function normalizeSocialPlatformId(value = '') {
  const normalized = normalizeSocialPlatformToken(value);
  return PLATFORM_ALIASES[normalized] || normalized;
}

export function socialPlatformMediaContract(platform = '') {
  const id = normalizeSocialPlatformId(platform);
  const contract = SOCIAL_FEED_MEDIA_CONTRACTS[id];
  if (!contract) return null;
  return {
    platform: id,
    surface: contract.surface,
    allowed_aspect_ratios: [...contract.allowed_aspect_ratios],
    preferred_aspect_ratios: [...contract.preferred_aspect_ratios],
    max_media_items: contract.max_media_items,
    note: contract.note,
  };
}

export function socialPlatformMediaContracts(platforms = []) {
  return Object.fromEntries(
    [...new Set((Array.isArray(platforms) ? platforms : []).map(normalizeSocialPlatformId).filter(Boolean))]
      .map(platform => [platform, socialPlatformMediaContract(platform)])
      .filter(([, contract]) => Boolean(contract)),
  );
}

export function socialAspectRatioFitsPlatform(platform = '', aspectRatio = '') {
  const contract = socialPlatformMediaContract(platform);
  return !contract || contract.allowed_aspect_ratios.includes(String(aspectRatio || '').trim());
}

function configLooksPresent(config) {
  if (config === true) return true;
  if (typeof config === 'string') return config.trim().length > 0;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  if (config.enabled === false || config.disabled === true || config.invalid === true) return false;
  return Object.entries(config).some(([key, value]) => {
    if (NON_CONNECTING_CONFIG_KEYS.has(String(key || '').toLowerCase())) return false;
    if (value === undefined || value === null || value === false || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  });
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function firstConfigObject(configs = {}, ...keys) {
  for (const key of keys) {
    const value = configs?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return { key, value };
  }
  return { key: '', value: {} };
}

function validHttpsUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && Boolean(url.hostname) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function resolveInstagramDirectPublishConfig(socialConfigs = {}, env = process.env) {
  const selected = firstConfigObject(socialConfigs, 'ig_config', 'instagram_config', 'instagram_direct_config', 'instagram');
  const cfg = selected.value;
  const token = firstNonEmpty(
    env.INSTAGRAM_ACCESS_TOKEN,
    cfg.token,
    cfg.access_token,
    cfg.accessToken,
    cfg.long_lived_token,
    cfg.longLivedToken,
  );
  const userId = firstNonEmpty(
    env.INSTAGRAM_USER_ID,
    cfg.ig_id,
    cfg.instagram_id,
    cfg.instagram_user_id,
    cfg.instagramBusinessId,
    cfg.instagram_business_id,
    cfg.user_id,
    cfg.userId,
  );
  const envComplete = Boolean(String(env.INSTAGRAM_ACCESS_TOKEN || '').trim() && String(env.INSTAGRAM_USER_ID || '').trim());
  return {
    configured: Boolean(token && userId),
    token,
    userId,
    source: token && userId ? (envComplete ? 'env' : 'kv') : null,
    config_key: selected.key || null,
  };
}

export function resolveFacebookDirectPublishConfig(socialConfigs = {}, env = process.env) {
  const selected = firstConfigObject(socialConfigs, 'fb_posts_config', 'facebook_posts_config', 'facebook_config', 'facebook');
  const cfg = selected.value;
  const token = firstNonEmpty(
    env.FACEBOOK_PAGE_TOKEN,
    cfg.page_token,
    cfg.pageToken,
    cfg.token,
    cfg.access_token,
    cfg.accessToken,
  );
  const pageId = firstNonEmpty(env.FACEBOOK_PAGE_ID, cfg.page_id, cfg.pageId, cfg.id);
  const envComplete = Boolean(String(env.FACEBOOK_PAGE_TOKEN || '').trim() && String(env.FACEBOOK_PAGE_ID || '').trim());
  return {
    configured: Boolean(token && pageId),
    token,
    pageId,
    source: token && pageId ? (envComplete ? 'env' : 'kv') : null,
    config_key: selected.key || null,
  };
}

export function resolvePinterestMakePublishConfig(socialConfigs = {}, env = process.env, overrideWebhookUrl = '') {
  const cfg = socialConfigs?.make_config && typeof socialConfigs.make_config === 'object'
    ? socialConfigs.make_config
    : {};
  const candidates = [
    { value: overrideWebhookUrl, source: 'resolved' },
    { value: cfg.webhook_url, source: 'kv' },
    { value: cfg.url, source: 'kv' },
    { value: env.MAKE_WEBHOOK_URL, source: 'env' },
  ];
  const selected = candidates
    .map(candidate => ({ ...candidate, url: validHttpsUrl(candidate.value) }))
    .find(candidate => candidate.url) || { url: '', source: null };
  const configuredUrl = selected.url;
  const callbackSecret = firstNonEmpty(env.MAKE_CALLBACK_SECRET);
  return {
    configured: Boolean(configuredUrl && callbackSecret),
    webhook_configured: Boolean(configuredUrl),
    callback_configured: Boolean(callbackSecret),
    url: configuredUrl,
    callbackSecret,
    source: selected.source,
  };
}

export function resolveTikTokPublishConfig(env = process.env) {
  const bufferConfigured = Boolean(
    String(env.BUFFER_ACCESS_TOKEN || '').trim()
    && String(env.BUFFER_PROFILE_IDS || '').split(',').some(value => value.trim()),
  );
  const metricoolConfigured = Boolean(
    String(env.METRICOOL_API_KEY || '').trim()
    && String(env.METRICOOL_BRAND_ID || '').trim(),
  );
  return {
    configured: bufferConfigured || metricoolConfigured,
    route: bufferConfigured ? 'buffer' : (metricoolConfigured ? 'metricool' : null),
    buffer_configured: bufferConfigured,
    metricool_configured: metricoolConfigured,
  };
}

function declaredPlatforms(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  return [
    config.platform,
    config.network,
    config.channel,
    ...(Array.isArray(config.platforms) ? config.platforms : []),
    ...(Array.isArray(config.networks) ? config.networks : []),
    ...(Array.isArray(config.channels) ? config.channels : []),
  ].map(normalizeSocialPlatformId).filter(Boolean);
}

function collectPlanTargets(socialConfigs = {}, env = process.env) {
  const targets = new Map();
  const add = (platform, sourceKey, discoveryRoute) => {
    const id = normalizeSocialPlatformId(platform);
    if (!id || id === 'all' || CONNECTOR_NAMES.has(id)) return;
    if (!targets.has(id)) targets.set(id, { source_keys: new Set(), discovery_routes: new Set() });
    if (sourceKey) targets.get(id).source_keys.add(sourceKey);
    if (discoveryRoute) targets.get(id).discovery_routes.add(discoveryRoute);
  };

  for (const [key, config] of Object.entries(socialConfigs && typeof socialConfigs === 'object' ? socialConfigs : {})) {
    if (!configLooksPresent(config)) continue;
    if (key === 'make_config') add('pinterest', key, 'make');
    const base = normalizeSocialPlatformId(key);
    if (!CONNECTOR_CONFIG_KEYS.has(key) && base !== 'pinterest') add(base, key, 'configured');
    if (base === 'pinterest' && key !== 'make_config') add('pinterest', key, 'configured');
    for (const platform of declaredPlatforms(config)) add(platform, key, 'declared');
  }

  if (String(env.INSTAGRAM_ACCESS_TOKEN || '').trim() || String(env.INSTAGRAM_USER_ID || '').trim()) add('instagram', 'instagram_env', 'env');
  if (String(env.FACEBOOK_PAGE_TOKEN || '').trim() || String(env.FACEBOOK_PAGE_ID || '').trim()) add('facebook', 'facebook_env', 'env');
  if (validHttpsUrl(env.MAKE_WEBHOOK_URL)) add('pinterest', 'make_env', 'env');
  if (resolveTikTokPublishConfig(env).configured) add('tiktok', 'tiktok_env', 'env');
  return targets;
}

export function resolveSocialPlatformCapabilities(socialConfigs = {}, options = {}) {
  const env = options.env || process.env;
  const planTargets = collectPlanTargets(socialConfigs, env);
  const instagram = resolveInstagramDirectPublishConfig(socialConfigs, env);
  const facebook = resolveFacebookDirectPublishConfig(socialConfigs, env);
  const pinterest = resolvePinterestMakePublishConfig(socialConfigs, env, options.makeWebhookUrl || '');
  const tiktok = resolveTikTokPublishConfig(env);
  const known = {
    instagram: {
      publish_capable: instagram.configured,
      publish_route: instagram.configured ? 'instagram_direct' : null,
      blocker_code: 'INSTAGRAM_DIRECT_CREDENTIALS_INCOMPLETE',
      blocker_reason: 'Instagram publishing requires both an access credential and Instagram business user ID.',
    },
    facebook: {
      publish_capable: facebook.configured,
      publish_route: facebook.configured ? 'facebook_direct' : null,
      blocker_code: 'FACEBOOK_DIRECT_CREDENTIALS_INCOMPLETE',
      blocker_reason: 'Facebook publishing requires both a page access credential and page ID.',
    },
    pinterest: {
      publish_capable: pinterest.configured,
      publish_route: pinterest.configured ? 'make_pinterest_bridge' : null,
      blocker_code: pinterest.webhook_configured ? 'MAKE_CALLBACK_SECRET_MISSING' : 'MAKE_PINTEREST_WEBHOOK_MISSING',
      blocker_reason: pinterest.webhook_configured
        ? 'Pinterest publishing requires MAKE_CALLBACK_SECRET for attempt-bound delivery callbacks.'
        : 'Pinterest publishing requires a valid HTTPS Make.com webhook.',
    },
    tiktok: {
      publish_capable: tiktok.configured,
      publish_route: tiktok.route === 'buffer' ? 'buffer_tiktok' : (tiktok.route === 'metricool' ? 'metricool_tiktok' : null),
      blocker_code: 'TIKTOK_PUBLISHER_MISSING',
      blocker_reason: 'TikTok publishing requires a complete Buffer credential/profile route or Metricool API key/brand route.',
    },
  };

  for (const platform of Object.keys(known)) {
    if (known[platform].publish_capable && !planTargets.has(platform)) {
      planTargets.set(platform, { source_keys: new Set(['runtime']), discovery_routes: new Set(['publish_route']) });
    }
  }

  const platformIds = [...new Set([...planTargets.keys(), ...Object.keys(known)])].sort((a, b) => a.localeCompare(b));
  const platforms = platformIds.map(platform => {
    const target = planTargets.get(platform);
    const capability = known[platform] || {
      publish_capable: false,
      publish_route: null,
      blocker_code: 'PUBLISH_ROUTE_NOT_IMPLEMENTED',
      blocker_reason: `No Etsy AI Command Center autopublish route is implemented for ${platform}.`,
    };
    return {
      platform,
      plan_capable: Boolean(target),
      publish_capable: capability.publish_capable,
      publish_route: capability.publish_route,
      blocker_code: capability.publish_capable ? null : capability.blocker_code,
      blocker_reason: capability.publish_capable ? '' : capability.blocker_reason,
      source_keys: target ? [...target.source_keys].sort() : [],
      discovery_routes: target ? [...target.discovery_routes].sort() : [],
    };
  });
  const byPlatform = Object.fromEntries(platforms.map(item => [item.platform, item]));
  return {
    platforms,
    by_platform: byPlatform,
    plan_capable_platforms: platforms.filter(item => item.plan_capable).map(item => item.platform),
    publish_capable_platforms: platforms.filter(item => item.publish_capable).map(item => item.platform),
    connectors: {
      make: {
        webhook_configured: pinterest.webhook_configured,
        callback_configured: pinterest.callback_configured,
        publish_capable: pinterest.configured,
      },
      buffer: { publish_capable: tiktok.buffer_configured },
      metricool: { publish_capable: tiktok.metricool_configured },
      meta_direct: {
        instagram_publish_capable: instagram.configured,
        facebook_publish_capable: facebook.configured,
      },
    },
  };
}

export function socialPlatformCapability(platform, socialConfigs = {}, options = {}) {
  const id = normalizeSocialPlatformId(platform);
  return resolveSocialPlatformCapabilities(socialConfigs, options).by_platform[id] || {
    platform: id,
    plan_capable: false,
    publish_capable: false,
    publish_route: null,
    blocker_code: 'PUBLISH_ROUTE_NOT_IMPLEMENTED',
    blocker_reason: id ? `No Etsy AI Command Center autopublish route is implemented for ${id}.` : 'A concrete platform is required.',
    source_keys: [],
    discovery_routes: [],
  };
}
