import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/#gallery');
  await expect(page.locator('.sidebar-brand')).toBeVisible();
  await expect(page.locator('#gtab-images')).toBeVisible();
  await expect(page.locator('#gtab-videos')).toBeVisible();
  await expect(page.locator('#gallery-grid')).toBeVisible();
});

test('gallery tabs switch both directions', async ({ page }) => {
  // Start on Images
  await expect(page.locator('#gtab-images')).toHaveClass(/gallery-tab-active/);

  // Switch to Videos
  await page.locator('#gtab-videos').click();
  await expect(page.locator('#gtab-videos')).toHaveClass(/gallery-tab-active/);

  // Switch back to Images (regression)
  await page.locator('#gtab-images').click();
  await expect(page.locator('#gtab-images')).toHaveClass(/gallery-tab-active/);

  // Grid must still render content/empty state block after switching back
  await expect(page.locator('#gallery-grid')).toBeVisible();
  await expect(page.locator('#gallery-grid')).not.toBeEmpty();
});

test('gallery does not render metadata records without local image data', async ({ page }) => {
  await page.route('**/api/kv', async route => {
    const body = route.request().postDataJSON?.() || {};
    if (body.action === 'getGalleryMeta') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        data: [{ id: 'missing-binary', mimeType: 'image/png', slotLabel: 'Broken' }],
      }) });
    }
    return route.fallback();
  });

  await page.reload();
  await expect(page.locator('#gallery-grid')).toBeVisible();
  await expect(page.locator('.gallery-card').filter({ hasText: 'Broken' })).toHaveCount(0);
  await expect(page.locator('a[href="data:image/png;base64,null"]')).toHaveCount(0);
});
