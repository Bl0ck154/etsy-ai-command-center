export function listFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.results)) return value.results;
  return [];
}

export function draftIdOf(value) {
  return String(value?.draft_id ?? value?.id ?? '');
}

export function nextCursorFrom(value, currentCursor = -1) {
  if (value?.next_cursor === null || value?.next_cursor === undefined) return null;
  const cursor = Number(value.next_cursor);
  return Number.isFinite(cursor) && cursor > currentCursor ? cursor : null;
}

export function conversationIdOf(value) {
  return String(
    value?.conversation_source_id
    ?? value?.conversation_id
    ?? value?.source_id
    ?? '',
  );
}

export function conversationKey(value, conversationName) {
  return conversationIdOf(value)
    || String(value?.id ?? '')
    || `${conversationName(value)}:${value?.last_message_at || value?.updated_at || ''}`;
}

export function mergeConversationPages(
  current,
  incoming,
  { firstPage = false, conversationName = () => '' } = {},
) {
  const primary = firstPage ? incoming : current;
  const secondary = firstPage ? current : incoming;
  const result = [];
  const positions = new Map();
  for (const conversation of [...primary, ...secondary]) {
    const key = conversationKey(conversation, conversationName);
    const existingIndex = positions.get(key);
    if (existingIndex === undefined) {
      positions.set(key, result.length);
      result.push(conversation);
      continue;
    }
    result[existingIndex] = firstPage
      ? { ...conversation, ...result[existingIndex] }
      : { ...result[existingIndex], ...conversation };
  }
  return result;
}

export function attachmentIdOf(attachment) {
  const value = String(attachment?.attachment_id ?? attachment?.id ?? '').trim();
  return /^\d+$/.test(value) ? value : '';
}

export function attachmentSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function publicEtsyAttachmentUrl(attachment) {
  const raw = attachment?.public_url
    || attachment?.source_url
    || attachment?.download_url
    || attachment?.url
    || '';
  try {
    const url = new URL(String(raw));
    const extension = url.pathname.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1] || '';
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'i.etsystatic.com'
      || url.username
      || url.password
      || url.port && url.port !== '443'
      || !url.pathname.startsWith('/icm/')
      || !['.gif', '.jpeg', '.jpg', '.pdf', '.png', '.webp'].includes(extension)
    ) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function attachmentsForDisplay(value) {
  const unique = new Map();
  for (const attachment of listFrom(value)) {
    const publicUrl = publicEtsyAttachmentUrl(attachment);
    const key = String(
      attachment?.sha256
      || publicUrl
      || attachment?.source_id
      || [
        attachment?.filename,
        attachment?.mime_type,
        attachment?.size_bytes,
      ].join(':'),
    );
    const current = unique.get(key);
    if (!current || (attachment?.local_path === true && current?.local_path !== true)) {
      unique.set(key, attachment);
    }
  }
  return [...unique.values()];
}

export function hasAccessibleAttachment(message) {
  return attachmentsForDisplay(message?.attachments).some(attachment =>
    (attachment?.local_path === true && attachmentIdOf(attachment))
    || publicEtsyAttachmentUrl(attachment),
  );
}

export function messagesRouteParams({
  tab = 'inbox',
  locale = 'uk',
  draft = null,
  conversation = null,
} = {}) {
  const params = { tab, lang: locale };
  if (tab === 'queue') {
    const draftId = draftIdOf(draft);
    if (draftId) params.draft_id = draftId;
  } else if (tab === 'inbox') {
    const conversationId = conversationIdOf(conversation);
    if (conversationId) params.conversation_id = conversationId;
  }
  return params;
}
