import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMessageLearningRepository,
  MESSAGE_LEARNING_FEEDBACK_RECORD_TYPE,
  MESSAGE_LEARNING_FEEDBACK_SCHEMA_VERSION,
} from '../api/messages/learning-feedback-repository.js';

const helper = fileURLToPath(new URL('./support/message-learning-process.mjs', import.meta.url));
const shopId = '12345678';

function testEnvironment() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'message-learning-'));
  const file = path.join(directory, 'feedback.json');
  return {
    directory,
    file,
    repository: createMessageLearningRepository({ file }),
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function proposal(overrides = {}) {
  return {
    shopId,
    draftId: 'draft-1',
    candidateId: 'candidate-1',
    conversationId: 'conversation-1',
    sourceMessageId: 'message-1',
    conversationHeadId: 'message-1',
    scenario: 'freeform',
    buyerMessage: 'Could you make the background a little lighter?',
    contextExcerpt: 'Buyer is reviewing the first version.',
    proposedBody: 'Yes, I can make the background a little lighter for you.',
    provenance: {
      provider: 'external_ai',
      model: 'gpt-5.4',
      promptVersion: 'messages-v3',
      responseSchemaVersion: 'draft-v2',
      playbookRevision: 7,
      evidenceDigest: 'abc123',
    },
    proposalCreatedAt: '2026-08-24T10:00:00.000Z',
    ...overrides,
  };
}

function waitForFiles(files, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (files.every(file => fs.existsSync(file))) return resolve();
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for child readiness'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function child(payload, readyFile, goFile) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const handle = spawn(process.execPath, [helper, encoded, readyFile, goFile], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  handle.stdout.on('data', chunk => { stdout += chunk; });
  handle.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    handle.once('error', reject);
    handle.once('close', code => {
      if (code !== 0) return reject(new Error(`Learning child exited ${code}: ${stderr} ${stdout}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid child output: ${stdout}`)); }
    });
  });
}

test('captures one immutable versioned proposal snapshot and rejects key reuse with different text', async () => {
  const env = testEnvironment();
  try {
    const captured = await env.repository.captureProposal(proposal());
    expect(captured).toMatchObject({
      shop_id: shopId,
      draft_id: 'draft-1',
      candidate_id: 'candidate-1',
      scenario: 'freeform',
      buyer_message: 'Could you make the background a little lighter?',
      proposed_body: 'Yes, I can make the background a little lighter for you.',
      outcome: null,
      provenance: {
        provider: 'external_ai',
        model: 'gpt-5.4',
        playbook_revision: 7,
      },
    });
    expect(captured.proposed_body_sha256).toMatch(/^[a-f0-9]{64}$/);

    const repeated = await env.repository.captureProposal(proposal({
      buyerMessage: 'This later retry must not rewrite the original snapshot.',
      contextExcerpt: 'Changed retry context.',
    }));
    expect(repeated).toEqual(captured);
    expect((await env.repository.getByDraft({ shopId, draftId: 'draft-1' })).buyer_message)
      .toBe('Could you make the background a little lighter?');

    await expect(env.repository.captureProposal(proposal({ proposedBody: 'A conflicting proposal.' })))
      .rejects.toMatchObject({ code: 'MESSAGE_LEARNING_PROPOSAL_CONFLICT', status: 409 });

    const persisted = JSON.parse(fs.readFileSync(env.file, 'utf8'));
    expect(persisted).toMatchObject({
      version: 1,
      schema_version: MESSAGE_LEARNING_FEEDBACK_SCHEMA_VERSION,
      record_type: MESSAGE_LEARNING_FEEDBACK_RECORD_TYPE,
      shops: { [shopId]: { revision: 1 } },
    });
    expect(persisted.shops[shopId].entries).toHaveLength(1);
  } finally {
    env.cleanup();
  }
});

test('adds a draft alias to a candidate snapshot without changing the immutable proposal', async () => {
  const env = testEnvironment();
  try {
    const first = await env.repository.captureProposal(proposal({ draftId: null }));
    const linked = await env.repository.captureProposal(proposal());
    expect(linked.id).toBe(first.id);
    expect(linked.identity_keys).toEqual(expect.arrayContaining([
      'candidate:candidate-1',
      'draft:draft-1',
    ]));
    expect((await env.repository.getByDraft({ shopId, draftId: 'draft-1' })).id).toBe(first.id);
  } finally {
    env.cleanup();
  }
});

test('only confirmed SENT outcomes become eligible and exact versus edited use is labelled', async () => {
  const env = testEnvironment();
  try {
    await env.repository.captureProposal(proposal());
    const exact = await env.repository.recordDeliveryOutcome({
      shopId,
      draftId: 'draft-1',
      status: 'SENT',
      finalBody: proposal().proposedBody,
      deliveryReference: 'bridge-result-1',
      resolvedAt: '2026-08-24T10:05:00.000Z',
    });
    expect(exact.outcome.label).toBe('accepted_exact');

    await env.repository.captureProposal(proposal({
      draftId: 'draft-2', candidateId: 'candidate-2', proposedBody: 'Sure, I can do that.',
    }));
    const edited = await env.repository.recordDeliveryOutcome({
      shopId,
      draftId: 'draft-2',
      status: 'SENT',
      finalBody: 'Yes, I can make that change for you.',
      resolvedAt: '2026-08-24T10:06:00.000Z',
    });
    expect(edited.outcome.label).toBe('edited_sent');

    await env.repository.captureProposal(proposal({
      draftId: 'draft-3', candidateId: 'candidate-3', proposedBody: 'Attempted reply.',
    }));
    await env.repository.recordDeliveryOutcome({
      shopId,
      draftId: 'draft-3',
      status: 'UNKNOWN',
      finalBody: 'Attempted reply.',
      reason: 'Browser confirmation was ambiguous.',
      resolvedAt: '2026-08-24T10:07:00.000Z',
    });

    await env.repository.captureProposal(proposal({
      draftId: 'draft-4', candidateId: 'candidate-4', proposedBody: 'Stale reply.',
    }));
    await env.repository.recordDeliveryOutcome({
      shopId,
      draftId: 'draft-4',
      status: 'STALE',
      reason: 'Conversation head changed.',
      resolvedAt: '2026-08-24T10:08:00.000Z',
    });

    const examples = await env.repository.listEligibleExamples({ shopId, scenario: 'freeform' });
    expect(examples.map(item => item.outcome_label)).toEqual(['edited_sent', 'accepted_exact']);
    expect(examples[0]).toMatchObject({
      id: edited.id,
      buyer_message: proposal().buyerMessage,
      proposed_body: 'Sure, I can do that.',
      final_body: 'Yes, I can make that change for you.',
      outcome_label: 'edited_sent',
      learning_kind: 'edited_sent',
      buyer_context: proposal().contextExcerpt,
      provenance: { provider: 'external_ai', model: 'gpt-5.4' },
    });
    expect(examples.some(item => item.draft_id === 'draft-3')).toBe(false);
    expect(examples.some(item => item.draft_id === 'draft-4')).toBe(false);
  } finally {
    env.cleanup();
  }
});

test('accepts the Messages learning application aliases for generation metadata and outcomes', async () => {
  const env = testEnvironment();
  try {
    const captured = await env.repository.captureProposal({
      shopId,
      draftId: 'draft-app',
      scenario: 'freeform',
      buyerMessage: 'Can you keep it blue?',
      buyerContext: 'shop: Hello\nbuyer: Can you keep it blue?',
      proposedBody: 'Yes, I can keep it blue.',
      playbookRevision: 9,
      evidenceDigest: 'evidence-digest',
      generation: {
        prompt_version: 'message-draft-v2-learning-memory',
        learned_example_count: 3,
        final_provider: { provider_id: 'omniroute', model: 'gpt-5.4' },
      },
    });
    expect(captured).toMatchObject({
      context_excerpt: 'shop: Hello\nbuyer: Can you keep it blue?',
      provenance: {
        provider: 'omniroute',
        model: 'gpt-5.4',
        prompt_version: 'message-draft-v2-learning-memory',
        playbook_revision: 9,
        evidence_digest: 'evidence-digest',
        learned_example_count: 3,
      },
    });

    const sent = await env.repository.recordDeliveryOutcome({
      shopId,
      draftId: 'draft-app',
      outcome: 'SENT',
      finalBody: 'Yes, I can keep it blue.',
      actor: 'owner',
      deliveredAt: '2026-08-24T11:00:00.000Z',
    });
    expect(sent.outcome).toMatchObject({
      status: 'SENT', label: 'accepted_exact', actor: 'owner',
      resolved_at: '2026-08-24T11:00:00.000Z',
    });
  } finally {
    env.cleanup();
  }
});

test('UNKNOWN remains excluded but can be reconciled once to confirmed SENT', async () => {
  const env = testEnvironment();
  try {
    await env.repository.captureProposal(proposal());
    await env.repository.recordDeliveryOutcome({
      shopId,
      draftId: 'draft-1',
      status: 'UNKNOWN',
      finalBody: proposal().proposedBody,
      resolvedAt: '2026-08-24T10:05:00.000Z',
    });
    expect(await env.repository.listEligibleExamples({ shopId })).toEqual([]);

    const reconciled = await env.repository.recordDeliveryOutcome({
      shopId,
      draftId: 'draft-1',
      status: 'SENT',
      finalBody: proposal().proposedBody,
      deliveryReference: 'confirmed-after-reconciliation',
      resolvedAt: '2026-08-24T10:10:00.000Z',
    });
    expect(reconciled.outcome).toMatchObject({ status: 'SENT', label: 'accepted_exact' });
    expect(await env.repository.listEligibleExamples({ shopId })).toHaveLength(1);

    await expect(env.repository.recordDeliveryOutcome({
      shopId,
      draftId: 'draft-1',
      status: 'FAILED',
    })).rejects.toMatchObject({ code: 'MESSAGE_LEARNING_OUTCOME_CONFLICT', status: 409 });
  } finally {
    env.cleanup();
  }
});

test('Telegram feedback is explicit and idempotent, and unhelpful suggestions become negative memory', async () => {
  const env = testEnvironment();
  try {
    const captured = await env.repository.captureProposal(proposal());
    await env.repository.recordDeliveryOutcome({
      shopId, recordId: captured.id, status: 'SENT', finalBody: proposal().proposedBody,
    });
    const feedback = await env.repository.recordTelegramFeedback({
      shopId,
      recordId: captured.id,
      callbackQueryId: 'telegram-callback-1',
      rating: 'unhelpful',
      actorId: 'owner-1',
      telegramMessageId: 'telegram-message-1',
      recordedAt: '2026-08-24T10:10:00.000Z',
    });
    expect(feedback.feedback.latest).toMatchObject({
      event_id: 'telegram-callback-1', rating: 'unhelpful', actor_id: 'owner-1',
    });
    const duplicate = await env.repository.recordTelegramFeedback({
      shopId,
      draftId: 'draft-1',
      eventId: 'telegram-callback-1',
      rating: 'unhelpful',
    });
    expect(duplicate.feedback.events).toHaveLength(1);
    expect(await env.repository.listEligibleExamples({ shopId })).toEqual([
      expect.objectContaining({
        id: captured.id,
        learning_kind: 'explicit_unhelpful',
        proposed_body: proposal().proposedBody,
        final_body: null,
        telegram_feedback: 'unhelpful',
      }),
    ]);

    await expect(env.repository.recordTelegramFeedback({
      shopId,
      draftId: 'draft-1',
      eventId: 'telegram-callback-1',
      rating: 'helpful',
    })).rejects.toMatchObject({ code: 'MESSAGE_LEARNING_FEEDBACK_CONFLICT', status: 409 });
  } finally {
    env.cleanup();
  }
});

test('an explicit unhelpful Telegram signal is usable as negative memory before delivery', async () => {
  const env = testEnvironment();
  try {
    const captured = await env.repository.captureProposal(proposal({
      draftId: 'draft-unsent',
      proposedBody: 'A vague reply that postpones the answer.',
    }));
    await env.repository.recordTelegramFeedback({
      shopId,
      draftId: 'draft-unsent',
      eventId: 'telegram-unsent-negative',
      rating: 'unhelpful',
    });
    expect(await env.repository.listEligibleExamples({ shopId })).toEqual([
      expect.objectContaining({
        id: captured.id,
        learning_kind: 'explicit_unhelpful',
        final_body: null,
        proposed_body: 'A vague reply that postpones the answer.',
      }),
    ]);
  } finally {
    env.cleanup();
  }
});

test('retention is bounded per shop and keeps the most recently active records', async () => {
  const env = testEnvironment();
  try {
    const repository = createMessageLearningRepository({
      file: env.file,
      maxRecordsPerShop: 2,
      clock: () => new Date('2026-08-24T10:00:00.000Z'),
    });
    await repository.captureProposal(proposal({
      draftId: 'draft-1', candidateId: 'candidate-1', proposalCreatedAt: '2026-08-24T10:00:00.000Z',
    }));
    await repository.captureProposal(proposal({
      draftId: 'draft-2', candidateId: 'candidate-2', proposalCreatedAt: '2026-08-24T10:01:00.000Z',
    }));
    await repository.captureProposal(proposal({
      draftId: 'draft-3', candidateId: 'candidate-3', proposalCreatedAt: '2026-08-24T10:02:00.000Z',
    }));

    expect(await repository.getByDraft({ shopId, draftId: 'draft-1' })).toBeNull();
    expect(await repository.getByDraft({ shopId, draftId: 'draft-2' })).not.toBeNull();
    expect(await repository.getByDraft({ shopId, draftId: 'draft-3' })).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(env.file, 'utf8')).shops[shopId].entries).toHaveLength(2);
  } finally {
    env.cleanup();
  }
});

test('separate writer processes preserve both proposal snapshots in one complete envelope', async () => {
  const env = testEnvironment();
  try {
    const goFile = path.join(env.directory, 'go');
    const readyFiles = [1, 2].map(index => path.join(env.directory, `writer-${index}.ready`));
    const outcomes = readyFiles.map((readyFile, index) => child({
      file: env.file,
      input: proposal({
        draftId: `draft-${index + 1}`,
        candidateId: `candidate-${index + 1}`,
        proposedBody: `Proposal ${index + 1}`,
      }),
    }, readyFile, goFile));
    await waitForFiles(readyFiles);
    fs.writeFileSync(goFile, 'go');
    await expect(Promise.all(outcomes)).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);

    const persisted = JSON.parse(fs.readFileSync(env.file, 'utf8'));
    expect(persisted.record_type).toBe(MESSAGE_LEARNING_FEEDBACK_RECORD_TYPE);
    expect(persisted.shops[shopId].revision).toBe(2);
    expect(persisted.shops[shopId].entries.map(entry => entry.draft_id).sort())
      .toEqual(['draft-1', 'draft-2']);
    await expect(env.repository.validate()).resolves.toBe(true);
  } finally {
    env.cleanup();
  }
});

test('a failed atomic replace preserves the previous complete learning record', async () => {
  const env = testEnvironment();
  try {
    await env.repository.captureProposal(proposal());
    const crashing = createMessageLearningRepository({
      file: env.file,
      repositoryOptions: {
        beforeAtomicReplace: async () => { throw new Error('simulated crash before rename'); },
      },
    });
    await expect(crashing.captureProposal(proposal({
      draftId: 'draft-2', candidateId: 'candidate-2', proposedBody: 'Second proposal.',
    }))).rejects.toThrow(/simulated crash before rename/);

    const persisted = JSON.parse(fs.readFileSync(env.file, 'utf8'));
    expect(persisted.shops[shopId].entries).toHaveLength(1);
    expect(persisted.shops[shopId].entries[0].draft_id).toBe('draft-1');
    expect(fs.readdirSync(env.directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(fs.existsSync(`${env.file}.lock`)).toBe(false);
  } finally {
    env.cleanup();
  }
});
