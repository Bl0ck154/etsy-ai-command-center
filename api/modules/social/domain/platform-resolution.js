import {
  normalizeSocialPlatformId,
  normalizeSocialPlatformToken,
  resolveSocialPlatformCapabilities,
  socialPlatformCapability,
} from '../../../_social-platform-capabilities.js';

const SOCIAL_CONNECTOR_NAMES = new Set(['buffer', 'metricool', 'zapier', 'make', 'make_com']);

export {
  normalizeSocialPlatformId as normalizeSocialHermesPlatformId,
  normalizeSocialPlatformToken as normalizeSocialHermesPlatformToken,
};

export function summarizeSocialHermesSocialConfigs(socialConfigs = {}) {
  const configs = socialConfigs && typeof socialConfigs === 'object' ? socialConfigs : {};
  const registry = resolveSocialPlatformCapabilities(configs);
  const platformRoutes = registry.platforms
    .filter(item => item.plan_capable)
    .map(item => ({ platform: item.platform, source_keys: item.source_keys, routes: item.discovery_routes }));
  const configuredPlatforms = registry.plan_capable_platforms;
  const targetsForSource = sourceKey => platformRoutes
    .filter(target => target.source_keys.includes(sourceKey))
    .map(target => target.platform)
    .sort();
  const sourceConfigured = sourceKey => platformRoutes.some(target => target.source_keys.includes(sourceKey));
  const connectorStates = {
    make: {
      configured: registry.connectors.make.webhook_configured,
      publish_capable: registry.connectors.make.publish_capable,
      target_platforms: [...new Set([...targetsForSource('make_config'), ...targetsForSource('make_env')])].sort(),
      route: 'pinterest_bridge',
    },
    buffer: {
      configured: sourceConfigured('buffer_config'),
      publish_capable: registry.connectors.buffer.publish_capable,
      target_platforms: targetsForSource('buffer_config'),
      route: 'external_queue',
    },
    metricool: {
      configured: sourceConfigured('metricool_config'),
      publish_capable: registry.connectors.metricool.publish_capable,
      target_platforms: targetsForSource('metricool_config'),
      route: 'external_queue',
    },
    zapier: {
      configured: sourceConfigured('zapier_config'),
      target_platforms: targetsForSource('zapier_config'),
      route: 'external_queue',
    },
    meta_direct: {
      instagram_configured: registry.by_platform.instagram?.publish_capable === true,
      facebook_configured: registry.by_platform.facebook?.publish_capable === true,
      target_platforms: configuredPlatforms.filter(platform => platform === 'instagram' || platform === 'facebook'),
      route: 'direct_api_when_publish_enabled',
    },
  };

  return {
    has_make: registry.connectors.make.webhook_configured,
    has_buffer_config: sourceConfigured('buffer_config'),
    has_metricool_config: sourceConfigured('metricool_config'),
    has_zapier_config: sourceConfigured('zapier_config'),
    configured_platforms: configuredPlatforms,
    configured_platform_count: configuredPlatforms.length,
    all_platform_target: configuredPlatforms,
    plan_capable_platforms: registry.plan_capable_platforms,
    publish_capable_platforms: registry.publish_capable_platforms,
    platform_capabilities: registry.platforms,
    platform_routes: platformRoutes,
    connector_states: connectorStates,
    note: 'Planning intent and real publish capability are resolved by one credential-safe registry. Autonomous campaigns use publish_capable_platforms only.',
  };
}

export function resolveSocialHermesConfiguredPlatforms(socialConfigs = {}) {
  return summarizeSocialHermesSocialConfigs(socialConfigs).configured_platforms;
}

export function resolveSocialHermesPublishCapablePlatforms(socialConfigs = {}) {
  return resolveSocialPlatformCapabilities(socialConfigs).publish_capable_platforms;
}

export function socialHermesUiPlatformCapabilityContext(socialConfigSummary = {}) {
  const capabilities = Array.isArray(socialConfigSummary.platform_capabilities)
    ? socialConfigSummary.platform_capabilities
    : [];
  const byPlatform = Object.fromEntries(capabilities.map(item => [item.platform, item]));
  const publishCapable = platform => byPlatform[platform]?.publish_capable === true;
  return {
    hasMake: socialConfigSummary.connector_states?.make?.configured === true,
    hasInstagram: publishCapable('instagram'),
    hasFacebook: publishCapable('facebook'),
    hasPinterest: publishCapable('pinterest'),
  };
}

export function resolveSocialHermesRequestedPlatforms(requestedPlatforms = [], configuredPlatforms = []) {
  const allowed = new Set((configuredPlatforms || []).map(normalizeSocialPlatformId).filter(Boolean));
  const requested = (Array.isArray(requestedPlatforms) ? requestedPlatforms : [requestedPlatforms])
    .map(normalizeSocialPlatformId)
    .filter(Boolean);
  const explicit = requested
    .filter(platform => platform !== 'all')
    .filter(platform => allowed.has(platform))
    .filter((platform, index, all) => all.indexOf(platform) === index);
  if (requested.includes('all')) {
    const merged = [...allowed, ...explicit]
      .map(normalizeSocialPlatformId)
      .filter(platform => platform && platform !== 'all');
    return [...new Set(merged)];
  }
  return explicit;
}

export function resolveSocialHermesMetricoolPlatformsFromConfig(platform, socialConfigs = {}) {
  const requested = Array.isArray(platform) ? platform : [platform];
  const explicitPlatforms = requested
    .map(value => ({ raw: normalizeSocialPlatformToken(value), id: normalizeSocialPlatformId(value) }))
    .filter(({ raw, id }) => id && id !== 'all' && !SOCIAL_CONNECTOR_NAMES.has(raw) && !SOCIAL_CONNECTOR_NAMES.has(id))
    .map(({ id }) => id);
  if (explicitPlatforms.length) return [...new Set(explicitPlatforms)];
  return resolveSocialHermesConfiguredPlatforms(socialConfigs);
}

export function resolveSocialHermesPublishRoute(platform, socialConfigs = {}, options = {}) {
  const id = normalizeSocialPlatformId(platform);
  if (!id || id === 'all') return { configured: false, route: '', reason: 'A single concrete platform is required.' };
  const capability = socialPlatformCapability(id, socialConfigs || {}, { makeWebhookUrl: options.makeWebhookUrl || '' });
  return {
    configured: capability.publish_capable === true,
    route: capability.publish_route || '',
    reason: capability.publish_capable ? '' : capability.blocker_reason,
    blocker_code: capability.blocker_code || null,
    plan_capable: capability.plan_capable === true,
    publish_capable: capability.publish_capable === true,
  };
}

export function normalizeSocialHermesPlatformCaptionVariants(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const platform = normalizeSocialPlatformId(item.platform || item.network || item.channel || '');
      const caption = String(item.caption || item.text || '').trim();
      if (!platform || platform === 'all' || !caption) return null;
      if (seen.has(platform)) return null;
      seen.add(platform);
      return {
        platform,
        caption: caption.slice(0, 2200),
        readiness: String(item.readiness || '').slice(0, 80),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

export function captionForSocialHermesPlatform(record = {}, platform = '') {
  const target = normalizeSocialPlatformId(platform);
  const variants = normalizeSocialHermesPlatformCaptionVariants(record.platform_caption_variants);
  return variants.find(variant => variant.platform === target)?.caption || record.caption || '';
}
