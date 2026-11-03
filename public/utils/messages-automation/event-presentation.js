import { statusName, translated } from './locale.js';

export function automationEventOutcome(event) {
  return String(
    event?.outcome
      || event?.result
      || event?.status
      || event?.decision
      || '',
  ).toLowerCase();
}

export function automationEventPresentation(event, locale = 'uk') {
  const outcome = automationEventOutcome(event);
  const status = statusName(event?.status);
  const draftId = String(event?.draft_id || event?.created_draft_id || '');
  if (status === 'SENT' || outcome === 'sent') {
    return { label: translated(locale, 'Надіслано', 'Sent'), className: 'is-sent' };
  }
  if (status === 'APPROVED' || outcome === 'approved') {
    return {
      label: translated(locale, 'Погоджено, очікує надсилання', 'Approved, waiting to send'),
      className: 'is-draft',
    };
  }
  if (status === 'BLOCKED' || outcome === 'blocked') {
    return { label: translated(locale, 'Чернетку не створено', 'Draft not created'), className: 'is-safe' };
  }
  if (status === 'RETRYABLE_ERROR' || outcome === 'retrying') {
    return { label: translated(locale, 'Перевірку буде повторено', 'Check will retry'), className: 'is-warning' };
  }
  if (outcome.includes('error') || outcome === 'failed') {
    return { label: translated(locale, 'Помилка перевірки', 'Check failed'), className: 'is-error' };
  }
  if (status === 'PENDING' || status === 'PROCESSING' || ['pending', 'processing'].includes(outcome)) {
    return { label: translated(locale, 'Очікує перевірки', 'Waiting to be checked'), className: 'is-pending' };
  }
  if (
    status === 'SKIPPED'
    || status.startsWith('IGNORED_')
    || outcome.startsWith('ignored')
    || ['skipped', 'no_match', 'cooldown'].includes(outcome)
  ) {
    const ignoredCode = String(event?.block_code || '').toUpperCase();
    return {
      label: outcome.includes('cooldown') || ignoredCode.includes('COOLDOWN')
        ? translated(locale, 'Пропущено: ще діє інтервал між повторами', 'Skipped: cooldown is still active')
        : translated(locale, 'Правила не створили чернетку', 'No draft created by rules'),
      className: 'is-skipped',
    };
  }
  if (
    draftId
    || ['draft_created', 'created_draft', 'created', 'queued', 'candidate_created', 'awaiting_approval'].includes(outcome)
  ) {
    return {
      label: translated(locale, 'Чернетка готова до перевірки', 'Draft ready for review'),
      className: 'is-draft',
    };
  }
  return {
    label: translated(locale, 'Перевірено, дій не потрібно', 'Checked, no action needed'),
    className: '',
  };
}
