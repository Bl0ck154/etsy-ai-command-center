function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function configured() {
  return /^(1|true|yes|on)$/i.test(
    String(process.env.MESSAGE_EVIDENCE_DEBUG_NOTIFICATIONS_ENABLED || ''),
  );
}

function oneLine(value, maxLength) {
  return cleanText(value, maxLength).replace(/\s+/g, ' ');
}

function dashboardUrl(conversationId) {
  const id = cleanText(conversationId, 80);
  if (!/^\d+$/.test(id)) return '';
  const raw = cleanText(process.env.PUBLIC_BASE_URL, 2_000).replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return `${parsed.toString().replace(/\/+$/, '')}/#messages?tab=inbox&conversation_id=${encodeURIComponent(id)}`;
  } catch {
    return '';
  }
}

const SCENARIO_LABELS = Object.freeze({
  how_to_send_files: 'Як надіслати файли',
  materials_sent_by_email: 'Клієнт каже, що надіслав файли на email',
  how_to_order: 'Як оформити замовлення',
  missing_materials: 'Немає матеріалів після покупки',
  deadline_no_materials: 'Дедлайн без матеріалів',
  deadline_variants_sent: 'Дедлайн після надісланих варіантів',
  review_request: 'Запит відгуку',
});

const GAP_LABELS = Object.freeze({
  'paid order status': 'підтвердження оплати замовлення',
  'physical item status': 'підтвердження, що товар фізичний',
  'official receipt automation facts': 'актуальні офіційні дані Etsy receipt',
  'paid_at timestamp': 'дата й час оплати',
  'official listing when_made check': 'офіційна перевірка поля when_made у лістингу',
  'made-to-order listing status': 'підтвердження made-to-order',
  'made-to-order checked_at timestamp': 'час останньої перевірки made-to-order',
  'completed order status': 'підтвердження завершення замовлення',
  'official paid/shipped/non-refunded receipt lifecycle': 'офіційний статус paid + shipped + без refund',
  'absence of an active issue': 'підтвердження відсутності активної проблеми',
  'absence of a prior review request': 'підтвердження, що відгук ще не просили',
  'positive buyer ending': 'позитивне завершення діалогу з боку покупця',
  'review evidence checked_at timestamp': 'час перевірки умов для відгуку',
  'materials.missing=true from the Trello operational record': 'у картці Trello немає матеріалів або їх посилань',
});

function humanGap(value) {
  const normalized = oneLine(value, 300);
  return GAP_LABELS[normalized] || normalized;
}

export async function notifyMessageEvidenceBlocked(candidate, options = {}) {
  if (!configured()) {
    return { delivered: false, skipped: true, reason: 'debug_notifications_disabled' };
  }
  const token = cleanText(process.env.MESSAGE_TELEGRAM_BOT_TOKEN, 500);
  // Evidence diagnostics are owner/operator messages.  They must never reuse
  // the manager approvals destination, which is intentionally visible to the
  // whole operating team.
  const chatId = cleanText(process.env.MESSAGE_EVIDENCE_DEBUG_CHAT_ID, 120);
  if (!token || !chatId) {
    const error = new Error('Messages owner evidence-debug Telegram notification is not configured');
    error.code = 'MESSAGE_EVIDENCE_NOTIFICATION_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
  const gaps = (Array.isArray(candidate?.evidence_gaps)
    ? candidate.evidence_gaps
    : [])
    .map(humanGap)
    .filter(Boolean)
    .slice(0, 12);
  const participant = oneLine(candidate?.participant, 160);
  const conversationId = oneLine(candidate?.conversation_id, 80);
  const receiptId = oneLine(candidate?.receipt_id, 80);
  const scenarioKey = oneLine(candidate?.scenario, 100);
  const scenario = SCENARIO_LABELS[scenarioKey] || scenarioKey || 'невідомий';
  const code = oneLine(candidate?.block_code, 160) || 'MESSAGE_EVIDENCE_UNVERIFIED';
  const reason = oneLine(candidate?.block_reason, 700);
  const link = dashboardUrl(conversationId);
  const text = [
    '⚠️ Etsy Messages: потрібна перевірка даних',
    ...(participant ? [`Клієнт: ${participant}`] : []),
    `Сценарій: ${scenario}`,
    ...(conversationId ? [`Діалог: ${conversationId}`] : []),
    ...(receiptId ? [`Замовлення: ${receiptId}`] : []),
    `Код: ${code}`,
    ...(reason ? [`Причина: ${reason}`] : []),
    ...(gaps.length ? ['Не підтверджено:', ...gaps.map(item => `• ${item}`)] : []),
    'Чернетку не створено і покупцеві нічого не надіслано.',
    ...(link ? [link] : []),
  ].join('\n');
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  const threadId = Number.parseInt(process.env.MESSAGE_APPROVALS_THREAD_ID, 10);
  if (Number.isInteger(threadId) && threadId > 0) {
    payload.message_thread_id = threadId;
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    const error = new Error('Messages evidence Telegram request failed');
    error.code = 'MESSAGE_EVIDENCE_NOTIFICATION_DELIVERY_FAILED';
    error.status = 503;
    throw error;
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true || !result?.result?.message_id) {
    const error = new Error(
      cleanText(result?.description, 300)
      || `Messages evidence Telegram notification failed with HTTP ${response.status}`,
    );
    error.code = 'MESSAGE_EVIDENCE_NOTIFICATION_DELIVERY_FAILED';
    error.status = 503;
    throw error;
  }
  if (String(result.result.chat?.id || '') !== String(chatId)) {
    const error = new Error('Messages evidence notification reached an unexpected chat');
    error.code = 'MESSAGE_EVIDENCE_NOTIFICATION_DESTINATION_MISMATCH';
    error.status = 503;
    throw error;
  }
  return {
    delivered: true,
    skipped: false,
    chat_id: String(result.result.chat?.id || chatId),
    message_id: Number(result.result.message_id),
  };
}
