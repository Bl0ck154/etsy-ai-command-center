import { escHtml } from './format.js';
import {
  attachmentIdOf,
  attachmentSize,
  attachmentsForDisplay,
  hasAccessibleAttachment,
  listFrom,
  publicEtsyAttachmentUrl,
} from './messages-view-model.js';

export function createMessagesConversationView({
  escapeHtml = escHtml,
  translate = (uk, _en) => uk,
  formatDate = value => String(value || ''),
  attachmentContentUrl = () => '',
} = {}) {
  const messageDirection = message => {
    const direction = String(message?.direction || '').trim().toLowerCase();
    if (['outgoing', 'incoming', 'system'].includes(direction)) return direction;
    return 'unknown';
  };

  const messageBody = message => message?.body || message?.text || message?.message || '';

  const conversationParticipant = conversation => conversation?.participant
    || conversation?.participant_name
    || conversation?.title
    || translate('Учасник діалогу', 'Conversation participant');

  const messageSenderLabel = (message, conversation) => {
    const direction = messageDirection(message);
    if (direction === 'outgoing') return translate('Ви', 'You');
    if (direction === 'incoming') return conversationParticipant(conversation);
    return '';
  };

  const visibleConversationMessages = conversation => listFrom(conversation?.messages).filter(message => {
    const direction = messageDirection(message);
    if (['incoming', 'outgoing'].includes(direction)) return true;
    return direction === 'unknown' && hasAccessibleAttachment(message);
  });

  const attachmentHtml = attachment => {
    const id = attachmentIdOf(attachment);
    const filename = attachment?.filename || 'Attachment';
    const mime = String(attachment?.mime_type || '').toLowerCase();
    const localUrl = attachment?.local_path === true && id
      ? attachmentContentUrl(id)
      : '';
    const publicUrl = publicEtsyAttachmentUrl(attachment);
    const contentUrl = localUrl || publicUrl;
    if (!contentUrl) {
      return `
        <span class="messages-attachment messages-attachment-unavailable">
          <span aria-hidden="true">↳</span>
          <span><strong>${escapeHtml(filename)}</strong><small>Attachment unavailable</small></span>
        </span>`;
    }
    const preview = mime.startsWith('image/')
      ? `<a class="messages-attachment-preview" href="${escapeHtml(contentUrl)}" target="_blank" rel="noopener noreferrer">
          <img src="${escapeHtml(contentUrl)}" alt="${escapeHtml(filename)}" loading="lazy" referrerpolicy="no-referrer" data-message-attachment-image>
          <span class="messages-attachment-preview-fallback">Preview unavailable</span>
        </a>`
      : '<span class="messages-attachment-file-icon" aria-hidden="true">PDF</span>';
    return `
      <span class="messages-attachment">
        ${preview}
        <span class="messages-attachment-copy">
          <strong>${escapeHtml(filename)}</strong>
          <small>${escapeHtml([mime, attachmentSize(attachment?.size_bytes)].filter(Boolean).join(' · '))}</small>
          <span class="messages-attachment-actions">
            <a href="${escapeHtml(contentUrl)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open</a>
            ${localUrl
              ? `<a href="${escapeHtml(localUrl)}" download="${escapeHtml(filename)}">Download</a>`
              : ''}
          </span>
        </span>
      </span>`;
  };

  const conversationMessagesHtml = (conversation, { visibleMessageLimit = 100 } = {}) => {
    const visibleMessages = visibleConversationMessages(conversation);
    if (!visibleMessages.length) {
      return conversation?.history_synced_at
        ? '<div class="messages-empty">No saved customer messages in this conversation.</div>'
        : '<div class="messages-empty">Messages are not loaded yet. Load this conversation when you need its history.</div>';
    }
    const displayedMessages = visibleMessages.slice(-visibleMessageLimit);
    const hiddenCount = visibleMessages.length - displayedMessages.length;
    const olderButton = hiddenCount > 0
      ? `<div class="messages-local-history">
          <button class="btn btn-sm" type="button" data-message-show-older>
            Show ${Math.min(100, hiddenCount)} older saved messages
          </button>
          <span>${hiddenCount} earlier messages are kept out of the browser until requested</span>
        </div>`
      : '';
    return olderButton + displayedMessages.map(message => {
      const direction = messageDirection(message);
      if (direction === 'unknown') {
        const localAttachments = attachmentsForDisplay(message.attachments).filter(
          attachment => (
            (attachment?.local_path === true && attachmentIdOf(attachment))
            || publicEtsyAttachmentUrl(attachment)
          ),
        );
        return `
          <article class="messages-event messages-event-unknown" data-message-id="${escapeHtml(String(message?.source_id ?? message?.id ?? ''))}">
            <div class="messages-bubble-meta"><strong>Attachments</strong></div>
            ${localAttachments.map(attachmentHtml).join('')}
          </article>`;
      }
      const legacyClass = direction === 'outgoing'
        ? 'seller'
        : (direction === 'incoming' ? 'buyer' : '');
      return `
        <article class="messages-bubble ${direction} ${legacyClass}" data-message-id="${escapeHtml(String(message?.source_id ?? message?.id ?? ''))}">
          <div class="messages-bubble-meta">
            <strong>${escapeHtml(messageSenderLabel(message, conversation))}</strong>
            <time>${escapeHtml(formatDate(message.sent_at || message.created_at))}</time>
          </div>
          <div class="messages-bubble-body">${escapeHtml(messageBody(message)).replace(/\n/g, '<br>')}</div>
          ${attachmentsForDisplay(message.attachments).map(attachmentHtml).join('')}
        </article>`;
    }).join('');
  };

  return {
    attachmentHtml,
    conversationMessagesHtml,
    messageDirection,
    visibleConversationMessages,
  };
}
