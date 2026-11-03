// components/view-on-etsy-button.js — Reusable "View on Etsy" button

/**
 * Generate HTML for "View on Etsy" button
 * @param {number|string} listingId - Etsy listing ID
 * @param {object} options - Button options
 * @param {string} options.size - Button size: 'sm' (default), 'md', 'lg'
 * @param {string} options.style - Additional inline styles
 * @param {boolean} options.icon - Show external link icon (default: true)
 * @returns {string} HTML string
 */
export function listingDestinationUrl(listingId, state = 'active') {
  const listingState = String(state || 'active').toLowerCase();
  return listingState && listingState !== 'active'
    ? `https://www.etsy.com/your/shops/me/listing-editor/edit/${listingId}#item-details`
    : `https://www.etsy.com/listing/${listingId}`;
}

export function viewOnEtsyButton(listingId, { size = 'sm', style = '', icon = true, state = 'active', label } = {}) {
  const sizeClass = size === 'sm' ? 'btn-sm' : '';
  const url = listingDestinationUrl(listingId, state);
  const text = label || (String(state || 'active').toLowerCase() === 'active' ? 'View on Etsy' : 'Edit on Etsy');
  const iconSvg = icon ? `
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="vertical-align:middle;margin-right:4px">
      <path d="M10 2h4v4M14 2l-6 6M6 3H3v10h10v-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  ` : '';

  return `<a href="${url}" target="_blank" rel="noopener"
    class="btn ${sizeClass}" style="${style}" title="${text}">
    ${iconSvg}${text}
  </a>`;
}

/**
 * Generate HTML for clickable listing ID badge
 * @param {number|string} listingId - Etsy listing ID
 * @returns {string} HTML string
 */
export function listingIdBadge(listingId, state = 'active') {
  const url = listingDestinationUrl(listingId, state);
  const title = String(state || 'active').toLowerCase() === 'active' ? 'View on Etsy' : 'Edit on Etsy';
  return `<a href="${url}" target="_blank" rel="noopener"
    class="badge badge-gray" style="font-size:10px;text-decoration:none;cursor:pointer"
    title="${title}">#${listingId}</a>`;
}
