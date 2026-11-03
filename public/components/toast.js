// public/components/toast.js — Toast notification system

export function initToasts() {
  if (!document.getElementById('toast-container')) {
    const el = document.createElement('div');
    el.id = 'toast-container';
    document.body.appendChild(el);
  }
}

export function toast(message, type = 'info', duration) {
  initToasts();
  const icons = {
    success: '✓',
    error: '✕',
    info: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="display:block"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="4.5" r="0.75" fill="currentColor"/></svg>',
  };
  // Errors stay visible longer so users have time to read them
  const ms = duration ?? (type === 'error' ? 10000 : 4200);
  const id = Date.now();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.id = `toast-${id}`;
  el.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-text">${message}</span>
    <button class="toast-close" onclick="document.getElementById('toast-${id}')?.remove()">×</button>
    <div class="toast-progress"></div>
  `;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export const toastSuccess = (msg, duration) => toast(msg, 'success', duration);
export const toastError = (msg, duration) => toast(msg, 'error', duration);
export const toastInfo = (msg, duration) => toast(msg, 'info', duration);

// ── Persistent error log ───────────────────────────────────
const errorLog = [];

export function getErrorLog() { return [...errorLog]; }
export function clearErrorLog() { errorLog.length = 0; updateErrorBadge(); }

function updateErrorBadge() {
  const badge = document.getElementById('error-log-badge');
  if (!badge) return;
  const count = errorLog.length;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

export function showErrorLog() {
  const { openModal, setModalBody } = window.__modalModule || {};
  const body = document.getElementById('app');
  if (!errorLog.length) { toastInfo('No errors logged'); return; }

  // Simple overlay
  const existing = document.getElementById('error-log-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.id = 'error-log-overlay';
  overlay.style.cssText = 'position:fixed;bottom:60px;right:16px;width:420px;max-height:320px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:0 8px 32px rgba(0,0,0,0.15);z-index:999;overflow:hidden;display:flex;flex-direction:column';
  overlay.innerHTML = `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:12px;font-weight:600">Error log (${errorLog.length})</span>
      <div style="display:flex;gap:8px">
        <button onclick="clearErrorLog();document.getElementById('error-log-overlay')?.remove()" style="font-size:11px;background:none;border:none;cursor:pointer;color:var(--text-3)">Clear</button>
        <button onclick="document.getElementById('error-log-overlay')?.remove()" style="font-size:11px;background:none;border:none;cursor:pointer;color:var(--text-3)">✕</button>
      </div>
    </div>
    <div style="overflow-y:auto;padding:8px">
      ${errorLog.map(e => `
        <div style="font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--red-bg,rgba(239,68,68,0.08));border-radius:var(--radius-sm);border-left:3px solid var(--red,#ef4444)">
          <div style="color:var(--text-3);margin-bottom:2px">${e.time}</div>
          <div style="color:var(--text)">${e.msg}</div>
        </div>`).join('')}
    </div>`;
  document.body.appendChild(overlay);
  // Close on outside click
  setTimeout(() => document.addEventListener('click', function h(e) {
    if (!overlay.contains(e.target)) { overlay.remove(); document.removeEventListener('click', h); }
  }), 100);
}

if (typeof window !== 'undefined') {
  window.showErrorLog = showErrorLog;
  window.clearErrorLog = clearErrorLog;
}
