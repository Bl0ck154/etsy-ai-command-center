import { getActiveShopId } from '../_shops.js';
import {
  bridgeApprovalPost,
  bridgeBinaryRequest,
  bridgePost,
  bridgeQuery,
  bridgeRequest,
  messageAutomationConfig,
} from './bridge-client.js';
import { getMessageTriggerWorkerStatus } from './trigger-worker.js';
import {
  loadMessageAutomationPolicy,
  saveMessageAutomationPolicy,
} from './automation-policy.js';
import {
  getMessageTriggerStatus,
  reconcileMessageTriggerDraft,
} from './trigger-runner.js';
import { generateMessageDraft } from './draft-agent.js';
import { loadShopSellerStyleReference } from './shop-style-reference.js';
import { conversationReplyState } from './conversation-state.js';
import { loadVerifiedListingFactsForConversation } from './listing-context-evidence.js';
import {
  loadMessagePlaybook,
  saveMessagePlaybook,
} from './playbook.js';
import { numericId, positiveInt } from './contracts.js';
import { actor, requireApprover } from './http-contract.js';
import { createMessagesConversationApplication } from './conversation-application.js';
import { createMessagesRuntimeApplication } from './runtime-application.js';
import { createMessagesDraftDeliveryApplication } from './draft-delivery-application.js';
import { createMessagesDraftGenerationApplication } from './draft-generation-application.js';
import { createMessagesDraftLifecycleApplication } from './draft-lifecycle-application.js';
import { createMessagesReadActionHandler } from './http-read-actions.js';
import { createMessagesWriteActionHandler } from './http-write-actions.js';
import {
  captureMessageLearningProposal,
  loadMessageLearningExamples,
  recordMessageLearningDeliveryOutcome,
} from './learning-runtime.js';

const conversationApplication = createMessagesConversationApplication({
  bridgeQuery,
  bridgeRequest,
  conversationReplyState,
});
const {
  conversationBundle,
  refreshedConversationForDraft,
} = conversationApplication;

const runtimeApplication = createMessagesRuntimeApplication({
  bridgeRequest,
  messageAutomationConfig,
  getMessageTriggerWorkerStatus,
  loadMessageAutomationPolicy,
  getMessageTriggerStatus,
});
const {
  automationStatus,
  bridgeStatus,
  runtimeStatus,
} = runtimeApplication;

const draftDeliveryApplication = createMessagesDraftDeliveryApplication({
  bridgeApprovalPost,
  bridgePost,
  bridgeRequest,
  reconcileMessageTriggerDraft,
  refreshedConversationForDraft,
  conversationReplyState,
  recordMessageLearningDeliveryOutcome,
});
const {
  approveAndSendDraft,
  createOutboxDraft,
  reconcileDraftAction,
  refreshDraftForReview,
} = draftDeliveryApplication;

const draftGenerationApplication = createMessagesDraftGenerationApplication({
  bridgeStatus,
  runtimeStatus,
  refreshedConversationForDraft,
  loadMessagePlaybook,
  loadVerifiedListingFactsForConversation,
  loadShopSellerStyleReference,
  generateMessageDraft,
  createOutboxDraft,
  loadMessageLearningExamples,
  captureMessageLearningProposal,
});
const {
  previewDraft,
  generateDraft: prepareGeneratedDraft,
  createManualDraft,
} = draftGenerationApplication;

const draftLifecycleApplication = createMessagesDraftLifecycleApplication({
  bridgeApprovalPost,
  bridgeRequest,
  refreshDraftForReview,
  reconcileDraftAction,
  captureMessageLearningProposal,
  recordMessageLearningDeliveryOutcome,
});
const {
  approveDraft,
  sendApprovedDraft,
  skipDraft,
  blockDraft,
} = draftLifecycleApplication;

export const handleGet = createMessagesReadActionHandler({
  getActiveShopId,
  bridgeStatus,
  runtimeStatus,
  bridgeQuery,
  conversationBundle,
  bridgeBinaryRequest,
  numericId,
  positiveInt,
  bridgeRequest,
  loadMessagePlaybook,
  automationStatus,
});

export const handlePost = createMessagesWriteActionHandler({
  getActiveShopId,
  actor,
  requireApprover,
  saveMessagePlaybook,
  saveMessageAutomationPolicy,
  bridgeRequest,
  bridgeQuery,
  positiveInt,
  numericId,
  bridgePost,
  conversationBundle,
  refreshedConversationForDraft,
  refreshDraftForReview,
  previewDraft,
  prepareGeneratedDraft,
  createManualDraft,
  approveAndSendDraft,
  approveDraft,
  sendApprovedDraft,
  skipDraft,
  blockDraft,
});
