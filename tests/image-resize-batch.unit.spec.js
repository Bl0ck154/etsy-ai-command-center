import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createImageResizeBatchService, crossPlatformResizeModes } from '../public/utils/image-resize-batch.js';

test('cross-platform mode policy preserves Etsy and Stories contain behavior', () => {
  expect(crossPlatformResizeModes('smart')).toEqual({ etsy: 'contain', social: 'smart', stories: 'contain' });
  expect(crossPlatformResizeModes('cover')).toEqual({ etsy: 'contain', social: 'cover', stories: 'contain' });
});

test('generates presets sequentially in declared order with resolved modes', async () => {
  const calls = [];
  const service = createImageResizeBatchService({
    presets: ['etsy', 'social', 'stories'],
    resize: async (file, key, mode) => {
      calls.push([file, key, mode]);
      return { key, mode };
    },
  });
  const file = { name: 'source.png' };
  const result = await service.generate(file, 'cover');
  expect(calls).toEqual([
    [file, 'etsy', 'contain'],
    [file, 'social', 'cover'],
    [file, 'stories', 'contain'],
  ]);
  expect(Object.keys(result)).toEqual(['etsy', 'social', 'stories']);
});

test('downloads one result with the historical key jpg filename', () => {
  const downloads = [];
  const service = createImageResizeBatchService({ download: (result, name) => downloads.push([result, name]) });
  expect(service.downloadOne({ social: { id: 1 } }, 'social')).toBe(true);
  expect(service.downloadOne({}, 'missing')).toBe(false);
  expect(downloads).toEqual([[{ id: 1 }, 'social.jpg']]);
});

test('downloadAll preserves object order and 350ms stagger', () => {
  const scheduled = [];
  const downloads = [];
  const service = createImageResizeBatchService({
    schedule: (fn, delay) => scheduled.push({ fn, delay }),
    download: (result, name) => downloads.push([result.id, name]),
  });
  const count = service.downloadAll({ etsy: { id: 'e' }, social: { id: 's' }, stories: { id: 't' } });
  expect(count).toBe(3);
  expect(scheduled.map(item => item.delay)).toEqual([0, 350, 700]);
  scheduled.forEach(item => item.fn());
  expect(downloads).toEqual([['e', 'etsy.jpg'], ['s', 'social.jpg'], ['t', 'stories.jpg']]);
});

test('modal delegates batch policy instead of owning resize/download orchestration', async () => {
  const source = await fs.readFile(new URL('../public/components/image-resize-modal.js', import.meta.url), 'utf8');
  expect(source).toContain("from '../utils/image-resize-batch.js'");
  expect(source).toContain('imageResizeBatch.generate(this.file, mode)');
  expect(source).toContain('imageResizeBatch.downloadOne(this.results, k)');
  expect(source).toContain('imageResizeBatch.downloadAll(this.results)');
  expect(source).not.toContain('const modeMap =');
  expect(source).not.toContain('for (const k of CROSS_PLATFORM_SET)');
  expect(source).not.toContain('i*350');
});
