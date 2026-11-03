import { escHtml } from './format.js';

const MEMORY_CATEGORY_COLORS = Object.freeze({
  preference: 'var(--orange)',
  rule: 'var(--red-text)',
  fact: 'var(--text-3)',
  context: 'var(--blue-text, #3b82f6)',
});

export function agentMemoryPanelsPresentation(personalItems = [], shopItems = [], {
  escapeHtml = escHtml,
} = {}) {
  const personal = Array.isArray(personalItems) ? personalItems : [];
  const shop = Array.isArray(shopItems) ? shopItems : [];
  const total = personal.length + shop.length;
  const personalMarkup = personal.length
    ? personal.map(item => `
        <div class="agent-memory-item">
          <span class="agent-memory-category" style="color:${MEMORY_CATEGORY_COLORS[item.category] || 'var(--text-3)'}">${escapeHtml(item.category || 'fact')}</span>
          <span class="agent-memory-copy">${escapeHtml(item.text)}</span>
          <button onclick="window.__deleteMemory('${escapeHtml(item.id)}')" class="agent-memory-delete" title="Forget personal memory" aria-label="Forget personal memory">&times;</button>
        </div>`).join('')
    : '<div class="agent-memory-empty">No personal preferences saved.</div>';
  const shopMarkup = shop.length
    ? shop.map(item => `
        <div class="agent-memory-item">
          <span class="agent-memory-category">${escapeHtml(item.category || 'rule')}</span>
          <span class="agent-memory-copy">${escapeHtml(item.summary || item.details || '')}</span>
          <button onclick="window.__deleteShopMemory('${escapeHtml(item.id)}')" class="agent-memory-delete" title="Forget shared shop memory" aria-label="Forget shared shop memory">&times;</button>
        </div>`).join('')
    : '<div class="agent-memory-empty">No shared shop rules saved.</div>';
  return {
    total,
    badgeText: total ? String(total) : '',
    personalMarkup,
    shopMarkup,
  };
}

export function agentHistoryPanelPresentation(sessions = [], currentSessionId = '', {
  escapeHtml = escHtml,
  formatDate = value => new Date(value).toLocaleString(),
} = {}) {
  const past = (Array.isArray(sessions) ? [...sessions] : [])
    .sort((left, right) => Number(right.last_at || 0) - Number(left.last_at || 0))
    .filter(session => session.id !== currentSessionId);
  if (!past.length) {
    return {
      count: 0,
      sessions: [],
      markup: '<div style="font-size:12px;color:var(--text-3)">No past conversations.</div>',
    };
  }
  return {
    count: past.length,
    sessions: past,
    markup: past.map(session => `
      <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;cursor:pointer"
           onclick="window.__loadHistorySession('${session.id}')">
        <div style="flex:1;min-width:0">
          <div style="font-size:10px;color:var(--text-3);margin-bottom:2px">${formatDate(session.last_at)}</div>
          <div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(session.preview || 'Conversation')}</div>
        </div>
        <button style="font-size:11px;background:none;border:none;cursor:pointer;color:var(--text-3);flex-shrink:0;padding:2px 6px"
                onclick="event.stopPropagation();window.__deleteHistorySession('${session.id}')">Delete</button>
      </div>`).join(''),
  };
}
