import { kvGet } from '../../../kv.js';

export function createSocialPublishConfigAdapter({
  get = kvGet,
  env = process.env,
  logger = console,
} = {}) {
  return {
    loadSocialConfigs() {
      return get('social_configs');
    },

    async loadMakeRoute(overrideUrl = '') {
      const directUrl = (overrideUrl || '').trim();
      if (directUrl) return { url: directUrl, source: 'request' };

      try {
        const configs = (await get('social_configs')) || {};
        const kvUrl = (configs.make_config?.webhook_url || configs.make_config?.url || '').trim();
        if (kvUrl) return { url: kvUrl, source: 'kv' };
      } catch (error) {
        logger?.warn?.('[social] Make config lookup failed:', error?.message);
      }

      const envUrl = String(env.MAKE_WEBHOOK_URL || '').trim();
      return envUrl ? { url: envUrl, source: 'env' } : { url: '', source: null };
    },

    autoPublishOptInEnabled() {
      return env.SOCIAL_AUTOPUBLISH_OWNER_OPT_IN === 'true';
    },

    autoPublishLeadMinutes() {
      const hours = Number(env.SOCIAL_AUTOPUBLISH_MIN_REVIEW_HOURS || 12);
      return Math.max(60, Math.min(72 * 60, Math.round((Number.isFinite(hours) ? hours : 12) * 60)));
    },
  };
}

export const socialPublishConfigAdapter = createSocialPublishConfigAdapter();
