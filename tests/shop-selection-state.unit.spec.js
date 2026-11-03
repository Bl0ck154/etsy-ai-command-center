import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { ACTIVE_SHOP_KEY, createShopSelectionState } from '../public/components/shop-selection-state.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    value: key => data.get(key),
    has: key => data.has(key),
  };
}

test('hydrate restores saved shop and persists canonical id', () => {
  const storage = memoryStorage({ [ACTIVE_SHOP_KEY]: '2' });
  const state = createShopSelectionState({ storageProvider: () => storage });
  expect(state.hydrate([{ id: '1', name: 'One' }, { id: '2', name: 'Two' }])).toMatchObject({ id: '2' });
  expect(state.getActiveShopId()).toBe('2');
  expect(storage.value(ACTIVE_SHOP_KEY)).toBe('2');
});

test('hydrate falls back to first shop and clears storage for empty list', () => {
  const storage = memoryStorage({ [ACTIVE_SHOP_KEY]: 'missing' });
  const state = createShopSelectionState({ storageProvider: () => storage });
  expect(state.hydrate([{ id: 'a' }, { id: 'b' }])).toMatchObject({ id: 'a' });
  expect(storage.value(ACTIVE_SHOP_KEY)).toBe('a');
  expect(state.hydrate([])).toBeNull();
  expect(storage.has(ACTIVE_SHOP_KEY)).toBe(false);
});

test('selection, lookup and list ownership stay in state owner', () => {
  const storage = memoryStorage();
  const state = createShopSelectionState({ storageProvider: () => storage });
  const shops = [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }];
  state.hydrate(shops);
  expect(state.findById('y')).toBe(shops[1]);
  state.select(shops[1]);
  expect(state.getActiveShop()).toBe(shops[1]);
  expect(storage.value(ACTIVE_SHOP_KEY)).toBe('y');
});

test('storage failures do not break in-memory selection', () => {
  const state = createShopSelectionState({ storageProvider: () => ({
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  }) });
  expect(state.hydrate([{ id: 'local' }])).toMatchObject({ id: 'local' });
  expect(state.getActiveShopId()).toBe('local');
});

test('shop switcher component delegates storage/list ownership', () => {
  const source = fs.readFileSync(new URL('../public/components/shop-switcher.js', import.meta.url), 'utf8');
  expect(source).toContain("from './shop-selection-state.js'");
  expect(source).not.toContain("sessionStorage.getItem('etsy_mgr_active_shop')");
  expect(source).not.toContain("sessionStorage.setItem('etsy_mgr_active_shop'");
  expect(source).not.toContain('let shops = []');
  expect(source).not.toContain('let activeShop = null');
});
