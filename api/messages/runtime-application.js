export function automationOutcome(candidate) {
  if (candidate.status === 'AWAITING_APPROVAL') return 'draft_created';
  if (candidate.status === 'BLOCKED') return 'blocked';
  if (candidate.status === 'RETRYABLE_ERROR') return 'retrying';
  if (String(candidate.status || '').startsWith('IGNORED_')) return 'ignored';
  return String(candidate.status || '').toLowerCase();
}

export function createMessagesRuntimeApplication({
  bridgeRequest,
  messageAutomationConfig,
  getMessageTriggerWorkerStatus,
  loadMessageAutomationPolicy,
  getMessageTriggerStatus,
}) {
  async function bridgeStatus() {
    return bridgeRequest('/v1/status');
  }

  function runtimeStatus(status) {
    const config = messageAutomationConfig();
    const account = status?.account || {
      label: 'unconfigured',
      mode: 'test',
    };
    const productionAccount = account.mode === 'production';
    return {
      ...config,
      account,
      order_linking_enabled: config.order_linking_enabled && productionAccount,
      automatic_triggers_enabled:
        config.automatic_triggers_enabled && productionAccount,
      approval_required: true,
      trigger_worker: getMessageTriggerWorkerStatus(),
      bridge: status,
      reserve_guard_active: !productionAccount,
    };
  }

  async function automationStatus(shopId) {
    const [policy, triggerState] = await Promise.all([
      loadMessageAutomationPolicy(shopId),
      getMessageTriggerStatus({ shop_id: shopId, limit: 100 }),
    ]);
    const config = messageAutomationConfig();
    const worker = getMessageTriggerWorkerStatus();
    const recent = triggerState.items || [];
    const lastCandidate = recent[0] || null;
    return {
      runtime: {
        implemented: true,
        enabled: config.automatic_triggers_enabled === true,
        worker_state: worker.last_error
          ? 'ERROR'
          : worker.running
            ? 'RUNNING'
            : worker.enabled
              ? 'READY'
              : 'PAUSED',
        delivery_mode: 'draft_only',
        human_approval_required: true,
        event_ingest_configured: config.event_ingest_configured,
        order_linking_enabled: config.order_linking_enabled,
        telegram_notifications_enabled:
          config.telegram_notifications_enabled,
        last_event_at: lastCandidate?.created_at || null,
        last_candidate_at: recent.find(item => item.draft_id)?.updated_at || null,
        last_tick_at: worker.last_tick_at,
        last_completed_at: worker.last_completed_at,
        last_error: worker.last_error,
      },
      policy,
      recent_events: recent.slice(0, 30).map(candidate => ({
        id: candidate.id,
        event: candidate.event,
        scenario: candidate.scenario,
        outcome: automationOutcome(candidate),
        status: candidate.status,
        conversation_id: candidate.conversation_id,
        participant: candidate.participant || null,
        draft_id: candidate.draft_id,
        block_code: candidate.block_code || null,
        reason: candidate.reason || candidate.block_reason || null,
        notification_status: candidate.notification_status,
        created_at: candidate.created_at,
        updated_at: candidate.updated_at,
      })),
    };
  }

  return {
    bridgeStatus,
    runtimeStatus,
    automationStatus,
  };
}
