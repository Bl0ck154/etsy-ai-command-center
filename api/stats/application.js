import {
  projectListingStats,
  summarizeOrders,
  summarizeRevenue,
} from './analytics.js';

export function createStatsApplication({
  etsyFetch,
  shopId,
  isCurrentPaidReceipt,
  now = Date.now,
} = {}) {
  if (typeof etsyFetch !== 'function') throw new TypeError('etsyFetch dependency is required');
  if (typeof isCurrentPaidReceipt !== 'function') throw new TypeError('isCurrentPaidReceipt dependency is required');
  const currentShopId = String(shopId || '').trim();
  if (!currentShopId) throw new TypeError('shopId is required');

  const minCreatedForDays = days => Math.floor(
    (Number(typeof now === 'function' ? now() : now) - parseInt(days) * 86400000) / 1000,
  );

  async function getShopStats({ days = '30', granularity = 'day' } = {}) {
    return etsyFetch(`/shops/${currentShopId}/stats?unit=${granularity}&limit=${days}`);
  }

  async function getRevenue({ days = '30' } = {}) {
    const minDate = minCreatedForDays(days);
    const data = await etsyFetch(
      `/shops/${currentShopId}/receipts?limit=100&min_created=${minDate}&was_paid=true&includes=transactions`,
    );
    return summarizeRevenue(data?.results || [], isCurrentPaidReceipt);
  }

  async function getListingStats() {
    const data = await etsyFetch(
      `/shops/${currentShopId}/listings?state=active&limit=100&sort_on=updated&sort_order=desc`,
    );
    return projectListingStats(data?.results || []);
  }

  async function getOrderStats({ days = '30' } = {}) {
    const minDate = minCreatedForDays(days);
    const data = await etsyFetch(
      `/shops/${currentShopId}/receipts?limit=100&sort_on=created&sort_order=desc&min_created=${minDate}`,
    );
    return summarizeOrders(data?.results || [], isCurrentPaidReceipt);
  }

  return {
    getShopStats,
    getRevenue,
    getListingStats,
    getOrderStats,
  };
}
