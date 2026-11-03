export async function fetchAvailableShops({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/etsy?action=getAvailableShops');
  const data = await response.json();
  return data?.data || data || [];
}

export const shopSwitcherApi = Object.freeze({
  fetchAvailableShops,
});
