export function renderAgentMarkdown(raw) {
  const inline = text => String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const escapeAttr = text => inline(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const formatInline = text => inline(text)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--orange);text-decoration:underline">${label}</a>`)
    .replace(/(?<!href=")(https?:\/\/[^\s<]+)/g, url => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--orange);text-decoration:underline">${url}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code style="background:var(--bg-secondary);padding:1px 5px;border-radius:3px;font-size:11px;font-family:monospace">$1</code>');

  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p style="margin:0 0 6px">${formatInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const isTableRow = line => /^\s*\|.+\|\s*$/.test(line);
  const isTableSep = line => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const isTsvRow = line => line.includes('\t') && line.split('\t').filter(Boolean).length >= 2;

  const splitMarkdownTableRow = row => {
    const body = row.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = [];
    let cell = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '\\' && body[i + 1] === '|') {
        cell += '|';
        i += 1;
      } else if (ch === '|') {
        cells.push(cell);
        cell = '';
      } else {
        cell += ch;
      }
    }
    cells.push(cell);
    return cells;
  };

  const normalizeTableRows = rows => {
    if (!rows.length) return [];
    const parsed = rows.map(splitMarkdownTableRow);
    const width = parsed[0]?.length || 0;
    if (width < 2) return parsed;
    return parsed.map((cells, idx) => {
      if (idx === 0 || cells.length <= width) return cells;
      const tailCount = Math.max(0, width - 2);
      const first = cells[0];
      const tail = tailCount ? cells.slice(-tailCount) : [];
      const middleEnd = tailCount ? cells.length - tailCount : cells.length;
      return [first, cells.slice(1, middleEnd).map(c => c.trim()).join(' | '), ...tail];
    });
  };

  const listingIdCell = text => String(text || '').trim().match(/^\d{6,}$/)?.[0] || '';
  const tableHeaderName = (rows, index) => String(rows?.[0]?.[index] || '').trim().toLowerCase();
  const isListingIdColumn = (rows, index) => /^(id|listing id|listing_id|лістинг|listing)$/i.test(tableHeaderName(rows, index));
  const isListingTitleColumn = (rows, index) => /^(title|name|listing title|listing_title|назва)$/i.test(tableHeaderName(rows, index));
  const listingIdForRow = (rows, rowIndex) => {
    if (rowIndex <= 0) return '';
    const cells = rows[rowIndex] || [];
    for (let i = 0; i < cells.length; i++) {
      if (isListingIdColumn(rows, i)) {
        const id = listingIdCell(cells[i]);
        if (id) return id;
      }
    }
    return '';
  };
  const formatTableCell = (text, rows, rowIndex, cellIndex) => {
    const value = String(text || '').trim();
    const listingId = rowIndex > 0 && isListingIdColumn(rows, cellIndex) ? listingIdCell(value) : '';
    if (listingId) {
      const url = `https://www.etsy.com/listing/${listingId}`;
      return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--orange);text-decoration:underline;font-weight:700">${listingId}</a>`;
    }
    const rowListingId = listingIdForRow(rows, rowIndex);
    if (rowListingId && isListingTitleColumn(rows, cellIndex) && value) {
      const url = `https://www.etsy.com/listing/${rowListingId}`;
      return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--text);text-decoration:none;font-weight:700">${formatInline(value)}</a>`;
    }
    if (rowListingId && /^(open|action|link)$/i.test(tableHeaderName(rows, cellIndex))) {
      const url = `https://www.etsy.com/listing/${rowListingId}`;
      return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--orange);text-decoration:underline;font-weight:800">Open</a>`;
    }
    return formatInline(value);
  };

  const addListingActionColumn = rows => {
    if (!rows.length) return rows;
    const hasListingId = rows[0].some((_, idx) => isListingIdColumn(rows, idx));
    const hasListingRows = rows.some((_, idx) => listingIdForRow(rows, idx));
    const hasAction = rows[0].some(header => /^(open|action|link|etsy url|url)$/i.test(String(header || '').trim()));
    if (!hasListingId || !hasListingRows || hasAction) return rows;
    return rows.map((cells, idx) => idx === 0 ? [...cells, 'Open'] : [...cells, listingIdForRow(rows, idx) ? 'Open' : '']);
  };

  const renderTable = rows => {
    const prepared = addListingActionColumn(rows);
    return '<div style="overflow-x:auto;margin:8px 0"><table style="border-collapse:collapse;font-size:12px;width:100%">' + prepared.map((cells, idx) => {
      const tag = idx === 0 ? 'th' : 'td';
      const style = idx === 0
        ? 'padding:5px 10px;border:1px solid var(--border);background:var(--bg-secondary);font-weight:600;text-align:left'
        : 'padding:5px 10px;border:1px solid var(--border)';
      return `<tr>${cells.map((c, cellIdx) => `<${tag} style="${style}">${formatTableCell(c, prepared, idx, cellIdx)}</${tag}>`).join('')}</tr>`;
    }).join('') + '</table></div>';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { flushParagraph(); continue; }
    if (/^-{3,}$/.test(trimmed)) { flushParagraph(); continue; }

    if (/^```/.test(trimmed)) {
      flushParagraph();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i]);
      blocks.push(`<pre style="background:var(--bg-secondary);padding:8px 12px;border-radius:6px;font-size:11px;overflow-x:auto;margin:6px 0"><code>${inline(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (isTableRow(line)) {
      flushParagraph();
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isTableSep(lines[i])) rows.push(lines[i].trim());
        i += 1;
      }
      i -= 1;
      if (rows.length) blocks.push(renderTable(normalizeTableRows(rows)));
      continue;
    }

    if (isTsvRow(line)) {
      flushParagraph();
      const rows = [];
      while (i < lines.length && isTsvRow(lines[i])) {
        rows.push(lines[i].split('\t').map(c => c.trim()).filter(Boolean));
        i += 1;
      }
      i -= 1;
      blocks.push(renderTable(rows));
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const size = heading[1].length === 1 ? 15 : heading[1].length === 2 ? 14 : 13;
      blocks.push(`<div style="font-weight:700;font-size:${size}px;margin:10px 0 4px">${formatInline(heading[2])}</div>`);
      continue;
    }

    const listMatch = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      const items = [];
      while (i < lines.length) {
        const item = lines[i].trim().match(/^(?:[-*]|\d+\.)\s+(.+)$/);
        if (!item) break;
        items.push(`<li style="margin:2px 0">${formatInline(item[1])}</li>`);
        i += 1;
      }
      i -= 1;
      blocks.push(`<ul style="margin:4px 0 6px;padding-left:20px">${items.join('')}</ul>`);
      continue;
    }

    paragraph.push(trimmed);
  }
  flushParagraph();
  return `<div style="line-height:1.45">${blocks.join('')}</div>`;
}
