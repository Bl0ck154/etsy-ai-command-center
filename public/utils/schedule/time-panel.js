import { escHtml } from '../format.js';
import { scheduleTimeDetails } from './time.js';

export function scheduleTimePanelMarkup(val, post = {}, label = 'Scheduled', {
  timeFormat = '12',
  escapeHtml = escHtml,
} = {}) {
  const details = scheduleTimeDetails(val, post, { timeFormat });
  if (!details) return '';
  return `<aside class="sched-time-panel" aria-label="${escapeHtml(label)} time">
    <div class="sched-time-primary">
      <span class="sched-time-label">${escapeHtml(label)} · Kyiv</span>
      <strong class="sched-time-primary-value">${escapeHtml(details.ownerTime)}</strong>
      <span class="sched-time-date">${escapeHtml(details.ownerDate)}</span>
    </div>
    <div class="sched-time-audience">
      <span class="sched-time-audience-label">US audience · ${escapeHtml(details.audienceLabel)}</span>
      <strong class="sched-time-audience-value">${escapeHtml(details.audienceTime)}</strong>
      <span class="sched-time-audience-date">${escapeHtml(details.audienceDate)}</span>
    </div>
  </aside>`;
}
