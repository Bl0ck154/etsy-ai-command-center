export function skeleton(lines = 3, width = '100%') {
  return lines > 1
    ? Array.from({ length: lines }, (_, i) =>
        `<div class="skeleton-line" style="width:${i === lines - 1 ? '60%' : width}"></div>`
      ).join('')
    : `<div class="skeleton-line" style="width:${width}"></div>`;
}

export function skeletonCard(rows = 4) {
  return `<div class="card skeleton-card">
    <div class="skeleton-line" style="width:40%;height:14px;margin-bottom:12px"></div>
    ${Array.from({ length: rows }, () =>
      `<div class="skeleton-line" style="width:${60 + Math.random() * 40}%"></div>`
    ).join('')}
  </div>`;
}

export function skeletonTable(cols = 6, rows = 8) {
  const headerCells = Array.from({ length: cols }, () =>
    `<th><div class="skeleton-line" style="width:80%;height:10px"></div></th>`
  ).join('');
  const bodyRows = Array.from({ length: rows }, () => {
    const cells = Array.from({ length: cols }, () =>
      `<td><div class="skeleton-line" style="width:${40 + Math.random() * 50}%"></div></td>`
    ).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table class="skeleton-table"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}
