import path from 'node:path';

import { createMessageRevisionedStoreRepository } from './revisioned-store-repository.js';

export const MESSAGE_SCENARIOS = Object.freeze([
  'how_to_send_files',
  'materials_sent_by_email',
  'how_to_order',
  'missing_materials',
  'deadline_variants_sent',
  'deadline_no_materials',
  'review_request',
  'freeform',
]);

const DEFAULT_SCENARIOS = Object.freeze({
  how_to_send_files: {
    label: 'How to send files',
    enabled: true,
    requires_order_context: true,
    instructions: 'This scenario is only for a buyer with an exact verified paid Etsy order linked to the conversation. Explain the shop-approved file delivery options in one concise paragraph. Use only options present in the supplied context. Do not invent an email address, upload link, file limit, or turnaround time.',
  },
  materials_sent_by_email: {
    label: 'Buyer says materials were emailed',
    enabled: true,
    requires_order_context: true,
    instructions: 'The buyer says files or photos were already sent by email. Use only the on-demand email_claim evidence searched from the exact paid_at of the linked Etsy order. Acknowledge receipt only for a verified match: the unique customer email, an exact receipt reference from a personal sender, or an exact unique full-name identity. If a possible personal sender exists, respond naturally that a possible matching email with attachments was found and will be checked against the order; do not ask a redundant question such as "Was that email from Federica Wasilewska?" when the buyer is already named Federica, and do not state that the files are definitely theirs. Never expose an email address. If no candidate was found, politely ask the buyer to resend using only a delivery address verified in listing context.',
  },
  how_to_order: {
    label: 'How to order',
    enabled: true,
    requires_order_context: false,
    instructions: 'Treat the buyer as a pre-sale prospect. Direct them to place or choose an order before the shop reviews any photos, files, or materials. Never invite them to send materials and never promise to inspect or perform work before purchase. Use only exact verified listing facts supplied in context when naming a listing, link, variation, or personalization field. Never state a price. If no exact verified listing is available, ask exactly one concise clarification question that includes ordering intent; do not recommend or link a listing or option.',
  },
  missing_materials: {
    label: 'Missing materials',
    enabled: true,
    requires_order_context: true,
    instructions: 'Politely explain that the shop is ready to begin and that the required customer materials are not yet present in the Trello operational order record. Use only verified delivery methods from the listing/order context. Do not require an exhaustive Gmail search. If the buyer explicitly says they already emailed the files, do not send this reminder; use the dedicated email-claim workflow.',
  },
  deadline_variants_sent: {
    label: 'Deadline: variants sent',
    enabled: true,
    requires_order_context: true,
    instructions: 'Explain that the order deadline is approaching or has arrived, provide only the verified result link supplied in context, and clearly state the next operational step. Do not use a threatening or blaming tone.',
  },
  deadline_no_materials: {
    label: 'Deadline: no materials',
    enabled: true,
    requires_order_context: true,
    instructions: 'Explain that the current order deadline has arrived but the buyer may send the required materials later when ready, if that policy is explicitly present in context. Do not claim the order was canceled or closed unless confirmed.',
  },
  review_request: {
    label: 'Review request',
    enabled: false,
    requires_order_context: true,
    instructions: 'Write one neutral, optional review request. Never request a positive or five-star review, never offer an incentive, and never draft this while an order issue is active. This scenario always requires individual owner approval.',
  },
  freeform: {
    label: 'Custom reply',
    enabled: true,
    requires_order_context: false,
    instructions: 'Draft a direct response using the supplied conversation, verified facts, shop operating context, owner notes, and seller style. Resolve ordinary ambiguity from context; ask for clarification only when a materially important uncertainty remains.',
  },
});

export const DEFAULT_MESSAGE_PLAYBOOK = Object.freeze({
  tone: {
    summary: 'Warm, calm, concise, and helpful. Sound like a real shop owner, not a support script.',
    response_length: 'Usually 2-5 short sentences. Use a second short paragraph only when it improves clarity.',
    language_policy: 'Reply in the buyer’s language when it is clear from the conversation. Otherwise use English.',
    signature: '',
  },
  business_context: {
    summary: (
      'The shop provides custom digital image and portrait work. A conversation may span purchase, reference material, draft versions, buyer feedback, revisions, and final digital delivery.'
    ),
    workflow: [
      'Interpret references to earlier versions, choices, people, backgrounds, or edits from the conversation chronology instead of treating each message in isolation.',
      'Use prior buyer decisions and shop replies to understand what work is currently being discussed, while keeping unverified operational status separate from conversational context.',
      'Resolve ordinary shorthand and imperfect grammar from context when the intended meaning is sufficiently clear; ask only when the remaining ambiguity could materially change the work or another important outcome.',
    ],
    response_principles: [
      'Answer as the shop owner responsible for helping the buyer, with a natural, direct, and appropriately warm tone.',
      'Distinguish confirmed facts, reasonable non-guaranteed commitments, and unknown operational state instead of collapsing them into the same thing.',
      'Do not treat missing certainty as proof that the shop cannot do something. When no verified blocker exists, prefer an appropriately qualified statement of willingness or effort over a negative refusal or premature fallback.',
      'Do not invent seller actions, internal workflow, or future follow-up activity that is not grounded in the conversation or verified facts.',
      'Answer the practical question first and mention alternatives or fallbacks only when they add useful clarity.',
      'Prefer the shortest complete natural reply that fits the situation and observed seller style. Do not add generic reassurance, praise, marketing language, or repeated thanks unless it serves the buyer’s question or is genuinely characteristic here.',
      'For a simple acknowledgement or confirmation, keep the reply to the essentials. Do not add extra promises about quality, effort, or outcome unless they answer something the buyer actually raised or materially clarify expectations.',
    ],
  },
  hard_rules: [
    'Do not present files, payment, approval, delivery, cancellation, deadline state, or other operational facts as verified unless the supplied context supports them.',
    'Do not invent prices, links, listing options, deadlines, file limits, email addresses, discounts, or guaranteed turnaround times.',
    'When a buyer wants to start custom work or submit materials and no exact paid Etsy order is verified, direct them to order first; do not force unrelated questions into purchase guidance.',
    'Never pressure a buyer, blame them, or imply that a positive review is expected.',
    'When information is incomplete, answer what can be answered safely and use clarification only when it is materially necessary. Block only when a useful reply would otherwise require guessing an important fact.',
    'Every outgoing message requires individual human approval.',
  ],
  avoid_phrases: [
    'leave a five-star review',
    'we need a positive review',
    'as an AI',
    'our system detected',
  ],
  scenarios: DEFAULT_SCENARIOS,
  examples: [],
});

function playbookPath() {
  return process.env.MESSAGE_PLAYBOOK_FILE
    || path.join(process.cwd(), 'data', 'message-agent-playbooks.json');
}

const playbookRepository = createMessageRevisionedStoreRepository({
  file: playbookPath,
  recordType: 'message_playbook_store',
  migrateRecord: record => ({
    ...record,
    history: Array.isArray(record?.history) ? record.history : [],
  }),
  validateRecord: record => (
    Number.isInteger(record?.revision)
    && record.revision > 0
    && (record.updated_at == null || (
      typeof record.updated_at === 'string'
      && Number.isFinite(Date.parse(record.updated_at))
    ))
    && (record.updated_by == null || typeof record.updated_by === 'string')
    && record.playbook
    && typeof record.playbook === 'object'
    && !Array.isArray(record.playbook)
    && Array.isArray(record.history)
  ),
});

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function cloneDefaultPlaybook() {
  return JSON.parse(JSON.stringify(DEFAULT_MESSAGE_PLAYBOOK));
}

function normalizeStringList(value, maxItems = 30, maxLength = 600) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function normalizeMessagePlaybook(value = {}) {
  const defaults = cloneDefaultPlaybook();
  const tone = value?.tone && typeof value.tone === 'object' ? value.tone : {};
  const businessContext = value?.business_context && typeof value.business_context === 'object'
    ? value.business_context
    : {};
  const suppliedScenarios = value?.scenarios && typeof value.scenarios === 'object'
    ? value.scenarios
    : {};
  const scenarios = {};

  for (const key of MESSAGE_SCENARIOS) {
    const base = defaults.scenarios[key];
    const supplied = suppliedScenarios[key] && typeof suppliedScenarios[key] === 'object'
      ? suppliedScenarios[key]
      : {};
    scenarios[key] = {
      label: cleanText(supplied.label || base.label, 80),
      enabled: supplied.enabled === undefined ? Boolean(base.enabled) : supplied.enabled === true,
      requires_order_context: Boolean(base.requires_order_context),
      instructions: cleanText(supplied.instructions || base.instructions, 4_000),
    };
  }

  const examples = (Array.isArray(value.examples) ? value.examples : [])
    .map((example, index) => {
      const scenario = MESSAGE_SCENARIOS.includes(example?.scenario)
        ? example.scenario
        : 'freeform';
      return {
        id: cleanText(example?.id, 80) || `example_${index + 1}`,
        scenario,
        customer_message: cleanText(example?.customer_message, 4_000),
        ideal_reply: cleanText(example?.ideal_reply, 6_000),
        context: cleanText(example?.context, 4_000),
        notes: cleanText(example?.notes, 2_000),
      };
    })
    .filter(example => example.customer_message && example.ideal_reply)
    .slice(0, 50);

  return {
    tone: {
      summary: cleanText(tone.summary || defaults.tone.summary, 2_000),
      response_length: cleanText(
        tone.response_length || defaults.tone.response_length,
        1_000,
      ),
      language_policy: cleanText(
        tone.language_policy || defaults.tone.language_policy,
        1_000,
      ),
      signature: cleanText(tone.signature, 500),
    },
    business_context: {
      summary: cleanText(
        businessContext.summary || defaults.business_context.summary,
        4_000,
      ),
      workflow: normalizeStringList(businessContext.workflow, 30, 1_500).length
        ? normalizeStringList(businessContext.workflow, 30, 1_500)
        : defaults.business_context.workflow,
      response_principles: normalizeStringList(
        businessContext.response_principles,
        30,
        1_500,
      ).length
        ? normalizeStringList(businessContext.response_principles, 30, 1_500)
        : defaults.business_context.response_principles,
    },
    hard_rules: normalizeStringList(value.hard_rules, 40, 1_000).length
      ? normalizeStringList(value.hard_rules, 40, 1_000)
      : defaults.hard_rules,
    avoid_phrases: normalizeStringList(value.avoid_phrases, 50, 300),
    scenarios,
    examples,
  };
}

function normalizeShopId(value) {
  const id = String(value || '').replace(/[^0-9]/g, '');
  if (!id) {
    const error = new Error('A numeric Etsy shop ID is required');
    error.status = 400;
    throw error;
  }
  return id;
}

export async function loadMessagePlaybook(shopId) {
  const id = normalizeShopId(shopId);
  const saved = await playbookRepository.load(id);
  if (!saved) {
    return {
      revision: 0,
      updated_at: null,
      updated_by: null,
      playbook: cloneDefaultPlaybook(),
    };
  }
  return {
    revision: Number(saved.revision) || 0,
    updated_at: saved.updated_at || null,
    updated_by: saved.updated_by || null,
    playbook: normalizeMessagePlaybook(saved.playbook),
  };
}

export async function saveMessagePlaybook(
  shopId,
  value,
  { expectedRevision, updatedBy } = {},
) {
  const id = normalizeShopId(shopId);
  const normalized = normalizeMessagePlaybook(value);
  const next = await playbookRepository.save(id, {
    expectedRevision,
    conflictError(currentRevision) {
      const error = new Error(
        `Playbook changed since it was opened (current revision ${currentRevision})`,
      );
      error.status = 409;
      error.code = 'MESSAGE_PLAYBOOK_REVISION_CONFLICT';
      return error;
    },
    buildRecord(current, currentRevision) {
      const now = new Date().toISOString();
      const updatedByValue = cleanText(updatedBy, 120) || 'unknown';
      return {
        revision: currentRevision + 1,
        updated_at: now,
        updated_by: updatedByValue,
        playbook: normalized,
        history: [
          {
            revision: currentRevision + 1,
            updated_at: now,
            updated_by: updatedByValue,
          },
          ...(Array.isArray(current?.history) ? current.history : []),
        ].slice(0, 30),
      };
    },
  });
  return {
    revision: next.revision,
    updated_at: next.updated_at,
    updated_by: next.updated_by,
    playbook: next.playbook,
  };
}

export async function validateMessagePlaybookStore() {
  return playbookRepository.validate();
}
