import { test, expect } from '@playwright/test';
import fs from 'fs';
import { isActionableOpenReceipt, isCurrentPaidReceipt, receiptLifecycle } from '../public/utils/receipt-lifecycle.js';

const money = amount => ({ amount, divisor: 100, currency_code: 'USD' });

test('canceled paid unshipped Etsy receipt is not open or shippable', () => {
  const receipt = {
    status: 'Canceled',
    is_paid: true,
    is_shipped: false,
    grandtotal: money(9350),
    refunds: [{ status: 'SUCCESS', amount: money(9350) }],
  };

  expect(receiptLifecycle(receipt)).toMatchObject({ key: 'canceled', isOpen: false, canShip: false, fullyRefunded: true });
  expect(isCurrentPaidReceipt(receipt)).toBe(false);
  expect(isActionableOpenReceipt(receipt)).toBe(false);
});

test('successful full refund closes a receipt even without canceled status', () => {
  const receipt = {
    status: 'Paid',
    is_paid: true,
    is_shipped: false,
    grandtotal: money(2500),
    refunds: [{ status: 'SUCCESS', amount: money(2500) }],
  };

  expect(receiptLifecycle(receipt)).toMatchObject({ key: 'refunded', isOpen: false, canShip: false });
  expect(isCurrentPaidReceipt(receipt)).toBe(false);
});

test('partial refund remains actionable and is labeled explicitly', () => {
  const receipt = {
    status: 'Paid',
    is_paid: true,
    is_shipped: false,
    grandtotal: money(5000),
    refunds: [{ status: 'SUCCESS', amount: money(1000) }],
  };

  expect(receiptLifecycle(receipt)).toMatchObject({ key: 'paid', isOpen: true, canShip: true, partiallyRefunded: true });
  expect(isCurrentPaidReceipt(receipt)).toBe(true);
});

test('failed refund does not close an otherwise paid order', () => {
  const receipt = {
    status: 'Paid',
    is_paid: true,
    is_shipped: false,
    grandtotal: money(2500),
    refunds: [{ status: 'FAILED', amount: money(2500) }],
  };

  expect(receiptLifecycle(receipt)).toMatchObject({ key: 'paid', isOpen: true, canShip: true });
});
