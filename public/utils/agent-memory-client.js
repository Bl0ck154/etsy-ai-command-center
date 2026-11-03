import { classifyAgentMemoryReplacement } from './agent-memory-diff.js';

function cloneItems(value) {
  return Array.isArray(value)
    ? value.map(item => (item && typeof item === 'object' ? { ...item } : item))
    : [];
}

export function createAgentMemoryClient({ get, post } = {}) {
  if (typeof get !== 'function') throw new TypeError('get dependency is required');
  if (typeof post !== 'function') throw new TypeError('post dependency is required');

  let clientSnapshot = null;

  async function load() {
    const items = await get('/api/kv', { action: 'getAgentMemory' });
    clientSnapshot = cloneItems(items);
    return items;
  }

  async function replace(value) {
    const next = cloneItems(value);
    const change = classifyAgentMemoryReplacement(clientSnapshot, next);

    if (change.kind === 'append') {
      await post('/api/kv', { action: 'appendAgentMemory', value: change.item });
      clientSnapshot = next;
      return { success: true };
    }

    if (change.kind === 'delete') {
      await post('/api/kv', { action: 'deleteAgentMemory', value: { id: change.id } });
      clientSnapshot = next;
      return { success: true };
    }

    const result = await post('/api/kv', { action: 'setAgentMemory', value: next });
    clientSnapshot = next;
    return result;
  }

  async function append(value) {
    const result = await post('/api/kv', { action: 'appendAgentMemory', value });
    if (clientSnapshot) clientSnapshot = [value, ...clientSnapshot];
    return result;
  }

  async function remove(id) {
    const normalizedId = String(id || '').trim();
    const result = await post('/api/kv', { action: 'deleteAgentMemory', value: { id: normalizedId } });
    if (clientSnapshot) clientSnapshot = clientSnapshot.filter(item => String(item?.id || '') !== normalizedId);
    return result;
  }

  return Object.freeze({ load, replace, append, remove });
}
