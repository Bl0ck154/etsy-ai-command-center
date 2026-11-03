// Create listing tests — AI generation flow (read-only, no actual publish)
import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true }) }));
  await page.route('**/api/login**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, user: { id: 'test-owner', name: 'Test Owner' } }) }));
  await page.route('**/pages/create.js*', route => route.fulfill({ path: 'public/pages/create.js', contentType: 'application/javascript' }));
  await page.route('**/utils/api.js*', route => route.fulfill({ path: 'public/utils/api.js', contentType: 'application/javascript' }));
  await page.route('**/sw.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  const listingResult = {
    title: 'Watercolor Alphabet Clipart PNG Set for Kids, Transparent Letters, Instant Download',
    description: 'A colourful watercolor alphabet clipart set with 26 transparent PNG letters for children’s printables, classroom decor, invitations, stickers, and digital craft projects. Includes instant download files designed for easy use in Canva, Cricut projects, scrapbooking, and nursery artwork.',
    tags: ['alphabet png', 'clipart letters', 'kids clipart', 'watercolor abc', 'instant download', 'transparent png', 'teacher clipart', 'nursery letters', 'printable art', 'digital clipart', 'abc bundle', 'letter graphics', 'school graphics'],
    materials: ['PNG', 'digital download'],
    price_suggestion: 4.99,
    is_personalizable: true,
    personalization_questions: [
      { question_type: 'file_upload', question_text: 'Upload your reference photos', instructions: 'Upload files directly on Etsy.', required: true, max_allowed_files: 10 },
      { question_type: 'text_input', question_text: 'Describe your custom request', instructions: 'Share names and details.', required: true, max_allowed_characters: 1024 },
    ],
  };
  const jobs = new Map();
  await page.route('**/api/jobs**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON?.() || {};
    const action = body.action || url.searchParams.get('action');
    if (action === 'startListingGeneration') {
      jobs.set('job-test', { id: 'job-test', type: 'listing_generation', status: 'done', progress: 100, message: 'Listing content ready', result: listingResult });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 'job-test', status: 'queued', progress: 0, message: 'Queued' } }) });
    }
    if (action === 'status') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: jobs.get(url.searchParams.get('job_id')) || jobs.get(body.job_id) }) });
    }
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Unknown job action' }) });
  });
  await page.route('**/api/drafts**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().method() === 'POST' ? (route.request().postDataJSON?.() || {}) : {};
    const action = body.action || url.searchParams.get('action');
    if (action === 'get') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: null }) });
    if (action === 'set') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { savedAt: body.draft?.savedAt || Date.now(), serverSavedAt: Date.now() } }) });
    if (action === 'delete') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { deleted: true } }) });
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Unknown draft action' }) });
  });
  await page.route('**/api/ai', async route => {
    const body = route.request().postDataJSON?.() || {};
    if (body.type === 'listing') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: listingResult }),
      });
    }
    if (body.type === 'audit' && body.stream) {
      const text = '## Score: B — solid field with room to improve\n\n## What\'s good\nRelevant to the listing context.\n\n## Issues & fixes\n1. Add stronger buyer intent.\n\n## Improved version\nWatercolor Alphabet Clipart PNG Bundle for Kids, Transparent ABC Letters, Instant Download';
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'delta', text })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`,
      });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: 'OK' }) });
  });
  await page.addInitScript(async () => {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  });
  // Force Gemini provider — ANTHROPIC_API_KEY is not configured in the test environment
  await page.addInitScript(() => localStorage.setItem('ai_provider', 'gemini'));
  await page.goto('/#create');
  await expect(page.getByRole('button', { name: 'AI Agent' })).toBeVisible();
  await expect(page.locator('#gen-btn, textarea').first()).toBeVisible({ timeout: 10_000 });
});

async function waitForCreateGenerationComplete(page, timeout = 180_000) {
  const title = page.locator('#e-title');
  const desc = page.locator('#e-desc');
  await expect(title).toBeVisible({ timeout });
  await expect(desc).toBeVisible({ timeout });

  await expect.poll(async () => {
    const titleVal = await title.inputValue().catch(() => '');
    const descVal = await desc.inputValue().catch(() => '');
    return titleVal.trim().length > 10 && descVal.trim().length > 50;
  }, { timeout, intervals: [1000, 2000, 3000] }).toBe(true);
}

test('step 1 form renders correctly', async ({ page }) => {
  await expect(page.locator('textarea').first()).toBeVisible();
  await expect(page.locator('#gen-btn')).toBeVisible();
});

test('generate button disabled without description', async ({ page }) => {
  const textarea = page.locator('textarea').first();
  await textarea.clear();
  // Button should be disabled OR clicking produces nothing (still on step 1)
  const btn = page.locator('#gen-btn');
  const isDisabled = await btn.isDisabled();
  if (isDisabled) {
    expect(isDisabled).toBe(true);
  } else {
    await btn.click();
    // Still on step 1 — #e-title not appeared
    const titleInput = page.locator('#e-title');
    expect(await titleInput.count()).toBe(0);
  }
});

test('AI generates listing — title appears in #e-title', async ({ page }) => {
  const textarea = page.locator('textarea').first();
  await textarea.fill('Watercolour alphabet clipart set for kids — 26 letters, PNG transparent background, instant download');

  await page.locator('#gen-btn').click();

  await waitForCreateGenerationComplete(page);

  const titleVal = await page.locator('#e-title').inputValue();
  expect(titleVal.length).toBeGreaterThan(10);
  expect(titleVal.length).toBeLessThanOrEqual(140);
});

test('description textarea populated after generation', async ({ page }) => {
  await page.locator('textarea').first().fill('Photo restoration service — repair old damaged family photos');
  await page.locator('#gen-btn').click();

  await waitForCreateGenerationComplete(page);
  const desc = await page.locator('#e-desc').inputValue();
  expect(desc.length).toBeGreaterThan(50);
});

test('AI Analyse button opens modal', async ({ page }) => {
  await page.locator('textarea').first().fill('SVG bundle for laser cutting — animals set, instant download');
  await page.locator('#gen-btn').click();

  // Wait for edit step
  await expect(page.locator('#e-title')).toBeVisible({ timeout: 120_000 });

  // Click Analyse on title
  await page.locator('button:has-text("Analyse")').first().click();

  // Modal overlay appears
  await expect(page.locator('#active-modal')).toBeVisible({ timeout: 30_000 });
  // Modal body has content
  await expect(page.locator('#modal-body')).not.toBeEmpty({ timeout: 20_000 });
});

test('AI generation creates upload-field personalization instead of legacy email/message instructions', async ({ page }) => {
  await page.locator('textarea').first().fill('Custom photo merge portrait from customer photos, digital file');
  await page.locator('#gen-btn').click();
  await waitForCreateGenerationComplete(page);
  await expect(page.locator('#toggle-personal')).toHaveClass(/on/);
  await expect(page.locator('.personal-question')).toHaveCount(2);
  await expect(page.locator('[data-pq-field="question_type"]').first()).toHaveValue('file_upload');
  await expect(page.locator('[data-pq-field="question_text"]').first()).toHaveValue(/Upload your reference photos/i);
  await expect(page.locator('#e-desc')).not.toHaveValue(/email|message\s+(me|us)|etsy chat/i);
});

test('personalization UI supports text dropdown and file questions', async ({ page }) => {
  await page.route('**/api/etsy**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('action') !== 'getListing' || url.searchParams.get('listing_id') !== '123456789') {
      return route.fallback();
    }
    return route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: {
      listing_id: 123456789,
      title: 'Mock Listing',
      description: 'Mock description for personalization UI test',
      tags: ['custom gift'],
      materials: [],
      price: { amount: 999, divisor: 100 },
      quantity: 999,
      listing_type: 'download',
      taxonomy_id: 1,
    } }),
    });
  });

  await page.evaluate(() => {
    window.navigate('create', { listing_id: 123456789 });
  });

  await expect(page.locator('#toggle-personal')).toBeVisible({ timeout: 10_000 });
  await page.locator('#toggle-personal').click();
  await expect(page.locator('#personal-fields')).toBeVisible();
  await expect(page.locator('.personal-question')).toHaveCount(1);

  await page.locator('[data-pq-field="question_type"]').first().selectOption('dropdown');
  await expect(page.locator('[data-pq-field="options"]')).toBeVisible();

  await page.locator('#add-personal-question-btn').click();
  await page.locator('[data-pq-field="question_type"]').nth(1).selectOption('file_upload');
  await expect(page.locator('.personal-question').nth(1).locator('[data-pq-field="max_allowed_files"]')).toBeVisible();
  await expect(page.locator('.personal-question')).toHaveCount(2);
});

test('existing listing image controls use provider-neutral copy without the new-draft auto-cover option', async ({ page }) => {
  await page.route('**/api/etsy**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('action') !== 'getListing' || url.searchParams.get('listing_id') !== '555000111') {
      return route.fallback();
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: {
        listing_id: 555000111,
        title: 'Generations Portrait Draft',
        description: 'A multi-generation family portrait draft used for image UI regression coverage.',
        tags: ['family portrait'],
        materials: [],
        price: { amount: 9900, divisor: 100 },
        quantity: 999,
        listing_type: 'download',
        taxonomy_id: 1,
        images: [{ listing_image_id: 1, url_570xN: 'data:image/png;base64,iVBORw0KGgo=' }],
      } }),
    });
  });

  await page.evaluate(() => window.navigate('create', { listing_id: 555000111 }));
  const button = page.locator('#gen-images-btn');
  await expect(button).toBeVisible({ timeout: 10_000 });
  await expect(button).toHaveAttribute('title', 'Open the image generator');
  await expect(button).not.toHaveAttribute('title', /provider|omniroute|gemini|nano banana/i);
  await expect(page.locator('#auto-gen-cover')).toHaveCount(0);
});

test('image prompt modal opens with 6 slots', async ({ page }) => {
  await page.locator('textarea').first().fill('Digital planner 2026 — minimalist, monthly and weekly, GoodNotes compatible, instant download');
  await page.locator('#gen-btn').click();

  await waitForCreateGenerationComplete(page);

  // Click Generate images button in review step
  await page.locator('#gen-images-btn').click();

  // Image prompt panel with slots opens
  const panel = page.locator('#img-gen-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText('Generate listing images', { timeout: 30_000 });
  // Should show slot labels
  await expect(panel).toContainText('Cover / hero', { timeout: 30_000 });
});

test('image prompts are prepared in the background before the image studio opens', async ({ page }) => {
  await page.unroute('**/api/ai');
  const promptCalls = [];
  await page.route('**/api/ai', async route => {
    const body = route.request().postDataJSON?.() || {};
    if (body.type !== 'audit') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) });
    promptCalls.push(body._rawPrompt || '');
    if (String(body._rawSystem || '').includes('Output exactly 4 lines')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: 'PRODUCT TRUTH: digital clipart set\nVISUAL SYSTEM: white, teal, coral\nCONSISTENCY: centered crop-safe product\nTEXT POLICY: no text' }),
      });
    }
    const slots = [...String(body._rawPrompt || '').matchAll(/Slot (\d+)/g)].map(match => Number(match[1]));
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: JSON.stringify(slots.map(slot => ({
        slot,
        label: `Prepared slot ${slot}`,
        ratio: '1:1',
        prompt: `Prepared commercial image brief for slot ${slot}. Preserve the exact product. Use a clear crop-safe composition. No added text. Use soft studio lighting. Keep the campaign consistent. Avoid unsupported claims and fake UI. Output square.`,
      }))) }),
    });
  });

  await page.locator('textarea').first().fill('Watercolor alphabet clipart PNG set, 26 transparent letters, instant digital download');
  await page.locator('#gen-btn').click();
  await expect(page.locator('#auto-gen-cover')).toBeVisible();
  await page.locator('#auto-gen-cover').uncheck();
  await waitForCreateGenerationComplete(page);
  await expect.poll(() => page.evaluate(() => window.__imgGenPrefetch?.status || ''), { timeout: 15_000 }).toBe('done');
  expect(promptCalls.length).toBe(3);
  await expect(page.locator('#img-gen-panel')).toBeHidden();

  await page.locator('#gen-images-btn').click();
  await expect.poll(() => page.evaluate(() => window.__imgGen?.prompts?.filter(prompt => prompt?.prompt).length || 0)).toBe(9);
  expect(await page.locator('#prompt-ta-0').inputValue()).toContain('Prepared commercial image brief for slot 0');
});

test('agent draft opens filled create page without legacy generation or loading screen', async ({ page }) => {
  const extraCalls = [];
  const promptCalls = [];
  await page.route('**/api/jobs**', route => {
    extraCalls.push({ type: 'jobs', url: route.request().url() });
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'should not start job for agent draft' }) });
  });
  await page.route('**/api/media', route => {
    extraCalls.push({ type: 'media', url: route.request().url() });
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'should not auto-generate media for agent draft' }) });
  });
  await page.route('**/api/ai', route => {
    const body = route.request().postDataJSON?.() || {};
    promptCalls.push(body);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: 'Prompt preparation fixture' }) });
  });

  await page.evaluate(() => window.navigate('create', { agentDraft: {
    description: 'Agent brief for a cinematic custom love story video',
    listingType: 'download',
    price: 15,
    generated: {
      title: 'Custom Cinematic Love Story Video, Anniversary Trailer from Photos, Digital Gift',
      description: 'A ready-to-review Etsy listing description generated by the agent. It explains the custom cinematic love story video, how buyers send photos, and that the final delivery is digital.',
      tags: ['love story video', 'anniversary gift', 'custom video', 'photo slideshow', 'digital gift', 'valentine video', 'movie trailer', 'gift for him', 'romantic video', 'photo video', 'custom trailer', 'wedding video', 'couple gift'],
      materials: ['digital video', 'photos'],
      price_suggestion: 15,
      personalization_questions: [
        { question_type: 'file_upload', question_text: 'Upload your photos', instructions: 'Upload the photos you want included.', required: true, max_allowed_files: 10 },
        { question_type: 'text_input', question_text: 'Share names and message', instructions: 'Add names, date, song preference, and any notes.', required: true, max_allowed_characters: 1024 },
      ],
    },
  } }));

  await expect(page.locator('#ai-listing-loading-banner')).toHaveCount(0);
  await expect(page.locator('#gen-progress-bar')).toHaveCount(0);
  await expect(page.locator('#e-title')).toHaveValue(/Custom Cinematic Love Story Video/);
  await expect(page.locator('#e-desc')).toHaveValue(/ready-to-review Etsy listing description/);
  await expect(page.locator('#tags-count')).toContainText('13/13');
  await expect(page.locator('#toggle-personal')).toHaveClass(/on/);
  await expect(page.locator('.personal-question')).toHaveCount(2);
  await expect(page.locator('#auto-gen-cover')).not.toBeChecked();
  await page.waitForTimeout(500);
  expect(extraCalls).toEqual([]);
  expect(promptCalls.length).toBeGreaterThan(0);
  expect(promptCalls.every(call => call.type === 'audit')).toBe(true);
});

test('agent draft can carry an uploaded image into create page unchanged', async ({ page }) => {
  const extraCalls = [];
  await page.route('**/api/media', route => {
    extraCalls.push({ type: 'media', url: route.request().url() });
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'should not auto-generate media when image is attached' }) });
  });

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  await page.evaluate((base64) => window.navigate('create', { agentDraft: {
    description: 'Agent brief from an uploaded finished design',
    listingType: 'download',
    price: 9,
    generateImages: false,
    attachedImages: [{
      base64,
      mimeType: 'image/png',
      filename: 'uploaded-design.png',
      preview: `data:image/png;base64,${base64}`,
      source: 'agent_upload',
    }],
    generated: {
      title: 'Uploaded Custom Digital Design, Instant Download Artwork File',
      description: 'A ready-to-review Etsy listing description generated from an uploaded image.',
      tags: ['custom design', 'digital design', 'uploaded art', 'instant download', 'printable art', 'png file', 'digital file', 'custom artwork', 'wall art', 'gift design', 'download art', 'modern print', 'home decor'],
      materials: ['PNG', 'digital download'],
      price_suggestion: 9,
    },
  } }), png);

  await expect(page.locator('#e-title')).toHaveValue(/Uploaded Custom Digital Design/);
  await expect(page.locator('#auto-gen-cover')).toHaveCount(0);
  await expect(page.locator('#image-uploader-wrap .img-thumb')).toHaveCount(1);
  const src = await page.locator('#image-uploader-wrap .img-thumb img').getAttribute('src');
  expect(src).toMatch(/^blob:|^data:image\/png/);
  await page.waitForTimeout(500);
  expect(extraCalls).toEqual([]);
});

test('gallery batch attaches five images and restores the newer local draft when server sync fails', async ({ page }) => {
  await page.unroute('**/api/drafts**').catch(() => {});
  await page.route('**/api/kv', async route => {
    const body = route.request().postDataJSON?.() || {};
    if (body.action === 'getGalleryMeta') {
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'KV unavailable in gallery test' }) });
  });

  const staleServerDraft = {
    savedAt: 1,
    description: 'Old server draft without gallery images',
    productType: 'other',
    listingType: 'download',
    price: 10,
    generated: {
      title: 'Stale Server Draft',
      description: 'This stale server copy intentionally has no images and must not replace the newer local draft.',
      tags: ['stale draft'],
      materials: [],
      price_suggestion: 10,
    },
    title: 'Stale Server Draft',
    desc: 'This stale server copy intentionally has no images and must not replace the newer local draft.',
    draftImages: [],
  };
  await page.route('**/api/drafts**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().method() === 'POST' ? (route.request().postDataJSON?.() || {}) : {};
    const action = body.action || url.searchParams.get('action');
    if (action === 'get') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: staleServerDraft }) });
    }
    if (action === 'set') {
      return route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'Draft exceeds server limit' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { deleted: true } }) });
  });

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  await page.evaluate(async ({ base64 }) => {
    const { saveImage } = await import('/utils/image-store.js');
    for (let i = 0; i < 5; i += 1) {
      await saveImage({
        base64,
        mimeType: 'image/png',
        prompt: `Gallery prompt ${i + 1}`,
        slotLabel: `Gallery slot ${i + 1}`,
        listingTitle: 'Gallery Persistence Listing',
        provider: 'external',
        model: 'test-image-model',
      });
    }
  }, { base64: png });

  await page.evaluate(() => window.navigate('create', { agentDraft: {
    description: 'Gallery draft regression brief',
    listingType: 'download',
    price: 12,
    generated: {
      title: 'Gallery Persistence Listing',
      description: 'A complete listing description used to verify that five gallery images attach and survive local draft restore.',
      tags: ['gallery test'],
      materials: ['PNG'],
      price_suggestion: 12,
    },
  } }));
  await expect(page.locator('#e-title')).toHaveValue('Gallery Persistence Listing');

  const galleryButton = page.getByRole('button', { name: /From Gallery/i });
  const openedAt = Date.now();
  await galleryButton.click();
  await expect(page.locator('#gallery-picker-overlay')).toBeVisible({ timeout: 1_000 });
  expect(Date.now() - openedAt).toBeLessThan(1_500);
  const cards = page.locator('#gallery-picker-overlay [data-id]');
  await expect(cards).toHaveCount(5, { timeout: 3_000 });

  await page.locator('.gallery-picker-preview-button').first().click();
  await expect(page.locator('.gallery-picker-lightbox')).toBeVisible();
  await expect(page.locator('.gallery-picker-lightbox-image')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.getByRole('button', { name: 'Close preview' }).click();

  const clickOrder = [2, 0, 4, 1, 3];
  const expectedLabels = [];
  for (let order = 0; order < clickOrder.length; order += 1) {
    const card = cards.nth(clickOrder[order]);
    const id = await card.getAttribute('data-id');
    expectedLabels.push((await card.locator('.gallery-picker-label').textContent()) || '');
    await card.click();
    await expect(page.locator(`#gallery-picker-overlay [data-id="${id}"] .gallery-picker-order`)).toHaveText(String(order + 1));
  }
  await expect(page.locator('.gallery-picker-status')).toHaveText('5 selected in attachment order');
  await page.locator('.gallery-picker-confirm').click();

  await expect(page.locator('#image-uploader-wrap .img-thumb')).toHaveCount(5, { timeout: 5_000 });
  await expect(page.locator('#image-uploader-wrap .upload-zone')).toHaveClass(/has-images/);
  await expect(page.locator('#animate-video-btn')).toHaveCount(0);
  await expect(page.locator('#listing-video-panel')).not.toHaveAttribute('open', '');
  const compactDropZone = await page.locator('#image-uploader-wrap .upload-zone').boundingBox();
  expect(compactDropZone?.height || 0).toBeGreaterThanOrEqual(48);
  expect(compactDropZone?.width || 0).toBeGreaterThan(300);
  const dragOverActive = await page.locator('#image-uploader-wrap .upload-zone').evaluate(zone => {
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    const active = zone.classList.contains('drag-over');
    zone.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
    return active;
  });
  expect(dragOverActive).toBe(true);
  const sectionHierarchy = await page.evaluate(() => {
    const personalization = document.querySelector('.create-personalization-wide');
    const variations = document.querySelector('#variations-card');
    const inventory = document.querySelector('#var-inventory-outer');
    return {
      personalizationBeforeVariations: Boolean(personalization?.compareDocumentPosition(variations) & Node.DOCUMENT_POSITION_FOLLOWING),
      inventoryInsideVariations: variations?.contains(inventory) === true,
    };
  });
  expect(sectionHierarchy).toEqual({ personalizationBeforeVariations: true, inventoryInsideVariations: true });
  const attachedLabels = await page.evaluate(() => window.__uploaders['image-uploader-wrap'].images.map(image => image.slotLabel));
  expect(attachedLabels).toEqual(expectedLabels);
  await expect(page.getByText('Images saved on this device. Server draft sync will retry automatically.')).toBeVisible();

  await page.evaluate(() => window.navigate('create', {}));
  await expect(page.getByRole('button', { name: 'Restore draft' })).toBeVisible();
  await page.evaluate(() => window.restoreDraft());
  await expect(page.locator('#e-title')).toHaveValue('Gallery Persistence Listing');
  await expect(page.locator('#image-uploader-wrap .img-thumb')).toHaveCount(5, { timeout: 5_000 });
  await expect(page.locator('#image-uploader-wrap .upload-zone')).toHaveClass(/has-images/);
  const restored = await page.evaluate(() => window.__uploaders['image-uploader-wrap'].images.map(image => ({
    galleryId: image.galleryId,
    prompt: image.prompt,
    slotLabel: image.slotLabel,
    listingTitle: image.listingTitle,
    provider: image.provider,
    model: image.model,
    mimeType: image.mimeType,
  })));
  expect(restored).toHaveLength(5);
  expect(restored[0]).toMatchObject({
    prompt: expect.stringMatching(/^Gallery prompt /),
    slotLabel: expect.stringMatching(/^Gallery slot /),
    listingTitle: 'Gallery Persistence Listing',
    provider: 'external',
    model: 'test-image-model',
    mimeType: 'image/png',
  });
  expect(restored.every(image => image.galleryId)).toBe(true);
});

test('agent draft uses uploaded design as cover generation reference without attaching it unchanged', async ({ page }) => {
  await page.unroute('**/api/jobs**');
  await page.unroute('**/api/ai');

  const jobsCalls = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  await page.route('**/api/ai', async route => {
    const body = route.request().postDataJSON?.() || {};
    if (body.type === 'audit') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: JSON.stringify([{ label: 'Cover / hero', prompt: 'Photorealistic Etsy cover mockup using the exact uploaded design as the product artwork.' }]) }),
      });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: 'OK' }) });
  });
  await page.route('**/api/jobs**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON?.() || {};
    const action = body.action || url.searchParams.get('action');
    if (action === 'startImageGeneration') {
      jobsCalls.push(body);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 'cover-ref-job', status: 'queued', progress: 0, message: 'Queued' } }) });
    }
    if (action === 'status') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {
          id: 'cover-ref-job',
          type: 'image_generation',
          status: 'done',
          progress: 100,
          message: 'Image generation complete',
          result: { success: true, images: [{ base64: png, mimeType: 'image/png' }] },
        } }),
      });
    }
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Unknown job action' }) });
  });

  await page.evaluate((base64) => window.navigate('create', { agentDraft: {
    description: 'Agent brief from an uploaded wedding board design',
    listingType: 'download',
    price: 12,
    generateImages: true,
    referenceImage: {
      base64,
      mimeType: 'image/png',
      filename: 'design-reference.png',
    },
    generated: {
      title: 'Wedding Board Design Template, Personalized Couple Gift Artwork',
      description: 'A ready-to-review Etsy listing description generated from an uploaded design reference.',
      tags: ['wedding design', 'couple gift', 'personalized art', 'digital design', 'gift artwork', 'anniversary gift', 'board design', 'rustic wedding', 'custom design', 'download art', 'home decor', 'bridal gift', 'keepsake'],
      materials: ['digital download'],
      price_suggestion: 12,
    },
  } }), png);

  await expect(page.locator('#e-title')).toHaveValue(/Wedding Board Design/);
  await expect(page.locator('#auto-gen-cover')).toBeChecked();
  await expect.poll(() => jobsCalls.length, { timeout: 30_000 }).toBe(1);
  expect(jobsCalls[0]?.referenceImage).toMatchObject({ base64: png, mimeType: 'image/png' });
  await expect(page.locator('#image-uploader-wrap .img-thumb')).toHaveCount(1, { timeout: 30_000 });
});

test('create draft autosave uses server storage and restores image generation state', async ({ page }) => {
  await page.unroute('**/api/drafts**').catch(() => {});
  await page.unroute('**/api/jobs**').catch(() => {});

  let serverDraft = null;
  const draftActions = [];
  await page.route('**/api/drafts**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().method() === 'POST' ? (route.request().postDataJSON?.() || {}) : {};
    const action = body.action || url.searchParams.get('action');
    draftActions.push(action);
    if (action === 'get') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: serverDraft }) });
    }
    if (action === 'set') {
      serverDraft = { ...body.draft, serverSavedAt: Date.now() };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { savedAt: serverDraft.savedAt, serverSavedAt: serverDraft.serverSavedAt } }) });
    }
    if (action === 'delete') {
      serverDraft = null;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { deleted: true } }) });
    }
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad draft action' }) });
  });

  await page.route('**/api/jobs**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON?.() || {};
    const action = body.action || url.searchParams.get('action');
    if (action === 'status') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: {
        id: body.job_id || url.searchParams.get('job_id') || 'job_slot_restore',
        type: 'image_generation',
        status: 'running',
        progress: 50,
        message: 'Still generating',
      } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 'job-unused', status: 'queued' } }) });
  });

  await page.evaluate(() => window.navigate('create', { agentDraft: {
    description: 'Server draft regression brief',
    listingType: 'download',
    price: 11,
    generateImages: false,
    generated: {
      title: 'Server Saved Draft Listing, Digital Download Artwork',
      description: 'A ready-to-review Etsy listing description for the server-side draft restore regression test.',
      tags: ['server draft', 'digital art', 'instant download', 'printable file', 'custom design', 'artwork png', 'download art', 'etsy draft', 'listing image', 'mockup design', 'digital gift', 'wall decor', 'print file'],
      materials: ['PNG', 'digital download'],
      price_suggestion: 11,
    },
  } }));

  await expect(page.locator('#e-title')).toHaveValue(/Server Saved Draft Listing/);
  await expect.poll(() => serverDraft?.generated?.title || '', { timeout: 10_000 }).toContain('Server Saved Draft Listing');

  serverDraft = {
    ...serverDraft,
    title: 'Restored Server Draft Title',
    desc: 'Restored server draft description that should be placed back into the editor.',
    imageGenerationJobs: { 0: { jobId: 'job_slot_restore', prompt: 'restored prompt', ratio: '1:1', count: 1, status: 'running' } },
    imagePrompts: [{ slot: 0, label: 'Cover / hero', ratio: '1:1', prompt: 'Restored cover prompt from server' }],
    coverImageJobId: null,
  };

  await page.evaluate(() => window.navigate('create', { restoreDraft: true }));

  await expect(page.locator('#e-title')).toHaveValue('Restored Server Draft Title');
  await expect(page.locator('#e-desc')).toHaveValue(/Restored server draft description/);
  await page.evaluate(() => window.openImagePrompt());

  await expect(page.locator('#img-gen-panel')).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => page.evaluate(() => window.__imgGen?._slotJobs?.[0]?.jobId || ''), { timeout: 10_000 }).toBe('job_slot_restore');
  await expect.poll(async () => page.evaluate(() => window.__imgGen?.prompts?.[0]?.prompt || ''), { timeout: 10_000 }).toContain('Restored cover prompt');
  expect(draftActions).toContain('set');
  expect(draftActions).toContain('get');
});

test('agent applies physical type and variations to the server draft and live Create UI', async ({ page }) => {
  await page.unroute('**/api/drafts**').catch(() => {});
  let serverDraft = null;
  const etsyWrites = [];
  await page.route('**/api/etsy**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().method() === 'POST' ? (route.request().postDataJSON?.() || {}) : {};
    const action = body.action || url.searchParams.get('action');
    const dataByAction = {
      getShopSections: { results: [{ shop_section_id: 53935278, title: 'Photo services' }] },
      getShippingProfiles: { results: [{ shipping_profile_id: 148610403760, title: 'Free shipping' }] },
      getReturnPolicies: { results: [{ return_policy_id: 1074832365360, accepts_returns: true }] },
      getReadinessStateDefinitions: { results: [{ readiness_state_id: 1405042501851, readiness_state: 'made_to_order', min_processing_days: 1, max_processing_days: 3 }] },
      getTaxonomy: { results: [{ id: 1, name: 'Art & Collectibles', children: [{ id: 77, name: 'Drawing & Illustration', children: [] }] }] },
    };
    if (dataByAction[action]) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: dataByAction[action] }) });
    }
    if (action === 'createListing') {
      etsyWrites.push(body);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { listing_id: 987654321, state: 'draft' } }) });
    }
    if (action === 'updateListingInventory') {
      etsyWrites.push(body);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { products: body.products } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { results: [] } }) });
  });
  await page.route('**/api/drafts**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().method() === 'POST' ? (route.request().postDataJSON?.() || {}) : {};
    const action = body.action || url.searchParams.get('action');
    if (action === 'get') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: serverDraft }) });
    }
    if (action === 'set') {
      serverDraft = { ...body.draft, serverSavedAt: Date.now(), revision: body.draft?.revision || Date.now() };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: serverDraft }) });
    }
    if (action === 'patch') {
      serverDraft = { ...serverDraft, ...body.patch, savedAt: Date.now(), serverSavedAt: Date.now(), revision: Date.now() };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: serverDraft }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { deleted: true } }) });
  });
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({
      type: 'done',
      message: 'I prepared the requested draft changes for approval.',
      pending_variations: {
        listing_type: 'physical',
        base_price: 25,
        taxonomy_category: 'Drawing & Illustration',
        shipping_profile_id: 148610403760,
        readiness_state_id: 1405042501851,
        properties: [
          { name: 'Size', pricing_mode: 'final_price', options: [{ name: 'Small', amount: 25 }, { name: 'Large', amount: 35 }] },
          { name: 'Finish', pricing_mode: 'surcharge', options: [{ name: 'Matte', amount: 0 }, { name: 'Glossy', amount: 5 }] },
        ],
      },
    })}\n\n`,
  }));

  await page.evaluate(() => window.navigate('create', { agentDraft: {
    description: 'Physical portrait draft',
    listingType: 'download',
    price: 25,
    generated: {
      title: 'Custom Physical Portrait Gift',
      description: 'A personalized physical portrait created from customer photos and delivered as a finished keepsake.',
      tags: ['custom portrait'],
      materials: ['archival paper'],
      price_suggestion: 25,
    },
  } }));
  await expect(page.locator('#e-ltype')).toHaveValue('download');
  await expect.poll(() => serverDraft?.title || '', { timeout: 10_000 }).toContain('Custom Physical Portrait');

  await page.locator('#agent-fab').click();
  const mini = page.locator('#float-agent-host');
  await mini.locator('#agent-input').fill('Make this draft physical and add size and finish variations');
  await mini.locator('#agent-send-btn').click();
  await mini.getByRole('button', { name: 'Apply to listing draft' }).click();

  await expect(mini.locator('#var-progress')).toContainText('saved listing draft');
  await expect(page.locator('#e-ltype')).toHaveValue('physical');
  await expect(page.locator('#variations-card')).toBeVisible();
  await expect(page.locator('#variations-card')).toContainText('Small');
  await expect(page.locator('#variations-card')).toContainText('Glossy');
  await expect(page.locator('#e-price')).toHaveValue('25');
  await expect(page.locator('#e-shipping')).toHaveValue('148610403760');
  await expect(page.locator('#e-readiness')).toHaveValue('1405042501851');
  await expect(page.locator('#taxonomy-select-wrap-label')).toContainText('Drawing & Illustration');
  await expect(page.getByRole('button', { name: 'Create Etsy draft' })).toHaveCount(1);
  expect(serverDraft.listingType).toBe('physical');
  expect(serverDraft.taxonomy_id).toBe(77);
  expect(serverDraft.shipping_profile_id).toBe(148610403760);
  expect(serverDraft.readiness_state_id).toBe(1405042501851);
  expect(serverDraft.variations.products).toHaveLength(4);
  expect(serverDraft.variations.products.map(product => product.price)).toEqual([25, 30, 35, 40]);

  await page.evaluate(() => window.closeAgentFloat());
  await page.evaluate(() => window.navigate('dashboard'));
  await page.evaluate(() => window.navigate('create'));
  await page.evaluate(() => window.restoreDraft());
  await expect(page.locator('#e-ltype')).toHaveValue('physical');
  await expect(page.locator('#variations-card')).toContainText('Large');
  await expect(page.locator('#e-shipping')).toHaveValue('148610403760');
  await expect(page.locator('#e-readiness')).toHaveValue('1405042501851');

  await page.getByRole('button', { name: 'Create Etsy draft' }).click();
  await expect.poll(() => etsyWrites.length).toBeGreaterThanOrEqual(2);
  const createRequest = etsyWrites.find(request => request.action === 'createListing');
  const inventoryRequest = etsyWrites.find(request => request.action === 'updateListingInventory');
  expect(createRequest).toMatchObject({
    listing_type: 'physical',
    taxonomy_id: 77,
    shipping_profile_id: '148610403760',
    readiness_state_id: '1405042501851',
    price: 25,
  });
  expect(inventoryRequest.readiness_state_id).toBe('1405042501851');
  expect(inventoryRequest.products.map(product => product.offerings[0].price)).toEqual([25, 30, 35, 40]);
  await expect(page.getByRole('button', { name: 'Continue editing in Etsy AI Command Center' })).toBeVisible();
  await expect(page.getByText('Etsy listing ID 987654321')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View this listing on Etsy' })).toHaveAttribute('href', 'https://www.etsy.com/listing/987654321');
});

test('agent applies variations and personalization to an existing Etsy listing after approval', async ({ page }) => {
  const writes = [];
  let savedInventory = null;
  let savedPersonalization = null;
  await page.route('**/api/etsy**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().method() === 'POST' ? (route.request().postDataJSON?.() || {}) : {};
    const action = body.action || url.searchParams.get('action');
    if (['updateListingInventory', 'updateListingPersonalization'].includes(action)) writes.push(body);
    if (action === 'updateListingInventory') savedInventory = { products: body.products || [] };
    if (action === 'updateListingPersonalization') savedPersonalization = { personalization_questions: body.personalization_questions || [] };
    if (action === 'getListingInventory') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: savedInventory || { products: [] } }) });
    }
    if (action === 'getListingPersonalization') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: savedPersonalization || { personalization_questions: [] } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { results: [], products: body.products || [] } }) });
  });
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({
      type: 'done',
      message: 'The listing options are ready for approval.',
      pending_variations: {
        target_type: 'etsy_listing',
        listing_id: 4540982802,
        listing_title: 'Custom Video Restoration Service',
        listing_type: 'physical',
        current_listing_type: 'physical',
        base_price: 30,
        taxonomy_id: 77,
        shipping_profile_id: 148610403760,
        readiness_state_id: 1405042501863,
        properties: [
          { name: 'Video length', pricing_mode: 'final_price', options: [{ name: 'Up to 1 minute', amount: 30 }, { name: 'Up to 2 minutes', amount: 37 }] },
          { name: 'Colorization', pricing_mode: 'surcharge', options: [{ name: 'Restoration only', amount: 0 }, { name: 'Add colorization', amount: 5 }] },
        ],
        personalization_questions: [
          { question_type: 'file_upload', question_text: 'Upload your source files', required: true, max_allowed_files: 10 },
          { question_type: 'text_input', question_text: 'Describe the people and requested result', required: true, max_allowed_characters: 1024 },
        ],
      },
    })}\n\n`,
  }));

  await page.locator('#agent-fab').click();
  const mini = page.locator('#float-agent-host');
  await expect(mini.locator('#agent-input')).toBeVisible();
  await mini.locator('#agent-input').fill('Add variations and personalization to listing 4540982802');
  await mini.locator('#agent-send-btn').click();

  await expect(mini.getByText('Custom Video Restoration Service')).toBeVisible();
  await expect(mini.getByText('Colorization surcharge')).toBeVisible();
  await expect(mini.getByText('Final prices sent to Etsy · 4 combinations')).toBeVisible();
  await expect(mini.getByText('Upload your source files')).toBeVisible();
  await expect(mini.getByRole('button', { name: 'Apply to Etsy listing' })).toBeVisible();
  await expect(mini.locator('#var-result-actions')).toBeHidden();
  expect(writes).toHaveLength(0);

  await mini.getByRole('button', { name: 'Apply to Etsy listing' }).click();
  await expect.poll(() => writes.length).toBe(2);
  const inventory = writes.find(write => write.action === 'updateListingInventory');
  const personalization = writes.find(write => write.action === 'updateListingPersonalization');
  expect(inventory.listing_id).toBe(4540982802);
  expect(inventory.products.map(product => product.offerings[0].price)).toEqual([30, 35, 37, 42]);
  expect(inventory.products.every(product => product.offerings[0].readiness_state_id === 1405042501863)).toBe(true);
  expect(personalization).toMatchObject({ listing_id: 4540982802 });
  expect(personalization.personalization_questions).toHaveLength(2);
  await expect(mini.locator('#var-progress')).toContainText('updated successfully');
  await expect(mini.getByRole('button', { name: 'Verify changes' })).toBeVisible();
  await expect(mini.getByRole('button', { name: 'Open in Etsy AI Command Center' })).toBeVisible();
  await mini.getByRole('button', { name: 'Verify changes' }).click();
  await expect(mini.locator('#var-progress')).toContainText('Verified on Etsy: 4 combinations');
  await mini.getByRole('button', { name: 'Open in Etsy AI Command Center' }).click();
  await expect(page).toHaveURL(/#create\?id=4540982802/);
});

test('legacy empty personalization plan updates only variations', async ({ page }) => {
  const writes = [];
  await page.route('**/api/etsy**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().method() === 'POST' ? (route.request().postDataJSON?.() || {}) : {};
    const action = body.action || url.searchParams.get('action');
    if (action?.startsWith('updateListing')) writes.push(body);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { products: body.products || [] } }) });
  });
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({
      type: 'done',
      message: 'Variation preview ready.',
      pending_variations: {
        target_type: 'etsy_listing',
        listing_id: 4540982802,
        listing_title: 'Custom Video Restoration Service',
        listing_type: 'physical',
        current_listing_type: 'physical',
        base_price: 30,
        taxonomy_id: 77,
        shipping_profile_id: 148610403760,
        readiness_state_id: 1405042501863,
        properties: [
          { name: 'Video length', options: [{ name: 'Up to 1 minute', price: 30 }, { name: 'Up to 2 minutes', price: 40 }] },
          { name: 'Colorization', options: [
            { name: 'Restoration only', price: 30, price_adjustment: 0 },
            { name: 'Add colorization', price: 30, price_adjustment: 10 },
          ] },
        ],
        personalization_questions: [],
      },
    })}\n\n`,
  }));

  await page.locator('#agent-fab').click();
  const mini = page.locator('#float-agent-host');
  await mini.locator('#agent-input').fill('Update the variation prices');
  await mini.locator('#agent-send-btn').click();
  await expect(mini.getByText('Colorization surcharge')).toBeVisible();
  await expect(mini.getByText('Final prices sent to Etsy · 4 combinations')).toBeVisible();
  await mini.getByRole('button', { name: 'Apply to Etsy listing' }).click();

  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].action).toBe('updateListingInventory');
  expect(writes[0].products.map(product => product.offerings[0].price)).toEqual([30, 40, 40, 50]);
  await expect(mini.locator('#var-progress')).toContainText('variations and prices updated successfully');
});
