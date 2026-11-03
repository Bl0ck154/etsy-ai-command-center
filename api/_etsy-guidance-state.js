import { createEtsyGuidanceRepository } from './etsy-guidance/guidance-repository.js';

const SHOP_ID = process.env.ETSY_SHOP_ID || 'default';

function getKvCreds() {
  const url = (process.env.KV_REST_API_URL || '').replace(/^["']|["']$/g, '');
  const token = (process.env.KV_REST_API_TOKEN || '').replace(/^["']|["']$/g, '');
  return { url, token };
}

async function callKv(command, ...args) {
  const { url, token } = getKvCreds();
  if (!url || !token) {
    throw new Error('KV_REST_API_URL or KV_REST_API_TOKEN not configured. Add an Upstash-compatible Redis REST endpoint to the runtime environment.');
  }
  const response = await fetch(`${url}/${[command, ...args].join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export const etsyGuidanceRepository = createEtsyGuidanceRepository({
  callKv,
  shopId: SHOP_ID,
});
