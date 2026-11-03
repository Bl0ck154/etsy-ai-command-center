export function stripMarkdownForEtsy(value) {
  let text = String(value ?? '');
  if (!text) return '';

  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?/gm, '');
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => (alt || url || '').trim());
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const cleanLabel = String(label || '').trim();
    const cleanUrl = String(url || '').trim();
    return cleanUrl && cleanUrl !== cleanLabel ? `${cleanLabel} ${cleanUrl}`.trim() : cleanLabel;
  });

  const lines = text.split('\n').map(rawLine => {
    let line = rawLine;
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '');
    line = line.replace(/^\s*>\s?/, '');
    line = line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '• ');
    line = line.replace(/^\s*[-*+]\s+/, '• ');
    line = line.replace(/^\s*(\d+)[.)]\s+/, '$1. ');
    line = line.replace(/^\s*[-*_]{3,}\s*$/, '');
    return line;
  });

  text = lines.join('\n');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  text = text.replace(/_([^_\n]+)_/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  text = text.replace(/[ \t]+$/gm, '');
  text = text.replace(/(^|\s)([*_]{1,3})(?=\s|$)/g, '$1');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
