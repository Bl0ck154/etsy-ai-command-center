import { statusName } from './locale.js';

export function automationHumanReason(event, locale = 'uk') {
  const code = String(event?.block_code || '').toUpperCase();
  const reason = String(
    event?.reason
      || event?.message
      || event?.detail
      || event?.block_reason
      || event?.error
      || '',
  );
  if (locale === 'en') return reason;
  if (code.includes('COOLDOWN')) return 'Повторна чернетка поки не потрібна: ще діє заданий інтервал.';
  if (code.includes('NO_MATCHING_RULE')) return 'Жодне активне правило не підходить до цієї події.';
  if (code.includes('NO_ACTION')) return 'Жоден підтримуваний сценарій не створив чернетку. Це не означає, що менеджеру точно не потрібно відповідати.';
  if (code.includes('SCENARIO') && code.includes('DISABLED')) return 'Потрібний сценарій вимкнено в налаштуваннях.';
  if (code.includes('RECEIPT') || code.includes('ORDER_LINK')) return 'Не вдалося надійно пов’язати діалог із замовленням.';
  if (code.includes('EVIDENCE') || code.includes('CONDITION')) return 'Для безпечної відповіді бракує перевірених даних.';
  if (code.includes('SELLER_REPLY') || /shop reply already follows/i.test(reason)) return 'Магазин уже відповів після цього повідомлення покупця.';
  if (code.includes('DIRECTION') || /unknown direction/i.test(reason)) return 'Не вдалося надійно визначити, хто написав останнє повідомлення.';
  if (code.includes('RETRY') || statusName(event?.status) === 'RETRYABLE_ERROR') return 'Тимчасова помилка. Система повторить перевірку автоматично.';
  if (/no enabled policy rule/i.test(reason)) return 'Жодне активне правило не підходить до цієї події.';
  if (/no action|no explicit incoming buyer/i.test(reason)) return 'Автоматичні правила не створили чернетку. За потреби менеджер може перевірити діалог вручну.';
  if (/missing|evidence|verified/i.test(reason)) return 'Для безпечної відповіді бракує перевірених даних.';
  return reason || 'Перевірку завершено без створення чернетки.';
}
