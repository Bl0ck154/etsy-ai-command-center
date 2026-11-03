import { test, expect } from '@playwright/test';

const baseUrl = String(process.env.GPT_LIVE_BASE_URL || '').replace(/\/+$/, '');
const accessToken = String(process.env.GPT_LIVE_ACCESS_TOKEN || '');
const liveEnabled = Boolean(baseUrl && accessToken);

test.describe('opt-in live GPT read-only canary', () => {
  test.skip(!liveEnabled, 'Set GPT_LIVE_BASE_URL and GPT_LIVE_ACCESS_TOKEN to run read-only live checks.');

  test('status and connected Etsy profile are readable without exposing credentials', async () => {
    expect(baseUrl).toMatch(/^https:\/\//);

    const statusResponse = await fetch(`${baseUrl}/api/gpt/status`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    expect(statusResponse.status).toBe(200);
    const status = await statusResponse.json();
    expect(status.data).toMatchObject({ ok: true, integration: 'gpt-actions' });

    const profileResponse = await fetch(`${baseUrl}/api/gpt/profile`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
    expect(profileResponse.status).toBe(200);
    const profile = await profileResponse.json();
    expect(profile).toMatchObject({ success: true, operation_id: 'getEtsyUserProfile' });
    expect(JSON.stringify({ status, profile })).not.toMatch(/client_secret|access_token|refresh_token|api_key/i);
  });
});
