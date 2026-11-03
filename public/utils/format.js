// public/utils/format.js — Formatting helpers

export function price(amount, divisor = 100) {
  return `$${(amount / divisor).toFixed(2)}`;
}

export function truncate(str, max = 60) {
  if (!str) return '';
  const clean = str.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

export function timeAgo(timestamp) {
  const diff = Date.now() - timestamp * 1000;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function formatDate(timestamp) {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function number(n) {
  return (n || 0).toLocaleString('en-US');
}

export function listingState(state) {
  const map = { active: { label: 'Active', cls: 'badge-green' }, inactive: { label: 'Inactive', cls: 'badge-gray' }, draft: { label: 'Draft', cls: 'badge-orange' }, expired: { label: 'Expired', cls: 'badge-red' }, sold_out: { label: 'Sold out', cls: 'badge-red' } };
  return map[state] || { label: state, cls: 'badge-gray' };
}

export function listingType(type) {
  const map = { download: { label: 'Digital', cls: 'badge-orange' }, physical: { label: 'Physical', cls: 'badge-blue' } };
  return map[type] || { label: type, cls: 'badge-gray' };
}

export function receiptState(paid, shipped, completed) {
  if (completed) return { label: 'Completed', cls: 'badge-gray' };
  if (shipped) return { label: 'Shipped', cls: 'badge-blue' };
  if (paid) return { label: 'Paid', cls: 'badge-green' };
  return { label: 'Open', cls: 'badge-orange' };
}

export function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

export function escAttr(str) {
  return escHtml(str).replace(/`/g, '&#96;');
}

export function escJsSingle(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ');
}

export function textToSimpleHtml(str) {
  return escHtml(str)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

export function tagCount(tags) {
  return `${(tags || []).length}/13`;
}

export function charCount(str, max) {
  const len = (str || '').length;
  return { count: len, over: len > max, label: `${len}/${max}` };
}
