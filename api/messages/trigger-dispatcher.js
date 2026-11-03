import {
  runDueMessageTriggerCandidates,
} from './trigger-runner.js';
import {
  mutateMessageTriggerState as mutateState,
} from './trigger-state-repository.js';

function configuredDebounceMs() {
  const seconds = Number.parseFloat(
    process.env.MESSAGE_TRIGGER_EVENT_DEBOUNCE_SECONDS,
  );
  const bounded = Number.isFinite(seconds)
    ? Math.max(0.5, Math.min(seconds, 30))
    : 3;
  return Math.round(bounded * 1_000);
}

export async function supersedePendingNewMessageCandidates({
  shop_id: shopId,
  conversation_id: conversationId,
  keep_event_id: keepEventId,
  keep_occurred_at: keepOccurredAt,
  now = new Date().toISOString(),
} = {}) {
  const shop = String(shopId || '').trim();
  const conversation = String(conversationId || '').trim();
  const keepEvent = String(keepEventId || '').trim();
  const keepOccurredMs = Date.parse(String(keepOccurredAt || ''));
  if (!shop || !conversation || !keepEvent) return { superseded: 0 };

  return mutateState(async state => {
    let superseded = 0;
    for (const candidate of Object.values(state.candidates || {})) {
      if (
        candidate.event !== 'new_message'
        || candidate.shop_id !== shop
        || candidate.conversation_id !== conversation
        || candidate.event_id === keepEvent
        || !['PENDING', 'RETRYABLE_ERROR'].includes(candidate.status)
      ) continue;
      const otherEvent = state.events?.[candidate.event_key];
      const otherOccurredMs = Date.parse(String(otherEvent?.occurred_at || ''));
      if (
        Number.isFinite(keepOccurredMs)
        && Number.isFinite(otherOccurredMs)
        && otherOccurredMs > keepOccurredMs
      ) continue;

      candidate.status = 'IGNORED_SUPERSEDED';
      candidate.block_code = 'MESSAGE_TRIGGER_SUPERSEDED_BY_NEWER_MESSAGE';
      candidate.block_reason = (
        `A newer message notification for this conversation superseded event ${candidate.event_id}`
      );
      candidate.updated_at = now;
      superseded += 1;
    }
    return { superseded };
  });
}

export function createMessageTriggerEventDispatcher({
  runDue = runDueMessageTriggerCandidates,
  debounceMs = configuredDebounceMs(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
  unrefTimers = true,
} = {}) {
  let timer = null;
  let running = false;
  let rerunRequested = false;

  async function dispatch() {
    timer = null;
    if (running) {
      rerunRequested = true;
      return { scheduled: true, reason: 'already_running' };
    }
    running = true;
    try {
      const result = await runDue({ limit: 10 });
      if (result?.processed) {
        logger.log?.('[message-trigger-dispatcher] processed', result.processed);
      }
      return result;
    } catch (error) {
      logger.error?.(
        '[message-trigger-dispatcher]',
        String(error?.code || error?.message || error).slice(0, 300),
      );
      return { error: String(error?.code || error?.message || error) };
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (running) {
      rerunRequested = true;
      return { scheduled: true, debounce_ms: debounceMs, coalesced: true };
    }
    const coalesced = Boolean(timer);
    if (timer) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      void dispatch();
    }, debounceMs);
    if (unrefTimers) timer?.unref?.();
    return { scheduled: true, debounce_ms: debounceMs, coalesced };
  }

  function stop() {
    if (!timer) return false;
    clearTimeoutFn(timer);
    timer = null;
    rerunRequested = false;
    return true;
  }

  return {
    dispatch,
    schedule,
    stop,
    status: () => ({
      scheduled: Boolean(timer),
      running,
      rerun_requested: rerunRequested,
      debounce_ms: debounceMs,
    }),
  };
}

const defaultDispatcher = createMessageTriggerEventDispatcher();

export function scheduleImmediateMessageTriggerRun() {
  return defaultDispatcher.schedule();
}

export function getMessageTriggerEventDispatcherStatus() {
  return defaultDispatcher.status();
}
