import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const publicRoot = path.resolve(process.cwd(), 'public');
let server;
let baseUrl;

const playbook = {
  tone: {
    summary: 'Warm and concise.',
    response_length: '2-5 short sentences.',
    language_policy: 'Reply in the buyer language.',
    signature: '',
  },
  hard_rules: ['Never invent facts.', 'Every message requires approval.'],
  avoid_phrases: ['five-star review'],
  scenarios: {
    how_to_send_files: {
      label: 'How to send files',
      enabled: true,
      requires_order_context: false,
      instructions: 'Explain verified options.',
    },
    how_to_order: {
      label: 'How to order',
      enabled: true,
      requires_order_context: false,
      instructions: 'Ask for missing choices.',
    },
    missing_materials: {
      label: 'Missing materials',
      enabled: true,
      requires_order_context: true,
      instructions: 'List only verified missing materials.',
    },
    deadline_variants_sent: {
      label: 'Deadline: variants sent',
      enabled: true,
      requires_order_context: true,
      instructions: 'Use the verified result link.',
    },
    deadline_no_materials: {
      label: 'Deadline: no materials',
      enabled: true,
      requires_order_context: true,
      instructions: 'Explain the verified deadline policy.',
    },
    review_request: {
      label: 'Review request',
      enabled: false,
      requires_order_context: true,
      instructions: 'Make the request neutral and optional.',
    },
    freeform: {
      label: 'Custom reply',
      enabled: true,
      requires_order_context: false,
      instructions: 'Use conversation facts.',
    },
  },
  examples: [],
};

function mimeType(file) {
  if (file.endsWith('.js')) return 'text/javascript';
  if (file.endsWith('.css')) return 'text/css';
  return 'text/html';
}

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    if (new URL(request.url, 'http://local').pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html>
        <html><head>
          <meta name="viewport" content="width=device-width">
          <link rel="stylesheet" href="/style.css">
          <link rel="stylesheet" href="/messages.css">
        </head><body>
          <div id="toast-container"></div><main id="fixture"></main>
          <script type="module">
            import { renderMessages } from '/pages/messages.js';
            window.updateCurrentRouteParams = (params = {}, options = {}) => {
              const query = new URLSearchParams();
              for (const [key, value] of Object.entries(params)) {
                if (value !== undefined && value !== null && value !== '') {
                  query.set(key, String(value));
                }
              }
              const target = '/#messages' + (query.size ? '?' + query.toString() : '');
              history[options.replace ? 'replaceState' : 'pushState']({}, '', target);
            };
            const params = Object.fromEntries(new URLSearchParams(location.search));
            renderMessages(document.getElementById('fixture'), params);
          </script>
        </body></html>`);
      return;
    }
    const requested = path.resolve(publicRoot, `.${new URL(request.url, 'http://local').pathname}`);
    if (!requested.startsWith(publicRoot + path.sep)) {
      response.statusCode = 403;
      response.end();
      return;
    }
    try {
      response.setHeader('Content-Type', mimeType(requested));
      response.end(await fs.readFile(requested));
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function mockMessages(page, calls = [], options = {}) {
  await page.addInitScript(locale => {
    window.localStorage.setItem('etsy-manager:messages-locale', locale);
  }, options.locale || 'en');
  await page.route('**/api/messages*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === 'POST'
      ? JSON.parse(request.postData() || '{}')
      : {};
    const action = body.action || url.searchParams.get('action');
    calls.push({
      action,
      method: request.method(),
      conversationId: body.conversation_id || url.searchParams.get('conversation_id'),
      limit: url.searchParams.get('limit') || body.limit || null,
      cursor: url.searchParams.get('cursor') || null,
      needsAttention: url.searchParams.get('needs_attention')
        || body.needs_attention
        || null,
      all: url.searchParams.get('all'),
      payload: body,
    });
    if (action === 'generateDraft' && options.failGenerate) {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'The draft agent could not prepare a valid reply. Please try again.',
        }),
      });
      return;
    }
    if (action === 'getAttachment') {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: 'mock-image',
      });
      return;
    }
    let data;
    if (action === 'status') {
      data = {
        account: options.production
          ? { label: 'production-shop', mode: 'production' }
          : { label: 'reserve-test-shop', mode: 'reserve' },
        reserve_guard_active: !options.production,
        bridge: {
          session_state: 'READY',
          delivery: options.production
            ? { approved_outbox_enabled: true }
            : options.reserveTestSend
            ? {
              approved_outbox_enabled: true,
              nonproduction_test_send: {
                configured: true,
                conversation_id: '1001',
                consumed: false,
                available: true,
              },
            }
            : { approved_outbox_enabled: false },
        },
      };
    } else if (action === 'listConversations') {
      const needsAttention = url.searchParams.get('needs_attention') || '';
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const limit = Number(url.searchParams.get('limit') || 50);
      if (options.delayConversationFilters && needsAttention) {
        await new Promise(resolve => setTimeout(resolve, needsAttention === 'true' ? 120 : 10));
      }
      if (options.paginatedConversations) {
        const firstPageCalls = calls.filter(call => (
          call.action === 'listConversations'
          && Number(call.cursor || 0) === 0
        )).length;
        const all = Array.from({ length: 120 }, (_, index) => ({
          id: index + 1,
          source_id: String(1000 + index),
          participant: `Customer ${index + 1}`,
          needs_attention: index === 1,
          last_message_preview: `Cached message ${index + 1}`,
          last_message_at: index === 119 ? null : `2026-07-${String(24 - Math.floor(index / 24)).padStart(2, '0')}T09:00:00Z`,
        }));
        if (options.refreshFirstPage && cursor === 0 && firstPageCalls > 1) {
          all.unshift({
            id: 999,
            source_id: '999',
            participant: 'Newest customer',
            needs_attention: true,
            last_message_preview: 'Just arrived',
            last_message_at: '2026-07-27T12:00:00Z',
          });
        }
        const items = all.slice(cursor, cursor + limit);
        if (cursor > 0 && items.length) items.unshift(all[cursor - 1]);
        data = {
          items,
          next_cursor: cursor + limit < all.length ? cursor + limit : null,
        };
      } else data = {
        items: [{
          id: 1,
          source_id: '1001',
          participant: options.delayConversationFilters && needsAttention
            ? `${needsAttention === 'true' ? 'New' : 'Viewed'} result`
            : 'Ilya',
          needs_attention: true,
          last_message_preview: 'Can I send the photos here?',
          updated_at: '2026-07-25T10:00:00Z',
          last_message_at: '2026-07-24T09:00:00Z',
        }],
        next_cursor: null,
      };
    } else if (action === 'markConversationViewed') {
      data = {
        status: 'VIEWED',
        scope: 'local_dashboard_only',
        conversation: {
          source_id: body.conversation_id,
          needs_attention: false,
        },
      };
    } else if (action === 'getConversation') {
      const requestedConversationId = url.searchParams.get('conversation_id') || '1001';
      const messages = options.emptyConversation
        ? []
        : options.attachmentFallback
        ? [{
          id: 301,
          source_id: 'etsy-message-301',
          sender: '987654321',
          direction: 'incoming',
          body: 'Files attached',
          sent_at: '2026-07-24T08:00:00Z',
          attachments: [{
            id: 61,
            source_id: 'etsy-cdn-61',
            filename: 'cdn-photo.png',
            mime_type: 'image/png',
            size_bytes: 2500,
            local_path: false,
            public_url: 'https://i.etsystatic.com/icm/12345/r/il/cdn-photo.png',
          }, {
            id: 611,
            source_id: 'duplicate-cdn-row',
            filename: 'cdn-photo.png',
            mime_type: 'image/png',
            size_bytes: 2500,
            local_path: false,
            source_url: 'https://i.etsystatic.com/icm/12345/r/il/cdn-photo.png',
          }, {
            id: 62,
            source_id: 'etsy-local-62',
            filename: 'local-first.png',
            mime_type: 'image/png',
            size_bytes: 3200,
            local_path: true,
            public_url: 'https://i.etsystatic.com/icm/12345/r/il/local-copy.png',
          }, {
            id: 63,
            source_id: 'unsafe-js',
            filename: 'unsafe-js.png',
            mime_type: 'image/png',
            local_path: false,
            source_url: 'javascript:alert(1)',
          }, {
            id: 64,
            source_id: 'unsafe-data',
            filename: 'unsafe-data.png',
            mime_type: 'image/png',
            local_path: false,
            source_url: 'data:image/png;base64,AAAA',
          }, {
            id: 65,
            source_id: 'unsafe-host',
            filename: 'unsafe-host.png',
            mime_type: 'image/png',
            local_path: false,
            source_url: 'https://evil.example/steal.png',
          }],
        }]
        : options.edgeDirections
        ? [{
          id: 201,
          source_id: 'etsy-message-201',
          sender: '987654321',
          direction: 'incoming',
          body: 'Incoming from participant',
          sent_at: '2026-07-24T08:00:00Z',
          attachments: [],
        }, {
          id: 202,
          source_id: 'etsy-message-202',
          sender: '123456789',
          direction: 'outgoing',
          body: 'Outgoing from shop',
          sent_at: '2026-07-24T09:00:00Z',
          attachments: [],
        }, {
          id: 203,
          source_id: 'etsy-message-203',
          sender: '555555555',
          direction: 'unknown',
          body: 'Stored but not classified',
          sent_at: '2026-07-24T10:00:00Z',
          attachments: [{
            id: 55,
            source_id: 'etsy-image-55',
            filename: 'unclassified-upload.png',
            mime_type: 'image/png',
            size_bytes: 1200,
            local_path: true,
          }],
        }, {
          id: 205,
          source_id: 'etsy-message-205',
          sender: '666666666',
          direction: 'unknown',
          body: 'Unknown text-only row',
          sent_at: '2026-07-24T10:30:00Z',
          attachments: [],
        }, {
          id: 204,
          source_id: 'etsy-message-204',
          sender: '305659982',
          direction: 'system',
          body: 'Thanks for your feedback!',
          sent_at: '2026-07-24T11:00:00Z',
          attachments: [],
        }]
        : options.longThread
        ? Array.from({ length: 250 }, (_, index) => ({
          id: index + 500,
          source_id: `long-message-${index + 1}`,
          sender: index % 2 ? '987654321' : '123456789',
          direction: index % 2 ? 'outgoing' : 'incoming',
          body: `Long stored message ${index + 1}`,
          sent_at: new Date(Date.UTC(2026, 6, 20, 0, index)).toISOString(),
          attachments: [],
        }))
        : options.realisticThread
        ? Array.from({ length: 36 }, (_, index) => ({
          id: index + 100,
          source_id: `etsy-message-${index + 100}`,
          sender: index % 2 ? '987654321' : '123456789',
          direction: index % 2 ? 'outgoing' : 'incoming',
          body: `Stored message ${index + 1}`,
          sent_at: `2026-07-24T${String(index % 24).padStart(2, '0')}:00:00Z`,
          attachments: index === 35 ? [{
            id: 42,
            source_id: 'etsy-image-42',
            filename: 'finished-portrait.png',
            mime_type: 'image/png',
            size_bytes: 48123,
            local_path: true,
          }, {
            id: 43,
            source_id: 'etsy-image-43',
            filename: 'older-photo.jpg',
            mime_type: '',
            size_bytes: null,
            local_path: false,
          }] : [],
        }))
        : [{
          id: 91,
          source_id: 'etsy-message-91',
          sender: 'self',
          direction: 'outgoing',
          body: 'Yes, you can attach them here.',
          sent_at: '2026-07-24T09:00:00Z',
          attachments: [],
        }];
      data = {
        id: 1,
        source_id: requestedConversationId,
        participant: requestedConversationId === '1001'
          ? 'Ilya'
          : `Customer ${Number(requestedConversationId) - 999}`,
        updated_at: '2026-07-25T10:00:00Z',
        last_message_at: '2026-07-24T09:00:00Z',
        messages,
      };
    } else if (action === 'syncConversationHistory') {
      const messages = options.realisticThread
        ? [
          ...Array.from({ length: 12 }, (_, index) => ({
            id: index + 50,
            source_id: `etsy-message-${index + 50}`,
            sender: '555555555',
            direction: index % 2 ? 'outgoing' : 'incoming',
            body: `Older stored message ${index + 1}`,
            sent_at: `2026-07-23T${String(index).padStart(2, '0')}:00:00Z`,
            attachments: [],
          })),
          ...Array.from({ length: 36 }, (_, index) => ({
            id: index + 100,
            source_id: `etsy-message-${index + 100}`,
            sender: index % 2 ? '987654321' : '123456789',
            direction: index % 2 ? 'outgoing' : 'incoming',
            body: `Stored message ${index + 1}`,
            sent_at: `2026-07-24T${String(index % 24).padStart(2, '0')}:00:00Z`,
            attachments: [],
          })),
        ]
        : [{
          id: 90,
          source_id: 'etsy-message-90',
          sender: 'buyer',
          direction: 'incoming',
          body: 'Older message',
          sent_at: '2026-07-23T09:00:00Z',
          attachments: [],
        }];
      data = {
        sync: { status: 'OK', mode: 'conversation_history' },
        conversation: {
          id: 1,
          source_id: '1001',
          participant: 'Ilya',
          last_message_at: '2026-07-24T09:00:00Z',
          messages,
        },
      };
    } else if (action === 'refreshConversationRecent') {
      data = options.refreshRecentConversation
        ? {
          sync: { status: 'OK', mode: 'conversation_recent' },
          conversation: {
            id: 1,
            source_id: '1001',
            participant: 'Ilya',
            last_message_at: '2026-07-28T12:00:00Z',
            messages: [{
              id: 501,
              source_id: 'fresh-message-501',
              sender: '987654321',
              direction: 'incoming',
              body: 'Fresh Etsy message',
              sent_at: '2026-07-28T12:00:00Z',
              attachments: [],
            }],
          },
        }
        : {};
    } else if (action === 'refreshDraftForReview') {
      data = options.refreshDraftForReview
        ? {
          draft: {
            id: 7,
            conversation_source_id: '1001',
            status: options.staleDraft ? 'SKIPPED' : 'APPROVED',
            scenario: 'freeform',
            body: 'Yes, you can attach the photos here.',
            account_label: 'reserve-test-shop',
            metadata: { generator: 'message_agent', playbook_revision: 1 },
          },
          conversation: {
            id: 1,
            source_id: '1001',
            participant: 'Ilya',
            messages: [{
              id: 91,
              source_id: 'etsy-message-91',
              sender: 'self',
              direction: 'outgoing',
              body: 'Yes, you can attach them here.',
              sent_at: '2026-07-24T09:00:00Z',
              attachments: [],
            }],
          },
          freshness: {
            current: !options.staleDraft,
            stale: options.staleDraft === true,
          },
        }
        : {};
    } else if (action === 'syncInbox') {
      data = {
        sync: { status: 'OK', mode: 'inbox_index' },
        conversations: {
          items: [{
            id: 1,
            source_id: '1001',
            participant: 'Ilya',
            needs_attention: true,
            last_message_at: '2026-07-24T09:00:00Z',
          }],
        },
      };
    } else if (action === 'previewDraft') {
      data = options.previewNoAction
        ? {
          status: 'no_action',
          scenario: body.scenario || 'freeform',
          reply_body: '',
          block_reason: 'The newest buyer message is only an acknowledgement.',
          warnings: [],
          preview_only: true,
          queued: false,
          sent: false,
        }
        : {
          status: 'ready',
          scenario: body.scenario || 'freeform',
          reply_body: 'You can attach the photos directly in this Etsy conversation.',
          rationale: 'The buyer asked how to send files.',
          warnings: [],
          preview_only: true,
          queued: false,
          sent: false,
        };
    } else if (action === 'listDrafts') {
      data = {
        items: [{
          id: 7,
          conversation_source_id: '1001',
          status: options.draftStatus || 'APPROVED',
          scenario: 'freeform',
          body: 'Yes, you can attach the photos here.',
          account_label: 'reserve-test-shop',
          metadata: { generator: 'message_agent', playbook_revision: 1 },
        }],
      };
    } else if (action === 'getDraft') {
      data = {
        id: 7,
        conversation_source_id: '1001',
        status: options.draftStatus || 'APPROVED',
        scenario: 'freeform',
        body: 'Yes, you can attach the photos here.',
        account_label: 'reserve-test-shop',
        metadata: { generator: 'message_agent', playbook_revision: 1 },
      };
    } else if (action === 'approveAndSendDraft') {
      if (options.delaySend) {
        await new Promise(resolve => setTimeout(resolve, 180));
      }
      data = {
        draft: {
          id: 7,
          conversation_source_id: '1001',
          status: 'SENT',
          scenario: 'freeform',
          body: body.body || 'Yes, you can attach the photos here.',
          account_label: options.production ? 'production-shop' : 'reserve-test-shop',
        },
        outcome: 'SENT',
        sent: true,
        delivery_attempted: true,
        idempotent_replay: false,
        retry_allowed: false,
      };
    } else if (action === 'sendApprovedDraft') {
      data = {
        id: 7,
        conversation_source_id: '1001',
        status: 'SENT',
        scenario: 'freeform',
        body: 'Yes, you can attach the photos here.',
        account_label: 'reserve-test-shop',
      };
    } else if (action === 'getPlaybook') {
      data = { revision: 1, playbook };
    } else if (action === 'getAutomationStatus') {
      data = options.automationStatus || {
        runtime: {
          implemented: true,
          enabled: true,
          worker_state: 'READY',
          telegram_notifications_enabled: true,
          last_event_at: '2026-07-28T08:20:00Z',
          last_candidate_at: '2026-07-28T08:21:00Z',
          last_error: null,
        },
        policy: {
          revision: 3,
          policy: {
            enabled: true,
            delivery_mode: 'draft_only',
            human_approval_required: true,
            rules: [{
              id: 'files-question',
              label: 'Answer file upload questions',
              enabled: true,
              event: 'new_message',
              scenario: 'how_to_send_files',
              delay_minutes: 1,
              cooldown_minutes: 1440,
              require_order_context: false,
              conditions: 'Buyer asks how to send files.',
              owner_notes: 'Use only approved upload methods.',
            }, {
              id: 'how-to-order',
              label: 'Answer ordering questions',
              enabled: false,
              event: 'new_message',
              scenario: 'how_to_order',
              delay_minutes: 0,
              cooldown_minutes: 1440,
              require_order_context: false,
              conditions: 'Buyer asks how to order.',
              owner_notes: '',
            }, {
              id: 'missing-materials',
              label: 'Request missing materials',
              enabled: false,
              event: 'order_paid',
              scenario: 'missing_materials',
              delay_minutes: 1440,
              cooldown_minutes: 10080,
              require_order_context: true,
              conditions: 'Verified paid order still has no materials.',
              owner_notes: '',
            }],
          },
        },
        recent_events: options.automationEvents || [{
          id: 'event-1',
          event: 'new_message',
          outcome: 'draft_created',
          participant: 'Ilya',
          draft_id: '7',
          reason: 'Matched file upload question.',
          created_at: '2026-07-28T08:21:00Z',
        }],
      };
    } else if (action === 'saveAutomationPolicy') {
      data = {
        revision: 4,
        policy: body.policy,
      };
    } else {
      data = {};
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
  });
}

test('reserve workspace exposes approval queue and blocks live sending', async ({ page }) => {
  await mockMessages(page);
  await page.goto(baseUrl);

  await expect(page.getByText('Reserve/test Etsy account connected')).toBeVisible();
  await expect(page.getByRole('button', { name: /Ilya/ })).toBeVisible();

  await page.getByRole('button', { name: /Approval queue/ }).click();
  await page.getByRole('button', { name: /APPROVED/ }).click();
  const send = page.getByRole('button', {
    name: 'Approve and send blocked on reserve account',
  });
  await expect(send).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(page.getByText('Human approval required')).toBeVisible();

  await page.getByRole('button', { name: 'Agent Playbook' }).click();
  await expect(page.getByRole('heading', { name: 'Teach decisions with rules and examples' })).toBeVisible();
  await expect(page.getByText('Preview the saved Playbook')).toBeVisible();
});

test('automation workspace separates wake-up, runner, and the approval queue', async ({ page }) => {
  await mockMessages(page);
  await page.goto(baseUrl);

  await expect(page.getByRole('button', { name: /Automation On/ })).toBeVisible();
  await page.getByRole('button', { name: /Automation On/ }).click();

  await expect(page.getByRole('heading', {
    name: 'When should the system prepare a draft?',
  })).toBeVisible();
  const diagnostics = page.locator('.messages-automation-diagnostics');
  await expect(diagnostics).not.toHaveAttribute('open', '');
  await diagnostics.locator('summary').click();
  await expect(page.getByText('Runner active', { exact: true })).toBeVisible();
  await expect(diagnostics.getByText('How to send files is active for new-message events.', { exact: false })).toBeVisible();
  const productionSetup = page.getByRole('region', {
    name: 'Current production automation',
  });
  await expect(productionSetup).toContainText(
    'How to send files is active for new-message events.',
  );
  await expect(productionSetup).toContainText(
    'Missing materials is currently disabled.',
  );
  await expect(productionSetup).toContainText('How to order is still disabled.');
  await expect(productionSetup).toContainText(
    'A matching event creates an AWAITING_APPROVAL draft and a dedicated Telegram notification.',
  );
  await expect(productionSetup).toContainText('The runner does not poll Etsy');
  await expect(page.getByText('Draft ready for review', { exact: true })).toBeVisible();
  await expect(page.getByText('Human approval required', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: /Draft ready for review/ }).click();
  await expect(page.getByRole('heading', { name: 'Ilya' })).toBeVisible();
  await expect(page.getByText('Conversation history with Ilya', { exact: true })).toBeVisible();
});

test('manager can edit and save draft-only automation rules', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls);
  await page.goto(baseUrl);
  await page.getByRole('button', { name: /Automation On/ }).click();
  await page.locator('[data-automation-rule] > summary').first().click();

  await page.locator('[data-auto-field="label"]').first().fill('Help customers send photos');
  const delay = page.locator('[data-duration-field="delay_minutes"]').first();
  await delay.locator('[data-duration-value]').fill('3');
  await delay.locator('[data-duration-unit]').selectOption('hours');
  await page.getByRole('button', { name: 'Save automation rules' }).click();

  await expect.poll(() =>
    calls.filter(call => call.action === 'saveAutomationPolicy').length,
  ).toBe(1);
  const save = calls.find(call => call.action === 'saveAutomationPolicy');
  expect(save.payload.expected_revision).toBe(3);
  expect(save.payload.policy).toMatchObject({
    enabled: true,
    delivery_mode: 'draft_only',
    human_approval_required: true,
  });
  expect(save.payload.policy.rules[0]).toMatchObject({
    label: 'Help customers send photos',
    delay_minutes: 180,
  });
});

test('Ukrainian manager guide explains the live automation workflow', async ({ page }) => {
  await mockMessages(page);
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Інструкція UA' }).click();

  await expect(page.getByRole('heading', {
    name: 'Your job is simply to review the draft',
  })).toBeVisible();
  await expect(page.getByText('Your main daily screen: history, draft, and decision button.')).toBeVisible();
  await expect(page.getByText('Nothing is sent until you explicitly approve it.')).toBeVisible();
  await expect(page.getByText('1', { exact: true }).last()).toBeVisible();
});

test('one-shot reserve test uses one explicit approve-and-send action', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls, { reserveTestSend: true, delaySend: true });
  await page.goto(baseUrl);

  await page.getByRole('button', { name: /Approval queue/ }).click();
  await page.getByRole('button', { name: /APPROVED/ }).click();
  const send = page.getByRole('button', {
    name: 'Approve and send one test message',
  });
  await expect(send).toBeEnabled();

  page.once('dialog', dialog => dialog.accept());
  await send.click();
  await expect(page.getByRole('button', {
    name: /Refreshing Etsy, approving and sending/,
  })).toBeDisabled();
  await expect.poll(() =>
    calls.filter(call => call.action === 'approveAndSendDraft').length,
  ).toBe(1);
  await expect(page.getByText('Message sent', { exact: true })).toBeVisible();
});

test('production approval is one explicit action with progress and one request', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls, {
    production: true,
    draftStatus: 'AWAITING_APPROVAL',
    delaySend: true,
  });
  await page.goto(baseUrl);

  await page.getByRole('button', { name: /Approval queue/ }).click();
  await page.getByRole('button', { name: /AWAITING APPROVAL/ }).click();
  const action = page.getByRole('button', {
    name: 'Approve exact text and send',
  });
  await expect(action).toBeEnabled();

  page.once('dialog', dialog => {
    expect(dialog.message()).toContain('Approve this exact text and send it now');
    dialog.accept();
  });
  await action.click();
  await expect(page.getByRole('button', {
    name: /Refreshing Etsy, approving and sending/,
  })).toBeDisabled();
  await expect.poll(() =>
    calls.filter(call => call.action === 'approveAndSendDraft').length,
  ).toBe(1);
  const request = calls.find(call => call.action === 'approveAndSendDraft');
  expect(request.payload).toMatchObject({
    draft_id: '7',
    body: 'Yes, you can attach the photos here.',
  });
  expect(request.payload.client_request_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f-]{27}$/i,
  );
  expect(calls.some(call => call.action === 'approveDraft')).toBe(false);
  expect(calls.some(call => call.action === 'sendApprovedDraft')).toBe(false);
  await expect(page.getByText('Message sent', { exact: true })).toBeVisible();
  await expect(page.locator('.messages-action-feedback.is-success')).toContainText(
    'Message sent successfully',
  );
});

test('Telegram deep link opens the requested approval draft with its conversation', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls, {
    production: true,
    draftStatus: 'AWAITING_APPROVAL',
  });
  await page.goto(`${baseUrl}?tab=queue&draft_id=7`);

  await expect(page.getByRole('button', { name: /Approval queue/ }))
    .toHaveClass(/active/);
  await expect(page.getByRole('button', { name: /AWAITING APPROVAL/ }))
    .toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ilya' })).toBeVisible();
  await expect.poll(() => calls.filter(call => call.action === 'getDraft').length)
    .toBe(1);
  await expect.poll(() =>
    calls.filter(call => call.action === 'refreshDraftForReview').length,
  ).toBe(1);
  await expect(page).toHaveURL(/#messages\?tab=queue&lang=en&draft_id=7$/);
});

test('Messages tabs create shareable URLs and clear a stale social preview id', async ({ page }) => {
  await mockMessages(page);
  await page.goto(`${baseUrl}?preview_id=old-social-post`);

  await page.getByRole('button', { name: 'Agent Playbook' }).click();
  await expect(page).toHaveURL(/\/#messages\?tab=playbook&lang=en$/);
  expect(new URL(page.url()).searchParams.has('preview_id')).toBe(false);

  await page.getByRole('button', { name: 'Інструкція UA' }).click();
  await expect(page).toHaveURL(/\/#messages\?tab=guide&lang=en$/);
});

test('an inbox conversation has a copyable deep link and reopens from it', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls);
  await page.goto(`${baseUrl}?tab=inbox&conversation_id=1001`);

  await expect.poll(() =>
    calls.filter(call => (
      call.action === 'getConversation'
      && call.conversationId === '1001'
    )).length,
  ).toBeGreaterThan(0);
  await expect(page).toHaveURL(
    /#messages\?tab=inbox&lang=en&conversation_id=1001$/,
  );
});

test('approval queue shows participant, scenario label, and conversation history together', async ({ page }) => {
  await mockMessages(page);
  await page.goto(baseUrl);

  await page.getByRole('button', { name: /Approval queue/ }).click();
  await page.getByRole('button', { name: /APPROVED/ }).click();

  await expect(page.getByRole('heading', { name: 'Ilya' })).toBeVisible();
  await expect(page.getByText('Conversation history with Ilya', { exact: true })).toBeVisible();
  await expect(page.getByText('Yes, you can attach them here.', { exact: true })).toBeVisible();
  await expect(page.getByText('Scenario: General reply · Draft #7', { exact: true })).toBeVisible();
  await expect(page.getByText('Conversation 1001', { exact: true })).toHaveCount(0);
  await expect(page.getByText('freeform · draft 7', { exact: true })).toHaveCount(0);
});

test('opening a queued draft automatically removes it when Etsy changed', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls, {
    refreshDraftForReview: true,
    staleDraft: true,
  });
  await page.goto(baseUrl);

  await page.getByRole('button', { name: /Approval queue/ }).click();
  await page.getByRole('button', { name: /APPROVED/ }).click();

  await expect.poll(() => calls.filter(call =>
    call.action === 'refreshDraftForReview',
  ).length).toBe(1);
  await expect(page.getByText(
    'This draft was removed because the Etsy conversation changed.',
    { exact: true },
  )).toBeVisible();
  await expect(page.getByRole('button', {
    name: /Approve and send/,
  })).toHaveCount(0);
});

test('conversation preview is visible but never queues, approves, or sends', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls);
  await page.goto(baseUrl);
  await page.locator('[data-conversation-id="1001"]').click();

  await page.getByRole('button', {
    name: 'Preview suggestion — nothing saved',
  }).click();

  const preview = page.locator('#messages-conversation-preview-result');
  await expect(preview).toContainText(
    'Preview only · not queued, approved, sent or notified',
  );
  await expect(preview).toContainText(
    'You can attach the photos directly in this Etsy conversation.',
  );
  const previewCall = calls.find(call => call.action === 'previewDraft');
  expect(previewCall).toMatchObject({
    conversationId: '1001',
  });
  expect(calls.some(call => [
    'generateDraft',
    'createManualDraft',
    'approveAndSendDraft',
    'approveDraft',
    'sendApprovedDraft',
  ].includes(call.action))).toBe(false);
});

test('conversation preview clearly reports when no reply is needed', async ({ page }) => {
  await mockMessages(page, [], { previewNoAction: true });
  await page.goto(baseUrl);
  await page.locator('[data-conversation-id="1001"]').click();

  await page.getByRole('button', {
    name: 'Preview suggestion — nothing saved',
  }).click();

  const preview = page.locator('#messages-conversation-preview-result');
  await expect(preview).toContainText('No reply needed');
  await expect(preview).toContainText(
    'The newest buyer message is only an acknowledgement.',
  );
});

test('draft generation failure is visible next to the action instead of failing silently', async ({ page }) => {
  await mockMessages(page, [], { failGenerate: true });
  await page.goto(baseUrl);
  await page.locator('[data-conversation-id="1001"]').click();

  await page.getByRole('button', { name: 'Generate approval draft' }).click();
  await expect(page.locator('.messages-action-feedback.is-error')).toContainText(
    'The draft agent could not prepare a valid reply',
  );
});

test('messages layout remains usable on a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockMessages(page);
  await page.goto(baseUrl);
  await expect(page.getByRole('button', { name: /Approval queue/ })).toBeVisible();
  await expect(page.locator('.messages-page-body')).toHaveCSS('max-width', '1680px');
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('conversation list uses Etsy source ID for detail and history and renders self as seller', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls);
  await page.goto(baseUrl);

  await expect(page.locator('[data-conversation-id="1001"]')).toBeVisible();
  await expect(page.locator('[data-conversation-id="1001"] time')).toContainText('Jul 24');
  await page.locator('[data-conversation-id="1001"]').click();

  await expect(page.getByText('Yes, you can attach them here.')).toBeVisible();
  await expect(page.locator('.messages-bubble.seller')).toHaveCount(1);
  expect(calls).toContainEqual(expect.objectContaining({
    action: 'getConversation',
    method: 'GET',
    conversationId: '1001',
  }));
  expect(calls.some(call => call.action === 'getConversation' && call.conversationId === '1')).toBe(false);

  await page.getByRole('button', { name: 'Load older history now' }).click();
  await expect(page.getByText('Older message')).toBeVisible();
  expect(calls).toContainEqual(expect.objectContaining({
    action: 'syncConversationHistory',
    method: 'POST',
    conversationId: '1001',
  }));
});

test('opening an indexed conversation automatically requests only its recent Etsy tail', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls, {
    emptyConversation: true,
    refreshRecentConversation: true,
  });
  await page.goto(baseUrl);

  await page.locator('[data-conversation-id="1001"]').click();
  await expect(page.getByText('Fresh Etsy message', { exact: true })).toBeVisible();
  expect(calls.filter(call =>
    call.action === 'refreshConversationRecent'
    && call.conversationId === '1001',
  )).toHaveLength(1);
  expect(calls.some(call => call.action === 'syncConversationHistory')).toBe(false);
});

test('page load is cache-only and Etsy is checked only after an explicit click', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls);
  await page.goto(baseUrl);

  expect(calls.some(call =>
    call.method === 'POST'
    && ['syncInbox', 'syncConversationHistory'].includes(call.action),
  )).toBe(false);

  await expect(page.locator('.messages-page-header').getByRole('button', {
    name: 'Refresh conversation index',
  })).toHaveCount(0);
  await page.getByText('Diagnostics / recovery').click();
  await expect(page.getByText(/without opening every thread/)).toBeVisible();
  await page.getByRole('button', { name: 'Refresh conversation index' }).click();
  await expect.poll(() => calls.filter(call => call.action === 'syncInbox').length).toBe(1);
  expect(calls.find(call => call.action === 'syncInbox')?.method).toBe('POST');
});

test('conversation index starts bounded and lazily loads deduplicated pages on scroll', async ({ page }) => {
  const calls = [];
  await mockMessages(page, calls, { paginatedConversations: true });
  await page.goto(baseUrl);

  await expect(page.locator('.messages-conversation')).toHaveCount(50);
  expect(calls.find(call => call.action === 'listConversations')).toMatchObject({
    method: 'GET',
    limit: '50',
    cursor: '0',
    all: null,
  });
  await expect(page.getByText('50 loaded · scroll for more')).toBeVisible();
  await expect(page.getByText('New', { exact: true })).toHaveAttribute(
    'title',
    'New in this dashboard',
  );

  const list = page.locator('#messages-conversation-list');
  await list.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: /Customer 51/ })).toBeVisible();
  await expect(page.locator('.messages-conversation')).toHaveCount(100);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await list.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: /Customer 120/ })).toBeVisible();
  await expect(page.locator('.messages-conversation')).toHaveCount(120);
  await expect(page.getByRole('button', { name: /Customer 120/ }).locator('time')).toHaveText('Not loaded');
  await expect(page.getByText('120 loaded', { exact: true })).toBeVisible();
});

test('local first-page refresh keeps loaded pages and the selected conversation', async ({ page }) => {
  await page.addInitScript(() => {
    window.__MESSAGES_LOCAL_REFRESH_MS = 300;
  });
  const calls = [];
  await mockMessages(page, calls, {
    paginatedConversations: true,
    refreshFirstPage: true,
  });
  await page.goto(baseUrl);

  const list = page.locator('#messages-conversation-list');
  await list.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: /Customer 56/ })).toBeVisible();
  await page.getByRole('button', { name: /Customer 56/ }).click();
  await expect(page.locator('.messages-thread-heading strong')).toHaveText('Customer 56');

  await expect(page.getByRole('button', { name: /Newest customer/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Customer 56/ })).toBeVisible();
  await expect(page.locator('.messages-thread-heading strong')).toHaveText('Customer 56');
  expect(calls.filter(call => call.method === 'POST').map(call => call.action))
    .toEqual(['markConversationViewed', 'refreshConversationRecent']);
});

test('inbox and queue filters survive their own rerenders', async ({ page }) => {
  await mockMessages(page);
  await page.goto(baseUrl);

  await page.getByLabel('Conversation filter').selectOption('true');
  await expect(page.getByLabel('Conversation filter')).toHaveValue('true');

  await page.getByRole('button', { name: /Approval queue/ }).click();
  await page.getByLabel('Draft status').selectOption('SENT');
  await expect(page.getByLabel('Draft status')).toHaveValue('SENT');
});

test('a slower stale inbox filter response cannot overwrite the latest selection', async ({ page }) => {
  await mockMessages(page, [], { delayConversationFilters: true });
  await page.goto(baseUrl);

  await page.getByLabel('Conversation filter').selectOption('true');
  await page.getByLabel('Conversation filter').selectOption('false');

  await expect(page.getByLabel('Conversation filter')).toHaveValue('false');
  await expect(page.getByRole('button', { name: /Viewed result/ })).toBeVisible();
  await page.waitForTimeout(150);
  await expect(page.getByRole('button', { name: /Viewed result/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /New result/ })).toHaveCount(0);
});

test('real Bridge-shaped directions and local attachment metadata render truthfully', async ({ page }) => {
  await mockMessages(page, [], { realisticThread: true });
  await page.goto(baseUrl);
  await page.locator('[data-conversation-id="1001"]').click();

  await expect(page.locator('.messages-bubble.incoming')).toHaveCount(18);
  await expect(page.locator('.messages-bubble.outgoing')).toHaveCount(18);
  await expect(page.getByText('Direction unavailable')).toHaveCount(0);

  const attachmentUrl = '/api/messages?action=getAttachment&attachment_id=42';
  const preview = page.locator(`.messages-attachment-preview[href="${attachmentUrl}"]`);
  await expect(preview).toBeVisible();
  await expect(preview.locator('img')).toHaveAttribute('src', attachmentUrl);
  await expect(page.locator(`a[download="finished-portrait.png"][href="${attachmentUrl}"]`)).toBeVisible();
  await expect(page.getByText('Attachment unavailable')).toBeVisible();
});

test('attachments prefer local BFF, deduplicate CDN fallback, and reject unsafe URLs', async ({ page }) => {
  await page.route('https://i.etsystatic.com/icm/12345/r/il/cdn-photo.png', route => route.abort());
  await mockMessages(page, [], { attachmentFallback: true });
  await page.goto(baseUrl);
  await page.locator('[data-conversation-id="1001"]').click();

  const cdnUrl = 'https://i.etsystatic.com/icm/12345/r/il/cdn-photo.png';
  const cdnPreview = page.locator(`.messages-attachment-preview[href="${cdnUrl}"]`);
  await expect(cdnPreview).toHaveCount(1);
  await expect(page.getByText('cdn-photo.png', { exact: true })).toHaveCount(1);
  await expect(cdnPreview).toHaveClass(/is-broken/);
  await expect(cdnPreview.getByText('Preview unavailable', { exact: true })).toBeVisible();

  const localUrl = '/api/messages?action=getAttachment&attachment_id=62';
  await expect(page.locator(`.messages-attachment-preview[href="${localUrl}"]`)).toHaveCount(1);
  await expect(page.locator(`a[download="local-first.png"][href="${localUrl}"]`)).toBeVisible();
  await expect(page.locator('[href="https://i.etsystatic.com/icm/12345/r/il/local-copy.png"]')).toHaveCount(0);

  await expect(page.getByText('Attachment unavailable')).toHaveCount(3);
  await expect(page.locator('[href^="javascript:"], [src^="javascript:"]')).toHaveCount(0);
  await expect(page.locator('[href^="data:"], [src^="data:"]')).toHaveCount(0);
  await expect(page.locator('[href*="evil.example"], [src*="evil.example"]')).toHaveCount(0);
});

test('sender labels are truthful and Etsy system events never become chat bubbles', async ({ page }) => {
  await mockMessages(page, [], { edgeDirections: true });
  await page.goto(baseUrl);
  await page.locator('[data-conversation-id="1001"]').click();

  await expect(page.locator('.messages-bubble.incoming .messages-bubble-meta strong')).toHaveText('Ilya');
  await expect(page.locator('.messages-bubble.outgoing .messages-bubble-meta strong')).toHaveText('You');
  await expect(page.getByText('Buyer', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Shop', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Direction unavailable', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Unclassified stored message', { exact: true })).toHaveCount(0);

  await expect(page.getByText('Thanks for your feedback!', { exact: true })).toHaveCount(0);
  const unknown = page.locator('.messages-event-unknown');
  await expect(unknown).not.toContainText('Stored but not classified');
  await expect(unknown).toContainText('Attachments');
  await expect(unknown).toContainText('unclassified-upload.png');
  await expect(page.getByText('Unknown text-only row', { exact: true })).toHaveCount(0);
  await expect(page.locator('.messages-bubble.unknown')).toHaveCount(0);
});

test('thread opens at the newest message and history prepend preserves the visible anchor', async ({ page }) => {
  await mockMessages(page, [], { realisticThread: true });
  await page.goto(baseUrl);
  await page.locator('[data-conversation-id="1001"]').click();
  const thread = page.locator('.messages-thread');

  await expect.poll(() => thread.evaluate(element =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(2);

  await thread.evaluate(element => {
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
  });
  const before = await thread.evaluate(element => ({
    top: element.scrollTop,
    height: element.scrollHeight,
  }));
  await page.getByRole('button', { name: 'Load older history now' }).click();
  await expect(page.getByText('Older stored message 1', { exact: true })).toBeVisible();
  const after = await thread.evaluate(element => ({
    top: element.scrollTop,
    height: element.scrollHeight,
  }));
  expect(after.height).toBeGreaterThan(before.height);
  expect(Math.abs(
    (after.top - before.top) - (after.height - before.height),
  )).toBeLessThanOrEqual(3);
});

test('long conversations render only the newest 100 messages until older rows are requested', async ({ page }) => {
  await mockMessages(page, [], { longThread: true });
  await page.goto(baseUrl);
  await page.locator('[data-conversation-id="1001"]').click();

  await expect(page.locator('.messages-bubble')).toHaveCount(100);
  await expect(page.getByText('Long stored message 250', { exact: true })).toBeVisible();
  await expect(page.getByText('Long stored message 150', { exact: true })).toHaveCount(0);
  await expect(page.getByText('250 saved · showing 100')).toBeVisible();

  await page.getByRole('button', { name: 'Show 100 older saved messages' }).click();
  await expect(page.locator('.messages-bubble')).toHaveCount(200);
  await expect(page.getByText('Long stored message 51', { exact: true })).toBeVisible();
  await expect(page.getByText('Long stored message 50', { exact: true })).toHaveCount(0);
});

test('Ukrainian manager guide explains automation without implying automatic sending', async ({ page }) => {
  await mockMessages(page, [], { locale: 'uk' });
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Як це працює' }).click();

  await expect(page.getByRole('heading', {
    name: 'Вам потрібно лише перевірити чернетку',
  })).toBeVisible();
  await expect(page.getByText('Система помітила', { exact: true })).toBeVisible();
  await expect(page.getByText('Чернетка готова', { exact: true })).toBeVisible();
  await expect(page.getByText('Ви вирішуєте', { exact: true })).toBeVisible();
  await expect(page.getByText('Без вашого натискання жодне повідомлення не надсилається.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Перейти до перевірки' })).toBeVisible();
});


test('Messages defaults to Ukrainian, keeps form edits across the language switch, and writes a shareable route', async ({ page }) => {
  await mockMessages(page, [], { locale: 'uk' });
  await page.goto(baseUrl);

  await expect(page.getByText('Повідомлення Etsy', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Коли готувати/ }).click();
  await expect(page.getByRole('heading', { name: 'Коли система має підготувати чернетку' })).toBeVisible();
  await expect(page).toHaveURL(/#messages\?tab=automation&lang=uk$/);

  await page.locator('[data-automation-rule] > summary').first().click();
  const managerName = page.locator('[data-auto-field="label"]').first();
  await managerName.fill('Незбережене правило менеджера');
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'When should the system prepare a draft?' })).toBeVisible();
  await expect(managerName).toHaveValue('Незбережене правило менеджера');
  await expect(page).toHaveURL(/#messages\?tab=automation&lang=en$/);

  await page.getByRole('button', { name: 'Agent Playbook' }).click();
  await page.locator('#pb-signature').fill('Unsaved signature');
  await page.getByRole('button', { name: 'УКР', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Навчіть агента правилами та прикладами' })).toBeVisible();
  await expect(page.locator('#pb-signature')).toHaveValue('Unsaved signature');
  await expect(page).toHaveURL(/#messages\?tab=playbook&lang=uk$/);
});

test('Automation distinguishes retry, safe block, and a stale draft from the current status', async ({ page }) => {
  await mockMessages(page, [], {
    locale: 'uk',
    automationEvents: [{
      id: 'retry',
      event: 'new_message',
      status: 'RETRYABLE_ERROR',
      outcome: 'retrying',
      reason: 'Temporary upstream failure',
      created_at: '2026-08-02T06:00:00Z',
    }, {
      id: 'blocked-with-old-draft',
      event: 'new_message',
      status: 'BLOCKED',
      outcome: 'blocked',
      draft_id: '7',
      block_code: 'MESSAGE_TRIGGER_ORDER_LINK_MISSING',
      reason: 'Bridge did not return an exact Etsy receipt link',
      created_at: '2026-08-02T05:00:00Z',
    }],
  });
  await page.goto(baseUrl);
  await page.getByRole('button', { name: /Коли готувати/ }).click();

  await expect(page.getByText('Перевірку буде повторено', { exact: true })).toBeVisible();
  await expect(page.getByText('Чернетку не створено', { exact: true })).toBeVisible();
  await expect(page.getByText('Не вдалося надійно пов’язати діалог із замовленням.')).toBeVisible();
  await expect(page.getByText('Чернетка готова до перевірки', { exact: true })).toHaveCount(0);
});

test('Automation and Playbook controls stay aligned without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await mockMessages(page, [], { locale: 'uk' });
  await page.goto(baseUrl);
  await page.getByRole('button', { name: /Коли готувати/ }).click();
  expect(await page.locator('#messages-workspace').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.locator('[data-automation-rule] > summary').first().click();
  await expect(page.locator('[data-auto-field="label"]').first()).toHaveCSS('border-top-style', 'solid');
  const firstRule = page.locator('[data-automation-rule]').first();
  const delay = firstRule.locator('[data-duration-field="delay_minutes"]');
  const cooldown = firstRule.locator('[data-duration-field="cooldown_minutes"]');
  await expect(delay.locator('[data-duration-value]')).toHaveValue('1');
  await expect(delay.locator('[data-duration-unit]')).toHaveValue('minutes');
  await expect(cooldown.locator('[data-duration-value]')).toHaveValue('1');
  await expect(cooldown.locator('[data-duration-unit]')).toHaveValue('days');
  const [delayBox, cooldownBox] = await Promise.all([delay.boundingBox(), cooldown.boundingBox()]);
  expect(Math.abs(delayBox.y - cooldownBox.y)).toBeLessThanOrEqual(3);
  await expect(firstRule.locator('.messages-rule-advanced')).not.toHaveAttribute('open', '');
  const help = firstRule.locator('.messages-help-tip').first();
  await expect(help).toHaveAttribute('aria-label', /Назвіть правило/);
  await help.focus();
  await expect(help).toBeFocused();

  await page.getByRole('button', { name: 'Як відповідати' }).click();
  expect(await page.locator('#messages-workspace').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(page.locator('#pb-signature')).toHaveCSS('border-top-style', 'solid');
  await expect(page.getByText('Повідомлення клієнта', { exact: true })).toBeVisible();
  await expect(page.getByText('Перевірені факти або вказівка менеджера', { exact: true })).toBeVisible();
});

test('mounted local refresh is GET-only, never syncs Etsy, and stops on cleanup', async ({ page }) => {
  await page.addInitScript(() => {
    window.__MESSAGES_LOCAL_REFRESH_MS = 60;
  });
  const calls = [];
  await mockMessages(page, calls);
  await page.goto(baseUrl);
  await page.locator('[data-conversation-id="1001"]').click();
  await expect.poll(() => calls.filter(call =>
    call.action === 'markConversationViewed',
  ).length).toBe(1);
  const baseline = calls.length;

  await expect.poll(() => calls.slice(baseline).filter(call =>
    call.action === 'listConversations',
  ).length).toBeGreaterThanOrEqual(2);
  const refreshCalls = calls.slice(baseline);
  expect(refreshCalls.length).toBeGreaterThan(0);
  expect(refreshCalls.every(call => call.method === 'GET')).toBe(true);
  expect(refreshCalls.every(call =>
    ['status', 'listConversations', 'getAutomationStatus', 'listDrafts'].includes(call.action),
  )).toBe(true);
  expect(calls.some(call => call.action === 'syncInbox')).toBe(false);

  await page.evaluate(() => window.__pageCleanup());
  await page.waitForTimeout(40);
  const afterCleanup = calls.length;
  await page.waitForTimeout(180);
  expect(calls).toHaveLength(afterCleanup);
});

test('unchanged local refresh does not reload or rerender the open conversation', async ({ page }) => {
  await page.addInitScript(() => {
    window.__MESSAGES_LOCAL_REFRESH_MS = 500;
  });
  const calls = [];
  await mockMessages(page, calls, { realisticThread: true });
  await page.goto(baseUrl);
  await page.locator('[data-conversation-id="1001"]').click();
  const thread = page.locator('.messages-thread');
  await expect.poll(() => thread.evaluate(element =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(2);
  await thread.evaluate(element => {
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 3);
  });
  const before = await thread.evaluate(element => element.scrollTop);
  const detailCalls = calls.filter(call => call.action === 'getConversation').length;

  await expect.poll(() => calls.filter(call =>
    call.action === 'listConversations',
  ).length).toBeGreaterThanOrEqual(2);
  expect(calls.filter(call => call.action === 'getConversation')).toHaveLength(detailCalls);
  const after = await thread.evaluate(element => element.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
});
