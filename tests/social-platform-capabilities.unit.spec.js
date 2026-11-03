import { expect, test } from '@playwright/test';
import {
  resolveSocialPlatformCapabilities,
  socialAspectRatioFitsPlatform,
  socialPlatformCapability,
  socialPlatformMediaContracts,
} from '../api/_social-platform-capabilities.js';
import {
  resolveFacebookDirectPublishConfig,
  resolveInstagramDirectPublishConfig,
  resolveSchedulerConfiguredPlatforms,
  resolveSchedulerMetricoolPlatformsForTest,
  resolveSchedulerPublishCapablePlatforms,
} from '../api/_scheduler.js';
import {
  normalizeSocialHermesPlatformCaptionVariants,
  normalizeSocialHermesPlatformId,
  resolveSocialHermesConfiguredPlatforms,
  resolveSocialHermesMetricoolPlatformsFromConfig,
  resolveSocialHermesPublishCapablePlatforms,
  resolveSocialHermesPublishRoute,
  resolveSocialHermesRequestedPlatforms,
  socialHermesUiPlatformCapabilityContext,
  summarizeSocialHermesSocialConfigs,
} from '../api/modules/social/index.js';
import {
  resolveSocialHermesPublishCapablePlatforms as resolvePublishCapableFromFacade,
  resolveSocialHermesMetricoolPlatformsForTest as resolveMetricoolPlatformsFromFacade,
  resolveSocialHermesPublishRouteForTest as resolvePublishRouteFromFacade,
  resolveSocialHermesRequestedPlatformsForTest as resolveRequestedFromFacade,
  socialHermesUiPlatformCapabilityContext as uiCapabilityContextFromFacade,
  summarizeSocialHermesSocialConfigs as summarizeConfigsFromFacade,
} from '../api/social.js';

const ENV_KEYS = [
  'INSTAGRAM_ACCESS_TOKEN',
  'INSTAGRAM_USER_ID',
  'FACEBOOK_PAGE_TOKEN',
  'FACEBOOK_PAGE_ID',
  'MAKE_WEBHOOK_URL',
  'MAKE_CALLBACK_SECRET',
  'BUFFER_ACCESS_TOKEN',
  'BUFFER_PROFILE_IDS',
  'METRICOOL_API_KEY',
  'METRICOOL_BRAND_ID',
];

function emptyCapabilityEnv(overrides = {}) {
  return Object.fromEntries([
    ...ENV_KEYS.map(key => [key, '']),
    ...Object.entries(overrides),
  ]);
}

test.describe('Social platform capability registry', () => {
  let originalEnv;

  test.beforeEach(() => {
    originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  test.afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  test('Pinterest may be planned from UI intent but cannot publish without a real Make callback route', () => {
    const noMake = socialPlatformCapability('pinterest', {
      pinterest_config: { board_id: 'board-intent-only' },
    }, { env: emptyCapabilityEnv() });
    expect(noMake).toMatchObject({
      plan_capable: true,
      publish_capable: false,
      publish_route: null,
      blocker_code: 'MAKE_PINTEREST_WEBHOOK_MISSING',
    });

    const webhookWithoutCallback = socialPlatformCapability('pinterest', {
      make_config: { webhook_url: 'https://hook.example.test/pinterest' },
    }, { env: emptyCapabilityEnv() });
    expect(webhookWithoutCallback).toMatchObject({
      plan_capable: true,
      publish_capable: false,
      blocker_code: 'MAKE_CALLBACK_SECRET_MISSING',
    });

    const ready = socialPlatformCapability('pinterest', {
      make_config: { webhook_url: 'https://hook.example.test/pinterest' },
    }, { env: emptyCapabilityEnv({ MAKE_CALLBACK_SECRET: 'attempt-bound-secret' }) });
    expect(ready).toMatchObject({
      plan_capable: true,
      publish_capable: true,
      publish_route: 'make_pinterest_bridge',
    });
  });

  test('feed media contracts keep Pinterest-first tall frames out of Instagram carousels', () => {
    const contracts = socialPlatformMediaContracts(['instagram', 'pinterest']);

    expect(contracts.instagram).toMatchObject({
      surface: 'feed_or_carousel',
      preferred_aspect_ratios: ['4:5', '1:1'],
    });
    expect(contracts.pinterest).toMatchObject({
      surface: 'standard_pin',
      preferred_aspect_ratios: ['2:3'],
      max_media_items: 1,
    });
    expect(socialAspectRatioFitsPlatform('instagram', '2:3')).toBe(false);
    expect(socialAspectRatioFitsPlatform('instagram', '4:5')).toBe(true);
    expect(socialAspectRatioFitsPlatform('pinterest', '2:3')).toBe(true);
  });

  test('TikTok requires a complete Buffer or Metricool publisher route', () => {
    const intentOnly = socialPlatformCapability('tiktok', {
      tiktok_config: { account_name: 'shop-channel' },
    }, { env: emptyCapabilityEnv() });
    expect(intentOnly).toMatchObject({
      plan_capable: true,
      publish_capable: false,
      blocker_code: 'TIKTOK_PUBLISHER_MISSING',
    });

    const incompleteBuffer = socialPlatformCapability('tiktok', {}, {
      env: emptyCapabilityEnv({ BUFFER_ACCESS_TOKEN: 'buffer-token' }),
    });
    expect(incompleteBuffer.publish_capable).toBe(false);

    const bufferReady = socialPlatformCapability('tiktok', {}, {
      env: emptyCapabilityEnv({ BUFFER_ACCESS_TOKEN: 'buffer-token', BUFFER_PROFILE_IDS: 'tiktok-profile' }),
    });
    expect(bufferReady).toMatchObject({ publish_capable: true, publish_route: 'buffer_tiktok' });

    const metricoolReady = socialPlatformCapability('tiktok', {}, {
      env: emptyCapabilityEnv({ METRICOOL_API_KEY: 'metricool-key', METRICOOL_BRAND_ID: 'brand-id' }),
    });
    expect(metricoolReady).toMatchObject({ publish_capable: true, publish_route: 'metricool_tiktok' });
  });

  test('Meta channels publish only when both direct credentials are present', () => {
    const registry = resolveSocialPlatformCapabilities({
      ig_config: { token: 'ig-token-only' },
      fb_posts_config: { page_id: 'facebook-page-only' },
    }, { env: emptyCapabilityEnv() });
    expect(registry.by_platform.instagram).toMatchObject({
      plan_capable: true,
      publish_capable: false,
      blocker_code: 'INSTAGRAM_DIRECT_CREDENTIALS_INCOMPLETE',
    });
    expect(registry.by_platform.facebook).toMatchObject({
      plan_capable: true,
      publish_capable: false,
      blocker_code: 'FACEBOOK_DIRECT_CREDENTIALS_INCOMPLETE',
    });

    const complete = resolveSocialPlatformCapabilities({
      ig_config: { token: 'ig-token', user_id: 'ig-business-id' },
      fb_posts_config: { page_token: 'facebook-token', page_id: 'facebook-page-id' },
    }, { env: emptyCapabilityEnv() });
    expect(complete.by_platform.instagram).toMatchObject({ publish_capable: true, publish_route: 'instagram_direct' });
    expect(complete.by_platform.facebook).toMatchObject({ publish_capable: true, publish_route: 'facebook_direct' });
  });

  test('planner, readiness and scheduler resolve the same publish-capable set', () => {
    process.env.MAKE_CALLBACK_SECRET = 'callback-secret';
    process.env.BUFFER_ACCESS_TOKEN = 'buffer-token';
    process.env.BUFFER_PROFILE_IDS = 'tiktok-profile';
    const configs = {
      ig_config: { token: 'ig-token', user_id: 'ig-business-id' },
      fb_posts_config: { page_token: 'facebook-token', page_id: 'facebook-page-id' },
      make_config: { webhook_url: 'https://hook.example.test/pinterest' },
      tiktok_config: { account_name: 'shop-channel' },
    };
    const registry = resolveSocialPlatformCapabilities(configs);
    const expected = ['facebook', 'instagram', 'pinterest', 'tiktok'];

    expect(registry.publish_capable_platforms).toEqual(expected);
    expect(resolveSocialHermesPublishCapablePlatforms(configs)).toEqual(expected);
    expect(resolveSchedulerPublishCapablePlatforms(configs)).toEqual(expected);
    for (const platform of expected) {
      expect(resolveSocialHermesPublishRoute(platform, configs).publish_capable).toBe(true);
    }
  });

  test('readiness rejects an explicitly requested platform that has planning intent but no publish route', () => {
    const configs = { pinterest_config: { board_id: 'intent-only-board' } };
    expect(resolveSocialHermesPublishCapablePlatforms(configs)).toEqual([]);
    expect(resolveSchedulerPublishCapablePlatforms(configs)).toEqual([]);
    expect(resolveSocialHermesRequestedPlatforms(['pinterest'], [])).toEqual([]);
    expect(resolveSocialHermesPublishRoute('pinterest', configs)).toMatchObject({
      configured: false,
      plan_capable: true,
      publish_capable: false,
      blocker_code: 'MAKE_PINTEREST_WEBHOOK_MISSING',
    });
  });

  test('legacy UI connection flags use the same publish-capability contract', () => {
    const incompletePinterestSummary = summarizeSocialHermesSocialConfigs({
      make_config: { webhook_url: 'https://hook.example.test/pinterest' },
    });
    expect(socialHermesUiPlatformCapabilityContext(incompletePinterestSummary)).toMatchObject({
      hasMake: true,
      hasPinterest: false,
    });

    process.env.MAKE_CALLBACK_SECRET = 'callback-secret';
    const summary = summarizeSocialHermesSocialConfigs({
      ig_config: { token: 'ig-token', user_id: 'ig-business-id' },
      fb_posts_config: { page_id: 'facebook-page-without-token' },
      make_config: { webhook_url: 'https://hook.example.test/pinterest' },
    });

    expect(socialHermesUiPlatformCapabilityContext(summary)).toEqual({
      hasMake: true,
      hasInstagram: true,
      hasFacebook: false,
      hasPinterest: true,
    });
    expect(summary.publish_capable_platforms).toEqual(['instagram', 'pinterest']);
  });

  test('normalizes requested platform aliases, deduplicates them, and expands all in configured order', () => {
    expect(resolveSocialHermesRequestedPlatforms(
      ['IG', 'facebook_posts', 'instagram', 'unknown'],
      ['instagram', 'facebook'],
    )).toEqual(['instagram', 'facebook']);
    expect(resolveSocialHermesRequestedPlatforms(
      ['all', 'IG'],
      ['pinterest', 'facebook', 'instagram'],
    )).toEqual(['pinterest', 'facebook', 'instagram']);
    expect(normalizeSocialHermesPlatformId(' Make.com ')).toBe('pinterest');
  });

  test('normalizes platform caption inputs without inventing duplicate or all-platform variants', () => {
    const longCaption = `  ${'x'.repeat(2300)}  `;
    const variants = normalizeSocialHermesPlatformCaptionVariants([
      { network: 'IG', text: '  First Instagram caption  ', readiness: 'media_ready' },
      { platform: 'instagram', caption: 'duplicate must be ignored' },
      { channel: 'facebook_posts', caption: longCaption, readiness: 'r'.repeat(100) },
      { platform: 'all', caption: 'invalid aggregate caption' },
      { platform: 'pinterest', caption: '   ' },
    ]);

    expect(variants).toEqual([
      { platform: 'instagram', caption: 'First Instagram caption', readiness: 'media_ready' },
      { platform: 'facebook', caption: 'x'.repeat(2200), readiness: 'r'.repeat(80) },
    ]);
  });

  test('resolves Metricool platform inputs without treating connector names as channels', () => {
    const configs = {
      bluesky_config: { handle: 'shop.example', app_password: 'secret' },
      fb_posts_config: { page_id: 'page-intent' },
    };
    expect(resolveSocialHermesMetricoolPlatformsFromConfig(['FB', 'facebook', 'metricool'], configs))
      .toEqual(['facebook']);
    expect(resolveSocialHermesMetricoolPlatformsFromConfig('metricool', configs))
      .toEqual(['bluesky', 'facebook']);
  });

  test('public module summaries remain credential-safe and the legacy facade stays compatible', () => {
    process.env.MAKE_CALLBACK_SECRET = 'callback-secret';
    const configs = {
      ig_config: { token: 'never-return-this-token', user_id: 'ig-business-id' },
      make_config: { webhook_url: 'https://hook.example.test/pinterest?credential=never-return-this-query' },
    };
    const summary = summarizeSocialHermesSocialConfigs(configs);
    expect(JSON.stringify(summary)).not.toContain('never-return-this-token');
    expect(JSON.stringify(summary)).not.toContain('never-return-this-query');

    expect(summarizeConfigsFromFacade(configs)).toEqual(summary);
    expect(resolvePublishCapableFromFacade(configs)).toEqual(resolveSocialHermesPublishCapablePlatforms(configs));
    expect(uiCapabilityContextFromFacade(summary)).toEqual(socialHermesUiPlatformCapabilityContext(summary));
    expect(resolveRequestedFromFacade(['IG'], ['instagram'])).toEqual(resolveSocialHermesRequestedPlatforms(['IG'], ['instagram']));
    expect(resolvePublishRouteFromFacade('instagram', configs)).toEqual(resolveSocialHermesPublishRoute('instagram', configs));
  });
});

test.describe('Social Hermes configured platform resolution', () => {
  let originalMakeWebhookUrl;
  const configs = {
    ig_config: { token: 'ig-secret-token', user_id: 'ig_1' },
    fb_posts_config: { page_id: 'page_1', token: 'fb-secret-token' },
    make_config: { webhook_url: 'https://hook.example.test/pinterest?credential=hide-me' },
    buffer_config: { access_token: 'buffer-credential', platforms: ['mastodon'] },
    bluesky_config: { handle: 'shop.example', app_password: 'credential' },
    tiktok_config: { invalid: true, last_error: 'expired token only' },
  };
  const expectedPlatforms = [
    'bluesky',
    'facebook',
    'instagram',
    'mastodon',
    'pinterest',
  ];

  test.beforeEach(() => {
    originalMakeWebhookUrl = process.env.MAKE_WEBHOOK_URL;
    delete process.env.MAKE_WEBHOOK_URL;
  });

  test.afterEach(() => {
    if (originalMakeWebhookUrl === undefined) delete process.env.MAKE_WEBHOOK_URL;
    else process.env.MAKE_WEBHOOK_URL = originalMakeWebhookUrl;
  });

  test('resolves all-platform target dynamically from UI social configs without leaking connector credentials', () => {
    const summary = summarizeSocialHermesSocialConfigs(configs);

    expect(resolveSocialHermesConfiguredPlatforms(configs)).toEqual(expectedPlatforms);
    expect(resolveSchedulerConfiguredPlatforms(configs)).toEqual(expectedPlatforms);
    expect(resolveInstagramDirectPublishConfig(configs)).toMatchObject({ configured: true, userId: 'ig_1', source: 'kv' });
    expect(resolveFacebookDirectPublishConfig(configs)).toMatchObject({ configured: true, pageId: 'page_1', source: 'kv' });
    expect(summary).toMatchObject({
      has_make: true,
      has_buffer_config: true,
      configured_platform_count: 5,
      all_platform_target: ['bluesky', 'facebook', 'instagram', 'mastodon', 'pinterest'],
      connector_states: {
        make: { configured: true, target_platforms: ['pinterest'], route: 'pinterest_bridge' },
        buffer: { configured: true, target_platforms: ['mastodon'], route: 'external_queue' },
        metricool: { configured: false, target_platforms: [], route: 'external_queue' },
        zapier: { configured: false, target_platforms: [], route: 'external_queue' },
        meta_direct: { instagram_configured: true, facebook_configured: true, target_platforms: ['facebook', 'instagram'] },
      },
    });
    expect(summary.platform_routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'pinterest', source_keys: ['make_config'], routes: ['make'] }),
      expect.objectContaining({ platform: 'mastodon', source_keys: ['buffer_config'], routes: ['declared'] }),
      expect.objectContaining({ platform: 'bluesky', source_keys: ['bluesky_config'], routes: ['configured'] }),
    ]));
    expect(JSON.stringify(summary)).not.toContain('secret');
    expect(JSON.stringify(summary)).not.toContain('token');
  });

  test('Metricool all-platform target follows UI configured platforms instead of hard-coded defaults', async () => {
    await expect(resolveMetricoolPlatformsFromFacade(undefined, configs)).resolves.toEqual(expectedPlatforms);
    await expect(resolveMetricoolPlatformsFromFacade('all', configs)).resolves.toEqual(expectedPlatforms);
    await expect(resolveMetricoolPlatformsFromFacade(['instagram', 'all', 'fb'], configs)).resolves.toEqual(['instagram', 'facebook']);
    await expect(resolveMetricoolPlatformsFromFacade(['metricool', 'all'], configs)).resolves.toEqual(expectedPlatforms);
    await expect(resolveMetricoolPlatformsFromFacade(['make', 'all'], configs)).resolves.toEqual(expectedPlatforms);
    await expect(resolveMetricoolPlatformsFromFacade('all', {})).resolves.toEqual([]);
    expect(resolveSchedulerMetricoolPlatformsForTest(undefined, configs)).toEqual(expectedPlatforms);
    expect(resolveSchedulerMetricoolPlatformsForTest('all', configs)).toEqual(expectedPlatforms);
    expect(resolveSchedulerMetricoolPlatformsForTest(['instagram', 'all', 'fb'], configs)).toEqual(['instagram', 'facebook']);
    expect(resolveSchedulerMetricoolPlatformsForTest(['metricool', 'all'], configs)).toEqual(expectedPlatforms);
    expect(resolveSchedulerMetricoolPlatformsForTest(['make', 'all'], configs)).toEqual(expectedPlatforms);
    expect(resolveSchedulerMetricoolPlatformsForTest('fb', configs)).toEqual(['facebook']);
    expect(resolveSchedulerMetricoolPlatformsForTest('all', {})).toEqual([]);
  });

  test('resolves Pinterest from Make runtime env without exposing the webhook', () => {
    process.env.MAKE_WEBHOOK_URL = 'https://hook.example.test/runtime-pinterest?credential=hide-me';

    const summary = summarizeSocialHermesSocialConfigs({
      ig_config: { token: 'ig-secret-token', user_id: 'ig_1' },
      fb_posts_config: { page_id: 'page_1', token: 'fb-secret-token' },
    });

    expect(resolveSocialHermesConfiguredPlatforms({})).toEqual(['pinterest']);
    expect(summary).toMatchObject({
      has_make: true,
      configured_platforms: ['facebook', 'instagram', 'pinterest'],
      all_platform_target: ['facebook', 'instagram', 'pinterest'],
      connector_states: {
        make: { configured: true, target_platforms: ['pinterest'], route: 'pinterest_bridge' },
      },
    });
    expect(summary.platform_routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'pinterest', source_keys: ['make_env'], routes: ['env'] }),
    ]));
    expect(JSON.stringify(summary)).not.toContain('hook.example.test');
    expect(JSON.stringify(summary)).not.toContain('runtime-pinterest');
    expect(JSON.stringify(summary)).not.toContain('hide-me');
  });
});
