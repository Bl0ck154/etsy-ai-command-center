import { createRevisionedJsonRepository } from '../platform/persistence/revisioned-json-repository.js';

const MEMORY_RECORD_TYPE = 'agent_memory_store';

function normalizedUserId(userId) {
  return String(userId || 'anonymous')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80) || 'anonymous';
}

export function userAgentMemoryKey(userId) {
  return `user:${normalizedUserId(userId)}:agent_memory`;
}

export function normalizeAgentMemoryItems(value, {
  now = Date.now,
  random = Math.random,
} = {}) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const text = String(item?.text || '').trim().slice(0, 1000);
    if (!text) return null;
    const category = ['preference', 'rule', 'fact', 'context'].includes(item?.category)
      ? item.category
      : 'fact';
    return {
      id: String(item?.id || `memory_${Number(now()).toString(36)}_${Number(random()).toString(36).slice(2, 7)}`).slice(0, 100),
      text,
      category,
      createdAt: Number(item?.createdAt) || Number(now()),
    };
  }).filter(Boolean).slice(0, 50);
}

function validMemoryState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'items')) return Object.keys(value).length === 0;
  return Array.isArray(value.items);
}

function decodeLegacyArray(raw, normalizeItems) {
  if (raw === null || raw === undefined) return { found: false, items: [] };
  try {
    const parsed = JSON.parse(decodeURIComponent(String(raw)));
    if (!Array.isArray(parsed)) return { found: false, items: [] };
    return { found: true, items: normalizeItems(parsed) };
  } catch {
    return { found: false, items: [] };
  }
}

export function createAgentMemoryRepository({
  callKv,
  shopId = 'default',
  now = Date.now,
  random = Math.random,
} = {}) {
  if (typeof callKv !== 'function') throw new TypeError('callKv dependency is required');
  const repositories = new Map();
  const scope = String(shopId || 'default');
  const normalizeItems = value => normalizeAgentMemoryItems(value, { now, random });

  function legacyUserStorageKey(userId) {
    return `${scope}:${userAgentMemoryKey(userId)}`;
  }

  function stateStorageKey(userId) {
    return `${legacyUserStorageKey(userId)}:state`;
  }

  function repositoryFor(userId) {
    const key = stateStorageKey(userId);
    if (!repositories.has(key)) {
      repositories.set(key, createRevisionedJsonRepository({
        callKv,
        key,
        recordType: MEMORY_RECORD_TYPE,
        validateState: validMemoryState,
      }));
    }
    return repositories.get(key);
  }

  async function readLegacyItems(userId) {
    const perUserRaw = await callKv('GET', encodeURIComponent(legacyUserStorageKey(userId))).catch(() => null);
    const perUser = decodeLegacyArray(perUserRaw, normalizeItems);
    if (perUser.found) return perUser;

    const globalRaw = await callKv('GET', encodeURIComponent(`${scope}:agent_memory`)).catch(() => null);
    const global = decodeLegacyArray(globalRaw, normalizeItems);
    return global.found && global.items.length
      ? global
      : { found: false, items: [] };
  }

  async function ensureUserState(userId) {
    const repository = repositoryFor(userId);
    const snapshot = await repository.readSnapshot({ migrateLegacy: false });
    if (Array.isArray(snapshot.state.items)) {
      return { repository, items: normalizeItems(snapshot.state.items) };
    }

    const legacy = await readLegacyItems(userId);
    if (!legacy.found) return { repository, items: [] };

    const migrated = await repository.update(current => {
      if (Array.isArray(current.items)) return undefined;
      return { items: legacy.items };
    });
    return { repository, items: normalizeItems(migrated.state.items) };
  }

  async function load(userId) {
    const { items } = await ensureUserState(userId);
    return items;
  }

  async function save(userId, value) {
    const { repository } = await ensureUserState(userId);
    const items = normalizeItems(value);
    const saved = await repository.update(() => ({ items }));
    return normalizeItems(saved.state.items);
  }

  async function append(userId, value = {}) {
    const text = String(value.text || '').trim().slice(0, 1000);
    if (!text) throw new Error('Memory text is required');
    const { repository } = await ensureUserState(userId);
    const memory = normalizeItems([{ ...value, text }])[0];
    let duplicate = false;
    let selected = memory;

    const updated = await repository.update(state => {
      const items = normalizeItems(state.items);
      const existing = items.find(item => item.text.toLowerCase() === text.toLowerCase());
      if (existing) {
        duplicate = true;
        selected = existing;
        return undefined;
      }
      duplicate = false;
      selected = memory;
      return { items: [memory, ...items].slice(0, 50) };
    });

    return {
      memory: selected,
      items: normalizeItems(updated.state.items),
      duplicate,
    };
  }

  async function remove(userId, memoryId) {
    const id = String(memoryId || '');
    const { repository } = await ensureUserState(userId);
    let deleted = false;
    const updated = await repository.update(state => {
      const items = normalizeItems(state.items);
      const next = items.filter(item => item.id !== id);
      deleted = next.length !== items.length;
      return deleted ? { items: next } : undefined;
    });
    return { deleted, items: normalizeItems(updated.state.items), id };
  }

  return Object.freeze({
    load,
    save,
    append,
    remove,
    repositoryFor,
    legacyUserStorageKey,
    stateStorageKey,
  });
}
