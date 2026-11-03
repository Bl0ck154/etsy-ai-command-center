import { appendSecurityAuditRecord } from './platform/observability/security-audit-store.js';

function safeText(value, limit = 120) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, limit);
}

export function securityActor(req) {
  return {
    user_id: safeText(req?.auth?.user?.id || 'anonymous', 64),
    ip: safeText(req?.ip || req?.socket?.remoteAddress || '', 80),
    user_agent: safeText(req?.headers?.['user-agent'] || '', 200),
  };
}

export function writeSecurityAudit(req, event, details = {}) {
  try {
    const now = new Date();
    const record = {
      at: now.toISOString(),
      event: safeText(event, 80),
      ...securityActor(req),
      details,
    };
    appendSecurityAuditRecord(record, now);
  } catch (err) {
    console.warn('[security-audit] write failed:', err?.message || err);
  }
}
