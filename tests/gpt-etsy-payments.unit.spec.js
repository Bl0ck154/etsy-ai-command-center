import { test, expect } from '@playwright/test';

import { resetEtsyTokenCacheForTests } from '../api/auth.js';
import { getLedgerEntryPayments, getPayments } from '../api/gpt/etsy-service.js';

function ok(data = { count: 0, results: [] }) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function captureUrl(run) {
  const previousFetch = global.fetch;
  const calls = [];
  resetEtsyTokenCacheForTests({ accessToken: 'gpt-payment-test-token' });
  global.fetch = async (url) => {
    calls.push(String(url));
    return ok();
  };
  try {
    await run();
    return calls;
  } finally {
    global.fetch = previousFetch;
    resetEtsyTokenCacheForTests();
  }
}

test('getPayments sends payment_ids as one comma-separated query parameter', async () => {
  const calls = await captureUrl(() => getPayments({
    shopId: 12345678,
    paymentIds: [111, 222, 333],
  }));

  expect(calls).toEqual([
    'https://openapi.etsy.com/v3/application/shops/12345678/payments?payment_ids=111,222,333',
  ]);
});

test('getLedgerEntryPayments follows Etsy tutorial comma-separated serialization', async () => {
  const calls = await captureUrl(() => getLedgerEntryPayments({
    shopId: 12345678,
    ledgerEntryIds: [42362821, 69507139],
  }));

  expect(calls).toEqual([
    'https://openapi.etsy.com/v3/application/shops/12345678/payment-account/ledger-entries/payments?ledger_entry_ids=42362821%2C69507139',
  ]);
  expect(new URL(calls[0]).searchParams.get('ledger_entry_ids')).toBe('42362821,69507139');
});
