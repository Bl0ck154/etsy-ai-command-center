import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

function safeSchedulePost(overrides = {}) {
  return {
    id: 'schedule-delete-regression-1',
    caption: 'Schedule delete regression post',
    platform: 'pinterest',
    scheduled_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    status: 'scheduled',
    created_at: Date.now(),
    media_items: [{ url: 'https://example.test/schedule-delete.jpg', type: 'image' }],
    ...overrides,
  };
}

async function installScheduleApiMocks(page, initialPosts, { beforeDelete, beforePublishDue, beforeCanaryReadiness, beforeApprove, schedulerStatus = {} } = {}) {
  let posts = [...initialPosts];

  await page.route('**/api/login', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true }) });
  });

  await page.route('**/api/social', async route => {
    const body = route.request().postDataJSON?.() || {};
    if (body.action === 'schedulerStatus') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, autopublish_enabled: false, due: 0, overdue_total: 0, scheduled: posts.length, published: 0, failed: 0, ...schedulerStatus }),
      });
      return;
    }
    if (body.action === 'publishDueScheduled') {
      await beforePublishDue?.(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, due_count: 1, results: [{ success: true, dryRun: true }] }),
      });
      return;
    }
    if (body.action === 'adminCanaryReadiness') {
      await beforeCanaryReadiness?.(body);
      const target = posts.find(item => String(item.id) === String(body.id)) || posts[0];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            checked_at: new Date().toISOString(),
            requested_id: body.id || null,
            summary: { total_checked: target ? 1 : 0, ready_for_owner_approval: target ? 1 : 0, blocked: 0, autopublish_enabled: false },
            candidates: target ? [{
              id: target.id,
              platform: target.platform,
              verdict: 'ready_for_owner_approval',
              ready_for_canary_approval: true,
              publish_route: `${target.platform}_direct`,
              media_count: (target.media_items || []).length,
              preview: {
                caption: target.caption,
                media_items: target.media_items || [],
                listing_url: target.listing_id ? `https://www.etsy.com/listing/${target.listing_id}` : '',
              },
              blockers: [],
            }] : [],
          },
          saved: false,
          published: false,
        }),
      });
      return;
    }
    if (body.action === 'approveScheduledPost') {
      await beforeApprove?.(body);
      const now = new Date().toISOString();
      let updated = null;
      posts = posts.map(item => {
        if (String(item.id) !== String(body.id)) return item;
        updated = {
          ...item,
          status: 'approved_scheduled',
          approved_for_publish: true,
          approved_by: body.approved_by || 'admin-ui',
          approved_at: now,
        };
        return updated;
      });
      await route.fulfill({
        status: updated ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(updated ? { success: true, data: updated, published: false } : { error: 'not found' }),
      });
      return;
    }
    if (body.action === 'restoreScheduledPostToDraft') {
      await new Promise(resolve => setTimeout(resolve, 400));
      const index = posts.findIndex(item => String(item.id) === String(body.id));
      let restoredFromSnapshot = false;
      let record;
      if (index >= 0) {
        record = {
          ...posts[index],
          status: 'draft',
          scheduled_at: null,
          approved_for_publish: false,
        };
        posts[index] = record;
      } else {
        restoredFromSnapshot = true;
        record = {
          ...(body.snapshot || {}),
          id: `${body.id}-restored-test`,
          status: 'draft',
          scheduled_at: null,
          approved_for_publish: false,
        };
        posts.unshift(record);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { record, restored_from_snapshot: restoredFromSnapshot }, published: false }),
      });
      return;
    }
    if (body.action === 'recoverQueuedExternalPostToDraft') {
      await new Promise(resolve => setTimeout(resolve, 400));
      const index = posts.findIndex(item => String(item.id) === String(body.id));
      if (index < 0) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found', code: 'NOT_FOUND' }) });
        return;
      }
      const original = { ...posts[index], status: 'failed' };
      const record = {
        ...posts[index],
        id: `${body.id}-recovered-test`,
        status: 'draft',
        scheduled_at: null,
        approved_for_publish: false,
      };
      posts[index] = original;
      posts.unshift(record);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { record, original }, published: false }),
      });
      return;
    }
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected social action' }) });
  });

  await page.route('**/api/kv', async route => {
    const body = route.request().postDataJSON?.() || {};
    if (body.action === 'getScheduledPosts') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: posts }) });
      return;
    }
    if (body.action === 'deleteScheduledPost') {
      await beforeDelete?.(body);
      posts = posts.filter(item => item.id !== body.value?.id);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { deleted: 1, remaining: posts.length } }) });
      return;
    }
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected kv action' }) });
  });
}

test('empty schedule explains the calendar is ready, not broken', async ({ page }) => {
  await installScheduleApiMocks(page, []);

  await page.goto('/#schedule');
  await expect(page.getByText('Calendar ready')).toBeVisible();
  await expect(page.getByText('Your content calendar is empty right now')).toBeVisible();
  await expect(page.getByText(/it is not broken/)).toBeVisible();
  await expect(page.getByText(/Empty calendar days are intentionally quiet/)).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Create post' })).toBeVisible();
  await expect(page.locator('#sched-autopilot-btn')).toHaveCount(0);
  await expect(page.locator('#sched-empty-autopilot')).toHaveCount(0);
});

test('manual due check uses dry-run payload and copy', async ({ page }) => {
  let publishDuePayload = null;
  await installScheduleApiMocks(page, [safeSchedulePost()], {
    beforePublishDue: async body => { publishDuePayload = body; },
  });

  await page.goto('/#schedule');
  const checkBtn = page.getByRole('button', { name: 'Check due' });
  await expect(checkBtn).toBeVisible();
  await expect(page.getByText(/Publishing is disabled; due checks remain dry-run only/)).toBeVisible();
  await checkBtn.click();
  await expect(page.locator('.toast-success .toast-text')).toContainText('dry-run checked');
  expect(publishDuePayload).toMatchObject({ action: 'publishDueScheduled', dryRun: true, limit: 10 });
});

test('scheduler safety banner reflects live autopublish governance from the backend', async ({ page }) => {
  await installScheduleApiMocks(page, [safeSchedulePost()], {
    schedulerStatus: { autopublish_enabled: true },
  });

  await page.goto('/#schedule');
  await expect(page.getByText('live', { exact: true })).toBeVisible();
  await expect(page.getByText(/Approved scheduled posts publish automatically when due/)).toBeVisible();
  await expect(page.getByText('approved posts publish automatically', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/real publishing remains disabled/)).toHaveCount(0);
});

test('calendar populated day opens detail modal with post actions', async ({ page }) => {
  await installScheduleApiMocks(page, [safeSchedulePost({ id: 'schedule-modal-regression-1' })]);

  await page.goto('/#schedule');
  await expect(page.locator('.page-title')).toContainText('Content Schedule');
  await expect(page.locator('text=Queue controls')).toBeVisible();
  await expect(page.locator('#sched-view')).toHaveValue('active');
  await expect(page.locator('#sched-view')).toContainText('Drafts');
  await expect(page.locator('#sched-sort')).toBeVisible();
  await expect(page.locator('#sched-sort')).toHaveValue('upcoming');
  await expect(page.locator('#sched-page-size')).toBeVisible();
  await expect(page.locator('#sched-page-size')).toHaveValue('20');
  await expect(page.locator('#sched-queue').getByText('Active queue', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(page.locator('#sched-mini-cal')).toBeVisible();
  await page.locator('[data-day-key]').filter({ hasText: /scheduled|published|failed|more|\d{1,2}:\d{2}|AM|PM/i }).first().click();

  await expect(page.locator('#sched-day-modal')).toBeVisible();
  await expect(page.locator('#sched-day-modal').getByRole('button', { name: /Close/i })).toBeVisible();
  await expect(page.locator('#sched-day-modal').locator('.card').first()).toBeVisible();
  await expect(page.locator('#sched-day-modal').getByRole('button', { name: /Edit/i }).first()).toBeVisible();
  await expect(page.locator('#sched-day-modal').getByRole('button', { name: /Move to drafts/i }).first()).toBeVisible();
  await expect(page.locator('#sched-day-modal').getByRole('button', { name: /Reschedule/i }).first()).toBeVisible();
  await expect(page.locator('#sched-day-modal').getByRole('button', { name: /Approve auto|Pause auto/i }).first()).toBeVisible();
  await expect(page.locator('#sched-day-modal').getByRole('button', { name: /Check readiness/i }).first()).toBeVisible();
});

test('content schedule opens on the queue and keeps the calendar opt-in', async ({ page }) => {
  await installScheduleApiMocks(page, [safeSchedulePost({ id: 'schedule-calendar-opt-in' })]);

  await page.goto('/#schedule');
  await expect(page.locator('#sched-queue')).toBeVisible();
  await expect(page.locator('#sched-mini-cal')).toHaveCount(0);
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(page.locator('#sched-mini-cal')).toBeVisible();
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(page.locator('#sched-mini-cal')).toHaveCount(0);
});

test('scheduled posts show both US audience time and owner Kyiv time', async ({ page }) => {
  await installScheduleApiMocks(page, [safeSchedulePost({
    id: 'schedule-dual-timezone',
    scheduled_at: '2030-07-20T13:00:00.000Z',
    scheduled_timezone: 'America/New_York',
  })]);
  await page.goto('/#schedule');

  const card = page.locator('[data-sched-post-card="schedule-dual-timezone"]');
  await expect(card).toContainText('US Eastern');
  await expect(card).toContainText('Kyiv');
  await expect(card.locator('.sched-time-primary-value')).toHaveText('16:00');
  await expect(card.locator('.sched-time-primary')).not.toContainText('PM');
  await expect(card.locator('.sched-time-audience-value')).toContainText('9:00 AM');
});

test('editing a legacy all-platform record requires one concrete platform', async ({ page }) => {
  await installScheduleApiMocks(page, [safeSchedulePost({
    id: 'schedule-legacy-all-platform',
    platform: 'all',
  })]);
  await page.goto('/#schedule');

  const card = page.locator('[data-sched-post-card="schedule-legacy-all-platform"]');
  await card.locator('[data-sched-action="edit"]').click();
  await expect(page.locator('#ed-platform')).toHaveValue('');
  await expect(page.locator('#ed-platform option[value="all"]')).toHaveCount(0);
  await expect(page.locator('#ed-platform')).toContainText('Choose a concrete platform');
});

test('Pinterest editor blocks multiple images before saving', async ({ page }) => {
  await installScheduleApiMocks(page, [safeSchedulePost({
    id: 'schedule-pinterest-multiple-media',
    platform: 'pinterest',
    listing_image_url: 'https://example.test/listing-image.jpg',
    media_items: [{ url: 'https://example.test/second-image.jpg', type: 'image' }],
  })]);
  await page.goto('/#schedule');

  const card = page.locator('[data-sched-post-card="schedule-pinterest-multiple-media"]');
  await card.locator('[data-sched-action="edit"]').click();
  await page.locator('#ed-save').click();
  await expect(page.getByText('Pinterest requires exactly one image; this post currently has 2.')).toBeVisible();
  await expect(page.locator('#sched-modal')).toBeVisible();
});

test('schedule card separates post copy and links the promoted Etsy listing without redundant controls', async ({ page }) => {
  await installScheduleApiMocks(page, [safeSchedulePost({
    id: 'schedule-information-hierarchy',
    caption: 'Short platform-ready copy that should be visible without an expand control.',
    listing_id: '1234567890',
    listing_title: 'Custom family portrait merge service',
    status: 'approved_scheduled',
    approved_for_publish: true,
  })]);
  await page.goto('/#schedule');

  const card = page.locator('[data-sched-post-card="schedule-information-hierarchy"]');
  await expect(card.locator('.sched-caption-panel')).toContainText('Post copy');
  await expect(card.locator('.sched-caption-panel')).toContainText('Short platform-ready copy');
  await expect(card.locator('[data-sched-expand-label="post copy"]')).toHaveCount(0);
  await expect(card.getByRole('link', { name: /Custom family portrait merge service/ })).toHaveAttribute('href', 'https://www.etsy.com/listing/1234567890');
  await expect(card.getByText('Approved auto', { exact: true })).toHaveCount(1);
  await expect(card.getByText('Auto approved', { exact: true })).toHaveCount(0);
  await expect(card.locator('.sched-post-footnote')).toContainText('Created');
  await expect(card.getByRole('button', { name: 'Reschedule', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: /Tomorrow/i })).toHaveCount(0);
});

test('active queue excludes stale overdue records while the stale view keeps them auditable', async ({ page }) => {
  await installScheduleApiMocks(page, [
    safeSchedulePost({
      id: 'schedule-stale-overdue',
      title: 'Historical overdue post',
      scheduled_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      status: 'scheduled',
    }),
    safeSchedulePost({
      id: 'schedule-future-active',
      title: 'Upcoming active post',
      scheduled_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      status: 'scheduled',
    }),
  ]);

  await page.goto('/#schedule');
  await expect(page.locator('[data-sched-post-card="schedule-stale-overdue"]')).toHaveCount(0);
  await expect(page.locator('[data-sched-post-card="schedule-future-active"]')).toHaveCount(1);

  await page.selectOption('#sched-view', 'stale');
  await expect(page.locator('[data-sched-post-card="schedule-stale-overdue"]')).toHaveCount(1);
});

test('telegram owner-review deep link opens schedule package records by campaign or base id', async ({ page }) => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const posts = [
    safeSchedulePost({
      id: 'owner-review-package-instagram',
      platform: 'instagram',
      caption: 'Instagram owner review caption with approved hashtags. #etsyshop #giftidea #customgift',
      scheduled_at: future,
      metadata: { owner_review_required: true },
      approval_source: 'owner_review_required',
      approved_for_publish: false,
    }),
    safeSchedulePost({
      id: 'saved-facebook-record',
      platform: 'facebook',
      caption: 'Facebook owner review caption for the same campaign.',
      scheduled_at: future,
      metadata: { campaign_id: 'owner-review-package', owner_review_required: true },
      approval_source: 'owner_review_required',
      approved_for_publish: false,
    }),
    safeSchedulePost({
      id: 'owner-review-package-pinterest',
      platform: 'pinterest',
      caption: 'Pinterest owner review caption for the same package.',
      scheduled_at: future,
      metadata: { owner_review_required: true },
      approval_source: 'owner_review_required',
      approved_for_publish: false,
    }),
  ];
  await installScheduleApiMocks(page, posts);

  await page.goto('/schedule?preview_id=owner-review-package');

  await expect(page.locator('.page-title')).toContainText('Content Schedule');
  await expect(page.getByText('Opened linked review: owner-review-package (3 platform records)')).toBeVisible();
  const modal = page.locator('#sched-review-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByText('Owner review package')).toBeVisible();
  await expect(modal.locator('[data-sched-post-card]')).toHaveCount(3);
  await expect(modal.locator('[data-sched-post-card="owner-review-package-instagram"]')).toContainText('Instagram');
  await expect(modal.locator('[data-sched-post-card="saved-facebook-record"]')).toContainText('Facebook');
  await expect(modal.locator('[data-sched-post-card="owner-review-package-pinterest"]')).toContainText('Pinterest');
  await expect(modal.getByText(/does not publish or approve autopublish/)).toBeVisible();
});

test('preview deep link opens its real page once and then allows normal pagination and filters', async ({ page }) => {
  const baseTime = Date.now() + 24 * 60 * 60 * 1000;
  const posts = Array.from({ length: 25 }, (_, index) => safeSchedulePost({
    id: index === 24 ? 'deep-link-page-target' : `deep-link-page-${String(index + 1).padStart(2, '0')}`,
    caption: `Pagination post ${index + 1}`,
    platform: 'pinterest',
    scheduled_at: new Date(baseTime + index * 60_000).toISOString(),
  }));
  await installScheduleApiMocks(page, posts);

  await page.goto('/schedule?preview_id=deep-link-page-target');

  const queue = page.locator('#sched-queue');
  await expect(queue).toContainText('Showing 21-25 of 25');
  await expect(queue.locator('[data-sched-post-card="deep-link-page-target"]')).toBeVisible();
  await expect(page.locator('#sched-view-modal')).toBeVisible();
  await page.locator('#sched-view-close').click();

  await queue.getByRole('button', { name: 'Previous page' }).first().click();
  await expect(queue).toContainText('Showing 1-20 of 25');
  await expect(queue.locator('[data-sched-post-card="deep-link-page-target"]')).toHaveCount(0);
  await expect(queue.getByRole('button', { name: 'Go to page 1' }).first()).toHaveAttribute('aria-current', 'page');

  await page.locator('#sched-platform').selectOption('instagram');
  await expect(page.locator('#sched-platform')).toHaveValue('instagram');
  await expect(page.getByText('Nothing matches this filtered view')).toBeVisible();
});

test('long card content stays bounded and full copy opens in the viewer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const caption = Array.from({ length: 24 }, (_, index) => `Caption line ${index + 1} with campaign context and approved copy.`).join('\n');
  const lastError = `Remote publishing error: ${'provider response exceeded the expected limit. '.repeat(30)}`;
  await installScheduleApiMocks(page, [safeSchedulePost({
    id: 'schedule-bounded-content',
    caption,
    last_error: lastError,
    listing_id: '1234567890',
    listing_title: `Long listing title ${'with detailed personalization metadata '.repeat(18)}`,
    publish_method: `external-provider-${'long-metadata-'.repeat(20)}`,
  })]);

  await page.goto('/#schedule');

  const card = page.locator('[data-sched-post-card="schedule-bounded-content"]');
  await expect(card).toBeVisible();
  expect((await card.locator('[data-media-candidates]').first().boundingBox())?.width || 0).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const errorToggle = card.getByRole('button', { name: 'Show full error details' });
  await expect(card.locator('[data-sched-expand-label="post copy"]')).toHaveCount(0);
  await expect(card.locator('.sched-caption-copy')).toHaveClass(/is-bounded/);
  await expect(errorToggle).toBeVisible();
  await expect(card.getByRole('link', { name: /Long listing title/ })).toHaveAttribute('href', 'https://www.etsy.com/listing/1234567890');
  await expect(card.getByRole('button', { name: 'Show full publish method' })).toBeVisible();

  const openTarget = card.locator('[data-sched-action="view"]');
  await openTarget.focus();
  await page.keyboard.press('Enter');
  const modal = page.locator('#sched-view-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.sched-caption-panel')).toContainText('Caption line 24');
  await expect(page.locator('#sched-view-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(openTarget).toBeFocused();
});

test('day detail uses bounded incremental loading for busy dates', async ({ page }) => {
  const scheduled = new Date();
  scheduled.setDate(scheduled.getDate() + 2);
  scheduled.setHours(9, 0, 0, 0);
  const dayKey = `${scheduled.getFullYear()}-${String(scheduled.getMonth() + 1).padStart(2, '0')}-${String(scheduled.getDate()).padStart(2, '0')}`;
  const posts = Array.from({ length: 15 }, (_, index) => safeSchedulePost({
    id: `busy-day-${String(index + 1).padStart(2, '0')}`,
    caption: `Busy day post ${index + 1}`,
    scheduled_at: new Date(scheduled.getTime() + index * 60_000).toISOString(),
  }));
  await installScheduleApiMocks(page, posts);

  await page.goto('/#schedule');
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.locator(`[data-day-key="${dayKey}"]`).click();

  const modal = page.locator('#sched-day-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('[data-sched-post-card]')).toHaveCount(10);
  const loadMore = modal.getByRole('button', { name: 'Load 5 more' });
  await expect(loadMore).toBeVisible();
  await loadMore.click();
  await expect(modal.locator('[data-sched-post-card]')).toHaveCount(15);
  await expect(modal.locator('[data-sched-load-more]')).toHaveCount(0);
});

test('filtered empty state explains hidden queue and offers reset', async ({ page }) => {
  await installScheduleApiMocks(page, [safeSchedulePost({
    id: 'schedule-filter-empty-helper',
    caption: 'Pinterest calendar item hidden by platform filter',
    platform: 'pinterest',
  })]);

  await page.goto('/#schedule');
  await expect(page.locator('[data-sched-post-card="schedule-filter-empty-helper"]')).toBeVisible();

  await page.locator('#sched-platform').selectOption('instagram');
  await expect(page.getByText('Nothing matches this filtered view')).toBeVisible();
  await expect(page.getByText(/hides the existing queue/)).toBeVisible();
  await expect(page.getByText('1 saved record')).toBeVisible();

  await page.getByRole('button', { name: 'Reset to active queue' }).click();
  await expect(page.locator('#sched-platform')).toHaveValue('all');
  await expect(page.locator('[data-sched-post-card="schedule-filter-empty-helper"]')).toBeVisible();
});

test('empty active queue separates paused history from upcoming posts', async ({ page }) => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await installScheduleApiMocks(page, [
    safeSchedulePost({ id: 'paused-history-1', caption: 'Paused history one', status: 'paused', scheduled_at: future }),
    safeSchedulePost({ id: 'paused-history-2', caption: 'Paused history two', status: 'paused', scheduled_at: future }),
  ]);

  await page.goto('/#schedule');

  await expect(page.getByText('No active posts are waiting to publish')).toBeVisible();
  await expect(page.locator('[data-sched-empty-metric="scheduled"]')).toHaveText('0');
  await expect(page.locator('[data-sched-empty-metric="paused"]')).toHaveText('2');
  await page.getByRole('button', { name: 'View 2 paused' }).click();
  await expect(page.locator('[data-sched-post-card]')).toHaveCount(2);
  await expect(page.getByText(/Paused records are preserved for audit/)).toBeVisible();
});

test('clicking a scheduled post card opens full carousel preview with full-size image links', async ({ page }) => {
  const post = safeSchedulePost({
    id: 'schedule-carousel-viewer',
    caption: 'Carousel preview target',
    platform: 'instagram',
    media_items: [
      { url: 'https://example.test/carousel-1.jpg', type: 'image' },
      { url: 'https://example.test/carousel-2.jpg', type: 'image' },
      { url: 'https://example.test/carousel-3.jpg', type: 'image' },
    ],
  });
  await installScheduleApiMocks(page, [post]);
  await page.goto('/#schedule');

  const card = page.locator('[data-sched-post-card="schedule-carousel-viewer"]');
  await expect(card).toBeVisible();
  await expect(card.getByText('Open full post')).toHaveCount(0);
  await card.locator('.sched-post-main').click();

  const viewer = page.locator('#sched-view-modal');
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText('Carousel preview target')).toBeVisible();
  await expect(viewer.locator('a[title^="Open image"]')).toHaveCount(3);
  await expect(viewer.getByText('1/3')).toBeVisible();
  await expect(viewer.getByText('3/3')).toBeVisible();
  await expect(viewer.locator('a[title="Open image 1 full size"]')).toHaveAttribute('href', 'https://example.test/carousel-1.jpg');
});

test('media asset thumbnails retry on the current origin before showing broken state', async ({ page }) => {
  const oldHostAsset = 'https://old-staging.example.test/api/social?action=mediaAsset&id=shmedia_current_origin_retry';
  const post = safeSchedulePost({
    id: 'schedule-media-origin-retry',
    caption: 'Media origin retry target',
    platform: 'instagram',
    media_items: [{ url: oldHostAsset, type: 'image' }],
  });

  let currentOriginRequested = false;
  await page.route('**/api/social?action=mediaAsset&id=shmedia_current_origin_retry**', async route => {
    currentOriginRequested = true;
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="orange"/></svg>',
    });
  });
  await installScheduleApiMocks(page, [post]);

  await page.goto('/#schedule');
  const card = page.locator('[data-sched-post-card="schedule-media-origin-retry"]');
  await expect(card).toBeVisible();
  await expect.poll(() => currentOriginRequested).toBe(true);
  await expect(card.locator('[data-broken-badge]')).toBeHidden();
  await expect(card.locator('img').first()).toHaveAttribute('src', /\/api\/social\?action=mediaAsset&id=shmedia_current_origin_retry&retry=1/);
});

test('status filters expose approved, queued external, missing media, and stale posts', async ({ page }) => {
  const now = Date.now();
  const future = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const posts = [
    safeSchedulePost({
      id: 'schedule-filter-approved',
      caption: 'Approved auto filter target',
      status: 'approved_scheduled',
      approved_for_publish: true,
      scheduled_at: future,
    }),
    safeSchedulePost({
      id: 'schedule-filter-queued',
      caption: 'Queued external filter target',
      status: 'queued_external',
      scheduled_at: future,
      publish_method: 'make',
    }),
    safeSchedulePost({
      id: 'schedule-filter-missing-media',
      caption: 'Missing media filter target',
      status: 'scheduled',
      scheduled_at: future,
      media_items: [],
    }),
    safeSchedulePost({
      id: 'schedule-filter-stale',
      caption: 'Stale overdue filter target',
      status: 'scheduled',
      scheduled_at: past,
    }),
    safeSchedulePost({
      id: 'schedule-filter-regular',
      caption: 'Regular scheduled control target',
      status: 'scheduled',
      scheduled_at: future,
    }),
    safeSchedulePost({
      id: 'schedule-filter-paused',
      caption: 'Paused legacy control target',
      status: 'paused',
      scheduled_at: future,
    }),
  ];

  await installScheduleApiMocks(page, posts);

  await page.goto('/#schedule');
  await expect(page.locator('.page-title')).toContainText('Content Schedule');
  await expect(page.locator('#sched-status-filter')).toContainText('Approved auto');
  await expect(page.locator('#sched-status-filter')).toContainText('Queued externally');
  await expect(page.locator('#sched-status-filter')).toContainText('Missing media');
  await expect(page.locator('#sched-status-filter')).toContainText('Stale overdue');
  await expect(page.locator('#sched-status-filter')).toContainText('Paused');
  await expect(page.locator('#sched-metric-total')).toHaveText('6');
  await expect(page.locator('[data-sched-post-card="schedule-filter-paused"]')).toHaveCount(0);

  await page.locator('#sched-status-filter').selectOption('approved_scheduled');
  await expect(page.locator('[data-sched-post-card="schedule-filter-approved"]')).toBeVisible();
  await expect(page.locator('[data-sched-post-card="schedule-filter-regular"]')).toHaveCount(0);

  await page.locator('#sched-view').selectOption('all');
  await page.locator('#sched-status-filter').selectOption('queued_external');
  await expect(page.locator('[data-sched-post-card="schedule-filter-queued"]')).toBeVisible();
  await expect(page.locator('[data-sched-post-card="schedule-filter-approved"]')).toHaveCount(0);

  await page.locator('#sched-view').selectOption('paused');
  await page.locator('#sched-status-filter').selectOption('all');
  const pausedCard = page.locator('[data-sched-post-card="schedule-filter-paused"]');
  await expect(pausedCard).toBeVisible();
  await expect(pausedCard).toContainText('ignored by autopublish');
  await expect(pausedCard.getByRole('button', { name: /Restore to drafts/i })).toBeVisible();
  await expect(pausedCard.getByRole('button', { name: /Approve auto/i })).toHaveCount(0);
  await expect(pausedCard.getByRole('button', { name: /Safe publish/i })).toHaveCount(0);

  await page.locator('#sched-view').selectOption('all');
  await page.locator('#sched-status-filter').selectOption('missing_media');
  await expect(page.locator('[data-sched-post-card="schedule-filter-missing-media"]')).toBeVisible();
  await expect(page.locator('[data-sched-post-card="schedule-filter-queued"]')).toHaveCount(0);

  await page.locator('#sched-view').selectOption('all');
  await page.locator('#sched-status-filter').selectOption('stale');
  await expect(page.locator('[data-sched-post-card="schedule-filter-stale"]')).toBeVisible();
  await expect(page.locator('[data-sched-post-card="schedule-filter-missing-media"]')).toHaveCount(0);
});

test('approve auto uses canary readiness preview before admin approval', async ({ page }) => {
  const post = safeSchedulePost({
    id: 'schedule-canary-approve',
    platform: 'facebook',
    listing_id: '1234567890',
    caption: 'Canary approval target caption for a shop-aware Facebook post.',
    scheduled_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    media_items: [{ url: 'https://example.test/canary-ready.jpg', type: 'image' }],
  });
  let readinessPayload = null;
  let approvePayload = null;
  page.on('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('Canary readiness passed');
    expect(dialog.message()).toContain('facebook_direct');
    expect(dialog.message()).toContain('Canary approval target caption');
    await dialog.accept();
  });

  await installScheduleApiMocks(page, [post], {
    beforeCanaryReadiness: async body => { readinessPayload = body; },
    beforeApprove: async body => { approvePayload = body; },
  });

  await page.goto('/#schedule');
  const card = page.locator('[data-sched-post-card="schedule-canary-approve"]');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Approve auto/i }).click();
  await expect(page.locator('.toast-success .toast-text')).toContainText('Approved for safe autopublish');
  await expect(card.getByRole('button', { name: /Pause auto/i })).toBeVisible();
  await expect(card.getByText('Approved auto', { exact: true })).toHaveCount(1);
  expect(readinessPayload).toMatchObject({ action: 'adminCanaryReadiness', id: 'schedule-canary-approve', probe_media: true });
  expect(approvePayload).toMatchObject({ action: 'approveScheduledPost', id: 'schedule-canary-approve', approved_by: 'admin-ui' });
});

test('restore to drafts moves a paused post through the recovery API', async ({ page }) => {
  const post = safeSchedulePost({
    id: 'schedule-stale-restore',
    status: 'paused',
    caption: 'Recover this useful post',
  });
  await installScheduleApiMocks(page, [post]);
  await page.goto('/#schedule');
  await page.locator('#sched-view').selectOption('paused');

  const button = page.locator('[data-sched-post-card="schedule-stale-restore"]').getByRole('button', { name: 'Restore to drafts' });
  await button.evaluate(element => element.click());
  await expect(page.getByText('Moved to drafts.')).toBeVisible();
  await expect(page.locator('#sched-metric-drafts')).toHaveText('1');
});

test('externally queued posts expose refresh and safe draft-copy recovery', async ({ page }) => {
  const post = safeSchedulePost({
    id: 'schedule-external-recovery',
    status: 'queued_external',
    platform: 'pinterest',
    caption: 'Keep this Pinterest idea',
  });
  await installScheduleApiMocks(page, [post]);
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/#schedule');
  await page.locator('#sched-view').selectOption('all');
  await page.locator('#sched-status-filter').selectOption('queued_external');

  const card = page.locator('[data-sched-post-card="schedule-external-recovery"]');
  await expect(card.getByRole('button', { name: 'Refresh status' })).toBeVisible();
  const recover = card.getByRole('button', { name: 'Recover draft copy' });
  await recover.evaluate(element => element.click());
  await expect(page.getByText(/Recovered an unapproved draft copy/)).toBeVisible();

  await page.locator('#sched-status-filter').selectOption('all');
  await page.locator('#sched-view').selectOption('drafts');
  await expect(page.locator('[data-sched-post-card="schedule-external-recovery-recovered-test"]')).toBeVisible();
});

test('safe publish check guides unscheduled drafts to the schedule field', async ({ page }) => {
  const draft = safeSchedulePost({
    id: 'schedule-safe-publish-needs-date',
    status: 'draft',
    scheduled_at: null,
  });

  await installScheduleApiMocks(page, [draft]);
  await page.goto('/#schedule');
  await page.locator('#sched-view').selectOption('drafts');

  const card = page.locator(`[data-sched-post-card="${draft.id}"]`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Check readiness/i }).click();

  await expect(page.locator('.toast-info .toast-text')).toContainText('Choose a future schedule date');
  await expect(page.locator('#sched-editor-schedule-notice')).toContainText('Nothing will be published from this check');
  await expect(page.locator('#ed-date')).toBeFocused();
  await expect(page.locator('#ed-date')).toHaveAttribute('min', /.+/);
});

test('agent drafts are visible from the Drafts view with agent badge', async ({ page }) => {
  const draft = safeSchedulePost({
    id: 'agent-autonomy-draft-visibility',
    caption: 'Agent draft visibility target',
    status: 'draft',
    scheduled_at: null,
    source: 'social_hermes',
    created_by: 'social_autonomous_content_factory',
    metadata: {
      ai_caption_quality_review_required: true,
      ai_caption_quality_review: {
        approved: true,
        decision: 'approve',
        reviewed_caption: 'Agent draft visibility target',
        rationale: 'The caption is specific, factual, and appropriate for this platform.',
        factual_grounding: 'It uses only supplied listing facts.',
        platform_fit: 'The length and CTA fit the selected platform.',
      },
    },
  });

  await installScheduleApiMocks(page, [draft]);
  await page.goto('/#schedule');
  await expect(page.locator('[data-sched-post-card="agent-autonomy-draft-visibility"]')).toHaveCount(0);
  await expect(page.locator('#sched-metric-drafts')).toHaveText('1');

  await page.locator('#sched-view').selectOption('drafts');
  const card = page.locator('[data-sched-post-card="agent-autonomy-draft-visibility"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Agent draft visibility target');
  await expect(card).toContainText('Agent');
  await expect(card).toContainText('AI reviewed');
  await card.getByRole('button', { name: /View post/i }).click();
  const modal = page.locator('#sched-view-modal');
  await expect(modal).toContainText('AI caption review');
  await expect(modal).toContainText('The caption is specific, factual, and appropriate for this platform.');
  await expect(modal).toContainText('It uses only supplied listing facts.');
});

test('delete locks immediately, sends one request, removes card, and shows one success toast', async ({ page }) => {
  const post = safeSchedulePost();
  let deleteRequests = 0;
  let confirmCount = 0;
  let releaseDelete;
  const deleteCanFinish = new Promise(resolve => { releaseDelete = resolve; });

  page.on('dialog', async dialog => {
    confirmCount++;
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('Delete this post?');
    await dialog.accept();
  });

  await installScheduleApiMocks(page, [post], {
    beforeDelete: async () => {
      deleteRequests++;
      await deleteCanFinish;
    },
  });

  await page.goto('/#schedule');
  await expect(page.locator('.page-title')).toContainText('Content Schedule');

  const card = page.locator(`[data-sched-post-card="${post.id}"]`);
  const deleteButton = page.locator(`[data-post-id="${post.id}"][data-sched-action="delete"]`);
  await expect(card).toBeVisible();
  await expect(deleteButton).toBeEnabled();

  await deleteButton.click();
  await expect(deleteButton).toBeDisabled();
  await expect(deleteButton).toHaveText('Deleting…');
  await expect(card).toHaveCSS('opacity', '0.45');

  await deleteButton.dispatchEvent('click');
  await expect.poll(() => confirmCount).toBe(1);
  await expect.poll(() => deleteRequests).toBe(1);

  releaseDelete();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.toast-success')).toHaveCount(1);
  await expect(page.locator('.toast-success .toast-text')).toHaveText('Post deleted.');
  await expect.poll(() => deleteRequests).toBe(1);
});
