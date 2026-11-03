export const AUTOMATION_EVENT_LABELS = Object.freeze({
  uk: Object.freeze({
    new_message: 'Нове повідомлення Etsy',
    order_paid: 'Замовлення оплачено',
    materials_missing: 'Матеріали досі не отримано',
    listing_deadline: 'Дедлайн замовлення',
    order_completed: 'Замовлення завершено',
  }),
  en: Object.freeze({
    new_message: 'New Etsy message',
    order_paid: 'Order paid',
    materials_missing: 'Materials still missing',
    listing_deadline: 'Listing deadline',
    order_completed: 'Order completed',
  }),
});

export function translated(locale, uk, en) {
  return locale === 'en' ? en : uk;
}

export function statusName(value) {
  return String(value || 'unknown').toUpperCase();
}

export function automationEventLabels(locale = 'uk') {
  return AUTOMATION_EVENT_LABELS[locale] || AUTOMATION_EVENT_LABELS.uk;
}

export function automationEventLabel(value, locale = 'uk') {
  const key = String(value || '');
  return automationEventLabels(locale)[key]
    || key.replaceAll('_', ' ')
    || translated(locale, 'Подія автоматизації', 'Automation event');
}
