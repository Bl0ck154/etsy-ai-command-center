function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

export function createMessageEventsApplication({
  enqueueMessageTriggerEvent,
  getMessageTriggerStatus,
  hydrateNewMessageTriggerEvent,
  hydrateOrderLinkedTriggerEvent,
  runDueMessageTriggerCandidates,
  scheduleImmediateMessageTriggerRun = () => ({ scheduled: false }),
  supersedePendingNewMessageCandidates = async () => ({ superseded: 0 }),
  getPersistedMessageTriggerWorkerStatus,
  defaultShopId = () => process.env.ETSY_SHOP_ID,
  now = () => new Date(),
} = {}) {
  async function status(input = {}) {
    const [data, persistedWorker] = await Promise.all([
      getMessageTriggerStatus({
        shop_id: cleanText(input.shop_id, 100),
        conversation_id: cleanText(input.conversation_id, 100),
        limit: input.limit,
      }),
      getPersistedMessageTriggerWorkerStatus(),
    ]);
    return {
      ...data,
      worker: persistedWorker || {
        version: 1,
        enabled: false,
        running: false,
        status: 'not_started',
      },
    };
  }

  async function runDue(input = {}) {
    return runDueMessageTriggerCandidates({
      now: input.now,
      limit: input.limit,
      candidate_id: input.candidate_id,
    });
  }

  async function ingest(input = {}, overrides = {}) {
    const supplied = { ...(input.event || input) };
    supplied.type = supplied.type || supplied.event || 'new_message';
    supplied.shop_id = supplied.shop_id || defaultShopId();
    supplied.occurred_at = supplied.occurred_at || now().toISOString();

    let hydration = null;
    if (supplied.type === 'new_message' && !supplied.source_message_id) {
      hydration = await hydrateNewMessageTriggerEvent(supplied);
      if (hydration.no_action) {
        return {
          status: 202,
          data: {
            queued: null,
            due: { processed: 0, candidates: [] },
            hydration,
          },
        };
      }
    } else if (supplied.type !== 'new_message') {
      try {
        const hydrateOrderEvent = overrides.hydrateOrderLinkedTriggerEvent
          || hydrateOrderLinkedTriggerEvent;
        hydration = await hydrateOrderEvent(supplied);
      } catch (error) {
        if (Number(error?.bridge_status || error?.status) !== 404) throw error;
        hydration = {
          event: supplied,
          hydrated: false,
          no_action: true,
          reason: 'No Etsy conversation is linked to this receipt',
        };
        return {
          status: 404,
          error: hydration.reason,
          code: 'MESSAGE_TRIGGER_ORDER_LINK_NOT_FOUND',
          data: { hydration },
        };
      }
    }

    const event = hydration?.event || supplied;
    const queued = await enqueueMessageTriggerEvent(event);
    let coalescing = { superseded: 0 };
    if (event.type === 'new_message' && queued?.duplicate !== true) {
      coalescing = await supersedePendingNewMessageCandidates({
        shop_id: event.shop_id,
        conversation_id: event.conversation_id,
        keep_event_id: event.event_id,
        keep_occurred_at: event.occurred_at,
        now: now().toISOString(),
      });
    }

    let due;
    if (input.process_due === true) {
      due = await runDueMessageTriggerCandidates({ limit: 10 });
    } else {
      const dispatch = scheduleImmediateMessageTriggerRun();
      due = {
        processed: 0,
        candidates: [],
        event_dispatch_scheduled: dispatch?.scheduled === true,
        debounce_ms: Number(dispatch?.debounce_ms) || null,
        fallback_worker: true,
      };
    }
    return {
      status: 202,
      data: { queued, due, hydration, coalescing },
    };
  }

  return { status, runDue, ingest };
}
