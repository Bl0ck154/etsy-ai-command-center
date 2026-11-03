function memoryIdentity(item = {}) {
  const id = String(item?.id || '').trim();
  if (id) return `id:${id}`;
  const text = String(item?.text || '').trim().toLowerCase();
  return text ? `text:${text}` : '';
}

function memoryItemEquivalent(a = {}, b = {}) {
  return String(a?.id || '') === String(b?.id || '')
    && String(a?.text || '') === String(b?.text || '')
    && String(a?.category || '') === String(b?.category || '')
    && Number(a?.createdAt || 0) === Number(b?.createdAt || 0);
}

export function classifyAgentMemoryReplacement(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return { kind: 'replace' };

  const previousByIdentity = new Map();
  for (const item of previous) {
    const identity = memoryIdentity(item);
    if (identity) previousByIdentity.set(identity, item);
  }
  const nextByIdentity = new Map();
  for (const item of next) {
    const identity = memoryIdentity(item);
    if (identity) nextByIdentity.set(identity, item);
  }

  const added = [...nextByIdentity.entries()]
    .filter(([identity]) => !previousByIdentity.has(identity))
    .map(([, item]) => item);
  const removed = [...previousByIdentity.entries()]
    .filter(([identity]) => !nextByIdentity.has(identity))
    .map(([, item]) => item);
  const changedExisting = [...nextByIdentity.entries()].some(([identity, item]) => {
    const previousItem = previousByIdentity.get(identity);
    return previousItem && !memoryItemEquivalent(previousItem, item);
  });

  if (!changedExisting && added.length === 1 && removed.length === 0) {
    return { kind: 'append', item: added[0] };
  }
  if (!changedExisting && removed.length === 1 && added.length === 0) {
    const id = String(removed[0]?.id || '').trim();
    if (id) return { kind: 'delete', id };
  }
  return { kind: 'replace' };
}
