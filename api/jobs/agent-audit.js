import {
  appendAgentAuditRecord,
  cleanupAgentAuditFiles,
} from './agent-audit-repository.js';

const AGENT_AUDIT_MESSAGE_LIMIT = 40;
const AGENT_AUDIT_MESSAGE_MAX_CHARS = 2_000;
export const AGENT_AUDIT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function now() { return Date.now(); }

function queueAgentAuditRecord(record, timestamp = now()) {
  appendAgentAuditRecord(record, timestamp)
    .catch(err => console.warn('[jobs] agent audit persist failed:', err?.message || err));
}

export function cleanupAgentAuditFilesSafely(cutoff) {
  cleanupAgentAuditFiles(cutoff)
    .catch(err => {
      if (err?.code !== 'ENOENT') console.warn('[jobs] agent audit cleanup failed:', err?.message || err);
    });
}

export function redactJobAuditText(value, maxChars = 140) {
  const source = String(value || '');
  let text = source
    .replace(/\b(?:sk|rk|pk|AIza)[-_A-Za-z0-9]{16,}\b/g, '[REDACTED_KEY]')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{32,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\b(api[_-]?key|authorization|token|secret|password|cookie|session)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, (_match, key) => `${key}=[REDACTED]`)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[REDACTED_URL]')
    .replace(/(?<!\w)(?:\+?\d[\d(). -]{6,}\d)(?!\w)/g, '[REDACTED_PHONE]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_NUMBER]');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return { text, truncated: source.length > maxChars };
}

function summarizeAgentMessages(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const retained = source.slice(-AGENT_AUDIT_MESSAGE_LIMIT);
  return {
    schema: 'agent_turn_transcript_v1',
    message_count: source.length,
    omitted_message_count: Math.max(0, source.length - retained.length),
    messages: retained.map((message, index) => {
      const content = redactJobAuditText(message?.content, AGENT_AUDIT_MESSAGE_MAX_CHARS);
      return {
        index: source.length - retained.length + index,
        role: String(message?.role || 'unknown').slice(0, 32),
        content: content.text,
        ...(content.truncated ? { content_truncated: true } : {}),
      };
    }),
  };
}

export function summarizeJobInput(input = {}) {
  const description = redactJobAuditText(input.description);
  const prompt = redactJobAuditText(input.prompt);
  return {
    description: description.text,
    listingType: input.listingType || input.listing_type || '',
    provider: input.provider || '',
    prompt: prompt.text,
    count: input.count || '',
    ...(Array.isArray(input.messages) ? { agent_conversation: summarizeAgentMessages(input.messages) } : {}),
  };
}

function compactAgentDebugTrace(trace) {
  if (!Array.isArray(trace)) return [];
  return trace.slice(-50).map(item => ({
    type: String(item?.type || 'unknown').slice(0, 64),
    ...(item?.provider ? { provider: String(item.provider).slice(0, 64) } : {}),
    ...(item?.provider_id ? { provider_id: String(item.provider_id).slice(0, 96) } : {}),
    ...(item?.model ? { model: String(item.model).slice(0, 160) } : {}),
    ...(Number.isFinite(item?.step) ? { step: item.step } : {}),
    ...(Number.isFinite(item?.duration_ms) ? { duration_ms: item.duration_ms } : {}),
    ...(item?.name ? { name: String(item.name).slice(0, 96) } : {}),
    ...(item?.status ? { status: String(item.status).slice(0, 32) } : {}),
    ...(item?.code ? { code: String(item.code).slice(0, 96) } : {}),
    ...(item?.fault_code ? { fault_code: String(item.fault_code).slice(0, 96) } : {}),
    ...(item?.fault_domain ? { fault_domain: String(item.fault_domain).slice(0, 32) } : {}),
    ...(item?.required_transition ? { required_transition: String(item.required_transition).slice(0, 160) } : {}),
    ...(Array.isArray(item?.tool_names)
      ? { tool_names: item.tool_names.map(name => String(name).slice(0, 96)).slice(0, 25) }
      : {}),
  }));
}

function summarizeAgentResultForAudit(result) {
  const message = redactJobAuditText(result?.message, AGENT_AUDIT_MESSAGE_MAX_CHARS);
  return {
    event_type: String(result?.type || '').slice(0, 64),
    provider: String(result?.provider || '').slice(0, 64),
    ...(message.text ? { message: message.text } : {}),
    ...(message.truncated ? { message_truncated: true } : {}),
    debug_trace: compactAgentDebugTrace(result?.debug_trace),
  };
}

export function persistAgentAuditEvent(job, event) {
  if (job?.type !== 'agent_turn') return;
  const record = {
    schema: 'agent_turn_audit_v1',
    at: new Date(job.updated_at || now()).toISOString(),
    event,
    job_id: job.id,
    status: job.status,
    requested_provider: String(job.input_summary?.provider || '').slice(0, 64),
    transcript: job.input_summary?.agent_conversation || null,
    ...(event === 'completed' ? { result: summarizeAgentResultForAudit(job.result) } : {}),
    ...(event === 'failed' ? { error: redactJobAuditText(job.error, AGENT_AUDIT_MESSAGE_MAX_CHARS).text } : {}),
  };
  queueAgentAuditRecord(record, job.updated_at || now());
}

export function recordAgentRuntimeFault(jobId, faultInput = {}) {
  const timestamp = now();
  const fault = {
    schema: 'agent_runtime_fault_v1',
    code: String(faultInput.code || 'APP_INTERNAL_ERROR').replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 96),
    operation: String(faultInput.operation || 'unknown_operation').replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 96),
    fault_domain: ['application', 'workflow', 'provider', 'user_environment'].includes(faultInput.fault_domain)
      ? faultInput.fault_domain
      : 'application',
    retryable: faultInput.retryable === true,
    user_action_required: faultInput.fault_domain === 'user_environment' && faultInput.user_action_required === true,
    ...(faultInput.recovery ? { recovery: String(faultInput.recovery).replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 160) } : {}),
    ...(faultInput.required_transition ? { required_transition: String(faultInput.required_transition).replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 160) } : {}),
    ...(faultInput.workflow_id ? { workflow_id: String(faultInput.workflow_id).replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 160) } : {}),
    ...(faultInput.state ? { state: String(faultInput.state).replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 96) } : {}),
  };
  const record = {
    schema: 'agent_turn_audit_v1',
    at: new Date(timestamp).toISOString(),
    event: 'runtime_fault',
    job_id: /^job_agent_[a-z0-9_]+$/i.test(String(jobId || '')) ? String(jobId) : null,
    source: 'client_runtime',
    fault,
  };
  queueAgentAuditRecord(record, timestamp);
  return record;
}
