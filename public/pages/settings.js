// public/pages/settings.js — tabbed settings with Etsy, AI & Images, Social, Crosspost, Context, Prefs

import { etsy, etsyGuidance, social, kv, fetchJsonWithTimeout, readJsonResponse, userFacingErrorMessage } from '../utils/api.js';
import { toastSuccess, toastError, toastInfo } from '../components/toast.js';
import { getShopContext, clearShopContext, buildContextPrompt } from '../utils/shop-context.js';
import { kvPost } from '../utils/kv-client.js';
import { DEFAULT_MODELS } from '../utils/models.js';
import { saveImage } from '../utils/image-store.js';
import { etsyGuidanceStatusPresentation } from '../utils/settings-view-model.js';

// ── KV write-through helpers (KV primary + localStorage cache) ───────────────
async function _kvSaveSocialCfg(key, cfg) {
  if (cfg) localStorage.setItem(key, JSON.stringify(cfg));
  else localStorage.removeItem(key);
  try { await kv.setSocialConfig(key, cfg || null); } catch (e) {
    console.warn('[KV] setSocialConfig failed:', e?.message);
  }
}
async function _kvDeleteSocialCfg(key) {
  localStorage.removeItem(key);
  try { await kv.deleteSocialConfig(key); } catch {}
}
// Pull KV state into localStorage on tab open (background refresh for multi-user sync)
async function _kvRefreshSocialCfgs() {
  try {
    const data = await kv.getSocialConfigs();
    if (!data) return;
    for (const k of ['pinterest_config','fb_posts_config','ig_config','tiktok_config','fb_shop_config','make_config']) {
      if (data[k]) localStorage.setItem(k, JSON.stringify(data[k]));
      else localStorage.removeItem(k);
    }
  } catch {}
}
async function _kvRefreshPersonalizationPrefs() {
  try {
    const data = await kv.getPersonalizationPrefs();
    if (!data) return;
    localStorage.setItem('etsy_personalization_prefs', JSON.stringify(data));
    // Update visible form fields if tab is open
    const fields = { 's-order-email': data.email, 's-personal-template': data.template, 's-delivery-method': data.delivery, 's-turnaround-min': data.turnaroundMin, 's-turnaround-max': data.turnaroundMax, 's-turnaround-unit': data.turnaroundUnit, 's-order-webhook': data.orderWebhook, 's-auto-reply': data.autoReply };
    for (const [id, val] of Object.entries(fields)) {
      const el = document.getElementById(id);
      if (el && val !== undefined) el.value = val;
    }
  } catch {}
}

export async function renderSettings(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Settings</div>
        <div class="page-subtitle">Credentials, AI, integrations, shop context</div>
      </div>
    </div>
    <div class="page-body settings-layout">
      <div class="card" style="padding:8px;position:sticky;top:20px">
        ${['Etsy API', 'AI & Images', 'Personalization', 'Social', 'Cross-posting', 'Shop Context', 'Preferences'].map((t, i) =>
    `<button class="btn stab" id="stab-${i}" data-idx="${i}"
            style="width:100%;text-align:left;padding:8px 12px;border:none;background:${i === 0 ? 'var(--orange-light)' : 'transparent'};color:${i === 0 ? 'var(--orange)' : 'var(--text-2)'};font-weight:${i === 0 ? '600' : '400'};border-radius:var(--radius);font-size:13px;margin-bottom:1px"
            onclick="window.switchSettingsTab(${i})">${t}</button>`).join('')}
      </div>
      <div id="settings-tab-content"></div>
    </div>`;

  const tabs = [
    renderEtsyTab, renderAITab, renderPersonalizationTab, renderSocialTab,
    renderCrosspostTab, renderContextTab, renderPrefsTab,
  ];

  window.switchSettingsTab = (idx) => {
    document.querySelectorAll('.stab').forEach((btn, i) => {
      const on = i === idx;
      btn.style.background = on ? 'var(--orange-light)' : 'transparent';
      btn.style.color = on ? 'var(--orange)' : 'var(--text-2)';
      btn.style.fontWeight = on ? '600' : '400';
      if (on) btn.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    document.getElementById('settings-tab-content').innerHTML = tabs[idx]();
    attachHandlers(idx);
  };

  window.switchSettingsTab(0);
}

// ── Tab renderers ─────────────────────────────────────────

function renderEtsyTab() {
  return `
    <div class="card mb-12">
      <div class="settings-group-title">Etsy API credentials</div>
      <div class="alert alert-info mb-12" style="font-size:12px">
        Set your own credentials in the <strong>server environment</strong> (typically a private <code>.env</code> file).
        Restart the application after changing environment variables. Etsy OAuth also needs persistent KV storage.
      </div>
      <div class="field"><label>API Key (keystring)</label>
        <input type="text" id="s-apikey" placeholder="ETSY_API_KEY"></div>
      <div class="field"><label>Access Token</label>
        <div class="row"><input type="text" id="s-token" placeholder="ETSY_ACCESS_TOKEN" style="flex:1">
          <span class="token-timer" id="token-timer">—</span></div>
      </div>
      <div class="field"><label>Refresh Token</label>
        <input type="text" id="s-refresh" placeholder="ETSY_REFRESH_TOKEN"></div>
      <div class="field"><label>Client Secret <span class="badge badge-orange" style="font-size:9px">Required Feb 2026+</span></label>
        <input type="text" id="s-secret" placeholder="ETSY_CLIENT_SECRET"></div>
      <div class="field"><label>Shop ID</label>
        <input type="text" id="s-shopid" placeholder="12345678" style="width:160px"></div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="window.testEtsy()">Test connection</button>
        <button class="btn" onclick="window.connectEtsyOAuth()">Connect Etsy</button>
        <button class="btn" onclick="window.saveEtsyTokens()">Save tokens</button>
        <span class="text-sm text-muted">Refresh token is optional but required for auto-refresh</span>
        <span id="etsy-test-result" class="text-sm text-muted"></span>
      </div>
      <div id="etsy-connection-status" class="alert alert-info" style="font-size:12px;margin-top:12px">
        Checking Etsy connection...
      </div>
    </div>`;
}

function renderAITab() {
  return `
    <div class="card mb-12">
      <div class="settings-group-title">Claude (Anthropic)</div>
      <div class="field" style="display:none"><label>API Key</label>
        <div class="row"><input type="text" id="s-claude-key" placeholder="ANTHROPIC_API_KEY" style="flex:1">
          <button class="btn btn-sm" onclick="window.testClaude()">Test</button></div>
      </div>
      <div class="field" style="display:none"><label>Default model</label>
        <input type="text" id="s-claude-model" list="claude-model-options" value="${DEFAULT_MODELS.claude}" placeholder="${DEFAULT_MODELS.claude}" onchange="window.saveAIModelPref('claude', this.value.trim())" style="width:min(100%,360px);height:38px;box-sizing:border-box">
        <datalist id="claude-model-options">
          <option value="${DEFAULT_MODELS.claude}">${DEFAULT_MODELS.claude} (default)</option>
          <option value="claude-3-5-sonnet-latest">claude-3-5-sonnet-latest (best)</option>
          <option value="claude-3-5-haiku-latest">claude-3-5-haiku-latest (fast)</option>
          <option value="claude-3-opus-latest">claude-3-opus-latest</option>
        </datalist>
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">Editable Anthropic model ID. Update it manually when Anthropic releases a newer model; model discovery is not guaranteed by the API.</div>
      </div>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">Google Gemini + Nano Banana 2</div>
      <div class="alert alert-info mb-12" style="font-size:12px">
        One API key covers both Gemini (text) and Nano Banana 2 (image generation).
        Get it at <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color:var(--orange)">aistudio.google.com ↗</a>
      </div>
      <div class="field"><label>Google AI Studio API Key</label>
        <div class="row"><input type="text" id="s-gemini-key" placeholder="GEMINI_API_KEY" style="flex:1">
          <button class="btn btn-sm" onclick="window.testGemini()">Test Gemini</button>
          <button class="btn btn-sm" onclick="window.testNanoBanana()">Test Nano Banana</button>
        </div>
      </div>
      <div class="field"><label>Gemini model</label>
        <select id="s-gemini-model" style="width:auto" onchange="window.saveAIModelPref('gemini', this.value)">
          <option value="${DEFAULT_MODELS.gemini}">${DEFAULT_MODELS.gemini} (default)</option>
          <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
          <option value="gemini-pro-latest">gemini-pro-latest (best quality, paid)</option>
        </select>
      </div>

      <div class="field">
        <label>Image model</label>
        <div style="font-size:12px;color:var(--text-2);padding:6px 0">Nano Banana 2 — <code style="background:var(--bg-hover);padding:1px 5px;border-radius:3px;font-size:11px">gemini-3.1-flash-image-preview</code></div>
      </div>
      <div class="card" style="background:var(--bg-secondary);margin-top:10px">
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">Quick Nano Banana test</div>
        <div class="row" style="gap:6px">
          <input type="text" id="nb-test-prompt" placeholder="a white mug on marble table, product photography" style="flex:1;font-size:12px">
          <button class="btn btn-sm btn-primary" onclick="window.quickNBTest()">Generate</button>
        </div>
        <div id="nb-test-result" style="margin-top:10px"></div>
      </div>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">Nano Banana 2 — Parallel API keys</div>
      <div class="alert alert-info mb-12" style="font-size:12px">
        Add extra Gemini keys to generate images in parallel. Each key runs its own concurrent worker — 3 keys = 3× speed for batch generation. Primary key is set via <strong>GEMINI_API_KEY</strong> env var.
      </div>
      <div id="extra-keys-list" style="margin-bottom:8px;display:flex;flex-direction:column;gap:4px"></div>
      <div class="row" style="gap:8px">
        <input type="text" id="new-gemini-key" placeholder="AIza… (extra key)" style="flex:1;font-size:12px">
        <button class="btn btn-sm btn-primary" onclick="window.addGeminiKey()">+ Add key</button>
      </div>
      <div id="gemini-keys-status" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">Default AI Providers</div>
      <div class="alert alert-info mb-12" style="font-size:12px">
        Used for new listing generation, Autopilot, and generated images. The Agent page has its own model selector.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="field" style="margin:0"><label>Text generation</label>
          <select id="default-text-provider">
            <option value="external">External AI</option>
            <option value="gemini">Gemini</option>
            <option value="claude">Claude</option>
          </select>
        </div>
        <div class="field" style="margin:0"><label>Image generation</label>
          <select id="default-image-provider">
            <option value="external">Image provider</option>
            <option value="gemini">Gemini image provider</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">External AI Provider</div>
      <div class="alert alert-info mb-12" style="font-size:12px">
        Supports configured OpenAI-compatible providers. Agent Auto uses this saved project text model whenever External AI is ready. Keep API keys server-side only.
      </div>
      <div class="field"><label>Base URL</label><input type="text" id="external-base-url" placeholder="https://your-provider.example/v1"></div>
      <div class="field"><label>API key</label><input type="password" id="external-api-key" placeholder="Leave blank to keep saved key"></div>
      <div class="field"><label>Image base URL override</label><input type="text" id="external-image-base-url" placeholder="Optional dedicated image adapter, e.g. http://127.0.0.1:20130/v1"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="field"><label>Text path</label><input type="text" id="external-text-path" placeholder="/v1/chat/completions"></div>
        <div class="field"><label>Codex image path</label><input type="text" id="external-image-path" value="/v1/responses" readonly></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px">
        <div class="field"><label>Project text model</label><input type="text" id="external-text-model" list="external-text-model-options" value="${DEFAULT_MODELS.external}" placeholder="${DEFAULT_MODELS.external}"></div>
        <div class="field"><label>Vision model</label><input type="text" id="external-vision-model" list="external-text-model-options" placeholder="Uses text model when empty"></div>
        <div class="field"><label>Image model</label><input type="text" id="external-image-model" list="external-image-model-options" value="${DEFAULT_MODELS.externalImage}" placeholder="${DEFAULT_MODELS.externalImage}"></div>
      </div>
      <datalist id="external-text-model-options">

      </datalist>
      <datalist id="external-image-model-options"></datalist>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="field"><label>Image response format</label><input type="text" id="external-image-response-format" value="base64_json" readonly></div>
        <div class="field"><label>Image timeout (ms, max 120000)</label><input type="number" id="external-image-timeout-ms" min="5000" max="120000" value="120000"></div>
      </div>
      <div class="field"><label>Codex image adapter</label><input type="text" id="external-image-adapter" value="openai_responses" readonly></div>
      <div class="field"><label>Reference image support</label><input type="text" id="external-image-reference-mode" value="provider_native" readonly></div>
      <div class="field"><label>Method</label><select id="external-method"><option value="openai">openai compatible</option></select></div>
      <div class="row" style="gap:8px">
        <button class="btn btn-sm btn-primary" onclick="window.saveExternalAIConfig()">Save External Provider</button>
        <button class="btn btn-sm" onclick="window.loadProviderStatus()">Refresh Status</button>
        <button class="btn btn-sm" id="test-external-text-btn" onclick="window.testExternalAI()">Test External Text</button>
        <button class="btn btn-sm" id="test-external-image-btn" onclick="window.testExternalImageAI()">Test External Image</button>
      </div>
      <div id="external-ai-status" style="font-size:12px;color:var(--text-2);margin-top:8px"></div>
      <div id="external-ai-test-result" style="display:none;font-size:12px;line-height:1.5;margin-top:8px;padding:9px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)"></div>
      <div id="image-provider-status" style="font-size:12px;color:var(--text-2);margin-top:4px"></div>
      <div id="ai-provider-status-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-top:10px"></div>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">Meta AI — video generation (Emu)</div>
      <div class="alert alert-info mb-12" style="font-size:12px">
        Meta AI generates short videos from images ("Animate") or text prompts. Two cookies required — <strong>ecto_1_sess</strong> expires frequently and needs refreshing.
        <br><br>
        <strong>How to get cookies:</strong> Open <a href="https://www.meta.ai" target="_blank" style="color:var(--orange)">meta.ai ↗</a> while logged in → DevTools (F12) → Network → open any meta.ai request → Request Headers → copy the full <code style="background:var(--bg-hover);padding:1px 4px;border-radius:3px">Cookie</code> header.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <div class="field" style="margin:0">
          <label>ecto_1_sess <span style="color:var(--red-text);font-size:10px">expires often</span></label>
          <input type="text" id="meta-cookie-ecto" placeholder="paste ecto_1_sess value" style="font-size:11px;font-family:monospace">
        </div>
        <div class="field" style="margin:0">
          <label>rd_challenge</label>
          <input type="text" id="meta-cookie-rd" placeholder="paste rd_challenge value" style="font-size:11px;font-family:monospace">
        </div>
      </div>
      <div class="field" style="margin-bottom:8px">
        <label>Full Cookie header <span style="color:var(--text-3);font-size:10px">recommended, keeps all Meta session cookies</span></label>
        <textarea id="meta-cookie-raw" rows="2" placeholder="ecto_1_sess=...; rd_challenge=...; datr=...; ..." style="font-size:11px;font-family:monospace"></textarea>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-sm btn-primary" id="meta-save-btn" onclick="window.saveMetaCookies()">Save cookies</button>
        <button class="btn btn-sm" id="meta-test-btn" onclick="window.testMetaCookies()">Test connection</button>
        <span id="meta-cookies-status" style="font-size:12px;color:var(--text-2)"></span>
      </div>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">AI behaviour</div>
      <div class="field">
        <div class="row"><label style="margin:0">Auto-fallback to other provider on error</label>
          <div class="toggle-wrap" style="margin-left:auto"><div class="toggle on" id="toggle-fallback" onclick="this.classList.toggle('on')"></div></div>
        </div>
        <div class="text-sm text-muted" style="margin-top:4px">If Claude fails, tries Gemini automatically (and vice versa)</div>
      </div>
      <div class="field">
        <div class="row"><label style="margin:0">Inject shop context into every listing generation</label>
          <div class="toggle-wrap" style="margin-left:auto"><div class="toggle on" id="toggle-context" onclick="this.classList.toggle('on')"></div></div>
        </div>
        <div class="text-sm text-muted" style="margin-top:4px">Analyses existing listings to keep descriptions/personalization consistent</div>
      </div>
    </div>

    <div class="card mb-12">
      <div class="row-between" style="gap:12px;align-items:flex-start">
        <div>
          <div class="settings-group-title">Etsy listing standards</div>
          <div class="text-sm text-muted">Versioned guidance from allowlisted official Etsy sources. New revisions require approval before the agent can use them.</div>
        </div>
        <button class="btn btn-sm" id="etsy-guidance-refresh" onclick="window.refreshEtsyGuidance()">Check now</button>
      </div>
      <div id="etsy-guidance-status" style="margin-top:12px">
        <div class="text-sm text-muted">Loading standards status...</div>
      </div>
    </div>`;
}

function renderEtsyGuidanceStatus(data) {
  const root = document.getElementById('etsy-guidance-status');
  if (!root) return;
  window.__etsyGuidanceStatus = data || null;
  root.innerHTML = etsyGuidanceStatusPresentation(data, { escapeHtml: escHtml }).markup;
}

function renderPersonalizationTab() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('etsy_personalization_prefs') || '{}'); } catch { return {}; } })();
  return `
    <div class="card mb-12">
      <div class="settings-group-title">Personalization defaults</div>
      <div class="alert alert-info mb-12" style="font-size:12px">
        These defaults are injected into every AI listing generation so your personalization copy is always consistent. AI will adapt them to each product type.
      </div>

      <div class="field">
        <label>Your order email</label>
        <input type="email" id="s-order-email" placeholder="owner@example.com" value="${saved.email || ''}">
        <div class="text-sm text-muted" style="margin-top:4px">Used in personalization instructions: "Please send info to [email]"</div>
      </div>

      <div class="field">
        <label>Default personalization instructions template</label>
        <textarea id="s-personal-template" rows="5" placeholder="After purchase, please send the following info to [your email]:&#10;1. Name(s) / text to add&#10;2. Photo (if applicable) — attach to Etsy message or email&#10;3. Any special requests&#10;&#10;Your order will be delivered within 1-2 business days via email.">${saved.template || ''}</textarea>
        <div class="text-sm text-muted" style="margin-top:4px">AI uses this as the base — adapts it to the specific product</div>
      </div>

      <div class="field">
        <label>Delivery method</label>
        <select id="s-delivery-method" style="width:auto">
          <option value="email" ${(saved.delivery || 'email') === 'email' ? 'selected' : ''}>Email (attach files to email)</option>
          <option value="etsy_message" ${saved.delivery === 'etsy_message' ? 'selected' : ''}>Etsy message (in-app delivery)</option>
          <option value="both" ${saved.delivery === 'both' ? 'selected' : ''}>Both email + Etsy message</option>
          <option value="google_drive" ${saved.delivery === 'google_drive' ? 'selected' : ''}>Google Drive link</option>
        </select>
      </div>

      <div class="field">
        <label>Typical turnaround time</label>
        <div class="row" style="gap:8px;align-items:center">
          <input type="number" id="s-turnaround-min" min="1" placeholder="1" value="${saved.turnaroundMin || 1}" style="width:70px">
          <span style="color:var(--text-3);font-size:13px">to</span>
          <input type="number" id="s-turnaround-max" min="1" placeholder="3" value="${saved.turnaroundMax || 3}" style="width:70px">
          <select id="s-turnaround-unit" style="width:auto">
            <option value="hours" ${saved.turnaroundUnit === 'hours' ? 'selected' : ''}>hours</option>
            <option value="business days" ${(saved.turnaroundUnit || 'business days') === 'business days' ? 'selected' : ''}>business days</option>
            <option value="days" ${saved.turnaroundUnit === 'days' ? 'selected' : ''}>days</option>
          </select>
        </div>
      </div>

      <button class="btn btn-primary" onclick="window.savePersonalizationPrefs()">Save preferences</button>
      <span id="s-personal-saved" style="font-size:12px;color:var(--green-text);margin-left:8px;display:none">✓ Saved</span>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">Email automation (Zapier / Make)</div>
      <div class="alert alert-info mb-12" style="font-size:12px">
        Automate order notifications and personalization request emails. When a customer buys and sends personalization info, these webhooks fire automatically.
      </div>
      <div class="field">
        <label>New order webhook (fires when Etsy order received)</label>
        <div class="row">
          <input type="text" id="s-order-webhook" placeholder="https://hooks.zapier.com/... or https://hook.eu1.make.com/..." style="flex:1" value="${saved.orderWebhook || ''}">
          <button class="btn btn-sm" onclick="window.testPersonalizationWebhook('order')">Test</button>
        </div>
        <div class="text-sm text-muted" style="margin-top:4px">Payload: order ID, buyer name, items, personalization instructions</div>
      </div>
      <div class="field">
        <label>Auto-reply template (sent via Etsy message after order)</label>
        <textarea id="s-auto-reply" rows="3" placeholder="Hi [name]! Thank you for your order 🎉 Please send [what you need] and I'll have your [product] ready within [time]!">${saved.autoReply || ''}</textarea>
      </div>
      <button class="btn btn-primary" onclick="window.savePersonalizationPrefs()">Save</button>
    </div>

    <div class="card">
      <div class="settings-group-title">AI personalization context</div>
      <div class="text-sm text-muted mb-8">Preview of what AI receives for every new listing generation:</div>
      <div id="personal-preview" style="background:var(--bg-secondary);border-radius:var(--radius);padding:12px;font-size:12px;font-family:monospace;color:var(--text-2);white-space:pre-wrap;min-height:60px">Click "Save preferences" to preview</div>
    </div>`;
}

function renderSocialTab() {
  return renderPinterestCard() + renderInstagramCard() + renderFbPostsCard() + renderTikTokCard() + renderFacebookShopCard();
}

function _socialCard({ id, icon, title, color, status, statusColor, inputId, inputPh, connectFn, disconnectFn, note, hint, extraFields = '' }) {
  return `
  <div class="card mb-12">
    <div class="row-between mb-12">
      <span style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px">
        <span style="width:22px;height:22px;border-radius:4px;background:${color};color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center">${icon}</span>
        ${title}
      </span>
      <span id="${id}-status" style="font-size:12px;color:${statusColor}">${status}</span>
    </div>
    ${note ? `<div style="background:var(--bg-secondary);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text-2);margin-bottom:10px">${note}</div>` : ''}
    <div class="field">
      <label>Access Token</label>
      <div class="row" style="gap:6px">
        <input type="text" id="${inputId}" placeholder="${inputPh}" style="flex:1;font-family:monospace;font-size:12px">
        <button class="btn btn-sm btn-primary" id="${id}-connect-btn" onclick="window.${connectFn}()">Connect</button>
      </div>
    </div>
    ${extraFields}
    <div id="${id}-connected-ui" style="display:none"></div>
    ${hint ? `<div style="font-size:11px;color:var(--text-3);margin-top:8px;line-height:1.6">${hint}</div>` : ''}
  </div>`;
}

function getPinConfig()    { try { return JSON.parse(localStorage.getItem('pinterest_config') || 'null'); } catch { return null; } }
function getFbPostsConfig() { try { return JSON.parse(localStorage.getItem('fb_posts_config') || 'null'); } catch { return null; } }
function getTikTokConfig()  { try { return JSON.parse(localStorage.getItem('tiktok_config') || 'null'); } catch { return null; } }
function getMakeConfig()    { try { return JSON.parse(localStorage.getItem('make_config') || 'null'); } catch { return null; } }

function renderPinterestCard() {
  const cfg = getPinConfig();
  return _socialCard({
    id: 'pinterest', icon: 'P', title: 'Pinterest', color: '#E60023',
    status: cfg ? `✓ Connected` : 'Not connected',
    statusColor: cfg ? 'var(--green-text,#2e7d32)' : 'var(--text-3)',
    inputId: 'pin-token-input', inputPh: 'Paste Pinterest Access Token',
    connectFn: 'connectPinterest', disconnectFn: 'disconnectPinterest',
    extraFields: `<div class="field"><label>Default Board ID <span style="font-weight:400;color:var(--text-3)">(optional)</span></label><input type="text" id="pin-board-input" placeholder="Leave blank to pick per-post" value="${cfg?.board_id || ''}"></div>`,
    hint: 'Get token: <a href="https://developers.pinterest.com/tools/oauth-token/" target="_blank" style="color:var(--orange)">Pinterest Token Generator</a>',
  });
}

function renderFbPostsCard() {
  const cfg = getFbPostsConfig();
  return _socialCard({
    id: 'fb-posts', icon: 'f', title: 'Facebook (posts)', color: '#1877F2',
    status: cfg ? `✓ ${cfg.page_name || 'Connected'}` : 'Not connected',
    statusColor: cfg ? 'var(--green-text,#2e7d32)' : 'var(--text-3)',
    inputId: 'fb-posts-token-input', inputPh: 'Paste Facebook User Token',
    connectFn: 'connectFbPosts', disconnectFn: 'disconnectFbPosts',
    hint: '<a href="https://developers.facebook.com/tools/explorer/" target="_blank" style="color:var(--orange)">Graph API Explorer</a> → Generate Token → <code>pages_show_list</code>, <code>pages_read_engagement</code>',
  });
}

function renderTikTokCard() {
  const cfg = getTikTokConfig();
  return _socialCard({
    id: 'tiktok', icon: 'T', title: 'TikTok', color: '#010101',
    status: cfg ? '✓ Connected' : 'Not connected',
    statusColor: cfg ? 'var(--green-text,#2e7d32)' : 'var(--text-3)',
    inputId: 'tiktok-token-input', inputPh: 'Paste TikTok Access Token',
    connectFn: 'connectTikTok', disconnectFn: 'disconnectTikTok',
    note: 'TikTok requires video content. Posting uses Buffer/Metricool or remains manual; Make.com is reserved for the Pinterest bridge here.',
    hint: 'Get token via TikTok for Developers → your app → OAuth 2.0',
  });
}

function getFbConfig() {
  try { return JSON.parse(localStorage.getItem('fb_shop_config') || 'null'); } catch { return null; }
}

function getIgConfig() {
  try { return JSON.parse(localStorage.getItem('ig_config') || 'null'); } catch { return null; }
}

function renderInstagramCard() {
  const cfg = getIgConfig();
  const connected = !!cfg?.ig_id;
  const invalid = !!cfg?.invalid;
  return `
  <div class="card mb-12">
    <div class="row-between mb-12">
      <span style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px">
        <span style="width:22px;height:22px;border-radius:4px;background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center">IG</span>
        Instagram
      </span>
      <span id="ig-conn-status" style="font-size:12px;color:${invalid ? 'var(--red-text)' : connected ? 'var(--green-text,#2e7d32)' : 'var(--text-3)'}">
        ${invalid ? `✕ Reconnect required` : connected ? `✓ @${cfg.ig_username}` : 'Not connected'}
      </span>
    </div>

    <div class="field">
      <label>Access Token</label>
      <div class="row" style="gap:6px">
        <input type="text" id="ig-token-input" placeholder="Paste Instagram / Facebook token" style="flex:1">
        <button class="btn btn-sm btn-primary" id="ig-connect-btn" onclick="window.connectInstagram()">Connect</button>
        ${connected ? `<button class="btn btn-sm btn-danger" onclick="window.disconnectInstagram()">Disconnect</button>` : ''}
      </div>
    </div>

    <details style="margin-top:8px">
      <summary style="font-size:12px;color:var(--orange);cursor:pointer">Manual fallback: token + Instagram Business ID</summary>
      <div style="margin-top:8px;display:grid;gap:6px">
        <input type="text" id="ig-direct-id-input" placeholder="Instagram Business ID (only if Page linking is broken)">
        <button class="btn btn-sm" id="ig-direct-connect-btn" onclick="window.connectInstagramDirect()">Connect with IG ID</button>
        <div style="font-size:11px;color:var(--text-3);line-height:1.5">Use this only if this token already published before and Meta refuses to link the account through Accounts Center/Page settings.</div>
      </div>
    </details>

    <div id="ig-connected-ui" style="${connected ? '' : 'display:none'}">
      <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-secondary);border-radius:8px;margin-top:8px">
        ${cfg?.ig_picture ? `<img src="${cfg.ig_picture}" style="width:36px;height:36px;border-radius:50%;object-fit:cover">` : ''}
        <div>
          <div style="font-size:13px;font-weight:600">@${cfg?.ig_username || ''}</div>
          <div style="font-size:11px;color:var(--text-3)">Instagram Business ID: ${cfg?.ig_id || ''}</div>
        </div>
        <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-sm" onclick="window.testInstagramConnection()" id="ig-test-btn">Test</button>
          <button class="btn btn-sm" onclick="window.refreshIgToken()" id="ig-refresh-btn">↺ Refresh token</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-3);margin-top:6px;line-height:1.5">Paste a Facebook User Token from Graph API Explorer. The app exchanges it for a long-lived User Token and saves it to KV. If refresh fails after expiry, Meta requires generating a new token.</div>
      ${invalid ? `<div style="font-size:11px;color:var(--red-text);margin-top:6px;line-height:1.5">Last refresh failed: ${String(cfg.last_error || 'token invalid').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : ''}
    </div>

    <div style="font-size:11px;color:var(--text-3);margin-top:8px;line-height:1.6">
      Потрібен <strong>User Token</strong> (не Page Token!):<br>
      <a href="https://developers.facebook.com/tools/explorer/" target="_blank" style="color:var(--orange)">Graph API Explorer</a> → вибери app <code>bringphototolife</code> → Generate User Access Token → додай права: <code>instagram_basic</code>, <code>instagram_content_publish</code>, <code>pages_read_engagement</code>, <code>pages_show_list</code>. Після Connect app сам обміняє short-lived token на long-lived через <code>FACEBOOK_APP_ID</code>/<code>FACEBOOK_APP_SECRET</code>.
      <br>У <a href="https://developers.facebook.com/tools/debug/accesstoken/" target="_blank" style="color:var(--orange)">Access Token Debugger</a> вставляй саме реальний token типу <code>EAAB...</code>, не назву permission. <code>instagram_basic</code> має бути в scopes, але це не access token.
    </div>
  </div>`;
}

function renderFacebookShopCard() {
  const cfg = getFbConfig();
  return `
  <div class="card mb-12">
    <div class="row-between mb-12">
      <span style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px">
        <span style="width:22px;height:22px;border-radius:4px;background:#1877F2;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center">F</span>
        Facebook Shop (catalog sync)
      </span>
      <span id="fb-conn-status" style="font-size:12px;font-weight:600;color:${cfg ? 'var(--green-text,#2e7d32)' : 'var(--text-3)'}">
        ${cfg ? `✓ ${cfg.page_name}` : 'Not connected'}
      </span>
    </div>

    <div id="fb-token-row" class="field">
      <label>Page Access Token</label>
      <div class="row">
        <input type="text" id="fb-token-input" placeholder="EAAbU…" style="flex:1" value="${cfg?.token || ''}">
        <button class="btn btn-sm btn-primary" id="fb-connect-btn" onclick="window.connectFacebook()">Connect</button>
      </div>
      <div class="text-sm text-muted">Graph API Explorer → requires <code class="code">catalog_management</code> + <code class="code">business_management</code></div>
    </div>

    <div id="fb-connected-ui" style="${cfg ? '' : 'display:none'}">
      <div class="divider"></div>
      <div class="grid-2">
        <div class="field">
          <label>Facebook Page</label>
          <select id="fb-page-select" onchange="window.onFbPageChange(this.value)">
            ${cfg ? `<option value="${cfg.page_id}" data-biz="${cfg.business_id}">${cfg.page_name}</option>` : ''}
          </select>
        </div>
        <div class="field">
          <label>Catalog</label>
          <div id="fb-catalog-info" style="display:flex;align-items:center;gap:8px;min-height:32px">
            ${cfg?.catalog_id ? `<code class="code" style="font-size:11px">${cfg.catalog_id}</code><span style="font-size:12px;color:var(--green-text,#2e7d32)">✓ Ready</span>` : '<span class="text-muted text-sm">—</span>'}
          </div>
        </div>
      </div>
      <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
        ${cfg?.catalog_id ? `
          <a href="https://business.facebook.com/commerce/catalogs/${cfg.catalog_id}/products/" target="_blank" rel="noopener" class="btn btn-sm" style="background:#1877F2;color:#fff;display:inline-flex;align-items:center;gap:6px">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M9 6h2.5L11 8.5H9V14H6.5V8.5H5V6h1.5V4.5C6.5 3 7.5 2 9 2h2v2.5H9.5C9.2 4.5 9 4.7 9 5V6z"/></svg>
            Commerce Manager
          </a>
          <a href="https://www.facebook.com/${cfg.page_id}?sk=shop" target="_blank" rel="noopener" class="btn btn-sm" style="background:#1877F2;color:#fff;display:inline-flex;align-items:center;gap:6px">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M9 6h2.5L11 8.5H9V14H6.5V8.5H5V6h1.5V4.5C6.5 3 7.5 2 9 2h2v2.5H9.5C9.2 4.5 9 4.7 9 5V6z"/></svg>
            Page Shop
          </a>` : ''}
        <button class="btn btn-sm btn-danger" onclick="window.disconnectFacebook()">Disconnect</button>
      </div>
      ${cfg?.catalog_id ? `<div class="alert" style="margin-top:10px;background:var(--bg-secondary);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--text-2)">
        ℹ️ Products added here go to your Commerce Manager catalog. To show them publicly on your Facebook Page, open Commerce Manager → Shops → connect this catalog to your page.
      </div>` : ''}
    </div>
  </div>`;
}

function renderCrosspostTab() {
  const makeCfg = getMakeConfig();
  const steps = [
    { n: 1, title: 'Configure platform credentials', detail: 'Instagram and Facebook posting are handled by this project through the Meta/Facebook credentials saved in the admin panel.' },
    { n: 2, title: 'Use Make.com for Pinterest', detail: 'Depending on your account permissions, Pinterest can use your configured integration or a manual workflow.' },
    { n: 3, title: 'Use Buffer/Metricool only as optional fallbacks', detail: 'Set up supported social integrations for the platforms you actually use.' },
    { n: 4, title: 'Apply your configuration', detail: 'After editing environment variables, update <code class="code">.env</code> and restart <code class="code">your self-hosted app service</code>.' },
  ];

  return `
    <div class="card mb-12">
      <div class="settings-group-title">Platform publishing routes</div>
      <div class="alert alert-info mb-12" style="font-size:12px">
        Current routing: <strong>Instagram → direct Instagram API</strong>, <strong>Facebook → direct Facebook Page API</strong>,
        <strong>Pinterest → Make.com webhook</strong>, <strong>TikTok → Buffer/Metricool or manual</strong>.
        Make.com is not the generic route for Instagram/Facebook in this project.
      </div>

      <div style="margin-bottom:18px">
        ${steps.map(s => `
        <div style="display:flex;gap:12px;margin-bottom:12px;align-items:flex-start">
          <div style="min-width:26px;height:26px;border-radius:50%;background:var(--orange);color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">${s.n}</div>
          <div>
            <div style="font-size:13px;font-weight:600;margin-bottom:2px">${s.title}</div>
            <div style="font-size:12px;color:var(--text-2);line-height:1.5">${s.detail}</div>
          </div>
        </div>`).join('')}
      </div>

      <div class="field"><label>Access Token</label>
        <div class="row">
          <input type="text" id="s-buffer-token" placeholder="BUFFER_ACCESS_TOKEN" style="flex:1">
          <button class="btn btn-sm btn-primary" onclick="window.loadBufferProfiles()">Load profiles</button>
          <button class="btn btn-sm" onclick="window.testCrosspost('buffer')">Test</button>
        </div>
      </div>

      <div class="field"><label>Profile IDs <span class="text-muted" style="font-weight:400">(auto-filled by Load profiles, or enter comma-separated)</span></label>
        <input type="text" id="s-buffer-profiles" placeholder="BUFFER_PROFILE_IDS — e.g. prof_abc,prof_xyz">
      </div>

      <div id="buffer-profiles-result" style="margin-top:8px"></div>

      <div class="alert alert-warning" style="font-size:12px;margin-top:12px;margin-bottom:0">
        Optional fallback only. If you add Buffer values, place them in <code class="code">.env</code> and restart <code class="code">your self-hosted app service</code>.
      </div>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">Make.com — Pinterest bridge</div>
      <div class="alert alert-info mb-12" style="font-size:12px">
        Make.com is used here for <strong>Pinterest</strong>, because direct Pinterest API access is not practical for this shop.
        Instagram and Facebook should keep using the direct Meta API integration in this project.
      </div>
      <div class="field"><label>Webhook URL</label>
        <div class="row">
          <input type="text" id="s-make-url" placeholder="https://hook.eu1.make.com/..." value="${makeCfg?.webhook_url || ''}" style="flex:1">
          <button class="btn btn-sm btn-primary" onclick="window.saveMakeWebhook()">Save</button>
          <button class="btn btn-sm" onclick="window.testMakeWebhook()">Test</button>
          <button class="btn btn-sm btn-danger" onclick="window.deleteMakeWebhook()">Delete</button>
        </div>
        <div id="make-webhook-status" style="font-size:12px;color:${makeCfg?.webhook_url ? 'var(--green-text,#2e7d32)' : 'var(--text-3)'};margin-top:6px">
          ${makeCfg?.webhook_url ? '✓ Saved in shared settings. Pinterest scheduler will use this Make webhook.' : 'Not configured. Paste your Pinterest Make webhook URL and click Save.'}
        </div>
      </div>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">Metricool</div>
      <div class="field"><label>API Key</label>
        <div class="row"><input type="text" id="s-metricool-key" placeholder="METRICOOL_API_KEY" style="flex:1">
          <button class="btn btn-sm" onclick="window.testCrosspost('metricool')">Test</button></div>
      </div>
      <div class="field"><label>Brand ID</label>
        <input type="text" id="s-metricool-brand" placeholder="METRICOOL_BRAND_ID" style="width:200px"></div>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">Zapier webhook</div>
      <div class="field"><label>Webhook URL</label>
        <div class="row"><input type="text" id="s-zapier-url" placeholder="ZAPIER_WEBHOOK_URL — https://hooks.zapier.com/..." style="flex:1">
          <button class="btn btn-sm" onclick="window.testWebhook('zapier')">Test fire</button></div>
      </div>
    </div>`;
}

function renderContextTab() {
  return `
    <div class="card mb-12">
      <div class="row-between mb-12">
        <div>
          <div class="settings-group-title" style="margin:0 0 4px">AI Shop Context</div>
          <div class="text-sm text-muted">Patterns extracted from your existing 101 listings and injected into every AI generation</div>
        </div>
        <div class="row" style="gap:6px">
          <button class="btn btn-sm" onclick="window.loadSettingsContext(true)">↺ Refresh</button>
          <button class="btn btn-sm btn-danger" onclick="window.clearSettingsContext()">Clear cache</button>
        </div>
      </div>
      <div id="ctx-content"><div class="loading-center"><div class="spinner"></div> Loading context...</div></div>
    </div>

    <div class="card">
      <div class="settings-group-title">Full context prompt preview</div>
      <div class="text-sm text-muted mb-8">This is what gets injected into every AI listing generation:</div>
      <textarea id="ctx-preview" rows="14" style="font-size:11px;font-family:monospace;background:var(--bg-secondary)" readonly placeholder="Click Refresh to load..."></textarea>
    </div>`;
}

function renderPrefsTab() {
  return `
    <div class="card mb-12">
      <div class="settings-group-title">Display</div>
      <div class="grid-2">
        <div class="field"><label>Theme</label>
          <select onchange="window.__toggleTheme()" id="theme-select">
            <option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </div>
        <div class="field"><label>Listings per page</label>
          <select style="width:auto"><option>10</option><option selected>25</option><option>50</option><option>100</option></select>
        </div>
        <div class="field"><label>Default listings view</label>
          <select style="width:auto"><option>List</option><option>Grid</option></select>
        </div>
        <div class="field"><label>Default social tone</label>
          <select style="width:auto"><option>Engaging</option><option>Professional</option><option>Playful</option><option>Urgent</option></select>
        </div>
      </div>
    </div>

    <div class="card mb-12">
      <div class="settings-group-title">Listing defaults</div>
      <div class="grid-2">
        <div class="field"><label>Who made it</label>
          <select style="width:auto"><option>I did</option><option>Collective</option><option>Someone else</option></select>
        </div>
        <div class="field"><label>When made</label>
          <select style="width:auto"><option>Made to order</option><option>2020–2024</option><option>2010–2019</option></select>
        </div>
      </div>
      <div class="field">
        <div class="row"><label style="margin:0">Auto-renew by default</label>
          <div class="toggle-wrap" style="margin-left:auto"><div class="toggle on" onclick="this.classList.toggle('on')"></div></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="settings-group-title">Image prompts</div>
      <div class="field"><label>Default slots per listing</label>
        <select style="width:auto"><option>3</option><option selected>6</option><option>9</option></select>
      </div>
      <div class="field"><label>Default image tool</label>
        <select style="width:auto">
          <option>Nano Banana 2</option>
          <option>Midjourney</option>
          <option>DALL·E 3</option>
          <option>Stable Diffusion</option>
        </select>
      </div>
    </div>`;
}

// ── Tab handlers ──────────────────────────────────────────

function attachHandlers(tabIdx) {
  if (tabIdx === 0) {
    // Etsy tab
    checkTokenStatus();
    checkEtsyConnectionStatus();
    window.testEtsy = async () => {
      const el = document.getElementById('etsy-test-result');
      if (el) el.textContent = 'Testing...';
      try {
        const shop = await etsy.getShop();
        if (el) { el.textContent = `✓ Connected: ${shop.shop_name}`; el.style.color = 'var(--green-text)'; }
      } catch (e) {
        if (el) { el.textContent = '✕ ' + e.message; el.style.color = 'var(--red-text)'; }
      }
    };
    window.connectEtsyOAuth = () => {
      window.location.href = '/etsy-auth.html?env=1';
    };
    window.saveEtsyTokens = async () => {
      const access = document.getElementById('s-token')?.value?.trim();
      const refresh = document.getElementById('s-refresh')?.value?.trim();
      if (!access) { toastError('Access token is required'); return; }
      try {
        await kv.setEtsyTokens({ access_token: access, refresh_token: refresh, expires_in: 3600 });
        toastSuccess('Etsy tokens saved to KV');
        checkTokenStatus();
      } catch (e) {
        toastError('Failed to save Etsy tokens: ' + e.message);
      }
    };
    window.doRefreshToken = async () => {
      try { await etsy.refreshToken(); toastSuccess('Token refreshed'); checkTokenStatus(); }
      catch (e) { toastError(e.message); }
    };
  }

  if (tabIdx === 1) {
    // AI tab
    const setGuidanceBusy = (busy, label = 'Check now') => {
      const button = document.getElementById('etsy-guidance-refresh');
      if (!button) return;
      button.disabled = busy;
      button.textContent = busy ? 'Checking...' : label;
    };
    window.loadEtsyGuidanceStatus = async () => {
      try {
        renderEtsyGuidanceStatus(await etsyGuidance.getStatus());
      } catch (error) {
        const root = document.getElementById('etsy-guidance-status');
        if (root) root.innerHTML = `<div class="alert alert-error" style="font-size:12px">${escHtml(error.message)}</div>`;
      }
    };
    window.refreshEtsyGuidance = async () => {
      setGuidanceBusy(true);
      try {
        renderEtsyGuidanceStatus(await etsyGuidance.refresh(false));
        toastSuccess('Official Etsy guidance check completed');
      } catch (error) {
        toastError(error.message);
        await window.loadEtsyGuidanceStatus();
      } finally {
        setGuidanceBusy(false);
      }
    };
    window.approveEtsyGuidance = async () => {
      const candidate = window.__etsyGuidanceStatus?.candidate;
      if (!candidate?.id || !candidate?.digest) return toastError('Reload the guidance candidate before approval');
      try {
        renderEtsyGuidanceStatus(await etsyGuidance.approve(candidate.id, candidate.digest));
        toastSuccess('The new Etsy guidance is active');
      } catch (error) {
        toastError(error.message);
        await window.loadEtsyGuidanceStatus();
      }
    };
    window.dismissEtsyGuidance = async () => {
      const candidate = window.__etsyGuidanceStatus?.candidate;
      if (!candidate?.id || !candidate?.digest) return toastError('Reload the guidance candidate before dismissing it');
      try {
        renderEtsyGuidanceStatus(await etsyGuidance.dismiss(candidate.id, candidate.digest));
        toastSuccess('Guidance candidate dismissed');
      } catch (error) {
        toastError(error.message);
        await window.loadEtsyGuidanceStatus();
      }
    };
    window.restoreBundledEtsyGuidance = async () => {
      if (!window.confirm('Restore the bundled Etsy guidance fallback?')) return;
      try {
        renderEtsyGuidanceStatus(await etsyGuidance.restoreBundled());
        toastSuccess('Bundled Etsy guidance restored');
      } catch (error) {
        toastError(error.message);
      }
    };
    window.loadEtsyGuidanceStatus();

    window.testClaude = async () => {
      toastInfo('Testing Claude API...');
      try {
        const res = await fetch('/api/ai', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'listing', provider: 'claude', description: 'test', productType: 'other', listingType: 'download' })
        });
        const d = await readJsonResponse(res, 'Claude connection test');
        toastSuccess('Claude API: connected ✓');
      } catch (e) { toastError('Claude: ' + e.message); }
    };
    window.testGemini = async () => {
      toastInfo('Testing Gemini...');
      try {
        const res = await fetch('/api/ai', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'listing', provider: 'gemini', description: 'test', productType: 'other', listingType: 'download' })
        });
        const d = await readJsonResponse(res, 'Gemini connection test');
        toastSuccess('Gemini API: connected ✓');
      } catch (e) { toastError('Gemini: ' + e.message); }
    };
    const setExternalTestState = ({ kind, state, message }) => {
      const resultEl = document.getElementById('external-ai-test-result');
      const textBtn = document.getElementById('test-external-text-btn');
      const imageBtn = document.getElementById('test-external-image-btn');
      const isLoading = state === 'loading';
      if (textBtn) {
        textBtn.disabled = isLoading;
        textBtn.innerHTML = isLoading && kind === 'text' ? '<span class="spinner" style="display:inline-block;width:12px;height:12px;margin-right:5px;vertical-align:-2px"></span>Testing Text...' : 'Test External Text';
      }
      if (imageBtn) {
        imageBtn.disabled = isLoading;
        imageBtn.innerHTML = isLoading && kind === 'image' ? '<span class="spinner" style="display:inline-block;width:12px;height:12px;margin-right:5px;vertical-align:-2px"></span>Testing Image...' : 'Test External Image';
      }
      if (!resultEl) return;
      resultEl.style.display = 'block';
      resultEl.style.borderColor = state === 'success' ? 'var(--green-text)' : state === 'error' ? 'var(--red-text)' : 'var(--orange-border)';
      resultEl.innerHTML = message;
    };
    const startExternalTestTimer = (kind, label) => {
      const startedAt = Date.now();
      const render = () => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
        setExternalTestState({ kind, state: 'loading', message: `<span style="color:var(--text-2)">${label}</span><div style="font-size:11px;color:var(--text-3);margin-top:2px">Elapsed: <span style="font-variant-numeric:tabular-nums">${elapsed}</span>. Still working...</div>` });
      };
      render();
      return setInterval(render, 1000);
    };
    window.testExternalAI = async () => {
      await window.saveExternalAIConfig(true); // silent save
      const timer = startExternalTestTimer('text', 'Testing External AI text connection...');
      try {
        const res = await fetch('/api/ai', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'audit', provider: 'external', _maxOutputTokens: 32, _rawSystem: 'You are a connection test responder.', _rawPrompt: 'Reply with exactly: OK' })
        });
        const d = await readJsonResponse(res, 'Text connection test');
        const preview = typeof d.data === 'string' ? d.data.trim().slice(0, 180) : JSON.stringify(d.data || {}).slice(0, 180);
        clearInterval(timer);
        setExternalTestState({ kind: 'text', state: 'success', message: `<span style="color:var(--green-text);font-weight:700">Text connection works.</span> Response: <code>${escHtml(preview || 'OK')}</code>` });
        toastSuccess('External AI: connected ✓');
      } catch (e) {
        clearInterval(timer);
        const message = userFacingErrorMessage(e.message);
        setExternalTestState({ kind: 'text', state: 'error', message: `<span style="color:var(--red-text);font-weight:700">Text test failed:</span> ${escHtml(message)}` });
        toastError('AI provider: ' + message);
      }
    };
    window.loadProviderStatus = async () => {
      const grid = document.getElementById('ai-provider-status-grid');
      if (!grid) return;
      grid.innerHTML = '<div style="font-size:12px;color:var(--text-3)">Loading provider status...</div>';
      try {
        const status = await kv.getAiProviderStatus();
        grid.innerHTML = (status.providers || []).map(p => {
          const isTextActive = localStorage.getItem('ai_provider') === p.key;
          const isImageActive = localStorage.getItem('image_provider') === p.key;
          let activeBadges = '';
          if (isTextActive) activeBadges += `<span style="background:var(--blue, #3b82f6);color:#fff;padding:2px 6px;border-radius:4px;font-size:9px;margin-right:4px;font-weight:bold">ACTIVE TEXT</span>`;
          if (isImageActive && p.supportsImages) activeBadges += `<span style="background:var(--orange, #f97316);color:#fff;padding:2px 6px;border-radius:4px;font-size:9px;font-weight:bold">ACTIVE IMAGE</span>`;

          return `
          <div style="border:1px solid ${isTextActive || isImageActive ? 'var(--blue, #3b82f6)' : 'var(--border)'};border-radius:10px;padding:10px;background:${isTextActive || isImageActive ? 'var(--bg-hover)' : 'var(--bg-secondary)'}">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
              <strong style="font-size:12px">${p.label}</strong>
              <span style="font-size:10px;font-weight:700;color:${p.configured ? 'var(--green-text)' : 'var(--text-3)'}">${p.configured ? 'READY' : 'NOT SET'}</span>
            </div>
            ${activeBadges ? `<div style="margin-bottom:8px">${activeBadges}</div>` : ''}
            ${p.baseUrl ? `<div style="font-size:11px;color:var(--text-3);word-break:break-all">${p.baseUrl}</div>` : ''}
            ${p.textModel ? `<div style="font-size:11px;color:var(--text-2);margin-top:5px">Text: <code>${p.textModel}</code></div>` : ''}
            ${p.imageModel ? `<div style="font-size:11px;color:var(--text-2)">Image: <code>${p.imageModel}</code></div>` : ''}
            <div style="font-size:10px;color:var(--text-3);margin-top:5px">Tools: ${p.supportsTools ? 'yes' : 'no'} · Images: ${p.supportsImages ? 'yes' : 'no'}</div>
          </div>
          `;
        }).join('');
      } catch (e) {
        grid.innerHTML = `<div class="alert alert-error" style="font-size:12px">${escHtml(e.message)}</div>`;
      }
    };
    window.saveExternalAIConfig = async (silent = false) => {
      const statusEl = document.getElementById('external-ai-status');
      const cfg = {
        baseUrl: document.getElementById('external-base-url')?.value?.trim(),
        apiKey: document.getElementById('external-api-key')?.value?.trim(),
        method: document.getElementById('external-method')?.value || 'openai',
        textPath: document.getElementById('external-text-path')?.value?.trim() || '/v1/chat/completions',
        imagePath: '/v1/responses',
        textModel: document.getElementById('external-text-model')?.value?.trim() || '',
        visionModel: document.getElementById('external-vision-model')?.value?.trim() || document.getElementById('external-text-model')?.value?.trim() || '',
        imageModel: document.getElementById('external-image-model')?.value?.trim() || '',
        imageStream: false,
        imageResponseFormat: 'base64_json',
        imageAdapter: 'openai_responses',
        imageReferenceMode: 'provider_native',
        imageDownloadPathPrefix: '',
        imageTimeoutMs: Number(document.getElementById('external-image-timeout-ms')?.value) || 120000,
        imageBaseUrl: document.getElementById('external-image-base-url')?.value?.trim() || '',
      };
      if (!cfg.baseUrl) { toastError('External base URL is required'); return; }
      try {
        await kv.setExternalAiConfig(cfg);
        // Older builds stored this project setting in the browser too. Clear it
        // so a stale tab cannot override the server-side model used by Auto.
        localStorage.removeItem('ai_model_external');
        if (statusEl) statusEl.textContent = '✓ External provider saved';
        document.getElementById('external-api-key').value = '';
        if (!silent) toastSuccess('External provider saved');
        window.loadProviderStatus?.();
      } catch (e) {
        if (statusEl) statusEl.textContent = '✕ ' + e.message;
        if (!silent) toastError('Failed to save external provider: ' + e.message);
      }
    };
    (async () => {
      const statusEl = document.getElementById('external-ai-status');
      try {
        const cfg = await kv.getExternalAiConfig();
        if (!cfg) return;
        const fields = {
          'external-base-url': cfg.baseUrl,
          'external-image-base-url': cfg.imageBaseUrl,
          'external-text-path': cfg.textPath,
          'external-text-model': cfg.textModel,
          'external-vision-model': cfg.visionModel || cfg.textModel,
          'external-image-model': cfg.imageModel,
          'external-image-timeout-ms': cfg.imageTimeoutMs,
          'external-method': cfg.method || 'openai',
        };
        for (const [id, value] of Object.entries(fields)) {
          const el = document.getElementById(id);
          if (el && value !== undefined && value !== null) el.value = value;
        }
        if (statusEl) statusEl.textContent = cfg.configured ? `Saved provider loaded. API key: ${cfg.apiKey}` : 'External provider is not configured yet.';
        window.loadProviderStatus?.();
      } catch {}
    })();
    window.setImageProvider = (provider, silent = false) => {
      const label = provider === 'external' ? 'External AI' : 'Gemini';
      localStorage.setItem('image_provider', provider);
      const select = document.getElementById('default-image-provider');
      if (select) select.value = provider;
      if (!silent) toastSuccess(`Image provider set to ${label}`);
      window.loadProviderStatus?.();
    };
    window.setTextProvider = (provider, silent = false) => {
      localStorage.setItem('ai_provider', provider);
      const select = document.getElementById('default-text-provider');
      if (select) select.value = provider;
      if (!silent) toastSuccess(`Text provider set to ${provider === 'external' ? 'External AI' : provider}`);
      window.loadProviderStatus?.();
    };
    const savedTextProvider = localStorage.getItem('ai_provider') || 'external';
    const savedImageProvider = localStorage.getItem('image_provider') || 'external';
    localStorage.setItem('ai_provider', savedTextProvider);
    localStorage.setItem('image_provider', savedImageProvider);
    const textProviderSelect = document.getElementById('default-text-provider');
    if (textProviderSelect) {
      textProviderSelect.value = savedTextProvider;
      textProviderSelect.addEventListener('change', (e) => window.setTextProvider(e.target.value));
    }
    const imageProviderSelect = document.getElementById('default-image-provider');
    if (imageProviderSelect) {
      imageProviderSelect.value = savedImageProvider;
      imageProviderSelect.addEventListener('change', (e) => window.setImageProvider(e.target.value));
    }
    window.setImageProvider(savedImageProvider, true);
    window.testExternalImageAI = async () => {
      await window.saveExternalAIConfig(true); // silent save
      const timer = startExternalTestTimer('image', 'Generating a small test image...');
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 120000);
      try {
        const d = await fetchJsonWithTimeout('/api/media', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ action: 'generate', provider: 'external', prompt: 'a small orange cat sticker on a white background, no text', aspectRatio: '1:1', count: 1 })
        }, 'Image connection test', 120000);
        clearInterval(timer);
        clearTimeout(abortTimer);
        const img = d.images?.[0];
        let galleryNote = '';
        let preview = '';
        if (img?.base64 && img?.mimeType) {
          try {
            const galleryId = await saveImage({
              base64: img.base64,
              mimeType: img.mimeType,
              prompt: 'Image provider connection test: A highly detailed, photorealistic studio shot of an elegant perfume bottle on a sleek black marble pedestal. Dramatic spotlighting. The label on the bottle is a pristine white square with the text "ETSY PRO" written in bold, modern minimalist typography. Surrounding the pedestal are subtle smoky wisps and a few scattered rose petals. 8k, hyper-detailed, advertising photography.',
              slotLabel: 'Provider test',
              listingTitle: 'Settings image test',
            });
            galleryNote = ` Saved to Gallery as <code>${escHtml(galleryId)}</code>.`;
          } catch (saveErr) {
            galleryNote = ` Generated image preview is shown below, but Gallery save failed: ${escHtml(saveErr.message)}.`;
          }
          preview = `<div style="margin-top:8px;display:flex;align-items:center;gap:10px">
            <img src="data:${escHtml(img.mimeType)};base64,${img.base64}" alt="Generated provider test image" style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid var(--border)">
            <button class="btn btn-sm" onclick="window.navigate?.('gallery')">Open Gallery</button>
          </div>`;
        }
        setExternalTestState({ kind: 'image', state: 'success', message: `<span style="color:var(--green-text);font-weight:700">Image connection works.</span> Generated ${d.images?.length || 0} PNG image.${galleryNote}${preview}` });
        toastSuccess(`Image provider connected - generated ${d.images?.length || 0} image`);
      } catch (e) {
        clearInterval(timer);
        clearTimeout(abortTimer);
        const message = userFacingErrorMessage(e.name === 'AbortError' ? 'Request timed out after 120s' : e.message);
        setExternalTestState({ kind: 'image', state: 'error', message: `<span style="color:var(--red-text);font-weight:700">Image test failed:</span> ${escHtml(message)}` });
        toastError('Image provider: ' + message);
      }
    };
    window.testNanoBanana = async () => {
      toastInfo('Testing Nano Banana 2...');
      try {
        const res = await fetch('/api/media', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'generate', prompt: 'a white coffee mug on marble, product photography', aspectRatio: '1:1', count: 1 })
        });
        const d = await readJsonResponse(res, 'Nano Banana image test');
        toastSuccess(`Nano Banana 2: connected ✓ — generated ${d.images?.length} image`);
      } catch (e) { toastError('Nano Banana 2: ' + userFacingErrorMessage(e.message)); }
    };
    window.quickNBTest = async () => {
      const prompt = document.getElementById('nb-test-prompt')?.value?.trim();
      if (!prompt) { toastError('Enter a prompt'); return; }
      const resultEl = document.getElementById('nb-test-result');
      if (resultEl) resultEl.innerHTML = '<div class="loading-center"><div class="spinner"></div> Generating...</div>';
      try {
        const res = await fetch('/api/media', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'generate', prompt, aspectRatio: '1:1', count: 2 })
        });
        const d = await readJsonResponse(res, 'Image generation test');
        if (resultEl) resultEl.innerHTML = `<div class="row" style="gap:8px">${(d.images || []).map(img =>
          `<img src="data:${img.mimeType};base64,${img.base64}" style="width:120px;height:120px;object-fit:cover;border-radius:var(--radius);border:1px solid var(--border)">`
        ).join('')}</div>`;
      } catch (e) {
        if (resultEl) resultEl.innerHTML = `<div class="alert alert-error" style="font-size:12px">${escHtml(userFacingErrorMessage(e.message))}</div>`;
      }
    };

    // ── Extra Gemini keys management ──
    let geminiExtraKeys = [];

    const renderExtraKeysList = () => {
      const listEl = document.getElementById('extra-keys-list');
      if (!listEl) return;
      if (!geminiExtraKeys.length) {
        listEl.innerHTML = '<div style="font-size:12px;color:var(--text-3)">No extra keys configured — using primary GEMINI_API_KEY only.</div>';
        return;
      }
      listEl.innerHTML = geminiExtraKeys.map((k, i) => `
        <div class="row" style="gap:6px;align-items:center;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:6px 10px">
          <span style="font-size:11px;font-weight:600;color:var(--text-3)">Key ${i + 2}</span>
          <span style="flex:1;font-size:12px;font-family:monospace;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${k.slice(0, 8)}${'•'.repeat(20)}</span>
          <button class="btn btn-sm" onclick="window.removeGeminiKey(${i})" style="color:var(--red-text);font-size:11px;padding:2px 8px">Remove</button>
        </div>`).join('');
    };

    const saveExtraKeys = async () => {
      const statusEl = document.getElementById('gemini-keys-status');
      try {
        await kvPost('setGeminiKeys', geminiExtraKeys);
        if (statusEl) statusEl.textContent = `✓ ${geminiExtraKeys.length + 1} key${geminiExtraKeys.length ? 's' : ''} configured (${geminiExtraKeys.length + 1}× parallel capacity)`;
      } catch (e) {
        if (statusEl) statusEl.textContent = '✕ ' + e.message;
        toastError('Failed to save keys: ' + e.message);
      }
    };

    window.addGeminiKey = async () => {
      const input = document.getElementById('new-gemini-key');
      const key = input?.value?.trim();
      if (!key) { toastError('Enter an API key'); return; }
      if (geminiExtraKeys.includes(key)) { toastError('Key already added'); return; }
      geminiExtraKeys.push(key);
      if (input) input.value = '';
      renderExtraKeysList();
      await saveExtraKeys();
      toastSuccess('Key added');
    };

    window.removeGeminiKey = async (idx) => {
      geminiExtraKeys.splice(idx, 1);
      renderExtraKeysList();
      await saveExtraKeys();
      toastSuccess('Key removed');
    };

    // Load existing extra keys
    (async () => {
      const statusEl = document.getElementById('gemini-keys-status');
      try {
        const data = await kvPost('getGeminiKeys');
        geminiExtraKeys = Array.isArray(data) ? data : [];
        renderExtraKeysList();
        if (geminiExtraKeys.length && statusEl) statusEl.textContent = `${geminiExtraKeys.length + 1} keys configured (${geminiExtraKeys.length + 1}× parallel capacity)`;
      } catch {
        renderExtraKeysList();
      }
    })();

    // ── Meta AI cookies management ──
    const setMetaCookieButtonsBusy = (busy) => {
      ['meta-save-btn', 'meta-test-btn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = Boolean(busy);
      });
    };

    const normalizeMetaCookieInput = (value) => String(value || '')
      .trim()
      .replace(/^cookie\s*:\s*/i, '')
      .trim();

    window.saveMetaCookies = async ({ silent = false, manageBusy = true } = {}) => {
      const ecto = document.getElementById('meta-cookie-ecto')?.value?.trim();
      const rd = document.getElementById('meta-cookie-rd')?.value?.trim();
      const raw = normalizeMetaCookieInput(document.getElementById('meta-cookie-raw')?.value);
      const statusEl = document.getElementById('meta-cookies-status');
      const rawParsed = raw ? parseMetaCookieSettings(raw) : {};
      const resolvedEcto = ecto || rawParsed.ecto_1_sess || '';
      const resolvedRd = rd || rawParsed.rd_challenge || rawParsed.datr || '';
      if (!resolvedEcto || !resolvedRd) { toastError('ecto_1_sess and rd_challenge are required'); return false; }
      const value = raw
        ? raw
        : [
          `ecto_1_sess=${resolvedEcto}`,
          `rd_challenge=${resolvedRd}`,
        ].filter(Boolean).join('; ');
      try {
        if (manageBusy) setMetaCookieButtonsBusy(true);
        if (statusEl && !silent) statusEl.textContent = 'Saving...';
        await kvPost('setMetaCookies', value);
        if (statusEl && !silent) statusEl.textContent = 'Saved';
        if (!silent) toastSuccess('Meta AI cookies saved');
        return true;
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Error: ' + e.message;
        toastError('Failed to save: ' + e.message);
        return false;
      } finally {
        if (manageBusy) setMetaCookieButtonsBusy(false);
      }
    };

    window.testMetaCookies = async () => {
      const statusEl = document.getElementById('meta-cookies-status');
      try {
        setMetaCookieButtonsBusy(true);
        if (statusEl) statusEl.textContent = 'Saving and testing...';
        const saved = await window.saveMetaCookies({ silent: true, manageBusy: false });
        if (!saved) return;
        if (statusEl) statusEl.textContent = 'Testing connection...';
        const res = await fetch('/api/meta-ai', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'status' }) });
        const d = await res.json();
        // A 503 "not configured" means cookies missing — anything else means we reached Meta AI
        if (d.error?.includes('not configured')) throw new Error(d.error);
        // 401 means cookies expired
        if (res.status === 401 || d.error?.includes('expired') || d.status === 'unauthorized') {
          if (statusEl) statusEl.textContent = 'Cookies expired';
          toastError('Cookies expired — paste fresh ones');
          return;
        }
        if (!res.ok || d.success === false) throw new Error(d.error || 'Connection failed');
        if (statusEl) statusEl.textContent = 'Connected to Meta AI';
        toastSuccess('Meta AI: connected');
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Error: ' + e.message;
        toastError('Meta AI: ' + e.message);
      } finally {
        setMetaCookieButtonsBusy(false);
      }
    };

    const parseMetaCookieSettings = (value) => {
      if (!value) return {};
      if (typeof value === 'object') return value;
      const text = normalizeMetaCookieInput(value);
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
      const parsed = {};
      text.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx <= 0) return;
        const name = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (name) parsed[name] = val;
      });
      return parsed;
    };

    // Load existing cookies
    (async () => {
      const statusEl = document.getElementById('meta-cookies-status');
      try {
        const data = await kvPost('getMetaCookies');
        if (data) {
          const parsed = parseMetaCookieSettings(data);
          const setF = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
          setF('meta-cookie-ecto', parsed.ecto_1_sess);
          setF('meta-cookie-rd', parsed.rd_challenge);
          setF('meta-cookie-raw', data);
          if (statusEl) statusEl.textContent = '✓ Cookies configured';
        }
      } catch {}
    })();

    // Save model preference to localStorage
    window.saveAIModelPref = (key, val) => {
      localStorage.setItem(`ai_model_${key}`, val);
      toastSuccess(`${key} model saved`);
    };
    // External text routing is project-wide. Drop the obsolete browser copy
    // before restoring personal Gemini or Claude preferences.
    localStorage.removeItem('ai_model_external');
    // Restore saved model selections
    ['claude', 'gemini'].forEach(k => {
      const saved = localStorage.getItem(`ai_model_${k}`);
      if (saved) {
        const id = `s-${k}-model`;
        const el = document.getElementById(id);
        if (el) el.value = saved;
      }
    });
  }

  if (tabIdx === 2) {
    // Pull fresh prefs from KV in background
    _kvRefreshPersonalizationPrefs();

    // Personalization tab
    window.savePersonalizationPrefs = () => {
      const prefs = {
        email: document.getElementById('s-order-email')?.value || '',
        template: document.getElementById('s-personal-template')?.value || '',
        delivery: document.getElementById('s-delivery-method')?.value || 'email',
        turnaroundMin: document.getElementById('s-turnaround-min')?.value || '1',
        turnaroundMax: document.getElementById('s-turnaround-max')?.value || '3',
        turnaroundUnit: document.getElementById('s-turnaround-unit')?.value || 'business days',
        orderWebhook: document.getElementById('s-order-webhook')?.value || '',
        autoReply: document.getElementById('s-auto-reply')?.value || '',
      };
      localStorage.setItem('etsy_personalization_prefs', JSON.stringify(prefs));
      kv.setPersonalizationPrefs(prefs).catch(() => {});
      const saved = document.getElementById('s-personal-saved');
      if (saved) { saved.style.display = 'inline'; setTimeout(() => { saved.style.display = 'none'; }, 2000); }
      // Update preview
      const preview = document.getElementById('personal-preview');
      if (preview) {
        const tmpl = prefs.template || `After purchase, please send the following to ${prefs.email || '[your email]'}:\n1. Name(s) / text to personalise\n2. Photo (if needed)\n3. Any special requests\n\nYour order will be ready in ${prefs.turnaroundMin}–${prefs.turnaroundMax} ${prefs.turnaroundUnit}.`;
        preview.textContent = tmpl;
      }
    };
    window.testPersonalizationWebhook = async (type) => {
      const urlEl = document.getElementById(`s-order-webhook`);
      const url = urlEl?.value?.trim();
      if (!url) { toastError('Enter a webhook URL first'); return; }
      try {
        await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, order_id: 'TEST-001', buyer: 'Test Buyer', items: ['Test Product'], personalization: 'Test personalization info', timestamp: new Date().toISOString() })
        });
        toastSuccess('Webhook fired successfully');
      } catch (e) { toastError('Webhook failed: ' + e.message); }
    };
  }

  if (tabIdx === 3) {
    // ── Pinterest ─────────────────────────────────────────────
    window.connectPinterest = async () => {
      const token = document.getElementById('pin-token-input')?.value?.trim();
      const boardId = document.getElementById('pin-board-input')?.value?.trim();
      if (!token) return toastError('Paste your Pinterest token first');
      const btn = document.getElementById('pinterest-connect-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
      try {
        const r = await fetch(`https://api.pinterest.com/v5/user_account`, { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json();
        if (!r.ok) throw new Error(d.message || 'Invalid token');
        const cfg = { token, board_id: boardId, username: d.username, connected_at: new Date().toISOString() };
        _kvSaveSocialCfg('pinterest_config', cfg);
        _setConnectedUI('pinterest', `✓ @${d.username}`);
        toastSuccess(`Pinterest connected: @${d.username}`);
      } catch (e) { toastError('Pinterest connect failed: ' + e.message); }
      finally { if (btn) { btn.disabled = false; btn.textContent = 'Connect'; } }
    };
    window.disconnectPinterest = () => { _kvDeleteSocialCfg('pinterest_config'); _setDisconnectedUI('pinterest'); toastSuccess('Pinterest disconnected'); };

    // ── Facebook posts ────────────────────────────────────────
    window.connectFbPosts = async () => {
      const token = document.getElementById('fb-posts-token-input')?.value?.trim();
      if (!token) return toastError('Paste your token first');
      const btn = document.getElementById('fb-posts-connect-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
      try {
        let page;
        // Try User Token first → /me/accounts lists all managed pages
        const r = await fetch(`https://graph.facebook.com/v25.0/me/accounts?fields=name,id&access_token=${token}`);
        const d = await r.json();
        if (!d.error && d.data?.[0]) {
          page = d.data[0];
        } else {
          // Fallback: Page Access Token → /me returns the page itself
          const r2 = await fetch(`https://graph.facebook.com/v25.0/me?fields=name,id&access_token=${token}`);
          const d2 = await r2.json();
          if (!d2.error && d2.name) {
            page = { id: d2.id, name: d2.name };
          } else {
            throw new Error(d.error?.message || 'No Facebook Page found for this token');
          }
        }
        const cfg = { token, page_id: page.id, page_name: page.name, connected_at: new Date().toISOString() };
        _kvSaveSocialCfg('fb_posts_config', cfg);
        _setConnectedUI('fb-posts', `✓ ${page.name}`);
        toastSuccess(`Facebook connected: ${page.name}`);
      } catch (e) { toastError('Facebook connect failed: ' + e.message); }
      finally { if (btn) { btn.disabled = false; btn.textContent = 'Connect'; } }
    };
    window.disconnectFbPosts = () => { _kvDeleteSocialCfg('fb_posts_config'); _setDisconnectedUI('fb-posts'); toastSuccess('Facebook disconnected'); };

    // ── TikTok ────────────────────────────────────────────────
    window.connectTikTok = () => {
      const token = document.getElementById('tiktok-token-input')?.value?.trim();
      if (!token) return toastError('Paste your TikTok token first');
      _kvSaveSocialCfg('tiktok_config', { token, connected_at: new Date().toISOString() });
      _setConnectedUI('tiktok', '✓ Connected');
      toastSuccess('TikTok token saved');
    };
    window.disconnectTikTok = () => { _kvDeleteSocialCfg('tiktok_config'); _setDisconnectedUI('tiktok'); toastSuccess('TikTok disconnected'); };

    function _setConnectedUI(id, statusText) {
      const st = document.getElementById(`${id}-status`);
      if (st) { st.textContent = statusText; st.style.color = 'var(--green-text,#2e7d32)'; }
      const ui = document.getElementById(`${id}-connected-ui`);
      if (ui) { ui.style.display = ''; ui.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button class="btn btn-sm" onclick="window.testSocialConfig('${id}')">Test</button><button class="btn btn-sm btn-danger" onclick="window.disconnect${_capitalize(id)}()">Disconnect</button></div>`; }
    }
    function _setDisconnectedUI(id) {
      const st = document.getElementById(`${id}-status`);
      if (st) { st.textContent = 'Not connected'; st.style.color = 'var(--text-3)'; }
      const ui = document.getElementById(`${id}-connected-ui`);
      if (ui) ui.style.display = 'none';
      const input = document.getElementById(`${id === 'fb-posts' ? 'fb-posts' : id}-token-input`);
      if (input) input.value = '';
    }
    function _capitalize(s) { return s.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(''); }

    window.testSocialConfig = async (id) => {
      try {
        if (id === 'pinterest') {
          const cfg = getPinConfig();
          if (!cfg?.token) throw new Error('Pinterest is not connected');
          const res = await fetch('https://api.pinterest.com/v5/user_account', { headers: { Authorization: `Bearer ${cfg.token}` } });
          const data = await res.json();
          if (!res.ok) throw new Error(data.message || 'Pinterest token failed');
          toastSuccess(`Pinterest token works: @${data.username || cfg.username || 'connected'}`);
          return;
        }
        if (id === 'fb-posts') {
          const cfg = getFbPostsConfig();
          if (!cfg?.token) throw new Error('Facebook posts are not connected');
          const res = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(cfg.page_id || 'me')}?fields=id,name&access_token=${encodeURIComponent(cfg.token)}`);
          const data = await res.json();
          if (data.error) throw new Error(data.error.message);
          toastSuccess(`Facebook token works: ${data.name || cfg.page_name || data.id}`);
          return;
        }
        if (id === 'tiktok') {
          const cfg = getTikTokConfig();
          if (!cfg?.token) throw new Error('TikTok is not connected');
          toastInfo('TikTok posting is not wired here. Use Buffer/Metricool or keep TikTok manual. Make.com is reserved for Pinterest here. Token is saved locally/KV.');
          return;
        }
        toastInfo('No test available for this service yet.');
      } catch (e) {
        toastError(`${id} test failed: ${e.message}`);
      }
    };

    // Auto-sync any localStorage configs → KV silently on tab open
    (async () => {
      const keys = ['pinterest_config', 'fb_posts_config', 'ig_config', 'tiktok_config', 'fb_shop_config'];
      for (const k of keys) {
        try {
          const val = JSON.parse(localStorage.getItem(k) || 'null');
          if (val) await kv.setSocialConfig(k, val);
        } catch {}
      }
    })();

    // Restore connected state UI on tab open
    if (getPinConfig())      _setConnectedUI('pinterest', `✓ @${getPinConfig().username || 'Connected'}`);
    if (getFbPostsConfig())  _setConnectedUI('fb-posts',  `✓ ${getFbPostsConfig().page_name || 'Connected'}`);
    if (getTikTokConfig())   _setConnectedUI('tiktok',    '✓ Connected');

    // Pull fresh configs from KV (multi-user sync) then re-render status badges
    _kvRefreshSocialCfgs().then(() => {
      if (getPinConfig())      _setConnectedUI('pinterest', `✓ @${getPinConfig().username || 'Connected'}`);
      if (getFbPostsConfig())  _setConnectedUI('fb-posts',  `✓ ${getFbPostsConfig().page_name || 'Connected'}`);
      if (getTikTokConfig())   _setConnectedUI('tiktok',    '✓ Connected');
    });
    // Auto-extend Facebook token if expiring within 15 days
    _autoExtendFbToken();
    // Auto-refresh Instagram token if expiring within 7 days
    _autoRefreshIgToken();

    // ── Instagram connect flow ────────────────────────────────
    window.connectInstagram = async () => {
      const token = document.getElementById('ig-token-input')?.value?.trim();
      if (!token) return toastError('Paste your token first');
      const btn = document.getElementById('ig-connect-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
      try {
        const data = await social.getMyInstagram(token);
        if (!data.success) throw new Error(data.error || 'Failed');
        if (!data.accounts?.length) throw new Error('No Instagram Business account linked to this token. Make sure your Instagram is connected to a Facebook Page.');

        const acc = data.accounts[0];
        const extended = await social.extendFacebookToken({ token, page_id: acc.page_id });
        if (!extended.success || !extended.access_token) throw new Error(extended.error || 'Could not exchange token for long-lived Facebook User Token');
        const cfg = {
          token: extended.access_token,
          token_type: 'facebook_long_lived_user',
          ig_id: acc.ig_id,
          ig_username: acc.ig_username,
          ig_picture: acc.ig_picture,
          page_id: acc.page_id,
          connected_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + (extended.expires_in || 5184000) * 1000).toISOString(),
        };
        _kvSaveSocialCfg('ig_config', cfg);

        const status = document.getElementById('ig-conn-status');
        if (status) { status.textContent = `✓ @${acc.ig_username}`; status.style.color = 'var(--green-text,#2e7d32)'; }
        const ui = document.getElementById('ig-connected-ui');
        if (ui) {
          ui.style.display = '';
          ui.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-secondary);border-radius:8px;margin-top:8px">
              ${acc.ig_picture ? `<img src="${acc.ig_picture}" style="width:36px;height:36px;border-radius:50%;object-fit:cover">` : ''}
              <div>
                <div style="font-size:13px;font-weight:600">@${acc.ig_username}</div>
                <div style="font-size:11px;color:var(--text-3)">Instagram Business ID: ${acc.ig_id}</div>
              </div>
              <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
                <button class="btn btn-sm" onclick="window.testInstagramConnection()" id="ig-test-btn">Test</button>
                <button class="btn btn-sm" onclick="window.refreshIgToken()" id="ig-refresh-btn">↺ Refresh token</button>
              </div>
            </div>
            <div style="font-size:11px;color:var(--text-3);margin-top:6px;line-height:1.5">Long-lived Facebook User Token saved to KV. Refresh is attempted before expiry. If it fully expires, Meta requires generating a new token.</div>`;
        }
        toastSuccess(`Connected: @${acc.ig_username}`);
      } catch (e) {
        toastError('Instagram connect failed: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
      }
    };

    window.connectInstagramDirect = async () => {
      const token = document.getElementById('ig-token-input')?.value?.trim();
      const igId = document.getElementById('ig-direct-id-input')?.value?.trim();
      if (!token) return toastError('Paste your token first');
      if (!igId) return toastError('Paste Instagram Business ID first');
      const btn = document.getElementById('ig-direct-connect-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
      try {
        const verified = await social.verifyInstagramDirect({ token, igId });
        if (!verified.success) throw new Error(verified.error || 'Instagram verification failed');
        let cfgToken = token;
        let expiresIn = 24 * 3600;
        let tokenType = 'facebook_user_manual_direct';
        try {
          const extended = await social.extendFacebookToken({ token });
          if (extended.success && extended.access_token) {
            cfgToken = extended.access_token;
            expiresIn = extended.expires_in || 5184000;
            tokenType = 'facebook_long_lived_user_direct';
          }
        } catch {}
        const cfg = {
          token: cfgToken,
          token_type: tokenType,
          ig_id: verified.ig_id || igId,
          ig_username: verified.ig_username || `IG ${igId}`,
          ig_picture: verified.ig_picture || '',
          page_id: null,
          connected_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
          direct_ig_id: true,
        };
        _kvSaveSocialCfg('ig_config', cfg);
        const status = document.getElementById('ig-conn-status');
        if (status) { status.textContent = `✓ @${cfg.ig_username}`; status.style.color = 'var(--green-text,#2e7d32)'; }
        toastSuccess(`Instagram connected directly: @${cfg.ig_username}`);
      } catch (e) {
        toastError('Direct Instagram connect failed: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Connect with IG ID'; }
      }
    };

    async function _autoExtendFbToken() {
      // Check all FB configs for expiring tokens and silently extend them
      const configs = [
        { key: 'fb_shop_config',  label: 'Facebook Shop' },
        { key: 'fb_posts_config', label: 'Facebook Posts' },
        { key: 'ig_config',       label: 'Instagram' },
      ];
      for (const { key, label } of configs) {
        try {
          const cfg = JSON.parse(localStorage.getItem(key) || 'null');
          if (!cfg?.token) continue;
          // Check expiry if stored, or just try to extend if no expiry stored
          const expires = cfg.expires_at ? new Date(cfg.expires_at) : null;
          const daysLeft = expires ? (expires - Date.now()) / 86400000 : 0;
          if (expires && daysLeft > 15) continue; // still fresh, skip
          const data = await social.extendFacebookToken({ token: cfg.token, page_id: cfg.page_id });
          if (!data.success) continue;
          // Instagram publishing needs a Facebook User Token; page tokens are for FB pages/catalogs.
          cfg.token = key === 'ig_config' ? data.access_token : (data.page_token || data.access_token);
          if (key === 'ig_config') cfg.token_type = 'facebook_long_lived_user';
          cfg.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();
          _kvSaveSocialCfg(key, cfg);
          console.log(`[settings] ${label} token extended, expires: ${cfg.expires_at}`);
        } catch { /* silent */ }
      }
    }

    async function _autoRefreshIgToken() {
      const cfg = getIgConfig();
      if (!cfg?.token || !cfg?.expires_at) return;
      if (cfg.invalid) return;
      const daysLeft = (new Date(cfg.expires_at) - Date.now()) / 86400000;
      if (daysLeft > 7) return; // still fresh
      try {
        const data = cfg.token_type?.startsWith('facebook_long_lived_user')
          ? await social.extendFacebookToken({ token: cfg.token, page_id: cfg.page_id })
          : await social.refreshInstagramToken(cfg.token);
        if (data.success && data.access_token) {
          cfg.token = data.access_token;
          if (cfg.token_type?.startsWith('facebook_long_lived_user')) cfg.token_type = cfg.token_type.includes('direct') ? 'facebook_long_lived_user_direct' : 'facebook_long_lived_user';
          cfg.expires_at = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();
          _kvSaveSocialCfg('ig_config', cfg);
          if (daysLeft <= 0) toastSuccess('Instagram token auto-refreshed');
        }
      } catch (e) {
        cfg.invalid = true;
        cfg.last_error = e.message;
        _kvSaveSocialCfg('ig_config', cfg);
      }
    }

    window.disconnectInstagram = () => {
      _kvDeleteSocialCfg('ig_config');
      const status = document.getElementById('ig-conn-status');
      if (status) { status.textContent = 'Not connected'; status.style.color = 'var(--text-3)'; }
      const ui = document.getElementById('ig-connected-ui');
      if (ui) ui.style.display = 'none';
      const input = document.getElementById('ig-token-input');
      if (input) input.value = '';
      toastSuccess('Disconnected from Instagram');
    };

    window.testInstagramConnection = async () => {
      const cfg = getIgConfig();
      if (!cfg?.token || !cfg?.ig_id) return toastError('Instagram is not connected');
      const btn = document.getElementById('ig-test-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Testing...'; }
      try {
        const data = await social.verifyInstagramDirect({ token: cfg.token, igId: cfg.ig_id });
        cfg.invalid = false;
        cfg.last_error = null;
        if (data.ig_username) cfg.ig_username = data.ig_username;
        if (data.ig_picture) cfg.ig_picture = data.ig_picture;
        _kvSaveSocialCfg('ig_config', cfg);
        const status = document.getElementById('ig-conn-status');
        if (status) { status.textContent = `✓ @${cfg.ig_username || data.ig_username || cfg.ig_id}`; status.style.color = 'var(--green-text,#2e7d32)'; }
        toastSuccess(`Instagram token works for @${cfg.ig_username || data.ig_username || cfg.ig_id}`);
      } catch (e) {
        cfg.invalid = true;
        cfg.last_error = e.message;
        _kvSaveSocialCfg('ig_config', cfg);
        const status = document.getElementById('ig-conn-status');
        if (status) { status.textContent = '✕ Reconnect required'; status.style.color = 'var(--red-text)'; }
        toastError('Instagram test failed: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Test'; }
      }
    };

    window.refreshIgToken = async () => {
      const cfg = getIgConfig();
      if (!cfg?.token) return toastError('Not connected');
      const btn = document.getElementById('ig-refresh-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
      try {
        const data = cfg.token_type?.startsWith('facebook_long_lived_user')
          ? await social.extendFacebookToken({ token: cfg.token, page_id: cfg.page_id })
          : await social.refreshInstagramToken(cfg.token);
        if (!data.success) throw new Error(data.error || 'Refresh failed');
        cfg.token = data.access_token;
        cfg.invalid = false;
        cfg.last_error = null;
        if (cfg.token_type?.startsWith('facebook_long_lived_user')) cfg.token_type = cfg.token_type.includes('direct') ? 'facebook_long_lived_user_direct' : 'facebook_long_lived_user';
        cfg.connected_at = new Date().toISOString();
        cfg.expires_at = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();
        _kvSaveSocialCfg('ig_config', cfg);
        toastSuccess('Token refreshed — valid for another 60 days');
      } catch (e) {
        cfg.invalid = true;
        cfg.last_error = e.message;
        _kvSaveSocialCfg('ig_config', cfg);
        const status = document.getElementById('ig-conn-status');
        if (status) { status.textContent = '✕ Reconnect required'; status.style.color = 'var(--red-text)'; }
        toastError('Refresh failed: ' + e.message + '. Get a new token from Graph API Explorer.');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '↺ Refresh token'; }
      }
    };

    // ── Facebook Shop connect flow ────────────────────────────
    let _fbData = null; // { pages, businesses } from API

    window.connectFacebook = async () => {
      const token = document.getElementById('fb-token-input')?.value?.trim();
      if (!token) return toastError('Paste your Page Access Token first');
      const btn = document.getElementById('fb-connect-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
      try {
        const data = await social.getMyFacebook(token);
        if (!data.success) throw new Error(data.error || 'Failed');
        _fbData = data;

        // Populate page selector
        const sel = document.getElementById('fb-page-select');
        if (sel) {
          sel.innerHTML = data.pages.map(p =>
            `<option value="${p.id}" data-biz-id="${_getBusinessForPage(p.id, data.businesses)}">${p.name}</option>`
          ).join('');
        }

        // Show connected UI
        const ui = document.getElementById('fb-connected-ui');
        if (ui) ui.style.display = '';

        // Auto-select first page and fetch its catalog
        const firstPage = data.pages[0];
        if (firstPage) await _autoSelectPage(token, firstPage.id, data.businesses);

        const status = document.getElementById('fb-conn-status');
        if (status) { status.textContent = `✓ ${firstPage?.name || 'Connected'}`; status.style.color = 'var(--green-text,#2e7d32)'; }
        toastSuccess('Connected to Facebook');
      } catch (e) {
        toastError('Facebook connect failed: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
      }
    };

    function _getBusinessForPage(pageId, businesses) {
      // Return first business id (pages don't directly map to businesses via this API)
      return businesses?.[0]?.business_id || '';
    }

    async function _autoSelectPage(token, pageId, businesses) {
      // Find catalogs across businesses
      let catalogId = null;
      let businessId = businesses?.[0]?.business_id;
      const allCatalogs = businesses?.flatMap(b => b.catalogs.map(c => ({ ...c, business_id: b.business_id }))) || [];

      if (allCatalogs.length > 0) {
        catalogId = allCatalogs[0].id;
        businessId = allCatalogs[0].business_id;
      } else if (businessId) {
        // No catalog → create one
        updateCatalogInfo('Creating catalog…');
        try {
          const r = await social.createFacebookCatalog({ token, business_id: businessId, name: 'My Shop Catalog' });
          if (r.success) catalogId = r.catalog_id;
        } catch { }
      }

      updateCatalogInfo(catalogId ? `<code class="code" style="font-size:11px">${catalogId}</code><span style="font-size:12px;color:var(--green-text,#2e7d32);margin-left:6px">✓ Ready</span>` : '<span class="text-muted text-sm">No catalog found</span>');

      const pageName = document.querySelector('#fb-page-select option:checked')?.textContent || '';
      const cfg = { token, page_id: pageId, page_name: pageName, catalog_id: catalogId, business_id: businessId };
      _kvSaveSocialCfg('fb_shop_config', cfg);
    }

    function updateCatalogInfo(html) {
      const el = document.getElementById('fb-catalog-info');
      if (el) el.innerHTML = html;
    }

    window.onFbPageChange = async (pageId) => {
      const token = document.getElementById('fb-token-input')?.value?.trim() || getFbConfig()?.token;
      if (!token || !_fbData) return;
      const pageName = document.querySelector('#fb-page-select option:checked')?.textContent || '';
      updateCatalogInfo('Loading…');
      await _autoSelectPage(token, pageId, _fbData.businesses);
      const cfg = getFbConfig();
      if (cfg) { cfg.page_id = pageId; cfg.page_name = pageName; _kvSaveSocialCfg('fb_shop_config', cfg); }
    };

    window.disconnectFacebook = () => {
      _kvDeleteSocialCfg('fb_shop_config');
      const status = document.getElementById('fb-conn-status');
      if (status) { status.textContent = 'Not connected'; status.style.color = 'var(--text-3)'; }
      const ui = document.getElementById('fb-connected-ui');
      if (ui) ui.style.display = 'none';
      const input = document.getElementById('fb-token-input');
      if (input) input.value = '';
      toastSuccess('Disconnected from Facebook');
    };
  }

  if (tabIdx === 4) {
    const setMakeStatus = (text, color = 'var(--text-3)') => {
      const el = document.getElementById('make-webhook-status');
      if (el) { el.textContent = text; el.style.color = color; }
    };

    window.saveMakeWebhook = async () => {
      const url = document.getElementById('s-make-url')?.value?.trim();
      if (!url) { toastError('Paste Make.com webhook URL first'); return false; }
      if (!/^https:\/\/hook\.[^\s]+make\.com\//.test(url)) {
        toastError('This does not look like a Make.com webhook URL');
        return false;
      }
      const cfg = { webhook_url: url, connected_at: new Date().toISOString() };
      try {
        await _kvSaveSocialCfg('make_config', cfg);
        setMakeStatus('✓ Saved in shared settings. Pinterest scheduler will use this Make webhook.', 'var(--green-text,#2e7d32)');
        toastSuccess('Make.com webhook saved');
        return true;
      } catch (e) {
        setMakeStatus('✕ ' + e.message, 'var(--red-text)');
        toastError('Save failed: ' + e.message);
        return false;
      }
    };

    window.deleteMakeWebhook = async () => {
      await _kvDeleteSocialCfg('make_config');
      const input = document.getElementById('s-make-url');
      if (input) input.value = '';
      setMakeStatus('Not configured. Paste your Make webhook URL and click Save.');
      toastSuccess('Make.com webhook removed');
    };

    window.testMakeWebhook = async () => {
      const url = document.getElementById('s-make-url')?.value?.trim();
      if (url && !await window.saveMakeWebhook()) return;
      setMakeStatus('Testing Make.com webhook...', 'var(--text-2)');
      try {
        const data = await social.sendToMake({
          platform: 'pinterest',
          title: 'EM - Shop Manager Pro Test Pin',
          text: 'Test webhook from EM - Shop Manager Pro settings.',
          imageUrl: 'https://picsum.photos/seed/etsy-manager-settings/1000/1500',
          link: 'https://www.etsy.com',
          listing_id: 'test-settings',
        });
        if (!data.success) throw new Error(data.message || `Make.com returned ${data.status || 'an error'}`);
        setMakeStatus(`✓ Test sent to Make.com (${data.source || 'configured'} config)`, 'var(--green-text,#2e7d32)');
        toastSuccess('Make.com webhook fired');
      } catch (e) {
        setMakeStatus('✕ ' + e.message, 'var(--red-text)');
        toastError('Make.com test failed: ' + e.message);
      }
    };

    window.testCrosspost = async (service) => {
      toastInfo(`Testing ${service}…`);
      try {
        const actions = { buffer: 'postBuffer', metricool: 'postMetricool' };
        const action = actions[service];
        if (!action) { toastInfo(`${service}: set credentials in .env`); return; }
        const res = await fetch('/api/social', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, text: 'Test from EM - Shop Manager Pro', profile_ids: [], platform: service === 'make' ? 'pinterest' : undefined })
        });
        const data = await res.json();
        if (data.error?.includes('not set')) toastError(`${service}: ${data.error}`);
        else toastSuccess(`${service}: connection OK`);
      } catch (e) { toastError(e.message); }
    };
    window.testWebhook = async (service) => {
      const urlEl = document.getElementById(`s-${service}-url`);
      const url = urlEl?.value?.trim();
      if (!url) { toastError('Enter webhook URL first'); return; }
      try {
        await fetch('/api/social', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: service === 'make' ? 'sendToMake' : 'sendToZapier',
            listingId: 'test', title: 'Test listing', price: '5.99', url: 'https://etsy.com', timestamp: new Date().toISOString()
          })
        });
        toastSuccess(`${service} webhook fired`);
      } catch (e) { toastError(e.message); }
    };

    _kvRefreshSocialCfgs().then(() => {
      const cfg = getMakeConfig();
      const input = document.getElementById('s-make-url');
      if (cfg?.webhook_url && input && !input.value) input.value = cfg.webhook_url;
      if (cfg?.webhook_url) setMakeStatus('✓ Saved in shared settings. Pinterest scheduler will use this Make webhook.', 'var(--green-text,#2e7d32)');
    });

    window.loadBufferProfiles = async () => {
      const tokenEl = document.getElementById('s-buffer-token');
      const token = tokenEl?.value?.trim();
      const resultEl = document.getElementById('buffer-profiles-result');
      if (!token) { toastError('Enter a Buffer access token first'); return; }
      if (resultEl) resultEl.innerHTML = '<div class="loading-center" style="padding:8px 0"><div class="spinner"></div> Fetching profiles…</div>';
      try {
        const res = await fetch('/api/social', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'getBufferProfiles', token })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const profiles = data.profiles || [];
        if (!profiles.length) {
          if (resultEl) resultEl.innerHTML = '<div class="alert alert-warning" style="font-size:12px;margin:0">No profiles found. Make sure you have connected social accounts in Buffer.</div>';
          return;
        }
        const ids = profiles.map(p => p.id).join(',');
        const profilesEl = document.getElementById('s-buffer-profiles');
        if (profilesEl) profilesEl.value = ids;
        if (resultEl) resultEl.innerHTML = `
          <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px;font-size:12px">
            <div style="font-weight:600;margin-bottom:6px;color:var(--green-text)">✓ Found ${profiles.length} profile${profiles.length !== 1 ? 's' : ''}</div>
            ${profiles.map(p => `<div style="display:flex;gap:8px;align-items:center;padding:3px 0">
              <span class="badge badge-gray" style="font-family:monospace;font-size:10px">${p.id}</span>
              <span style="color:var(--text-2)">${p.name} (${p.service})</span>
            </div>`).join('')}
            <div style="margin-top:8px;color:var(--text-3)">Profile IDs auto-filled above. Copy them to your <code class="code">.env.local</code>.</div>
          </div>`;
        toastSuccess(`Loaded ${profiles.length} Buffer profile${profiles.length !== 1 ? 's' : ''}`);
      } catch (e) {
        if (resultEl) resultEl.innerHTML = `<div class="alert alert-error" style="font-size:12px;margin:0">${escHtml(e.message)}</div>`;
        toastError('Failed to load profiles: ' + e.message);
      }
    };
  }

  if (tabIdx === 5) {
    window.loadSettingsContext = async (force = false) => {
      const el = document.getElementById('ctx-content');
      const previewEl = document.getElementById('ctx-preview');
      if (el) el.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
      try {
        const ctx = await getShopContext(force);
        const age = Math.round((Date.now() - ctx.timestamp) / 60000);
        if (el) el.innerHTML = `
          <div class="stats-grid" style="margin-bottom:12px">
            ${[
            ['Listings analysed', ctx.listings?.length || 0],
            ['Boilerplate blocks found', ctx.boilerplateBlocks?.length || 0],
            ['Personalization patterns', ctx.personalizationPatterns?.length || 0],
            ['Top tags tracked', ctx.topTags?.length || 0],
          ].map(([l, v]) => `<div class="stat-card"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join('')}
          </div>
          <div class="text-sm text-muted">Last updated: ${age < 1 ? 'just now' : age + ' minutes ago'} · refreshes every 30 min automatically</div>
          ${ctx.boilerplateBlocks?.length ? `
            <div class="divider"></div>
            <div style="font-size:12px;font-weight:600;margin-bottom:6px">Detected boilerplate blocks:</div>
            ${ctx.boilerplateBlocks.map(b => `
              <details style="margin-bottom:6px">
                <summary style="font-size:12px;cursor:pointer;padding:6px 8px;background:var(--bg-secondary);border-radius:var(--radius)">
                  ${b.label} <span class="badge badge-gray" style="font-size:10px">${b.count} listings</span>
                </summary>
                <pre style="font-size:11px;white-space:pre-wrap;padding:8px;background:var(--bg-page);border-radius:0 0 var(--radius) var(--radius);color:var(--text-2)">${escHtml(b.text.slice(0, 300))}</pre>
              </details>`).join('')}` : ''}
          ${ctx.personalizationPatterns?.length ? `
            <div class="divider"></div>
            <div style="font-size:12px;font-weight:600;margin-bottom:6px">Personalization instructions (auto-injected):</div>
            ${ctx.personalizationPatterns.slice(0, 2).map(p => `
              <div style="font-size:11px;font-family:monospace;background:var(--orange-light);border:1px solid var(--orange-border);border-radius:var(--radius);padding:8px;margin-bottom:6px;color:var(--text-2)">${escHtml(p.text?.slice(0, 200))}...</div>`).join('')}` : ''}`;

        if (previewEl) previewEl.value = buildContextPrompt(ctx);
        if (force) toastSuccess('Context refreshed');
      } catch (e) {
        if (el) el.innerHTML = `<div class="alert alert-error">${escHtml(e.message)}</div>`;
      }
    };
    window.clearSettingsContext = () => {
      clearShopContext();
      toastSuccess('Context cache cleared — will re-fetch on next generation');
      window.loadSettingsContext(false);
    };
    window.loadSettingsContext(false);
  }
}

async function checkTokenStatus() {
  try {
    const status = await etsy.getTokenStatus();
    const el = document.getElementById('token-timer');
    if (!el) return;
    const secs = status.expires_in_seconds || 0;
    el.className = secs > 300 ? 'token-timer' : secs > 0 ? 'token-timer expiring' : 'token-timer expired';
    el.textContent = status.last_error ? `Token issue: ${status.last_error}` : secs > 0 ? `Expires in ${Math.floor(secs / 60)}m ${secs % 60}s` : 'Expired';
    if (secs > 0) setTimeout(checkTokenStatus, 30000);
  } catch { }
}

async function checkEtsyConnectionStatus() {
  const el = document.getElementById('etsy-connection-status');
  if (!el) return;
  el.className = 'alert alert-info';
  el.textContent = 'Checking Etsy connection...';
  try {
    const [status, shop] = await Promise.all([
      etsy.getTokenStatus().catch(() => null),
      etsy.getShop(),
    ]);
    const refreshText = status?.has_refresh_token ? 'auto-refresh enabled' : 'access token only';
    const envText = status?.using_env_token ? 'environment token' : 'saved OAuth token';
    el.className = 'alert alert-success';
    el.innerHTML = `✓ Connected to <strong>${escHtml(shop.shop_name || shop.name || shop.shop_id || 'Etsy shop')}</strong> <span class="text-muted">(${escHtml(refreshText)}, ${escHtml(envText)})</span>`;
  } catch (err) {
    el.className = 'alert alert-error';
    el.innerHTML = `✕ Etsy not connected: ${escHtml(err.message || err)}. Use <strong>Connect Etsy</strong> to reconnect.`;
  }
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
