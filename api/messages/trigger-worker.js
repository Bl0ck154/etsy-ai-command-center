import {
  messageTriggerRunnerAvailable,
  runDueMessageTriggerCandidates,
} from './trigger-runner.js';
import {
  readMessageTriggerWorkerStatus,
  writeMessageTriggerWorkerStatus,
} from './trigger-state-repository.js';

function configuredIntervalMs() {
  const seconds = Number.parseInt(
    process.env.MESSAGE_TRIGGER_WORKER_INTERVAL_SECONDS,
    10,
  );
  return Math.max(15, Math.min(Number.isFinite(seconds) ? seconds : 60, 300))
    * 1_000;
}

export function createMessageTriggerWorker({
  runDue = runDueMessageTriggerCandidates,
  isEnabled = () => messageTriggerRunnerAvailable().enabled,
  intervalMs = configuredIntervalMs(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  persistStatus = writeMessageTriggerWorkerStatus,
  unrefTimers = true,
  logger = console,
} = {}) {
  let timer = null;
  let initialTimer = null;
  let running = false;
  let activeTick = null;
  const state = {
    enabled: false,
    running: false,
    interval_ms: intervalMs,
    last_tick_at: null,
    last_completed_at: null,
    last_processed: 0,
    last_result_counts: {},
    last_error: null,
  };
  let statusPersistTail = Promise.resolve();

  function status() {
    return { ...state, last_result_counts: { ...state.last_result_counts } };
  }

  function queueStatusPersistence() {
    const snapshot = status();
    statusPersistTail = statusPersistTail
      .catch(() => {})
      .then(() => persistStatus(snapshot))
      .catch(error => {
        logger.error?.(
          '[message-trigger-worker] status persistence failed',
          String(error?.code || error?.message || error).slice(0, 300),
        );
      });
    return statusPersistTail;
  }

  async function runTick() {
    if (running) return { skipped: true, reason: 'overlap' };
    running = true;
    state.running = true;
    state.last_tick_at = new Date().toISOString();
    queueStatusPersistence();
    try {
      const result = await runDue({ limit: 5 });
      const counts = (result.candidates || []).reduce((summary, candidate) => {
        summary[candidate.status] = (summary[candidate.status] || 0) + 1;
        return summary;
      }, {});
      state.last_processed = Number(result.processed) || 0;
      state.last_result_counts = counts;
      state.last_error = null;
      if (result.processed) {
        const outcomes = (result.candidates || []).map(candidate => ({
          id: String(candidate?.id || '').slice(0, 80),
          conversation_id: String(candidate?.conversation_id || '').slice(0, 80),
          status: candidate?.status || null,
          notification_status: candidate?.notification_status || null,
          block_code: candidate?.block_code || null,
        }));
        logger.log?.('[message-trigger-worker] processed', { counts, outcomes });
      }
      return { skipped: false, result };
    } catch (error) {
      state.last_error = String(
        error?.code || error?.message || 'worker failed',
      ).slice(0, 300);
      logger.error?.('[message-trigger-worker]', state.last_error);
      return { skipped: false, error: state.last_error };
    } finally {
      running = false;
      state.running = false;
      state.last_completed_at = new Date().toISOString();
      await queueStatusPersistence();
    }
  }

  async function tick() {
    if (activeTick) return Promise.resolve({ skipped: true, reason: 'overlap' });
    const operation = runTick();
    activeTick = operation;
    try {
      return await operation;
    } finally {
      if (activeTick === operation) activeTick = null;
    }
  }

  function start() {
    if (timer || !isEnabled()) return false;
    state.enabled = true;
    timer = setIntervalFn(tick, intervalMs);
    if (unrefTimers) timer?.unref?.();
    initialTimer = setTimeoutFn(tick, 5_000);
    if (unrefTimers) initialTimer?.unref?.();
    queueStatusPersistence();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    if (initialTimer) {
      clearIntervalFn(initialTimer);
      initialTimer = null;
    }
    state.enabled = false;
    queueStatusPersistence();
    return true;
  }

  async function shutdown() {
    stop();
    const inFlight = activeTick;
    if (inFlight) await inFlight;
    state.enabled = false;
    state.running = false;
    await queueStatusPersistence();
    await statusPersistTail;
    return status();
  }

  return {
    flushStatus: () => statusPersistTail,
    shutdown,
    start,
    stop,
    tick,
    status,
  };
}

const defaultWorker = createMessageTriggerWorker();

export function startMessageTriggerWorker() {
  return defaultWorker.start();
}

export function stopMessageTriggerWorker() {
  return defaultWorker.stop();
}

export function getMessageTriggerWorkerStatus() {
  return defaultWorker.status();
}

export function getPersistedMessageTriggerWorkerStatus() {
  return readMessageTriggerWorkerStatus();
}
