import { statusName, translated } from './locale.js';

export function normalizeAutomationPolicyState(value) {
  if (value?.policy) return value;
  return {
    revision: Number(value?.revision) || 0,
    policy: {
      enabled: value?.enabled === true,
      delivery_mode: 'draft_only',
      human_approval_required: true,
      rules: Array.isArray(value?.rules) ? value.rules : [],
    },
  };
}

export function isAutomationOperational(runtime = {}, policyState = {}) {
  return runtime.implemented === true
    && runtime.enabled === true
    && policyState.policy?.enabled === true
    && ['READY', 'RUNNING', 'IDLE', 'LISTENING'].includes(statusName(runtime.worker_state));
}

export function automationRuntimePresentation(runtime = {}, policyState = {}, locale = 'uk') {
  if (runtime.implemented !== true) {
    return {
      label: translated(locale, 'Автоматизація недоступна', 'Runner unavailable'),
      detail: translated(locale, 'На цьому сервері не запущено модуль підготовки чернеток.', 'The draft runner is not installed on this service.'),
      className: 'is-blocked',
    };
  }
  if (runtime.enabled !== true) {
    return {
      label: translated(locale, 'Автоматизацію призупинено', 'Runner paused'),
      detail: translated(locale, 'Події можуть оновлювати вхідні, але чернетки автоматично не створюються.', 'Events can update the inbox, but no automatic draft will be created.'),
      className: 'is-paused',
    };
  }
  if (policyState.policy?.enabled !== true) {
    return {
      label: translated(locale, 'Правила вимкнено', 'Rules paused'),
      detail: translated(locale, 'Сервіс працює, але правила автоматизації для магазину вимкнені.', 'The worker is available, but the manager disabled this shop’s automation policy.'),
      className: 'is-paused',
    };
  }
  const workerState = statusName(runtime.worker_state);
  if (['ERROR', 'BLOCKED', 'DEGRADED'].includes(workerState)) {
    return {
      label: translated(locale, 'Автоматизація потребує уваги', `Runner ${workerState.toLowerCase()}`),
      detail: runtime.last_error || translated(locale, 'Перед створенням нових чернеток потрібно перевірити стан сервісу.', 'The runner needs attention before it can prepare drafts.'),
      className: 'is-blocked',
    };
  }
  return {
    label: translated(locale, 'Автоматизація працює', 'Runner active'),
    detail: translated(locale, 'Події перевіряються, а безпечні пропозиції потрапляють у чергу погодження.', 'Matching events are checked and safe suggestions enter the Approval queue.'),
    className: 'is-running',
  };
}
