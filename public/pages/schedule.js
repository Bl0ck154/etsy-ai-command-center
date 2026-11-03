// public/pages/schedule.js — Content Calendar: scheduled & draft social posts

import { toastSuccess, toastError, toastInfo } from '../components/toast.js';
import {
  approveScheduledPost,
  deleteScheduledPost,
  generateId,
  getAdminCanaryReadiness,
  getScheduledPosts,
  normalizeScheduledPost,
  recoverQueuedExternalPostToDraft,
  restoreScheduledPostToDraft,
  saveScheduledPost,
  unapproveScheduledPost,
  updateScheduledPost,
} from '../utils/schedule-store.js';
import { currentOriginMediaAssetUrl as normalizeCurrentMediaAssetUrl, normalizeMediaUrl } from '../utils/media-url.js';
import {
  dualScheduleDateLabel,
  dualScheduleTimeLabel,
  formatScheduleDateInZone,
  scheduleDayKey,
  scheduleTimePanelMarkup,
} from '../utils/schedule-view-model.js';

const PLATFORM_COLORS = {
  pinterest: '#E60023',
  instagram: '#C13584',
  facebook:  '#1877F2',
  tiktok:    '#111',
  all:       '#666',
};
const PLATFORM_NAMES = {
  pinterest: 'Pinterest',
  instagram: 'Instagram',
  facebook:  'Facebook',
  tiktok:    'TikTok',
  all:       'All platforms',
};
const PLATFORM_MEDIA_HINT = {
  instagram: 'Up to 10 images or videos (carousel)',
  facebook:  'Multiple images supported',
  pinterest: 'Exactly one image is required',
  tiktok:    'Single video',
  all:       'Multiple images supported',
};

let scheduleState = {
  view: 'active',
  platform: 'all',
  status: 'all',
  query: '',
  month: new Date(),
  timeFormat: '12',
  sort: 'upcoming',
  page: 1,
  pageSize: 20,
  calendarVisible: false,
};

const pendingDeleteIds = new Set();
let deepLinkPreviewId = '';
let openedDeepLinkPreviewId = '';
let appliedDeepLinkPreviewId = '';
const DEEP_LINK_PLATFORM_SUFFIX_RE = /-(instagram|facebook|pinterest|tiktok)$/i;
const MODAL_POST_BATCH_SIZE = 10;
const MEDIA_RECOVERY_TOKEN = Date.now().toString(36);
const OWNER_DISPLAY_TIME_ZONE = 'Europe/Kyiv';

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function cleanDeepLinkId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 160);
}

function paramsFromCurrentUrl() {
  const searchParams = new URLSearchParams(window.location.search || '');
  const hashQuery = String(window.location.hash || '').split('?')[1] || '';
  const hashParams = new URLSearchParams(hashQuery);
  return { ...Object.fromEntries(searchParams), ...Object.fromEntries(hashParams) };
}

function usableUrl(url) {
  const value = String(url || '').trim();
  if (!value || /^(null|undefined|about:blank)$/i.test(value)) return '';
  return normalizeMediaUrl(value) || (value.startsWith('/') ? value : '');
}

function imageFallbackHtml(size = '64px', label = 'No usable media') {
  return `<div style="width:${size};height:${size};border-radius:8px;background:repeating-linear-gradient(45deg,var(--bg-secondary),var(--bg-secondary) 8px,var(--bg-card) 8px,var(--bg-card) 16px);display:flex;flex-direction:column;gap:2px;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;color:var(--text-3);border:1px dashed var(--orange-border,var(--border));text-align:center;line-height:1.1" title="${esc(label)}"><span>🖼</span><span style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.02em">Missing</span></div>`;
}

function missingMediaBadgeHtml(text = 'Missing media') {
  return `<span style="font-size:10px;font-weight:800;color:var(--orange);background:var(--orange-light,#fff7ed);border:1px solid var(--orange-border,#fed7aa);border-radius:999px;padding:2px 7px;text-transform:uppercase;letter-spacing:.03em">⚠ ${esc(text)}</span>`;
}

function mediaRetryUrl(url) {
  const value = usableUrl(url);
  if (!value || !/\/api\/social\?[^#]*action=mediaAsset/i.test(value)) return '';
  try {
    const parsed = new URL(value, window.location.origin);
    if (!parsed.searchParams.has('retry')) parsed.searchParams.set('retry', '1');
    return parsed.toString();
  } catch { return ''; }
}

function mediaRecoveryUrl(url) {
  const value = usableUrl(url);
  if (!value || !/\/api\/social\?[^#]*action=mediaAsset/i.test(value)) return '';
  try {
    const parsed = new URL(value, window.location.origin);
    parsed.searchParams.set('_ui_media_retry', MEDIA_RECOVERY_TOKEN);
    return parsed.toString();
  } catch { return ''; }
}

function currentOriginMediaAssetUrl(url) {
  const value = usableUrl(url);
  if (!value) return '';
  const normalized = normalizeCurrentMediaAssetUrl(value);
  if (normalized === value && !/\/api\/social\?/i.test(value)) return '';
  try {
    const parsed = new URL(normalized, window.location.origin);
    if (!parsed.searchParams.has('retry')) parsed.searchParams.set('retry', '1');
    return parsed.toString();
  } catch { return ''; }
}

function mediaCandidateUrls(item) {
  const candidates = [];
  const add = (candidate) => {
    const url = usableUrl(candidate?.url || candidate);
    if (url && !candidates.includes(url)) candidates.push(url);
  };
  const primary = usableUrl(item?.url || item);
  // Old scheduled records can contain absolute /api/social mediaAsset links for
  // a previous staging hostname. Prefer the same media asset ID on the current
  // origin so the thumbnail does not look broken because DNS/proxy changed.
  // Only retry equivalent URLs for this asset. A later carousel item must not
  // hide a genuinely dead first URL.
  const currentOrigin = currentOriginMediaAssetUrl(primary);
  add(currentOrigin || primary);
  if (!currentOrigin) return candidates;
  add(mediaRetryUrl(currentOrigin));
  add(mediaRecoveryUrl(currentOrigin));
  return candidates;
}

function mediaTileHtml(item, size = '64px', countHtml = '') {
  const candidates = mediaCandidateUrls(item);
  const url = candidates[0] || '';
  if (!url) return imageFallbackHtml(size);
  const isVideo = item?.type === 'video';
  const common = `position:relative;z-index:1;width:${size};height:${size};object-fit:cover;border-radius:8px`;
  const encodedCandidates = esc(JSON.stringify(candidates));
  const loadScript = `const p=this.parentElement;if(p){p.dataset.mediaLoaded='1';delete p.dataset.mediaBroken;p.title=this.currentSrc||this.src;const b=p.querySelector('[data-broken-badge]');if(b)b.style.display='none';}`;
  const fallbackScript = `const p=this.parentElement;if(!p)return;const urls=JSON.parse(p.dataset.mediaCandidates||'[]');let i=parseInt(p.dataset.mediaIndex||'0',10)+1;p.dataset.mediaAttempts=String(Math.min(i,urls.length));if(i<urls.length){p.dataset.mediaIndex=String(i);this.src=urls[i];p.title='Retrying media '+(i+1)+'/'+urls.length;return;}p.dataset.mediaBroken='1';p.dataset.mediaFailedUrl=urls[0]||'';p.title='Media failed after '+urls.length+' bounded attempts';this.remove();const b=p.querySelector('[data-broken-badge]');if(b)b.style.display='block';`;
  return `<div data-media-candidates="${encodedCandidates}" data-media-index="0" style="position:relative;width:${size};height:${size};flex-shrink:0;border-radius:8px;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:22px;overflow:hidden;border:1px solid var(--border)" title="${esc(url)}">
    <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${isVideo ? '🎬' : '🖼'}</span>
    ${isVideo
      ? `<video src="${esc(url)}" muted playsinline preload="metadata" style="${common}" onloadeddata="${esc(loadScript)}" onerror="${esc(fallbackScript)}"></video>`
      : `<img src="${esc(url)}" alt="" style="${common}" loading="lazy" onload="${esc(loadScript)}" onerror="${esc(fallbackScript)}">`}
    <span data-broken-badge style="display:none;position:absolute;z-index:3;left:3px;right:3px;bottom:3px;background:rgba(180,83,9,.92);color:#fff;font-size:8px;font-weight:800;text-align:center;padding:2px 3px;border-radius:4px;text-transform:uppercase">Broken</span>
    ${countHtml}
  </div>`;
}

const CONTROL_STYLE = 'width:100%;font-size:12px;padding:8px 32px 8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);outline:none;appearance:none;-webkit-appearance:none;box-sizing:border-box;cursor:pointer';
const INPUT_STYLE = 'width:100%;font-size:12px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);outline:none;box-sizing:border-box';

function controlLabel(label, innerHtml, style = '') {
  return `<label style="display:flex;flex-direction:column;gap:4px;font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;${style}"><span>${esc(label)}</span>${innerHtml}</label>`;
}

function selectWrap(id, html, width = '150px') {
  return `<div style="position:relative;width:${width}"><select id="${id}" style="${CONTROL_STYLE}">${html}</select><span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-3);font-size:11px">▾</span></div>`;
}

function platformBadge(platform) {
  const color = PLATFORM_COLORS[platform] || '#666';
  const name  = PLATFORM_NAMES[platform]  || platform;
  return `<span style="background:${color};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap">${name}</span>`;
}

function localDateTimeValue(val) {
  if (!val) return '';
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Resize image file to max 1200px and encode as base64 JPEG
function resizeImageForUpload(file, maxPx = 1200) {
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxPx || h > maxPx) {
        const scale = maxPx / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error(`Cannot load ${file.name}`)); };
    img.src = blobUrl;
  });
}

// ── Public page entry ─────────────────────────────────────

export async function renderSchedule(container, params = {}) {
  const urlParams = paramsFromCurrentUrl();
  deepLinkPreviewId = cleanDeepLinkId(params.preview_id || params.post_id || urlParams.preview_id || urlParams.post_id || '');
  openedDeepLinkPreviewId = '';
  appliedDeepLinkPreviewId = '';
  container.innerHTML = `
    <div class="sched-shell">
      <div class="page-header sched-page-header">
        <div class="sched-page-title-wrap">
          <div class="page-title">Content Schedule</div>
          <div class="page-subtitle">Drafts, scheduled posts, and archive</div>
        </div>
        <div class="sched-header-actions" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-sm" id="sched-calendar-toggle" title="Show the month calendar overview">Calendar</button>
          <button class="btn btn-sm" id="sched-clean-test-btn" style="display:none;color:var(--red-text)">Clean test drafts</button>
          <button class="btn btn-sm" id="sched-publish-due-btn">Check due</button>
          <button class="btn btn-primary btn-sm" id="sched-new-btn">+ New post</button>
        </div>
      </div>
      <div class="sched-dashboard-metrics">
        <div class="sched-metric-card"><div class="sched-metric-label">Queue</div><div id="sched-metric-total" class="sched-metric-value">0</div></div>
        <div class="sched-metric-card"><div class="sched-metric-label">Due</div><div id="sched-metric-due" class="sched-metric-value">0</div></div>
        <div class="sched-metric-card"><div class="sched-metric-label">Drafts</div><div id="sched-metric-drafts" class="sched-metric-value">0</div></div>
        <div class="sched-metric-card"><div class="sched-metric-label">Published</div><div id="sched-metric-published" class="sched-metric-value">0</div></div>
      </div>
      <div class="page-body">
        <div id="sched-status" style="display:none;margin-bottom:12px"></div>
        <div id="sched-stats" class="sched-stats-wrap" style="display:none"></div>
        <div class="sched-toolbar-shell">
          <div class="sched-toolbar-head">
            <div>
              <div class="sched-toolbar-title">Queue controls</div>
              <div class="sched-toolbar-subtitle">Search and filter the publishing queue.</div>
            </div>
          </div>
          <div class="sched-controls-grid">
            ${controlLabel('Search', `<input id="sched-search" type="search" placeholder="Caption or listing..." style="${INPUT_STYLE}">`, 'min-width:220px')}
            ${controlLabel('View', selectWrap('sched-view', `
              <option value="active">Active queue</option>
              <option value="drafts">Drafts</option>
              <option value="paused">Paused</option>
              <option value="stale">Stale overdue</option>
              <option value="published">Published archive</option>
              <option value="all">Everything</option>`, '100%'))}
            ${controlLabel('Platform', selectWrap('sched-platform', `
              <option value="all">All platforms</option>
              <option value="pinterest">Pinterest</option>
              <option value="instagram">Instagram</option>
              <option value="facebook">Facebook</option>
              <option value="tiktok">TikTok</option>`, '100%'))}
            ${controlLabel('Status', selectWrap('sched-status-filter', `
              <option value="all">All statuses</option>
              <option value="due">Due now</option>
              <option value="scheduled">Scheduled</option>
              <option value="approved_scheduled">Approved auto</option>
              <option value="queued_external">Queued externally</option>
              <option value="missing_media">Missing media</option>
              <option value="stale">Stale overdue</option>
              <option value="paused">Paused</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="failed">Failed</option>`, '100%'))}
            ${controlLabel('Sort', selectWrap('sched-sort', `
              <option value="upcoming">Upcoming first</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="status">Status</option>
              <option value="platform">Platform</option>`, '100%'))}
            ${controlLabel('Per page', selectWrap('sched-page-size', `
              <option value="10">10 posts</option>
              <option value="20">20 posts</option>
              <option value="30">30 posts</option>
              <option value="50">50 posts</option>`, '100%'))}
          </div>
        </div>
        <div id="sched-list"><div class="sched-state" role="status" aria-live="polite">Loading schedule...</div></div>
      </div>
    </div>`;

  container.querySelector('#sched-new-btn').onclick = () => openEditor(container, null);
  container.querySelector('#sched-clean-test-btn').onclick = () => cleanupTestDrafts(container);
  container.querySelector('#sched-publish-due-btn').onclick = () => publishDuePosts(container);
  container.querySelector('#sched-calendar-toggle').onclick = () => { scheduleState.calendarVisible = !scheduleState.calendarVisible; loadAndRender(container); };
  container.querySelector('#sched-time-toggle')?.addEventListener('click', () => { scheduleState.timeFormat = scheduleState.timeFormat === '12' ? '24' : '12'; loadAndRender(container); });
  container.querySelector('#sched-prev-month')?.addEventListener('click', () => { scheduleState.month = new Date(scheduleState.month.getFullYear(), scheduleState.month.getMonth() - 1, 1); loadAndRender(container); });
  container.querySelector('#sched-next-month')?.addEventListener('click', () => { scheduleState.month = new Date(scheduleState.month.getFullYear(), scheduleState.month.getMonth() + 1, 1); loadAndRender(container); });
  container.querySelector('#sched-search').oninput = (e) => { scheduleState.query = e.target.value; scheduleState.page = 1; loadAndRender(container); };
  container.querySelector('#sched-view').onchange = (e) => { scheduleState.view = e.target.value; scheduleState.page = 1; loadAndRender(container); };
  container.querySelector('#sched-platform').onchange = (e) => { scheduleState.platform = e.target.value; scheduleState.page = 1; loadAndRender(container); };
  container.querySelector('#sched-status-filter').onchange = (e) => { scheduleState.status = e.target.value; scheduleState.page = 1; loadAndRender(container); };
  container.querySelector('#sched-sort').onchange = (e) => { scheduleState.sort = e.target.value; scheduleState.page = 1; loadAndRender(container); };
  container.querySelector('#sched-page-size').onchange = (e) => { scheduleState.pageSize = parseInt(e.target.value, 10) || 8; scheduleState.page = 1; loadAndRender(container); };
  await loadAndRender(container);
}

async function publishDuePosts(container) {
  const btn = container.querySelector('#sched-publish-due-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
  try {
    const res = await fetch('/api/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Schedule UI checks must never trigger real publishing. Cron/owner
      // governance remains the only place that can change dry-run behavior.
      body: JSON.stringify({ action: 'publishDueScheduled', dryRun: true, limit: 10 }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Scheduler failed');
    const ok = (data.results || []).filter(r => r.success).length;
    const failed = (data.results || []).filter(r => r.success === false).length;
    if (!data.due_count) toastSuccess('No due posts right now.');
    else toastSuccess(`Scheduler dry-run checked ${data.due_count} approved due posts: ${ok} publishable, ${failed} failed checks.`);
    await loadAndRender(container);
  } catch (e) {
    toastError('Scheduler failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check due'; }
  }
}

async function loadAndRender(container) {
  const listEl = container.querySelector('#sched-list');
  try {
    const posts = await getScheduledPosts();
    const statusEl = container.querySelector('#sched-status');
    if (statusEl) {
      statusEl.innerHTML = '';
      statusEl.style.display = 'none';
    }
    const deepLink = prepareDeepLink(posts);
    await renderSchedulerStatus(container, posts);
    renderDeepLinkStatus(container, deepLink);
    renderScheduleToolbar(container, posts);
    const filtered = filterPosts(posts);
    renderDashboard(container, listEl, filtered, posts);
    openDeepLinkPreview(container, deepLink);
  } catch (e) {
    listEl.innerHTML = `<div class="sched-state sched-state-error" role="alert">
      <strong>Could not load the schedule</strong>
      <span>${esc(e.message || 'Unknown error')}</span>
      <button class="btn btn-sm" id="sched-load-retry">Retry</button>
    </div>`;
    listEl.querySelector('#sched-load-retry')?.addEventListener('click', () => loadAndRender(container));
  }
}

function deepLinkCandidateIds(post = {}) {
  const values = [
    post.id,
    post.post_id,
    post.scheduled_post_id,
    post.record_id,
    post.preview_id,
    post.metadata?.campaign_id,
    post.metadata?.base_id,
    post.metadata?.package_id,
    post.metadata?.variant_of,
  ];
  const id = String(post.id || '');
  if (id) values.push(id.replace(DEEP_LINK_PLATFORM_SUFFIX_RE, ''));
  return values.map(cleanDeepLinkId).filter(Boolean);
}

function deepLinkMatchesPost(post = {}, id = '') {
  const target = cleanDeepLinkId(id);
  if (!target) return false;
  const postId = String(post.id || '');
  if (deepLinkCandidateIds(post).includes(target)) return true;
  if (postId.startsWith(`${target}-`)) return true;
  return postId.replace(DEEP_LINK_PLATFORM_SUFFIX_RE, '') === target;
}

function relatedDeepLinkPosts(posts = [], target = null, previewId = deepLinkPreviewId) {
  const ids = new Set([cleanDeepLinkId(previewId), ...deepLinkCandidateIds(target || {})].filter(Boolean));
  if (!ids.size) return [];
  return posts.filter(post => [...ids].some(id => deepLinkMatchesPost(post, id)));
}

function findDeepLinkPost(posts = [], previewId = deepLinkPreviewId) {
  const id = cleanDeepLinkId(previewId);
  if (!id) return null;
  return posts.find(post => deepLinkCandidateIds(post).includes(id))
    || posts.find(post => deepLinkMatchesPost(post, id))
    || null;
}

function prepareDeepLink(posts = []) {
  if (!deepLinkPreviewId) return null;
  const target = findDeepLinkPost(posts);
  const shouldApplyTarget = appliedDeepLinkPreviewId !== deepLinkPreviewId;
  if (shouldApplyTarget) {
    scheduleState.view = 'all';
    scheduleState.status = 'all';
    scheduleState.platform = 'all';
    scheduleState.query = '';
    appliedDeepLinkPreviewId = deepLinkPreviewId;
  }
  if (!target) return { id: deepLinkPreviewId, found: false };
  const related = relatedDeepLinkPosts(posts, target).sort(sortPosts);
  if (shouldApplyTarget) {
    const sorted = [...posts].sort(sortPosts);
    const index = Math.max(0, sorted.findIndex(post => String(post.id || '') === String(target.id || '')));
    scheduleState.page = Math.floor(index / Math.max(1, scheduleState.pageSize)) + 1;
  }
  return { id: deepLinkPreviewId, found: true, post: target, posts: related.length ? related : [target] };
}

function renderDeepLinkStatus(container, deepLink) {
  if (!deepLink) return;
  const status = container.querySelector('#sched-status');
  if (!status) return;
  status.style.display = 'block';
  const foundHtml = deepLink.found
    ? `<strong>Opened linked review:</strong> ${esc(deepLink.id)}${deepLink.posts?.length > 1 ? ` (${deepLink.posts.length} platform records)` : ` - ${esc(deepLink.post?.id || '')}`}`
    : `<strong>Preview is not saved in the schedule yet:</strong> ${esc(deepLink.id)}. Approve/save it from Telegram first, then this link can open the saved record.`;
  status.insertAdjacentHTML('beforeend', `<div style="margin-bottom:8px;padding:9px 12px;border:1px solid ${deepLink.found ? 'var(--green-border,#bbf7d0)' : 'var(--orange-border,#fed7aa)'};border-radius:var(--radius);background:${deepLink.found ? 'var(--green-light,#ecfdf5)' : 'var(--orange-light,#fff7ed)'};font-size:12px;color:${deepLink.found ? 'var(--green-text,#166534)' : 'var(--orange)'}">${foundHtml}</div>`);
}

function openDeepLinkPreview(container, deepLink) {
  if (!deepLink?.found || openedDeepLinkPreviewId === deepLink.id) return;
  openedDeepLinkPreviewId = deepLink.id;
  setTimeout(() => {
    const focusPost = deepLink.post || deepLink.posts?.[0];
    const card = container.querySelector(`[data-sched-post-card="${safeCssEscape(String(focusPost.id))}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.outline = '2px solid var(--orange)';
      card.style.boxShadow = '0 0 0 4px rgba(249,115,22,.14)';
      setTimeout(() => { card.style.outline = ''; card.style.boxShadow = ''; }, 2400);
    }
    if (deepLink.posts?.length > 1) openReviewPackage(container, deepLink);
    else openViewer(focusPost);
  }, 120);
}

function renderScheduleToolbar(container, posts) {
  const stats = schedulerCounts(posts);
  const missing = missingMediaCount(posts);
  const setMetric = (id, value) => { const el = container.querySelector(id); if (el) el.textContent = String(value); };
  setMetric('#sched-metric-total', posts.length);
  setMetric('#sched-metric-due', stats.due + stats.stale);
  setMetric('#sched-metric-drafts', stats.drafts);
  setMetric('#sched-metric-published', stats.published);
  const statsEl = container.querySelector('#sched-stats');
  if (statsEl) statsEl.innerHTML = '';
  const statsWrap = container.querySelector('.sched-stats-wrap');
  if (statsWrap) statsWrap.innerHTML = '';
  const monthLabel = container.querySelector('#sched-month-label');
  if (monthLabel) monthLabel.textContent = scheduleState.month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const timeBtn = container.querySelector('#sched-time-toggle');
  if (timeBtn) timeBtn.textContent = scheduleState.timeFormat === '24' ? '24h time' : '12h time';
  const search = container.querySelector('#sched-search');
  if (search && search.value !== scheduleState.query) search.value = scheduleState.query;
  const view = container.querySelector('#sched-view');
  if (view) view.value = scheduleState.view;
  const platform = container.querySelector('#sched-platform');
  if (platform) platform.value = scheduleState.platform;
  const status = container.querySelector('#sched-status-filter');
  if (status) status.value = scheduleState.status;
  const sort = container.querySelector('#sched-sort');
  if (sort) sort.value = scheduleState.sort;
  const pageSize = container.querySelector('#sched-page-size');
  if (pageSize) pageSize.value = String(scheduleState.pageSize);
  const cleanupBtn = container.querySelector('#sched-clean-test-btn');
  if (cleanupBtn) {
    const testDraftCount = posts.filter(isSafeTestDraft).length;
    cleanupBtn.style.display = testDraftCount ? '' : 'none';
    cleanupBtn.textContent = `Clean ${testDraftCount} test draft${testDraftCount === 1 ? '' : 's'}`;
  }
}

function isSafeTestDraft(post) {
  const text = `${post.caption || ''} ${post.listing_title || ''} ${post.id || ''}`.toLowerCase();
  const hasTestMarker = /(^|\b)(test draft|test post|ui test|schedule test|dummy draft|lorem ipsum|delete me)(\b|$)/i.test(text) || /^test[-_\s]/i.test(String(post.id || ''));
  return hasTestMarker && !post.scheduled_at && post.status !== 'published' && post.status !== 'publishing' && !post.listing_id;
}

async function cleanupTestDrafts(container) {
  const posts = await getScheduledPosts();
  const targets = posts.filter(isSafeTestDraft);
  if (!targets.length) { toastSuccess('No safe test drafts found.'); return; }
  const sample = targets.slice(0, 5).map(p => `• ${(p.caption || p.id || '').slice(0, 60)}`).join('\n');
  const answer = prompt(`Delete ${targets.length} unscheduled test draft${targets.length === 1 ? '' : 's'}?\n\nOnly drafts with explicit test markers, no listing, and no schedule are included.\n\n${sample}\n\nType DELETE TEST DRAFTS to continue.`);
  if (answer !== 'DELETE TEST DRAFTS') return;
  let deleted = 0;
  for (const post of targets) {
    try { await deleteScheduledPost(post.id); deleted++; } catch (e) { console.warn('Test draft cleanup failed for', post.id, e); }
  }
  toastSuccess(`Deleted ${deleted} test draft${deleted === 1 ? '' : 's'}.`);
  await loadAndRender(container);
}

function filterPosts(posts) {
  const q = scheduleState.query.trim().toLowerCase();
  const now = Date.now();
  return posts.filter(p => {
    const scheduledTime = scheduledTimestamp(p);
    const hasFutureSchedule = Number.isFinite(scheduledTime) && scheduledTime > now;
    const stale = isStaleOverdue(p, now);
    const effectiveStatus = scheduleStatusKey(p, now);
    if (scheduleState.view === 'active') {
      // Stale records are historical audit items, not active work. Keep them
      // available through the explicit Stale overdue view.
      if (effectiveStatus === 'published' || effectiveStatus === 'failed' || effectiveStatus === 'queued_external') return false;
      if (effectiveStatus === 'paused') return false;
      if (stale) return false;
      if (!hasFutureSchedule && effectiveStatus !== 'due' && effectiveStatus !== 'approved_scheduled') return false;
    }
    if (scheduleState.view === 'drafts' && effectiveStatus !== 'draft') return false;
    if (scheduleState.view === 'paused' && effectiveStatus !== 'paused') return false;
    if (scheduleState.view === 'stale' && !stale) return false;
    if (scheduleState.view === 'published' && effectiveStatus !== 'published') return false;
    if (scheduleState.platform !== 'all' && p.platform !== scheduleState.platform) return false;
    if (scheduleState.status !== 'all') {
      if (!matchesStatusFilter(p, scheduleState.status, now)) return false;
    }
    if (q && !`${p.caption || ''} ${p.listing_title || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function scheduledTimestamp(post = {}) {
  if (!post.scheduled_at) return null;
  const time = new Date(post.scheduled_at).getTime();
  return Number.isFinite(time) ? time : null;
}

function isExternallyQueued(post = {}) {
  return post.status === 'queued_external' || post.status === 'queued';
}

function isApprovedScheduled(post = {}) {
  return post.status === 'approved_scheduled' && post.approved_for_publish === true;
}

function isDuePost(post = {}, now = Date.now()) {
  const scheduledTime = scheduledTimestamp(post);
  return Number.isFinite(scheduledTime)
    && scheduledTime <= now
    && post.status !== 'published'
    && post.status !== 'publishing'
    && post.status !== 'failed'
    && post.status !== 'paused'
    && !isExternallyQueued(post);
}

function isStaleOverdue(post = {}, now = Date.now()) {
  return isDuePost(post, now) && (post.status === 'scheduled' || post.status === 'draft' || !post.status);
}

function scheduleStatusKey(post = {}, now = Date.now()) {
  if (post.status === 'published') return 'published';
  if (post.status === 'failed') return 'failed';
  if (post.status === 'paused') return 'paused';
  if (isExternallyQueued(post)) return 'queued_external';
  if (isApprovedScheduled(post)) return 'approved_scheduled';
  if (isStaleOverdue(post, now)) return 'stale';
  if (isDuePost(post, now)) return 'due';
  return post.scheduled_at ? 'scheduled' : 'draft';
}

function matchesStatusFilter(post = {}, filter, now = Date.now()) {
  if (filter === 'missing_media') return normalizeMediaItems(post).length === 0;
  if (filter === 'due') return isDuePost(post, now);
  return scheduleStatusKey(post, now) === filter;
}

async function renderSchedulerStatus(container, posts) {
  const el = container.querySelector('#sched-status');
  if (!el) return;
  const local = schedulerCounts(posts);
  let status = local;
  try {
    const res = await fetch('/api/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'schedulerStatus' }),
    });
    const data = await res.json();
    if (res.ok && data.success) status = data;
  } catch {}
  const autopublishEnabled = status.autopublish_enabled === true;
  const modeLabel = autopublishEnabled ? 'live' : 'dry-run';
  const safetyNote = autopublishEnabled
    ? 'Approved scheduled posts publish automatically when due. Unapproved drafts and stale records remain inert.'
    : 'Publishing is disabled; due checks remain dry-run only.';
  el.style.display = 'block';
  el.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-card);font-size:12px;color:var(--text-2)">
      <strong style="color:var(--text)">Autopilot safety</strong>
      <span class="badge${autopublishEnabled ? ' badge-green' : ''}" style="font-size:10px;${autopublishEnabled ? '' : 'color:var(--orange);border-color:var(--orange)'}">${modeLabel}</span>
      ${status.publishable_due ? `<span class="badge badge-green" style="font-size:10px">${status.publishable_due} approved due check</span>` : ''}
      ${status.failed ? `<span class="badge" style="font-size:10px;color:var(--red-text);border-color:var(--red-text)">${status.failed} failed checks</span>` : ''}
      <span style="margin-left:auto;color:var(--text-3);font-size:11px">${safetyNote}</span>
    </div>`;
}

function schedulerCounts(posts) {
  const now = Date.now();
  return {
    success: true,
    due: posts.filter(p => isDuePost(p, now)).length,
    scheduled: posts.filter(p => {
      const time = scheduledTimestamp(p);
      const status = scheduleStatusKey(p, now);
      return Number.isFinite(time)
        && time > now
        && (status === 'scheduled' || status === 'approved_scheduled');
    }).length,
    stale: posts.filter(p => isStaleOverdue(p, now)).length,
    drafts: posts.filter(p => scheduleStatusKey(p, now) === 'draft').length,
    paused: posts.filter(p => scheduleStatusKey(p, now) === 'paused').length,
    agent: posts.filter(isAgentScheduledPost).length,
    queued_external: posts.filter(isExternallyQueued).length,
    approved: posts.filter(isApprovedScheduled).length,
    failed: posts.filter(p => p.status === 'failed').length,
    published: posts.filter(p => p.status === 'published').length,
  };
}

function missingMediaCount(posts) {
  return posts.filter(p => normalizeMediaItems(p).length === 0).length;
}

function activeFilterSummary() {
  const parts = [];
  if (scheduleState.view !== 'active') parts.push(`View: ${scheduleState.view}`);
  if (scheduleState.platform !== 'all') parts.push(`Platform: ${PLATFORM_NAMES[scheduleState.platform] || scheduleState.platform}`);
  if (scheduleState.status !== 'all') parts.push(`Status: ${scheduleState.status.replace(/_/g, ' ')}`);
  if (scheduleState.query.trim()) parts.push(`Search: “${scheduleState.query.trim()}”`);
  return parts.join(' · ');
}

function clearScheduleFilters(container) {
  scheduleState.view = 'active';
  scheduleState.platform = 'all';
  scheduleState.status = 'all';
  scheduleState.query = '';
  scheduleState.sort = 'upcoming';
  scheduleState.page = 1;
  loadAndRender(container);
}

function renderList(container, el, posts, allPosts = posts) {
  if (!posts.length) {
    if (allPosts.length) {
      const counts = schedulerCounts(allPosts);
      const activeQueueIsEmpty = scheduleState.view === 'active'
        && scheduleState.platform === 'all'
        && scheduleState.status === 'all'
        && !scheduleState.query.trim();
      if (activeQueueIsEmpty) {
        el.innerHTML = `
          <div class="card" role="status" style="padding:18px;border:1px solid var(--border);background:var(--bg-card)">
            <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap">
              <div style="min-width:0">
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:7px">
                  <span class="badge badge-green" style="font-size:10px">Queue clear</span>
                  <span class="badge" style="font-size:10px">Autopublish has nothing due</span>
                </div>
                <div style="font-size:16px;font-weight:800;color:var(--text);margin-bottom:5px">No active posts are waiting to publish</div>
                <div style="font-size:12px;line-height:1.55;color:var(--text-2);max-width:720px">Paused legacy posts, drafts, and published history stay available in their own views. They are not part of the live publishing queue.</div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                ${counts.drafts ? `<button class="btn btn-sm" id="sched-empty-drafts">View ${counts.drafts} draft${counts.drafts === 1 ? '' : 's'}</button>` : ''}
                ${counts.paused ? `<button class="btn btn-sm" id="sched-empty-paused">View ${counts.paused} paused</button>` : ''}
                <button class="btn btn-primary btn-sm" id="sched-empty-new">+ Create post</button>
              </div>
            </div>
            <div class="sched-empty-metrics sched-empty-metrics-four" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px">
              <div style="padding:10px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)"><div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;margin-bottom:4px">Upcoming</div><div data-sched-empty-metric="scheduled" style="font-size:18px;font-weight:800;color:var(--text)">${counts.scheduled}</div></div>
              <div style="padding:10px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)"><div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;margin-bottom:4px">Drafts</div><div data-sched-empty-metric="drafts" style="font-size:18px;font-weight:800;color:var(--text)">${counts.drafts}</div></div>
              <div style="padding:10px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)"><div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;margin-bottom:4px">Paused</div><div data-sched-empty-metric="paused" style="font-size:18px;font-weight:800;color:var(--text)">${counts.paused}</div></div>
              <div style="padding:10px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)"><div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;margin-bottom:4px">Published</div><div data-sched-empty-metric="published" style="font-size:18px;font-weight:800;color:var(--text)">${counts.published}</div></div>
            </div>
          </div>`;
        el.querySelector('#sched-empty-new').onclick = () => openEditor(container, null);
        const draftsBtn = el.querySelector('#sched-empty-drafts');
        if (draftsBtn) draftsBtn.onclick = () => { scheduleState.view = 'drafts'; scheduleState.page = 1; loadAndRender(container); };
        const pausedBtn = el.querySelector('#sched-empty-paused');
        if (pausedBtn) pausedBtn.onclick = () => { scheduleState.view = 'paused'; scheduleState.page = 1; loadAndRender(container); };
        return;
      }
      const filterText = activeFilterSummary() || 'Current filters';
      el.innerHTML = `
      <div class="card" role="status" style="padding:18px 18px 16px;border:1px solid var(--border);background:linear-gradient(180deg,var(--bg-card),var(--bg));box-shadow:0 12px 32px rgba(15,23,42,.05)">
        <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
          <div style="font-size:30px;line-height:1">🔎</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
              <span class="badge" style="font-size:10px">No matches</span>
              <span class="badge badge-green" style="font-size:10px">${allPosts.length} saved record${allPosts.length === 1 ? '' : 's'}</span>
            </div>
            <div style="font-size:15px;font-weight:800;color:var(--text);margin-bottom:6px">Nothing matches this filtered view</div>
            <div style="font-size:12px;line-height:1.55;color:var(--text-2);max-width:720px">${esc(filterText)} hides the existing queue. The calendar is working — broaden filters or switch to Everything to audit all saved records.</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
              <button class="btn btn-primary btn-sm" id="sched-empty-reset">Reset to active queue</button>
              <button class="btn btn-sm" id="sched-empty-everything">Show everything</button>
            </div>
          </div>
        </div>
        <div class="sched-empty-metrics sched-empty-metrics-four" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px">
          <div style="padding:10px 11px;border:1px solid var(--border);border-radius:10px;background:var(--bg-secondary)"><div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Upcoming</div><div style="font-size:18px;font-weight:800;color:var(--text)">${counts.scheduled}</div></div>
          <div style="padding:10px 11px;border:1px solid var(--border);border-radius:10px;background:var(--bg-secondary)"><div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Drafts</div><div style="font-size:18px;font-weight:800;color:var(--text)">${counts.drafts}</div></div>
          <div style="padding:10px 11px;border:1px solid var(--border);border-radius:10px;background:var(--bg-secondary)"><div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Overdue</div><div style="font-size:18px;font-weight:800;color:${counts.stale ? 'var(--orange)' : 'var(--text)'}">${counts.stale}</div></div>
          <div style="padding:10px 11px;border:1px solid var(--border);border-radius:10px;background:var(--bg-secondary)"><div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Published</div><div style="font-size:18px;font-weight:800;color:var(--text)">${counts.published}</div></div>
        </div>
      </div>`;
      el.querySelector('#sched-empty-reset').onclick = () => clearScheduleFilters(container);
      el.querySelector('#sched-empty-everything').onclick = () => { scheduleState.view = 'all'; scheduleState.status = 'all'; scheduleState.platform = 'all'; scheduleState.query = ''; scheduleState.page = 1; loadAndRender(container); };
      return;
    }
    el.innerHTML = `
      <div class="card" role="status" style="padding:18px 18px 16px;border:1px solid var(--border);background:linear-gradient(180deg,var(--bg-card),var(--bg));box-shadow:0 12px 32px rgba(15,23,42,.05)">
        <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
          <div style="font-size:30px;line-height:1">📅</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
              <span class="badge badge-green" style="font-size:10px">Calendar ready</span>
              <span class="badge" style="font-size:10px">No posts yet</span>
            </div>
            <div style="font-size:15px;font-weight:800;color:var(--text);margin-bottom:6px">Your content calendar is empty right now</div>
            <div style="font-size:12px;line-height:1.55;color:var(--text-2);max-width:680px">Saved drafts and scheduled owner-review posts will appear here. The month grid below is waiting for the first post — it is not broken.</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
              <button class="btn btn-primary btn-sm" id="sched-empty-new">+ Create post</button>
            </div>
          </div>
        </div>
        <div style="margin-top:14px;padding:10px 12px;border:1px dashed var(--border-2,var(--border));border-radius:10px;background:var(--bg-secondary);font-size:12px;color:var(--text-2);line-height:1.45">
          Empty calendar days are intentionally quiet until a draft or an AI owner-review post is saved.
        </div>
        <div class="sched-empty-metrics" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px">
          <div style="padding:10px 11px;border:1px solid var(--border);border-radius:10px;background:var(--bg-secondary)">
            <div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Drafts</div>
            <div style="font-size:12px;color:var(--text-2)">Save a caption now and schedule it later from the preview modal.</div>
          </div>
          <div style="padding:10px 11px;border:1px solid var(--border);border-radius:10px;background:var(--bg-secondary)">
            <div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Scheduled</div>
            <div style="font-size:12px;color:var(--text-2)">Pick a future time to make the queue feel alive and actionable.</div>
          </div>
          <div style="padding:10px 11px;border:1px solid var(--border);border-radius:10px;background:var(--bg-secondary)">
            <div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Published</div>
            <div style="font-size:12px;color:var(--text-2)">Finished posts move here after they are published or queued externally.</div>
          </div>
        </div>
      </div>`;
    el.querySelector('#sched-empty-new').onclick = () => openEditor(container, null);
    return;
  }

  const sorted = [...posts].sort(sortPosts);
  const totalPages = Math.max(1, Math.ceil(sorted.length / scheduleState.pageSize));
  if (scheduleState.page > totalPages) scheduleState.page = totalPages;
  const start = (scheduleState.page - 1) * scheduleState.pageSize;
  const pagePosts = sorted.slice(start, start + scheduleState.pageSize);
  const viewTitle = scheduleState.view === 'published' ? 'Published archive' : scheduleState.view === 'all' ? 'All posts' : scheduleState.view === 'drafts' ? 'Drafts' : scheduleState.view === 'paused' ? 'Paused' : scheduleState.view === 'stale' ? 'Stale overdue' : 'Active queue';
  const viewHint = scheduleState.view === 'published'
    ? 'Published posts are separated from the working queue.'
    : scheduleState.view === 'all'
      ? 'Everything is visible; use this only for audits.'
      : scheduleState.view === 'drafts'
        ? 'Unscheduled drafts are visible here; schedule or delete them after review.'
        : scheduleState.view === 'paused'
          ? 'Paused records are preserved for audit and ignored by autopublish until explicitly rescheduled.'
        : scheduleState.view === 'stale'
          ? 'Historical unapproved posts are retained for audit and ignored by autopublish. No manual action is required.'
          : 'Future scheduled and due posts are visible here. Drafts, stale records, and the published archive stay in their own views.';
  el.innerHTML = `
    <div class="card" style="padding:12px 14px;margin-bottom:10px;border:1px solid var(--border);background:var(--bg-card)">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <div>
          <div style="font-size:13px;font-weight:800;color:var(--text)">${esc(viewTitle)}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px">Showing ${start + 1}-${Math.min(start + pagePosts.length, sorted.length)} of ${sorted.length}, sorted by ${esc(sortLabel(scheduleState.sort))}. ${esc(viewHint)}</div>
        </div>
        ${paginationHtml(totalPages)}
      </div>
    </div>
    <div class="sched-post-list" style="display:flex;flex-direction:column;gap:10px;max-width:900px">${pagePosts.map(p => postCardHtml(p)).join('')}</div>
    ${totalPages > 1 ? `<div class="card sched-pagination-card" style="padding:10px 14px;margin-top:10px;max-width:900px">${paginationHtml(totalPages)}</div>` : ''}`;
  wirePagination(container, el, totalPages);
  for (const p of pagePosts) wirePostActions(container, el, p);
}

function safeCssEscape(value) {
  const raw = String(value ?? '');
  if (window.CSS?.escape) return CSS.escape(raw);
  return raw.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

function wirePostActions(container, root, post) {
  const card = root.querySelector(`[data-sched-post-card="${safeCssEscape(String(post.id))}"]`);
  if (card && card.dataset.schedCardWired !== '1') {
    card.dataset.schedCardWired = '1';
    card.addEventListener('click', (event) => {
      const interactive = event.target.closest('button,a,input,textarea,select,label,[data-sched-no-card-open]');
      if (interactive) return;
      openViewer(post);
    });
  }
  if (root.dataset.schedExpandWired !== '1') {
    root.dataset.schedExpandWired = '1';
    root.addEventListener('click', event => {
      const button = event.target.closest?.('[data-sched-expand-label]');
      if (!button || !root.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      const copy = button.closest('.sched-bounded-block')?.querySelector('.sched-bounded-copy');
      if (!copy) return;
      const expanded = button.getAttribute('aria-expanded') === 'true';
      const nextLabel = expanded
        ? (button.dataset.schedExpandText || `Show full ${button.dataset.schedExpandLabel}`)
        : (button.dataset.schedCollapseText || 'Show less');
      copy.classList.toggle('is-expanded', !expanded);
      button.setAttribute('aria-expanded', String(!expanded));
      button.setAttribute('aria-label', nextLabel);
      button.textContent = nextLabel;
    });
  }
  // Caption wrapping depends on the actual viewport. Hide the control when
  // the clamped copy does not overflow, including short mobile captions.
  requestAnimationFrame(() => {
    root.querySelectorAll('.sched-bounded-block').forEach(block => {
      const copy = block.querySelector('.sched-bounded-copy');
      const button = block.querySelector('[data-sched-expand-label]');
      if (!copy || !button || button.getAttribute('aria-expanded') === 'true') return;
      button.hidden = copy.scrollHeight <= copy.clientHeight + 1;
    });
  });
  root.querySelectorAll(`[data-post-id="${safeCssEscape(String(post.id))}"]`).forEach(btn => {
    if (btn.dataset.schedWired === '1') return;
    btn.dataset.schedWired = '1';
    btn.addEventListener('click', () => {
      const action = btn.dataset.schedAction;
      if (action === 'edit') openEditor(container, post);
      else if (action === 'view') openViewer(post);
      else if (action === 'draft') quickDraft(container, post, btn);
      else if (action === 'refresh-external') refreshExternalStatus(container, btn);
      else if (action === 'recover-external') recoverExternalDraft(container, post, btn);
      else if (action === 'reschedule') openEditor(container, post, { focusSchedule: true });
      else if (action === 'approve') approveForAutopublish(container, post);
      else if (action === 'unapprove') unapproveForAutopublish(container, post);
      else if (action === 'publish') publishPost(container, post);
      else if (action === 'delete') deletePost(container, post);
    });
  });
}

function sortLabel(value) {
  return ({ newest: 'newest first', oldest: 'oldest first', upcoming: 'upcoming first', status: 'status', platform: 'platform' })[value] || value;
}

function paginationHtml(totalPages) {
  if (totalPages <= 1) return '';
  const pages = [];
  const start = Math.max(1, scheduleState.page - 2);
  const end = Math.min(totalPages, start + 4);
  for (let page = start; page <= end; page++) {
    pages.push(`<button class="btn btn-sm" data-sched-page="${page}" aria-label="Go to page ${page}" ${page === scheduleState.page ? 'aria-current="page"' : ''} style="min-width:30px;${page === scheduleState.page ? 'background:var(--orange);color:#fff;border-color:var(--orange)' : ''}">${page}</button>`);
  }
  return `<nav class="sched-pagination" aria-label="Schedule pages" style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
    <button class="btn btn-sm" data-sched-page="prev" aria-label="Previous page" ${scheduleState.page <= 1 ? 'disabled' : ''}>Prev</button>
    ${pages.join('')}
    <span class="sched-pagination-status">Page ${scheduleState.page} of ${totalPages}</span>
    <button class="btn btn-sm" data-sched-page="next" aria-label="Next page" ${scheduleState.page >= totalPages ? 'disabled' : ''}>Next</button>
  </nav>`;
}

function wirePagination(container, el, totalPages) {
  el.querySelectorAll('[data-sched-page]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const value = btn.dataset.schedPage;
      if (value === 'prev') scheduleState.page = Math.max(1, scheduleState.page - 1);
      else if (value === 'next') scheduleState.page = Math.min(totalPages, scheduleState.page + 1);
      else scheduleState.page = Math.min(totalPages, Math.max(1, parseInt(value, 10) || 1));
      await loadAndRender(container);
      container.querySelector('#sched-queue [aria-current="page"]')?.focus();
    });
  });
}

function renderDashboard(container, el, posts, allPosts = posts) {
  const sorted = [...posts].sort(sortPosts);
  el.innerHTML = `
    <div class="sched-dashboard-grid" style="display:flex;flex-direction:column;gap:12px;align-items:stretch">
      ${scheduleState.calendarVisible ? `<section class="card sched-calendar-card sched-calendar-panel" aria-label="Calendar overview">
        <div class="sched-calendar-panel-head">
          <strong>Calendar overview</strong>
          <div class="sched-toolbar-month">
            <button class="btn btn-sm" id="sched-prev-month" title="Previous month" style="min-width:32px">‹</button>
            <span id="sched-month-label" style="font-size:12px;font-weight:800;color:var(--text);min-width:120px;text-align:center"></span>
            <button class="btn btn-sm" id="sched-next-month" title="Next month" style="min-width:32px">›</button>
            <button class="btn btn-sm" id="sched-time-toggle" title="Toggle 12/24 hour time">12h</button>
            <button class="btn btn-sm" id="sched-calendar-hide" title="Hide calendar overview">Hide</button>
          </div>
        </div>
        <div id="sched-mini-cal"></div>
      </section>` : ''}
      <div id="sched-queue"></div>
    </div>`;
  if (scheduleState.calendarVisible) {
    const calendarPosts = posts.length ? posts : allPosts;
    renderMonth(container, el.querySelector('#sched-mini-cal'), calendarPosts, { wrapCard: false });
    el.querySelector('#sched-time-toggle')?.addEventListener('click', () => { scheduleState.timeFormat = scheduleState.timeFormat === '12' ? '24' : '12'; loadAndRender(container); });
    el.querySelector('#sched-prev-month')?.addEventListener('click', () => { scheduleState.month = new Date(scheduleState.month.getFullYear(), scheduleState.month.getMonth() - 1, 1); loadAndRender(container); });
    el.querySelector('#sched-next-month')?.addEventListener('click', () => { scheduleState.month = new Date(scheduleState.month.getFullYear(), scheduleState.month.getMonth() + 1, 1); loadAndRender(container); });
    el.querySelector('#sched-calendar-hide')?.addEventListener('click', () => {
      scheduleState.calendarVisible = false;
      loadAndRender(container);
    });
  }
  renderList(container, el.querySelector('#sched-queue'), sorted, allPosts);
}

function renderMonth(container, el, posts, { wrapCard = true } = {}) {
  const year = scheduleState.month.getFullYear();
  const month = scheduleState.month.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const byDay = new Map();
  for (const p of posts) {
    const key = p.scheduled_at ? scheduleDayKey(new Date(p.scheduled_at)) : 'draft';
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(p);
  }
  const draftPosts = byDay.get('draft') || [];
  const calendarBody = `
      ${draftPosts.length ? `<button id="sched-drafts-detail" style="width:100%;text-align:left;padding:10px 12px;border:0;border-bottom:1px solid var(--border);background:var(--bg-secondary);font-size:12px;color:var(--text-2);cursor:pointer"><strong style="color:var(--text)">${draftPosts.length} draft${draftPosts.length === 1 ? '' : 's'}</strong> without date - click to review</button>` : ''}
      <div style="display:grid;grid-template-columns:repeat(7,1fr);background:var(--bg-secondary);border-bottom:1px solid var(--border)">${['S','M','T','W','T','F','S'].map(d => `<div style="padding:7px 4px;font-size:10px;font-weight:700;color:var(--text-3);text-align:center">${d}</div>`).join('')}</div>
      <div class="sched-month-grid" style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr))">${days.map(day => {
        const key = scheduleDayKey(day);
        const dayPosts = (byDay.get(key) || []).sort(sortPosts);
        const muted = day.getMonth() !== month;
        const today = key === scheduleDayKey(new Date());
        const firstPost = dayPosts[0];
        const platformDots = [...new Set(dayPosts.map(p => p.platform || 'all'))].slice(0, 4)
          .map(platform => `<span title="${esc(PLATFORM_NAMES[platform] || platform)}" style="width:7px;height:7px;border-radius:50%;background:${PLATFORM_COLORS[platform] || '#666'};display:inline-block"></span>`).join('');
        const hasStale = dayPosts.some(p => isStaleOverdue(p));
        const hasMissing = dayPosts.some(p => normalizeMediaItems(p).length === 0);
        const status = dayPosts.some(p => p.status === 'failed') ? 'failed'
          : hasStale ? 'stale'
            : hasMissing ? 'missing media'
              : dayPosts.some(p => p.status === 'published') ? 'published'
                : dayPosts.length ? 'scheduled' : '';
        const statusColor = status === 'failed' ? 'var(--red-text)'
          : status === 'stale' || status === 'missing media' ? 'var(--orange)'
            : status === 'published' ? 'var(--green)'
              : 'var(--text-3)';
        const bg = today ? 'var(--orange-light,#fff7ed)' : hasStale ? 'linear-gradient(180deg,var(--orange-light,#fff7ed),var(--bg))' : dayPosts.length ? 'var(--bg)' : 'var(--bg-card)';
        return `<button class="sched-day-cell" data-day-key="${esc(key)}" style="min-height:82px;padding:7px;border:0;border-right:1px solid var(--border);border-bottom:1px solid var(--border);background:${bg};opacity:${muted ? .55 : 1};text-align:left;cursor:${dayPosts.length ? 'pointer' : 'default'};color:var(--text);display:flex;flex-direction:column;gap:5px">
          <div style="font-size:11px;font-weight:800;color:${today ? 'var(--orange)' : 'var(--text-2)'};display:flex;justify-content:space-between;gap:4px;align-items:center"><span>${day.getDate()}</span>${dayPosts.length ? `<span style="font-size:10px;color:var(--text-3)">${dayPosts.length}</span>` : ''}</div>
          ${dayPosts.length ? `<div style="font-size:10px;font-weight:700;color:var(--text);line-height:1.25" title="${esc(dualScheduleDateLabel(firstPost.scheduled_at, firstPost, { timeFormat: scheduleState.timeFormat }))}">${esc(dualScheduleTimeLabel(firstPost.scheduled_at, firstPost, { timeFormat: scheduleState.timeFormat }))}</div>` : `<div style="flex:1"></div>`}
          ${dayPosts.length > 1 ? `<div style="font-size:10px;color:var(--text-3);white-space:nowrap">+${dayPosts.length - 1} more</div>` : ''}
          <div style="margin-top:auto;display:flex;gap:3px;align-items:center;min-height:8px">${platformDots}</div>
          ${status ? `<div style="font-size:9px;color:${statusColor};text-transform:uppercase;font-weight:700;letter-spacing:.02em">${status}</div>` : ''}
        </button>`;
      }).join('')}</div>`;
  el.innerHTML = wrapCard
    ? `<div class="card sched-calendar-card" style="padding:0;overflow:hidden">${calendarBody}</div>`
    : calendarBody;
  el.querySelector('#sched-drafts-detail')?.addEventListener('click', () => openDayDetail(container, 'Drafts', draftPosts));
  el.querySelectorAll('[data-day-key]').forEach(node => {
    const dayPosts = (byDay.get(node.dataset.dayKey) || []).sort(sortPosts);
    if (dayPosts.length) node.addEventListener('click', () => openDayDetail(container, node.dataset.dayKey, dayPosts));
  });
}

function monthPill(p, compact = false) {
  const color = PLATFORM_COLORS[p.platform] || '#666';
  const time = dualScheduleTimeLabel(p.scheduled_at, p, { timeFormat: scheduleState.timeFormat });
  const label = compact ? (p.platform || '?').slice(0, 2).toUpperCase() : (PLATFORM_NAMES[p.platform] || p.platform);
  return `<button title="${esc(`${time} ${PLATFORM_NAMES[p.platform] || p.platform}: ${p.caption || p.listing_title || ''}`)}" data-post-id="${esc(p.id)}" style="text-align:left;border:1px solid var(--border);background:var(--bg);border-left:4px solid ${color};border-radius:6px;padding:${compact ? '2px 4px' : '4px 5px'};cursor:pointer;min-width:0;font-size:${compact ? '9px' : '10px'};color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;width:100%">
    <strong style="color:var(--text)">${esc(time)}</strong> <span style="color:${color};font-weight:800">${esc(label)}</span>${compact ? '' : ` · ${esc((p.caption || p.listing_title || '').slice(0, 45))}`}
  </button>`;
}

function wireScheduleModal(modal, { closeButton, initialFocus = closeButton, onClose = () => modal.remove() } = {}) {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closed = false;
  const closeModal = () => {
    if (closed) return;
    closed = true;
    onClose();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter(node => node.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  requestAnimationFrame(() => initialFocus?.focus());
  return closeModal;
}

function renderBoundedModalPosts(container, list, posts) {
  const sortedPosts = [...posts].sort(sortPosts);
  let visibleCount = Math.min(MODAL_POST_BATCH_SIZE, sortedPosts.length);
  const render = () => {
    const visiblePosts = sortedPosts.slice(0, visibleCount);
    const remaining = sortedPosts.length - visibleCount;
    list.innerHTML = `${visiblePosts.map(post => postCardHtml(post)).join('')}
      ${remaining > 0 ? `<div class="sched-modal-load-more">
        <span>Showing ${visibleCount} of ${sortedPosts.length}</span>
        <button type="button" class="btn btn-sm" data-sched-load-more>Load ${Math.min(MODAL_POST_BATCH_SIZE, remaining)} more</button>
      </div>` : ''}`;
    for (const post of visiblePosts) wirePostActions(container, list, post);
    list.querySelector('[data-sched-load-more]')?.addEventListener('click', () => {
      const firstNewIndex = visibleCount;
      visibleCount = Math.min(sortedPosts.length, visibleCount + MODAL_POST_BATCH_SIZE);
      render();
      const nextLoadButton = list.querySelector('[data-sched-load-more]');
      const firstNewCard = list.querySelectorAll('[data-sched-action="view"]')[firstNewIndex];
      (nextLoadButton || firstNewCard)?.focus();
    });
  };
  render();
}

function openDayDetail(container, label, posts) {
  const title = label === 'Drafts'
    ? 'Drafts without date'
    : new Date(`${label}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  document.getElementById('sched-day-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div id="sched-day-modal" class="sched-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sched-day-title" style="position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px">
      <div class="sched-day-modal-panel" style="background:var(--bg-card);border-radius:14px;width:100%;max-width:820px;max-height:92vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,0.3)">
        <div style="position:sticky;top:0;background:var(--bg-card);z-index:1;display:flex;justify-content:space-between;gap:12px;align-items:center;padding:16px 18px;border-bottom:1px solid var(--border)">
          <div>
            <div id="sched-day-title" style="font-weight:800;font-size:15px;color:var(--text)">${esc(title)}</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:2px">${posts.length} post${posts.length === 1 ? '' : 's'}</div>
          </div>
          <button class="btn btn-sm" id="sched-day-close">Close</button>
        </div>
        <div id="sched-day-posts" style="padding:14px;display:flex;flex-direction:column;gap:10px"></div>
      </div>
    </div>`);
  const modal = document.getElementById('sched-day-modal');
  const list = document.getElementById('sched-day-posts');
  renderBoundedModalPosts(container, list, posts);
  const closeButton = document.getElementById('sched-day-close');
  const closeModal = wireScheduleModal(modal, { closeButton });
  closeButton.onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
}

function openReviewPackage(container, deepLink) {
  const posts = (deepLink.posts || []).sort(sortPosts);
  if (!posts.length) return;
  document.getElementById('sched-review-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div id="sched-review-modal" class="sched-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sched-review-title" style="position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px">
      <div class="sched-review-modal-panel" style="background:var(--bg-card);border-radius:14px;width:100%;max-width:920px;max-height:92vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,0.3)">
        <div style="position:sticky;top:0;background:var(--bg-card);z-index:1;display:flex;justify-content:space-between;gap:12px;align-items:center;padding:16px 18px;border-bottom:1px solid var(--border)">
          <div>
            <div id="sched-review-title" style="font-weight:800;font-size:15px;color:var(--text)">Owner review package</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(deepLink.id)} - ${posts.length} platform record${posts.length === 1 ? '' : 's'}</div>
          </div>
          <button class="btn btn-sm" id="sched-review-close">Close</button>
        </div>
        <div style="padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="padding:10px 12px;border:1px solid var(--orange-border,#fed7aa);border-radius:10px;background:var(--orange-light,#fff7ed);font-size:12px;line-height:1.45;color:var(--orange)">
            <strong>Review before approval:</strong> these records are saved for owner review only. Opening this link does not publish or approve autopublish.
          </div>
          <div id="sched-review-posts" style="display:flex;flex-direction:column;gap:10px"></div>
        </div>
      </div>
    </div>`);
  const modal = document.getElementById('sched-review-modal');
  const list = document.getElementById('sched-review-posts');
  renderBoundedModalPosts(container, list, posts);
  const closeButton = document.getElementById('sched-review-close');
  const closeModal = wireScheduleModal(modal, { closeButton });
  closeButton.onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
}

function postSortTime(post) {
  const raw = post.published_at || post.scheduled_at || post.created_at || 0;
  const time = typeof raw === 'number' ? raw : new Date(raw).getTime();
  return Number.isFinite(time) ? time : 0;
}

function statusRank(post) {
  const now = Date.now();
  if (isStaleOverdue(post, now) || isDuePost(post, now)) return 0;
  if (post.status === 'failed') return 1;
  if (isApprovedScheduled(post)) return 2;
  if (isExternallyQueued(post)) return 3;
  if (post.scheduled_at && post.status !== 'published') return 4;
  if (post.status === 'draft' || !post.scheduled_at) return 5;
  if (post.status === 'published') return 6;
  return 7;
}

function upcomingRank(post) {
  const now = Date.now();
  const time = post.scheduled_at ? new Date(post.scheduled_at).getTime() : null;
  if (post.status === 'published') return 4;
  if (post.status === 'failed') return 2;
  if (time && time <= now) return 0;
  if (time && time > now) return 1;
  return 3;
}

function sortPosts(a, b) {
  if (scheduleState.sort === 'oldest') return postSortTime(a) - postSortTime(b);
  if (scheduleState.sort === 'upcoming') {
    const rankDiff = upcomingRank(a) - upcomingRank(b);
    if (rankDiff) return rankDiff;
    if (a.scheduled_at && b.scheduled_at) return new Date(a.scheduled_at) - new Date(b.scheduled_at);
    return postSortTime(b) - postSortTime(a);
  }
  if (scheduleState.sort === 'status') return statusRank(a) - statusRank(b) || postSortTime(b) - postSortTime(a);
  if (scheduleState.sort === 'platform') return String(a.platform || '').localeCompare(String(b.platform || '')) || postSortTime(b) - postSortTime(a);
  return postSortTime(b) - postSortTime(a);
}

function normalizeMediaItems(post = {}) {
  return normalizeScheduledPost(post).media_items || [];
}

function canaryCandidateFromReadiness(readiness, post) {
  const candidates = Array.isArray(readiness?.candidates) ? readiness.candidates : [];
  return candidates.find(item => String(item.id || '') === String(post?.id || '')) || candidates[0] || null;
}

function blockerSummary(candidate) {
  return (Array.isArray(candidate?.blockers) ? candidate.blockers : [])
    .map(item => item?.message || item?.code || item)
    .filter(Boolean)
    .join('; ');
}

function humanCanaryBlockerSummary(candidate) {
  const summary = blockerSummary(candidate);
  if (/scheduled_at\s+is\s+required|schedule.*required/i.test(summary)) {
    return 'Choose a future publish time first. Safe publish review checks the exact post and schedule; nothing is published by this check.';
  }
  if (/schedule.*future|future.*schedule|lead.?time|review window/i.test(summary)) {
    return 'Move the publish time further into the future so there is enough time for owner review.';
  }
  return summary;
}

function captionPreview(value = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function canaryApprovalMessage(candidate, post) {
  const preview = candidate?.preview || {};
  const platform = PLATFORM_NAMES[candidate?.platform || post?.platform] || candidate?.platform || post?.platform || 'post';
  const route = candidate?.publish_route || 'configured route';
  const mediaCount = candidate?.media_count ?? (Array.isArray(preview.media_items) ? preview.media_items.length : normalizeMediaItems(post).length);
  const caption = captionPreview(preview.caption || post?.caption || '');
  return [
    'Canary readiness passed for this exact scheduled post.',
    '',
    `Platform: ${platform}`,
    `Route: ${route}`,
    `Media: ${mediaCount}`,
    caption ? `Caption: ${caption}` : '',
    '',
    'Approve this exact post and date for future autopublish? Editing or rescheduling will remove approval.',
  ].filter(line => line !== '').join('\n');
}

function isAgentScheduledPost(post = {}) {
  const hay = `${post.id || ''} ${post.source || ''} ${post.created_by || ''} ${post.approval_source || ''}`.toLowerCase();
  return hay.includes('agent-autonomy') || hay.includes('social_hermes') || hay.includes('autonomous_content_factory');
}

function boundedCopyHtml(value, {
  label = 'content',
  className = '',
  maxChars = 280,
  maxLines = 5,
  expandText = `Show full ${label}`,
  collapseText = 'Show less',
  showToggle = true,
} = {}) {
  const text = String(value || '');
  const isLong = text.length > maxChars || text.split('\n').length > maxLines;
  const classes = `sched-bounded-copy ${isLong ? 'is-bounded' : ''} ${className}`.trim();
  const copy = `<div class="${classes}" style="--sched-line-clamp:${Math.max(1, maxLines)}">${esc(text)}</div>`;
  if (!isLong || !showToggle) return copy;
  return `<div class="sched-bounded-block">
    ${copy}
    <button type="button" class="sched-content-toggle" data-sched-expand-label="${esc(label)}" data-sched-expand-text="${esc(expandText)}" data-sched-collapse-text="${esc(collapseText)}" aria-expanded="false" aria-label="${esc(expandText)}">${esc(expandText)}</button>
  </div>`;
}

function listingUrlForPost(post = {}) {
  const explicit = String(
    post.listing_url
      || post.etsy_url
      || post.metadata?.listing_url
      || post.metadata?.etsy_url
      || '',
  ).trim();
  if (explicit) {
    try {
      const parsed = new URL(explicit, window.location.origin);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
    } catch { /* keep looking for a canonical Etsy URL */ }
  }
  const listingId = String(post.listing_id || post.metadata?.listing_id || '').trim();
  return /^\d+$/.test(listingId) ? `https://www.etsy.com/listing/${encodeURIComponent(listingId)}` : '';
}

function listingLinkHtml(post = {}, { compact = false } = {}) {
  const title = String(post.listing_title || '').trim();
  if (!title) return '';
  const url = listingUrlForPost(post);
  const copy = url
    ? `<a class="sched-listing-link" href="${esc(url)}" target="_blank" rel="noopener" title="Open this Etsy listing">${esc(title)}<span aria-hidden="true">↗</span></a>`
    : `<span class="sched-listing-link is-disabled" title="No Etsy listing URL is stored">${esc(title)}</span>`;
  return `<div class="sched-listing-row ${compact ? 'is-compact' : ''}">
    <span class="sched-field-label">Promoted listing</span>
    ${copy}
  </div>`;
}

function postStatusDetails(post = {}, now = Date.now()) {
  const isPublished = post.status === 'published';
  const isFailed = post.status === 'failed';
  const isPaused = post.status === 'paused';
  const isQueuedExternal = post.status === 'queued_external' || post.status === 'queued';
  const isApproved = post.status === 'approved_scheduled' && post.approved_for_publish === true;
  const stale = isStaleOverdue(post, now);
  const due = !stale && isDuePost(post, now);
  const isScheduled = !isPublished && !isQueuedExternal && !isPaused && !!post.scheduled_at;
  const statusLabel = isPublished ? 'Published'
    : isFailed ? 'Failed'
      : isQueuedExternal ? 'Queued externally'
        : isPaused ? 'Paused'
          : isApproved ? 'Approved auto'
          : stale ? 'Stale overdue'
            : due ? 'Due now'
              : isScheduled ? 'Scheduled'
                : 'Draft';
  const statusColor = isPublished ? 'var(--green)'
    : isFailed ? 'var(--red-text)'
      : isQueuedExternal ? 'var(--blue,#2563eb)'
        : isPaused ? 'var(--text-3)'
          : isApproved ? 'var(--green)'
          : stale || due || isScheduled ? 'var(--orange)'
            : 'var(--text-3)';
  const dateLabel = isPublished ? 'Published' : isPaused ? 'Paused' : stale ? 'Missed' : due ? 'Due' : isScheduled ? 'Scheduled' : 'Created';
  const dateValue = isPublished ? (post.published_at || post.scheduled_at) : (post.scheduled_at || post.created_at);
  return { isPublished, isFailed, isQueuedExternal, isPaused, isApproved, stale, due, isScheduled, statusLabel, statusColor, dateLabel, dateValue };
}

function postCardHtml(p) {
  const { isPublished, isQueuedExternal, isPaused, isApproved, stale, due, isScheduled, statusLabel, statusColor, dateLabel, dateValue } = postStatusDetails(p);

  const mediaItems  = normalizeMediaItems(p);
  const imageUrl    = mediaItems[0]?.url || '';
  const mediaCount  = mediaItems.length;
  const caption = p.caption || '';
  const captionHtml = boundedCopyHtml(caption, {
    label: 'post copy',
    className: 'sched-caption-copy',
    maxChars: 360,
    maxLines: 6,
    showToggle: false,
  });
  const errorHtml = p.last_error
    ? boundedCopyHtml(p.last_error, { label: 'error details', className: 'sched-error-copy', maxChars: 180, maxLines: 3 })
    : '';
  const listingHtml = listingLinkHtml(p);
  const publishMethodHtml = p.publish_method
    ? boundedCopyHtml(`Sent via ${p.publish_method}`, { label: 'publish method', className: 'sched-inline-metadata', maxChars: 120, maxLines: 2 })
    : '';

  const mediaBadge = mediaCount > 1 ? `<span style="position:absolute;z-index:2;top:3px;right:3px;background:rgba(0,0,0,0.6);color:#fff;font-size:9px;font-weight:700;padding:1px 4px;border-radius:4px">1/${mediaCount}</span>` : '';
  const imgHtml = imageUrl
    ? mediaTileHtml(mediaItems[0], '168px', mediaBadge)
    : imageFallbackHtml('168px');
  const missingMedia = mediaCount === 0;
  const agentPost = isAgentScheduledPost(p);
  const captionReview = p.metadata?.ai_caption_quality_review;
  const captionReviewed = p.metadata?.ai_caption_quality_review_required === true
    && captionReview?.approved === true
    && captionReview?.decision === 'approve'
    && String(captionReview?.reviewed_caption || '').trim() === String(caption || '').trim();
  const addedValue = p.created_at || p.createdAt || p.created;
  const addedHtml = addedValue
    ? `<span class="sched-added-at" title="When this record entered the content queue">Created ${esc(formatScheduleDateInZone(addedValue, OWNER_DISPLAY_TIME_ZONE, { force24: true, locale: 'en-GB', timeFormat: scheduleState.timeFormat }) || addedValue)} Kyiv</span>`
    : '';
  const staleWarningHtml = stale ? `<div style="margin:8px 0 0;padding:8px 10px;border:1px solid var(--orange-border,#fed7aa);border-radius:8px;background:var(--orange-light,#fff7ed);color:var(--orange);font-size:11px;line-height:1.45"><strong>Historical record:</strong> this unapproved post missed its scheduled time and is ignored by autopublish. No action is required; reschedule only if you intentionally want to reuse it.</div>` : '';
  const pausedWarningHtml = isPaused ? `<div style="margin:8px 0 0;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text-2);font-size:11px;line-height:1.45"><strong style="color:var(--text)">Paused archive:</strong> this record is ignored by autopublish. Restore it to drafts before editing or scheduling it again.</div>` : '';
  const missingMediaWarningHtml = missingMedia && !isPaused ? `<div style="margin:8px 0 0;padding:8px 10px;border:1px dashed var(--orange-border,#fed7aa);border-radius:9px;background:var(--bg-secondary);color:var(--text-2);font-size:11px;line-height:1.45"><strong style="color:var(--orange)">Media required:</strong> add an image/video before approving or publishing this post.</div>` : '';
  const approveBtn = isApproved
    ? `<button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="unapprove" title="Remove autopublish approval and keep the post scheduled">Pause auto</button>`
    : `<button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="approve" title="Approve this exact post and time for automatic publishing">Approve auto</button>`;

  const actionBtns = isPublished || isQueuedExternal ? `
    <div class="sched-post-actions">
      <button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="view" title="View the complete post">View post</button>
      ${isQueuedExternal ? `
        <button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="refresh-external" title="Reload the queue and check whether the external publisher confirmed this post">Refresh status</button>
        <button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="recover-external" title="Keep the external attempt as history and create a separate unapproved draft copy">Recover draft copy</button>
        <span style="font-size:11px;color:var(--text-3);align-self:center">Sent externally; confirmation has not arrived yet</span>
      ` : ''}
    </div>` : isPaused ? `
    <div class="sched-post-actions">
      <button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="view" title="View the complete post">View post</button>
      <button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="draft" title="Restore this paused record to drafts">Restore to drafts</button>
      <button class="btn btn-sm sched-action-danger" data-post-id="${esc(p.id)}" data-sched-action="delete" title="Permanently delete this paused record">Delete</button>
    </div>` : `
    <div class="sched-post-actions">
      <button class="btn btn-primary btn-sm" data-post-id="${esc(p.id)}" data-sched-action="view" title="View the complete post">View post</button>
      <button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="edit" title="Edit post copy and media">Edit</button>
      <button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="reschedule" title="Choose a new publish date and time">Reschedule</button>
      <button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="draft" title="Remove the publish time and move this post to drafts">Move to drafts</button>
      ${approveBtn}
      <button class="btn btn-sm" data-post-id="${esc(p.id)}" data-sched-action="publish" title="Verify this post can be published; this check does not publish it">Check readiness</button>
      <button class="btn btn-sm sched-action-danger" data-post-id="${esc(p.id)}" data-sched-action="delete" title="Delete this draft or scheduled post">Delete</button>
    </div>`;

  return `
    <div class="card sched-post-card" role="article" aria-label="${esc(PLATFORM_NAMES[p.platform] || p.platform || 'Post')} ${esc(statusLabel)} post" data-sched-post-card="${esc(p.id)}">
      <div class="sched-post-main" style="display:flex;gap:12px;align-items:flex-start">
        ${imgHtml}
        <div class="sched-post-content-grid">
          <div class="sched-post-copy">
            <div class="sched-post-badges">
              ${platformBadge(p.platform || 'all')}
              <span style="font-size:11px;font-weight:800;color:${statusColor};text-transform:uppercase;letter-spacing:.03em">${statusLabel}</span>
              ${missingMedia ? missingMediaBadgeHtml() : ''}
              ${agentPost ? `<span style="font-size:10px;font-weight:800;color:var(--blue,#2563eb);background:var(--blue-light,#eff6ff);border:1px solid var(--blue-border,#bfdbfe);border-radius:999px;padding:2px 7px;text-transform:uppercase;letter-spacing:.03em" title="Created by ${esc(p.created_by || p.source || 'social agent')}">🤖 Agent</span>` : ''}
              ${captionReviewed ? `<span style="font-size:10px;font-weight:800;color:var(--green-text,var(--green));background:var(--green-light,#ecfdf5);border:1px solid var(--green-border,#bbf7d0);border-radius:999px;padding:2px 7px;text-transform:uppercase;letter-spacing:.03em" title="${esc(captionReview.rationale || 'Approved by the AI caption critic')}">AI reviewed</span>` : ''}
            </div>
            ${listingHtml}
            ${publishMethodHtml}
            ${errorHtml}
            <section class="sched-caption-panel" aria-label="Post copy">
              <span class="sched-field-label">Post copy</span>
              ${captionHtml || '<span class="sched-caption-empty">No post copy yet</span>'}
            </section>
            ${staleWarningHtml}
            ${pausedWarningHtml}
            ${missingMediaWarningHtml}
          </div>
          ${dateValue ? scheduleTimePanelMarkup(dateValue, p, dateLabel, { timeFormat: scheduleState.timeFormat, escapeHtml: esc }) : ''}
        </div>
      </div>
      ${actionBtns}
      ${addedHtml ? `<div class="sched-post-footnote">${addedHtml}</div>` : ''}
    </div>`;
}

// ── Editor modal ──────────────────────────────────────────

function openViewer(post) {
  const mediaItems = normalizeMediaItems(post);
  const details = postStatusDetails(post);
  const missingMedia = !mediaItems.length;
  const captionReview = post.metadata?.ai_caption_quality_review;
  const captionReviewHtml = post.metadata?.ai_caption_quality_review_required === true
    ? `<div style="margin-top:12px;border:1px solid var(--border);background:var(--bg-secondary);border-radius:10px;padding:12px 14px;font-size:12px;line-height:1.5;color:var(--text-2)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
          <strong style="color:var(--text)">AI caption review</strong>
          <span style="font-size:10px;font-weight:800;text-transform:uppercase;color:${captionReview?.approved === true ? 'var(--green)' : 'var(--orange)'}">${captionReview?.approved === true ? 'Approved' : 'Needs review'}</span>
        </div>
        ${captionReview?.rationale ? `<div>${esc(captionReview.rationale)}</div>` : '<div>No critic rationale is stored.</div>'}
        ${captionReview?.factual_grounding ? `<div style="margin-top:6px"><strong>Grounding:</strong> ${esc(captionReview.factual_grounding)}</div>` : ''}
        ${captionReview?.platform_fit ? `<div style="margin-top:6px"><strong>Platform fit:</strong> ${esc(captionReview.platform_fit)}</div>` : ''}
      </div>`
    : '';
  const safetyHtml = details.stale
    ? `<div style="border:1px solid var(--orange-border,#fed7aa);background:var(--orange-light,#fff7ed);color:var(--orange);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.45;margin-bottom:12px"><strong>Needs review:</strong> this post is stale/overdue. Use Reschedule on the card before approving it.</div>`
    : missingMedia
      ? `<div style="border:1px dashed var(--orange-border,#fed7aa);background:var(--bg-secondary);color:var(--text-2);border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.45;margin-bottom:12px"><strong style="color:var(--orange)">Missing media:</strong> this preview has no usable image/video yet.</div>`
      : '';
  document.getElementById('sched-view-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div id="sched-view-modal" class="sched-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sched-view-title" style="position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px">
      <div class="sched-view-modal-panel" style="background:var(--bg-card);border-radius:16px;padding:0;width:100%;max-width:820px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.3);overflow:hidden">
        <div style="position:sticky;top:0;z-index:1;background:var(--bg-card);display:flex;justify-content:space-between;gap:12px;align-items:center;padding:16px 18px;border-bottom:1px solid var(--border)">
          <div>
            <div id="sched-view-title" style="font-weight:800;font-size:15px;color:var(--text)">Post preview</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:2px">Review the media and post copy before taking an action.</div>
          </div>
          <button class="btn btn-sm" id="sched-view-close">Close</button>
        </div>
        <div class="sched-view-modal-body" style="padding:18px 20px 20px;overflow-y:auto;min-height:0">
          <div class="sched-view-summary">
            <div class="sched-view-summary-main">
              <div class="sched-post-badges">
                ${platformBadge(post.platform || 'all')}
                <span style="font-size:11px;font-weight:800;color:${details.statusColor};text-transform:uppercase;letter-spacing:.03em">${esc(details.statusLabel)}</span>
                ${missingMedia ? missingMediaBadgeHtml() : ''}
              </div>
              ${listingLinkHtml(post, { compact: true })}
            </div>
            ${details.dateValue ? scheduleTimePanelMarkup(details.dateValue, post, details.dateLabel, { timeFormat: scheduleState.timeFormat, escapeHtml: esc }) : ''}
          </div>
          ${safetyHtml}
          ${mediaItems.length ? `<div class="sched-view-media-gallery ${mediaItems.length === 1 ? 'is-single' : ''}" data-media-count="${mediaItems.length}">${mediaItems.map((m, idx) => { const href = mediaCandidateUrls(m)[0] || usableUrl(m.url); return `<a href="${esc(href)}" target="_blank" rel="noopener" title="Open image ${idx + 1} full size">${mediaTileHtml(m, '180px', mediaItems.length > 1 ? `<span style="position:absolute;z-index:3;top:6px;right:6px;background:rgba(0,0,0,.62);color:#fff;font-size:10px;font-weight:800;padding:2px 6px;border-radius:999px">${idx + 1}/${mediaItems.length}</span>` : '')}</a>`; }).join('')}</div>` : `<div class="sched-view-media-gallery is-single" data-media-count="0">${imageFallbackHtml('220px')}</div>`}
          <section class="sched-caption-panel is-modal" aria-label="Post copy">
            <span class="sched-field-label">Post copy</span>
            <div style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;color:var(--text)">${esc(post.caption || '')}</div>
          </section>
          ${captionReviewHtml}
        </div>
      </div>
    </div>`);
  const modal = document.getElementById('sched-view-modal');
  const closeButton = document.getElementById('sched-view-close');
  const closeModal = wireScheduleModal(modal, { closeButton });
  closeButton.onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
}

function buildEditorHTML(post, isNew, { focusSchedule = false } = {}) {
  const selectedPlatform = String(post?.platform || (isNew ? 'all' : '')).toLowerCase();
  const concretePlatforms = ['pinterest','instagram','facebook','tiktok'];
  const platformOptions = [
    ...(!isNew && !concretePlatforms.includes(selectedPlatform)
      ? [`<option value="" selected disabled>Choose a concrete platform</option>`]
      : []),
    ...(isNew ? ['all', ...concretePlatforms] : concretePlatforms)
    .map(p => `<option value="${p}" ${(post?.platform||'all')===p?'selected':''}>${PLATFORM_NAMES[p]||p}</option>`)
  ].join('');
  const dateValue = localDateTimeValue(post?.scheduled_at);
  const scheduleMin = localDateTimeValue(Date.now() + 5 * 60_000);
  const inputStyle = 'width:100%;box-sizing:border-box;font-size:13px;padding:8px 10px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text)';
  const listingRow = listingLinkHtml(post || {}, { compact: true });
  const hasListingImg = !!usableUrl(post?.listing_image_url);

  return `
    <div id="sched-modal" class="sched-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sched-editor-title" style="position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px">
      <div class="sched-editor-panel" style="background:var(--bg-card);border-radius:14px;padding:22px;width:100%;max-width:720px;max-height:92vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,0.3);display:grid;grid-template-columns:1fr 220px;gap:20px">

        <!-- Left: form -->
        <div>
          <div id="sched-editor-title" style="font-weight:700;font-size:14px;margin-bottom:18px">${isNew ? '+ New post' : '✎ Edit post'}</div>
          <div style="margin-bottom:14px">
            <label style="font-size:11px;font-weight:600;color:var(--text-2);display:block;margin-bottom:5px">Platform</label>
            <select id="ed-platform" style="${inputStyle}">${platformOptions}</select>
          </div>
          <div style="margin-bottom:14px">
            <label style="font-size:11px;font-weight:600;color:var(--text-2);display:block;margin-bottom:5px">Caption</label>
            <textarea id="ed-caption" rows="10" style="${inputStyle};line-height:1.55;resize:vertical;min-height:220px">${esc(post?.caption || '')}</textarea>
          </div>
          <div style="margin-bottom:14px">
            <label style="font-size:11px;font-weight:600;color:var(--text-2);display:block;margin-bottom:5px">Media</label>

            <!-- Listing image row -->
            <div id="ed-listing-img-row" style="display:${hasListingImg ? 'flex' : 'none'};align-items:center;gap:8px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px">
              <img src="${esc(post?.listing_image_url||'')}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0" onerror="this.style.display='none'">
              <span style="font-size:11px;color:var(--text-2);flex:1">Listing image</span>
              <button type="button" id="ed-remove-listing-img" style="font-size:10px;color:var(--red-text);background:none;border:none;cursor:pointer;padding:2px 6px">✕ Remove</button>
            </div>

            <!-- Custom media thumbnail strip -->
            <div id="ed-thumb-strip" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>

            <!-- Upload + URL buttons -->
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
              <label for="ed-file-input" class="btn btn-sm" style="cursor:pointer;margin:0">📁 Upload files</label>
              <input type="file" id="ed-file-input" accept="image/*,video/*" multiple style="display:none">
              <button type="button" class="btn btn-sm" id="ed-url-toggle">🔗 Add URL</button>
            </div>
            <div id="ed-url-row" style="display:none;margin-top:6px;gap:6px;align-items:center">
              <input type="url" id="ed-url-input" placeholder="https://…" style="${inputStyle.replace('width:100%','flex:1')};flex:1">
              <button type="button" class="btn btn-sm btn-primary" id="ed-url-add" style="white-space:nowrap">Add</button>
            </div>
            <div id="ed-media-hint" style="font-size:10px;color:var(--text-3);margin-top:5px">${PLATFORM_MEDIA_HINT[post?.platform||'all']||''}</div>
          </div>

          <div style="margin-bottom:14px">
            ${focusSchedule ? `<div id="sched-editor-schedule-notice" role="status" style="margin-bottom:8px;padding:9px 11px;border:1px solid var(--orange-border,#fed7aa);border-radius:9px;background:var(--orange-light,#fff7ed);color:var(--orange);font-size:12px;line-height:1.45"><strong>Choose a future time first.</strong> Safe publish review checks the exact post and its scheduled date. Nothing will be published from this check.</div>` : ''}
            <label for="ed-date" style="font-size:11px;font-weight:600;color:var(--text-2);display:block;margin-bottom:5px">Schedule date &amp; time <span style="font-weight:400;color:var(--text-3)">(leave empty for draft)</span></label>
            <input id="ed-date" type="datetime-local" value="${esc(dateValue)}" min="${esc(scheduleMin)}" ${focusSchedule ? 'aria-describedby="sched-editor-schedule-notice"' : ''} style="${inputStyle}">
          </div>
          ${listingRow}
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
            <button class="btn btn-sm" id="ed-cancel">Cancel</button>
            <button class="btn btn-primary btn-sm" id="ed-save">Save post</button>
          </div>
        </div>

        <!-- Right: live preview -->
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:8px">Preview</div>
          <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg-secondary)">
            <div id="ed-preview-media" style="position:relative;width:100%;aspect-ratio:1/1;background:var(--bg-secondary);overflow:hidden">
              <div id="ed-preview-inner" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:24px">🖼</div>
              <div id="ed-preview-nav" style="display:none;position:absolute;inset:0;pointer-events:none"></div>
            </div>
            <div style="padding:10px">
              <div id="ed-preview-platform" style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;margin-bottom:5px">${PLATFORM_NAMES[post?.platform||'all']||'All platforms'}</div>
              <div id="ed-preview-caption" style="font-size:11px;color:var(--text-2);line-height:1.5;white-space:pre-wrap;max-height:260px;overflow-y:auto">${esc(post?.caption||'')}</div>
            </div>
          </div>
        </div>

      </div>
    </div>`;
}

function openEditor(container, post, options = {}) {
  const isNew = !post;
  const id = post?.id || generateId();

  // ── Editor state ──────────────────────────────────────
  let listingImgUrl = usableUrl(post?.listing_image_url) || null;
  let mediaItems = [];
  mediaItems = normalizeMediaItems({ media_items: post?.media_items || [], custom_image_url: post?.custom_image_url, generated_image_url: post?.generated_image_url })
    .filter(m => m.url !== listingImgUrl);
  let previewIndex = 0;

  document.body.insertAdjacentHTML('beforeend', buildEditorHTML(post, isNew, options));
  const overlay = document.getElementById('sched-modal');

  // All media combined for preview (listing first, then custom)
  const allMedia = () => {
    const items = [];
    const listingUrl = usableUrl(listingImgUrl);
    if (listingUrl) items.push({ url: listingUrl, type: 'image' });
    for (const m of mediaItems) {
      const url = usableUrl(m?.url);
      if (url) items.push({ ...m, url });
    }
    return items;
  };

  function renderThumbStrip() {
    const strip = document.getElementById('ed-thumb-strip');
    if (!strip) return;
    if (!mediaItems.length) { strip.innerHTML = ''; return; }
    strip.innerHTML = mediaItems.map((m, i) => {
      const isActive = allMedia().indexOf(m) === previewIndex;
      const border = isActive ? '2px solid var(--orange)' : '1px solid var(--border)';
      const thumb = m.type === 'video'
        ? `<div style="width:48px;height:48px;border-radius:5px;border:${border};background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer" onclick="window.__edPreview(${i})">🎬</div>`
        : `<img src="${esc(m.url)}" style="width:48px;height:48px;object-fit:cover;border-radius:5px;border:${border};cursor:pointer" onerror="this.style.opacity=0.3" onclick="window.__edPreview(${i})">`;
      return `<div style="position:relative;flex-shrink:0">
        ${thumb}
        <button onclick="window.__edRemove(${i})" style="position:absolute;top:-5px;right:-5px;width:16px;height:16px;border-radius:50%;background:var(--red,#ef4444);color:#fff;border:none;cursor:pointer;font-size:10px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center">✕</button>
      </div>`;
    }).join('');
  }

  function updatePreview() {
    const all = allMedia();
    const item = all[previewIndex] || null;
    const inner = document.getElementById('ed-preview-inner');
    const nav   = document.getElementById('ed-preview-nav');
    if (!inner || !nav) return;

    if (item) {
      if (item.type === 'video') {
        inner.innerHTML = `<video src="${esc(item.url)}" style="width:100%;height:100%;object-fit:cover" muted autoplay loop playsinline></video>`;
      } else {
        inner.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:24px">🖼<img src="${esc(item.url)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onerror="this.remove()"></div>`;
      }
    } else {
      inner.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:24px">🖼</div>`;
    }

    if (all.length > 1) {
      nav.style.display = 'block';
      nav.style.pointerEvents = 'auto';
      nav.innerHTML = `
        <button id="ed-prev" style="position:absolute;left:4px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,0.45);color:#fff;border:none;border-radius:50%;width:24px;height:24px;cursor:pointer;font-size:16px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center">‹</button>
        <button id="ed-next" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,0.45);color:#fff;border:none;border-radius:50%;width:24px;height:24px;cursor:pointer;font-size:16px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center">›</button>
        <div style="position:absolute;bottom:6px;left:0;right:0;display:flex;justify-content:center;gap:4px;pointer-events:none">
          ${all.map((_, i) => `<div style="width:6px;height:6px;border-radius:50%;background:${i===previewIndex?'#fff':'rgba(255,255,255,0.45)'}"></div>`).join('')}
        </div>
        <div style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.5);color:#fff;font-size:10px;font-weight:600;padding:2px 6px;border-radius:10px;pointer-events:none">${previewIndex+1}/${all.length}</div>`;
      document.getElementById('ed-prev').onclick = () => { previewIndex = (previewIndex - 1 + all.length) % all.length; updatePreview(); renderThumbStrip(); };
      document.getElementById('ed-next').onclick = () => { previewIndex = (previewIndex + 1) % all.length; updatePreview(); renderThumbStrip(); };
    } else {
      nav.style.display = 'none';
      nav.innerHTML = '';
    }

    const cap  = document.getElementById('ed-preview-caption');
    const plat = document.getElementById('ed-preview-platform');
    const hint = document.getElementById('ed-media-hint');
    const platform = document.getElementById('ed-platform')?.value || 'all';
    if (cap)  cap.textContent  = document.getElementById('ed-caption')?.value || '';
    if (plat) plat.textContent = PLATFORM_NAMES[platform] || platform;
    if (hint) hint.textContent = PLATFORM_MEDIA_HINT[platform] || '';
  }

  // Window handlers for inline onclick in the thumb strip
  window.__edRemove = (idx) => {
    const item = mediaItems[idx];
    if (item?.type === 'video') URL.revokeObjectURL(item.url);
    mediaItems.splice(idx, 1);
    previewIndex = Math.max(0, Math.min(previewIndex, allMedia().length - 1));
    renderThumbStrip();
    updatePreview();
  };
  window.__edPreview = (idx) => {
    // idx is index in mediaItems; offset by 1 if listing image present
    previewIndex = listingImgUrl ? idx + 1 : idx;
    renderThumbStrip();
    updatePreview();
  };

  // File upload
  document.getElementById('ed-file-input').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const MAX = 10;
    if (mediaItems.length >= MAX) { toastError(`Max ${MAX} media items allowed`); return; }
    let added = 0;
    for (const file of files) {
      if (mediaItems.length >= MAX) { toastError('Reached 10 item limit'); break; }
      if (file.type.startsWith('video/')) {
        mediaItems.push({ url: URL.createObjectURL(file), type: 'video' });
      } else {
        try {
          const dataUrl = await resizeImageForUpload(file);
          mediaItems.push({ url: dataUrl, type: 'image' });
        } catch (err) {
          toastError(`Failed: ${err.message}`);
          continue;
        }
      }
      added++;
    }
    if (!added) return;
    previewIndex = allMedia().length - 1; // jump to last added
    renderThumbStrip();
    updatePreview();
  };

  // Add URL toggle + confirm
  const urlRow = document.getElementById('ed-url-row');
  document.getElementById('ed-url-toggle').onclick = () => {
    urlRow.style.display = urlRow.style.display === 'flex' ? 'none' : 'flex';
  };
  document.getElementById('ed-url-add').onclick = () => {
    const url = usableUrl(document.getElementById('ed-url-input').value);
    if (!url) return;
    if (mediaItems.length >= 10) { toastError('Max 10 media items'); return; }
    const type = /\.(mp4|mov|webm)(\?|#|$)/i.test(url) ? 'video' : 'image';
    mediaItems.push({ url, type });
    document.getElementById('ed-url-input').value = '';
    urlRow.style.display = 'none';
    previewIndex = allMedia().length - 1;
    renderThumbStrip();
    updatePreview();
  };

  // Caption + platform changes update preview
  document.getElementById('ed-caption').oninput = updatePreview;
  document.getElementById('ed-platform').onchange = updatePreview;

  // Remove listing image
  document.getElementById('ed-remove-listing-img')?.addEventListener('click', () => {
    listingImgUrl = null;
    document.getElementById('ed-listing-img-row').style.display = 'none';
    previewIndex = Math.max(0, Math.min(previewIndex, allMedia().length - 1));
    updatePreview();
  });

  // Close
  const closeEditor = () => {
    // Revoke any video blob URLs
    for (const m of mediaItems) {
      if (m.type === 'video' && m.url.startsWith('blob:')) URL.revokeObjectURL(m.url);
    }
    delete window.__edRemove;
    delete window.__edPreview;
    overlay.remove();
  };
  const closeModal = wireScheduleModal(overlay, {
    closeButton: document.getElementById('ed-cancel'),
    initialFocus: document.getElementById('ed-platform'),
    onClose: closeEditor,
  });
  document.getElementById('ed-cancel').onclick = closeModal;
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

  if (options.focusSchedule) {
    requestAnimationFrame(() => {
      const dateInput = document.getElementById('ed-date');
      dateInput?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      dateInput?.focus();
    });
  }

  // Save
  document.getElementById('ed-save').onclick = async () => {
    const caption = document.getElementById('ed-caption').value.trim();
    if (!caption) { toastError('Caption is required'); return; }
    const saveBtn = document.getElementById('ed-save');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const dateVal = document.getElementById('ed-date').value;
      // Don't persist video blob URLs (they expire with the session)
      if (mediaItems.some(m => m.type === 'video' && m.url?.startsWith('blob:'))) {
        toastError('Uploaded videos are preview-only right now. Add a hosted video URL before saving.');
        saveBtn.disabled = false; saveBtn.textContent = 'Save post';
        return;
      }
      const persistMedia = mediaItems.map(m => {
        const url = usableUrl(m?.url);
        return (m.type === 'video' && url.startsWith('blob:')) ? { ...m, url: null } : { ...m, url };
      }).filter(m => usableUrl(m.url));
      const record = {
        id, caption,
        platform:          document.getElementById('ed-platform').value,
        scheduled_at:      dateVal ? new Date(dateVal).toISOString() : null,
        media_items:       persistMedia,
        custom_image_url:  persistMedia[0]?.url || null,   // backward compat
        listing_id:        post?.listing_id    || null,
        listing_title:     post?.listing_title || null,
        listing_image_url: listingImgUrl,
        status:            dateVal ? 'scheduled' : 'draft',
        created_at:        post?.created_at    || Date.now(),
      };
      if (!record.platform || (!isNew && record.platform === 'all')) {
        toastError('Choose one concrete platform before updating this post.');
        saveBtn.disabled = false; saveBtn.textContent = 'Save post';
        return;
      }
      const selectedMediaCount = allMedia().length;
      if (record.platform === 'pinterest' && selectedMediaCount !== 1) {
        toastError(`Pinterest requires exactly one image; this post currently has ${selectedMediaCount}.`);
        saveBtn.disabled = false; saveBtn.textContent = 'Save post';
        return;
      }
      const savedRecord = isNew ? await saveScheduledPost(record) : await updateScheduledPost(id, record);
      if (Array.isArray(savedRecord)) {
        toastSuccess(`Post expanded and saved to ${savedRecord.length} configured platforms.`);
      } else {
        if (savedRecord) Object.assign(record, savedRecord);
        toastSuccess(isNew ? 'Post saved!' : 'Post updated!');
      }
      closeModal();
      await loadAndRender(container);
    } catch (e) {
      toastError('Save failed: ' + e.message);
      saveBtn.disabled = false; saveBtn.textContent = 'Save post';
    }
  };

  // Initial render
  renderThumbStrip();
  updatePreview();
}

// ── Publish now ───────────────────────────────────────────
function setScheduleActionPending(button, pendingText) {
  if (!button) return () => {};
  const originalText = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = pendingText;
  const card = button.closest('[data-sched-post-card]');
  if (card) card.classList.add('is-action-pending');
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = originalText;
    if (card) card.classList.remove('is-action-pending');
  };
}

async function quickDraft(container, post, button = null) {
  const reset = setScheduleActionPending(button, 'Restoring...');
  try {
    const restored = await restoreScheduledPostToDraft(post.id, post);
    toastSuccess(restored.restored_from_snapshot
      ? 'The stale card was recovered as a new unapproved draft.'
      : 'Moved to drafts.');
    await loadAndRender(container);
  } catch (e) {
    reset();
    toastError('Restore failed: ' + e.message);
  }
}

async function refreshExternalStatus(container, button = null) {
  const reset = setScheduleActionPending(button, 'Checking...');
  try {
    await loadAndRender(container);
    toastInfo('External publish status refreshed.');
  } catch (e) {
    reset();
    toastError('Refresh failed: ' + e.message);
  }
}

async function recoverExternalDraft(container, post, button = null) {
  if (!confirm('Create a separate unapproved draft copy? The original external attempt will remain in history because a late publisher confirmation may still arrive.')) return;
  const reset = setScheduleActionPending(button, 'Recovering...');
  try {
    await recoverQueuedExternalPostToDraft(post.id);
    toastSuccess('Recovered an unapproved draft copy. The unconfirmed external attempt was moved to failed history.');
    await loadAndRender(container);
  } catch (e) {
    reset();
    toastError('Recovery failed: ' + e.message);
  }
}

async function approveForAutopublish(container, post) {
  if (!post.scheduled_at) {
    toastInfo('Choose a future schedule date before approving autopublish.');
    openEditor(container, post, { focusSchedule: true });
    return;
  }
  if (new Date(post.scheduled_at).getTime() <= Date.now() + 5 * 60_000) {
    toastInfo('Choose a later schedule date before approving autopublish.');
    openEditor(container, post, { focusSchedule: true });
    return;
  }
  try {
    const readiness = await getAdminCanaryReadiness(post.id, { min_lead_minutes: 5, probe_media: true });
    const candidate = canaryCandidateFromReadiness(readiness, post);
    if (!candidate || candidate.ready_for_canary_approval !== true) {
      toastError(`Safe publish review blocked: ${humanCanaryBlockerSummary(candidate) || 'this post is not ready for approval'}`);
      return;
    }
    if (!confirm(canaryApprovalMessage(candidate, post))) return;
    await approveScheduledPost(post.id, { approvedBy: 'admin-ui' });
    toastSuccess('Approved for safe autopublish.');
    await loadAndRender(container);
  } catch (e) {
    toastError('Approval failed: ' + e.message);
  }
}

async function unapproveForAutopublish(container, post) {
  if (!confirm('Remove autopublish approval and keep this post scheduled?')) return;
  try {
    await unapproveScheduledPost(post.id, { unapprovedBy: 'admin-ui', reason: 'manual pause from schedule UI' });
    toastSuccess('Autopublish approval removed.');
    await loadAndRender(container);
  } catch (e) {
    toastError('Pause failed: ' + e.message);
  }
}

async function publishPost(container, post) {
  // Guardrail for overnight/UI work: the Schedule page must never trigger real
  // social publishing. This action is intentionally a safe review/check only.
  const details = postStatusDetails(post);
  if (normalizeMediaItems(post).length === 0) {
    toastError('Add media before publish review. Nothing was sent.');
    return;
  }
  if (!post.scheduled_at) {
    toastInfo('Choose a future schedule date before running safe publish review. Nothing was published.');
    openEditor(container, post, { focusSchedule: true });
    return;
  }
  if (new Date(post.scheduled_at).getTime() <= Date.now() + 5 * 60_000) {
    toastInfo('This post needs a later schedule date before safe publish review. Nothing was published.');
    openEditor(container, post, { focusSchedule: true });
    return;
  }
  if (details.stale) {
    toastError('Reschedule stale overdue posts before publish review. Nothing was sent.');
    return;
  }
  try {
    const readiness = await getAdminCanaryReadiness(post.id, { min_lead_minutes: 5, probe_media: true });
    const candidate = canaryCandidateFromReadiness(readiness, post);
    if (!candidate || candidate.ready_for_canary_approval !== true) {
      toastError(`Safe publish review blocked: ${humanCanaryBlockerSummary(candidate) || 'this post is not ready for approval'}`);
      return;
    }
    toastSuccess(`Canary readiness passed: ${candidate.publish_route || 'configured route'}, ${candidate.media_count || normalizeMediaItems(post).length} media. No live publishing happened.`);
  } catch (e) {
    toastError('Readiness check failed: ' + e.message);
  }
}

// ── Delete ────────────────────────────────────────────────
async function deletePost(container, post) {
  const id = String(post?.id || '');
  if (!id || pendingDeleteIds.has(id)) return;
  if (!confirm('Delete this post?')) return;

  pendingDeleteIds.add(id);
  const selectorId = safeCssEscape(id);
  const buttons = document.querySelectorAll(`[data-post-id="${selectorId}"][data-sched-action="delete"]`);
  const cards = document.querySelectorAll(`[data-sched-post-card="${selectorId}"]`);
  buttons.forEach(btn => { btn.disabled = true; btn.textContent = 'Deleting…'; });
  cards.forEach(card => {
    card.style.opacity = '0.45';
    card.style.pointerEvents = 'none';
    card.style.transition = 'opacity .12s ease';
  });

  try {
    await deleteScheduledPost(id);
    cards.forEach(card => card.remove());
    toastSuccess('Post deleted.');
    await loadAndRender(container);
  } catch (e) {
    toastError('Delete failed: ' + e.message);
    await loadAndRender(container);
  } finally {
    pendingDeleteIds.delete(id);
  }
}
