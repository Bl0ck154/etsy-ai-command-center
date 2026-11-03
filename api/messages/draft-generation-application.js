import { cleanText } from './contracts.js';
import {
  ORDER_CONTEXT_SCENARIOS,
  assertConversationNeedsReply,
  assertLiveScenarioAllowed,
  assertScenario,
  blockedPreview,
} from './scenario-policy.js';

export function createMessagesDraftGenerationApplication({
  bridgeStatus,
  runtimeStatus,
  refreshedConversationForDraft,
  loadMessagePlaybook,
  loadVerifiedListingFactsForConversation,
  loadShopSellerStyleReference,
  generateMessageDraft,
  createOutboxDraft,
  loadMessageLearningExamples = async () => [],
  captureMessageLearningProposal = async () => null,
}) {
  async function previewDraft({ shopId, input }) {
    const scenario = assertScenario(input.scenario);
    const playbookState = await loadMessagePlaybook(shopId);
    const status = runtimeStatus(await bridgeStatus());
    const refreshed = input.conversation_id
      ? await refreshedConversationForDraft(input.conversation_id)
      : null;

    if (refreshed && !refreshed.replyState.eligible) {
      return {
        ...blockedPreview(refreshed.replyState, playbookState.revision),
        scenario,
        sync: refreshed.sync,
      };
    }

    const conversation = refreshed?.conversation || {
      source_id: 'playbook-preview',
      participant: cleanText(input.participant, 300) || 'Example buyer',
      messages: [{
        sender: 'buyer',
        direction: 'incoming',
        source_id: 'playbook-preview-message',
        body: cleanText(input.customer_message, 6_000),
        sent_at: new Date().toISOString(),
        attachments: [],
      }],
    };
    const listingContext = scenario === 'how_to_order' && refreshed
      ? await loadVerifiedListingFactsForConversation({ conversation })
      : null;
    const sellerStyleReference = await loadShopSellerStyleReference(shopId);
    const learnedExamples = await loadMessageLearningExamples({
      shopId,
      scenario,
      conversation,
      sourceMessageId: refreshed?.replyState?.source_message_id || null,
    });
    const data = await generateMessageDraft({
      scenario,
      conversation,
      ownerNotes: input.owner_notes,
      verifiedFacts: listingContext
        ? {
          ...(input.simulated_facts || {}),
          listing: listingContext.listing,
          listing_context: {
            exact_reference_available: Boolean(listingContext.listing),
            unavailable_reason: listingContext.unavailable_reason || null,
          },
        }
        : (input.simulated_facts || {}),
      playbook: playbookState.playbook,
      account: status.account,
      sellerStyleReference,
      learnedExamples,
    });
    return {
      ...data,
      preview_only: true,
      simulation_only:
        ORDER_CONTEXT_SCENARIOS.has(scenario)
        && !status.order_linking_enabled,
      queued: false,
      sent: false,
      sync: refreshed?.sync || null,
      conversation_check: refreshed?.replyState || null,
      playbook_revision: playbookState.revision,
    };
  }

  async function generateDraft({ shopId, input, currentActor }) {
    const scenario = assertScenario(input.scenario);
    const status = runtimeStatus(await bridgeStatus());
    assertLiveScenarioAllowed(scenario, status);
    const refreshed = await refreshedConversationForDraft(input.conversation_id);
    assertConversationNeedsReply(refreshed.replyState);
    const conversation = refreshed.conversation;
    const playbookState = await loadMessagePlaybook(shopId);
    const listingContext = scenario === 'how_to_order'
      ? await loadVerifiedListingFactsForConversation({ conversation })
      : null;
    const sellerStyleReference = await loadShopSellerStyleReference(shopId);
    const learnedExamples = await loadMessageLearningExamples({
      shopId,
      scenario,
      conversation,
      sourceMessageId: refreshed.replyState.source_message_id,
    });
    const generated = await generateMessageDraft({
      scenario,
      conversation,
      ownerNotes: input.owner_notes,
      verifiedFacts: listingContext
        ? {
          listing: listingContext.listing,
          listing_context: {
            exact_reference_available: Boolean(listingContext.listing),
            unavailable_reason: listingContext.unavailable_reason || null,
          },
        }
        : {},
      playbook: playbookState.playbook,
      account: status.account,
      sourceMessageId: refreshed.replyState.source_message_id,
      sellerStyleReference,
      learnedExamples,
    });

    if (generated.status !== 'ready') {
      return {
        ready: false,
        error: generated.block_reason,
        code: generated.status === 'no_action'
          ? 'MESSAGE_DRAFT_NO_ACTION'
          : 'MESSAGE_DRAFT_BLOCKED',
        generated,
      };
    }

    const draft = await createOutboxDraft({
      conversationId: conversation.source_id,
      body: generated.reply_body,
      scenario,
      reason: generated.rationale,
      metadata: {
        generator: 'message_agent',
        playbook_revision: playbookState.revision,
        language: generated.language,
        confidence: generated.confidence,
        facts_used: generated.facts_used,
        warnings: generated.warnings,
        generation: generated.generation || null,
        learned_example_ids: learnedExamples.map(example => example.id).filter(Boolean),
        dashboard_shop_id: shopId,
        source_message_id: refreshed.replyState.source_message_id,
        conversation_checked_at: new Date().toISOString(),
      },
      createdBy: currentActor.id,
      clientRequestId: input.client_request_id,
    });
    const learning = await captureMessageLearningProposal({
      shopId,
      draft,
      generated,
      scenario,
      conversation,
      sourceMessageId: refreshed.replyState.source_message_id,
      playbookRevision: playbookState.revision,
      createdBy: currentActor.id,
    });

    return {
      ready: true,
      draft,
      generated,
      sync: refreshed.sync,
      conversation_check: refreshed.replyState,
      learning,
    };
  }

  async function createManualDraft({ shopId, input, currentActor }) {
    const scenario = assertScenario(input.scenario || 'freeform');
    const status = runtimeStatus(await bridgeStatus());
    assertLiveScenarioAllowed(scenario, status);
    const body = cleanText(input.body, 10_000);
    if (!body) return { valid: false, error: 'Draft text is required' };
    const draft = await createOutboxDraft({
      conversationId: input.conversation_id,
      body,
      scenario,
      reason: input.reason || 'Written manually by an operator',
      metadata: {
        generator: 'human',
        dashboard_shop_id: shopId,
      },
      createdBy: currentActor.id,
      clientRequestId: input.client_request_id,
    });
    return { valid: true, draft };
  }

  return { previewDraft, generateDraft, createManualDraft };
}
