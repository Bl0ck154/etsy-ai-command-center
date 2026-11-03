export async function kvPost(action, value, extra = {}) {
  const res = await fetch('/api/kv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, value, ...extra }),
  });
  if (res.status === 503) throw Object.assign(new Error('kv_unavailable'), { kvUnavailable: true });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'KV error');
  return data.data;
}

export async function kvGet(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`/api/kv?${qs}`);
  if (res.status === 503) throw Object.assign(new Error('kv_unavailable'), { kvUnavailable: true });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'KV error');
  return data.data;
}
