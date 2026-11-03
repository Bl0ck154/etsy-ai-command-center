const MESSAGE_PRESENTATIONS = Object.freeze({
  user: Object.freeze({
    wrapClassName: 'agent-message-wrap agent-message-wrap-user',
    wrapStyle: 'display:flex;flex-direction:column;align-items:flex-end',
    bubbleClassName: 'agent-message-bubble agent-message-bubble-user',
    bubbleStyle: 'background:var(--orange);color:#fff;padding:10px 14px;border-radius:14px 14px 4px 14px;font-size:13px;max-width:75%;line-height:1.5;white-space:pre-wrap',
    senderLabel: 'User:\n',
  }),
  runtime: Object.freeze({
    wrapClassName: 'agent-message-wrap agent-message-wrap-runtime',
    wrapStyle: 'display:flex;flex-direction:column;align-items:flex-start;max-width:820px',
    bubbleClassName: 'agent-message-bubble agent-message-bubble-runtime',
    bubbleStyle: 'background:var(--orange-soft,rgba(245,158,11,.08));border:1px solid var(--orange);color:var(--text);padding:10px 14px;border-radius:8px;font-size:12px;max-width:820px;line-height:1.5',
    senderLabel: 'Etsy AI Command Center runtime:\n',
  }),
  assistant: Object.freeze({
    wrapClassName: 'agent-message-wrap agent-message-wrap-assistant',
    wrapStyle: 'display:flex;flex-direction:column;align-items:flex-start;max-width:820px',
    bubbleClassName: 'agent-message-bubble agent-message-bubble-assistant',
    bubbleStyle: 'background:var(--bg-card);border:1px solid var(--border);padding:12px 16px;border-radius:4px 14px 14px 14px;font-size:13px;max-width:820px;box-shadow:var(--shadow-sm)',
    senderLabel: 'Agent:\n',
  }),
});

export function agentMessageRolePresentation(role) {
  const presentation = MESSAGE_PRESENTATIONS[role];
  if (presentation) return presentation;
  return {
    ...MESSAGE_PRESENTATIONS.assistant,
    wrapClassName: `agent-message-wrap agent-message-wrap-${role}`,
    bubbleClassName: `agent-message-bubble agent-message-bubble-${role}`,
  };
}

export function agentAttachmentPresentation(image = null) {
  const attached = Boolean(image);
  return {
    attached,
    preview: attached ? String(image.preview || '') : '',
    filename: attached ? String(image.filename || 'image.jpg') : '',
    display: attached ? 'flex' : 'none',
    accent: attached ? 'var(--orange)' : '',
  };
}

export function agentDebugTracePresentation(trace = [], visible = false) {
  if (!visible) return null;
  const items = (Array.isArray(trace) ? trace : []).filter(Boolean);
  if (!items.length) return null;
  return {
    items,
    bodyText: JSON.stringify(items, null, 2),
  };
}
