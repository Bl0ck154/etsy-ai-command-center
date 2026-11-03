import { expect, test } from '@playwright/test';
import { mergeEtsyTokenSettings, tokenStateChangedError } from '../api/_etsy-token-state.js';
import { createEtsyRevisionedStateRepository } from '../api/modules/etsy/index.js';

function createMemoryKv() {
  const values = new Map();
  const callKv = async (command, ...args) => {
    if (command === 'GET') return values.get(decodeURIComponent(args[0])) ?? null;
    if (command === 'EVAL') {
      const key = decodeURIComponent(args[2]);
      const expected = decodeURIComponent(args[3]);
      const replacement = decodeURIComponent(args[4]);
      const current = values.get(key);
      const missing = expected === '__revisioned_json_missing__';
      if (missing ? current !== undefined : current !== expected) return 0;
      values.set(key, replacement);
      return 1;
    }
    throw new Error(`Unexpected fake KV command: ${command}`);
  };
  return { callKv, values };
}

test('Settings merge preserves omitted token values and clears stale error state', () => {
  const next = mergeEtsyTokenSettings({
    access_token: 'access-old',
    refresh_token: 'refresh-old',
    expires_at: 1,
    last_error: 'old error',
    last_failed_access_token: 'failed-old',
    invalid_refresh_token: 'invalid-old',
  }, {
    access_token: '',
    refresh_token: 'refresh-new',
    expires_in: 120,
  }, () => 1_000);

  expect(next).toEqual({
    access_token: 'access-old',
    refresh_token: 'refresh-new',
    expires_at: 121_000,
    last_error: '',
    last_failed_access_token: '',
    invalid_refresh_token: '',
  });
});

test('Settings merge preserves the existing minimum expiry behavior', () => {
  const next = mergeEtsyTokenSettings({}, { expires_in: 1 }, () => 5_000);
  expect(next.expires_at).toBe(65_000);
});

test('stale completion error is explicit and retryable by caller', () => {
  const error = tokenStateChangedError('refresh');
  expect(error.code).toBe('ETSY_TOKEN_STATE_CHANGED');
  expect(error.status).toBe(409);
  expect(error.message).toContain('refresh');
});

test('a Settings save wins over an OAuth completion derived from a stale revision', async () => {
  const kv = createMemoryKv();
  const authOwner = createEtsyRevisionedStateRepository({ callKv: kv.callKv, key: 'shop:etsy_oauth_tokens' });
  const settingsOwner = createEtsyRevisionedStateRepository({ callKv: kv.callKv, key: 'shop:etsy_oauth_tokens' });
  const beforeExternalRequest = await authOwner.readSnapshot();

  await settingsOwner.update(current => mergeEtsyTokenSettings(current, {
    access_token: 'settings-access',
    refresh_token: 'settings-refresh',
    expires_in: 7200,
  }, () => 10_000));

  await expect(authOwner.compareAndReplace(beforeExternalRequest.revision, {
    access_token: 'stale-oauth-access',
    refresh_token: 'stale-oauth-refresh',
    expires_at: 20_000,
    last_error: '',
    last_failed_access_token: '',
    invalid_refresh_token: '',
  })).rejects.toMatchObject({ code: 'REVISIONED_JSON_REVISION_CONFLICT' });

  await expect(authOwner.read()).resolves.toMatchObject({
    access_token: 'settings-access',
    refresh_token: 'settings-refresh',
  });
});
