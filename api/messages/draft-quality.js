import { generateWithMessageAi } from './message-ai.js';

const QUALITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'decision',
    'answers_question_directly',
    'uses_available_context',
    'asks_irrelevant_question',
    'greeting_appropriate',
    'fabricates_internal_process',
    'unnecessarily_defers_answer',
    'natural_and_decisive',
    'unsupported_claims',
    'confidence',
    'rationale',
  ],
  properties: {
    decision: { type: 'string', enum: ['approve', 'block'] },
    answers_question_directly: { type: 'boolean' },
    uses_available_context: { type: 'boolean' },
    asks_irrelevant_question: { type: 'boolean' },
    greeting_appropriate: { type: 'boolean' },
    fabricates_internal_process: { type: 'boolean' },
    unnecessarily_defers_answer: { type: 'boolean' },
    natural_and_decisive: { type: 'boolean' },
    unsupported_claims: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', maxLength: 300 },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', maxLength: 1_500 },
  },
};

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function compactMessages(messages = []) {
  const normalized = (Array.isArray(messages) ? messages : [])
    .map(message => ({
      source_message_id: cleanText(message?.source_id || message?.id, 160),
      direction: cleanText(message?.direction, 40).toLowerCase(),
      sender: cleanText(message?.sender, 160),
      body: cleanText(message?.body, 3_000),
      sent_at: cleanText(message?.sent_at, 80) || null,
    }))
    .filter(message => ['incoming', 'outgoing'].includes(message.direction));
  if (normalized.length <= 40) return normalized;
  return [
    ...normalized.slice(0, 6),
    ...normalized.slice(-34),
  ];
}


function compactSellerStyle(value = {}) {
  if (!value || typeof value !== 'object' || value.available !== true) {
    return { available: false };
  }
  return {
    available: true,
    priority: cleanText(value.priority, 40) || null,
    corpus_message_count: Number(value.corpus_message_count) || 0,
    unique_message_count: Number(value.unique_message_count) || 0,
    conversation_count: Number(value.conversation_count) || 0,
    profile: value.profile && typeof value.profile === 'object'
      ? value.profile
      : {},
    recurring_replies: (Array.isArray(value.recurring_replies)
      ? value.recurring_replies
      : []).slice(0, 12),
  };
}

export function validateDraftQualityReview(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Message draft quality reviewer returned an invalid result');
  }
  const review = {
    decision: result.decision,
    answers_question_directly: result.answers_question_directly === true,
    uses_available_context: result.uses_available_context === true,
    asks_irrelevant_question: result.asks_irrelevant_question === true,
    greeting_appropriate: result.greeting_appropriate === true,
    fabricates_internal_process: result.fabricates_internal_process === true,
    unnecessarily_defers_answer: result.unnecessarily_defers_answer === true,
    natural_and_decisive: result.natural_and_decisive === true,
    unsupported_claims: (
      Array.isArray(result.unsupported_claims) ? result.unsupported_claims : []
    ).map(value => cleanText(value, 300)).filter(Boolean).slice(0, 12),
    confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
    rationale: cleanText(result.rationale, 1_500),
  };
  review.approved = (
    review.decision === 'approve'
    && review.answers_question_directly
    && review.uses_available_context
    && !review.asks_irrelevant_question
    && review.greeting_appropriate
    && !review.fabricates_internal_process
    && !review.unnecessarily_defers_answer
    && review.natural_and_decisive
    && review.unsupported_claims.length === 0
  );
  return review;
}

export async function reviewMessageDraftQuality({
  scenario,
  sourceMessageId,
  conversation,
  replyBody,
  verifiedFacts,
  shopContext = {},
  sellerStyleReference = null,
  generate = generateWithMessageAi,
}) {
  const result = await generate(
    `You are the independent quality gate for one Etsy reply draft.

Approve only when the proposed reply directly answers the exact triggering
buyer message, uses all relevant verified order context, asks no irrelevant
question, uses a greeting or no greeting appropriately for the conversation
position and observed seller style, makes no unsupported operational claim, and
sounds like a decisive human shop owner rather than a support dispatcher.

Set fabricates_internal_process=true when the reply attributes a current or
future action to the seller that is not grounded in the supplied conversation
or verified facts. Judge this semantically; wording alone is not enough.

Set unnecessarily_defers_answer=true when the reply postpones a question that
can reasonably be answered now. Distinguish unsupported guarantees from
reasonable non-guaranteed intent or effort, using the actual context rather
than a fixed phrase rule.

Set natural_and_decisive=false when the reply sounds like generic support
routing, over-hedges, repeats obvious information without helping, asks the
buyer to do unnecessary work, or is noticeably more verbose/ornate than the
situation and observed seller style call for. Also set it false when the reply
turns missing certainty into an unsupported negative conclusion (for example,
treating an unknown outcome as evidence the shop cannot do it) or prematurely
pushes the buyer to a fallback without a real blocker. A qualified willingness
or effort is not the same as a guaranteed operational outcome. Prefer the
shortest complete natural answer; for simple acknowledgements or confirmations,
extra reassurance, praise, repeated thanks, or promises about quality/effort
should appear only when they genuinely answer the buyer or clarify expectations.
Resolve references and shorthand from the conversation chronology before
treating them as ambiguous.

Block when the draft is not directly useful, relies on a materially unsupported
claim, or fails to use context that would change the answer. Do not block merely
because some nonessential fact is unavailable; a grounded, appropriately
qualified answer can still be good.`,
    JSON.stringify({
      task: 'Review one proposed Etsy reply before it can enter approval queue.',
      scenario,
      triggering_source_message_id: cleanText(sourceMessageId, 160) || null,
      participant: cleanText(
        conversation?.participant || conversation?.title,
        300,
      ) || null,
      recent_conversation: compactMessages(conversation?.messages),
      proposed_reply: cleanText(replyBody, 10_000),
      shop_context: shopContext && typeof shopContext === 'object' ? shopContext : {},
      seller_style_reference: compactSellerStyle(sellerStyleReference),
      verified_facts:
        verifiedFacts && typeof verifiedFacts === 'object' ? verifiedFacts : {},
    }, null, 2),
    '',
    {
      structuredOutput: true,
      structuredOutputSchema: QUALITY_SCHEMA,
      maxTokens: 1_500,
      temperature: 0,
      validateResult: validateDraftQualityReview,
    },
  );
  return validateDraftQualityReview(result);
}
