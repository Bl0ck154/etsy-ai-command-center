import { expect, test } from '@playwright/test';

import { etsyApiHubEnabled } from '../api/auth.js';

test('Etsy API Hub feature flag is explicit and defaults off', () => {
  expect(etsyApiHubEnabled({})).toBe(false);
  expect(etsyApiHubEnabled({ ETSY_API_HUB_ENABLED: 'true' })).toBe(true);
  expect(etsyApiHubEnabled({ ETSY_API_HUB_ENABLED: '1' })).toBe(true);
  expect(etsyApiHubEnabled({ ETSY_API_HUB_ENABLED: 'false' })).toBe(false);
});
