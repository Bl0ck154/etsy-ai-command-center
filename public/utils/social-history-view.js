import { escHtml } from './format.js';
import {
  filterAndSortHistory,
  historyStatusBadge,
  historyStatusLabel,
} from './social-view-model.js';

export function socialPagerHtml({ currentPage, totalPages, start, end, total, onPage, label }) {
  if (totalPages <= 1) {
    return `<div style="font-size:11px;color:var(--text-3)">${total ? `${start}-${end} of ${total}` : ''}</div>`;
  }
  return `<nav aria-label="${escHtml(label)}" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--text-3)">
    <span>${start}-${end} of ${total} · Page ${currentPage}/${totalPages}</span>
    <span style="display:flex;gap:5px">
      <button type="button" class="btn btn-sm" style="width:30px;height:28px;padding:0" aria-label="Previous page" title="Previous page" onclick="${onPage}(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>←</button>
      <button type="button" class="btn btn-sm" style="width:30px;height:28px;padding:0" aria-label="Next page" title="Next page" onclick="${onPage}(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>→</button>
    </span>
  </nav>`;
}

export function socialHistoryPresentation(history = [], {
  platform = 'all',
  status = 'all',
  sort = 'newest',
  page = 1,
  pageSize = 10,
  platforms = [],
  formatDate = () => '',
} = {}) {
  if (!history.length) {
    return {
      currentPage: page,
      totalPages: 1,
      html: '<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">Published and queued posts will appear here</div>',
    };
  }
  const items = filterAndSortHistory(history, { platform, status, sort });
  if (!items.length) {
    return {
      currentPage: page,
      totalPages: 1,
      html: '<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">No posts match these filters</div>',
    };
  }
  const safePageSize = Math.max(1, Number(pageSize) || 10);
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (currentPage - 1) * safePageSize;
  const pageItems = items.slice(start, start + safePageSize);
  const counts = history.reduce((acc, item) => {
    const itemStatus = String(item.status || 'published').toLowerCase();
    const key = itemStatus === 'queued_external' ? 'queued' : itemStatus;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const workflowSummary = `<div class="social-workflow-summary" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)">
    ${[['draft', 'Drafts'], ['owner_review', 'Needs review'], ['scheduled', 'Scheduled'], ['queued', 'Sending'], ['published', 'Published'], ['failed', 'Failed']].map(([key, label]) => `<button type="button" class="badge ${historyStatusBadge(key)}" data-history-status-shortcut="${key}" style="border:1px solid var(--border);cursor:pointer" title="Show ${label.toLowerCase()}" onclick="window.__socialHistoryStatus('${key}')">${label}: ${counts[key] || 0}</button>`).join('')}
  </div>`;
  const rows = pageItems.map(item => {
    const platformMeta = platforms.find(candidate => candidate.id === item.platform);
    const itemStatus = item.status || 'published';
    return `
      <div data-social-history-item style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
        <div class="row-between" style="gap:8px;align-items:flex-start">
          <div style="display:flex;align-items:flex-start;gap:7px;min-width:0;flex:1">
            <span style="background:${platformMeta?.color || '#888'};width:18px;height:18px;font-size:9px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;color:#fff;flex-shrink:0;margin-top:1px">${escHtml((item.platform || '?')[0].toUpperCase())}</span>
            <div style="min-width:0;flex:1">
              <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--text)">${escHtml(item.listing || 'Untitled listing')}</div>
              <div style="font-size:11px;color:var(--text-3);display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">
                <span>${escHtml(platformMeta?.name || item.platform || 'Unknown')}</span>
                <span>via ${escHtml(item.service || 'direct')}</span>
                <span>${escHtml(item.date || formatDate(item._postedAt))}</span>
              </div>
              ${item.error ? `<div style="font-size:11px;color:var(--red-text);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(item.error)}">${escHtml(item.error)}</div>` : ''}
              ${item.review_url ? `<div style="margin-top:4px"><a href="${escHtml(item.review_url)}" style="font-size:11px;color:var(--accent);font-weight:600">Review in Schedule</a></div>` : ''}
            </div>
          </div>
          <div class="row" style="gap:6px;flex-shrink:0;justify-content:flex-end">
            <span class="badge ${historyStatusBadge(itemStatus)}" style="font-size:10px">${escHtml(historyStatusLabel(itemStatus))}</span>
            ${item.post_url ? `<a href="${escHtml(item.post_url)}" target="_blank" rel="noopener" class="badge badge-green" style="font-size:10px;text-decoration:none">View</a>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
  const pager = socialPagerHtml({
    currentPage,
    totalPages,
    start: start + 1,
    end: Math.min(start + pageItems.length, items.length),
    total: items.length,
    onPage: 'window.__socialHistoryPage',
    label: 'Post history pages',
  });
  return {
    currentPage,
    totalPages,
    html: `${workflowSummary}${rows}<div style="padding-top:10px">${pager}</div>`,
  };
}
