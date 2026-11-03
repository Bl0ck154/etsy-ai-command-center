// public/pages/social.js — Social Hub: generate + publish + cross-post

import { etsy, ai, social, kv } from '../utils/api.js';
import { price, truncate, escHtml, number, escJsSingle } from '../utils/format.js';
import { toastSuccess, toastError, toastInfo } from '../components/toast.js';
import { getOrFetch, invalidate } from '../utils/store.js';
import { getAllPostRecords } from '../utils/post-store.js';
import { saveScheduledPost, getScheduledPosts, generateId } from '../utils/schedule-store.js';
import { drafts as idbDrafts } from '../utils/idb.js';
import { currentOriginMediaAssetUrl, normalizeMediaUrl, listingVideoUrl } from '../utils/media-url.js';
import { socialHistoryPresentation, socialPagerHtml } from '../utils/social-history-view.js';
import {
  applySocialSort,
  buildAutopilotUsageIndex,
  historyStatusLabel,
  listingImageUrl,
  listingImageUrls,
  mergeAutopilotListingFacts,
  normalizePublishHistoryStatus,
  parseAutopilotStreamJson,
  selectListingsForAutopilot,
  socialHubScheduleStatus,
  usageSummaryForPost,
} from '../utils/social-view-model.js';

const SOCIAL_MEDIA_RECOVERY_TOKEN = Date.now().toString(36);
const LEGACY_SOCIAL_COMPOSER_ENABLED = false;

function blockLegacySocialComposer() {
  toastInfo('This legacy composer is retired. Review Social Hermes posts in Content Schedule.');
}

const PLATFORMS = [
  { id: 'pinterest', name: 'Pinterest', color: '#E60023', limit: 500, hashLimit: 0 },
  { id: 'instagram', name: 'Instagram', color: '#C13584', limit: 2200, hashLimit: 30 },
  { id: 'facebook', name: 'Facebook', color: '#1877F2', limit: 63206, hashLimit: 5 },
  { id: 'tiktok', name: 'TikTok', color: '#000000', limit: 150, hashLimit: 10 },
];

// Media type support per platform
const PLATFORM_MEDIA = {
  pinterest: { image: true, video: true },
  instagram: { image: true, video: true },
  facebook:  { image: true, video: true },
  tiktok:    { image: false, video: true }, // TikTok: video only
};

const CROSSPOST_SERVICES = [
  { id: 'buffer', name: 'Buffer' },
  { id: 'metricool', name: 'Metricool' },
  { id: 'make', name: 'Make.com' },
  { id: 'zapier', name: 'Zapier' },
];

let state = {
  listings: [],
  allListings: [],
  sections: [],
  selectedSection: '',
  selectedListing: null,
  posts: { pinterest: '', instagram: '', facebook: '', tiktok: '' },
  publishStatus: {},
  publishUrls: {},
  generating: false,
  generatingPlatforms: new Set(),
  provider: localStorage.getItem('ai_provider') || 'external',
  tone: 'engaging',
  history: [],
  pinterestBoards: [],
  facebookPages: [],
  selectedBoard: '',
  selectedPage: '',
  selectedImages: { pinterest: '', instagram: [], facebook: '', tiktok: '' },
  customMedia: [],
  previewPlatform: null,
  autopilotPlan: null,
  autopilotSaving: false,
  autopilotContext: null,
  autopilotContextListings: [],
  historyPlatform: 'all',
  historyStatus: 'all',
  historySort: 'newest',
  historyPage: 1,
  historyPageSize: 10,
  listingPage: 1,
  listingPageSize: 20,
};

const AUTOPILOT_PLAN_KEY = 'etsy_mgr_autopilot_plan_v1';

function autopilotPlanId(plan) {
  const basis = (plan?.posts || []).map(p => [p.platform, p.listing_id, p.scheduled_at, p.caption].join('|')).join('||');
  let hash = 0;
  for (let i = 0; i < basis.length; i++) hash = ((hash << 5) - hash + basis.charCodeAt(i)) | 0;
  return `auto_${Math.abs(hash).toString(36)}`;
}

function saveAutopilotPlanCache(plan) {
  try { localStorage.setItem(AUTOPILOT_PLAN_KEY, JSON.stringify({ savedAt: Date.now(), plan })); } catch {}
}

function loadAutopilotPlanCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(AUTOPILOT_PLAN_KEY) || 'null');
    return cached?.plan?.posts?.length ? cached.plan : null;
  } catch { return null; }
}

function clearAutopilotPlanCache() {
  try { localStorage.removeItem(AUTOPILOT_PLAN_KEY); } catch {}
}

// ── Social platform configs (KV + localStorage, loaded on init) ──
let socialConfigs = {};
// ── Server-side config status ──
let configStatus = {};
async function loadSocialConfigs() {
  try {
    const data = await kv.getSocialConfigs();
    if (data && typeof data === 'object') {
      socialConfigs = data;
      for (const k of ['pinterest_config', 'fb_posts_config', 'ig_config', 'tiktok_config']) {
        if (data[k]) try { localStorage.setItem(k, JSON.stringify(data[k])); } catch {}
      }
    }
  } catch { /* KV offline — fall through to localStorage */ }
  // Also populate from localStorage for any key not in KV
  for (const k of ['pinterest_config', 'fb_posts_config', 'ig_config', 'tiktok_config']) {
    if (!socialConfigs[k]) {
      try { const v = JSON.parse(localStorage.getItem(k) || 'null'); if (v) socialConfigs[k] = v; } catch {}
    }
  }
  // Refresh account chips if cards are already rendered
  if (state.selectedListing) renderPlatformCards();
}

async function checkIgTokenHealth() {
  const cfg = socialConfigs.ig_config;
  if (!cfg?.token) return;
  if (cfg.invalid) {
    toastError('Instagram token is invalid — reconnect in Settings.');
    return;
  }
  if (!cfg.expires_at) return;
  const daysLeft = (new Date(cfg.expires_at) - Date.now()) / 86400000;
  if (daysLeft <= 0) {
    toastError('Instagram token expired — <a href="#" onclick="window.navigate(\'settings\')" style="color:inherit;text-decoration:underline">reconnect in Settings</a>');
    return;
  }
  if (daysLeft <= 7) {
    try {
      const data = cfg.token_type?.startsWith('facebook_long_lived_user')
        ? await social.extendFacebookToken({ token: cfg.token, page_id: cfg.page_id })
        : await social.refreshInstagramToken(cfg.token);
      if (data.success && data.access_token) {
        cfg.token = data.access_token;
        if (cfg.token_type?.startsWith('facebook_long_lived_user')) cfg.token_type = cfg.token_type.includes('direct') ? 'facebook_long_lived_user_direct' : 'facebook_long_lived_user';
        cfg.expires_at = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();
        localStorage.setItem('ig_config', JSON.stringify(cfg));
        socialConfigs.ig_config = cfg;
        kv.setSocialConfig('ig_config', cfg).catch(() => {});
        toastSuccess('Instagram token refreshed and saved.');
      }
    } catch (e) {
      cfg.invalid = true;
      cfg.last_error = e.message;
      localStorage.setItem('ig_config', JSON.stringify(cfg));
      socialConfigs.ig_config = cfg;
      kv.setSocialConfig('ig_config', cfg).catch(() => {});
      toastError(`Instagram token refresh failed — reconnect in Settings. ${e.message || ''}`);
    }
  }
}

// ── Draft persistence helpers ────────────────────────────
const DRAFT_KEY_PREFIX = 'social_draft_';
function saveDraft(listingId, posts) {
  if (!listingId) return;
  idbDrafts.set(DRAFT_KEY_PREFIX + listingId, posts); // async, fire-and-forget
}
async function loadDraft(listingId) {
  return idbDrafts.get(DRAFT_KEY_PREFIX + listingId);
}

export async function renderSocial(container, params = {}) {
  // Don't reset posts if we're returning to the same listing (state persists across navigations)
  const isReturn = !!state.selectedListing && !params.listing_id;
  if (!isReturn) {
    state.posts = { pinterest: '', instagram: '', facebook: '', tiktok: '' };
    state.publishStatus = {};
    state.publishUrls = {};
    state.selectedSection = '';
  }

  container.innerHTML = `
    <div class="page-header social-hub-hero">
      <div>
        <div class="page-eyebrow">AI campaign desk</div>
        <div class="page-title">Social Hub</div>
        <div class="page-subtitle">Review the agent's rationale, media choices, and publishing queue</div>
      </div>
      <button class="btn btn-sm" id="soc-clear-btn" style="color:var(--text-3)">Clear posts</button>
    </div>
    <div class="page-body">
      <div class="card mb-12" id="autopilot-card" style="border:1px solid var(--orange-border,#fed7aa);background:linear-gradient(135deg,var(--bg-card),var(--orange-light,#fff7ed))">
        <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap">
          <div style="min-width:260px;flex:1">
            <div style="font-size:12px;font-weight:800;color:var(--orange,#f97316);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Content Autopilot</div>
            <div style="font-size:18px;font-weight:800;color:var(--text);margin-bottom:4px">Fill your social calendar automatically</div>
            <div style="font-size:12px;color:var(--text-2);line-height:1.55;max-width:720px">AI reviews the selected shop scope and recent queue history, then proposes platform-specific drafts and media choices for owner review in the Content Calendar.</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <label style="font-size:11px;color:var(--text-3);display:flex;align-items:center;gap:5px">Days
              <input id="auto-days" type="number" min="1" max="30" step="1" value="14" class="form-input" style="width:70px;font-size:12px;padding:7px 8px" oninput="window.__clampAutopilotInput?.('auto-days',1,30,14)" onblur="window.__clampAutopilotInput?.('auto-days',1,30,14)">
            </label>
            <label style="font-size:11px;color:var(--text-3);display:flex;align-items:center;gap:5px">Listings to use
              <select id="auto-source" class="form-input" style="width:220px;font-size:12px;padding:7px 8px">
                <option value="all">All listings</option>
                <option value="filtered">Current visible filter</option>
                <option value="selected">Selected listing only</option>
              </select>
            </label>
            <button class="btn btn-primary btn-sm" id="auto-plan-btn">Fill Calendar</button>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;font-size:11px;color:var(--text-2);align-items:center">
          ${['instagram','pinterest','facebook','tiktok'].map((p) => `
            <label style="display:flex;align-items:center;gap:5px;background:var(--bg-card);border:1px solid var(--border);border-radius:999px;padding:5px 8px" title="${p === 'tiktok' ? 'Draft/manual only until video/publishing is stable' : ''}">
              <input type="checkbox" class="auto-platform" value="${p}" ${p !== 'tiktok' ? 'checked' : ''}>
              <span>${PLATFORMS.find(x => x.id === p)?.name || p}</span>
              <input type="number" class="auto-platform-count form-input" data-platform="${p}" min="0" max="30" step="1" value="${p === 'tiktok' ? 0 : 3}" style="width:54px;font-size:11px;padding:3px 5px" oninput="window.__clampAutopilotInput?.(this.id,0,30,0)" id="auto-count-${p}">
            </label>`).join('')}
          <span style="color:var(--text-3)">Set exact post counts per platform. Unchecked platforms are ignored.</span>
        </div>
        <details style="margin-top:10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);overflow:hidden">
          <summary style="cursor:pointer;padding:9px 12px;font-size:12px;font-weight:700;color:var(--text)">Advanced campaign settings</summary>
          <div style="padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;font-size:11px;color:var(--text-2);align-items:end">
            <label style="display:flex;flex-direction:column;gap:4px;font-weight:600">Campaign theme
              <input id="auto-campaign-theme" class="form-input" type="text" placeholder="graduation, summer, pickleball..." style="width:100%;box-sizing:border-box;font-size:12px;padding:7px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text)">
            </label>
            <label style="grid-column:span 2;display:flex;flex-direction:column;gap:4px;font-weight:600">Posting window
              <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:7px;align-items:center">
                <input id="auto-time-start" class="form-input" type="time" value="09:00" style="width:100%;box-sizing:border-box;font-size:12px;padding:7px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);color-scheme:light dark">
                <span style="font-size:11px;color:var(--text-3);font-weight:700">to</span>
                <input id="auto-time-end" class="form-input" type="time" value="19:30" style="width:100%;box-sizing:border-box;font-size:12px;padding:7px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);color-scheme:light dark">
              </div>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-weight:600">Max posts/day
              <input id="auto-max-per-day" class="form-input" type="number" min="1" max="10" value="2" style="width:100%;box-sizing:border-box;font-size:12px;padding:7px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text)">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-weight:600">Repeat same listing after days
              <input id="auto-repeat-days" class="form-input" type="number" min="1" max="30" value="7" style="width:100%;box-sizing:border-box;font-size:12px;padding:7px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text)">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-weight:600">Repeat policy
              <select id="auto-repeat-scope" class="form-input" style="width:100%;box-sizing:border-box;font-size:12px;padding:7px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text)">
                <option value="per_platform">Per platform</option>
                <option value="global">Across all platforms</option>
              </select>
            </label>
            <label style="min-height:52px;display:flex;align-items:center;gap:7px;font-weight:600;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:7px 8px;box-sizing:border-box">
              <input id="auto-allow-cross-platform" type="checkbox" checked> Allow same listing across platforms
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-weight:600">Creative images
              <select id="auto-creative-mode" class="form-input" style="width:100%;box-sizing:border-box;font-size:12px;padding:7px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text)">
                <option value="ai_decides">AI decides</option>
                <option value="existing_only">Existing media only</option>
                <option value="generation_allowed">Generation allowed</option>
              </select>
            </label>
            <label style="min-height:52px;display:flex;align-items:center;gap:7px;font-weight:600;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:7px 8px;box-sizing:border-box">
              <input id="auto-include-weekends" type="checkbox" checked> Include weekends
            </label>
          </div>
        </details>
        <div id="autopilot-output" style="margin-top:12px"></div>
      </div>
      <div class="soc-main-grid">

        <!-- Left panel: listing selector -->
        <div>
          <div class="card mb-12">
            <div class="card-title">Select listing</div>
            <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center">
              <div style="flex:1;position:relative">
                <svg style="position:absolute;left:8px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-3);z-index:1" width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                <input id="listing-search" type="search" placeholder="Search listings…"
                  class="form-input"
                  style="width:100%;box-sizing:border-box;font-size:12px;padding:6px 8px 6px 28px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text)"
                  oninput="window.__socialFilterListings(this.value)">
              </div>
              <div style="position:relative;flex-shrink:0">
                <select id="listing-sort" onchange="window.__socialSortListings(this.value)"
                  style="font-size:12px;padding:6px 28px 6px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);appearance:none;-webkit-appearance:none;cursor:pointer;outline:none">
                  <option value="created">Newest</option>
                  <option value="title">A → Z</option>
                  <option value="price_asc">Price ↑</option>
                  <option value="price_desc">Price ↓</option>
                  <option value="views">Views</option>
                </select>
                <svg style="position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-3)" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </div>
            </div>
            <div style="margin-bottom:8px;position:relative">
              <select id="listing-section" onchange="window.__socialSectionFilter(this.value)"
                style="width:100%;font-size:12px;padding:6px 28px 6px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);appearance:none;-webkit-appearance:none;cursor:pointer;outline:none">
                <option value="">All sections</option>
              </select>
              <svg style="position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-3)" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <div id="listing-select" style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px">
              <div style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">Loading…</div>
            </div>
            <div id="listing-pagination" style="margin:-2px 0 10px"></div>
            <div id="listing-preview"></div>
            <div id="listing-images"></div>
          </div>

          <div class="card" style="margin-top:12px">
            <div class="row-between" style="gap:10px;align-items:flex-start;margin-bottom:8px">
              <div>
                <div class="card-title" style="margin-bottom:2px">Post history</div>
                <div style="font-size:11px;color:var(--text-3);line-height:1.4">Only confirmed publishes are marked published. Webhook sends stay queued until callback.</div>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-bottom:10px">
              <select id="history-platform-filter" class="form-input" style="font-size:11px;padding:6px 7px" onchange="window.__socialHistoryPlatform(this.value)">
                <option value="all" ${state.historyPlatform === 'all' ? 'selected' : ''}>All platforms</option>
                ${PLATFORMS.map(p => `<option value="${p.id}" ${state.historyPlatform === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
              </select>
              <select id="history-status-filter" class="form-input" style="font-size:11px;padding:6px 7px" onchange="window.__socialHistoryStatus(this.value)">
                <option value="all" ${state.historyStatus === 'all' ? 'selected' : ''}>All statuses</option>
                <option value="published" ${state.historyStatus === 'published' ? 'selected' : ''}>Published</option>
                <option value="draft" ${state.historyStatus === 'draft' ? 'selected' : ''}>Draft</option>
                <option value="owner_review" ${state.historyStatus === 'owner_review' ? 'selected' : ''}>Needs review</option>
                <option value="scheduled" ${state.historyStatus === 'scheduled' ? 'selected' : ''}>Scheduled</option>
                <option value="queued" ${state.historyStatus === 'queued' ? 'selected' : ''}>Sending</option>
                <option value="failed" ${state.historyStatus === 'failed' ? 'selected' : ''}>Failed</option>
              </select>
              <select id="history-sort" class="form-input" style="font-size:11px;padding:6px 7px" onchange="window.__socialHistorySort(this.value)">
                <option value="newest" ${state.historySort === 'newest' ? 'selected' : ''}>Newest</option>
                <option value="oldest" ${state.historySort === 'oldest' ? 'selected' : ''}>Oldest</option>
                <option value="platform" ${state.historySort === 'platform' ? 'selected' : ''}>Platform</option>
                <option value="listing" ${state.historySort === 'listing' ? 'selected' : ''}>Listing</option>
              </select>
              <select id="history-page-size" class="form-input" style="font-size:11px;padding:6px 7px" onchange="window.__socialHistoryPageSize(this.value)" aria-label="History items per page">
                ${[10, 20, 30].map(size => `<option value="${size}" ${state.historyPageSize === size ? 'selected' : ''}>${size} per page</option>`).join('')}
              </select>
            </div>
            <div id="post-history">
              <div style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">Published posts will appear here</div>
            </div>
          </div>
        </div>

        <!-- Right panel: compact controls + platform cards -->
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;padding:8px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
            <button class="btn btn-primary btn-sm" id="gen-social-btn" onclick="window.generateAllPosts()" style="white-space:nowrap;gap:5px">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
              Generate all
            </button>
            <div style="display:flex;gap:4px;align-items:center;border-left:1px solid var(--border);padding-left:8px">
              <label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer">
                <input type="radio" name="soc-provider" value="gemini" checked style="accent-color:var(--orange)"> Gemini
              </label>
              <label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer">
                <input type="radio" name="soc-provider" value="claude" style="accent-color:var(--orange)"> Claude
              </label>
            </div>
            <div style="position:relative;border-left:1px solid var(--border);padding-left:8px">
              <select id="soc-tone" style="font-size:11px;padding:4px 24px 4px 6px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);appearance:none;-webkit-appearance:none;cursor:pointer;outline:none">
                <option value="engaging">Engaging</option>
                <option value="professional">Professional</option>
                <option value="playful">Playful</option>
                <option value="urgent">Urgent</option>
                <option value="storytelling">Storytelling</option>
              </select>
              <svg style="position:absolute;right:6px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-3)" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
          </div>

          <div id="platform-cards">
            <div class="empty-state" style="padding:48px">
              <div class="empty-state-icon">📱</div>
              <div class="empty-state-title">Select a listing to get started</div>
              <p>Then generate posts for all platforms at once</p>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  if (!LEGACY_SOCIAL_COMPOSER_ENABLED) {
    container.querySelector('#autopilot-card')?.remove();
    container.querySelector('#gen-social-btn')?.parentElement?.remove();
  }

  window.selectListing = selectListing;
  window.generateAllPosts = LEGACY_SOCIAL_COMPOSER_ENABLED ? generateAllPosts : blockLegacySocialComposer;
  window.runContentAutopilot = LEGACY_SOCIAL_COMPOSER_ENABLED ? runContentAutopilot : blockLegacySocialComposer;
  window.saveAutopilotPlan = LEGACY_SOCIAL_COMPOSER_ENABLED ? saveAutopilotPlan : blockLegacySocialComposer;
  window.generateOnePlatform = LEGACY_SOCIAL_COMPOSER_ENABLED ? generateOnePlatform : blockLegacySocialComposer;
  window.publishToPlatform = LEGACY_SOCIAL_COMPOSER_ENABLED ? publishToPlatform : blockLegacySocialComposer;
  window.sendToCrosspost = LEGACY_SOCIAL_COMPOSER_ENABLED ? sendToCrosspost : blockLegacySocialComposer;
  window.copyPost = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    navigator.clipboard.writeText(el.value).then(() => {
      toastSuccess('Copied!');
      const btn = el.parentElement?.querySelector('button[title="Copy text"]');
      if (btn) {
        btn.style.color = 'var(--green-text,#2e7d32)';
        setTimeout(() => { btn.style.color = 'var(--text-3)'; }, 1000);
      }
    });
  };
  window.__socialFilterListings = () => { state.listingPage = 1; refreshListingList(); };
  window.__socialSortListings = () => { state.listingPage = 1; refreshListingList(); };
  window.__socialSectionFilter = (sectionId) => {
    state.selectedSection = sectionId;
    state.listingPage = 1;
    refreshListingList();
  };
  window.__socialListingPage = (page) => { state.listingPage = page; refreshListingList(); document.getElementById('listing-select')?.scrollTo?.(0, 0); };
  window.__socialHistoryPlatform = (value) => { state.historyPlatform = value || 'all'; state.historyPage = 1; renderHistory(); };
  window.__socialHistoryStatus = (value) => { state.historyStatus = value || 'all'; state.historyPage = 1; renderHistory(); };
  window.__socialHistorySort = (value) => { state.historySort = value || 'newest'; state.historyPage = 1; renderHistory(); };
  window.__socialHistoryPage = (page) => { state.historyPage = page; renderHistory(); };
  window.__socialHistoryPageSize = (value) => { state.historyPageSize = parseInt(value, 10) || 10; state.historyPage = 1; renderHistory(); };
  window.__clampAutopilotInput = (id, min, max, fallback) => clampNumberInput(id, min, max, fallback, id === 'auto-days' ? 'Days' : 'Posts/week');

  // Load social configs from KV → localStorage (ensures Instagram/Pinterest tokens available)
  loadSocialConfigs().then(() => checkIgTokenHealth());

  // Clear button
  container.querySelector('#soc-clear-btn')?.addEventListener('click', () => {
    if (state.generating) return;
    if (Object.values(state.posts).some(Boolean)) {
      state.posts = { pinterest: '', instagram: '', facebook: '', tiktok: '' };
      state.publishStatus = {};
      if (state.selectedListing) saveDraft(state.selectedListing.listing_id, state.posts);
      renderPlatformCards();
      toastSuccess('Posts cleared');
    }
  });

  container.querySelector('#auto-plan-btn')?.addEventListener('click', runContentAutopilot);
  const cachedPlan = state.autopilotPlan || loadAutopilotPlanCache();
  if (cachedPlan?.posts?.length) {
    state.autopilotPlan = cachedPlan;
    renderAutopilotPlan(cachedPlan);
  }

  await loadListings();
  loadSections();

  // If returning to page with a listing already selected, restore the cards
  if (isReturn && state.selectedListing) {
    renderPlatformCards();
  }

  // Restore history from in-memory state (re-render after HTML rebuild)
  renderHistory();

  // Load post history from KV in background (fills in on fresh page load)
  loadPostHistory();

  // Check if any publish service is configured and show banner if not
  checkSocialConfig();

  // Load platform metadata in background
  loadPlatformMeta();

  // Auto-select if passed from create page or agent
  if (params.listing_id) {
    // Try to find in already-loaded list
    let found = state.listings.find(l => String(l.listing_id) === String(params.listing_id));

    // If not found (e.g. draft/newly created not yet indexed), fetch it directly
    if (!found) {
      try {
        const specific = await etsy.getListing(params.listing_id);
        if (specific?.listing_id) {
          state.listings.unshift(specific);
          const sel = document.getElementById('listing-select');
          if (sel) {
            const opt = document.createElement('option');
            opt.value = String(specific.listing_id);
            const priceVal = ((specific.price?.amount || 0) / (specific.price?.divisor || 100)).toFixed(2);
            opt.textContent = truncate(specific.title, 100) + ' · $' + priceVal;
            sel.prepend(opt);
          }
          found = specific;
        }
      } catch { }
    }

    const sel = document.getElementById('listing-select');
    if (sel) { sel.value = String(params.listing_id); }
    if (found) {
      await selectListing(params.listing_id);
      // Auto-generate if requested (e.g. from listings page "Post to Social" button)
      if (params.autoGenerate) blockLegacySocialComposer();
    }
  }

  // Pre-fill caption if passed from AI Agent social post card
  if (params.caption) {
    const targets = (params.platform && params.platform !== 'all')
      ? [params.platform]
      : Object.keys(state.posts);
    for (const p of targets) {
      if (p in state.posts) state.posts[p] = params.caption;
    }
    renderPlatformCards();
  }
}

async function checkSocialConfig() {
  try {
    const r = await fetch('/api/social', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'checkConfig' }) });
    const cfg = await r.json();
    configStatus = cfg; // store for account label chips
    if (state.selectedListing) renderPlatformCards(); // refresh account chips
    const anyConfigured = cfg.hasBuffer || cfg.hasMake || cfg.hasZapier || cfg.hasMetricool || cfg.hasFacebook || cfg.hasInstagram || cfg.hasPinterest;
    if (!anyConfigured && !document.getElementById('soc-config-banner')) {
      const banner = document.createElement('div');
      banner.id = 'soc-config-banner';
      banner.style.cssText = 'background:var(--orange-light,#fff7ed);border:1px solid var(--orange-border,#fed7aa);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:var(--orange,#ea580c);display:flex;align-items:center;justify-content:space-between;gap:10px';
      banner.innerHTML = `<span>⚠️ No social platform is connected. Connect Facebook, Instagram, or Pinterest in Settings to publish directly, or copy captions and post manually.</span><button onclick="window.navigate('settings')" style="background:var(--orange,#f97316);color:#fff;border:none;padding:5px 12px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap">Open Settings →</button>`;
      const body = document.querySelector('.page-body');
      if (body) body.insertBefore(banner, body.firstChild);
    }
  } catch { /* ignore — not critical */ }
}

async function loadPlatformMeta() {
  // Only attempt if social section has been configured
  // Fail silently — boards/pages are optional enhancement
  try {
    const boards = await social.getPinterestBoards();
    state.pinterestBoards = Array.isArray(boards) ? boards : [];
  } catch { state.pinterestBoards = []; /* credentials not set — that's fine */ }

  try {
    const pages = await social.getFacebookPages();
    state.facebookPages = Array.isArray(pages) ? pages : [];
  } catch { state.facebookPages = []; }
  // Refresh account chips once platform meta is known
  if (state.selectedListing) renderPlatformCards();
}

async function loadPostHistory() {
  try {
    const [records, scheduledPosts] = await Promise.all([
      getAllPostRecords().catch(() => []),
      getScheduledPosts().catch(() => []),
    ]);
    // Convert KV records to state.history format (newest first already from KV)
    // Only add records not already in memory (avoid duplicates on return navigation)
    const existing = new Set(state.history.map(h => `${h._source || 'history'}:${h.platform}:${h._id || ''}`));
    const publishedItems = (Array.isArray(records) ? records : [])
      .filter(r => !existing.has(`history:${r.platform}:${r._id || ''}`))
      .map(r => ({
        _id: r._id,
        _source: 'history',
        _postedAt: r.postedAt || 0,
        platform: r.platform,
        service: r.service || 'direct',
        listing: truncate(r.listing_title || '', 40),
        date: r.postedAt ? formatHistoryDate(r.postedAt) : '',
        status: r.status || 'published',
        post_url: r.post_url || null,
        error: r.error || null,
        result: null,
      }));
    const reviewItems = (Array.isArray(scheduledPosts) ? scheduledPosts : [])
      .filter(r => !existing.has(`schedule:${r.platform}:${r.id || r._id || ''}`))
      .map(r => {
        const createdAt = r.updated_at || r.created_at || r.scheduled_at || 0;
        return {
          _id: r.id || r._id,
          _source: 'schedule',
          _postedAt: createdAt ? new Date(createdAt).getTime() : 0,
          platform: r.platform || 'all',
          service: 'Etsy AI Command Center',
          listing: truncate(r.listing_title || r.mapped_listing_title || r.title || 'Owner-review post', 40),
          date: createdAt ? formatHistoryDate(createdAt) : '',
          status: socialHubScheduleStatus(r),
          review_url: `/schedule?preview_id=${encodeURIComponent(r.parent_preview_id || r.preview_id || r.id || r._id || '')}`,
          error: r.error || null,
          result: null,
        };
      });
    const newItems = [...publishedItems, ...reviewItems];
    if (newItems.length) {
      state.history = [...state.history, ...newItems]
        .sort((a, b) => (b._postedAt || 0) - (a._postedAt || 0));
      renderHistory();
    }
  } catch { /* KV offline — history stays empty, no problem */ }
}

async function loadListings() {
  try {
    const listings = await getOrFetch('listings:active:complete', async () => {
      const pageSize = 100;
      const maxPages = 20;
      const all = [];
      for (let page = 0; page < maxPages; page++) {
        const r = await etsy.getListings({
          limit: pageSize,
          offset: page * pageSize,
          state: 'active',
          sort_on: 'created',
          sort_order: 'desc',
        });
        const rows = Array.isArray(r.results) ? r.results : [];
        all.push(...rows);
        const reportedTotal = Number(r.count || 0);
        if (rows.length < pageSize || (reportedTotal > 0 && all.length >= reportedTotal)) break;
      }
      return all;
    });
    state.allListings = listings;
    state.listings = listings;
    refreshListingList();
  } catch (e) {
    toastError('Could not load listings: ' + e.message);
  }
}

async function loadSections() {
  try {
    const result = await getOrFetch('sections', () => etsy.getShopSections());
    state.sections = result.results || result || [];
    const sel = document.getElementById('listing-section');
    if (sel && state.sections.length) {
      state.sections.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.shop_section_id;
        opt.textContent = s.title;
        sel.appendChild(opt);
      });
    }
    const autoSel = document.getElementById('auto-source');
    if (autoSel && state.sections.length && !autoSel.querySelector('option[data-section-option="1"]')) {
      const group = document.createElement('optgroup');
      group.label = 'Shop sections';
      state.sections.forEach(s => {
        const opt = document.createElement('option');
        opt.value = `section:${s.shop_section_id}`;
        opt.textContent = s.title;
        opt.dataset.sectionOption = '1';
        group.appendChild(opt);
      });
      autoSel.appendChild(group);
    }
  } catch (e) {
    console.warn('[social] loadSections failed:', e.message);
  }
}

function renderListingOptions(listings) {
  const sel = document.getElementById('listing-select');
  const pagination = document.getElementById('listing-pagination');
  if (!sel) return;
  if (!listings.length) {
    sel.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">No listings found</div>`;
    if (pagination) pagination.innerHTML = '';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(listings.length / state.listingPageSize));
  state.listingPage = Math.min(Math.max(1, Number(state.listingPage) || 1), totalPages);
  const start = (state.listingPage - 1) * state.listingPageSize;
  const pageListings = listings.slice(start, start + state.listingPageSize);
  const activeId = state.selectedListing?.listing_id;
  sel.innerHTML = pageListings.map(l => {
    const thumb = l.MainImage?.url_75x75 || l.images?.[0]?.url_75x75 || '';
    const priceVal = ((l.price?.amount || 0) / (l.price?.divisor || 100)).toFixed(2);
    const isActive = String(l.listing_id) === String(activeId);
    return `<div onclick="window.selectListing('${l.listing_id}')" data-lid="${l.listing_id}"
      style="display:flex;align-items:center;gap:10px;padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.1s;${isActive ? 'background:var(--orange-bg,#fff7f0)' : ''}"
      onmouseenter="this.style.background=this.dataset.active==='1'?'var(--orange-bg,#fff7f0)':'var(--bg-secondary)'"
      onmouseleave="this.style.background=this.dataset.active==='1'?'var(--orange-bg,#fff7f0)':''">
      ${thumb ? `<img src="${thumb}" style="width:36px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0">` : `<div style="width:36px;height:36px;background:var(--bg-secondary);border-radius:4px;flex-shrink:0"></div>`}
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:${isActive ? '600' : '400'};color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(truncate(l.title, 80))}</div>
        <div style="font-size:11px;color:var(--text-3)">$${priceVal}</div>
      </div>
      ${isActive ? `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="color:var(--orange);flex-shrink:0"><path d="M3 8l4 4 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ''}
    </div>`;
  }).join('');
  // Mark active items for hover logic
  sel.querySelectorAll('[data-lid]').forEach(el => {
    if (el.dataset.lid === String(activeId)) el.dataset.active = '1';
  });
  if (pagination) pagination.innerHTML = socialPagerHtml({
    currentPage: state.listingPage,
    totalPages,
    start: start + 1,
    end: Math.min(start + pageListings.length, listings.length),
    total: listings.length,
    onPage: 'window.__socialListingPage',
    label: 'Listing pages',
  });
}

function refreshListingList() {
  const sel = document.getElementById('listing-select');
  if (!sel) return;
  const scrollTop = sel.scrollTop;
  const q = (document.getElementById('listing-search')?.value || '').toLowerCase();
  const sortKey = document.getElementById('listing-sort')?.value || 'created';
  let filtered = state.allListings;
  if (q) filtered = filtered.filter(l => l.title.toLowerCase().includes(q));
  if (state.selectedSection) filtered = filtered.filter(l => String(l.shop_section_id) === state.selectedSection);
  renderListingOptions(applySocialSort(filtered, sortKey));
  sel.scrollTop = scrollTop;
}

function localDateValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function selectedMediaForPlatform(platformId, listing = state.selectedListing) {
  if (platformId === 'instagram') {
    const urls = (state.selectedImages.instagram || []).filter(Boolean);
    return { imageUrl: urls[0] || '', imageUrls: urls, mediaItems: urls.map(url => ({ url, type: /\.(mp4|mov|webm)(\?|#|$)/i.test(url) ? 'video' : 'image' })) };
  }
  const selected = state.selectedImages[platformId] || '';
  const imageUrls = selected ? [selected] : [];
  return { imageUrl: selected, imageUrls, mediaItems: imageUrls.map(url => ({ url, type: /\.(mp4|mov|webm)(\?|#|$)/i.test(url) ? 'video' : 'image' })) };
}

function autopilotListingById(listingId) {
  const id = String(listingId || '');
  return state.autopilotContextListings.find(listing => String(listing.listing_id) === id)
    || state.allListings.find(listing => String(listing.listing_id) === id)
    || null;
}

function getAutopilotListingPool() {
  const source = document.getElementById('auto-source')?.value || 'all';
  if (source === 'selected') return state.selectedListing ? [state.selectedListing] : [];
  let listings = state.allListings;
  if (source.startsWith('section:')) {
    const sectionId = source.slice('section:'.length);
    return listings.filter(l => String(l.shop_section_id) === sectionId);
  }
  if (source === 'filtered') {
    const q = (document.getElementById('listing-search')?.value || '').toLowerCase();
    if (q) listings = listings.filter(l => l.title.toLowerCase().includes(q));
    if (state.selectedSection) listings = listings.filter(l => String(l.shop_section_id) === state.selectedSection);
  }
  return listings;
}

function getAutopilotPlatformPlan() {
  const checked = new Set([...document.querySelectorAll('.auto-platform:checked')].map(el => el.value));
  const counts = {};
  for (const input of document.querySelectorAll('.auto-platform-count')) {
    const platform = input.dataset.platform;
    const value = clampNumberInput(input.id, 0, 30, 0, platform).value;
    if (checked.has(platform) && value > 0) counts[platform] = value;
  }
  const platforms = Object.keys(counts);
  return { counts, platforms, targetCount: Object.values(counts).reduce((a, b) => a + b, 0) };
}

function getAutopilotCampaignSettings(targetCount) {
  const timeStart = document.getElementById('auto-time-start')?.value || '09:00';
  const timeEnd = document.getElementById('auto-time-end')?.value || '19:30';
  const maxPostsPerDay = clampNumberInput('auto-max-per-day', 1, 10, 2, 'Max posts/day').value;
  const repeatListingAfterDays = clampNumberInput('auto-repeat-days', 1, 30, 7, 'Repeat same listing after days').value;
  const repeatScope = document.getElementById('auto-repeat-scope')?.value || 'per_platform';
  const allowCrossPlatformRepeat = !!document.getElementById('auto-allow-cross-platform')?.checked;
  const creativeMode = document.getElementById('auto-creative-mode')?.value || 'ai_decides';
  return {
    theme: (document.getElementById('auto-campaign-theme')?.value || '').trim(),
    timeWindow: { start: timeStart, end: timeEnd },
    maxPostsPerDay,
    includeWeekends: !!document.getElementById('auto-include-weekends')?.checked,
    repeatListingAfterDays,
    repeatScope,
    allowCrossPlatformRepeat,
    creativeMode,
  };
}

function clampNumberInput(id, min, max, fallback, label) {
  const el = document.getElementById(id);
  const raw = Number(el?.value || fallback);
  let value = Number.isFinite(raw) ? Math.round(raw) : fallback;
  const original = value;
  value = Math.min(Math.max(value, min), max);
  if (el && String(el.value) !== String(value)) el.value = String(value);
  return { value, corrected: original !== value, message: original !== value ? `${label} changed from ${original} to ${value} (allowed ${min}-${max}).` : '' };
}

function extractPartialAutopilotPosts(text) {
  const posts = [];
  const source = String(text || '');
  const regex = /"platform"\s*:\s*"(instagram|pinterest|facebook|tiktok)"[\s\S]{0,2600}?"caption"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = regex.exec(source)) && posts.length < 6) {
    let caption = match[2];
    try { caption = JSON.parse(`"${caption}"`); } catch { caption = caption.replace(/\\n/g, '\n'); }
    posts.push({ platform: match[1], caption });
  }
  return posts;
}

function normalizeAutopilotPlan(raw, usageIndex = new Map()) {
  const plan = raw && typeof raw === 'object' ? raw : {};
  const posts = Array.isArray(plan.posts) ? plan.posts : [];
  const normalizationWarnings = [];
  const normalized = {
    id: plan.id || null,
    summary: String(plan.summary || 'Autopilot content plan'),
    notes: Array.isArray(plan.notes) ? plan.notes.filter(Boolean).map(String) : [],
    warnings: Array.isArray(plan.warnings) ? plan.warnings.filter(Boolean).map(String) : [],
    requested_counts: plan.requested_counts || null,
    saved_at: plan.saved_at || null,
    posts: posts.map((p, i) => {
      if (!p || typeof p !== 'object') {
        normalizationWarnings.push(`Post ${i + 1}: AI returned an invalid record.`);
        return null;
      }
      const listing = autopilotListingById(p.listing_id);
      if (!listing) {
        normalizationWarnings.push(`Post ${i + 1}: AI selected a listing outside the supplied Etsy inventory.`);
        return null;
      }
      const platform = String(p.platform || '').toLowerCase();
      if (!['instagram', 'pinterest', 'facebook', 'tiktok'].includes(platform)) {
        normalizationWarnings.push(`Post ${i + 1}: AI did not return a supported platform.`);
        return null;
      }
      const scheduled = p.scheduled_at ? new Date(p.scheduled_at) : null;
      if (!scheduled || Number.isNaN(scheduled.getTime())) {
        normalizationWarnings.push(`Post ${i + 1}: AI did not return a valid schedule time.`);
        return null;
      }
      const caption = String(p.caption || '').trim();
      if (!caption) {
        normalizationWarnings.push(`Post ${i + 1}: AI returned an empty caption.`);
        return null;
      }
      const usage = usageIndex.get(String(p.listing_id || listing?.listing_id || '')) || [];
      const now = Date.now();
      const allowedMediaUrls = new Set(listingImageUrls(listing));
      const rawMediaItems = Array.isArray(p.media_items) ? p.media_items : [];
      const generationBriefs = Array.isArray(p.generation_briefs) ? p.generation_briefs : [];
      const allowedAspectRatios = new Set(['1:1', '4:5', '2:3', '3:4', '9:16', '16:9']);
      const mediaItemsValid = rawMediaItems.every(item => {
        const order = Number(item?.order);
        const url = String(item?.url || '').trim();
        return item && typeof item === 'object' && !Array.isArray(item)
          && Number.isInteger(order) && order > 0
          && item.source === 'listing_image'
          && Boolean(String(item.role || '').trim())
          && allowedMediaUrls.has(url);
      });
      if (!mediaItemsValid) {
        normalizationWarnings.push(`Post ${i + 1}: AI returned malformed listing media or selected media outside this Etsy listing gallery.`);
        return null;
      }
      const generationBriefsValid = generationBriefs.every(brief => {
        const order = Number(brief?.order);
        const id = String(brief?.id || '').trim();
        const role = String(brief?.role || '').trim();
        const prompt = String(brief?.prompt || '').trim();
        const aspectRatio = String(brief?.aspect_ratio || '').trim();
        const referencePolicy = String(brief?.reference_policy || '').trim();
        const referenceUrl = String(brief?.reference_image_url || '').trim();
        const referenceValid = brief?.reference_required === true
          ? Boolean(referenceUrl) && allowedMediaUrls.has(referenceUrl)
          : brief?.reference_required === false && !referenceUrl;
        return brief && typeof brief === 'object' && !Array.isArray(brief)
          && Number.isInteger(order) && order > 0
          && Boolean(id) && Boolean(role) && Boolean(prompt)
          && allowedAspectRatios.has(aspectRatio)
          && typeof brief.reference_required === 'boolean'
          && Boolean(referencePolicy)
          && referenceValid;
      });
      const briefIds = generationBriefs.map(brief => String(brief?.id || '').trim());
      if (!generationBriefsValid || new Set(briefIds).size !== briefIds.length) {
        normalizationWarnings.push(`Post ${i + 1}: AI returned an incomplete generation brief or invalid listing-image reference.`);
        return null;
      }
      const combinedOrders = [...rawMediaItems, ...generationBriefs].map(item => Number(item?.order));
      if (!combinedOrders.length || new Set(combinedOrders).size !== combinedOrders.length) {
        normalizationWarnings.push(`Post ${i + 1}: AI media plan must contain at least one frame with a unique explicit order.`);
        return null;
      }
      return {
        id: generateId(),
        caption,
        platform,
        strategy_reason: String(p.strategy_reason || '').trim(),
        listing_id: Number(listing.listing_id),
        listing_title: listing.title || '',
        listing_image_url: rawMediaItems[0]?.url || null,
        media_items: rawMediaItems.map(item => ({ ...item, order: Number(item.order) })),
        generation_briefs: generationBriefs,
        scheduled_at: scheduled.toISOString(),
        status: 'draft',
        creative_brief: p.creative_brief || '',
        usage_context: usage.map(u => ({
          platform: u.platform,
          source: u.source,
          status: u.status,
          days_ago: u.at ? Math.max(0, Math.floor((now - u.at) / 86400000)) : null,
        })),
        risk_level: p.risk_level || 'needs_review',
        created_at: Date.now(),
      };
    }).filter(Boolean),
  };
  normalized.warnings.push(...normalizationWarnings);
  normalized.id = normalized.id || autopilotPlanId(normalized);
  return normalized;
}

function validateAutopilotPlan(plan, platformCounts) {
  const warnings = [];
  const actual = (plan.posts || []).reduce((m, p) => { m[p.platform] = (m[p.platform] || 0) + 1; return m; }, {});
  for (const [platform, requested] of Object.entries(platformCounts || {})) {
    if ((actual[platform] || 0) !== requested) warnings.push(`${platform}: requested ${requested}, got ${actual[platform] || 0}`);
  }
  for (const platform of Object.keys(actual)) {
    if (!Object.prototype.hasOwnProperty.call(platformCounts || {}, platform)) warnings.push(`${platform}: generated ${actual[platform]} unrequested post(s)`);
  }
  return { ...plan, requested_counts: platformCounts, warnings: [...(plan.warnings || []), ...warnings] };
}

function validateAutopilotSchedule(plan, campaign = {}) {
  const warnings = [];
  const byDay = new Map();
  const listingDates = new Map();
  const listingPlatformDates = new Map();
  const start = campaign.timeWindow?.start || '00:00';
  const end = campaign.timeWindow?.end || '23:59';
  const toMinutes = (s) => {
    const [h, m] = String(s || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const startMin = toMinutes(start);
  const endMin = toMinutes(end);
  const maxPerDay = Number(campaign.maxPostsPerDay || 0);
  const repeatDays = Number(campaign.repeatListingAfterDays || 0);

  for (const post of plan.posts || []) {
    const d = new Date(post.scheduled_at);
    if (Number.isNaN(d.getTime())) continue;
    const day = d.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
    const dow = d.getDay();
    if (campaign.includeWeekends === false && (dow === 0 || dow === 6)) warnings.push(`${day}: weekend post scheduled while weekends are off`);
    const minutes = d.getHours() * 60 + d.getMinutes();
    if (minutes < startMin || minutes > endMin) warnings.push(`${day}: ${post.platform} is outside ${start}-${end}`);
    if (post.listing_id && repeatDays) {
      const key = String(post.listing_id);
      const globalPrev = listingDates.get(key);
      const platformKey = `${key}:${post.platform}`;
      const platformPrev = listingPlatformDates.get(platformKey);
      if (campaign.repeatScope === 'global' || campaign.allowCrossPlatformRepeat === false) {
        if (globalPrev && Math.abs(d - globalPrev) / 86400000 < repeatDays) warnings.push(`${post.listing_title || key}: repeated across platforms within ${repeatDays} days`);
      } else if (platformPrev && Math.abs(d - platformPrev) / 86400000 < repeatDays) {
        warnings.push(`${post.listing_title || key}: repeated on ${post.platform} within ${repeatDays} days`);
      }
      listingDates.set(key, d);
      listingPlatformDates.set(platformKey, d);
      for (const use of post.usage_context || []) {
        if (use.days_ago == null || use.days_ago >= repeatDays) continue;
        const samePlatform = use.platform === post.platform || use.platform === 'all';
        const blocksGlobal = campaign.repeatScope === 'global' || campaign.allowCrossPlatformRepeat === false;
        if (blocksGlobal || samePlatform) warnings.push(`${post.listing_title || key}: used on ${use.platform} ${use.days_ago}d ago`);
      }
    }
  }
  if (maxPerDay) {
    for (const [day, count] of byDay.entries()) {
      if (count > maxPerDay) warnings.push(`${day}: ${count} posts exceeds max/day ${maxPerDay}`);
    }
  }
  return { ...plan, warnings: [...(plan.warnings || []), ...warnings] };
}

function renderAutopilotPlan(plan) {
  const el = document.getElementById('autopilot-output');
  if (!el) return;
  if (!plan?.posts?.length) {
    const reasons = Array.isArray(plan?.warnings) ? plan.warnings.filter(Boolean) : [];
    el.innerHTML = `<div style="font-size:12px;color:var(--red-text);padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card)">
      <div style="font-weight:700;margin-bottom:${reasons.length ? '5px' : '0'}">No usable posts returned.</div>
      ${reasons.length ? `<div style="line-height:1.45">${reasons.map(escHtml).join(' · ')}</div>` : '<div>Try fewer days or select more platforms.</div>'}
    </div>`;
    return;
  }
  const counts = plan.posts.reduce((m, p) => { m[p.platform] = (m[p.platform] || 0) + 1; return m; }, {});
  const saved = !!plan.saved_at;
  const campaignBits = [];
  if (plan.campaign?.theme) campaignBits.push(`Theme: ${plan.campaign.theme}`);
  if (plan.campaign?.timeWindow) campaignBits.push(`Time: ${plan.campaign.timeWindow.start}-${plan.campaign.timeWindow.end}`);
  if (plan.campaign?.maxPostsPerDay) campaignBits.push(`Max/day: ${plan.campaign.maxPostsPerDay}`);
  if (plan.campaign?.repeatListingAfterDays) campaignBits.push(`Repeat listing: ${plan.campaign.repeatListingAfterDays}+ days`);
  if (plan.campaign?.repeatScope) campaignBits.push(`Repeat: ${plan.campaign.repeatScope === 'global' ? 'global' : 'per platform'}`);
  if (plan.campaign?.creativeMode) campaignBits.push(`Creative: ${plan.campaign.creativeMode.replaceAll('_', ' ')}`);
  el.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:10px;background:var(--bg-card);overflow:hidden">
      <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
        <div>
          <div style="font-weight:800;font-size:13px;margin-bottom:3px">${escHtml(plan.summary)}</div>
          <div style="font-size:11px;color:var(--text-3)">${plan.posts.length} posts · ${Object.entries(counts).map(([k,v]) => `${v} ${k}`).join(' · ')}</div>
          ${campaignBits.length ? `<div style="font-size:11px;color:var(--text-3);margin-top:3px">${campaignBits.map(escHtml).join(' · ')}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" data-autopilot-save="1" onclick="window.saveAutopilotPlan()" ${saved ? 'disabled' : ''}>${saved ? 'Saved to Calendar' : 'Save all to Calendar'}</button>
          <button class="btn btn-sm" onclick="window.clearAutopilotPlan()">Clear plan</button>
          <button class="btn btn-sm" onclick="window.navigate?.('schedule')">Open Calendar</button>
        </div>
      </div>
      ${plan.warnings?.length ? `<div style="border-bottom:1px solid var(--border);padding:9px 14px;background:var(--orange-light,#fff7ed);font-size:11px;color:var(--orange)"><strong>Check plan:</strong> ${plan.warnings.map(escHtml).join(' · ')}</div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;padding:12px">
        ${plan.posts.map((post, idx) => autopilotPostCardHtml(post, idx, saved)).join('')}
      </div>
      ${plan.notes.length ? `<div style="border-top:1px solid var(--border);padding:10px 14px;font-size:11px;color:var(--text-3)">${plan.notes.map(escHtml).join(' · ')}</div>` : ''}
    </div>`;
}

function autopilotPostCardHtml(post, idx = -1, locked = false) {
  const color = PLATFORMS.find(p => p.id === post.platform)?.color || '#666';
  const date = post.scheduled_at ? new Date(post.scheduled_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : 'Draft';
  const risk = post.risk_level === 'needs_review'
    ? `<span style="font-size:10px;color:var(--orange);font-weight:700">Review needed</span>`
    : `<span style="font-size:10px;color:var(--green-text,#2e7d32);font-weight:700">Ready draft</span>`;
  const media = post.media_items?.[0] || (post.generated_image_url ? { url: post.generated_image_url, type: 'image' } : null);
  const rawMediaUrl = normalizeMediaUrl(media?.url || '') || (String(media?.url || '').startsWith('/') ? String(media.url) : '');
  const mediaUrl = currentOriginMediaAssetUrl(rawMediaUrl);
  const mediaCandidates = [];
  const addMediaCandidate = value => {
    const url = String(value || '').trim();
    if (url && !mediaCandidates.includes(url)) mediaCandidates.push(url);
  };
  addMediaCandidate(mediaUrl);
  if (/\/api\/social\?[^#]*action=mediaAsset/i.test(mediaUrl)) {
    try {
      const retryUrl = new URL(mediaUrl, window.location.origin);
      retryUrl.searchParams.set('retry', '1');
      addMediaCandidate(retryUrl.toString());
      retryUrl.searchParams.set('_ui_media_retry', SOCIAL_MEDIA_RECOVERY_TOKEN);
      addMediaCandidate(retryUrl.toString());
    } catch { /* The validated URL remains the sole candidate. */ }
  }
  const encodedCandidates = escHtml(JSON.stringify(mediaCandidates));
  const loadScript = `const p=this.parentElement;if(p){p.dataset.mediaLoaded='1';delete p.dataset.mediaBroken;p.title=this.currentSrc||this.src;}`;
  const fallbackScript = `const p=this.parentElement;if(!p)return;const urls=JSON.parse(p.dataset.mediaCandidates||'[]');let i=parseInt(p.dataset.mediaIndex||'0',10)+1;p.dataset.mediaAttempts=String(Math.min(i,urls.length));if(i<urls.length){p.dataset.mediaIndex=String(i);this.src=urls[i];p.title='Retrying media '+(i+1)+'/'+urls.length;return;}p.dataset.mediaBroken='1';p.dataset.mediaFailedUrl=urls[0]||'';p.title='Media failed after '+urls.length+' bounded attempts';this.replaceWith(Object.assign(document.createElement('div'),{className:'social-media-missing',textContent:'Media unavailable'}));`;
  const mediaHtml = mediaUrl
    ? `<span data-media-candidates="${encodedCandidates}" data-media-index="0" style="display:flex;flex-shrink:0" title="${escHtml(mediaUrl)}">${media?.type === 'video'
      ? `<video src="${escHtml(listingVideoUrl(media) || mediaUrl)}" muted playsinline preload="metadata" style="width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0" onloadeddata="${escHtml(loadScript)}" onerror="${escHtml(fallbackScript)}"></video>`
      : `<img src="${escHtml(mediaUrl)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0" onload="${escHtml(loadScript)}" onerror="${escHtml(fallbackScript)}">`}</span>`
    : `<div class="social-media-missing">No media</div>`;
  const usageText = usageSummaryForPost(post);
  const canGenerate = !locked && idx >= 0 && post.platform !== 'tiktok' && post.generation_briefs?.length;
  return `<div style="border:1px solid var(--border);border-radius:9px;background:var(--bg-secondary);padding:10px;min-width:0">
    <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px">
      ${mediaHtml}
      <div style="min-width:0;flex:1">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:3px"><span style="background:${color};color:#fff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px">${escHtml(post.platform)}</span>${risk}${!locked && idx >= 0 ? `<button class="btn btn-sm" onclick="window.removeAutopilotPost(${idx})" style="font-size:10px;padding:1px 6px;margin-left:auto;color:var(--red-text)">Remove</button>` : ''}</div>
        <div style="font-size:11px;color:var(--text-3)">${escHtml(date)}</div>
        ${post.listing_title ? `<div style="font-size:11px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(post.listing_title)}</div>` : ''}
        <div style="font-size:10px;color:${usageText === 'Fresh listing' ? 'var(--green-text,#2e7d32)' : 'var(--orange)'};margin-top:2px">${escHtml(usageText)}</div>
        ${post.strategy_reason ? `<div style="font-size:10px;color:var(--text-3);margin-top:3px;line-height:1.35">${escHtml(post.strategy_reason)}</div>` : ''}
      </div>
    </div>
    <div style="font-size:12px;line-height:1.5;color:var(--text-2);white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden">${escHtml(post.caption)}</div>
    ${post.creative_brief ? `<div style="font-size:10px;color:var(--text-3);margin-top:7px;border-top:1px solid var(--border);padding-top:7px">Creative: ${escHtml(post.creative_brief)}</div>` : ''}
    ${canGenerate ? `<button class="btn btn-sm" onclick="window.generateAutopilotCreative(${idx})" style="margin-top:8px;font-size:11px;padding:3px 8px">${post.generated_image_url ? 'Regenerate creative' : 'Generate creative'}</button>` : ''}
  </div>`;
}

function renderAutopilotProgress({ step = 'Starting', detail = '', elapsed = 0, targetCount = 0, candidateCount = 0, active = true } = {}) {
  const out = document.getElementById('autopilot-output');
  if (!out) return;
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  const slowHint = seconds >= 20
    ? `<div style="font-size:11px;color:var(--orange);margin-top:8px">Still working. The AI call can take 20-45 seconds when creating many captions.</div>`
    : '';
  out.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:10px;background:var(--bg-card);padding:12px 14px">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:10px">
        <div>
          <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:3px">${escHtml(step)}</div>
          <div style="font-size:12px;color:var(--text-2);line-height:1.45">${escHtml(detail || 'Preparing your content calendar...')}</div>
        </div>
        <div style="font-size:11px;color:var(--text-3);white-space:nowrap">${seconds}s elapsed</div>
      </div>
      <div style="height:7px;border-radius:999px;background:var(--bg-secondary);overflow:hidden;border:1px solid var(--border)">
        <div style="height:100%;width:${active ? '62%' : '100%'};border-radius:999px;background:linear-gradient(90deg,var(--orange,#f97316),#fbbf24);${active ? 'animation:autopilotPulse 1.4s ease-in-out infinite alternate' : ''}"></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:var(--text-3)">
        <span>${targetCount || '-'} planned posts</span>
        <span>${candidateCount || '-'} listing candidates</span>
        <span>Fast mode: on</span>
      </div>
      ${slowHint}
      <style>@keyframes autopilotPulse{from{transform:translateX(-28%);opacity:.7}to{transform:translateX(72%);opacity:1}}</style>
    </div>`;
}

function renderAutopilotStream({ text = '', elapsed = 0, targetCount = 0, candidateCount = 0 } = {}) {
  const out = document.getElementById('autopilot-output');
  if (!out) return;
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  const partialPosts = extractPartialAutopilotPosts(text);
  const progressText = text.trim() ? 'Draft captions are arriving. Final cards will appear when validation finishes.' : 'Waiting for the first draft captions from Gemini...';
  if (!document.getElementById('autopilot-stream-panel')) {
    out.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:10px;background:var(--bg-card);overflow:hidden">
      <div style="padding:10px 12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <div>
          <div style="font-size:13px;font-weight:800;color:var(--text)">Autopilot is drafting your calendar</div>
          <div id="autopilot-stream-meta" style="font-size:11px;color:var(--text-3)"></div>
        </div>
        <span style="font-size:10px;font-weight:800;color:var(--orange);text-transform:uppercase;letter-spacing:.05em">Live progress</span>
      </div>
      <div id="autopilot-stream-panel" style="padding:12px;background:var(--bg-secondary)"></div>
      <div style="padding:9px 12px;border-top:1px solid var(--border);font-size:11px;color:var(--text-3)">Showing safe preview cards only. Final posts are validated before saving to Calendar.</div>
    </div>`;
  }
  const meta = document.getElementById('autopilot-stream-meta');
  if (meta) meta.textContent = `${targetCount} planned posts · ${candidateCount} listing candidates · ${seconds}s elapsed`;
  const panel = document.getElementById('autopilot-stream-panel');
  if (!panel) return;
  if (!partialPosts.length) {
    panel.innerHTML = `<div style="font-size:12px;color:var(--text-2);padding:12px;border:1px dashed var(--border);border-radius:8px;background:var(--bg-card)">${progressText}</div>`;
    return;
  }
  panel.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">${partialPosts.map(p => {
    const color = PLATFORMS.find(x => x.id === p.platform)?.color || '#666';
    return `<div style="border:1px solid var(--border);border-radius:8px;background:var(--bg-card);padding:9px">
      <div style="margin-bottom:6px"><span style="background:${color};color:#fff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px">${escHtml(p.platform)}</span></div>
      <div style="font-size:12px;line-height:1.45;color:var(--text-2);white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden">${escHtml(p.caption)}</div>
    </div>`;
  }).join('')}</div>`;
}

function startAutopilotProgress(targetCount, candidateCount) {
  const startedAt = Date.now();
  let currentStep = 'Preparing Autopilot';
  let currentDetail = `Building a compact plan request for ${targetCount} posts.`;
  const tick = () => renderAutopilotProgress({ step: currentStep, detail: currentDetail, elapsed: Date.now() - startedAt, targetCount, candidateCount });
  tick();
  const timer = setInterval(tick, 1000);
  return {
    step(step, detail) { currentStep = step; currentDetail = detail || currentDetail; tick(); },
    stop() { clearInterval(timer); },
  };
}

async function loadAutopilotShopContext() {
  const response = await fetch('/api/social', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'adminAutopilotContext' }),
  });
  const payload = await response.json();
  const context = payload?.data;
  if (!response.ok || payload?.success !== true || !context || !Array.isArray(context.listings)) {
    throw new Error(payload?.error || 'Etsy AI Command Center could not refresh the AI shop context.');
  }
  if (!context.listings.length) throw new Error('Etsy AI Command Center returned no active listings for AI planning.');
  return context;
}

async function runContentAutopilot() {
  if (!LEGACY_SOCIAL_COMPOSER_ENABLED) return blockLegacySocialComposer();
  const out = document.getElementById('autopilot-output');
  const btn = document.getElementById('auto-plan-btn');
  if (!state.allListings.length) { toastError('Listings are still loading. Try again in a moment.'); return; }
  const daysInput = clampNumberInput('auto-days', 1, 30, 14, 'Days');
  const days = daysInput.value;
  const platformPlan = getAutopilotPlatformPlan();
  const postsPerWeek = Math.max(1, Math.ceil(platformPlan.targetCount * 7 / days));
  const corrections = [daysInput.message].filter(Boolean);
  if (corrections.length) toastInfo(corrections.join(' '));
  const targetCount = Math.min(Math.max(1, platformPlan.targetCount), 30);
  if (platformPlan.targetCount > 30) { toastError('Autopilot supports up to 30 posts total. Reduce platform counts.'); return; }
  const listingPool = getAutopilotListingPool();
  const platforms = platformPlan.platforms;
  if (!platforms.length || !platformPlan.targetCount) { toastError('Choose at least one platform and set its post count above 0.'); return; }
  if (!listingPool.length) { toastError('No listings match the selected Autopilot source.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Planning...'; }
  const progress = startAutopilotProgress(targetCount, listingPool.length);
  try {
    progress.step('Refreshing shop evidence', 'Loading Etsy listings, recent sales, reviews, media, and queue history before AI planning.');
    const [scheduledPosts, postHistory, autonomousContext] = await Promise.all([
      getScheduledPosts().catch(() => []),
      getAllPostRecords().catch(() => []),
      loadAutopilotShopContext(),
    ]);
    const contextByListing = new Map((autonomousContext.listings || []).map(listing => [String(listing.listing_id), listing]));
    const missingContextListings = listingPool.filter(listing => !contextByListing.has(String(listing.listing_id)));
    if (missingContextListings.length) throw new Error(`AI shop context is incomplete for ${missingContextListings.length} selected listing(s). Refresh and try again.`);
    state.autopilotContext = autonomousContext;
    state.autopilotContextListings = listingPool.map(listing => mergeAutopilotListingFacts(listing, contextByListing.get(String(listing.listing_id))));
    const listingCandidates = selectListingsForAutopilot(state.autopilotContextListings);
    const usageIndex = buildAutopilotUsageIndex(scheduledPosts, postHistory);
    progress.step('Asking AI for captions', `Generating ${targetCount} platform-specific posts from ${listingCandidates.length} listing candidates.`);
    const campaign = getAutopilotCampaignSettings(targetCount);
    const request = {
      provider: localStorage.getItem('ai_provider') || 'external',
      _thinkingLevel: 'HIGH',
      _maxOutputTokens: 12288,
      days,
      postsPerWeek,
      targetCount,
      platforms,
      platformCounts: platformPlan.counts,
      campaign,
      tone: document.getElementById('soc-tone')?.value || 'engaging',
      approvalMode: 'save_drafts',
      listings: listingCandidates,
      reviews: autonomousContext.reviews || [],
      scheduledPosts: scheduledPosts.map(p => ({ platform: p.platform, listing_id: p.listing_id, scheduled_at: p.scheduled_at, status: p.status })),
      postHistory: postHistory.map(p => ({ platform: p.platform, listing_id: p.listing_id, postedAt: p.postedAt, published_at: p.published_at })),
      shopContext: 'Use the complete supplied shop inventory and operational history. Decide the strongest truthful opportunities semantically; do not favor a listing merely because of title keywords or local ordering. Do not invent discounts. Pinterest may be routed through Make. TikTok is draft/manual only for now.',
      shopFacts: {
        generated_at: autonomousContext.generated_at || null,
        stats: autonomousContext.stats || null,
        collection_diagnostics: autonomousContext.collection_diagnostics || {},
        collection_errors: autonomousContext.errors || [],
      },
      factualChanges: autonomousContext.factual_changes || null,
      saleContext: JSON.stringify(autonomousContext.discounts || []),
      currentResearch: {
        status: 'unavailable',
        external_research_used: false,
        reason: 'This manual Social Hub request did not run live web research.',
      },
      seasonalContext: `Current date: ${new Date().toISOString().slice(0,10)}. No live current-event research is supplied. Do not claim news or trends; use a general seasonal angle only when it is naturally supported by listing and shop facts.`,
    };
    let streamedText = '';
    const streamStartedAt = Date.now();
    for await (const evt of ai.streamAutopilot(request)) {
      if (evt.type === 'delta') {
        streamedText += evt.text || '';
        renderAutopilotStream({ text: streamedText, elapsed: Date.now() - streamStartedAt, targetCount, candidateCount: listingCandidates.length });
      } else if (evt.type === 'error') {
        throw new Error(evt.error || 'Autopilot stream failed');
      }
    }
    progress.step('Validating plan', 'Checking the streamed plan before turning it into calendar cards.');
    let planRaw;
    try {
      planRaw = parseAutopilotStreamJson(streamedText);
    } catch (parseErr) {
      progress.step('Repairing plan', 'The live stream ended before valid JSON was complete. Retrying once without streaming.');
      planRaw = await ai.planAutopilot(request);
    }
    state.autopilotPlan = validateAutopilotPlan(normalizeAutopilotPlan(planRaw, usageIndex), platformPlan.counts);
    state.autopilotPlan.campaign = request.campaign;
    state.autopilotPlan = validateAutopilotSchedule(state.autopilotPlan, request.campaign);
    saveAutopilotPlanCache(state.autopilotPlan);
    renderAutopilotPlan(state.autopilotPlan);
    toastSuccess('Autopilot plan ready. Review and save to Calendar.');
  } catch (e) {
    if (out) out.innerHTML = `<div style="font-size:12px;color:var(--red-text);padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card)">Autopilot failed: ${escHtml(e.message)}</div>`;
    toastError('Autopilot failed: ' + e.message);
  } finally {
    progress.stop();
    if (btn) { btn.disabled = false; btn.textContent = 'Fill Calendar'; }
  }
}

async function saveAutopilotPlan() {
  if (!LEGACY_SOCIAL_COMPOSER_ENABLED) return blockLegacySocialComposer();
  if (state.autopilotSaving) return;
  const plan = state.autopilotPlan;
  if (!plan?.posts?.length) { toastError('No autopilot plan to save.'); return; }
  const existingPosts = await getScheduledPosts().catch(() => []);
  const existingForPlan = existingPosts.filter(p => p.autopilot_plan_id === plan.id);
  if (plan.saved_at && existingForPlan.length >= plan.posts.length) { toastInfo('This plan is already saved to Calendar. Clear it or generate a new one first.'); return; }
  const existingKeys = new Set(existingForPlan.map(p => [p.platform, p.listing_id || '', p.scheduled_at || '', p.caption || ''].join('|')));
  state.autopilotSaving = true;
  const saveBtn = document.querySelector('button[data-autopilot-save="1"]');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = `Saving 0/${plan.posts.length}...`; }
  try {
    let saved = 0;
    for (const post of plan.posts) {
      const key = [post.platform, post.listing_id || '', post.scheduled_at || '', post.caption || ''].join('|');
      if (existingKeys.has(key)) { saved++; continue; }
      await saveScheduledPost({ ...post, id: generateId(), autopilot_plan_id: plan.id, status: 'draft', created_at: Date.now() });
      saved++;
      if (saveBtn) saveBtn.textContent = `Saving ${saved}/${plan.posts.length}...`;
    }
    state.autopilotPlan = { ...plan, saved_at: Date.now() };
    saveAutopilotPlanCache(state.autopilotPlan);
    renderAutopilotPlan(state.autopilotPlan);
    toastSuccess(`Saved ${plan.posts.length} posts to Content Calendar.`);
    const out = document.getElementById('autopilot-output');
    if (out) out.insertAdjacentHTML('afterbegin', `<div style="font-size:12px;color:var(--green-text,#2e7d32);padding:8px 10px;margin-bottom:8px;border:1px solid var(--green-border,#bbf7d0);border-radius:8px;background:var(--green-bg,#f0fdf4)">Saved to Calendar. <button class="btn btn-sm" onclick="window.navigate?.('schedule')" style="margin-left:8px">Open Calendar</button></div>`);
  } catch (e) {
    toastError('Save failed: ' + e.message);
  } finally {
    state.autopilotSaving = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save all to Calendar'; }
  }
}

window.clearAutopilotPlan = () => {
  state.autopilotPlan = null;
  clearAutopilotPlanCache();
  const out = document.getElementById('autopilot-output');
  if (out) out.innerHTML = '';
  toastSuccess('Autopilot plan cleared');
};

window.removeAutopilotPost = (idx) => {
  if (!state.autopilotPlan?.posts?.[idx]) return;
  state.autopilotPlan = { ...state.autopilotPlan, posts: state.autopilotPlan.posts.filter((_, i) => i !== idx), saved_at: null };
  state.autopilotPlan.id = autopilotPlanId(state.autopilotPlan);
  saveAutopilotPlanCache(state.autopilotPlan);
  renderAutopilotPlan(state.autopilotPlan);
  toastSuccess('Post removed from plan');
};

function orderedAutopilotMedia(items = []) {
  return items
    .map((item, index) => ({ item, index, order: Number(item?.order) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(entry => entry.item);
}

async function autopilotReferenceImage(brief = {}, listing = null) {
  const url = String(brief.reference_image_url || '').trim();
  if (!url) return null;
  if (!listing || !listingImageUrls(listing).includes(url)) {
    throw new Error('AI-selected reference image is not part of the selected Etsy listing gallery.');
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the AI-selected reference image (${response.status}).`);
  const blob = await response.blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the AI-selected reference image.'));
    reader.readAsDataURL(blob);
  });
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('AI-selected reference image could not be encoded.');
  return { mimeType: match[1], base64: match[2] };
}

window.generateAutopilotCreative = async (idx) => {
  if (!LEGACY_SOCIAL_COMPOSER_ENABLED) return blockLegacySocialComposer();
  const post = state.autopilotPlan?.posts?.[idx];
  if (!post) return;
  const briefs = post.generation_briefs || [];
  if (!briefs.length) { toastError('AI did not request generated frames for this post.'); return; }
  if (briefs.length > 10) { toastError('AI requested more than the supported 10 media frames. Regenerate the plan.'); return; }
  const plannedMedia = [...(post.media_items || []).filter(item => item?.autopilot_generated !== true), ...briefs];
  const plannedOrders = plannedMedia.map(item => Number(item?.order));
  if (plannedOrders.some(order => !Number.isInteger(order) || order < 1) || new Set(plannedOrders).size !== plannedOrders.length) {
    toastError('AI media plan is missing explicit frame order. Regenerate the plan.');
    return;
  }
  const btns = [...document.querySelectorAll('button')].filter(b => b.getAttribute('onclick') === `window.generateAutopilotCreative(${idx})`);
  btns.forEach(b => { b.disabled = true; b.textContent = `Generating 0/${briefs.length}...`; });
  try {
    const listing = autopilotListingById(post.listing_id);
    if (!listing) throw new Error('Selected Etsy listing is no longer available in the refreshed AI context.');
    let complete = 0;
    const generatedFrames = await Promise.all(briefs.map(async (brief, briefIndex) => {
      const referenceImage = await autopilotReferenceImage(brief, listing);
      if (brief.reference_required === true && !referenceImage) throw new Error(`Frame ${briefIndex + 1} requires an exact reference image, but no reference URL was supplied.`);
      const res = await fetch('/api/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'adminGenerateMedia',
          prompt: String(brief.prompt || '').trim(),
          aspect_ratio: brief.aspect_ratio,
          count: 1,
          image_model_tier: 'standard',
          reference_image: referenceImage,
          reference_policy: brief.reference_policy || '',
          quality_context: {
            platform: post.platform,
            listing_id: post.listing_id,
            listing_title: post.listing_title,
            frame_role: brief.role || '',
            strategy_reason: post.strategy_reason || '',
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `Frame ${briefIndex + 1} generation failed`);
      const img = data.data?.images?.[0];
      if (!img?.url || img.permanent !== true) throw new Error(`Frame ${briefIndex + 1} returned no persistent media asset`);
      complete += 1;
      btns.forEach(b => { b.textContent = `Generating ${complete}/${briefs.length}...`; });
      return {
        ...img,
        order: Number(brief.order),
        role: brief.role,
        brief_id: brief.id,
        autopilot_generated: true,
      };
    }));
    const retainedMedia = (post.media_items || []).filter(item => item?.autopilot_generated !== true);
    const mediaItems = orderedAutopilotMedia([...retainedMedia, ...generatedFrames]);
    const updated = { ...post, generated_image_url: generatedFrames[0]?.url || '', media_items: mediaItems };
    state.autopilotPlan = { ...state.autopilotPlan, posts: state.autopilotPlan.posts.map((p, i) => i === idx ? updated : p), saved_at: null };
    state.autopilotPlan.id = autopilotPlanId(state.autopilotPlan);
    saveAutopilotPlanCache(state.autopilotPlan);
    renderAutopilotPlan(state.autopilotPlan);
    toastSuccess(`${generatedFrames.length} AI-planned creative frame(s) generated and attached.`);
  } catch (e) {
    toastError('Creative generation failed: ' + e.message);
    btns.forEach(b => { b.disabled = false; b.textContent = post.generated_image_url ? 'Regenerate creative' : 'Generate creative'; });
  }
};

async function selectListing(id) {
  if (!id) { state.selectedListing = null; refreshListingList(); return; }
  // Toggle off if clicking the already-selected listing
  if (state.selectedListing && String(state.selectedListing.listing_id) === String(id)) {
    state.selectedListing = null;
    refreshListingList();
    const preview = document.getElementById('listing-preview');
    const images = document.getElementById('listing-images');
    if (preview) preview.innerHTML = '';
    if (images) images.innerHTML = '';
    renderPlatformCards();
    return;
  }
  state.selectedListing = state.listings.find(l => String(l.listing_id) === String(id)) || null;
  refreshListingList();

  // Restore draft posts for this listing if available
  const draft = await loadDraft(id);
  if (draft) {
    state.posts = { pinterest: '', instagram: '', facebook: '', tiktok: '', ...draft };
    toastInfo('Draft restored from last session');
  } else {
    state.posts = { pinterest: '', instagram: '', facebook: '', tiktok: '' };
  }

  const preview = document.getElementById('listing-preview');
  if (!preview || !state.selectedListing) return;
  const l = state.selectedListing;

  // Revoke previous custom media object URLs to avoid memory leaks
  for (const m of state.customMedia) URL.revokeObjectURL(m.url);
  state.customMedia = [];

  // Init image selection from listing images. Instagram supports carousels,
  // so prefer the full listing image set instead of only the title image.
  const images = l.images || [];
  const listingUrls = listingImageUrls(l);
  const mainUrl = listingUrls[0] || l.MainImage?.url_570xN || images[0]?.url_570xN || '';
  state.selectedImages = {
    pinterest: mainUrl,
    instagram: listingUrls.length ? listingUrls.slice(0, 10) : (mainUrl ? [mainUrl] : []),
    facebook: mainUrl,
    tiktok: mainUrl,
  };

  preview.innerHTML = `
    <div class="row" style="gap:8px;margin-top:8px;padding-top:10px;border-top:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:500;line-height:1.4">${escHtml(truncate(l.title, 55))}</div>
        <div class="text-sm text-muted">$${((l.price?.amount || 0) / (l.price?.divisor || 100)).toFixed(2)} · ${number(l.views || 0)} views</div>
        <a href="https://www.etsy.com/listing/${l.listing_id}" target="_blank" class="text-sm" style="color:var(--orange)">View on Etsy ↗</a>
      </div>
    </div>`;

  renderImageGallery();
  renderPlatformCards();
}

function renderImageGallery() {
  const el = document.getElementById('listing-images');
  if (!el) return;
  const l = state.selectedListing;
  const images = l?.images || [];
  const igCount = state.selectedImages.instagram.length;

  const listingImagesHtml = images.length ? `
    <div style="font-size:11px;font-weight:600;margin-bottom:6px;color:var(--text-2)">
      Post images
      <span style="font-weight:400;color:var(--text-3)"> — click to select · Ctrl+click for Instagram carousel</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px">
      ${images.map(img => {
        const full = img.url_570xN || img.url_170x135 || '';
        const thumb = img.url_170x135 || full;
        const isMain = state.selectedImages.pinterest === full;
        const inCarousel = state.selectedImages.instagram.includes(full);
        const carouselIdx = state.selectedImages.instagram.indexOf(full);
        return `<div style="position:relative;cursor:pointer" onclick="window.__socialPickImage('${escJsSingle(full)}',event)" title="${isMain ? 'Selected for all' : 'Click to select · Ctrl+Click to add to Instagram carousel'}">
          <img src="${escHtml(thumb)}" style="width:48px;height:48px;object-fit:cover;border-radius:5px;border:2px solid ${isMain ? 'var(--orange)' : inCarousel ? '#C13584' : 'var(--border)'}">
          ${isMain ? `<span style="position:absolute;bottom:1px;right:1px;background:var(--orange);color:#fff;border-radius:3px;font-size:8px;padding:0 3px;line-height:14px">✓</span>` : ''}
          ${inCarousel && !isMain ? `<span style="position:absolute;bottom:1px;right:1px;background:#C13584;color:#fff;border-radius:3px;font-size:8px;padding:0 3px;line-height:14px">${carouselIdx + 1}</span>` : ''}
        </div>`;
      }).join('')}
    </div>
    ${igCount > 1 ? `<div style="font-size:11px;color:#C13584;margin-bottom:6px">📷 Instagram carousel: ${igCount} images selected</div>` : ''}
  ` : '';

  const customMediaHtml = `
    <div style="${images.length ? 'margin-top:8px;padding-top:8px;border-top:1px solid var(--border)' : ''}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:11px;font-weight:600;color:var(--text-2)">Custom media</span>
        <label style="cursor:pointer;font-size:11px;color:var(--orange);font-weight:500">
          + Upload
          <input type="file" id="custom-media-input" accept="image/*,video/*" multiple style="display:none">
        </label>
      </div>
      ${state.customMedia.length ? `
        <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:5px">
          ${state.customMedia.map(m => {
            const isSelected = [state.selectedImages.pinterest, state.selectedImages.facebook, state.selectedImages.tiktok, ...state.selectedImages.instagram].includes(m.url);
            const border = isSelected ? 'var(--orange)' : 'var(--border)';
            const thumb = m.type === 'video'
              ? `<div style="width:48px;height:48px;border-radius:5px;border:2px solid ${border};background:var(--bg-secondary);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px">
                  <span style="font-size:18px;line-height:1">🎬</span>
                  <span style="font-size:7px;color:var(--text-3);max-width:42px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escHtml(m.name)}</span>
                </div>`
              : `<img src="${escHtml(m.url)}" style="width:48px;height:48px;object-fit:cover;border-radius:5px;border:2px solid ${border}">`;
            const hint = m.type === 'video' ? 'Video — all platforms' : 'Image — Instagram, Facebook, Pinterest (not TikTok)';
            return `<div style="position:relative;cursor:pointer" onclick="window.__socialPickCustom('${m.id}',event)" title="${escHtml(m.name)}\n${hint}">
              ${thumb}
              <button onclick="event.stopPropagation();window.__socialRemoveCustom('${m.id}')" style="position:absolute;top:-5px;right:-5px;width:15px;height:15px;background:#ef4444;color:#fff;border:none;border-radius:50%;font-size:10px;cursor:pointer;line-height:15px;text-align:center;padding:0">×</button>
              ${isSelected ? `<span style="position:absolute;bottom:1px;right:1px;background:var(--orange);color:#fff;border-radius:3px;font-size:8px;padding:0 3px;line-height:14px">✓</span>` : ''}
            </div>`;
          }).join('')}
        </div>
        <div style="font-size:10px;color:var(--text-3)">📷 Images → Instagram, Facebook, Pinterest &nbsp;·&nbsp; 🎬 Video → all platforms incl. TikTok</div>
      ` : `<div style="font-size:11px;color:var(--text-3)">Upload your own images or videos to attach to posts</div>`}
    </div>`;

  if (!images.length && !state.customMedia.length && !state.selectedListing) { el.innerHTML = ''; return; }

  el.innerHTML = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">${listingImagesHtml}${customMediaHtml}</div>`;

  // File upload handler
  const fileInput = document.getElementById('custom-media-input');
  if (fileInput) {
    fileInput.onchange = () => {
      for (const file of fileInput.files) {
        const type = file.type.startsWith('video/') ? 'video' : 'image';
        const url = URL.createObjectURL(file);
        const id = 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        state.customMedia.push({ id, url, type, name: file.name });
      }
      fileInput.value = '';
      renderImageGallery();
      renderPlatformCards();
    };
  }

  window.__socialPickImage = (url, event) => {
    if (event?.ctrlKey || event?.metaKey) {
      const idx = state.selectedImages.instagram.indexOf(url);
      if (idx > -1) state.selectedImages.instagram.splice(idx, 1);
      else if (state.selectedImages.instagram.length < 10) state.selectedImages.instagram.push(url);
    } else {
      const isMain = state.selectedImages.pinterest === url;
      if (isMain) {
        state.selectedImages.pinterest = '';
        state.selectedImages.facebook = '';
        state.selectedImages.tiktok = '';
        if (state.selectedImages.instagram[0] === url) state.selectedImages.instagram.shift();
      } else {
        state.selectedImages.pinterest = url;
        state.selectedImages.facebook = url;
        state.selectedImages.tiktok = url;
        if (!state.selectedImages.instagram.includes(url)) state.selectedImages.instagram.unshift(url);
        else state.selectedImages.instagram = [url, ...state.selectedImages.instagram.filter(u => u !== url)];
      }
    }
    renderImageGallery();
    renderPlatformCards();
  };

  window.__socialPickCustom = (id, event) => {
    const m = state.customMedia.find(x => x.id === id);
    if (!m) return;
    for (const p of PLATFORMS) {
      if (!PLATFORM_MEDIA[p.id][m.type]) continue;
      if (p.id === 'instagram') {
        if (event?.ctrlKey || event?.metaKey) {
          const idx = state.selectedImages.instagram.indexOf(m.url);
          if (idx > -1) state.selectedImages.instagram.splice(idx, 1);
          else if (state.selectedImages.instagram.length < 10) state.selectedImages.instagram.push(m.url);
        } else {
          state.selectedImages.instagram = [m.url];
        }
      } else {
        state.selectedImages[p.id] = state.selectedImages[p.id] === m.url ? '' : m.url;
      }
    }
    renderImageGallery();
    renderPlatformCards();
  };

  window.__socialRemoveCustom = (id) => {
    const m = state.customMedia.find(x => x.id === id);
    if (!m) return;
    URL.revokeObjectURL(m.url);
    state.customMedia = state.customMedia.filter(x => x.id !== id);
    for (const p of PLATFORMS) {
      if (state.selectedImages[p.id] === m.url) state.selectedImages[p.id] = '';
    }
    state.selectedImages.instagram = state.selectedImages.instagram.filter(u => u !== m.url);
    renderImageGallery();
    renderPlatformCards();
  };
}

function getAccountLabel(platformId) {
  const ok = 'display:inline-flex;align-items:center;gap:3px;font-size:10px;color:#22c55e;font-weight:500';
  const na = 'font-size:10px;color:var(--text-3)';

  if (platformId === 'instagram') {
    const ig = socialConfigs.ig_config;
    if (ig?.ig_username) {
      const avatar = ig.ig_picture
        ? `<img src="${escHtml(ig.ig_picture)}" style="width:14px;height:14px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : '';
      return `<span style="${ok}">${avatar}@${escHtml(ig.ig_username)}</span>`;
    }
    if (configStatus.hasInstagram) return `<span style="${ok}">✓ Connected</span>`;
    return `<span style="${na}">Not connected</span>`;
  }

  if (platformId === 'facebook') {
    const page = state.facebookPages[0];
    if (page?.name) return `<span style="${ok}">✓ ${escHtml(page.name)}</span>`;
    if (configStatus.hasFacebook) return `<span style="${ok}">✓ Connected</span>`;
    return `<span style="${na}">Not connected</span>`;
  }

  if (platformId === 'pinterest') {
    if (configStatus.hasPinterest) return `<span style="${ok}">✓ Connected</span>`;
    return `<span style="${na}">Not connected</span>`;
  }

  if (platformId === 'tiktok') {
    return `<span style="${na}">Copy caption only</span>`;
  }

  return '';
}

function renderPlatformCards() {
  const el = document.getElementById('platform-cards');
  if (!el) return;

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr;gap:12px">
      ${PLATFORMS.map(p => {
    const post = state.posts[p.id] || '';
    const status = state.publishStatus[p.id];
    const len = post.length;
    const over = len > p.limit;

    // Platform-specific extra fields
    let extraField = '';
    if (p.id === 'pinterest' && state.pinterestBoards.length) {
      extraField = `<select id="board-select" style="width:100%;font-size:12px;margin-bottom:6px" onchange="window.__setSocialBoard?.(this.value)">
            <option value="">Select board...</option>
            ${state.pinterestBoards.map(b => `<option value="${b.id}" ${state.selectedBoard === b.id ? 'selected' : ''}>${escHtml(b.name)}</option>`).join('')}
          </select>`;
    }
    if (p.id === 'facebook' && state.facebookPages.length) {
      extraField = `<select id="page-select" style="width:100%;font-size:12px;margin-bottom:6px" onchange="window.__setSocialPage?.(this.value)">
            <option value="">Select page...</option>
            ${state.facebookPages.map(pg => `<option value="${pg.id}" ${state.selectedPage === pg.id ? 'selected' : ''}>${escHtml(pg.name)}</option>`).join('')}
          </select>`;
    }

    const imgUrl = p.id === 'instagram'
      ? state.selectedImages.instagram[0] || ''
      : state.selectedImages[p.id] || '';
    const igCarousel = p.id === 'instagram' && state.selectedImages.instagram.length > 1;
    const isPreviewing = state.previewPlatform === p.id;
    const isVideo = !!state.customMedia.find(m => m.type === 'video' && (
      p.id === 'instagram' ? state.selectedImages.instagram.includes(m.url) : state.selectedImages[p.id] === m.url
    ));

    // TikTok note — context-aware: video ready or hint to upload
    const tiktokNote = p.id === 'tiktok' ? (isVideo ? `
      <div style="background:var(--bg-hover);border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:11px;color:var(--text-2)">
        🎬 Video ready for TikTok
      </div>` : `
      <div style="background:var(--bg-hover);border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:11px;line-height:1.6">
        <div style="font-weight:600;margin-bottom:3px">📹 TikTok requires video</div>
        <div style="color:var(--text-2)">Upload a video in the <strong>Custom media</strong> section, or use caption below in CapCut / Canva:</div>
        ${state.selectedImages.instagram.length ? `<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
          ${state.selectedImages.instagram.slice(0, 4).map(u => `<a href="${escHtml(u)}" target="_blank"><img src="${escHtml(u)}" style="width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid var(--border)"></a>`).join('')}
          <a href="https://www.canva.com" target="_blank" class="btn btn-sm" style="font-size:10px">Canva →</a>
          <a href="https://www.capcut.com" target="_blank" class="btn btn-sm" style="font-size:10px">CapCut →</a>
        </div>` : ''}
      </div>`) : '';

    // Post preview panel — uses <video> for video media
    const previewPanel = isPreviewing && post ? (() => {
      const aspectRatio = p.id === 'tiktok' || p.id === 'instagram' ? '4/5' : '16/9';
      const previewMedia = !imgUrl ? '' : isVideo
        ? `<video src="${escHtml(imgUrl)}" style="width:100%;aspect-ratio:${aspectRatio};object-fit:cover;border-radius:6px 6px 0 0" muted playsinline controls></video>`
        : `<img src="${escHtml(imgUrl)}" style="width:100%;aspect-ratio:${aspectRatio};object-fit:cover;border-radius:6px 6px 0 0">`;
      const previewText = escHtml(post.slice(0, 200)) + (post.length > 200 ? '…' : '');
      return `<div style="border:1px solid var(--border);border-radius:6px;margin-bottom:8px;overflow:hidden;font-size:11px">
        ${previewMedia}
        <div style="padding:8px;background:var(--bg-secondary)">
          <div style="font-weight:600;font-size:10px;color:var(--text-3);margin-bottom:3px;text-transform:uppercase">${p.name} preview</div>
          <div style="line-height:1.5;color:var(--text-2);white-space:pre-wrap">${previewText}</div>
          ${igCarousel ? `<div style="margin-top:4px;color:#C13584;font-size:10px">📷 ${state.selectedImages.instagram.length} images (carousel)</div>` : ''}
        </div>
      </div>`;
    })() : '';

    const accountLabel = getAccountLabel(p.id);
    const publishUrl = state.publishUrls?.[p.id];

    return `
          <div class="platform-card">
            <div class="platform-header">
              <span class="platform-name" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span class="platform-icon pi-${p.id}" style="background:${p.color}">${p.name[0]}</span>
                ${p.name}
                ${igCarousel ? `<span style="font-size:10px;color:#C13584">📷 ×${state.selectedImages.instagram.length}</span>` : ''}
                ${accountLabel}
              </span>
              <div class="row" style="gap:4px;flex-shrink:0;flex-wrap:wrap">
                ${publishUrl ? `<a href="${escHtml(publishUrl)}" target="_blank" rel="noopener" class="badge badge-green" style="font-size:10px;text-decoration:none">View ↗</a>` : ''}
                ${status ? `<span class="badge ${status === 'published' ? 'badge-green' : status === 'error' ? 'badge-red' : 'badge-gray'}" style="font-size:10px">${escHtml(historyStatusLabel(status))}</span>` : ''}
                <button class="btn btn-sm" onclick="window.togglePostPreview('${p.id}')" title="Preview" style="${isPreviewing ? 'color:var(--orange)' : ''}">👁</button>
                <button class="btn btn-sm btn-primary" data-gen-btn="${p.id}" onclick="window.generateOnePlatform('${p.id}')" title="Generate post for ${p.name}" style="padding:4px 8px;font-size:11px">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
                  Generate
                </button>
              </div>
            </div>

            ${imgUrl ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
              ${isVideo
                ? `<div style="width:32px;height:32px;border-radius:4px;border:1px solid var(--border);background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:18px">🎬</div>`
                : `<img src="${escHtml(imgUrl)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;border:1px solid var(--border)">`}
              <span style="font-size:11px;color:var(--text-3)">${igCarousel ? `📷 ${state.selectedImages.instagram.length} images (carousel)` : isVideo ? '🎬 Custom video' : 'Selected image'}</span>
            </div>` : ''}

            ${tiktokNote}
            ${previewPanel}

            ${extraField}

            <div style="position:relative">
              <textarea id="soc-${p.id}" rows="5" style="font-size:12px;margin-bottom:8px;width:100%;box-sizing:border-box;padding-right:36px"
                oninput="window.updateSocPost('${p.id}', this.value)"
                placeholder="Generate a post or type manually...">${escHtml(post)}</textarea>
              <button onclick="window.copyPost('soc-${p.id}')" title="Copy text"
                style="position:absolute;top:5px;right:22px;background:none;border:none;cursor:pointer;padding:3px;border-radius:4px;color:var(--text-3);line-height:1;transition:color .15s,background .15s"
                onmouseenter="this.style.color='var(--text-1)';this.style.background='var(--bg-secondary)'"
                onmouseleave="this.style.color='var(--text-3)';this.style.background='none'">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
            </div>

            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap">
              <span style="font-size:10px;font-weight:600;color:var(--text-3);letter-spacing:.03em">🎬 VIDEO</span>
              <button class="btn btn-sm" id="vid-text-btn-${p.id}"
                onclick="window.socialGenVideo('${p.id}','text')" style="font-size:11px" title="Generate video from caption text">Text → Video</button>
              ${imgUrl && !isVideo ? `<button class="btn btn-sm" id="vid-anim-btn-${p.id}"
                onclick="window.socialGenVideo('${p.id}','animate')" style="font-size:11px" title="Animate selected image with Meta AI">Animate image</button>` : ''}
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
              <span class="text-sm ${over ? 'char-count over' : 'text-muted'}">${len}/${p.limit}</span>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <div id="sched-${p.id}" style="display:none;align-items:center;gap:4px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:4px 8px">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style="color:var(--text-3);flex-shrink:0"><rect x="1" y="2" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 1v2M11 1v2M1 6h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                  <input type="date" id="sched-date-${p.id}"
                    style="font-size:11px;padding:2px 4px;width:112px;background:transparent;border:none;outline:none;color:var(--text);font-family:inherit"
                    min="${new Date().toISOString().slice(0, 10)}">
                  <span style="color:var(--text-3);font-size:11px">at</span>
                  <input type="time" id="sched-time-${p.id}"
                    style="font-size:11px;padding:2px 4px;width:68px;background:transparent;border:none;outline:none;color:var(--text);font-family:inherit">
                </div>
                <button class="btn btn-sm" id="sched-toggle-${p.id}"
                  onclick="window.toggleSchedule('${p.id}')" title="Schedule post" style="font-size:11px">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v3.5l2 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                  Schedule
                </button>
                <button class="btn btn-sm" id="draft-${p.id}"
                  onclick="window.saveDraftPost('${p.id}')" title="Save as draft to Schedule page" style="font-size:11px">
                  📅 Draft
                </button>
                <button class="btn btn-sm ${p.id !== 'tiktok' ? 'btn-primary' : ''}"
                  id="pub-btn-${p.id}"
                  onclick="window.publishToPlatform('${p.id}')"
                  ${status === 'publishing' ? 'disabled' : ''}>
                  ${status === 'publishing' ? '<div class="spinner" style="width:10px;height:10px;border-width:1.5px;display:inline-block;vertical-align:middle;margin-right:4px"></div>Publishing…' : p.id === 'tiktok' ? 'Copy & open TikTok ↗' : 'Publish'}
                </button>
                <div style="position:relative;display:inline-block">
                  <button class="btn btn-sm" id="xpost-toggle-${p.id}"
                    onclick="window.toggleXpost('${p.id}')" title="Send via crosspost service" style="padding:4px 8px;font-size:11px">Via ▾</button>
                  <div id="xpost-menu-${p.id}" style="display:none;position:absolute;right:0;top:100%;margin-top:2px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.1);z-index:100;min-width:130px;overflow:hidden">
                    ${configStatus.hasBuffer
                      ? `<button class="btn" onclick="window.sendPlatformTo('${p.id}','buffer')" style="display:block;width:100%;text-align:left;padding:7px 12px;font-size:11px;border-radius:0;border:none">Buffer</button>`
                      : `<div style="padding:7px 12px;font-size:11px;color:var(--text-3)">Buffer <a href="#" onclick="window.navigate('settings');return false" style="color:var(--orange);font-size:10px">Setup →</a></div>`}
                    ${p.id === 'pinterest' ? (configStatus.hasMake
                      ? `<button class="btn" onclick="window.sendPlatformTo('${p.id}','make')" style="display:block;width:100%;text-align:left;padding:7px 12px;font-size:11px;border-radius:0;border:none">Make.com Pinterest</button>`
                      : `<div style="padding:7px 12px;font-size:11px;color:var(--text-3)">Make.com Pinterest <a href="#" onclick="window.navigate('settings');return false" style="color:var(--orange);font-size:10px">Setup →</a></div>`)
                      : `<div style="padding:7px 12px;font-size:11px;color:var(--text-3)">Make.com is Pinterest-only</div>`}
                    ${configStatus.hasZapier
                      ? `<button class="btn" onclick="window.sendPlatformTo('${p.id}','zapier')" style="display:block;width:100%;text-align:left;padding:7px 12px;font-size:11px;border-radius:0;border:none">Zapier</button>`
                      : `<div style="padding:7px 12px;font-size:11px;color:var(--text-3)">Zapier <a href="#" onclick="window.navigate('settings');return false" style="color:var(--orange);font-size:10px">Setup →</a></div>`}
                  </div>
                </div>
              </div>
            </div>
          </div>`;
  }).join('')}
    </div>

    <div class="card" style="margin-top:12px;padding:10px 16px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span style="font-size:12px;font-weight:600;color:var(--text-2)">Publish all platforms at once</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-primary btn-sm" onclick="window.publishAll()" title="Instagram/Facebook through Etsy AI Command Center settings; Pinterest through Make.com if configured">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2v9M4 7l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Publish Meta + Pinterest
          </button>
          <button class="btn btn-sm" onclick="window.sendToCrosspost('buffer')" title="Optional fallback; not the default for Instagram/Facebook">Buffer fallback</button>
          <button class="btn btn-sm" onclick="window.sendToCrosspost('make')" title="Pinterest bridge only">Make Pinterest</button>
          <button class="btn btn-sm" onclick="window.sendToCrosspost('zapier')" title="Optional fallback">Zapier fallback</button>
        </div>
      </div>
    </div>`;

  if (!LEGACY_SOCIAL_COMPOSER_ENABLED) {
    el.querySelectorAll('[data-gen-btn], [id^="vid-text-btn-"], [id^="vid-anim-btn-"], [id^="pub-btn-"], [id^="xpost-toggle-"]')
      .forEach(node => node.remove());
    el.querySelector('[onclick="window.publishAll()"]')?.closest('.card')?.remove();
  }

  window.updateSocPost = (platform, value) => { state.posts[platform] = value; };
  window.__setSocialBoard = (value) => { state.selectedBoard = value || ''; };
  window.__setSocialPage = (value) => { state.selectedPage = value || ''; };
  window.togglePostPreview = (platformId) => {
    state.previewPlatform = state.previewPlatform === platformId ? null : platformId;
    renderPlatformCards();
    // Restore textarea content after re-render
    for (const p of PLATFORMS) {
      const ta = document.getElementById(`soc-${p.id}`);
      if (ta && state.posts[p.id]) ta.value = state.posts[p.id];
    }
  };
  window.toggleSchedule = (platformId) => {
    const wrap = document.getElementById(`sched-${platformId}`);
    const btn = document.getElementById(`sched-toggle-${platformId}`);
    const pubBtn = document.getElementById(`pub-btn-${platformId}`);
    if (!wrap) return;
    const isVisible = wrap.style.display === 'flex';
    if (!isVisible) {
      // Fill defaults: today's date, current time + 1h
      const now = new Date(Date.now() + 3600000);
      const dateEl = document.getElementById(`sched-date-${platformId}`);
      const timeEl = document.getElementById(`sched-time-${platformId}`);
      if (dateEl && !dateEl.value) dateEl.value = localDateValue(now);
      if (timeEl && !timeEl.value) timeEl.value = now.toTimeString().slice(0, 5);
    }
    wrap.style.display = isVisible ? 'none' : 'flex';
    if (btn) btn.style.color = isVisible ? '' : 'var(--orange)';
    if (pubBtn && platformId !== 'tiktok') pubBtn.textContent = isVisible ? 'Publish' : 'Add to schedule';
  };
  let _publishingAll = false;
  window.publishAll = async () => {
    if (!LEGACY_SOCIAL_COMPOSER_ENABLED) return blockLegacySocialComposer();
    if (_publishingAll) return;
    _publishingAll = true;
    const btn = document.querySelector('[onclick="window.publishAll()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
    try {
      for (const p of PLATFORMS.filter(p => p.id !== 'tiktok')) {
        await publishToPlatform(p.id, { forceDirect: true });
      }
    } finally {
      _publishingAll = false;
      if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2v9M4 7l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Publish Meta + Pinterest`; }
    }
  };

  // Per-platform crosspost dropdown
  window.toggleXpost = (platformId) => {
    const menu = document.getElementById(`xpost-menu-${platformId}`);
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    // Close all menus first
    document.querySelectorAll('[id^="xpost-menu-"]').forEach(m => { m.style.display = 'none'; });
    if (!isOpen) {
      menu.style.display = 'block';
      setTimeout(() => document.addEventListener('click', function h(e) {
        if (!menu.contains(e.target)) { menu.style.display = 'none'; document.removeEventListener('click', h); }
      }), 50);
    }
  };

  window.sendPlatformTo = async (platformId, serviceId) => {
    if (!LEGACY_SOCIAL_COMPOSER_ENABLED) return blockLegacySocialComposer();
    const menu = document.getElementById(`xpost-menu-${platformId}`);
    if (menu) menu.style.display = 'none';
    if (!state.selectedListing) { toastError('Select a listing first'); return; }
    if (serviceId === 'make' && platformId !== 'pinterest') {
      toastError('Make.com is configured as the Pinterest bridge only. Use Etsy AI Command Center social settings for Instagram/Facebook.');
      return;
    }
    const l = state.selectedListing;
    const caption = document.getElementById(`soc-${platformId}`)?.value || state.posts[platformId] || '';
    if (!caption.trim()) { toastError('No caption — generate or write content first'); return; }
    const media = selectedMediaForPlatform(platformId, l);
    const schedWrap = document.getElementById(`sched-${platformId}`);
    const schedDate = document.getElementById(`sched-date-${platformId}`)?.value;
    const schedTime = document.getElementById(`sched-time-${platformId}`)?.value || '09:00';
    const scheduleAt = (schedWrap?.style?.display === 'flex' && schedDate) ? `${schedDate}T${schedTime}` : null;
    const payload = {
      platform: platformId,
      text: caption,
      imageUrl: media.imageUrl,
      imageUrls: media.imageUrls,
      media_items: media.mediaItems,
      link: `https://www.etsy.com/listing/${l.listing_id}`,
      title: l.title,
      scheduleAt,
    };
    try {
      const actionMap = {
        buffer: () => social.sendToBuffer(payload),
        make: () => social.sendToMake(payload),
        zapier: () => social.sendToZapier(payload),
      };
      const result = await actionMap[serviceId]();
      const status = normalizePublishHistoryStatus(result);
      state.history.unshift({
        platform: platformId,
        service: serviceId,
        listing: truncate(l.title, 40),
        date: formatHistoryDate(Date.now()),
        _postedAt: Date.now(),
        status,
        post_url: result?.post_url || null,
        result,
      });
      renderHistory();
      toastSuccess(status === 'published' ? `Published ${platformId} via ${serviceId}!` : `Queued ${platformId} via ${serviceId}. Waiting for publish confirmation.`);
    } catch (e) {
      state.history.unshift({ platform: platformId, service: serviceId, listing: truncate(l.title, 40), date: formatHistoryDate(Date.now()), _postedAt: Date.now(), status: 'failed', post_url: null, error: e.message });
      renderHistory();
      toastError(`${serviceId} error: ${e.message}`);
    }
  };

  // Meta AI video generation for Social Hub
  window.socialGenVideo = async (platformId, mode) => {
    if (!LEGACY_SOCIAL_COMPOSER_ENABLED) return blockLegacySocialComposer();
    const caption = document.getElementById(`soc-${platformId}`)?.value || state.posts[platformId] || '';
    const textBtn = document.getElementById(`vid-text-btn-${platformId}`);
    const animBtn = document.getElementById(`vid-anim-btn-${platformId}`);
    const setLoading = (on) => {
      if (textBtn) { textBtn.disabled = on; if (on && mode === 'text') textBtn.textContent = '⏳ Generating…'; else textBtn.textContent = 'Text → Video'; }
      if (animBtn) { animBtn.disabled = on; if (on && mode === 'animate') animBtn.textContent = '⏳ Animating…'; else animBtn.textContent = 'Animate image'; }
    };
    setLoading(true);
    toastInfo(mode === 'animate' ? 'Animating image with Meta AI… (~30–60s)' : 'Generating video with Meta AI… (~30–60s)');
    try {
      let result;
      if (mode === 'animate') {
        const imgSrc = Array.isArray(state.selectedImages[platformId])
          ? state.selectedImages[platformId][0]
          : state.selectedImages[platformId];
        if (!imgSrc) throw new Error('No image selected for this platform');
        // Send imageUrl to server — server fetches it (avoids CORS on Etsy CDN)
        result = await fetch('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'animateImage', imageUrl: imgSrc, prompt: caption.slice(0, 200) }),
        }).then(r => r.json());
      } else {
        result = await fetch('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'generateVideo', prompt: caption.slice(0, 300) || 'product showcase video' }),
        }).then(r => r.json());
      }
      if (result.error) throw new Error(result.error);
      const { base64, mimeType } = result.video;
      const videoBlob = await fetch(`data:${mimeType};base64,${base64}`).then(r => r.blob());
      const url = URL.createObjectURL(videoBlob);
      const id = 'vid_' + Date.now().toString(36);
      state.customMedia.push({ id, url, type: 'video', name: `${platformId}-video.mp4` });
      // Auto-select for this platform
      if (platformId === 'instagram') state.selectedImages.instagram = [url];
      state.selectedImages[platformId] = url;
      renderImageGallery();
      renderPlatformCards();
      toastSuccess('Video generated — selected and ready to use!');
    } catch (e) {
      toastError('Video generation failed: ' + e.message);
    } finally {
      setLoading(false);
    }
  };
  window.saveDraftPost = async (platformId) => {
    const caption = state.posts[platformId];
    if (!caption?.trim()) { toastError('No caption to save'); return; }
    const btn = document.getElementById(`draft-${platformId}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const media = selectedMediaForPlatform(platformId);
      await saveScheduledPost({
        id: generateId(),
        caption,
        platform: platformId,
        listing_id: state.selectedListing?.listing_id || null,
        listing_title: state.selectedListing?.title || null,
        listing_image_url: media.imageUrl || null,
        media_items: media.mediaItems,
        video_url: media.mediaItems.find(m => m.type === 'video')?.url || null,
        status: 'draft',
        created_at: Date.now(),
      });
      if (btn) { btn.disabled = false; btn.textContent = '✓ Saved'; setTimeout(() => { if (btn) btn.textContent = '📅 Draft'; }, 2500); }
      toastSuccess('Saved as draft — <button style="background:none;border:none;color:inherit;cursor:pointer;text-decoration:underline;padding:0;font-size:inherit" onclick="window.navigate?.(\'schedule\')">View in Schedule →</button>');
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '📅 Draft'; }
      toastError('Save failed: ' + e.message);
    }
  };
}

async function generateAllPosts() {
  if (!LEGACY_SOCIAL_COMPOSER_ENABLED) return blockLegacySocialComposer();
  if (!state.selectedListing) { toastError('Select a listing first'); return; }
  const btn = document.getElementById('gen-social-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Generating...'; }
  state.generating = true;

  const l = state.selectedListing;
  const provider = document.querySelector('input[name="soc-provider"]:checked')?.value || 'claude';
  const tone = document.getElementById('soc-tone')?.value || 'engaging';

  try {
    const raw = await ai.generateSocial({
      title: l.title,
      price: ((l.price?.amount || 0) / (l.price?.divisor || 100)).toFixed(2),
      url: `https://www.etsy.com/listing/${l.listing_id}`,
      productType: l.listing_type === 'download' ? 'digital download' : 'service',
      tone,
      provider,
    });

    // Robustly extract the posts object — AI sometimes returns a string if JSON breaks
    let result = raw;
    if (typeof raw === 'string') {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        result = match ? JSON.parse(match[0]) : {};
      } catch { result = {}; }
    }
    if (typeof result !== 'object' || result === null) result = {};

    const { pinterest, instagram, facebook, tiktok } = result;
    if (pinterest) state.posts.pinterest = pinterest;
    if (instagram) state.posts.instagram = instagram;
    if (facebook) state.posts.facebook = facebook;
    if (tiktok) state.posts.tiktok = tiktok;

    renderPlatformCards();
    // Save draft to localStorage so posts survive navigation
    saveDraft(l.listing_id, state.posts);
    toastSuccess('Posts generated!');
  } catch (e) {
    toastError('Generation failed: ' + e.message);
  }

  state.generating = false;
  if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg> Generate all platforms`; }
}

async function generateOnePlatform(platformId) {
  if (!LEGACY_SOCIAL_COMPOSER_ENABLED) return blockLegacySocialComposer();
  if (!state.selectedListing) { toastError('Select a listing first'); return; }
  if (state.generatingPlatforms.has(platformId)) return;
  state.generatingPlatforms.add(platformId);

  const btn = document.querySelector(`[data-gen-btn="${platformId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  const l = state.selectedListing;
  const provider = document.querySelector('input[name="soc-provider"]:checked')?.value || 'gemini';
  const tone = document.getElementById('soc-tone')?.value || 'engaging';

  try {
    const result = await ai.generateSocial({ title: l.title, price: ((l.price?.amount || 0) / (l.price?.divisor || 100)).toFixed(2), url: `https://www.etsy.com/listing/${l.listing_id}`, productType: l.listing_type, tone, provider });
    if (result[platformId]) {
      state.posts[platformId] = result[platformId];
      const ta = document.getElementById(`soc-${platformId}`);
      if (ta) ta.value = result[platformId];
    }
  } catch (e) { toastError(e.message); }

  state.generatingPlatforms.delete(platformId);
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg> Generate`;
  }
}

async function publishToPlatform(platformId, opts = {}) {
  if (!LEGACY_SOCIAL_COMPOSER_ENABLED) return blockLegacySocialComposer();
  const post = document.getElementById(`soc-${platformId}`)?.value || state.posts[platformId];
  if (!post?.trim()) { toastError(`No content for ${platformId}`); return; }
  if (!state.selectedListing) { toastError('No listing selected'); return; }

  // TikTok — copy caption and open TikTok
  if (platformId === 'tiktok') {
    await navigator.clipboard.writeText(post);
    window.open('https://www.tiktok.com/upload', '_blank', 'noopener');
    toastSuccess('Caption copied — TikTok upload page opened');
    return;
  }

  const l = state.selectedListing;
  // Use selected image for this platform, fallback to listing main image
  const media = selectedMediaForPlatform(platformId, l);
  const img = media.imageUrl;
  const igImages = platformId === 'instagram' ? media.imageUrls : [];
  const url = `https://www.etsy.com/listing/${l.listing_id}`;

  const schedWrap = document.getElementById(`sched-${platformId}`);
  const schedDate = document.getElementById(`sched-date-${platformId}`)?.value;
  const schedTime = document.getElementById(`sched-time-${platformId}`)?.value || '09:00';
  const scheduleAt = (!opts.forceDirect && schedWrap?.style?.display === 'flex' && schedDate) ? `${schedDate}T${schedTime}` : null;

  // Scheduled post -> route through the configured publishing service.
  if (scheduleAt) {
    await saveScheduledPost({
      id: generateId(),
      caption: post,
      platform: platformId,
      listing_id: l.listing_id || null,
      listing_title: l.title || null,
      listing_image_url: img || null,
      custom_image_url: img || null,
      media_items: media.mediaItems,
      scheduled_at: new Date(scheduleAt).toISOString(),
      status: 'draft',
      created_at: Date.now(),
    });
    toastSuccess('Added to Content Schedule. Autopilot publisher will send it when due.');
    return;
  }

  state.publishStatus[platformId] = 'publishing';
  renderPlatformCards();
  document.getElementById(`soc-${platformId}`)?.setAttribute('value', post);

  try {
    const actionMap = {
      // Pinterest: Make.com bridge (direct Pinterest API is not reliable/available for this shop)
      pinterest: () => social.sendToMake({
        platform: 'pinterest',
        title: truncate(l.title, 100),
        text: post,
        link: url,
        imageUrl: img,
        imageUrls: media.imageUrls,
        media_items: media.mediaItems,
        listing_id: l.listing_id || null,
      }),
      // Instagram: token from KV-synced socialConfigs (falls back to server environment)
      instagram: () => {
        const igCfg = socialConfigs.ig_config || null;
        const igAuth = igCfg ? { token: igCfg.token, userId: igCfg.ig_id } : {};
        return igImages.length > 1
          ? social.postInstagramCarousel({ caption: post, imageUrls: igImages, ...igAuth })
          : social.postInstagram({ caption: post, imageUrl: img, ...igAuth });
      },
      facebook: () => {
        const fbCfg = socialConfigs.fb_posts_config || null;
        return social.postFacebook({
          text: post,
          link: url,
          imageUrl: img,
          pageId: state.selectedPage || document.getElementById('page-select')?.value || fbCfg?.page_id || '',
          ...(fbCfg?.token ? { token: fbCfg.token } : {}),
        });
      },
    };

    const result = await actionMap[platformId]();
    const serviceName = platformId === 'pinterest' ? 'make' : 'direct';
    const status = normalizePublishHistoryStatus(result);
    state.publishStatus[platformId] = status;

    // Derive a link to the published post where possible
    let post_url = null;
    if (result?.pin_id) post_url = `https://www.pinterest.com/pin/${result.pin_id}/`;
    else if (result?.post_id) post_url = `https://www.facebook.com/${result.post_id}`;
    else if (result?.post_url) post_url = result.post_url;
    // Instagram media URLs are not directly constructable from media_id without username
    if (post_url) state.publishUrls[platformId] = post_url;

    state.history.unshift({ platform: platformId, service: serviceName, listing: truncate(l.title, 40), date: formatHistoryDate(Date.now()), _postedAt: Date.now(), status, post_url, result });
    renderHistory();
    toastSuccess(status === 'published'
      ? `Published to ${platformId}!${post_url ? ` <a href="${post_url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">View →</a>` : ''}`
      : `Queued ${platformId} via Make.com. Waiting for publish confirmation.`);
  } catch (e) {
    state.publishStatus[platformId] = 'error';
    const serviceName = platformId === 'pinterest' ? 'make' : 'direct';
    state.history.unshift({ platform: platformId, service: serviceName, listing: truncate(l.title, 40), date: formatHistoryDate(Date.now()), _postedAt: Date.now(), status: 'failed', post_url: null, error: e.message });
    const isTokenErr = platformId === 'instagram' && /session has expired|access token|OAuthException/i.test(e.message);
    if (isTokenErr) {
      toastError('Instagram token expired — <a href="#" onclick="window.navigate(\'settings\')" style="color:inherit;text-decoration:underline">reconnect in Settings</a>');
    } else {
      toastError(`${platformId} error: ${e.message}`);
    }
  }
  renderPlatformCards();
  // Restore textarea value after re-render
  const ta = document.getElementById(`soc-${platformId}`);
  if (ta) ta.value = post;
}

async function sendToCrosspost(serviceId) {
  if (!LEGACY_SOCIAL_COMPOSER_ENABLED) return blockLegacySocialComposer();
  if (!state.selectedListing) { toastError('Select a listing first'); return; }
  const l = state.selectedListing;
  const pinterestMedia = selectedMediaForPlatform('pinterest', l);
  const instagramMedia = selectedMediaForPlatform('instagram', l);
  const facebookMedia = selectedMediaForPlatform('facebook', l);
  const img = instagramMedia.imageUrl || pinterestMedia.imageUrl || facebookMedia.imageUrl || listingImageUrl(l);

  const payload = {
    listingId: l.listing_id,
    title: l.title,
    price: ((l.price?.amount || 0) / (l.price?.divisor || 100)).toFixed(2),
    url: `https://www.etsy.com/listing/${l.listing_id}`,
    imageUrl: img,
    imageUrls: [...new Set([...pinterestMedia.imageUrls, ...instagramMedia.imageUrls, ...facebookMedia.imageUrls])],
    media_items: [...pinterestMedia.mediaItems, ...instagramMedia.mediaItems, ...facebookMedia.mediaItems],
    platform_media: {
      pinterest: pinterestMedia,
      instagram: instagramMedia,
      facebook: facebookMedia,
    },
    pinterest: document.getElementById('soc-pinterest')?.value || state.posts.pinterest,
    instagram: document.getElementById('soc-instagram')?.value || state.posts.instagram,
    facebook: document.getElementById('soc-facebook')?.value || state.posts.facebook,
    tiktok: document.getElementById('soc-tiktok')?.value || state.posts.tiktok,
    text: document.getElementById('soc-instagram')?.value || state.posts.instagram,
  };
  if (serviceId === 'make') {
    payload.platform = 'pinterest';
    payload.text = payload.pinterest;
    payload.imageUrl = pinterestMedia.imageUrl;
    payload.imageUrls = pinterestMedia.imageUrls;
    payload.media_items = pinterestMedia.mediaItems;
  }

  const btn = document.getElementById(`xpost-${serviceId}`);
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const schedEl = document.getElementById(`sched-${serviceId}`);
    const scheduleAt = (schedEl?.style?.display !== 'none' && schedEl?.value) ? schedEl.value : null;
    const actionMap = {
      buffer: () => social.sendToBuffer(payload),
      metricool: () => social.sendToMetricool({ ...payload, networks: ['instagram', 'facebook', 'pinterest'] }),
      make: () => social.sendToMake(payload),
      zapier: () => social.sendToZapier(payload),
    };
    const result = await actionMap[serviceId]();
    // Record each platform as queued unless the service returned a real publish confirmation.
    const platformsToRecord = serviceId === 'make' ? ['pinterest'] : ['pinterest', 'instagram', 'facebook', 'tiktok'];
    for (const p of platformsToRecord) {
      if (!payload[p]) continue;
      const status = normalizePublishHistoryStatus(result);
      const item = { platform: p, service: serviceId, listing: truncate(l.title, 40), date: formatHistoryDate(Date.now()), _postedAt: Date.now(), status, post_url: result?.post_url || null, result };
      state.history.unshift(item);
    }
    renderHistory();
    toastSuccess(result?.published === true ? `Published via ${serviceId}!` : `Queued via ${serviceId}. Waiting for publish confirmation.`);
  } catch (e) {
    const platformsToRecord = serviceId === 'make' ? ['pinterest'] : ['pinterest', 'instagram', 'facebook', 'tiktok'];
    for (const p of platformsToRecord) {
      if (!payload[p]) continue;
      const item = { platform: p, service: serviceId, listing: truncate(l.title, 40), date: formatHistoryDate(Date.now()), _postedAt: Date.now(), status: 'failed', post_url: null, error: e.message };
      state.history.unshift(item);
    }
    renderHistory();
    toastError(`${serviceId} error: ${e.message}`);
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Send all'; }
}

function formatHistoryDate(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderHistory() {
  const el = document.getElementById('post-history');
  if (!el) return;
  const presentation = socialHistoryPresentation(state.history, {
    platform: state.historyPlatform,
    status: state.historyStatus,
    sort: state.historySort,
    page: state.historyPage,
    pageSize: state.historyPageSize,
    platforms: PLATFORMS,
    formatDate: formatHistoryDate,
  });
  state.historyPage = presentation.currentPage;
  el.innerHTML = presentation.html;
}
