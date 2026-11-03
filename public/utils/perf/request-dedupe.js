export function createRequestDeduper({ fetchImpl = fetch } = {}) {
  const pendingRequests = new Map();

  async function dedupedFetch(url, options) {
    const key = `${url}:${JSON.stringify(options)}`;
    if (pendingRequests.has(key)) return pendingRequests.get(key);
    const promise = fetchImpl(url, options).finally(() => pendingRequests.delete(key));
    pendingRequests.set(key, promise);
    return promise;
  }

  return { dedupedFetch };
}

const requestDeduper = createRequestDeduper();
export const dedupedFetch = requestDeduper.dedupedFetch;
