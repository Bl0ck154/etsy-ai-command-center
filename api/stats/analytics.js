export function receiptDay(receipt) {
  return new Date((receipt.create_timestamp || receipt.created_timestamp) * 1000)
    .toISOString()
    .slice(0, 10);
}

export function transactionRevenue(transaction) {
  return ((transaction.price?.amount || 0) / (transaction.price?.divisor || 100))
    * (Number(transaction.quantity) || 1);
}

export function summarizeRevenue(receipts = [], isCurrentPaidReceipt) {
  const currentReceipts = receipts.filter(isCurrentPaidReceipt);
  const transactions = currentReceipts.flatMap(receipt => receipt.transactions || []);
  const byDay = {};
  for (const receipt of currentReceipts) {
    const amount = (receipt.transactions || []).reduce(
      (sum, transaction) => sum + transactionRevenue(transaction),
      0,
    );
    const day = receiptDay(receipt);
    byDay[day] = (byDay[day] || 0) + amount;
  }
  return {
    by_day: byDay,
    total: Object.values(byDay).reduce((sum, value) => sum + value, 0),
    transactions,
  };
}

export function projectListingStats(listings = []) {
  return {
    listings: listings.map(listing => ({
      listing_id: listing.listing_id,
      title: listing.title,
      views: listing.views || 0,
      num_favorers: listing.num_favorers || 0,
      price: listing.price,
      listing_type: listing.listing_type,
      state: listing.state,
      daily_views: listing.daily_views || null,
    })),
    total_views: listings.reduce((sum, listing) => sum + (listing.views || 0), 0),
  };
}

export function summarizeOrders(receipts = [], isCurrentPaidReceipt) {
  const currentReceipts = receipts.filter(isCurrentPaidReceipt);
  const byDay = {};
  let totalRevenue = 0;
  for (const receipt of currentReceipts) {
    const amount = (receipt.grandtotal?.amount || 0) / (receipt.grandtotal?.divisor || 100);
    const day = receiptDay(receipt);
    byDay[day] = (byDay[day] || 0) + amount;
    totalRevenue += amount;
  }
  return {
    total_orders: currentReceipts.length,
    total_revenue: totalRevenue,
    revenue_by_day: byDay,
    avg_order_value: currentReceipts.length ? totalRevenue / currentReceipts.length : 0,
  };
}
