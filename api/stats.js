// api/stats.js — Etsy Stats API

import { requireAuth } from './_auth.js';
import { sendPublicError } from './_errors.js';
import { etsyFetch, getShopId } from './_etsy.js';
import { isCurrentPaidReceipt } from '../public/utils/receipt-lifecycle.js';
import { createStatsApplication } from './stats/application.js';

// Construct shop-scoped analytics only when the endpoint is used.
// A fresh self-hosted installation must boot before Etsy credentials are configured.
function applicationForConfiguredShop() {
  const shopId = String(getShopId() || '').trim();
  if (!shopId) {
    const error = new Error('Configure ETSY_SHOP_ID or ETSY_SHOP_IDS to use Etsy analytics');
    error.status = 503;
    error.code = 'ETSY_SHOP_NOT_CONFIGURED';
    throw error;
  }
  return createStatsApplication({ etsyFetch, shopId, isCurrentPaidReceipt });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const { action, days = '30', granularity = 'day' } = req.query;

  try {
    let result;
    const statsApplication = applicationForConfiguredShop();
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
