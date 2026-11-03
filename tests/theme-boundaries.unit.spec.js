import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { THEME_KEY, applyTheme, getTheme, toggleTheme } from '../public/utils/theme/preference.js';
import { isPWAInstalled, triggerInstall } from '../public/utils/theme/pwa.js';
import { closeMobileSidebar, onMobileNavClick, openMobileSidebar } from '../public/utils/theme/mobile-sidebar.js';

function withGlobals(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
}

test('theme preference keeps storage key, document attribute and icons in sync', async () => {
  expect(THEME_KEY).toBe('etsy_mgr_theme');
  const attributes = new Map();
  const storage = new Map();
  const icons = [{ textContent: '' }, { textContent: '' }];
  await withGlobals({
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    document: {
      documentElement: {
        setAttribute: (key, value) => attributes.set(key, value),
        getAttribute: key => attributes.get(key) || null,
      },
      querySelectorAll: () => icons,
    },
  }, () => {
    applyTheme('dark');
    expect(getTheme()).toBe('dark');
    expect(storage.get(THEME_KEY)).toBe('dark');
    expect(icons.map(icon => icon.textContent)).toEqual(['☀️', '☀️']);
    toggleTheme();
    expect(getTheme()).toBe('light');
    expect(icons.map(icon => icon.textContent)).toEqual(['🌙', '🌙']);
  });
});

test('PWA installed detection preserves display-mode and iOS standalone paths', async () => {
  await withGlobals({
    window: { matchMedia: () => ({ matches: true }), navigator: {} },
  }, () => expect(isPWAInstalled()).toBe(true));
  await withGlobals({
    window: { matchMedia: () => ({ matches: false }), navigator: { standalone: true } },
  }, () => expect(isPWAInstalled()).toBe(true));
  await withGlobals({
    window: { matchMedia: () => ({ matches: false }), navigator: {} },
  }, async () => expect(await triggerInstall()).toBe(false));
});

test('mobile sidebar open/close toggles historical classes', async () => {
  const classes = {
    sidebar: new Set(),
    overlay: new Set(),
    button: new Set(),
  };
  const element = key => ({ classList: {
    add: value => classes[key].add(value),
    remove: value => classes[key].delete(value),
  } });
  await withGlobals({
    document: { getElementById: id => id === 'sidebar' ? element('sidebar') : id === 'sidebar-overlay' ? element('overlay') : id === 'hamburger-btn' ? element('button') : null },
    window: { innerWidth: 700 },
  }, () => {
    openMobileSidebar();
    expect(classes.sidebar.has('open')).toBe(true);
    expect(classes.overlay.has('visible')).toBe(true);
    expect(classes.button.has('sidebar-open')).toBe(true);
    onMobileNavClick();
    expect(classes.sidebar.has('open')).toBe(false);
    openMobileSidebar();
    closeMobileSidebar();
    expect(classes.overlay.has('visible')).toBe(false);
  });
});

test('theme public entry remains a feature compatibility facade', () => {
  const source = fs.readFileSync(new URL('../public/utils/theme.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(22);
  expect(source).not.toContain('beforeinstallprompt');
  expect(source).not.toContain('prefers-color-scheme');
  expect(source).not.toContain('hamburger-btn');
  expect(source).toContain("from './theme/preference.js'");
  expect(source).toContain("from './theme/pwa.js'");
  expect(source).toContain("from './theme/mobile-sidebar.js'");
});
