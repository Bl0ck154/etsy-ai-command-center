// AI Agent tests — conversational interface responds, tool use works
import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__agentTestStorageKey = (key) => {
      const normalize = (value, fallback) => {
        const normalized = String(value || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 80);
        return normalized || fallback;
      };
      let userId = 'anonymous';
      let shopId = 'default_shop';
      try {
        userId = JSON.parse(sessionStorage.getItem('etsy_mgr_auth_user') || 'null')?.id || userId;
        shopId = sessionStorage.getItem('etsy_mgr_active_shop') || shopId;
      } catch {}
      return `${String(key || '')}::${normalize(userId, 'anonymous')}:${normalize(shopId, 'default_shop')}`;
    };
  });
  await page.route('**/api/auth**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true }) }));
  await page.route('**/api/login**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, success: true }) }));
  await page.route('**/pages/agent.js*', route => route.fulfill({ path: 'public/pages/agent.js', contentType: 'application/javascript' }));
  await page.route('**/pages/create.js*', route => route.fulfill({ path: 'public/pages/create.js', contentType: 'application/javascript' }));
  await page.route('**/components/image-prompt.js*', route => route.fulfill({ path: 'public/components/image-prompt.js', contentType: 'application/javascript' }));
  await page.route('**/utils/api.js*', route => route.fulfill({ path: 'public/utils/api.js', contentType: 'application/javascript' }));
  await page.route('**/utils/agent-format.js*', route => route.fulfill({ path: 'public/utils/agent-format.js', contentType: 'application/javascript' }));
  await page.route('**/utils/image-store.js*', route => route.fulfill({ path: 'public/utils/image-store.js', contentType: 'application/javascript' }));
  await page.route('**/utils/agent-progress.js*', route => route.fulfill({ path: 'public/utils/agent-progress.js', contentType: 'application/javascript' }));
  await page.route('**/utils/agent-runtime-contract.js*', route => route.fulfill({ path: 'public/utils/agent-runtime-contract.js', contentType: 'application/javascript' }));
  await page.route('**/style.css*', route => route.fulfill({ path: 'public/style.css', contentType: 'text/css' }));
  await page.goto('/#agent');
  await expect(page.locator('.sidebar-brand')).toBeVisible();
  await expect(page.locator('#agent-input')).toBeVisible({ timeout: 10_000 });
});

test('retry on an image message reuses the same image context', async ({ page }) => {
  const mediaCalls = [];
  const agentCalls = [];
  const listingJobCalls = [];
  const listingResult = {
    title: 'Retro Floral Printable Design for Etsy',
    description: 'Generated listing body.',
    tags: ['retro floral', 'printable art'],
    materials: ['digital download'],
    price_suggestion: 7,
  };
  await page.route('**/api/media', async route => {
    mediaCalls.push(route.request().postDataJSON?.() || {});
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ analysis: 'Bright retro floral digital pattern for a printable Etsy design.' }),
    });
  });
  await page.route('**/api/agent', async route => {
    const body = route.request().postDataJSON?.() || {};
    agentCalls.push(body);
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"done","message":"Listing draft is ready.","pending_generate_listing":{"description":"retro floral printable design","listing_type":"download","price":7,"attached_image_role":"reference"}}\n\n',
    });
  });
  await page.route('**/api/jobs**', route => {
    if (route.request().method() === 'POST') {
      listingJobCalls.push(route.request().postDataJSON?.() || {});
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: `listing-job-${listingJobCalls.length}` }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'done', result: listingResult }) });
  });

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
  await page.locator('#agent-img-file').setInputFiles({
    name: 'design.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await page.locator('#agent-input').fill('Generate a listing that will sell this design');
  await page.locator('#agent-send-btn').click();

  await expect.poll(() => mediaCalls.length, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => agentCalls.length, { timeout: 30_000 }).toBe(1);
  expect(agentCalls[0]?.context?.attached_image?.analysis).toContain('Bright retro floral digital pattern');
  expect(agentCalls[0]?.context?.attached_image?.available_as_original_listing_image).toBe(true);
  expect(agentCalls[0]?.context?.attached_image?.available_as_reference_image).toBe(true);
  await expect(page.locator('#agent-messages')).toContainText('Attached image will be used as the visual reference', { timeout: 30_000 });
  await expect(page.locator('#agent-messages')).not.toContainText('Attached image will be added to the draft unchanged');

  await page.evaluate(() => {
    const messages = JSON.parse(sessionStorage.getItem(window.__agentTestStorageKey('agent_history')) || '[]');
    const user = messages.find(msg => msg.role === 'user' && msg._imgData?.preview);
    if (user) user._imgData = { preview: user._imgData.preview };
    sessionStorage.setItem(window.__agentTestStorageKey('agent_history'), JSON.stringify(messages));
  });
  await page.reload();
  await expect(page.locator('#agent-input')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Retry' }).first().click();

  await expect.poll(() => mediaCalls.length, { timeout: 30_000 }).toBe(2);
  await expect.poll(() => agentCalls.length, { timeout: 30_000 }).toBe(2);
  expect(mediaCalls[1]).toMatchObject({
    action: 'analyzeImage',
    referenceImage: {
      mimeType: 'image/jpeg',
    },
  });
  expect(mediaCalls[1].referenceImage.base64?.length || 0).toBeGreaterThan(20);
  expect(agentCalls[1]?.context?.attached_image?.analysis).toContain('Bright retro floral digital pattern');
  expect(listingJobCalls).toHaveLength(2);
  expect(listingJobCalls.every(call => call.action === 'startListingGeneration')).toBe(true);
  await expect(page.locator('#agent-messages')).toContainText('Attached image will be used as the visual reference', { timeout: 30_000 });
  await expect(page.locator('#agent-messages')).not.toContainText('Attached image will be added to the draft unchanged');
});

test('agent input and send button visible', async ({ page }) => {
  await expect(page.locator('#agent-input')).toBeVisible();
  await expect(page.locator('#agent-send-btn')).toBeVisible();
});

test('local gallery and agent history stay isolated between authenticated users', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const scope = await import('/utils/user-scope.js');
    const store = await import('/utils/image-store.js');
    const { history } = await import('/utils/idb.js');
    const agent = await import('/pages/agent.js');
    const originalUser = scope.currentAuthUser();
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

    scope.setCurrentAuthUser({ id: 'admin-a', name: 'Admin A' });
    const imageA = await store.saveImage({ base64, mimeType: 'image/png', prompt: 'A', slotLabel: 'Cover A' });
    await history.set('shared-logical-session', [{ role: 'assistant', content: 'Private A' }]);
    agent.setAgentModel('external');
    localStorage.setItem(scope.scopedClientKey('agent_memory_items'), JSON.stringify([{ id: 'memory-a', text: 'Private A memory' }]));

    scope.setCurrentAuthUser({ id: 'admin-b', name: 'Admin B' });
    const aImageVisibleToB = Boolean(await store.getImage(imageA));
    const aHistoryVisibleToB = await history.get('shared-logical-session');
    const aMemoryVisibleToB = agent.loadMemories();
    const modelBeforeBChoice = agent.getAgentModel();
    const imageB = await store.saveImage({ base64, mimeType: 'image/png', prompt: 'B', slotLabel: 'Cover B' });
    await history.set('shared-logical-session', [{ role: 'assistant', content: 'Private B' }]);
    agent.setAgentModel('gemini');
    localStorage.setItem(scope.scopedClientKey('agent_memory_items'), JSON.stringify([{ id: 'memory-b', text: 'Private B memory' }]));
    const bImages = (await store.getLocalImages()).map(image => image.id);

    scope.setCurrentAuthUser({ id: 'admin-a', name: 'Admin A' });
    const aImages = (await store.getLocalImages()).map(image => image.id);
    const aHistory = await history.get('shared-logical-session');
    const aMemory = agent.loadMemories();
    const aModel = agent.getAgentModel();
    scope.setCurrentAuthUser(originalUser);

    return { imageA, imageB, aImageVisibleToB, aHistoryVisibleToB, aMemoryVisibleToB, modelBeforeBChoice, aImages, bImages, aHistory, aMemory, aModel };
  });

  expect(result.aImageVisibleToB).toBe(false);
  expect(result.aHistoryVisibleToB).toBeNull();
  expect(result.aMemoryVisibleToB).toEqual([]);
  expect(result.modelBeforeBChoice).toBe('auto');
  expect(result.aImages).toEqual([result.imageA]);
  expect(result.bImages).toEqual([result.imageB]);
  expect(result.aHistory).toEqual([{ role: 'assistant', content: 'Private A' }]);
  expect(result.aMemory).toEqual([{ id: 'memory-a', text: 'Private A memory' }]);
  expect(result.aModel).toBe('external');
});

test('mini agent shares durable turns, attachments, and action cards with full-screen agent', async ({ page }) => {
  await page.route('**/api/agent', async route => {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"done","message":"The listing update preview is ready.","pending_updates":{"summary":"Rewrite title and tags","updates":[{"listing_id":123456789,"listing_title":"Watercolor Family Portrait","state":"active","title_current":"Old title","title":"New SEO title","tags_current":["old"],"tags":["new","portrait"]}]}}\n\n',
    });
  });

  await page.evaluate(() => window.navigate('dashboard'));
  await expect(page.locator('#agent-fab')).toBeVisible();
  await page.locator('#agent-fab').click();
  await expect(page.locator('.agent-float-title')).toHaveText('Shop agent');
  await expect(page.getByRole('button', { name: 'Open full agent' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close agent' })).toBeVisible();
  await expect(page.locator('#agent-float-panel')).not.toContainText('Expand');

  const mini = page.locator('#float-agent-host');
  await expect(mini.locator('#agent-input')).toBeVisible();
  await expect(mini.locator('#agent-img-file')).toBeAttached();
  await expect(mini.locator('#agent-history-btn')).toBeVisible();
  await expect(mini.locator('#agent-clear-btn')).toBeVisible();

  await mini.locator('#agent-input').fill('Prepare a listing update preview');
  await mini.locator('#agent-send-btn').click();
  await expect(mini.locator('#agent-loading')).toBeVisible();
  await page.evaluate(() => window.closeAgentFloat());
  await page.evaluate(() => window.toggleAgentFloat());

  await expect(mini.locator('#agent-loading')).toBeVisible();
  await expect(mini).toContainText('The listing update preview is ready.', { timeout: 15_000 });
  await expect(mini.getByRole('button', { name: /Approve preview/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const messages = JSON.parse(sessionStorage.getItem(window.__agentTestStorageKey('agent_history')) || '[]');
    return messages.some(message => message.pending_updates?.summary === 'Rewrite title and tags');
  })).toBe(true);

  await page.getByRole('button', { name: /Open full agent/ }).click();
  await expect(page.locator('#main-area #agent-input')).toBeVisible();
  await expect(page.locator('#main-area')).toContainText('The listing update preview is ready.');
  await expect(page.locator('#main-area').getByRole('button', { name: /Approve preview/ })).toBeVisible();

  await page.reload();
  await expect(page.locator('#main-area')).toContainText('The listing update preview is ready.');
  await expect(page.locator('#main-area').getByRole('button', { name: 'Expired' })).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 760 });
  await page.evaluate(() => window.navigate('dashboard'));
  await page.locator('#agent-fab').click();
  await expect(page.locator('#float-agent-host #agent-input')).toBeVisible();
  const panelFits = await page.locator('#agent-float-panel').evaluate(panel => {
    const rect = panel.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
  });
  expect(panelFits).toBe(true);
});

test('agent top bar stays usable on mobile', async ({ page }) => {
  await expect(page.locator('.agent-model-switcher')).toContainText('Model');
  const desktopFits = await page.locator('.agent-topbar-card').evaluate(el => {
    const card = el.getBoundingClientRect();
    const parent = el.parentElement?.getBoundingClientRect();
    return Boolean(parent && card.left >= parent.left - 1 && card.right <= parent.right + 1);
  });
  expect(desktopFits).toBe(true);
  await page.setViewportSize({ width: 390, height: 760 });
  await expect(page.locator('.agent-topbar-card')).toBeVisible();
  await expect(page.locator('.agent-topbar-card')).not.toContainText('provider for Etsy actions');
  await expect(page.locator('#agent-model-select')).toBeVisible();
  await expect(page.locator('#agent-memory-btn')).toBeVisible();
  await expect(page.locator('#agent-history-btn')).toBeVisible();
  await expect(page.locator('#agent-clear-btn')).toBeVisible();
  const fits = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.agent-topbar-card, .agent-topbar-card *')];
    return nodes.every(node => {
      const rect = node.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= window.innerWidth + 1;
    });
  });
  expect(fits).toBe(true);
});

test('agent welcome cards disappear after first message', async ({ page }) => {
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: 'data: {"type":"done","message":"Mock assistant reply."}\n\n',
  }));
  await expect(page.locator('.agent-welcome')).toBeVisible();
  await expect(page.locator('.agent-welcome')).toContainText('What I can do');
  await expect(page.locator('.agent-welcome')).toContainText('Important rules');
  await page.locator('#agent-input').fill('hello');
  await page.locator('#agent-send-btn').click();
  await expect(page.locator('.agent-welcome')).toHaveCount(0);
  await expect(page.locator('#agent-chips')).toBeEmpty();
});

test('agent loading status follows real model and tool lifecycle events', async ({ page }) => {
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url;
      if (url !== '/api/agent') return originalFetch(input, init);

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const send = event => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          send({ type: 'model', provider: 'external', model: 'gpt-5.4' });
          setTimeout(() => send({
            type: 'tool',
            name: 'analyze_listing_images',
            message: 'Аналіз зображень лістингу',
          }), 500);
          setTimeout(() => {
            send({
              type: 'tool_result',
              name: 'analyze_listing_images',
              message: 'Аналіз зображень лістингу',
              duration_ms: 2300,
              status: 'ok',
            });
            send({ type: 'model', provider: 'external', model: 'gpt-5.4' });
          }, 1000);
          setTimeout(() => {
            send({ type: 'done', message: 'Готово.' });
            controller.close();
          }, 4000);
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    };
  });

  await page.locator('#agent-input').fill('Перевір фото');
  await page.locator('#agent-send-btn').click();

  await expect(page.locator('#agent-tool-status')).toContainText('gpt-5.4');
  await expect(page.locator('#agent-progress-history')).toContainText('✓ Аналіз зображень лістингу · 2s');
  await expect(page.locator('#agent-loading')).toHaveCount(0);
  await expect(page.locator('#agent-messages')).toContainText('Готово.');
});

test('agent keeps an active turn when navigating to Settings and back', async ({ page }) => {
  await page.route('**/api/jobs**', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'done',
        updated_at: Date.now(),
        result: { type: 'done', message: 'Finished after navigation.' },
      }),
    });
  });
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url;
      if (url !== '/api/agent') return originalFetch(input, init);

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"model","provider":"external","model":"test-model"}\\n\\n'));
          window.__finishActiveAgentTurn = () => {
            window.__finishedAfterNavigation = true;
            controller.enqueue(encoder.encode('data: {"type":"done","message":"Finished after navigation."}\\n\\n'));
            controller.close();
          };
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    };
  });

  await page.locator('#agent-input').fill('Keep this request running');
  await page.locator('#agent-send-btn').click();
  await expect(page.locator('#agent-loading')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.__finishActiveAgentTurn)).toBe('function');

  // The remounted page must not overwrite the just-sent message with a stale
  // IndexedDB copy while the same in-memory SSE request continues.
  await page.evaluate(async () => {
    const sessionId = sessionStorage.getItem(window.__agentTestStorageKey('agent_current_session'));
    const { history } = await import('/utils/idb.js');
    await history.set(`agent_session_${sessionId}`, [{ role: 'assistant', content: 'Stale stored history.' }]);
  });

  await page.locator('.nav-item[data-page="settings"]').click();
  await expect(page.locator('#agent-input')).toHaveCount(0);
  await page.locator('.nav-item[data-page="agent"]').click();

  await expect(page.locator('#agent-input')).toBeVisible();
  await expect(page.locator('#agent-messages')).toContainText('Keep this request running');
  await expect(page.locator('#agent-loading')).toBeVisible();

  await page.evaluate(() => window.__finishActiveAgentTurn());
  await expect(page.locator('#agent-messages')).toContainText('Finished after navigation.');
  await expect(page.locator('#agent-send-btn')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem(window.__agentTestStorageKey('agent_history')) || '[]').map(m => m.content))).toContain('Finished after navigation.');
});

test('client app faults are runtime context, not synthetic assistant history or local repair advice', async ({ page }) => {
  const agentCalls = [];
  const faultAuditCalls = [];
  await page.route('**/api/jobs**', async route => {
    const body = route.request().postDataJSON?.() || {};
    if (body.action === 'recordAgentRuntimeFault') {
      faultAuditCalls.push(body);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { recorded: true } }) });
    }
    return route.continue();
  });
  await page.route('**/api/agent', async route => {
    const body = route.request().postDataJSON?.() || {};
    agentCalls.push(body);
    if (agentCalls.length === 1) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'QuotaExceededError: temporary storage quota exceeded' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"done","message":"I kept the workflow state and can continue from the app fault."}\n\n',
    });
  });

  await page.locator('#agent-input').fill('Attach the saved previews');
  await page.locator('#agent-send-btn').click();
  await expect(page.locator('.agent-message-wrap-runtime')).toContainText('APP_STORAGE_QUOTA');
  await expect(page.locator('.agent-message-wrap-runtime')).not.toContainText(/clear data|DevTools|delete browser/i);
  await expect.poll(() => faultAuditCalls.length).toBe(1);
  expect(faultAuditCalls[0]).toMatchObject({
    action: 'recordAgentRuntimeFault',
    fault: { code: 'APP_STORAGE_QUOTA', fault_domain: 'application', user_action_required: false },
  });

  await page.locator('#agent-input').fill('Continue the operation');
  await page.locator('#agent-send-btn').click();
  await expect.poll(() => agentCalls.length).toBe(2);
  expect(agentCalls[1].messages.map(message => message.role)).toEqual(['user', 'user']);
  expect(agentCalls[1].context.agent_runtime_events).toHaveLength(1);
  expect(agentCalls[1].context.agent_runtime_events[0].fault).toMatchObject({
    code: 'APP_STORAGE_QUOTA',
    fault_domain: 'application',
    user_action_required: false,
  });
  await expect(page.locator('#agent-messages')).toContainText('I kept the workflow state');
});

test('required listing transition generates the matching draft and resumes approved image attach', async ({ page }) => {
  const workflowId = 'listing_flow_browser_test';
  const savedImageId = await page.evaluate(async () => {
    const { saveImage } = await import('/utils/image-store.js');
    return saveImage({
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      prompt: 'Saved listing preview',
      slotLabel: 'Cover',
    });
  });
  const listingResult = {
    title: 'Photo Restoration Service Listing',
    description: 'Professional photo restoration listing description.',
    tags: ['photo restoration', 'photo repair'],
    materials: ['digital service'],
    price_suggestion: 25,
  };
  await page.route('**/api/jobs**', async route => {
    const body = route.request().method() === 'POST' ? (route.request().postDataJSON?.() || {}) : {};
    if (body.action === 'recordAgentRuntimeFault') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { recorded: true } }) });
    }
    if (body.action === 'startListingGeneration') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'job_listing_workflow_browser' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'done', result: listingResult }) });
  });
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({
      type: 'done',
      message: 'Creating the missing listing draft and then attaching the saved previews.',
      pending_generate_listing: {
        description: 'Photo restoration service with two listing examples',
        listing_type: 'download',
        workflow_id: workflowId,
        workflow_state: 'listing_content_generating',
        after_generation: 'attach_active_image_plan',
      },
    })}\n\n`,
  }));

  await page.evaluate(({ imageId, workflow }) => {
    const messages = [
      { role: 'user', content: 'Create listing images for my photo restoration service.' },
      {
        role: 'assistant',
        content: 'The image preview is ready.',
        pending_listing_images: {
          listing_id: 'draft',
          listing_title: 'Photo Restoration Service',
          workflow_id: workflow,
          workflow_state: 'image_previews_ready',
          mode: 'add',
          count: 1,
          prompt: 'Professional photo restoration Etsy listing image',
          slots: [{ purpose: 'Cover', visual_prompt: 'Professional restored portrait preview', alt_text: 'Restored portrait preview' }],
          generated_images: [{ id: imageId, mimeType: 'image/png', rank: 1 }],
          status: 'generated',
        },
      },
    ];
    sessionStorage.setItem(window.__agentTestStorageKey('agent_history'), JSON.stringify(messages));
  }, { imageId: savedImageId, workflow: workflowId });
  await page.reload();
  await expect(page.locator('#agent-input')).toBeVisible({ timeout: 10_000 });

  await page.locator('#agent-input').fill('Attach those previews and create the listing');
  await page.locator('#agent-send-btn').click();

  await expect(page.locator('#agent-draft-ready-banner')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#image-uploader-wrap .img-thumb')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('main')).not.toContainText(/clear data|DevTools|browser storage/i);
});

test('agent resumes a server-tracked turn after reload without rerunning the request', async ({ page }) => {
  let statusPolls = 0;
  await page.route('**/api/jobs**', route => {
    statusPolls += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'done',
        updated_at: 123,
        result: { type: 'done', message: 'Recovered from the server job.' },
      }),
    });
  });
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url;
      if (url !== '/api/agent') return originalFetch(input, init);
      return Promise.resolve(new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    };
  });

  await page.locator('#agent-input').fill('Do not lose this request on reload');
  await page.locator('#agent-send-btn').click();
  await expect(page.locator('#agent-loading')).toBeVisible();
  await page.reload();

  await expect(page.locator('#agent-messages')).toContainText('Do not lose this request on reload');
  await expect(page.locator('#agent-messages')).toContainText('Recovered from the server job.');
  await expect(page.locator('#agent-send-btn')).toBeEnabled();
  expect(statusPolls).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem(window.__agentTestStorageKey('agent_history')) || '[]').filter(m => m.content === 'Recovered from the server job.').length)).toBe(1);
});

test('listing draft job is saved before a delayed server start can trigger a chat rerender', async ({ page }) => {
  const starts = [];
  const listingResult = {
    title: 'Durable Custom Portrait Listing',
    description: 'A listing draft that survives the handoff from the agent turn to its server job.',
    tags: ['custom portrait', 'digital keepsake'],
    materials: ['digital file'],
    price_suggestion: 19,
  };
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: 'data: {"type":"done","message":"Preparing your listing draft.","pending_generate_listing":{"description":"custom portrait keepsake","listing_type":"download","price":19}}\n\n',
  }));
  await page.route('**/api/jobs**', async route => {
    const body = route.request().postDataJSON?.() || {};
    if (route.request().method() === 'POST') {
      starts.push(body);
      await new Promise(resolve => setTimeout(resolve, 800));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: body.job_id }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'done', result: listingResult }) });
  });

  await page.locator('#agent-input').fill('Create a custom portrait keepsake listing');
  await page.locator('#agent-send-btn').click();

  await expect.poll(() => page.evaluate(() => {
    const messages = JSON.parse(sessionStorage.getItem(window.__agentTestStorageKey('agent_history')) || '[]');
    return messages.find(message => message.pending_generate_listing)?.pending_generate_listing?.generation_job_id || '';
  })).toMatch(/^job_listing_/);
  await page.waitForTimeout(300);
  await expect(page.locator('#agent-messages')).not.toContainText('Draft generation was interrupted');
  await expect(page.locator('#agent-open-created-draft-btn')).toBeVisible({ timeout: 20_000 });
  expect(starts).toHaveLength(1);
  expect(starts[0].job_id).toMatch(/^job_listing_/);
});

test('restored agent progress starts its visible stage timer from zero', async ({ page }) => {
  const updatedAt = Date.now();
  await page.route('**/api/jobs**', async route => {
    await new Promise(resolve => setTimeout(resolve, 800));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      status: 'running',
      updated_at: updatedAt,
      last_event: { type: 'model', provider: 'external', model: 'codex/gpt-5.6-terra-medium' },
    }) });
  });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem(window.__agentTestStorageKey('agent_current_session')) || '')).not.toBe('');
  await page.evaluate(() => {
    const sessionId = sessionStorage.getItem(window.__agentTestStorageKey('agent_current_session'));
    sessionStorage.setItem(window.__agentTestStorageKey('agent_active_turn'), JSON.stringify({
      id: 'job_agent_restored_timer',
      session_id: sessionId,
      text: 'Keep working in the background',
      started_at: Date.now() - 851_000,
      progress_at: Date.now() - 851_000,
      stage: 'Thinking',
      progress: { type: 'model', provider: 'external', model: 'codex/gpt-5.6-terra-medium' },
      runtime_active: false,
    }));
  });

  await page.reload();
  await expect(page.locator('#agent-tool-status')).toContainText('codex/gpt-5.6-terra-medium');
  await expect(page.locator('#agent-tool-status')).toContainText('0s');
  await expect(page.locator('#agent-tool-status')).not.toContainText('14:11');
  await page.evaluate(() => {
    const actualNow = Date.now.bind(Date);
    Date.now = () => actualNow() + 981_000;
  });
  await page.waitForTimeout(1_100);
  await expect(page.locator('#agent-tool-status')).not.toContainText('16:21');
});

test('agent response remains visible after leaving and returning to the chat mid-turn', async ({ page }) => {
  await page.route('**/api/agent', async route => {
    await new Promise(resolve => setTimeout(resolve, 1_200));
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"done","message":"Background agent response completed."}\n\n',
    });
  });

  await page.locator('#agent-input').fill('Finish this while I open settings');
  await page.locator('#agent-send-btn').click();
  await expect(page.locator('#agent-loading')).toBeVisible();
  await page.evaluate(() => window.navigate('settings'));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.navigate('agent'));

  await expect(page.locator('#agent-loading')).toBeVisible();
  await expect(page.locator('#agent-messages')).toContainText('Background agent response completed.', { timeout: 15_000 });
  await expect(page.locator('#agent-send-btn')).toBeEnabled();
});

test('agent generated listing opens create page already filled without old loading pipeline', async ({ page }) => {
  const generationCalls = [];
  const listingResult = {
    title: 'Custom Cinematic Anniversary Love Story Video, Movie Trailer Gift from Photos',
    description: 'Agent-generated listing copy that should arrive on the Create page already filled and ready to review.',
    tags: ['love story video', 'anniversary gift', 'custom video', 'photo slideshow', 'digital gift', 'valentine video', 'movie trailer', 'gift for him', 'romantic video', 'photo video', 'custom trailer', 'wedding video', 'couple gift'],
    materials: ['digital video'],
    price_suggestion: 15,
  };
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: 'data: {"type":"done","message":"Чернетка лістинга готується.","pending_generate_listing":{"description":"cinematic anniversary video","listing_type":"download","price":15,"extra":"premium romantic tone"}}\n\n',
  }));
  await page.route('**/api/jobs**', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON?.() || {};
      generationCalls.push({ type: 'listing_job', body });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'listing-job-create' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'done', result: listingResult }) });
  });
  await page.route('**/api/media', route => {
    generationCalls.push({ type: 'media' });
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'cover should not auto-generate for agent draft' }) });
  });
  await page.route('**/api/etsy**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }));

  await page.locator('#agent-input').fill('створи лістинг для cinematic anniversary video');
  await page.locator('#agent-send-btn').click();
  await expect(page.locator('#agent-open-created-draft-btn')).toBeVisible({ timeout: 30_000 });
  expect(generationCalls.filter(call => call.type === 'listing_job')).toHaveLength(1);
  expect(generationCalls[0].body.action).toBe('startListingGeneration');
  await page.locator('#agent-open-created-draft-btn').click();
  await expect(page.locator('#agent-draft-ready-banner')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#ai-listing-loading-banner')).toHaveCount(0);
  await expect(page.locator('#gen-progress-bar')).toHaveCount(0);
  await expect(page.locator('#e-title')).toHaveValue(/Custom Cinematic Anniversary/);
  await expect(page.locator('#e-desc')).toHaveValue(/already filled and ready to review/);
  await expect(page.locator('#tags-count')).toContainText('13/13');
  await expect(page.locator('#auto-gen-cover')).not.toBeChecked();
  await page.waitForTimeout(500);
  expect(generationCalls).toHaveLength(1);
});

test('existing listing content generation becomes an approval card for the same Etsy ID', async ({ page }) => {
  const listingId = 4540982802;
  const writes = [];
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({
      type: 'done',
      message: 'Preparing an optimized version for review.',
      pending_generate_listing: {
        target_type: 'etsy_listing',
        listing_id: listingId,
        listing_title: 'Current Photo Restoration Service',
        description: 'Current factual product description.',
        listing_type: 'physical',
        price: 30,
        current_values: {
          title: 'Current Photo Restoration Service',
          description: 'Current factual product description.',
          tags: ['photo restoration'],
          price: 30,
        },
      },
    })}\n\n`,
  }));
  await page.route('**/api/jobs**', route => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'listing-job-existing-update' }) });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'done',
        result: {
          title: 'Professional Custom Photo Restoration and Repair Service',
          description: 'Restore damaged family photographs with a clear, buyer-friendly custom service process.',
          tags: ['photo restoration', 'photo repair', 'restore old photo'],
          materials: ['digital service'],
          price_suggestion: 30,
        },
      }),
    });
  });
  await page.route('**/api/etsy**', async route => {
    const body = route.request().method() === 'POST' ? (route.request().postDataJSON?.() || {}) : {};
    if (body.action === 'updateListing') writes.push(body);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) });
  });

  await page.locator('#agent-input').fill(`Optimize listing ${listingId}`);
  await page.locator('#agent-send-btn').click();
  await expect(page.getByRole('link', { name: 'Current Photo Restoration Service' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Approve preview & apply/ })).toBeVisible();
  await expect(page.locator('#agent-open-created-draft-btn')).toHaveCount(0);
  expect(writes).toHaveLength(0);

  await page.getByRole('button', { name: /Approve preview & apply/ }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    listing_id: listingId,
    title: 'Professional Custom Photo Restoration and Repair Service',
  });
});

test('duplicate retry applies remaining changes without creating another listing', async ({ page }) => {
  const etsyCalls = [];
  let updateAttempts = 0;
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: 'data: {"type":"done","message":"Duplicate preview is ready.","pending_duplicate":{"source_listing_id":4540982802,"source_title":"Photo restoration service","title":"Updated photo restoration service","changes_summary":"Duplicate and update title"}}\n\n',
  }));
  await page.route('**/api/etsy', async route => {
    const body = route.request().postDataJSON?.() || {};
    etsyCalls.push(body);
    if (body.action === 'duplicateListing') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { listing_id: 4999000111 } }) });
    }
    if (body.action === 'updateListing') {
      updateAttempts += 1;
      if (updateAttempts === 1) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary Etsy failure' }) });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { listing_id: 4999000111 } }) });
    }
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected action' }) });
  });

  await page.locator('#agent-input').fill('Duplicate this listing and update its title');
  await page.locator('#agent-send-btn').click();
  await page.getByRole('button', { name: 'Create duplicate' }).click();
  await expect(page.getByRole('button', { name: 'Retry remaining changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry remaining changes' }).click();
  await expect(page.locator('#agent-messages')).toContainText('Created listing 4999000111');

  expect(etsyCalls.filter(call => call.action === 'duplicateListing')).toHaveLength(1);
  expect(etsyCalls.filter(call => call.action === 'updateListing')).toHaveLength(2);
  expect(etsyCalls.filter(call => call.action === 'updateListing').every(call => call.listing_id === 4999000111)).toBe(true);
});

test('agent follow-up image request uses latest draft instead of regenerating listing', async ({ page }) => {
  let agentCalls = 0;
  let listingJobStarts = 0;
  let imageJobStarts = 0;
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

  await page.route('**/api/agent', route => {
    agentCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: agentCalls === 1
        ? 'data: {"type":"done","message":"Draft is being prepared.","pending_generate_listing":{"description":"custom lavender soy candle gift","listing_type":"physical","price":24}}\n\n'
        : 'data: {"type":"done","message":"Opening image generation for the current draft.","pending_draft_image_action":{"action":"open_image_generator"}}\n\n',
    });
  });
  await page.route('**/api/ai', async route => {
    const body = route.request().postDataJSON?.() || {};
    const rawPrompt = String(body._rawPrompt || '');
    if (rawPrompt.includes('Generate 5')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [0, 1, 2, 3, 4].map(slot => ({ slot, label: `Slot ${slot}`, ratio: '1:1', prompt: `Prompt for slot ${slot}` })) }) });
    }
    if (rawPrompt.includes('Generate 4')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [5, 6, 7, 8].map(slot => ({ slot, label: `Slot ${slot}`, ratio: '1:1', prompt: `Prompt for slot ${slot}` })) }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: 'PALETTE: sage #7C8F6A\nTEXT POLICY: no text by default\nPHOTOGRAPHY / ARTWORK STYLE: clean product photography\nSUBJECT + MOOD: calming candle gift' }) });
  });
  await page.route('**/api/jobs**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON?.() || {};
      if (body.action === 'startListingGeneration') {
        listingJobStarts += 1;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'listing-job-candle' }) });
      }
      imageJobStarts += 1;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: `img-job-${imageJobStarts}` }) });
    }
    const jobId = new URL(request.url()).searchParams.get('job_id') || '';
    if (jobId === 'listing-job-candle') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'done', result: {
        title: 'Custom Lavender Soy Candle Gift, Personalized Relaxation Candle for Her',
        description: 'A handmade lavender soy candle gift listing generated by the agent.',
        tags: ['lavender candle', 'soy candle', 'custom gift', 'relaxation gift', 'gift for her', 'spa candle', 'handmade candle', 'personalized gift', 'aromatherapy', 'candle decor', 'home fragrance', 'birthday gift', 'self care gift'],
        materials: ['soy wax', 'lavender fragrance'],
        price_suggestion: 24,
      } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      status: 'done',
      result: { images: [{ base64: tinyPng, mimeType: 'image/png' }] },
    }) });
  });
  await page.route('**/api/etsy**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }));

  await page.locator('#agent-input').fill('create a listing for a custom lavender soy candle gift');
  await page.locator('#agent-send-btn').click();
  await expect(page.locator('#agent-open-created-draft-btn')).toBeVisible({ timeout: 30_000 });
  expect(agentCalls).toBe(1);
  expect(listingJobStarts).toBe(1);

  await page.locator('#agent-input').fill('generate images for it');
  await page.locator('#agent-send-btn').click();

  await expect(page.locator('#e-title')).toHaveValue(/Custom Lavender Soy Candle/, { timeout: 15_000 });
  await expect(page.locator('#img-gen-panel')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => agentCalls, { timeout: 2_000 }).toBe(2);
  expect(listingJobStarts).toBe(1);
  await expect.poll(() => imageJobStarts, { timeout: 15_000 }).toBeGreaterThan(0);
});

test('listing draft generation resumes from its server job after reload', async ({ page }) => {
  let jobStarts = 0;
  await page.route('**/api/jobs**', route => {
    if (route.request().method() === 'POST') {
      jobStarts += 1;
      const body = route.request().postDataJSON?.() || {};
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: body.job_id }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'done', result: {
      title: 'Resumed Personalized Family Portrait Listing',
      description: 'A durable listing draft completed by the existing server job.',
      tags: ['family portrait', 'custom keepsake'],
      materials: ['digital file'],
      price_suggestion: 29,
    } }) });
  });

  await page.evaluate(async () => {
    const sessionId = sessionStorage.getItem(window.__agentTestStorageKey('agent_current_session'));
    const messages = [{
      role: 'assistant',
      content: 'Preparing the listing draft.',
      pending_generate_listing: {
        description: 'personalized family portrait',
        listing_type: 'download',
        price: 29,
        generation_job_id: 'job_listing_resume',
        status: 'generating',
      },
    }];
    sessionStorage.setItem(window.__agentTestStorageKey('agent_history'), JSON.stringify(messages));
    const { history } = await import('/utils/idb.js');
    await history.set(`agent_session_${sessionId}`, messages);
  });
  await page.reload();

  await expect(page.locator('#agent-open-created-draft-btn')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#agent-messages')).toContainText('Resumed Personalized Family Portrait Listing');
  expect(jobStarts).toBe(1);
});

test('listing image generation resumes from its server job after reload', async ({ page }) => {
  let jobStarts = 0;
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  await page.route('**/api/jobs**', route => {
    if (route.request().method() === 'POST') {
      jobStarts += 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'resume must not start a new job' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      status: 'done',
      result: { images: [{ base64: tinyPng, mimeType: 'image/png', prompt_index: 0 }] },
    }) });
  });

  await page.evaluate(async () => {
    const sessionId = sessionStorage.getItem(window.__agentTestStorageKey('agent_current_session'));
    const messages = [{
      role: 'assistant',
      content: 'Generating the approved previews.',
      pending_listing_images: {
        listing_id: '987654321',
        listing_title: 'Custom Family Portrait',
        listing_image_url: 'https://example.test/current.jpg',
        mode: 'add',
        count: 1,
        aspect_ratio: '1:1',
        prompt: 'Create an Etsy-ready result-first family portrait cover.',
        slots: [{ purpose: 'Cover', visual_prompt: 'Result-first family portrait cover.', alt_text: 'Custom family portrait cover' }],
        generated_images: [],
        generation_job_id: 'job_image_resume',
        generation_slot_indexes: [0],
        status: 'generating',
      },
    }];
    sessionStorage.setItem(window.__agentTestStorageKey('agent_history'), JSON.stringify(messages));
    const { history } = await import('/utils/idb.js');
    await history.set(`agent_session_${sessionId}`, messages);
  });
  await page.reload();

  await expect(page.locator('#agent-messages')).toContainText('1/1 preview ready', { timeout: 20_000 });
  await expect(page.locator('#agent-messages')).toContainText(/Generated previews [-—] awaiting approval/);
  expect(jobStarts).toBe(0);
});

test('selected agent transcript includes hidden sender labels', async ({ page }) => {
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: 'data: {"type":"done","message":"Mock assistant reply."}\n\n',
  }));
  await page.locator('#agent-input').fill('hello copy labels');
  await page.locator('#agent-send-btn').click();
  await expect(page.locator('.agent-message-bubble-assistant')).toContainText('Mock assistant reply.');
  const selectedText = await page.evaluate(() => {
    const messages = document.querySelector('#agent-messages');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(messages);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(selectedText).toContain('User:');
  expect(selectedText).toContain('hello copy labels');
  expect(selectedText).toContain('Agent:');
  expect(selectedText).toContain('Mock assistant reply.');
});

test('agent update proposal card is clearly preview-only before approval', async ({ page }) => {
  await page.evaluate(async () => {
    const mod = await import(`/pages/agent.js?agent-card-test=${Date.now()}`);
    const mount = document.createElement('div');
    mount.id = 'agent-card-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    mount.appendChild(mod.__renderAgentPlanPreviewForTest({
      summary: 'Rewrite title and tags',
      updates: [{
        listing_id: 123456789,
        listing_title: 'Watercolor Family Portrait',
        state: 'active',
        title_current: 'Old title',
        title: 'New SEO title',
        tags_current: ['old'],
        tags: ['new', 'portrait'],
      }],
    }));
  });

  const card = page.locator('#agent-card-test-mount .agent-action-card');
  await expect(card).toContainText(/Preview [-—] Rewrite title and tags/);
  await expect(card).toContainText('Preview, not applied');
  await expect(card).toContainText('Approval required');
  await expect(card).toContainText('Preview only. Nothing changes on Etsy until you approve this card.');
  await expect(card).toContainText('Target listing');
  await expect(card.getByRole('button', { name: /Approve preview/ })).toBeVisible();
});

test('agent listing image card separates generated previews from applied changes', async ({ page }) => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  await page.evaluate(async (preview) => {
    const mod = await import(`/pages/agent.js?agent-image-card-test=${Date.now()}`);
    const mount = document.createElement('div');
    mount.id = 'agent-image-card-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    mount.appendChild(mod.__renderListingImagesPreviewForTest({
      listing_id: 987654321,
      listing_title: 'Custom Pet Portrait',
      mode: 'replace_cover',
      prompt: 'Generate a warm watercolor-style cover image.',
      count: 1,
      aspect_ratio: '1:1',
      current_images: [{ listing_image_id: 'old-cover', url: preview, rank: 1 }],
      generated_images: [{ id: 'generated-cover', preview, mimeType: 'image/png', rank: 1 }],
    }));
  }, tinyPng);

  const card = page.locator('#agent-image-card-test-mount .agent-action-card');
  await expect(card).toContainText(/Existing listing images [·-] Replace cover image/);
  await expect(card).toContainText('Custom Pet Portrait');
  await expect(card).toContainText(/ID 987654321 [·-] 1\/1 preview ready/);
  await expect(card).toContainText('Old Etsy images are deleted only after new uploads succeed.');
  await expect(card).toContainText(/Generated previews [-—] awaiting approval/);
  await expect(card).toContainText('Preview only');
  await expect(card).not.toContainText('Apply requires approval');
  await expect(card).not.toContainText('Preview — Image set');
  await expect(card.getByRole('button', { name: /Apply to listing/ })).toBeVisible();
});

test('draft image card omits a fake thumbnail and uses explicit draft action copy', async ({ page }) => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  await page.evaluate(async (preview) => {
    const mod = await import(`/pages/agent.js?agent-draft-image-card-copy-test=${Date.now()}`);
    const mount = document.createElement('div');
    mount.id = 'agent-draft-image-card-copy-test-mount';
    document.body.appendChild(mount);
    mount.appendChild(mod.__renderListingImagesPreviewForTest({
      listing_id: 'draft',
      listing_title: 'Custom Portrait Draft',
      mode: 'add',
      count: 1,
      prompt: 'Create one premium Etsy listing image.',
      generated_images: [{ id: 'draft-image-1', preview, mimeType: 'image/png', rank: 1 }],
    }));
  }, tinyPng);

  const card = page.locator('#agent-draft-image-card-copy-test-mount .agent-action-card');
  await expect(card.locator('.agent-action-card-thumb-placeholder')).toHaveCount(0);
  await expect(card).not.toContainText(/Image pending|Draft listing image pending|\+/);
  await expect(card.getByRole('button', { name: 'Add generated images to draft listing' })).toBeVisible();
});

test('listing draft card continues in chat and reopens the latest workflow draft', async ({ page }) => {
  const workflowId = 'workflow-draft-card-current-state';
  const agentCalls = [];
  await page.route('**/api/agent', route => {
    agentCalls.push(route.request().postDataJSON?.() || {});
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: agentCalls.length === 1
        ? `data: ${JSON.stringify({ type: 'done', message: 'Draft prepared.', pending_generate_listing: { description: 'custom portrait service', listing_type: 'download', workflow_id: workflowId } })}\n\n`
        : 'data: {"type":"done","message":"Image plan requested in this chat."}\n\n',
    });
  });
  await page.route('**/api/jobs**', route => route.fulfill({
    contentType: 'application/json',
    body: route.request().method() === 'POST'
      ? JSON.stringify({ id: 'job-draft-card-actions' })
      : JSON.stringify({ status: 'done', result: {
        title: 'Custom Portrait Draft',
        description: 'A complete Etsy listing description.',
        tags: ['custom portrait'],
        price_suggestion: 29,
      } }),
  }));

  await page.locator('#agent-input').fill('Create this listing');
  await page.locator('#agent-send-btn').click();
  await expect(page.getByRole('button', { name: 'Generate listing images now' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Edit draft on Create page' })).toBeVisible();
  await expect(page.locator('#agent-messages')).toContainText('Continue here to create images');

  await page.getByRole('button', { name: 'Generate listing images now' }).click();
  await expect.poll(() => agentCalls.length).toBe(2);
  expect(agentCalls[1].messages.at(-1).content).toBe('Generate listing images for this draft now.');
  expect(agentCalls[1].context.current_agent_draft.title).toBe('Custom Portrait Draft');

  await page.evaluate(async ({ workflow }) => {
    const mod = await import('/pages/agent.js');
    const current = mod.getLatestAgentDraft();
    mod.rememberLatestAgentDraft({
      ...current,
      workflow_id: workflow,
      workflow_state: 'images_attached',
      storedImageIds: ['saved-generated-image'],
    });
    window.__openedDraft = null;
    window.navigate = async (_page, state) => { window.__openedDraft = state.agentDraft; };
  }, { workflow: workflowId });
  await page.getByRole('button', { name: 'Edit draft on Create page' }).click();
  expect(await page.evaluate(() => window.__openedDraft?.storedImageIds)).toEqual(['saved-generated-image']);
  expect(await page.evaluate(() => {
    const messages = JSON.parse(sessionStorage.getItem(window.__agentTestStorageKey('agent_history')) || '[]');
    return messages.find(message => message.pending_generate_listing?.workflow_id === 'workflow-draft-card-current-state')?.pending_generate_listing?.agent_draft?.storedImageIds;
  })).toEqual(['saved-generated-image']);
});

test('completed generated image card remains visible in full and mini chat history', async ({ page }) => {
  const imageId = await page.evaluate(async () => {
    const store = await import('/utils/image-store.js');
    return store.saveImage({
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      prompt: 'Completed draft image',
      slotLabel: 'Cover',
    });
  });
  await page.evaluate(async (id) => {
    const sessionId = sessionStorage.getItem(window.__agentTestStorageKey('agent_current_session'));
    const plan = {
      listing_id: 'draft',
      listing_title: 'Persistent Draft Images',
      workflow_id: 'workflow-completed-images',
      workflow_state: 'images_attached',
      status: 'applied',
      mode: 'add',
      count: 1,
      prompt: 'A persistent generated listing image.',
      generated_images: [{ id, mimeType: 'image/png', rank: 1 }],
    };
    const messages = [{
      role: 'assistant',
      content: 'The generated image was added to the draft.',
      pending_listing_images: plan,
      listing_image_result: { ...plan, applied_at: new Date().toISOString() },
    }];
    sessionStorage.setItem(window.__agentTestStorageKey('agent_history'), JSON.stringify(messages));
    const { history } = await import('/utils/idb.js');
    await history.set(`agent_session_${sessionId}`, messages);
  }, imageId);
  await page.reload();

  const full = page.locator('#main-area');
  await expect(full).toContainText('Persistent Draft Images');
  await expect(full.getByRole('button', { name: 'Added to draft listing' })).toBeDisabled();
  await expect(full.locator('.agent-generated-preview-tile img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(full.getByRole('button', { name: /Generate previews|Regenerate preview|Add generated images/ })).toHaveCount(0);

  await page.evaluate(() => window.navigate('dashboard'));
  await page.locator('#agent-fab').click();
  const mini = page.locator('#float-agent-host');
  await expect(mini).toContainText('Persistent Draft Images');
  await expect(mini.getByRole('button', { name: 'Added to draft listing' })).toBeDisabled();
  await expect(mini.locator('.agent-generated-preview-tile img')).toHaveAttribute('src', /^data:image\/png;base64,/);
});

test('agent listing image card uses reference image instead of No image placeholder', async ({ page }) => {
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  await page.evaluate(async (base64) => {
    const mod = await import(`/pages/agent.js?agent-reference-thumb-test=${Date.now()}`);
    const mount = document.createElement('div');
    mount.id = 'agent-reference-thumb-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    mount.appendChild(mod.__renderListingImagesPreviewForTest({
      listing_id: 987654321,
      listing_title: 'Reference Image Listing Draft',
      mode: 'add',
      count: 2,
      aspect_ratio: '1:1',
      prompt: 'Create Etsy mockups based on the uploaded design.',
      reference_image: { base64, mimeType: 'image/png' },
      current_images: [],
      slots: [{ purpose: 'Cover', visual_prompt: 'Use the uploaded reference design.' }],
    }));
  }, tinyPng);

  const card = page.locator('#agent-reference-thumb-test-mount .agent-action-card');
  await expect(card).toContainText('Reference Image Listing Draft');
  await expect(card).not.toContainText('No image');
  await expect(card.locator('img').first()).toHaveAttribute('src', /^data:image\/png;base64,/);
});

test('agent listing image card strips embedded image payloads from visual brief', async ({ page }) => {
  await page.evaluate(async () => {
    const mod = await import(`/pages/agent.js?agent-dirty-visual-brief-test=${Date.now()}`);
    const mount = document.createElement('div');
    mount.id = 'agent-dirty-visual-brief-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    mount.appendChild(mod.__renderListingImagesPreviewForTest({
      listing_id: 987654321,
      listing_title: 'Dirty Vision Brief Listing',
      mode: 'replace_all',
      count: 2,
      aspect_ratio: '1:1',
      prompt: 'Professional Etsy image set. ![generated image 1](data:image/png;base64,' + 'A'.repeat(300) + ') Continue with a clean visual brief.',
      current_images: [{ listing_image_id: 'old-cover', url: 'https://example.test/old.jpg', rank: 1 }],
      slots: [{ purpose: 'Cover', visual_prompt: 'Use this data:image/png;base64,' + 'B'.repeat(300), alt_text: 'Cover' }],
    }));
  });

  const card = page.locator('#agent-dirty-visual-brief-test-mount .agent-action-card');
  await expect(card).toContainText('Dirty Vision Brief Listing');
  await expect(card).toContainText('[image omitted]');
  await expect(card).not.toContainText('data:image');
  await expect(card).not.toContainText('base64');
});

test('agent image follow-up keeps the pending listing target', async ({ page }) => {
  let agentBody = null;
  await page.route('**/api/agent', async route => {
    agentBody = route.request().postDataJSON?.() || {};
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"done","message":"Image plan is ready."}\n\n',
    });
  });

  await page.evaluate(async () => {
    const mod = await import(`/pages/agent.js?agent-image-follow-up-target-test=${Date.now()}`);
    mod.agentMessages.length = 0;
    mod.agentMessages.push({
      role: 'assistant',
      content: 'Generated 1/4 preview. Review it here in chat.',
      pending_listing_images: {
        listing_id: 987654321,
        listing_title: 'Custom Pet Portrait',
        mode: 'add',
        prompt: 'Generate clean Etsy images.',
        count: 4,
        current_images: [{ listing_image_id: 'old-cover', url: 'https://example.test/old.jpg', rank: 1 }],
      },
    });
    mod.agentMessages.push({ role: 'user', content: 'ну от для нього і згенеруй нові фотки' });
    await mod.sendAgentMessage('ну от для нього і згенеруй нові фотки');
  });

  expect(agentBody?.context?.pending_listing_images?.listing_id).toBe(987654321);
  expect(agentBody?.context?.last_target_listing?.listing_id).toBe(987654321);
  expect(agentBody?.context?.last_target_listing?.listing_title).toBe('Custom Pet Portrait');
  expect(agentBody?.context?.conversation_listing_references?.[0]).toMatchObject({
    listing_id: 987654321,
    listing_title: 'Custom Pet Portrait',
    source: 'active_listing_image_plan',
  });
});

test('agent listing image generation previews do not write to Etsy', async ({ page }) => {
  const tinyBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  const uploadCalls = [];
  const jobCalls = [];
  await page.route('**/api/jobs**', async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON?.() || {};
      jobCalls.push(body);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: `job-${jobCalls.length}`, status: 'queued' } }) });
    }
    const url = new URL(req.url());
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      success: true,
      data: {
        id: url.searchParams.get('job_id'),
        status: 'done',
        result: { images: [
          { base64: tinyBase64, mimeType: 'image/png' },
          { base64: tinyBase64, mimeType: 'image/png' },
        ] },
      },
    }) });
  });
  await page.route('**/api/upload', async route => {
    uploadCalls.push(route.request().postDataJSON?.() || {});
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
  });

  await page.evaluate(async () => {
    window.__agentPreviewOpened = null;
    window.__agentViewImg = src => { window.__agentPreviewOpened = src; };
    const store = await import(`/utils/image-store.js?agent-image-gallery-generate-test=${Date.now()}`);
    await store.clearAllImages();
    const mod = await import(`/pages/agent.js?agent-image-interactive-generate-test=${Date.now()}`);
    mod.agentMessages.push({ role: 'user', content: 'make it brighter and more premium for this listing' });
    const mount = document.createElement('div');
    mount.id = 'agent-image-generate-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    mount.appendChild(mod.__renderInteractiveListingImagesPreviewForTest({
      listing_id: 987654321,
      listing_title: 'Custom Pet Portrait',
      mode: 'add',
      prompt: 'Generate two clean Etsy listing images.',
      count: 2,
      aspect_ratio: '1:1',
      current_images: [{ listing_image_id: 'old-cover', url: 'https://example.test/old.jpg', rank: 1 }],
      visual_analysis: { overall_summary: 'Existing cover is dark and needs a brighter product hero.' },
    }));
  });

  const card = page.locator('#agent-image-generate-test-mount .agent-action-card');
  await card.getByRole('button', { name: /Generate previews/ }).click();
  await expect(card).toContainText('2/2 previews ready', { timeout: 30_000 });
  await expect(card).toContainText(/Generated previews [-—] awaiting approval/);
  expect(uploadCalls).toEqual([]);
  expect(jobCalls).toHaveLength(1);
  expect(jobCalls[0].action).toBe('startImageGeneration');
  expect(jobCalls[0].count).toBe(2);
  expect(jobCalls[0].prompts).toHaveLength(2);
  expect(jobCalls[0].referenceImage?.url).toBe('https://example.test/old.jpg');
  expect(jobCalls[0].prompts.every(prompt => !prompt.includes('Target listing ID'))).toBe(true);
  expect(jobCalls[0].prompts.every(prompt => !prompt.includes('987654321'))).toBe(true);
  expect(jobCalls[0].prompts.every(prompt => !prompt.includes('Recent conversation context'))).toBe(true);
  expect(jobCalls[0].prompts.every(prompt => prompt.includes('Generate two clean Etsy listing images.'))).toBe(true);
  await card.getByRole('button', { name: 'View' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__agentPreviewOpened || '')).toContain('data:image/png;base64,');
  await expect(card).toContainText('Review the generated images. The listing will not change until you approve applying them.');
  await expect.poll(() => page.evaluate(async () => {
    const store = await import('/utils/image-store.js');
    return (await store.getAllImages()).length;
  })).toBeGreaterThanOrEqual(2);
});

test('agent listing image apply uploads replacement before deleting selected old image', async ({ page }) => {
  const calls = [];
  await page.route('**/api/upload', async route => {
    const body = route.request().postDataJSON?.() || {};
    calls.push(body);
    if (body.action === 'getImages') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: [
        { listing_image_id: 'old-1', url_570xN: 'https://example.test/1.jpg', rank: 1 },
        { listing_image_id: 'old-2', url_570xN: 'https://example.test/2.jpg', rank: 2 },
        { listing_image_id: 'old-3', url_570xN: 'https://example.test/3.jpg', rank: 3 },
      ] }) });
    }
    if (body.action === 'uploadImage') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { listing_image_id: 'new-3' } }) });
    }
    if (body.action === 'deleteImage') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unknown upload action' }) });
  });

  await page.evaluate(async () => {
    const store = await import(`/utils/image-store.js?agent-image-store-apply-test=${Date.now()}`);
    const id = await store.saveImage({
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      prompt: 'Replacement image',
      slotLabel: 'Agent 1',
      listingTitle: 'Custom Pet Portrait',
    });
    const mod = await import(`/pages/agent.js?agent-image-interactive-apply-test=${Date.now()}`);
    const mount = document.createElement('div');
    mount.id = 'agent-image-apply-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    mount.appendChild(mod.__renderInteractiveListingImagesPreviewForTest({
      listing_id: 987654321,
      listing_title: 'Custom Pet Portrait',
      mode: 'replace_selected',
      prompt: 'Regenerate the third listing image.',
      count: 1,
      aspect_ratio: '1:1',
      current_images: [
        { listing_image_id: 'old-1', url: 'https://example.test/1.jpg', rank: 1 },
        { listing_image_id: 'old-2', url: 'https://example.test/2.jpg', rank: 2 },
        { listing_image_id: 'old-3', url: 'https://example.test/3.jpg', rank: 3 },
      ],
      selected_image_ranks: [3],
      slots: [{ purpose: 'Replacement detail', visual_prompt: 'Regenerate the third listing image.', alt_text: 'Cinematic pet portrait preview in warm light' }],
      generated_images: [{ id, mimeType: 'image/png', rank: 1 }],
    }));
  });

  const card = page.locator('#agent-image-apply-test-mount .agent-action-card');
  await card.getByRole('button', { name: /Apply to listing/ }).click();
  await expect(card.locator('#listing-img-progress')).toContainText('Applied to listing', { timeout: 30_000 });
  expect(calls.map(call => call.action)).toEqual(['getImages', 'uploadImage', 'deleteImage']);
  expect(calls[1]).toMatchObject({ action: 'uploadImage', listing_id: 987654321, rank: 3, overwrite: false, alt_text: 'Cinematic pet portrait preview in warm light' });
  expect(calls[2]).toMatchObject({ action: 'deleteImage', listing_id: 987654321, listing_image_id: 'old-3' });
});

test('agent listing image action tool applies generated previews through the card action', async ({ page }) => {
  const calls = [];
  await page.route('**/api/upload', async route => {
    const body = route.request().postDataJSON?.() || {};
    calls.push(body);
    if (body.action === 'uploadImage') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { listing_image_id: 'new-4' } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
  });

  await page.evaluate(async () => {
    const store = await import(`/utils/image-store.js?agent-image-text-apply-store-test=${Date.now()}`);
    const id = await store.saveImage({
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      prompt: 'Additional listing image',
      slotLabel: 'Agent 1',
      listingTitle: 'Custom Pet Portrait',
    });
    const mod = await import(`/pages/agent.js?agent-image-text-apply-test=${Date.now()}`);
    mod.agentMessages.length = 0;
    const plan = {
      listing_id: 987654321,
      listing_title: 'Custom Pet Portrait',
      mode: 'add',
      prompt: 'Generate one clean Etsy listing image.',
      count: 1,
      aspect_ratio: '1:1',
      current_images: [{ listing_image_id: 'old-cover', url: 'https://example.test/old.jpg', rank: 1 }],
      slots: [{ purpose: 'Extra buyer proof', visual_prompt: 'Show a premium extra buyer proof image.', alt_text: 'Premium pet portrait preview' }],
      generated_images: [{ id, mimeType: 'image/png', rank: 1 }],
    };
    mod.agentMessages.push({ role: 'assistant', content: 'Generated preview is ready.', pending_listing_images: plan, listing_image_result: null });
    const mount = document.createElement('div');
    mount.id = 'agent-image-text-apply-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    mount.appendChild(mod.__renderInteractiveListingImagesPreviewForTest(plan, 0));
    window.__handledTextApply = await mod.__executeListingImageActionForTest({ action: 'apply_to_listing', listing_id: '987654321' });
  });

  expect(await page.evaluate(() => window.__handledTextApply)).toBe(true);
  const card = page.locator('#agent-image-text-apply-test-mount .agent-action-card');
  await expect(card.locator('#listing-img-progress')).toContainText('Applied to listing', { timeout: 30_000 });
  expect(calls.map(call => call.action)).toEqual(['uploadImage']);
  expect(calls[0]).toMatchObject({ action: 'uploadImage', listing_id: 987654321, rank: 2, overwrite: false, alt_text: 'Premium pet portrait preview' });
});

test('agent listing image apply keeps old selected image when upload fails', async ({ page }) => {
  const calls = [];
  await page.route('**/api/upload', async route => {
    const body = route.request().postDataJSON?.() || {};
    calls.push(body);
    if (body.action === 'getImages') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: [
        { listing_image_id: 'old-3', url_570xN: 'https://example.test/3.jpg', rank: 3 },
      ] }) });
    }
    if (body.action === 'uploadImage') {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'mock upload failed' }) });
    }
    if (body.action === 'deleteImage') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unknown upload action' }) });
  });

  await page.evaluate(async () => {
    const store = await import(`/utils/image-store.js?agent-image-store-fail-test=${Date.now()}`);
    const id = await store.saveImage({
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      prompt: 'Replacement image',
      slotLabel: 'Agent 1',
      listingTitle: 'Custom Pet Portrait',
    });
    const mod = await import(`/pages/agent.js?agent-image-interactive-fail-test=${Date.now()}`);
    const mount = document.createElement('div');
    mount.id = 'agent-image-fail-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    mount.appendChild(mod.__renderInteractiveListingImagesPreviewForTest({
      listing_id: 987654321,
      listing_title: 'Custom Pet Portrait',
      mode: 'replace_selected',
      prompt: 'Regenerate the third listing image.',
      count: 1,
      aspect_ratio: '1:1',
      current_images: [{ listing_image_id: 'old-3', url: 'https://example.test/3.jpg', rank: 3 }],
      selected_image_ranks: [3],
      generated_images: [{ id, mimeType: 'image/png', rank: 1 }],
    }));
  });

  const card = page.locator('#agent-image-fail-test-mount .agent-action-card');
  await card.getByRole('button', { name: /Apply to listing/ }).click();
  await expect(card.locator('#listing-img-progress')).toContainText('APP_LISTING_IMAGE_APPLY_FAILED', { timeout: 30_000 });
  await expect(card.locator('#listing-img-progress')).not.toContainText(/clear data|DevTools|browser storage/i);
  expect(calls.map(call => call.action)).toEqual(['getImages', 'uploadImage']);
  expect(calls.some(call => call.action === 'deleteImage')).toBe(false);
});

test('agent variation-safe price card is preview-only and preserves variations', async ({ page }) => {
  await page.evaluate(async () => {
    const mod = await import(`/pages/agent.js?agent-price-card-test=${Date.now()}`);
    const mount = document.createElement('div');
    mount.id = 'agent-price-card-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    mount.appendChild(mod.__renderPriceInventoryPreviewForTest({
      summary: 'Multiply all inventory prices by 2.5x',
      mode: 'multiply',
      value: 2.5,
      multiplier: 2.5,
      listings: [{
        listing_id: 4440964330,
        listing_title: 'Cinematic Love Story Video',
        state: 'active',
        summary: {
          product_count: 2,
          price_min: 15,
          price_max: 25,
          properties: [{ name: 'Length', options: ['Short', 'Long'] }],
        },
        new_summary: {
          product_count: 2,
          price_min: 37.5,
          price_max: 62.5,
          properties: [{ name: 'Length', options: ['Short', 'Long'] }],
        },
        changes: [
          { index: 1, variation: 'Length: Short', current_price: 15, new_price: 37.5 },
          { index: 2, variation: 'Length: Long', current_price: 25, new_price: 62.5 },
        ],
      }],
    }));
  });

  const card = page.locator('#agent-price-card-test-mount');
  await expect(card).toContainText('Variation-safe price update');
  await expect(card).toContainText('Preview, not applied');
  await expect(card).toContainText('Approval required');
  await expect(card).toContainText('multiplies every inventory offering price by 2.5x');
  await expect(card).toContainText('preserves all variation properties');
  await expect(card).toContainText('$15-$25');
  await expect(card).toContainText('$37.5-$62.5');
  await expect(card).toContainText('Length: Short: $15 → $37.5');
  await expect(card.getByRole('button', { name: /Approve & update prices/ })).toBeVisible();
});

test('agent debug trace is hidden by default and available in diagnostics mode', async ({ page }) => {
  await page.evaluate(async () => {
    const mod = await import(`/pages/agent.js?agent-debug-trace-test=${Date.now()}`);
    const mount = document.createElement('div');
    mount.id = 'agent-debug-trace-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    const hidden = mod.__renderAgentDebugTraceForTest([
      { type: 'listing_resolution', query: 'cinetamic love story video custom valentine', selected: { listing_id: 4440964330, score: 0.91 } },
      { type: 'inventory_price_proposal', mode: 'multiply', listing_ids: [4440964330], range: { before: [15, 25], after: [37.5, 62.5] } },
    ]);
    mount.dataset.hiddenByDefault = String(hidden === null);
    window.__ETSY_AGENT_DEBUG__ = true;
    mount.appendChild(mod.__renderAgentDebugTraceForTest([
      { type: 'listing_resolution', query: 'cinetamic love story video custom valentine', selected: { listing_id: 4440964330, score: 0.91 } },
      { type: 'inventory_price_proposal', mode: 'multiply', listing_ids: [4440964330], range: { before: [15, 25], after: [37.5, 62.5] } },
    ]));
  });

  await expect(page.locator('#agent-debug-trace-test-mount')).toHaveAttribute('data-hidden-by-default', 'true');
  const trace = page.locator('#agent-debug-trace-test-mount .agent-debug-trace');
  await expect(trace).toContainText('Debug trace');
  await trace.locator('summary').click();
  await expect(trace).toContainText('listing_resolution');
  await expect(trace).toContainText('inventory_price_proposal');
  await expect(trace).toContainText('4440964330');
});

test('agent listing thumbnail results explain selection is preview-only', async ({ page }) => {
  await page.evaluate(async () => {
    const { renderListingThumbnails } = await import(`/utils/agent-format.js?listing-select-test=${Date.now()}`);
    const mount = document.createElement('div');
    mount.id = 'agent-listing-select-test-mount';
    mount.style.cssText = 'max-width:820px;margin:16px';
    document.body.appendChild(mount);
    mount.innerHTML = renderListingThumbnails([
      'Listing media:',
      'Listing ID: 123456789 | State: active | Views: 42 | Sales: 3 | Price: 19.5 | Etsy URL: https://www.etsy.com/listing/123456789 | image_url: https://example.test/listing.jpg | Title: Low View Portrait',
      'Listing ID: 987654321 | State: active | Views: 88 | Price: 12 | Etsy URL: https://www.etsy.com/listing/987654321 | image_url: https://example.test/listing-2.jpg | Title: Low View Template',
    ].join('\n'));
  });

  const panel = page.locator('#agent-listing-select-test-mount .agent-listing-selection-panel');
  await expect(panel).toContainText('Listing selection');
  await expect(panel).toContainText('Preview/select only - no Etsy changes');
  await expect(panel).toContainText('Listing');
  await expect(panel).not.toContainText('Candidate listing');
  await expect(panel).toContainText('Low View Portrait');
  await expect(panel).toContainText('Low View Template');
  await expect(panel).toContainText('ID 123456789');
  await expect(panel).toContainText('42 views');
  await expect(panel).toContainText('3 sales');
  await expect(panel).toContainText('$19.5');
  await expect(panel).toContainText('Open');
  await expect(panel).toContainText('Use ID 123456789');
  await expect(panel.locator('[data-agent-listing-id="123456789"]')).not.toHaveAttribute('href', /./);
  await expect(panel.locator('[data-agent-listing-id="123456789"] a').first()).toHaveAttribute('href', 'https://www.etsy.com/listing/123456789');
  await expect(panel.locator('[data-copy-listing-id="123456789"]')).toContainText('Use ID 123456789');
});

test('agent responds to shop info request', async ({ page }) => {
  const bubbles = page.locator('#agent-messages .agent-message-bubble');
  const before = await bubbles.count();

  await page.locator('#agent-input').fill('show shop info');
  await page.locator('#agent-send-btn').click();

  // Wait for AI to respond — send button is re-enabled when loading finishes
  await expect(page.locator('#agent-send-btn')).toBeEnabled({ timeout: 60_000 });

  // Should have gained at least 2 chat bubbles (user message + assistant response).
  // Count only bubbles because the empty-chat welcome panel/chips are removed on send.
  const after = await bubbles.count();
  expect(after).toBeGreaterThanOrEqual(before + 2);

  // Last message should have meaningful content
  const text = await bubbles.last().textContent();
  expect(text?.length).toBeGreaterThan(10);
});

test('agent responds to listings request', async ({ page }) => {
  const bubbles = page.locator('#agent-messages .agent-message-bubble');
  const before = await bubbles.count();

  await page.locator('#agent-input').fill('show me my top 3 listings');
  await page.locator('#agent-send-btn').click();

  // Listings request fetches Etsy data + AI — allow up to 60s
  await expect(page.locator('#agent-send-btn')).toBeEnabled({ timeout: 60_000 });

  // Should have gained at least 2 chat bubbles (user message + assistant response).
  // Count only bubbles because the empty-chat welcome panel/chips are removed on send.
  const after = await bubbles.count();
  expect(after).toBeGreaterThanOrEqual(before + 2);

  const text = await bubbles.last().textContent();
  expect(text?.length).toBeGreaterThan(10);
});

test('agent clear button works', async ({ page }) => {
  const initialCount = await page.locator('#agent-messages > *').count();

  // Auto-accept the confirm() dialog that the clear button shows
  page.on('dialog', dialog => dialog.accept());

  // Send a message first so there's something to clear
  await page.locator('#agent-input').fill('hello');
  await page.locator('#agent-send-btn').click();
  // Wait for user message to appear (count grows beyond initial)
  await expect(page.locator('#agent-messages > *')).not.toHaveCount(initialCount, { timeout: 5_000 });

  // Clear — dialog auto-accepted above
  await page.locator('#agent-clear-btn').click();
  // After clear, welcome panel re-renders — count returns to initial
  await expect(page.locator('#agent-messages > *')).toHaveCount(initialCount, { timeout: 5_000 });
});
