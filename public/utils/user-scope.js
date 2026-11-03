const AUTH_USER_KEY = 'etsy_mgr_auth_user';
const ACTIVE_SHOP_KEY = 'etsy_mgr_active_shop';

export function normalizeScopeSegment(value, fallback = 'default') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

export function setCurrentAuthUser(user = {}) {
  const normalized = {
    id: normalizeScopeSegment(user.id, 'anonymous'),
    name: String(user.name || user.id || '').trim().slice(0, 80),
  };
  window.__etsyManagerAuthUser = normalized;
  try { sessionStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalized)); } catch {}
  return normalized;
}

export function clearCurrentAuthUser() {
  delete window.__etsyManagerAuthUser;
  try { sessionStorage.removeItem(AUTH_USER_KEY); } catch {}
}

export function currentAuthUser() {
  if (window.__etsyManagerAuthUser?.id) return window.__etsyManagerAuthUser;
  try {
    const stored = JSON.parse(sessionStorage.getItem(AUTH_USER_KEY) || 'null');
    if (stored?.id) return stored;
  } catch {}
  return { id: 'anonymous', name: '' };
}

export function currentWorkspaceScope() {
  let shopId = 'default_shop';
  try { shopId = sessionStorage.getItem(ACTIVE_SHOP_KEY) || shopId; } catch {}
  return workspaceScopeFor(currentAuthUser().id, shopId);
}

export function workspaceScopeFor(userId, shopId) {
  return `${normalizeScopeSegment(userId, 'anonymous')}:${normalizeScopeSegment(shopId, 'default_shop')}`;
}

export function scopedClientKey(key) {
  return `${String(key || '')}::${currentWorkspaceScope()}`;
}
