// api/stats.js — Etsy Stats API

import { requireAuth } from './_auth.js';
import { sendPublicError } from './_errors.js';
import { etsyFetch, getShopId } from './_etsy.js';
import { isCurrentPaidReceipt } from '../public/utils/receipt-lifecycle.js';
import { createStatsApplication } from './stats/application.js';

const statsApplication = createStatsApplication({
  etsyFetch,
  shopId: getShopId(),
  isCurrentPaidReceipt,
});

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const { action, days = '30', granularity = 'day' } = req.query;

  try {
    let result;
    switch (action) {
      case 'getShopStats':
        result = await statsApplication.getShopStats({ days, granularity });
        break;
      case 'getRevenue':
        result = await statsApplication.getRevenue({ days });
        break;
      case 'getListingStats':
        result = await statsApplication.getListingStats();
        break;
      case 'getOrderStats':
        result = await statsApplication.getOrderStats({ days });
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[stats.js]', err.message);
    return sendPublicError(res, err);
  }
}
