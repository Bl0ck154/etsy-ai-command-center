import { messagesTransport } from './messages-transport.js';

const get = (action, values) => messagesTransport.get(action, values);
const post = (action, values, timeoutMs) => messagesTransport.post(action, values, timeoutMs);

export const messagesApi = {
  status: () => get('status'),
  listConversations: values => get('listConversations', values),
  getConversation: conversationId => get('getConversation', { conversation_id: conversationId }),
  markConversationViewed: conversationId =>
    post('markConversationViewed', { conversation_id: conversationId }),
  attachmentContentUrl: attachmentId =>
    `/api/messages?${new URLSearchParams({
      action: 'getAttachment',
      attachment_id: String(attachmentId),
    }).toString()}`,
  syncInbox: values => post('syncInbox', values, 190_000),
  syncConversationHistory: conversationId =>
    post('syncConversationHistory', { conversation_id: conversationId }, 190_000),
  refreshConversationRecent: conversationId =>
    post('refreshConversationRecent', { conversation_id: conversationId }, 190_000),
  listDrafts: values => get('listDrafts', values),
  getDraft: draftId => get('getDraft', { draft_id: draftId }),
  refreshDraftForReview: draftId =>
    post('refreshDraftForReview', { draft_id: draftId }, 190_000),
  getPlaybook: () => get('getPlaybook'),
  savePlaybook: (playbook, expectedRevision) =>
    post('savePlaybook', { playbook, expected_revision: expectedRevision }),
  getAutomationStatus: () => get('getAutomationStatus'),
  saveAutomationPolicy: (policy, expectedRevision) =>
    post('saveAutomationPolicy', {
      policy,
      expected_revision: expectedRevision,
    }),
  previewDraft: values => post('previewDraft', values, 170_000),
  generateDraft: values => post('generateDraft', values, 170_000),
  createManualDraft: values => post('createManualDraft', values),
  approveAndSendDraft: (draftId, body, clientRequestId) =>
    post('approveAndSendDraft', {
      draft_id: draftId,
      body,
      client_request_id: clientRequestId,
    }, 190_000),
  approveDraft: (draftId, body) => post('approveDraft', { draft_id: draftId, body }),
  sendApprovedDraft: draftId => post('sendApprovedDraft', { draft_id: draftId }, 170_000),
  skipDraft: (draftId, reason) => post('skipDraft', { draft_id: draftId, reason }),
  blockDraft: (draftId, reason) => post('blockDraft', { draft_id: draftId, reason }),
};
