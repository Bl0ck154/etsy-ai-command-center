function moneyAmount(money) {
  if (!money || money.amount == null) return null;
  const amount = Number(money.amount);
  const divisor = Number(money.divisor) || 100;
  return Number.isFinite(amount) ? amount / divisor : null;
}

function successfulRefundTotal(receipt) {
  return (Array.isArray(receipt?.refunds) ? receipt.refunds : [])
    .filter(refund => !refund?.status || String(refund.status).toUpperCase() === 'SUCCESS')
    .reduce((total, refund) => total + (moneyAmount(refund?.amount) || 0), 0);
}

export function receiptLifecycle(receipt = {}) {
  const rawStatus = String(receipt.status || '').trim();
  const normalizedStatus = rawStatus.toLowerCase();
  const orderTotal = moneyAmount(receipt.grandtotal || receipt.grand_total);
  const refundedTotal = successfulRefundTotal(receipt);
  const canceled = receipt.is_canceled === true
    || receipt.is_cancelled === true
    || /cancel/.test(normalizedStatus);
  const fullyRefunded = receipt.is_refunded === true
    || receipt.was_refunded === true
    || /refund/.test(normalizedStatus)
    || (orderTotal != null && orderTotal > 0 && refundedTotal + 0.00001 >= orderTotal);
  const partiallyRefunded = !fullyRefunded && refundedTotal > 0;

  if (canceled) {
    return { key: 'canceled', label: 'Canceled', badgeClass: 'badge-red', isOpen: false, canShip: false, refundedTotal, fullyRefunded, partiallyRefunded };
  }
  if (fullyRefunded) {
    return { key: 'refunded', label: 'Refunded', badgeClass: 'badge-gray', isOpen: false, canShip: false, refundedTotal, fullyRefunded, partiallyRefunded: false };
  }
  if (receipt.is_shipped === true) {
    return { key: 'shipped', label: 'Shipped', badgeClass: 'badge-blue', isOpen: false, canShip: false, refundedTotal, fullyRefunded: false, partiallyRefunded };
  }
  if (/completed/.test(normalizedStatus)) {
    return { key: 'completed', label: 'Completed', badgeClass: 'badge-gray', isOpen: false, canShip: false, refundedTotal, fullyRefunded: false, partiallyRefunded };
  }
  if (receipt.is_paid === true) {
    return { key: 'paid', label: partiallyRefunded ? 'Paid - partial refund' : 'Paid', badgeClass: 'badge-orange', isOpen: true, canShip: true, refundedTotal, fullyRefunded: false, partiallyRefunded };
  }
  return { key: 'pending', label: rawStatus || 'Pending', badgeClass: 'badge-gray', isOpen: true, canShip: false, refundedTotal, fullyRefunded: false, partiallyRefunded };
}

export function isCurrentPaidReceipt(receipt) {
  const lifecycle = receiptLifecycle(receipt);
  return receipt?.is_paid === true && lifecycle.key !== 'canceled' && lifecycle.key !== 'refunded';
}

export function isActionableOpenReceipt(receipt) {
  return receiptLifecycle(receipt).key === 'paid';
}
