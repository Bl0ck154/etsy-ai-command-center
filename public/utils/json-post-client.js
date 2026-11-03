export async function postJson(url, body, { fetchImpl = fetch, headers = {} } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return response.json();
}
