export const AGENT_RUNTIME_FAULT_SCHEMA = 'agent_runtime_fault_v1';

const FAULT_DOMAINS = new Set(['application', 'workflow', 'provider', 'user_environment']);

function cleanToken(value, fallback, max = 96) {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, max);
  return cleaned || fallback;
}

export function createAgentRuntimeFault(options = {}) {
  const faultDomain = FAULT_DOMAINS.has(options.fault_domain) ? options.fault_domain : 'application';
  const safeMessage = String(options.safe_message || 'Etsy AI Command Center could not complete this step because of an internal problem.').trim().slice(0, 600);
  return {
    schema: AGENT_RUNTIME_FAULT_SCHEMA,
    code: cleanToken(options.code, 'APP_INTERNAL_ERROR'),
    operation: cleanToken(options.operation, 'unknown_operation'),
    fault_domain: faultDomain,
    retryable: options.retryable === true,
    user_action_required: faultDomain === 'user_environment' && options.user_action_required === true,
    safe_message: safeMessage,
    ...(options.recovery ? { recovery: cleanToken(options.recovery, 'retry_operation', 160) } : {}),
    ...(options.required_transition ? { required_transition: cleanToken(options.required_transition, '', 160) } : {}),
    ...(options.workflow_id ? { workflow_id: cleanToken(options.workflow_id, '', 160) } : {}),
    ...(options.state ? { state: cleanToken(options.state, '', 96) } : {}),
  };
}

export function toolFaultResult(options = {}) {
  const fault = createAgentRuntimeFault(options);
  return { status: 'error', error: fault.safe_message, fault };
}

export function mayRequestLocalUserAction(fault) {
  return fault?.schema === AGENT_RUNTIME_FAULT_SCHEMA
    && fault.fault_domain === 'user_environment'
    && fault.user_action_required === true;
}

export function agentModelConversation(messages = []) {
  return Array.isArray(messages)
    ? messages.filter(message => message?.role === 'user' || message?.role === 'assistant')
    : [];
}

export function agentRuntimeUserMessage(faultInput = {}) {
  const fault = createAgentRuntimeFault(faultInput);
  if (mayRequestLocalUserAction(fault)) return `${fault.safe_message} Reference: ${fault.code}.`;
  const preserved = fault.code === 'AGENT_LISTING_DRAFT_REQUIRED'
    ? 'The generated images remain saved.'
    : fault.code === 'APP_LISTING_IMAGE_APPLY_PARTIAL'
      ? 'Completed work was preserved for an idempotent retry.'
      : 'Your existing data was left unchanged.';
  return `${fault.safe_message} ${preserved} Reference: ${fault.code}.`;
}

export function classifyAgentRuntimeError(error, options = {}) {
  if (error?.runtime_fault?.schema === AGENT_RUNTIME_FAULT_SCHEMA) return createAgentRuntimeFault(error.runtime_fault);
  const raw = String(error?.message || error || 'Unknown error');
  const common = {
    operation: options.operation || 'unknown_operation',
    workflow_id: options.workflow_id || '',
    state: options.state || '',
  };
  if (error?.name === 'QuotaExceededError' || /quota|storage.*full|exceeded.*storage/i.test(raw)) {
    return createAgentRuntimeFault({
      ...common,
      code: 'APP_STORAGE_QUOTA',
      fault_domain: 'application',
      retryable: true,
      recovery: 'use_persistent_references',
      safe_message: 'Etsy AI Command Center ran out of temporary browser storage while moving generated data.',
    });
  }
  if (/no listing draft|draft.*does not exist|create or open a draft/i.test(raw)) {
    return createAgentRuntimeFault({
      ...common,
      code: 'AGENT_LISTING_DRAFT_REQUIRED',
      fault_domain: 'workflow',
      retryable: true,
      required_transition: 'generate_listing_content',
      safe_message: 'Listing content must be generated before these images can be attached.',
    });
  }
  if (/generated image.*missing|saved generated images.*no longer available|image records are unavailable/i.test(raw)) {
    return createAgentRuntimeFault({
      ...common,
      code: 'APP_GENERATED_ASSET_MISSING',
      fault_domain: 'application',
      retryable: true,
      recovery: 'regenerate_missing_previews',
      safe_message: 'Etsy AI Command Center could not read one or more saved generated images.',
    });
  }
  if (/session expired|log in again|unauthorized|auth_required/i.test(raw)) {
    return createAgentRuntimeFault({
      ...common,
      code: 'USER_AUTHENTICATION_REQUIRED',
      fault_domain: 'user_environment',
      retryable: true,
      user_action_required: true,
      recovery: 'reauthenticate',
      safe_message: 'Your Etsy AI Command Center session expired. Please log in again in the app.',
    });
  }
  if (/\b429\b|rate limit|too many requests|retry[_ -]?after/i.test(raw)) {
    return createAgentRuntimeFault({
      ...common,
      code: 'APP_RATE_LIMITED',
      fault_domain: 'application',
      retryable: true,
      recovery: 'retry_after_backoff',
      safe_message: 'Etsy AI Command Center received too many requests at once. This operation can be retried shortly.',
    });
  }
  if (/failed to fetch|network|connection|timed out|timeout|stream/i.test(raw)) {
    return createAgentRuntimeFault({
      ...common,
      code: 'APP_CONNECTION_INTERRUPTED',
      fault_domain: 'provider',
      retryable: true,
      recovery: 'retry_idempotent_operation',
      safe_message: 'Etsy AI Command Center lost the connection while completing this step.',
    });
  }
  return createAgentRuntimeFault({
    ...common,
    code: options.code || 'APP_INTERNAL_ERROR',
    fault_domain: options.fault_domain || 'application',
    retryable: options.retryable === true,
    recovery: options.recovery || '',
    safe_message: options.safe_message || 'Etsy AI Command Center could not complete this step because of an internal problem.',
  });
}
