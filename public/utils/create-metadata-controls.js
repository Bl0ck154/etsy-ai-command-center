import { escHtml } from './format.js';

export function shippingProfileControlMarkup({
  status = 'idle',
  profiles = [],
  selectedValue = '',
} = {}) {
  if (status === 'loading') {
    return '<div class="create-meta-state"><span class="spinner"></span> Loading shipping profiles...</div>';
  }
  if (status === 'failed') {
    return '<div class="create-meta-state is-error"><span>Could not load shipping profiles.</span><button type="button" class="btn btn-sm" onclick="window.retryShippingProfiles()">Retry</button></div>';
  }
  if (!profiles.length) {
    return '<div class="create-meta-state is-warning">No shipping profiles exist for this shop. <a href="https://www.etsy.com/your/shops/me/tools/shipping-profiles" target="_blank" rel="noopener">Manage on Etsy ↗</a></div><input type="hidden" id="e-shipping" value="">';
  }
  const options = profiles.map(profile => (
    `<option value="${profile.shipping_profile_id}" ${String(selectedValue) === String(profile.shipping_profile_id) ? 'selected' : ''}>${escHtml(profile.title)}</option>`
  )).join('');
  return `<select id="e-shipping"><option value="">Select a profile...</option>${options}</select>`;
}

export function defaultReadinessProfileId(listing = {}, profiles = []) {
  if (Number(listing.readiness_state_id) > 0) return Number(listing.readiness_state_id);
  const madeToOrder = (listing.when_made || 'made_to_order') === 'made_to_order';
  const exactLegacyDefault = profiles.find(profile => (
    profile.readiness_state === (madeToOrder ? 'made_to_order' : 'ready_to_ship')
    && Number(profile.min_processing_days) === 1
    && Number(profile.max_processing_days) === 7
  ));
  return exactLegacyDefault?.readiness_state_id || null;
}

export function readinessProfileControlMarkup({
  status = 'idle',
  profiles = [],
  selectedValue = '',
} = {}) {
  if (status === 'loading') {
    return '<div class="create-meta-state"><span class="spinner"></span> Loading processing profiles...</div>';
  }
  if (status === 'failed') {
    return '<div class="create-meta-state is-error"><span>Could not load processing profiles.</span><button type="button" class="btn btn-sm" onclick="window.retryReadinessProfiles()">Retry</button></div>';
  }
  if (!profiles.length) {
    return '<div class="create-meta-state is-warning">No processing profiles exist for this shop. <a href="https://www.etsy.com/your/shops/me/tools/shipping-profiles" target="_blank" rel="noopener">Manage on Etsy ↗</a></div><input type="hidden" id="e-readiness" value="">';
  }
  const options = profiles.map(profile => {
    const stateLabel = profile.readiness_state === 'ready_to_ship'
      ? 'Ready to ship'
      : 'Made to order';
    const timeLabel = profile.processing_days_display_label
      || `${profile.min_processing_days || '?'}-${profile.max_processing_days || '?'} days`;
    return `<option value="${profile.readiness_state_id}" ${String(selectedValue) === String(profile.readiness_state_id) ? 'selected' : ''}>${stateLabel} · ${escHtml(timeLabel)}</option>`;
  }).join('');
  return `<select id="e-readiness"><option value="">Select a profile...</option>${options}</select>`;
}
