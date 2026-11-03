export function extractListingThumbnailRows(raw) {
  const text = String(raw || '');
  const rows = [];
  const seen = new Set();
  const cleanField = value => String(value || '').replace(/\s+/g, ' ').trim();
  const fieldValue = (line, names, { toEnd = false } = {}) => {
    const joined = Array.isArray(names) ? names.join('|') : names;
    const end = toEnd ? '$' : '(?=\\s*\\|\\s*(?:Listing ID|Title|State|Status|Views|Sales|Revenue|Price|Etsy URL|URL|image_url|thumbnail|image)\\s*:|$)';
    const match = String(line || '').match(new RegExp(`(?:^|\\|)\\s*(?:${joined})\\s*:\\s*(.*?)\\s*${end}`, 'i'));
    return match ? cleanField(match[1]) : '';
  };
  const addRow = item => {
    if (!item?.listing_id) return;
    const key = String(item.listing_id);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(item);
  };
  const mediaLines = text.split(/\r?\n/).filter(line => /\b(?:listing(?:_id)?|ID)\s*[:#]?\s*\d{6,}\b/i.test(line));
  for (const line of mediaLines) {
    const id = line.match(/\b(?:listing(?:_id)?|ID)\s*[:#]?\s*(\d{6,})\b/i)?.[1];
    if (!id) continue;
    const image = fieldValue(line, ['image_url', 'thumbnail', 'image']) || line.match(/\b(?:image_url|thumbnail|image)\s*[:=]\s*(https?:\/\/[^\s)\]}|]+)/i)?.[1] || '';
    const etsyUrl = fieldValue(line, ['Etsy URL']) || '';
    const url = etsyUrl || fieldValue(line, ['URL']) || '';
    const state = fieldValue(line, ['State', 'Status']) || 'active';
    addRow({
      listing_id: id,
      image_url: image,
      title: fieldValue(line, ['Title'], { toEnd: true }),
      state,
      views: fieldValue(line, ['Views']),
      sales: fieldValue(line, ['Sales']),
      revenue: fieldValue(line, ['Revenue']),
      price: fieldValue(line, ['Price']),
      url,
      etsy_url: etsyUrl || url,
    });
  }
  const lineRe = /(?:^|\n).*?(?:listing(?:_id)?|ID)\s*[:#]?\s*(\d{6,}).*?(?:image_url|thumbnail|image)\s*[:=]\s*(https?:\/\/[^\s)\]}]+).*?(?=\n|$)/gi;
  let match;
  while ((match = lineRe.exec(text))) {
    const state = match[0].match(/\b(?:state|listing_state)\s*[:=]\s*(draft|active|inactive|expired)/i)?.[1] || 'active';
    addRow({ listing_id: match[1], image_url: match[2], state });
  }
  const jsonRe = /["']?(?:listing_id|id)["']?\s*[:=]\s*["']?(\d{6,})["']?[^\n{}]*?["']?(?:image_url|listing_image_url)["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi;
  while ((match = jsonRe.exec(text))) {
    const state = match[0].match(/\b(?:state|listing_state)["']?\s*[:=]\s*["']?(draft|active|inactive|expired)/i)?.[1] || 'active';
    addRow({ listing_id: match[1], image_url: match[2], state });
  }
  return rows;
}

export function stripListingThumbnailMetadata(raw) {
  return String(raw || '')
    .replace(/(?:^|\n)\s*Listing links:\s*\n(?:\s*-\s*Listing\s+\d+\s*:\s*\[View on Etsy\]\(https?:\/\/[^\s)]+\)\s*\n?)*/gi, '\n')
    .replace(/(?:^|\n)\s*Listing media:\s*(?=\n|$)/gi, '\n')
    .split(/\r?\n/)
    .filter(line => !(/\b(?:listing(?:_id)?|ID)\s*[:#]?\s*\d{6,}\b/i.test(line) && /\b(?:image_url|thumbnail|image|Etsy URL|URL|Title|State|Status|Views|Sales|Revenue|Price)\s*[:=]/i.test(line)))
    .join('\n')
    .trim();
}

export function formatAgentMessageForCopy(role, content) {
  const visible = stripListingThumbnailMetadata(content);
  return visible || String(content || '').trim();
}

export function formatAgentTranscriptMessageForCopy(role, content) {
  const label = role === 'user' ? 'User' : 'Assistant';
  return `${label}:\n${formatAgentMessageForCopy(role, content)}`;
}

export function renderListingThumbnails(raw, options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : extractListingThumbnailRows(raw);
  if (!rows.length) return '';
  const escAttr = value => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const esc = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const listingUrl = item => String(item.state || 'active').toLowerCase() === 'active'
    ? (item.etsy_url || item.url || `https://www.etsy.com/listing/${item.listing_id}`)
    : `https://www.etsy.com/your/shops/me/listing-editor/edit/${item.listing_id}#item-details`;
  const metricParts = item => [
    item.state ? `Status ${item.state}` : '',
    item.views !== '' && item.views != null ? `${item.views} views` : '',
    item.sales !== '' && item.sales != null ? `${item.sales} sales` : '',
    item.revenue !== '' && item.revenue != null ? `$${String(item.revenue).replace(/^\$/, '')} revenue` : '',
    item.price !== '' && item.price != null ? `$${String(item.price).replace(/^\$/, '')}` : '',
  ].filter(Boolean);
  const shown = rows.slice(0, 6);
  return `<div class="agent-listing-selection-panel">
    <div class="agent-listing-selection-head">
      <strong>Listing selection</strong>
      <span>Preview/select only - no Etsy changes</span>
    </div>
    <div class="agent-listing-selection-grid">${shown.map(item => {
      const url = listingUrl(item);
      return `
      <div class="agent-listing-selection-card" data-agent-listing-id="${escAttr(item.listing_id)}">
        ${item.image_url ? `<img src="${escAttr(item.image_url)}" alt="" class="agent-listing-selection-thumb" onerror="this.style.display='none'">` : '<span class="agent-listing-selection-thumb agent-listing-selection-thumb-empty">ID</span>'}
        <span class="agent-listing-selection-copy">
          <span class="agent-listing-selection-label">Listing</span>
          <strong>${esc(item.title || `Listing ${item.listing_id}`)}</strong>
          <span class="agent-listing-selection-id">ID ${esc(item.listing_id)}</span>
          ${metricParts(item).length ? `<span class="agent-listing-selection-meta">${esc(metricParts(item).join(' | '))}</span>` : ''}
          <span class="agent-listing-selection-actions">
            <a href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">Open</a>
            <button type="button" class="agent-listing-use-id" data-copy-listing-id="${escAttr(item.listing_id)}">Use ID ${esc(item.listing_id)}</button>
          </span>
        </span>
      </div>`;
    }).join('')}</div>
  </div>`;
}
