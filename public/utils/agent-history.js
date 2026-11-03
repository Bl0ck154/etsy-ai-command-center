export function extractDuplicateListingId(content) {
  const text = String(content || '');
  const match = text.match(/(?:New listing ID:\s*|Created listing\s+)(\d{6,})/i);
  return match ? Number(match[1]) : null;
}

export function duplicateResultFromMessage(content) {
  const listingId = extractDuplicateListingId(content);
  if (!listingId) return null;
  return {
    new_listing_id: listingId,
    listing_id: listingId,
    new_listing_title: '',
    listing_title: '',
    image_url: null,
    source_image_url: null,
    source_state: 'draft',
    created_at: new Date().toISOString(),
  };
}

export function latestDuplicateResultFromMessages(messages = []) {
  const assistantMessages = Array.isArray(messages) ? messages.filter(m => m.role === 'assistant') : [];
  for (let i = assistantMessages.length - 1; i >= 0; i--) {
    const msg = assistantMessages[i];
    if (msg.duplicate_result?.new_listing_id || msg.duplicate_result?.listing_id) return msg.duplicate_result;
    const fromText = duplicateResultFromMessage(msg.content);
    if (fromText) return fromText;
  }
  return null;
}

function workflowId(value = {}) {
  return String(value?.workflow_id || value?.agent_draft?.workflow_id || '').trim();
}

function draftTitle(value = {}) {
  return String(value?.generated?.title || value?.agent_draft?.generated?.title || '').trim();
}

export function sameAgentDraftWorkflow(left = {}, right = {}) {
  const leftId = workflowId(left);
  const rightId = workflowId(right);
  if (leftId || rightId) return Boolean(leftId && rightId && leftId === rightId);
  const leftTitle = draftTitle(left);
  const rightTitle = draftTitle(right);
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle);
}

export function mergeAgentDraftSnapshots(original = {}, current = {}) {
  if (!current?.generated || !sameAgentDraftWorkflow(original, current)) return original;
  return {
    ...original,
    ...current,
    generated: { ...(original.generated || {}), ...(current.generated || {}) },
    storedImageIds: [...new Set([
      ...(Array.isArray(original.storedImageIds) ? original.storedImageIds : []),
      ...(Array.isArray(current.storedImageIds) ? current.storedImageIds : []),
    ].map(String).filter(Boolean))],
  };
}

export function agentDraftHistorySnapshot(draft = {}) {
  if (!draft?.generated) return null;
  const { attachedImages, referenceImage, ...durable } = draft;
  return {
    ...durable,
    generated: { ...(draft.generated || {}) },
    storedImageIds: Array.isArray(draft.storedImageIds) ? [...draft.storedImageIds] : [],
  };
}

export function persistAgentDraftInHistory(messages = [], draft = {}, preferredIndex = -1) {
  if (!Array.isArray(messages) || !draft?.generated) return -1;
  const candidates = [];
  if (Number.isInteger(preferredIndex) && preferredIndex >= 0) candidates.push(preferredIndex);
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!candidates.includes(index)) candidates.push(index);
  }
  for (const index of candidates) {
    const message = messages[index];
    const generation = message?.pending_generate_listing;
    if (message?.role !== 'assistant' || !generation?.generated) continue;
    const recordedDraft = generation.agent_draft || {
      generated: generation.generated,
      workflow_id: generation.workflow_id || null,
    };
    if (!sameAgentDraftWorkflow(recordedDraft, draft)) continue;
    message.pending_generate_listing = {
      ...generation,
      generated: draft.generated,
      workflow_id: draft.workflow_id || generation.workflow_id || null,
      workflow_state: draft.workflow_state || generation.workflow_state || 'listing_draft_ready',
      storedImageIds: Array.isArray(draft.storedImageIds) ? [...draft.storedImageIds] : [],
      agent_draft: agentDraftHistorySnapshot(draft),
    };
    return index;
  }
  return -1;
}
