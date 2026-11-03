import { escHtml } from './format.js';

export function publishReadinessPresentation(report = {}) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  const ready = report.ready === true;
  const requiredLabel = `${blockers.length} item${blockers.length === 1 ? '' : 's'} need attention`;
  const requiredTitle = `${blockers.length} required item${blockers.length === 1 ? '' : 's'} missing`;
  return {
    ready,
    markup: `
      <div class="create-readiness-heading">
        <div><span class="create-readiness-kicker">Publish readiness</span><strong>${ready ? 'Ready for Etsy' : requiredLabel}</strong></div>
        <span class="create-readiness-count">${checks.filter(check => check.ready).length}/${checks.length}</span>
      </div>
      <div class="create-readiness-list">${checks.map(check => `
        <button type="button" class="create-readiness-row ${check.ready ? 'is-ready' : 'is-blocked'}" data-readiness-key="${check.key}" onclick="window.focusCreateReadinessField('${check.key}')">
          <span class="create-readiness-icon">${check.ready ? '✓' : '!'}</span>
          <span>${escHtml(check.label)}</span>
          <span>${escHtml(check.detail || (check.ready ? 'Ready' : 'Required'))}</span>
        </button>`).join('')}</div>`,
    badgeText: ready ? 'Ready' : `${blockers.length} required`,
    badgeTitle: ready ? 'Ready to create on Etsy' : 'Go to the first required field',
    publishButtonTitle: ready ? 'Create this listing in Etsy drafts' : requiredTitle,
  };
}
