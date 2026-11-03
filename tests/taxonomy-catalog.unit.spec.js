import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createTaxonomyCatalog, flattenTaxonomyTree } from '../public/components/taxonomy-catalog.js';

const SAMPLE = [
  {
    id: 1,
    name: 'Art',
    children: [
      { id: 2, name: 'Digital Art', children: [{ id: 3, name: 'Printable Portraits' }] },
      { id: 4, name: 'Painting' },
    ],
  },
  { id: 5, name: 'Craft Supplies' },
];

test('flattens hierarchical taxonomy with stable path labels and levels', () => {
  expect(flattenTaxonomyTree(SAMPLE)).toEqual([
    { id: 1, name: 'Art', path: ['Art'], label: 'Art', level: 0 },
    { id: 2, name: 'Digital Art', path: ['Art', 'Digital Art'], label: 'Art › Digital Art', level: 1 },
    { id: 3, name: 'Printable Portraits', path: ['Art', 'Digital Art', 'Printable Portraits'], label: 'Art › Digital Art › Printable Portraits', level: 2 },
    { id: 4, name: 'Painting', path: ['Art', 'Painting'], label: 'Art › Painting', level: 1 },
    { id: 5, name: 'Craft Supplies', path: ['Craft Supplies'], label: 'Craft Supplies', level: 0 },
  ]);
});

test('deduplicates concurrent loads and caches the resulting catalog', async () => {
  let calls = 0;
  let resolveLoad;
  const catalog = createTaxonomyCatalog({
    loadTaxonomy: () => {
      calls += 1;
      return new Promise(resolve => { resolveLoad = resolve; });
    },
  });

  const first = catalog.load();
  const second = catalog.load();
  expect(calls).toBe(1);
  resolveLoad({ results: SAMPLE });
  await expect(first).resolves.toHaveLength(5);
  await expect(second).resolves.toHaveLength(5);
  await catalog.load();
  expect(calls).toBe(1);
});

test('failed load can be retried instead of poisoning the shared cache', async () => {
  let calls = 0;
  const catalog = createTaxonomyCatalog({
    loadTaxonomy: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
      return SAMPLE;
    },
  });
  await expect(catalog.load()).rejects.toThrow('temporary');
  await expect(catalog.load()).resolves.toHaveLength(5);
  expect(calls).toBe(2);
});

test('preserves initial/search limits, lookup, and specificity-biased AI hint matching', async () => {
  const catalog = createTaxonomyCatalog({ loadTaxonomy: async () => SAMPLE });
  await catalog.load();

  expect(catalog.initial(2).map(node => node.id)).toEqual([1, 2]);
  expect(catalog.search('art').map(node => node.id)).toEqual([1, 2, 3, 4]);
  expect(catalog.search('portrait').map(node => node.id)).toEqual([3]);
  expect(catalog.findById(4)?.label).toBe('Art › Painting');
  expect(catalog.findById(999)).toBeNull();
  expect(catalog.findBest('digital printable portrait')?.id).toBe(3);
});

test('picker delegates taxonomy data/search ownership to the catalog', async () => {
  const pickerSource = await fs.readFile(new URL('../public/components/taxonomy-select.js', import.meta.url), 'utf8');
  const catalogSource = await fs.readFile(new URL('../public/components/taxonomy-catalog.js', import.meta.url), 'utf8');

  expect(pickerSource).toContain("from './taxonomy-catalog.js'");
  expect(pickerSource).toContain('taxonomyCatalog.load()');
  expect(pickerSource).toContain('taxonomyCatalog.search(this.query, 100)');
  expect(pickerSource).toContain('return taxonomyCatalog.findBest(hint)');
  expect(pickerSource).not.toContain("from '../utils/api.js'");
  expect(pickerSource).not.toContain('function flattenTree(');
  expect(pickerSource).not.toContain('.filter(n => n.label.toLowerCase().includes');

  expect(catalogSource).toContain("await import('../utils/api.js')");
  expect(catalogSource).toContain('matches * 10 + node.level');
});
