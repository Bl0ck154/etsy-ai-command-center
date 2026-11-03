import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { CROSS_PLATFORM_SET, PRESETS } from '../public/utils/image-resize-contracts.js';
import { calculateResizeRect, resolveResizeMode } from '../public/utils/image-resize-geometry.js';

test('preserves cross-platform preset contracts', () => {
  expect(CROSS_PLATFORM_SET).toEqual(['etsy', 'social', 'stories']);
  expect(PRESETS.etsy).toMatchObject({ w: 2000, h: 2000, ratio: '1:1' });
  expect(PRESETS.social).toMatchObject({ w: 1080, h: 1350, ratio: '4:5' });
  expect(PRESETS.stories).toMatchObject({ w: 1080, h: 1920, ratio: '9:16' });
});

test('smart mode uses contain only when projected crop loss exceeds 15 percent', () => {
  expect(resolveResizeMode(1100, 1000, 1000, 1000, 'smart')).toBe('cover');
  expect(resolveResizeMode(2000, 1000, 1000, 1000, 'smart')).toBe('contain');
  expect(resolveResizeMode(1000, 2000, 1000, 1000, 'smart')).toBe('contain');
  expect(resolveResizeMode(2000, 1000, 1000, 1000, 'cover')).toBe('cover');
});

test('contain centers a wide source with vertical padding', () => {
  expect(calculateResizeRect({
    srcWidth: 2000,
    srcHeight: 1000,
    dstWidth: 1000,
    dstHeight: 1000,
    mode: 'contain',
  })).toEqual({ sx: 0, sy: 0, sw: 2000, sh: 1000, dx: 0, dy: 250, dw: 1000, dh: 500, mode: 'contain' });
});

test('contain centers a tall source with horizontal padding', () => {
  expect(calculateResizeRect({
    srcWidth: 1000,
    srcHeight: 2000,
    dstWidth: 1000,
    dstHeight: 1000,
    mode: 'contain',
  })).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 2000, dx: 250, dy: 0, dw: 500, dh: 1000, mode: 'contain' });
});

test('cover crops a wide source symmetrically', () => {
  expect(calculateResizeRect({
    srcWidth: 2000,
    srcHeight: 1000,
    dstWidth: 1000,
    dstHeight: 1000,
    mode: 'cover',
  })).toEqual({ sx: 500, sy: 0, sw: 1000, sh: 1000, dx: 0, dy: 0, dw: 1000, dh: 1000, mode: 'cover' });
});

test('Canvas adapter delegates geometry and keeps compatibility exports', async () => {
  const source = await fs.readFile(new URL('../public/utils/image-resize.js', import.meta.url), 'utf8');
  expect(source).toContain("from './image-resize-geometry.js'");
  expect(source).toContain("export { CROSS_PLATFORM_SET, PRESETS } from './image-resize-contracts.js';");
  expect(source).toContain('calculateResizeRect({');
  expect(source).not.toContain('const srcRatio = img.width / img.height');
  expect(source).not.toContain('const loss = srcRatio > dstRatio');
});
