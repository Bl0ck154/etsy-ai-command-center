function enabledFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function clean(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

async function logRedactedDiagnostics() {
  try {
    const state = await readMessageTriggerState();
    const recent = Object.values(state?.candidates || {})
      .sort((a, b) => Date.parse(b?.updated_at || 0) - Date.parse(a?.updated_at || 0))
      .slice(0, 6)
      .map(candidate => ({
        id: clean(candidate?.id, 80),
        conversation_id: clean(candidate?.conversation_id, 80),
        scenario: clean(candidate?.scenario, 80) || null,
        status: clean(candidate?.status, 80),
        notification_status: clean(candidate?.notification_status, 80) || null,
        notification_attempts: Number(candidate?.notification_attempts) || 0,
        notification_error: clean(candidate?.notification_error, 300) || null,
        notification_due_at: clean(candidate?.notification_due_at, 80) || null,
        block_code: clean(candidate?.block_code, 160) || null,
        block_reason: clean(candidate?.block_reason, 500) || null,
        last_error: clean(candidate?.last_error, 300) || null,
        updated_at: clean(candidate?.updated_at, 80) || null,
      }));
    console.log(JSON.stringify({
      component: 'message-trigger-worker',
      event: 'diagnostics',
      telegram: {
        enabled: enabledFlag('MESSAGE_TELEGRAM_NOTIFICATIONS_ENABLED'),
        token_present: Boolean(clean(process.env.MESSAGE_TELEGRAM_BOT_TOKEN, 500)),
        suggestions_chat_id: clean(process.env.MESSAGE_SUGGESTIONS_CHAT_ID, 120) || null,
        approvals_chat_id: clean(process.env.MESSAGE_APPROVALS_CHAT_ID, 120) || null,
        public_base_url_present: Boolean(clean(process.env.PUBLIC_BASE_URL, 2_000)),
      },
      assistant_enabled: enabledFlag('MESSAGE_UNIVERSAL_ASSISTANT_ENABLED'),
      recent_candidates: recent,
      at: new Date().toISOString(),
    }));
  } catch (error) {
    console.error('[message-trigger-worker] diagnostics failed', clean(error?.message || error));
  }
}

import { createMessageTriggerWorker } from '../api/messages/trigger-worker.js';
import {
  readMessageTriggerState,
  writeMessageTriggerWorkerStatus,
} from '../api/messages/trigger-state-repository.js';
import {
  messageLearningStoreRequired,
  validateMessageLearningStore,
} from '../api/messages/learning-runtime.js';

if (messageLearningStoreRequired()) await validateMessageLearningStore();

const worker = createMessageTriggerWorker({ unrefTimers: false });
let stopping = false;
let finish;
const shutdownComplete = new Promise(resolve => { finish = resolve; });

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  await worker.shutdown();
  console.log(JSON.stringify({
    component: 'message-trigger-worker',
    event: 'stopped',
    signal,
    at: new Date().toISOString(),
  }));
  finish();
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

const started = worker.start();
if (!started) {
  await writeMessageTriggerWorkerStatus({
    enabled: false,
    running: false,
    status: 'disabled',
    last_error: null,
  });
}

console.log(JSON.stringify({
  component: 'message-trigger-worker',
  event: started ? 'started' : 'disabled',
  at: new Date().toISOString(),
}));
await logRedactedDiagnostics();

// A disabled worker remains supervised and exposes persisted status. Restarting
// the unit after an environment change re-evaluates the release gates.
const idleTimer = started ? null : setInterval(() => {}, 60 * 60 * 1000);
await shutdownComplete;
if (idleTimer) clearInterval(idleTimer);
