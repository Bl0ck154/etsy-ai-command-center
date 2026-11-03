// public/utils/token-manager.js
// Background token auto-refresh + live countdown in UI

const CHECK_INTERVAL_MS  = 30_000;  // check every 30s
const REFRESH_BEFORE_SEC = 300;     // refresh when < 5 min left — more breathing room

let timer        = null;
let expiresAt    = 0;
let onExpiryCbs  = [];
let onRefreshCbs = [];
let countdownTimer = null;  // single instance

export function startTokenManager() {
  stopTokenManager();
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  tick(); // immediate first check
}

export function stopTokenManager() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function onTokenExpiring(cb) { onExpiryCbs.push(cb); }
export function onTokenRefreshed(cb) { onRefreshCbs.push(cb); }

export function getExpiresAt() { return expiresAt; }
export function getSecondsLeft() {
  return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}

async function tick() {
  try {
    const res  = await fetch('/api/auth');
    const data = await res.json();

    if (data.expires_at) {
      expiresAt = data.expires_at;
    } else if (data.expires_in_seconds !== undefined) {
      expiresAt = Date.now() + data.expires_in_seconds * 1000;
    }

    const secsLeft = getSecondsLeft();
    updateAllCountdowns(secsLeft);

    // Auto-refresh if about to expire
    if (secsLeft > 0 && secsLeft < REFRESH_BEFORE_SEC) {
      await refreshNow();
    } else if (secsLeft <= 0) {
      onExpiryCbs.forEach(cb => cb());
    }
  } catch {
    // Server might be waking up — skip silently
  }
}

export async function refreshNow() {
  try {
    const res  = await fetch('/api/auth', { method: 'POST' });
    const data = await res.json();
    if (data.expires_at) {
      expiresAt = data.expires_at;
    } else if (data.expires_in_seconds) {
      expiresAt = Date.now() + data.expires_in_seconds * 1000;
    }
    const secsLeft = getSecondsLeft();
    updateAllCountdowns(secsLeft);
    onRefreshCbs.forEach(cb => cb(secsLeft));
    return true;
  } catch {
    return false;
  }
}

// ── Live countdown ─────────────────────────────────────────
// Any element with data-token-timer attribute gets updated automatically


export function startCountdownUI() {
  if (countdownTimer) return;  // already running — don't stack
  countdownTimer = setInterval(() => {
    updateAllCountdowns(getSecondsLeft());
  }, 1000);
}

function updateAllCountdowns(secs) {
  document.querySelectorAll('[data-token-timer]').forEach(el => {
    if (secs <= 0) {
      el.className = 'token-timer expired';
      el.textContent = 'Token expired';
    } else if (secs < 120) {
      el.className = 'token-timer expiring';
      el.textContent = `Token: ${Math.floor(secs / 60)}m ${secs % 60}s`;
    } else {
      el.className = 'token-timer';
      el.textContent = `Token: ${Math.floor(secs / 60)}m`;
    }
  });
}
