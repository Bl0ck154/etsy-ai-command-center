import { escHtml } from './format.js';

const GUIDANCE_RULE_LABELS = Object.freeze({
  title: 'Titles',
  discovery: 'Search discovery',
  description: 'Descriptions',
  photos: 'Photos',
});

export function guidanceDateLabel(value) {
  if (!value) return 'Not checked yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function guidanceRuleDiffMarkup(candidate, active, {
  escapeHtml = escHtml,
} = {}) {
  if (!candidate?.rules) return '';
  return Object.entries(GUIDANCE_RULE_LABELS).map(([group, label]) => {
    const activeRules = new Set(
      (active?.rules?.[group] || []).map(rule => String(rule).toLocaleLowerCase()),
    );
    const rules = candidate.rules[group] || [];
    return `
      <div style="margin-top:9px">
        <div style="font-size:12px;font-weight:600">${label}</div>
        <ul style="margin:5px 0 0;padding-left:18px;font-size:12px;color:var(--text-2);line-height:1.5">
          ${rules.map(rule => `<li>${activeRules.has(String(rule).toLocaleLowerCase()) ? '' : '<strong style="color:var(--orange)">New:</strong> '}${escapeHtml(rule)}</li>`).join('')}
        </ul>
      </div>`;
  }).join('');
}

export function etsyGuidanceStatusPresentation(data, {
  escapeHtml = escHtml,
  formatDate = guidanceDateLabel,
} = {}) {
  const active = data?.active;
  const candidate = data?.candidate;
  const monitor = data?.monitor || {};
  const statusColor = monitor.lastError
    ? 'var(--red-text)'
    : candidate
      ? 'var(--orange)'
      : monitor.stale
        ? 'var(--orange)'
        : 'var(--green-text)';
  const statusText = monitor.lastError
    ? 'Last check failed'
    : candidate
      ? 'Update awaiting review'
      : monitor.stale
        ? 'Official sources need checking'
        : 'Current';
  const sources = (data?.officialSources || []).map(source => (
    `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--orange)">${escapeHtml(source.label)}</a>`
  )).join(' · ');

  return {
    statusColor,
    statusText,
    markup: `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px">
      <div style="padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px">
        <div style="font-size:11px;color:var(--text-3)">Active revision</div>
        <div style="font-size:13px;font-weight:600;margin-top:3px">${escapeHtml(active?.reviewedAt || 'Bundled fallback')}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">${escapeHtml(active?.origin || 'bundled')}</div>
      </div>
      <div style="padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px">
        <div style="font-size:11px;color:var(--text-3)">Official-source check</div>
        <div style="font-size:13px;font-weight:600;margin-top:3px;color:${statusColor}">${statusText}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">${escapeHtml(formatDate(monitor.lastCheckedAt))}</div>
      </div>
    </div>
    ${monitor.lastError ? `<div class="alert alert-error" style="font-size:12px;margin-top:10px">${escapeHtml(monitor.lastError)}</div>` : ''}
    <div style="font-size:11px;color:var(--text-3);line-height:1.5;margin-top:9px">Automatic check: ${escapeHtml(monitor.nextAutomaticCheck || 'monthly')}. Active rules remain unchanged if fetching, AI extraction, evidence validation, or approval fails.</div>
    <div style="font-size:11px;line-height:1.5;margin-top:7px">${sources}</div>
    ${candidate ? `
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="font-size:13px;font-weight:700">Proposed revision: ${escapeHtml(candidate.reviewedAt || candidate.id)}</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.5;margin-top:5px">${escapeHtml(candidate.changeSummary || 'Official guidance changes detected.')}</div>
        <details style="margin-top:8px">
          <summary style="font-size:12px;cursor:pointer;color:var(--orange)">Review rule changes and evidence</summary>
          ${guidanceRuleDiffMarkup(candidate, active, { escapeHtml })}
          <div style="font-size:11px;color:var(--text-3);margin-top:8px">${candidate.evidence?.length || 0} source excerpts validated.</div>
        </details>
        <div class="row" style="gap:7px;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" id="etsy-guidance-approve" onclick="window.approveEtsyGuidance()">Activate revision</button>
          <button class="btn btn-sm" id="etsy-guidance-dismiss" onclick="window.dismissEtsyGuidance()">Dismiss</button>
        </div>
      </div>` : ''}
    ${active?.origin !== 'bundled' ? `
      <button class="btn btn-sm" style="margin-top:10px" onclick="window.restoreBundledEtsyGuidance()">Restore bundled fallback</button>
    ` : ''}`,
  };
}
