import { toastError, toastSuccess } from '../components/toast.js';
import { escHtml } from '../utils/format.js';
import { messagesApi } from '../utils/messages-api.js';
import { createMessagesConversationView } from '../utils/messages-conversation-view.js';
import {
  automationEventLabel,
  automationEventLabels,
  automationEventPresentation,
  automationHumanReason,
  automationRuntimePresentation,
  isAutomationOperational,
  normalizeAutomationPolicyState,
} from '../utils/messages-automation-view-model.js';
import {
  conversationIdOf,
  draftIdOf,
  listFrom,
  mergeConversationPages,
  messagesRouteParams,
  nextCursorFrom,
} from '../utils/messages-view-model.js';

const ORDER_SCENARIOS = new Set([
  'missing_materials',
  'materials_sent_by_email',
  'deadline_variants_sent',
  'deadline_no_materials',
  'review_request',
]);
const SCENARIO_LABELS = Object.freeze({
  uk: Object.freeze({
    how_to_send_files: 'Як надіслати файли',
    materials_sent_by_email: 'Клієнт надіслав файли на email',
    how_to_order: 'Як оформити замовлення',
    missing_materials: 'Нагадування про відсутні матеріали',
    deadline_variants_sent: 'Дедлайн: варіанти надіслано',
    deadline_no_materials: 'Дедлайн: матеріали не отримано',
    review_request: 'Запит відгуку',
    freeform: 'Звичайна відповідь',
  }),
  en: Object.freeze({
    how_to_send_files: 'How to send files',
    materials_sent_by_email: 'Buyer emailed files',
    how_to_order: 'How to place an order',
    missing_materials: 'Missing materials reminder',
    deadline_variants_sent: 'Deadline: variants sent',
    deadline_no_materials: 'Deadline: no materials received',
    review_request: 'Review request',
    freeform: 'General reply',
  }),
});
const LOCAL_CACHE_REFRESH_MS = Math.max(
  50,
  Number(window.__MESSAGES_LOCAL_REFRESH_MS) || 15_000,
);
const CONVERSATION_PAGE_SIZE = 50;
const INITIAL_VISIBLE_MESSAGE_LIMIT = 100;
const MESSAGES_LOCALE_STORAGE_KEY = 'etsy-manager:messages-locale';

const state = {
  tab: 'inbox',
  status: null,
  conversations: [],
  drafts: [],
  playbookState: null,
  automationState: null,
  conversation: null,
  draft: null,
  inboxFilter: '',
  draftFilter: '',
  inboxRequestRevision: 0,
  conversationNextCursor: null,
  inboxLoadingMore: false,
  visibleMessageLimit: INITIAL_VISIBLE_MESSAGE_LIMIT,
  locale: 'uk',
  container: null,
  mounted: false,
  busy: false,
};

let localRefreshTimer = null;

function tr(uk, en) {
  return state.locale === 'en' ? en : uk;
}

function scenarioLabels() {
  return SCENARIO_LABELS[state.locale] || SCENARIO_LABELS.uk;
}

function currentMessagesRouteParams() {
  return messagesRouteParams(state);
}

function updateMessagesRoute(options = {}) {
  if (window.updateCurrentRouteParams) {
    window.updateCurrentRouteParams(currentMessagesRouteParams(), options);
    return;
  }
  const query = new URLSearchParams(currentMessagesRouteParams()).toString();
  window.history[options.replace ? 'replaceState' : 'pushState']({}, '', `${window.location.pathname}#messages?${query}`);
}

function applyFirstConversationPage(page, { reset = false } = {}) {
  const previousLength = state.conversations.length;
  const previousCursor = state.conversationNextCursor;
  const items = listFrom(page);
  state.conversations = reset
    ? mergeConversationPages([], items, { conversationName })
    : mergeConversationPages(state.conversations, items, {
      firstPage: true,
      conversationName,
    });
  state.conversationNextCursor = reset || previousLength <= CONVERSATION_PAGE_SIZE
    ? nextCursorFrom(page, 0)
    : previousCursor;
}

function conversationCountLabel() {
  const loaded = state.conversations.length;
  return state.conversationNextCursor === null
    ? tr(`Завантажено: ${loaded}`, `${loaded} loaded`)
    : tr(`Завантажено: ${loaded} · прокрутіть нижче`, `${loaded} loaded · scroll for more`);
}

function displayDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat(state.locale === 'uk' ? 'uk-UA' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
}

const {
  conversationMessagesHtml: renderConversationMessagesHtml,
  messageDirection,
} = createMessagesConversationView({
  translate: tr,
  formatDate: displayDate,
  attachmentContentUrl: messagesApi.attachmentContentUrl,
});

function statusName(value) {
  return String(value || 'unknown').toUpperCase();
}

function isReserve() {
  return state.status?.reserve_guard_active !== false;
}

function reserveTestSendAvailable(draft) {
  const gate = state.status?.bridge?.delivery?.nonproduction_test_send;
  return Boolean(
    isReserve()
    && gate?.available === true
    && String(gate?.conversation_id || '') === conversationIdOf(draft),
  );
}

function accountLabel() {
  return state.status?.account?.label || tr('Акаунт не налаштовано', 'Unconfigured account');
}

function conversationName(conversation) {
  return conversation?.participant
    || conversation?.participant_name
    || conversation?.title
    || tr(`Діалог ${conversationIdOf(conversation)}`, `Conversation ${conversationIdOf(conversation)}`);
}

function conversationMessagesHtml(conversation) {
  return renderConversationMessagesHtml(conversation, {
    visibleMessageLimit: state.visibleMessageLimit,
  });
}

function scenarioLabel(value) {
  const key = String(value || 'freeform');
  return scenarioLabels()[key]
    || state.playbookState?.playbook?.scenarios?.[key]?.label
    || key;
}

function draftStatusLabel(value) {
  const status = statusName(value);
  const labels = {
    DRAFT: tr('Чернетка', 'DRAFT'),
    AWAITING_APPROVAL: tr('Очікує погодження', 'AWAITING APPROVAL'),
    APPROVED: tr('Погоджено', 'APPROVED'),
    SENT: tr('Надіслано', 'SENT'),
    SKIPPED: tr('Пропущено', 'SKIPPED'),
    BLOCKED: tr('Заблоковано', 'BLOCKED'),
    UNKNOWN: tr('Результат невідомий', 'UNKNOWN'),
  };
  return labels[status] || status.replaceAll('_', ' ');
}

function draftConversation(draft) {
  const id = conversationIdOf(draft);
  if (id && id === conversationIdOf(state.conversation)) return state.conversation;
  return state.conversations.find(item => conversationIdOf(item) === id) || null;
}

function draftParticipant(draft) {
  return draft?.participant
    || conversationName(draftConversation(draft) || draft);
}

function conversationContentSignature(value) {
  return String(value?.last_message_at || '');
}

async function markConversationViewedHere(conversationId) {
  const result = await messagesApi.markConversationViewed(conversationId);
  const viewed = result?.conversation || {};
  state.conversations = state.conversations.map(conversation =>
    conversationIdOf(conversation) === conversationId
      ? { ...conversation, ...viewed, needs_attention: false }
      : conversation,
  );
  if (conversationIdOf(state.conversation) === conversationId) {
    state.conversation = {
      ...state.conversation,
      ...viewed,
      needs_attention: false,
    };
  }
}

function currentDraftBody(draft) {
  return draft?.body || draft?.draft_body || draft?.proposed_body || '';
}

function automationRuntime() {
  return state.automationState?.runtime || {};
}

function automationPolicyState() {
  return normalizeAutomationPolicyState(state.automationState?.policy);
}

function automationRules() {
  return listFrom(automationPolicyState().policy?.rules);
}

function automationEvents() {
  return listFrom(state.automationState?.recent_events);
}

function automationIsOperational() {
  return isAutomationOperational(automationRuntime(), automationPolicyState());
}

function automationStatusCopy() {
  return automationRuntimePresentation(automationRuntime(), automationPolicyState(), state.locale);
}

function readMessagesLocale(params = {}) {
  const requested = String(params?.lang || '').toLowerCase();
  if (['uk', 'en'].includes(requested)) return requested;
  try {
    const saved = window.localStorage.getItem(MESSAGES_LOCALE_STORAGE_KEY);
    if (['uk', 'en'].includes(saved)) return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted browsers.
  }
  return 'uk';
}

function saveMessagesLocale(locale) {
  try {
    window.localStorage.setItem(MESSAGES_LOCALE_STORAGE_KEY, locale);
  } catch {
    // The URL still keeps the selected locale.
  }
}

function preserveVisibleEditor() {
  if (state.tab === 'automation' && state.automationState?.policy?.policy) {
    state.automationState.policy.policy = collectAutomationPolicy();
  }
  if (state.tab === 'playbook' && state.playbookState?.playbook) {
    state.playbookState.playbook = collectPlaybook();
  }
}

function automationSelectOptions(values, selected, labels = {}) {
  return values.map(value => `
    <option value="${escHtml(value)}" ${value === selected ? 'selected' : ''}>
      ${escHtml(labels[value] || scenarioLabel(value))}
    </option>`).join('');
}

function helpTip(uk, en) {
  const copy = tr(uk, en);
  return `<span class="messages-help-tip" tabindex="0" role="note" aria-label="${escHtml(copy)}" data-tooltip="${escHtml(copy)}">?</span>`;
}

function humanDuration(minutes, defaultUnit = 'hours') {
  const total = Math.max(0, Number(minutes) || 0);
  if (total === 0) return { value: 0, unit: defaultUnit };
  if (total >= 1_440 && total % 1_440 === 0) return { value: total / 1_440, unit: 'days' };
  if (total >= 60 && total % 60 === 0) return { value: total / 60, unit: 'hours' };
  return { value: total, unit: 'minutes' };
}

function durationControl(name, minutes, maxMinutes) {
  const duration = humanDuration(minutes);
  return `
    <span class="messages-duration-control" data-duration-field="${name}" data-max-minutes="${maxMinutes}">
      <input type="number" min="0" step="1" data-duration-value value="${duration.value}" aria-label="${tr('Значення часу', 'Duration value')}">
      <select data-duration-unit aria-label="${tr('Одиниця часу', 'Duration unit')}">
        <option value="minutes" ${duration.unit === 'minutes' ? 'selected' : ''}>${tr('хвилини', 'minutes')}</option>
        <option value="hours" ${duration.unit === 'hours' ? 'selected' : ''}>${tr('години', 'hours')}</option>
        <option value="days" ${duration.unit === 'days' ? 'selected' : ''}>${tr('дні', 'days')}</option>
      </select>
    </span>`;
}

function durationMinutes(element, name, maxMinutes) {
  const control = element.querySelector(`[data-duration-field="${name}"]`);
  if (!control) return 0;
  const value = Math.max(0, Number.parseInt(control.querySelector('[data-duration-value]')?.value, 10) || 0);
  const multiplier = ({ minutes: 1, hours: 60, days: 1_440 })[
    control.querySelector('[data-duration-unit]')?.value
  ] || 1;
  return Math.min(maxMinutes, value * multiplier);
}

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header messages-page-header" lang="${state.locale === 'en' ? 'en' : 'uk'}">
      <div>
        <div class="page-title">${tr('Повідомлення Etsy', 'Etsy Messages')}</div>
        <div class="page-subtitle">${tr('Чернетки відповідей, контроль менеджера та навчання агента', 'Human-approved replies and agent training')}</div>
      </div>
      <div class="messages-header-actions">
        <div class="messages-locale-switch" role="group" aria-label="${tr('Мова сторінки', 'Page language')}">
          <button type="button" data-message-locale="uk" class="${state.locale === 'uk' ? 'active' : ''}">УКР</button>
          <button type="button" data-message-locale="en" class="${state.locale === 'en' ? 'active' : ''}">EN</button>
        </div>
        <span id="messages-session-chip" class="messages-chip">${tr('Перевіряємо Bridge…', 'Checking Bridge…')}</span>
      </div>
    </div>
    <div class="page-body messages-page-body" lang="${state.locale === 'en' ? 'en' : 'uk'}">
      <div id="messages-account-banner"></div>
      <details class="messages-diagnostics">
        <summary>${tr('Діагностика та відновлення', 'Diagnostics / recovery')}</summary>
        <div>
          <p>${tr('Вхідні відкриваються з локальної бази Bridge. Ця дія оновить індекс діалогів без відкривання кожного чату й без постійного опитування Etsy.', 'The inbox normally opens from the local Bridge cache. This refreshes the conversation index without opening every thread or starting polling.')}</p>
          <button class="btn btn-sm" type="button" data-message-action="check-inbox">${tr('Оновити список діалогів', 'Refresh conversation index')}</button>
        </div>
      </details>
      <nav class="messages-tabs" aria-label="Messages workspace">
        <button class="messages-tab active" type="button" data-message-tab="inbox">${tr('Діалоги', 'Inbox')}</button>
        <button class="messages-tab" type="button" data-message-tab="queue">
          ${tr('На перевірку', 'Approval queue')} <span id="messages-queue-count" class="messages-tab-count">0</span>
        </button>
        <button class="messages-tab" type="button" data-message-tab="automation">
          ${tr('Коли готувати', 'Automation')} <span id="messages-automation-chip" class="messages-tab-signal">${tr('Перевірка', 'Checking')}</span>
        </button>
        <button class="messages-tab" type="button" data-message-tab="playbook">${tr('Як відповідати', 'Agent Playbook')}</button>
        <button class="messages-tab" type="button" data-message-tab="guide">${tr('Як це працює', 'Інструкція UA')}</button>
      </nav>
      <section id="messages-workspace" class="messages-workspace">
        <div class="messages-loading">${tr('Завантажуємо повідомлення…', 'Loading message workspace…')}</div>
      </section>
    </div>`;
}

function renderStatus() {
  const chip = document.getElementById('messages-session-chip');
  const banner = document.getElementById('messages-account-banner');
  const count = document.getElementById('messages-queue-count');
  const automationChip = document.getElementById('messages-automation-chip');
  if (count) {
    count.textContent = String(state.drafts.filter(draft =>
      ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(statusName(draft.status)),
    ).length);
  }
  if (!chip || !banner) return;
  if (automationChip) {
    const runner = automationStatusCopy();
    automationChip.textContent = automationIsOperational() ? tr('Увімкнено', 'On') : tr('Пауза', 'Paused');
    automationChip.className = `messages-tab-signal ${runner.className}`;
    automationChip.title = `${runner.label}. ${runner.detail}`;
  }
  const session = statusName(
    state.status?.bridge?.session_state
    || state.status?.bridge?.state
    || state.status?.bridge?.status,
  );
  const sessionLabel = ({ READY: tr('ГОТОВО', 'READY'), IDLE: tr('ОЧІКУЄ', 'IDLE') })[session] || session;
  chip.textContent = `${accountLabel()} · ${sessionLabel}`;
  chip.className = `messages-chip ${
    session === 'READY' ? 'is-ready' : (session === 'IDLE' ? '' : 'is-warning')
  }`;
  if (isReserve()) {
    banner.innerHTML = `
      <div class="messages-guard-banner">
        <div class="messages-guard-icon" aria-hidden="true">R</div>
        <div>
          <strong>${tr('Підключено резервний Etsy-акаунт', 'Reserve/test Etsy account connected')}: ${escHtml(accountLabel())}</strong>
          <p>${tr('Замовлення з панелі навмисно не пов’язуються. Чернетки, що залежать від замовлень, автоматичні тригери та бойове надсилання заблоковані. Можна безпечно тестувати діалоги й попередній перегляд інструкцій.', 'Orders from this dashboard are intentionally not linked. Order-dependent drafts, automatic triggers, and live sending stay blocked. Conversation-only drafts and Playbook previews are safe to test.')}</p>
        </div>
      </div>`;
  } else {
    banner.innerHTML = `
      <div class="messages-production-banner">
        <strong>${tr('Основний магазин', 'Production account')}: ${escHtml(accountLabel())}</strong>
        <span>${automationIsOperational()
          ? tr('Автоматична перевірка може готувати чернетки. Кожне вихідне повідомлення все одно потребує окремого погодження людиною.', 'Automatic checks can prepare drafts. Every outgoing message still requires separate human approval.')
          : tr('Автоматичну підготовку чернеток призупинено. Кожне вихідне повідомлення потребує перевірки людиною.', 'Draft automation is paused. Every outgoing message requires separate human review.')}</span>
      </div>`;
  }
}

function renderActiveTab() {
  document.querySelectorAll('[data-message-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.messageTab === state.tab);
  });
  if (state.tab === 'queue') renderQueue();
  else if (state.tab === 'automation') renderAutomation();
  else if (state.tab === 'playbook') renderPlaybook();
  else if (state.tab === 'guide') renderManagerGuide();
  else renderInbox();
}

function snapshotThreadScroll() {
  const thread = document.querySelector('.messages-thread');
  if (!thread) return null;
  return {
    scrollTop: thread.scrollTop,
    scrollHeight: thread.scrollHeight,
    nearBottom: thread.scrollHeight - thread.clientHeight - thread.scrollTop <= 80,
  };
}

function snapshotConversationListScroll() {
  const list = document.getElementById('messages-conversation-list');
  return list ? list.scrollTop : null;
}

function restoreConversationListScroll(scrollTop) {
  if (scrollTop === null) return;
  requestAnimationFrame(() => {
    const list = document.getElementById('messages-conversation-list');
    if (list) list.scrollTop = scrollTop;
  });
}

function restoreThreadScroll(mode, previous) {
  if (!mode) return;
  requestAnimationFrame(() => {
    const thread = document.querySelector('.messages-thread');
    if (!thread) return;
    if (mode === 'bottom') {
      thread.scrollTop = thread.scrollHeight;
      return;
    }
    if (mode === 'position' && previous) {
      thread.scrollTop = previous.nearBottom
        ? thread.scrollHeight
        : previous.scrollTop;
      return;
    }
    if (mode === 'preserve-history' && previous) {
      thread.scrollTop = previous.scrollTop
        + Math.max(0, thread.scrollHeight - previous.scrollHeight);
    }
  });
}

function renderInbox(options = {}) {
  const workspace = document.getElementById('messages-workspace');
  if (!workspace) return;
  workspace.innerHTML = `
    <div class="messages-inbox-layout">
      <aside class="messages-panel messages-conversation-panel">
        <div class="messages-panel-heading">
          <div>
            <strong>${tr('Діалоги', 'Conversations')}</strong>
            <span id="messages-conversation-count">${escHtml(conversationCountLabel())}</span>
          </div>
          <select id="messages-inbox-filter" aria-label="${tr('Фільтр діалогів', 'Conversation filter')}">
            <option value="" ${state.inboxFilter === '' ? 'selected' : ''}>${tr('Усі', 'All')}</option>
            <option value="true" ${state.inboxFilter === 'true' ? 'selected' : ''}>${tr('Нові тут', 'New here')}</option>
            <option value="false" ${state.inboxFilter === 'false' ? 'selected' : ''}>${tr('Переглянуті тут', 'Viewed here')}</option>
          </select>
        </div>
        <div id="messages-conversation-list" class="messages-conversation-list">
          ${conversationListHtml()}
        </div>
      </aside>
      <main class="messages-panel messages-thread-panel">
        ${threadHtml()}
      </main>
      <aside class="messages-panel messages-compose-panel">
        ${composerHtml()}
      </aside>
    </div>`;
  restoreThreadScroll(options.threadScroll, options.previousScroll);
}

function conversationListHtml() {
  if (!state.conversations.length) {
    return `<div class="messages-empty">${tr('У локальній базі ще немає діалогів. Bridge залишається в очікуванні, доки не надійде подія або ви не відкриєте діалог.', 'No locally synced conversations yet. The Bridge stays idle until an event arrives or you open a conversation.')}</div>`;
  }
  const conversations = state.conversations.map(conversation => {
    const id = conversationIdOf(conversation);
    const active = id && id === conversationIdOf(state.conversation);
    const preview = conversation.last_message_preview
      || conversation.last_message
      || conversation.preview
      || '';
    return `
      <button class="messages-conversation ${active ? 'active' : ''}" type="button" data-conversation-id="${escHtml(id)}">
        <span class="messages-avatar">${escHtml(conversationName(conversation).slice(0, 1).toUpperCase())}</span>
        <span class="messages-conversation-copy">
          <span class="messages-conversation-line">
            <strong>${escHtml(conversationName(conversation))}</strong>
            <time title="${conversation.last_message_at ? '' : tr('Відкрийте діалог, щоб завантажити дату', 'Open the conversation to load its message date')}">${escHtml(displayDate(conversation.last_message_at) || tr('Не завантажено', 'Not loaded'))}</time>
          </span>
          <span class="messages-conversation-preview-line">
            <span class="messages-preview">${escHtml(preview || tr('Відкрити діалог', 'Open conversation'))}</span>
            ${conversation.needs_attention ? `<span class="messages-unread" title="${tr('Нове в цій панелі', 'New in this dashboard')}">${tr('Нове', 'New')}</span>` : ''}
          </span>
        </span>
      </button>`;
  }).join('');
  const pagination = state.inboxLoadingMore
    ? `<div class="messages-list-pagination" role="status">${tr('Завантажуємо ще діалоги…', 'Loading more conversations…')}</div>`
    : state.conversationNextCursor !== null
      ? `<div class="messages-list-pagination">${tr('Прокрутіть нижче, щоб побачити більше', 'Scroll for more conversations')}</div>`
      : `<div class="messages-list-pagination is-complete">${tr('Кінець завантаженого списку', 'End of loaded conversation index')}</div>`;
  return conversations + pagination;
}

function threadHtml() {
  if (!state.conversation) {
    return `
      <div class="messages-empty messages-empty-center">
        <span class="messages-empty-mark">↗</span>
        <strong>${tr('Оберіть діалог', 'Select a conversation')}</strong>
        <span>${tr('Історія завантажується з локальної бази Bridge, тому перегляд тут не відкриває сторінки Etsy повторно.', 'History comes from the local Bridge database, so reading it does not repeatedly open Etsy pages.')}</span>
      </div>`;
  }
  const messages = listFrom(state.conversation.messages);
  const customerMessageCount = messages.filter(message =>
    ['incoming', 'outgoing'].includes(messageDirection(message)),
  ).length;
  const displayedMessageCount = Math.min(
    customerMessageCount,
    state.visibleMessageLimit,
  );
  const historyActionLabel = customerMessageCount
    ? tr('Завантажити старішу історію', 'Load older history now')
    : tr('Завантажити цей діалог', 'Load this conversation');
  return `
    <div class="messages-thread-heading">
      <div>
        <strong>${escHtml(conversationName(state.conversation))}</strong>
        <span>${tr('Діалог', 'Conversation')} ${escHtml(conversationIdOf(state.conversation))} · ${tr(`збережено ${customerMessageCount} · показано ${displayedMessageCount}`, `${customerMessageCount} saved · showing ${displayedMessageCount}`)}</span>
      </div>
      <button class="btn btn-sm" type="button" data-message-action="sync-history">${historyActionLabel}</button>
    </div>
    <div class="messages-thread">
      ${conversationMessagesHtml(state.conversation)}
    </div>`;
}

function scenarioOptions() {
  const scenarios = state.playbookState?.playbook?.scenarios || {};
  return Object.entries(scenarios).map(([key, scenario]) => {
    const unavailable = !scenario.enabled || (isReserve() && ORDER_SCENARIOS.has(key));
    const suffix = !scenario.enabled
      ? tr(' — вимкнено в інструкціях', ' — disabled in Playbook')
      : (isReserve() && ORDER_SCENARIOS.has(key)
        ? tr(' — потрібні дані основного магазину', ' — needs production order context')
        : '');
    return `<option value="${escHtml(key)}" ${unavailable ? 'disabled' : ''}>${escHtml(scenarioLabel(key))}${escHtml(suffix)}</option>`;
  }).join('');
}

function composerHtml() {
  if (!state.conversation) {
    return `
      <div class="messages-evidence-title">${tr('Дані для чернетки', 'Draft evidence')}</div>
      <div class="messages-empty">${tr('Оберіть діалог, щоб перевірити контекст і підготувати чернетку.', 'Select a conversation to inspect evidence and prepare a draft.')}</div>`;
  }
  return `
    <div class="messages-evidence-title">${tr('Підготувати до погодження', 'Prepare for approval')}</div>
    <div class="messages-safety-note">
      <strong>${tr('Лише чернетка', 'Draft only')}</strong>
      <span>${tr('Агент не може сам погодити або надіслати свою відповідь.', 'The agent cannot approve or send its own reply.')}</span>
    </div>
    <label class="messages-field">
      <span>${tr('Сценарій', 'Scenario')}</span>
      <select id="messages-draft-scenario">${scenarioOptions()}</select>
    </label>
    <label class="messages-field">
      <span>${tr('Вказівки менеджера / перевірені факти', 'Owner notes / verified facts')}</span>
      <textarea id="messages-owner-notes" rows="4" placeholder="${tr('Додавайте лише перевірені факти. Не вставляйте секретні дані.', 'Only add facts you verified. Do not paste secrets.')}"></textarea>
    </label>
    <button class="btn btn-primary messages-full-button" type="button" data-message-action="preview-conversation-draft">
      ${tr('Переглянути пропозицію — без збереження', 'Preview suggestion — nothing saved')}
    </button>
    <div id="messages-conversation-preview-result" class="messages-preview-result"></div>
    <button class="btn messages-full-button" type="button" data-message-action="generate-draft">
      ${tr('Підготувати чернетку', 'Generate approval draft')}
    </button>
    <div class="messages-action-feedback" role="status" aria-live="polite"></div>
    <div class="messages-divider"><span>${tr('або написати вручну', 'or write manually')}</span></div>
    <label class="messages-field">
      <span>${tr('Відповідь вручну', 'Manual reply')}</span>
      <textarea id="messages-manual-body" rows="7" placeholder="${tr('Текст потрапить у чергу погодження, а не в Etsy.', 'This will enter the approval queue, not Etsy.')}"></textarea>
    </label>
    <button class="btn messages-full-button" type="button" data-message-action="save-manual-draft">
      ${tr('Додати в чергу погодження', 'Add manual draft to queue')}
    </button>`;
}

function renderQueue(options = {}) {
  const workspace = document.getElementById('messages-workspace');
  if (!workspace) return;
  workspace.innerHTML = `
    <div class="messages-queue-layout">
      <aside class="messages-panel messages-draft-list-panel">
        <div class="messages-panel-heading">
          <div><strong>${tr('Черга погодження', 'Approval queue')}</strong><span>${tr('Єдине місце для перевірки чернеток', 'Canonical queue stored in Bridge')}</span></div>
          <select id="messages-draft-filter" aria-label="${tr('Статус чернетки', 'Draft status')}">
            <option value="" ${state.draftFilter === '' ? 'selected' : ''}>${tr('Активні', 'Active')}</option>
            <option value="AWAITING_APPROVAL" ${state.draftFilter === 'AWAITING_APPROVAL' ? 'selected' : ''}>${draftStatusLabel('AWAITING_APPROVAL')}</option>
            <option value="APPROVED" ${state.draftFilter === 'APPROVED' ? 'selected' : ''}>${draftStatusLabel('APPROVED')}</option>
            <option value="SENT" ${state.draftFilter === 'SENT' ? 'selected' : ''}>${draftStatusLabel('SENT')}</option>
            <option value="SKIPPED" ${state.draftFilter === 'SKIPPED' ? 'selected' : ''}>${draftStatusLabel('SKIPPED')}</option>
            <option value="BLOCKED" ${state.draftFilter === 'BLOCKED' ? 'selected' : ''}>${draftStatusLabel('BLOCKED')}</option>
            <option value="UNKNOWN" ${state.draftFilter === 'UNKNOWN' ? 'selected' : ''}>${draftStatusLabel('UNKNOWN')}</option>
          </select>
        </div>
        <div class="messages-draft-list">${draftListHtml()}</div>
      </aside>
      <main class="messages-panel messages-review-panel">
        ${draftReviewHtml()}
      </main>
    </div>`;
  restoreThreadScroll(options.threadScroll, options.previousScroll);
}

function activeDrafts() {
  return state.drafts.filter(draft => {
    const filter = state.draftFilter;
    return filter
      ? statusName(draft.status) === filter
      : ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(statusName(draft.status));
  });
}

function draftListHtml() {
  const drafts = activeDrafts();
  if (!drafts.length) return `<div class="messages-empty">${tr('У цій черзі нічого немає.', 'Nothing in this queue.')}</div>`;
  return drafts.map(draft => {
    const id = draftIdOf(draft);
    const active = id === draftIdOf(state.draft);
    return `
      <button class="messages-draft-card ${active ? 'active' : ''}" type="button" data-draft-id="${escHtml(id)}">
        <span class="messages-draft-topline">
          <span class="messages-status status-${statusName(draft.status).toLowerCase()}">${escHtml(draftStatusLabel(draft.status))}</span>
          <time>${escHtml(displayDate(draft.updated_at || draft.created_at))}</time>
        </span>
        <strong>${escHtml(draftParticipant(draft))}</strong>
        <span>${escHtml(scenarioLabel(draft.scenario))}</span>
        <p>${escHtml(currentDraftBody(draft).slice(0, 150))}</p>
      </button>`;
  }).join('');
}

function draftReviewHtml() {
  const draft = state.draft;
  if (!draft) {
    return `
      <div class="messages-empty messages-empty-center">
        <span class="messages-empty-mark">✓</span>
        <strong>${tr('Оберіть чернетку для перевірки', 'Select a draft to review')}</strong>
        <span>${tr('Нічого не буде надіслано, доки менеджер не перевірить точний текст і явно не натисне «Погодити й надіслати».', 'Nothing leaves the shop until a manager reviews the exact text and explicitly clicks Approve and send.')}</span>
      </div>`;
  }
  const status = statusName(draft.status);
  const metadata = draft.metadata || {};
  const conversation = draftConversation(draft);
  const conversationMessages = listFrom(conversation?.messages).filter(message =>
    ['incoming', 'outgoing'].includes(messageDirection(message)),
  );
  const warnings = listFrom(metadata.warnings || draft.warnings);
  const canEdit = ['DRAFT', 'AWAITING_APPROVAL'].includes(status);
  const canApproveAndSend = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(status);
  const reserveTestSend = reserveTestSendAvailable(draft);
  const deliveryEnabled = canApproveAndSend
    && (!isReserve() || reserveTestSend)
    && state.status?.bridge?.delivery?.approved_outbox_enabled === true;
  return `
    <div class="messages-review-heading">
      <div>
        <span class="messages-status status-${status.toLowerCase()}">${escHtml(draftStatusLabel(status))}</span>
        <h2>${escHtml(draftParticipant(draft))}</h2>
        <p>${tr('Сценарій', 'Scenario')}: ${escHtml(scenarioLabel(draft.scenario))} · ${tr('Чернетка', 'Draft')} #${escHtml(draftIdOf(draft))}</p>
      </div>
      <span class="messages-human-lock">${tr('Потрібне погодження людиною', 'Human approval required')}</span>
    </div>
    <section class="messages-review-context">
      <div class="messages-review-context-heading">
        <div>
          <strong>${tr('Історія діалогу з', 'Conversation history with')} ${escHtml(draftParticipant(draft))}</strong>
          <span>${tr(`Повідомлень: ${conversationMessages.length}`, `${conversationMessages.length} messages`)} · ${tr('діалог Etsy', 'Etsy conversation')} ${escHtml(conversationIdOf(draft))}</span>
        </div>
        ${conversation ? `<button class="btn btn-sm" type="button" data-message-action="sync-history">${tr('Завантажити старішу історію', 'Load older history')}</button>` : ''}
      </div>
      <div class="messages-thread messages-review-thread">
        ${conversation
          ? conversationMessagesHtml(conversation)
          : '<div class="messages-loading"><span class="spinner"></span> Loading conversation history…</div>'}
      </div>
    </section>
    ${status === 'SENT' ? `
      <div class="messages-send-result is-success">
        <strong>Message sent</strong>
        <span>${escHtml(displayDate(draft.sent_at || draft.updated_at))} · resending is unavailable</span>
      </div>` : ''}
    ${status === 'UNKNOWN' ? `
      <div class="messages-send-result is-warning">
        <strong>Delivery result unknown</strong>
        <span>Check the Etsy conversation first. This message will not be retried automatically.</span>
      </div>` : ''}
    <div class="messages-evidence-strip">
      <div><span>Generator</span><strong>${escHtml(metadata.generator || draft.created_by || 'unknown')}</strong></div>
      <div><span>Playbook</span><strong>rev ${escHtml(metadata.playbook_revision ?? '—')}</strong></div>
      <div><span>Confidence</span><strong>${metadata.confidence !== undefined ? `${Math.round(Number(metadata.confidence) * 100)}%` : '—'}</strong></div>
      <div><span>Account</span><strong>${escHtml(draft.account_label || accountLabel())}</strong></div>
    </div>
    ${draft.reason || metadata.rationale ? `
      <div class="messages-rationale"><strong>Why this draft</strong><p>${escHtml(draft.reason || metadata.rationale)}</p></div>` : ''}
    ${warnings.length ? `
      <div class="messages-warning-box"><strong>Warnings to review</strong><ul>${warnings.map(item => `<li>${escHtml(item)}</li>`).join('')}</ul></div>` : ''}
    <label class="messages-field messages-draft-editor">
      <span>Exact buyer-facing text</span>
      <textarea id="messages-review-body" rows="12" ${canEdit ? '' : 'readonly'}>${escHtml(currentDraftBody(draft))}</textarea>
    </label>
    <div class="messages-review-actions">
      ${canApproveAndSend ? `
        <button class="btn btn-primary" type="button" data-message-action="approve-draft" ${deliveryEnabled ? '' : 'disabled'}>
          ${isReserve()
            ? (reserveTestSend
              ? 'Approve and send one test message'
              : 'Approve and send blocked on reserve account')
            : (deliveryEnabled
              ? 'Approve exact text and send'
              : 'Approve and send unavailable')}
        </button>` : ''}
      ${['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(status)
        ? '<button class="btn" type="button" data-message-action="skip-draft">Skip</button><button class="btn btn-danger" type="button" data-message-action="block-draft">Block conversation</button>'
        : ''}
    </div>
    <div class="messages-action-feedback" role="status" aria-live="polite"></div>
    <p class="messages-action-footnote">This one manager click refreshes the Etsy thread, verifies that the newest message is still from the buyer, approves this exact text, and makes one delivery attempt. Unknown outcomes are never retried automatically.</p>`;
}

function automationRuleHtml(rule, index) {
  const scenarioValues = Object.keys(
    state.playbookState?.playbook?.scenarios || scenarioLabels(),
  );
  const eventLabels = automationEventLabels(state.locale);
  const event = String(rule?.event || 'new_message');
  const scenario = String(rule?.scenario || 'freeform');
  const ruleLabel = String(rule?.label || '').trim() || tr('Нове правило', 'New rule');
  const timing = Number(rule?.delay_minutes) > 0
    ? tr('Чернетка з затримкою', 'Delayed draft')
    : tr('Перевірка одразу', 'Check immediately');
  return `
    <details class="messages-automation-rule" data-automation-rule="${index}">
      <summary class="messages-rule-summary">
        <div class="messages-rule-identity">
          <span class="messages-rule-state ${rule?.enabled ? 'is-on' : ''}">${rule?.enabled ? tr('Працює', 'On') : tr('Вимкнено', 'Off')}</span>
          <div><strong>${escHtml(ruleLabel)}</strong><small>${escHtml(scenarioLabel(scenario))} · ${timing}</small></div>
        </div>
        <span class="messages-rule-edit-label">${tr('Редагувати', 'Edit')}</span>
      </summary>
      <div class="messages-rule-editor">
      <header>
        <label class="messages-rule-switch">
          <input type="checkbox" data-auto-field="enabled" ${rule?.enabled ? 'checked' : ''}>
          <span>${tr('Правило працює', 'Rule enabled')}</span>
        </label>
        <button class="messages-rule-remove" type="button" data-remove-automation-rule="${index}" aria-label="${tr('Видалити правило', 'Remove this automation rule')}">${tr('Видалити', 'Remove')}</button>
      </header>
      <label class="messages-field">
        <span>${tr('Назва правила', 'Rule name')} ${helpTip('Назвіть правило так, щоб колега одразу зрозумів його мету.', 'Use a name that tells a colleague exactly what this rule is for.')}</span>
        <input type="text" data-auto-field="label" value="${escHtml(rule?.label || '')}" placeholder="${tr('Наприклад: відповідь про надсилання файлів', 'Example: Answer file upload questions')}">
      </label>
      <div class="messages-rule-grid messages-rule-grid-primary">
        <label class="messages-field">
          <span>${tr('Після якої події', 'After which event')} ${helpTip('Подія лише запускає перевірку. Вона не надсилає повідомлення сама.', 'The event only starts a check. It never sends a message by itself.')}</span>
          <select data-auto-field="event">
            ${automationSelectOptions(
              Object.keys(eventLabels),
              event,
              eventLabels,
            )}
          </select>
        </label>
        <label class="messages-field">
          <span>${tr('Яку відповідь підготувати', 'Which reply to prepare')} ${helpTip('Зміст і тон цього сценарію налаштовуються у вкладці «Як відповідати».', 'The content and tone for this scenario live under How to reply.')}</span>
          <select data-auto-field="scenario">
            ${automationSelectOptions(scenarioValues, scenario, scenarioLabels())}
          </select>
        </label>
        <label class="messages-field">
          <span>${tr('Підготувати через', 'Prepare after')} ${helpTip('Скільки почекати після події. 0 означає перевірити одразу.', 'How long to wait after the event. 0 means check immediately.')}</span>
          ${durationControl('delay_minutes', rule?.delay_minutes, 43_200)}
        </label>
        <label class="messages-field">
          <span>${tr('Захист від повтору', 'Repeat protection')} ${helpTip('Протягом цього часу система не створить ще одну таку саму чернетку.', 'The system will not create another matching draft during this period.')}</span>
          ${durationControl('cooldown_minutes', rule?.cooldown_minutes, 10_080)}
        </label>
      </div>
      <details class="messages-rule-advanced">
        <summary>${tr('Додаткові умови', 'Advanced conditions')} <span>${tr('Відкривайте лише коли правило потребує замовлення або спеціальних фактів', 'Open only when this rule needs order data or special facts')}</span></summary>
        <div>
          <label class="messages-rule-order-check">
            <input type="checkbox" data-auto-field="require_order_context" ${rule?.require_order_context ? 'checked' : ''}>
            <span>${tr('Працювати лише з точно пов’язаним замовленням', 'Require an exactly linked order')} ${helpTip('Якщо замовлення не знайдено однозначно, система безпечно пропустить правило.', 'If the order cannot be linked exactly, the rule is safely skipped.')}</span>
          </label>
          <label class="messages-field">
            <span>${tr('Що система повинна підтвердити', 'Facts the system must confirm')} ${helpTip('Опишіть умови звичайними реченнями. Не додавайте здогадки про конкретного клієнта.', 'Write plain sentences. Do not add guesses about a specific customer.')}</span>
            <textarea rows="3" data-auto-field="conditions" placeholder="${tr('Наприклад: замовлення оплачене, а в операційній картці немає матеріалів чи посилань.', 'Example: the order is paid and its operational card has no materials or links.')}">${escHtml(rule?.conditions || '')}</textarea>
          </label>
          <label class="messages-field">
            <span>${tr('Сталі факти про магазин', 'Stable shop facts')} ${helpTip('Сюди можна додати перевірену адресу email, правила магазину або постійне посилання.', 'Use this for a verified email address, shop policy, or permanent link.')}</span>
            <textarea rows="3" data-auto-field="owner_notes" placeholder="${tr('Лише перевірені сталі дані, без припущень.', 'Verified stable facts only; no assumptions.')}">${escHtml(rule?.owner_notes || '')}</textarea>
          </label>
        </div>
      </details>
      <input type="hidden" data-auto-field="id" value="${escHtml(rule?.id || `rule_${index + 1}`)}">
      </div>
    </details>`;
}

function automationEventHtml(event) {
  const presentation = automationEventPresentation(event, state.locale);
  const eventName = automationEventLabel(
    event?.event || event?.event_type || event?.trigger_event,
    state.locale,
  );
  const draftId = String(event?.draft_id || event?.created_draft_id || '');
  const participant = event?.participant
    || event?.participant_name
    || event?.conversation_name
    || '';
  const technicalReason = event?.reason || event?.message || event?.detail || event?.block_reason || event?.error || '';
  const explanation = automationHumanReason(event, state.locale);
  const time = event?.created_at
    || event?.processed_at
    || event?.occurred_at
    || event?.updated_at
    || event?.timestamp;
  const content = `
    <span class="messages-automation-event-mark" aria-hidden="true"></span>
    <span class="messages-automation-event-copy">
      <span>
        <strong>${escHtml(presentation.label)}</strong>
        <time>${escHtml(displayDate(time) || tr('Час невідомий', 'Time unavailable'))}</time>
      </span>
      <b>${escHtml(eventName)}${participant ? ` · ${escHtml(participant)}` : ''}</b>
      ${explanation ? `<small>${escHtml(explanation)}</small>` : ''}
      ${state.locale === 'uk' && (technicalReason || event?.block_code) ? `
        <details class="messages-event-technical">
          <summary>Технічні подробиці</summary>
          <code>${escHtml([event?.status, event?.block_code, technicalReason].filter(Boolean).join(' · '))}</code>
        </details>` : ''}
    </span>`;
  return draftId
    ? `<button class="messages-automation-event ${presentation.className}" type="button" data-trigger-draft-id="${escHtml(draftId)}">${content}<span class="messages-event-open">${tr('Відкрити чернетку →', 'Review draft →')}</span></button>`
    : `<div class="messages-automation-event ${presentation.className}">${content}</div>`;
}

function renderAutomation() {
  const workspace = document.getElementById('messages-workspace');
  if (!workspace) return;
  const runtime = automationRuntime();
  const policyState = automationPolicyState();
  const policy = policyState.policy;
  const rules = automationRules();
  const events = automationEvents();
  const runner = automationStatusCopy();
  const activeRules = rules.filter(rule => rule.enabled).length;
  const sendFilesActive = rules.some(rule =>
    rule.enabled && rule.event === 'new_message' && rule.scenario === 'how_to_send_files',
  );
  const howToOrderActive = rules.some(rule =>
    rule.enabled && rule.scenario === 'how_to_order',
  );
  const missingMaterialsRule = rules.find(rule =>
    rule.enabled && rule.scenario === 'missing_materials',
  );
  const missingMaterialsActive = Boolean(missingMaterialsRule);
  const missingDelay = Number(missingMaterialsRule?.delay_minutes) === 1_440
    ? tr('затримкою 24 години', 'a 24-hour delay')
    : tr(`затримкою ${Number(missingMaterialsRule?.delay_minutes) || 0} хв`, `a ${Number(missingMaterialsRule?.delay_minutes) || 0}-minute delay`);
  const missingCooldown = Number(missingMaterialsRule?.cooldown_minutes) === 10_080
    ? tr('інтервалом повтору 7 днів', 'a 7-day cooldown')
    : tr(`інтервалом повтору ${Number(missingMaterialsRule?.cooldown_minutes) || 0} хв`, `a ${Number(missingMaterialsRule?.cooldown_minutes) || 0}-minute cooldown`);
  const pendingDrafts = state.drafts.filter(draft =>
    ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(statusName(draft.status)),
  ).length;

  workspace.innerHTML = `
    <div class="messages-automation">
      <header class="messages-automation-hero">
        <div>
          <span class="messages-kicker">${tr('Налаштування сценаріїв', 'Scenario settings')}</span>
          <h2>${tr('Коли система має підготувати чернетку', 'When should the system prepare a draft?')}</h2>
          <p>${tr('Кожне ввімкнене правило описує одну ситуацію. Тут налаштовується лише поява чернетки; рішення про надсилання завжди залишається за менеджером.', 'Each enabled rule describes one situation. This page only controls when a draft appears; sending always remains a manager decision.')}</p>
        </div>
        <div class="messages-runner-state ${runner.className}">
          <span class="messages-runner-pulse" aria-hidden="true"></span>
          <div><strong>${escHtml(runner.label)}</strong><span>${escHtml(runner.detail)}</span></div>
        </div>
      </header>

      <details class="messages-automation-diagnostics">
        <summary>${tr('Стан системи та технічна схема', 'System status and technical flow')} <span>${tr('Потрібно лише для діагностики', 'Only needed for diagnostics')}</span></summary>
      <section class="messages-wakeup-note" aria-label="${tr('Поточні налаштування', 'Current production automation')}">
        <strong>${tr('Що зараз увімкнено', 'Current production setup')}</strong>
        <span>
          ${sendFilesActive
            ? tr('Питання про надсилання файлів перевіряються автоматично.', 'How to send files is active for new-message events.')
            : tr('Сценарій надсилання файлів вимкнено.', 'How to send files is currently disabled.')}
          ${missingMaterialsActive
            ? tr(`Нагадування про матеріали працює із ${missingDelay} та ${missingCooldown}; відсутність визначається за операційною карткою замовлення. Gmail перевіряється окремо лише після слів клієнта, що файли вже надіслані.`, `Missing materials is active for order-paid events with ${missingDelay} and ${missingCooldown}. Absence comes from the operational order card; Gmail is checked separately only after the buyer says files were sent.`)
            : tr('Нагадування про відсутні матеріали вимкнено.', 'Missing materials is currently disabled.')}
          ${tr('Сценарій оформлення замовлення', 'How to order')} ${howToOrderActive ? tr('увімкнено.', 'is active — review the rules below.') : tr('вимкнено.', 'is still disabled.')}
          ${runtime.telegram_notifications_enabled
            ? tr('Якщо правило підходить, система створює чернетку й надсилає окреме сповіщення в Telegram.', 'A matching event creates an AWAITING_APPROVAL draft and a dedicated Telegram notification.')
            : tr('Telegram-сповіщення вимкнені; нові пропозиції з’являються лише в черзі погодження.', 'Telegram notifications are currently disabled; matching suggestions appear only in Approval queue.')}
          ${tr('Менеджер перевіряє точний текст і однією явною дією погоджує та надсилає його. Сервіс сам цю кнопку не натискає й не опитує Etsy постійно.', 'Approve exact text and send is one explicit manager action; the runner never clicks it. The runner does not poll Etsy; it reacts to accepted events and uses refreshed or locally stored evidence.')}
        </span>
      </section>

      <section class="messages-signal-rail" aria-label="How message automation flows">
        <article>
          <span>1</span><div><strong>${tr('Сигнал від Etsy', 'Email / Etsy signal')}</strong><p>${tr('Сповіщення запускає оновлення потрібного діалогу. Саме по собі воно не створює відповіді.', 'A notification wakes the Bridge and refreshes the relevant conversation. This alone never writes a reply.')}</p></div>
        </article>
        <article>
          <span>2</span><div><strong>${tr('Перевірка фактів', 'Evidence check')}</strong><p>${tr('Система перевіряє діалог, зв’язок із замовленням та факти, яких вимагає правило.', 'The system links the conversation to an order and checks Etsy, email and known order facts required by the rule.')}</p></div>
        </article>
        <article class="${automationIsOperational() ? 'is-live' : ''}">
          <span>3</span><div><strong>${tr('Підготовка чернетки', 'Draft runner')}</strong><p>${automationIsOperational() ? tr(`Активних правил: ${activeRules}. Вони можуть готувати пропозиції.`, `${activeRules} active rule${activeRules === 1 ? '' : 's'} can prepare suggestions.`) : tr('Перевірку призупинено: події видно, але чернетки не створюються.', 'Paused events remain visible but create no suggestions.')}</p></div>
        </article>
        <article>
          <span>4</span><div><strong>${tr('Рішення менеджера', 'Approval queue')}</strong><p>${tr(`Чернеток, які очікують рішення: ${pendingDrafts}. Одна явна дія погоджує точний текст і надсилає його.`, `${pendingDrafts} draft${pendingDrafts === 1 ? '' : 's'} currently need a manager decision. One explicit click safely approves the exact text and sends it.`)}</p></div>
        </article>
      </section>

      <section class="messages-automation-metrics" aria-label="Automation status">
        <div><span>${tr('Стан', 'Worker')}</span><strong>${escHtml(statusName(runtime.worker_state || (runtime.implemented ? 'idle' : 'unavailable')))}</strong></div>
        <div><span>${tr('Остання подія', 'Latest event')}</span><strong>${escHtml(displayDate(runtime.last_event_at) || tr('Подій ще не було', 'No events yet'))}</strong></div>
        <div><span>${tr('Остання чернетка', 'Latest suggestion')}</span><strong>${escHtml(displayDate(runtime.last_candidate_at) || tr('Чернеток ще не було', 'No drafts yet'))}</strong></div>
        <div><span>${tr('Правила', 'Rules')}</span><strong>${tr(`${activeRules} активних із ${rules.length}`, `${activeRules} active / ${rules.length} total`)}</strong></div>
      </section>
      ${runtime.last_error ? `<div class="messages-automation-error"><strong>${tr('Потрібна увага', 'Runner needs attention')}</strong><span>${escHtml(runtime.last_error)}</span></div>` : ''}
      </details>

      <div class="messages-automation-columns">
        <section class="messages-panel messages-automation-rules">
          <header class="messages-automation-section-heading">
            <div><span class="messages-kicker">${tr('Правила', 'Rules')}</span><h3>${tr('Коли готувати чернетку', 'When to prepare a suggestion')}</h3></div>
            <label class="messages-master-switch">
              <input id="messages-automation-enabled" type="checkbox" ${policy.enabled ? 'checked' : ''}>
              <span>${tr('Увімкнути автоматичні пропозиції', 'Enable draft suggestions')}</span>
            </label>
          </header>
          <div class="messages-safety-contract">
            <strong>${tr('Незмінне правило безпеки', 'Permanent safety boundary')}</strong>
            <span>${tr('Лише чернетка · кожен текст погоджує людина · жодне правило не може надіслати повідомлення.', 'Draft only · individual human approval required · no rule can send a message.')}</span>
          </div>
          <div id="messages-automation-rule-list" class="messages-automation-rule-list">
            ${rules.length
              ? rules.map(automationRuleHtml).join('')
              : `<div class="messages-empty">${tr('Правил ще немає. Додайте правило, щоб описати, коли потрібна чернетка.', 'No trigger rules yet. Add one to describe when the runner should suggest a reply.')}</div>`}
          </div>
          <div class="messages-automation-rule-actions">
            <button class="btn" type="button" data-message-action="add-automation-rule">${tr('Додати правило', 'Add rule')}</button>
            <button class="btn btn-primary" type="button" data-message-action="save-automation-policy">${tr('Зберегти правила', 'Save automation rules')}</button>
          </div>
          <div class="messages-action-feedback" role="status" aria-live="polite"></div>
          <p class="messages-action-footnote">${tr('Зміни вплинуть лише на майбутні чернетки. Наявні чернетки не зміняться.', 'Saving a rule changes future draft suggestions only. Existing drafts stay unchanged.')}</p>
        </section>

        <section class="messages-panel messages-automation-activity">
          <header class="messages-automation-section-heading">
            <div><span class="messages-kicker">${tr('Журнал', 'Activity')}</span><h3>${tr('Результати автоматичних перевірок', 'What the runner noticed')}</h3></div>
            <span>${tr('Останні перевірки', 'Latest checks')}</span>
          </header>
          <div class="messages-wakeup-note">
            <strong>${tr('Лист Etsy лише запускає перевірку діалогу.', 'Email wake-up is not a reply trigger by itself.')}</strong>
            <span>${tr('Чернетка з’явиться лише тоді, коли активне правило підходить і перевірених даних достатньо.', 'Only a matching enabled rule with enough verified evidence may create a draft.')}</span>
          </div>
          <div class="messages-automation-event-list">
            ${events.length
              ? events.map(automationEventHtml).join('')
              : `<div class="messages-empty">${tr('Перевірок ще не було. Нові результати й чернетки з’являться тут.', 'No trigger activity yet. New checks and draft suggestions will appear here.')}</div>`}
          </div>
        </section>
      </div>
    </div>`;
}

function lines(value) {
  return (Array.isArray(value) ? value : [])
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .join('\n');
}

function renderLegacyManagerGuide() {
  const workspace = document.getElementById('messages-workspace');
  if (!workspace) return;
  workspace.innerHTML = `
    <div class="messages-guide">
      <header class="messages-guide-hero">
        <div>
          <span class="messages-kicker">Інструкція для менеджера</span>
          <h2>Як зараз працюють повідомлення Etsy</h2>
          <p>Панель збирає локальну історію, готує AI-чернетки та зберігає їх для перевірки. Агент не може сам підтвердити або надіслати повідомлення.</p>
        </div>
        <div class="messages-guide-status">
          <strong>Поточний етап</strong>
          <span>How to send files працює від події нового повідомлення</span>
          <span>Чернетка й Telegram-сповіщення створюються автоматично</span>
          <span>Approve і Send залишаються окремими ручними діями</span>
        </div>
      </header>

      <section class="messages-guide-flow" aria-label="Щоденний процес">
        ${[
          ['01', 'Відкрити діалог', 'Inbox показує локальну копію. За потреби натисніть Load older history now.'],
          ['02', 'Перевірити сценарій', 'Автоматично зараз працює лише How to send files. How to order і Missing materials вимкнені.'],
          ['03', 'Додати лише факти', 'Owner notes — тільки для перевірених адрес, посилань, опцій чи іншого контексту.'],
          ['04', 'Створити чернетку', 'Generate approval draft додає текст у Queue, але нічого не надсилає.'],
          ['05', 'Перевірити й надіслати', 'Прочитайте історію, виправте точний текст і натисніть Approve exact text and send. Це одна явна дія менеджера.'],
          ['06', 'Перевірка перед відправкою', 'Система ще раз оновить цей діалог Etsy і не відправить текст, якщо клієнту вже відповіли або напрямок останнього повідомлення не підтверджений.'],
        ].map(([number, title, copy]) => `
          <article>
            <span>${number}</span>
            <div><strong>${title}</strong><p>${copy}</p></div>
          </article>`).join('')}
      </section>

      <div class="messages-guide-grid">
        <section class="messages-panel messages-guide-card">
          <span class="messages-kicker">Уже працює</span>
          <h3>Що можна робити зараз</h3>
          <ul>
            <li>читати діалоги, історію та вкладення;</li>
            <li>бачити нове в цій панелі без зміни read-статусу на Etsy;</li>
            <li>готувати відповіді про надсилання файлів і оформлення замовлення;</li>
            <li>створювати довільну відповідь через General reply;</li>
            <li>навчати тон, правила та приклади в Agent Playbook;</li>
            <li>редагувати й окремо погоджувати точний текст у Queue.</li>
          </ul>
        </section>
        <section class="messages-panel messages-guide-card is-warning">
          <span class="messages-kicker">Ще не автоматизовано</span>
          <h3>Де система поки не має доказів</h3>
          <ul>
            <li>чи є матеріали або посилання в операційній картці; Gmail перевіряється точково лише після заяви клієнта про відправку;</li>
            <li>який діалог точно належить конкретному замовленню;</li>
            <li>чи настав дедлайн і чи готове перевірене посилання на результат;</li>
            <li>чи можна просити відгук і чи його вже не залишили;</li>
            <li>автоматичний вибір сценарію, delay та cooldown.</li>
          </ul>
        </section>
      </div>

      <section class="messages-panel messages-guide-scenarios">
        <div>
          <span class="messages-kicker">Сценарії менеджера</span>
          <h3>Чесний стан готовності</h3>
        </div>
        <div class="messages-guide-table">
          <div class="is-ready"><strong>Як надіслати файли</strong><span>Активне event-driven правило створює AWAITING_APPROVAL і Telegram-сповіщення.</span></div>
          <div class="is-partial"><strong>Як оформити замовлення</strong><span>Автоматичне правило вимкнене; факти про listing, кількість людей, опції та ціну треба перевіряти.</span></div>
          <div class="is-blocked"><strong>Не отримані матеріали</strong><span>Працює за точно пов’язаним замовленням і станом його операційної Trello-картки.</span></div>
          <div class="is-blocked"><strong>Дедлайн</strong><span>Очікує перевіреного дедлайну, стану матеріалів і result link.</span></div>
          <div class="is-blocked"><strong>Запит відгуку</strong><span>Вимкнений до появи eligibility, винятків і захисту від повторних запитів.</span></div>
        </div>
      </section>

      <section class="messages-panel messages-guide-card">
        <span class="messages-kicker">Як навчати агента</span>
        <h3>Agent Playbook</h3>
        <ol>
          <li>Запишіть бажаний тон, довжину, мову й підпис.</li>
          <li>Додайте правила, яких відповідь ніколи не має порушувати.</li>
          <li>Опишіть окремо кожен сценарій.</li>
          <li>Додайте реальні приклади: повідомлення покупця, точну хорошу відповідь і пояснення.</li>
          <li>Натисніть Save new revision, потім перевірте результат у Safe sandbox.</li>
        </ol>
        <p class="messages-guide-note">Playbook навчає змісту й тону. Він не запускає тригери сам по собі.</p>
      </section>

      <section class="messages-panel messages-guide-card">
        <span class="messages-kicker">Майбутній процес</span>
        <h3>Що означатиме автоматизація</h3>
        <p class="messages-guide-chain">Подія → перевірка діалогу й замовлення → докази з Etsy/email/Drive → вибір сценарію → delay/cooldown → чернетка → перевірка менеджером → Approve → окремий Send</p>
        <p>Навіть після запуску тригери створюватимуть лише чернетки. Окремий Telegram-бот для погодження не потрібний: основним робочим місцем залишиться Approval queue, а Telegram можна використати лише для сповіщення.</p>
      </section>
    </div>`;
}

function renderDetailedManagerGuide() {
  const workspace = document.getElementById('messages-workspace');
  if (!workspace) return;
  const runtime = automationRuntime();
  const rules = automationRules();
  const events = automationEvents();
  const activeRules = rules.filter(rule => rule.enabled);
  const pendingDrafts = state.drafts.filter(draft =>
    ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(statusName(draft.status)),
  ).length;
  const runtimeText = automationIsOperational()
    ? `Автоматична перевірка активна: ${activeRules.length} правил увімкнено.`
    : 'Автоматична перевірка зараз призупинена. Її стан і причину видно у вкладці Automation.';
  const notificationText = runtime.telegram_notifications_enabled
    ? 'Після створення чернетки менеджер також отримує сповіщення у виділеному Telegram-боті.'
    : 'Telegram-сповіщення зараз вимкнені: усі пропозиції видно лише в Approval queue.';
  const productionHeading = automationIsOperational()
    ? `Активні автоматичні правила: ${activeRules.length}`
    : 'Автоматичні правила зараз вимкнені';
  const productionSummary = automationIsOperational()
    ? `Прийнята подія запускає лише правила, які видно як увімкнені у вкладці Automation. За збігу система може створити <strong>AWAITING_APPROVAL</strong>. ${notificationText}`
    : `Нові події можуть оновлювати діалоги, але зараз не створюють автоматичних чернеток. Для безпечної перевірки відкрийте діалог і натисніть <strong>Preview suggestion — nothing saved</strong>. ${notificationText}`;

  workspace.innerHTML = `
    <div class="messages-guide">
      <header class="messages-guide-hero">
        <div>
          <span class="messages-kicker">Інструкція для менеджера</span>
          <h2>Як працювати з автоматичними пропозиціями відповідей</h2>
          <p>Система помічає події, перевіряє діалог і доступні дані замовлення, а потім — лише коли вистачає підтверджених фактів — готує чернетку. Жодна чернетка не стає повідомленням без окремого рішення менеджера.</p>
        </div>
        <div class="messages-guide-status">
          <strong>Стан зараз</strong>
          <span>${escHtml(runtimeText)}</span>
          <span>${pendingDrafts} чернеток очікують рішення менеджера.</span>
          <span>Остання перевірена подія: ${escHtml(displayDate(runtime.last_event_at) || 'ще не було')}.</span>
        </div>
      </header>

      <section class="messages-panel messages-guide-card">
        <span class="messages-kicker">Production зараз</span>
        <h3>${escHtml(productionHeading)}</h3>
        <p>${productionSummary}</p>
        <p class="messages-guide-note">Bridge не опитує Etsy за таймером і не відкриває всі діалоги у фоні. Він реагує на прийняті події або явні запити; панель між подіями читає локальну базу.</p>
      </section>

      <section class="messages-guide-flow" aria-label="Робочий процес менеджера">
        ${[
          ['01', 'Система помічає подію', 'Лист Etsy або інша подія лише будить синхронізацію. Це ще не означає, що клієнту треба відповідати.'],
          ['02', 'Перевіряються факти', 'Runner зіставляє подію з правилами, історією діалогу, замовленням та доступними даними про матеріали.'],
          ['03', 'З’являється пропозиція', `Якщо правило підійшло і фактів достатньо, чернетка AWAITING_APPROVAL потрапляє в Approval queue. ${notificationText}`],
          ['04', 'Менеджер читає контекст', 'Відкрийте чернетку, прочитайте історію, причину й попередження. Відредагуйте текст, якщо потрібно.'],
          ['05', 'Ручне погодження й надсилання', 'Approve exact text and send — одна явна дія менеджера. Агент не може натиснути її або погодити себе сам.'],
          ['06', 'Навчання на майбутнє', 'Вдалий стиль, сталі правила й типові відповіді додавайте в Agent Playbook, а умови запуску — в Automation.'],
        ].map(([number, title, copy]) => `
          <article>
            <span>${number}</span>
            <div><strong>${title}</strong><p>${copy}</p></div>
          </article>`).join('')}
      </section>

      <div class="messages-guide-grid">
        <section class="messages-panel messages-guide-card">
          <span class="messages-kicker">Щоденна робота</span>
          <h3>Куди дивитися</h3>
          <ol>
            <li><strong>Inbox</strong> — нові діалоги й повна локально збережена переписка.</li>
            <li><strong>Automation</strong> — чи працює runner, які правила активні та що саме він помітив або пропустив.</li>
            <li><strong>Approval queue</strong> — готові пропозиції з історією, причиною та точним текстом для перевірки.</li>
            <li><strong>Agent Playbook</strong> — тон, заборони, інструкції сценаріїв і приклади хороших відповідей.</li>
            <li><strong>Пряме посилання</strong> — відкрийте потрібну вкладку, діалог або чернетку й скопіюйте URL браузера.</li>
          </ol>
        </section>
        <section class="messages-panel messages-guide-card">
          <span class="messages-kicker">Важлива різниця</span>
          <h3>Синхронізація ≠ чернетка ≠ надсилання</h3>
          <ul>
            <li><strong>Email wake-up</strong> оновлює діалог, але сам не створює відповідь.</li>
            <li><strong>Rule match</strong> може створити лише пропозицію, якщо є потрібні докази.</li>
            <li><strong>Approve</strong> погоджує точний текст, але не є прихованим автоматичним надсиланням.</li>
            <li>Помилка або нестача фактів показується в Automation activity; система не повинна домислювати дані.</li>
          </ul>
        </section>
      </div>

      <section class="messages-panel messages-guide-scenarios">
        <div>
          <span class="messages-kicker">Сценарії менеджера</span>
          <h3>Що може поповнювати чергу</h3>
        </div>
        <div class="messages-guide-table">
          ${Object.entries(scenarioLabels())
            .filter(([key]) => key !== 'freeform')
            .map(([key, label]) => {
              const matching = activeRules.filter(rule => rule.scenario === key);
              return `
                <div class="${matching.length ? 'is-ready' : 'is-partial'}">
                  <strong>${escHtml(label)}</strong>
                  <span>${matching.length
                    ? `${matching.length} активних правил. Події можуть створювати чернетки після перевірки фактів.`
                    : 'Сценарій навчений у Playbook, але автоматичне правило для нього не ввімкнено.'}</span>
                </div>`;
            }).join('')}
        </div>
      </section>

      <section class="messages-panel messages-guide-card">
        <span class="messages-kicker">Як налаштувати Automation</span>
        <h3>Правило відповідає на чотири питання</h3>
        <ol>
          <li><strong>Коли?</strong> Виберіть реальну подію: нове повідомлення, оплата, відсутні матеріали, дедлайн або завершення замовлення.</li>
          <li><strong>Яка відповідь?</strong> Виберіть сценарій із Playbook.</li>
          <li><strong>За яких умов?</strong> Простою мовою запишіть факти, які система мусить підтвердити.</li>
          <li><strong>Коли повторювати?</strong> Встановіть затримку та cooldown, щоб не створювати дублікати.</li>
        </ol>
        <p class="messages-guide-note">Спочатку збережіть правило вимкненим і перевірте його формулювання. Увімкніть його лише коли Playbook містить правильну інструкцію та приклади для цього сценарію.</p>
      </section>

      <section class="messages-panel messages-guide-card">
        <span class="messages-kicker">Як навчати агента</span>
        <h3>Правила, приклади та факти мають різні ролі</h3>
        <ul>
          <li><strong>Playbook</strong> описує постійний тон і те, як відповідати в кожному сценарії.</li>
          <li><strong>Automation rule</strong> описує, коли варто підготувати таку відповідь.</li>
          <li><strong>Verified order context</strong> дає факти про конкретного клієнта й замовлення.</li>
          <li><strong>Manager edit</strong> завжди має пріоритет для конкретної чернетки.</li>
          <li><strong>До підтвердженої оплати</strong> агент спочатку скеровує до оформлення замовлення й не просить надсилати матеріали.</li>
        </ul>
        <p class="messages-guide-note">Щоб навчити агента, змініть інструкцію сценарію або додайте перевірений приклад «повідомлення покупця → правильна відповідь», а потім натисніть Save new revision. Це змінить майбутні чернетки, але не ввімкне вимкнене Automation rule.</p>
        <p>Останні ${events.length} подій показані у вкладці Automation. Відкрийте подію «Draft ready for review», щоб одразу перейти до відповідної чернетки.</p>
      </section>
    </div>`;
}

function renderManagerGuide() {
  const workspace = document.getElementById('messages-workspace');
  if (!workspace) return;
  const runtime = automationRuntime();
  const rules = automationRules();
  const activeRules = rules.filter(rule => rule.enabled);
  const pendingDrafts = state.drafts.filter(draft =>
    ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(statusName(draft.status)),
  ).length;
  const runnerLabel = automationIsOperational()
    ? tr('Чернетки готуються автоматично', 'Draft suggestions are active')
    : tr('Автоматичні чернетки призупинені', 'Draft suggestions are paused');
  const lastEvent = displayDate(runtime.last_event_at) || tr('ще не було', 'none yet');

  workspace.innerHTML = `
    <div class="messages-guide messages-guide-simple">
      <header class="messages-guide-hero messages-guide-hero-simple">
        <div>
          <span class="messages-kicker">${tr('Коротко про роботу', 'The short version')}</span>
          <h2>${tr('Вам потрібно лише перевірити чернетку', 'Your job is simply to review the draft')}</h2>
          <p>${tr('Система сама помічає потрібну ситуацію та готує відповідь. Ви читаєте контекст, за потреби виправляєте текст і вирішуєте, чи надсилати його.', 'The system notices a relevant situation and prepares a reply. You read the context, edit if needed, and decide whether to send it.')}</p>
        </div>
        <aside class="messages-guide-today" aria-label="${tr('Що потребує уваги зараз', 'What needs attention now')}">
          <span>${tr('Зараз', 'Right now')}</span>
          <strong>${pendingDrafts}</strong>
          <p>${tr('чернеток чекають на ваше рішення', 'drafts are waiting for your decision')}</p>
          <button class="btn btn-primary" type="button" data-message-tab="queue">${tr('Перейти до перевірки', 'Review drafts')}</button>
        </aside>
      </header>

      <section class="messages-manager-path" aria-label="${tr('Три кроки роботи', 'Three-step workflow')}">
        <article><span>1</span><div><strong>${tr('Система помітила', 'System notices')}</strong><p>${tr('Нове питання або подію замовлення.', 'A new question or order event.')}</p></div></article>
        <article><span>2</span><div><strong>${tr('Чернетка готова', 'Draft is ready')}</strong><p>${tr('Разом з історією та причиною.', 'With conversation history and a reason.')}</p></div></article>
        <article class="is-manager"><span>3</span><div><strong>${tr('Ви вирішуєте', 'You decide')}</strong><p>${tr('Виправити, надіслати або пропустити.', 'Edit, send, or skip.')}</p></div></article>
      </section>

      <section class="messages-guide-workmap" aria-label="${tr('Карта розділу повідомлень', 'Messages workspace map')}">
        <header><span class="messages-kicker">${tr('Карта панелі', 'Workspace map')}</span><h3>${tr('Куди заходити і навіщо', 'Where to go and why')}</h3></header>
        <div>
          <button type="button" data-message-tab="queue">
            <span class="messages-workmap-number">01</span><strong>${tr('На перевірку', 'To review')}</strong>
            <small>${tr('Ваш головний щоденний екран. Тут є історія, чернетка та кнопка рішення.', 'Your main daily screen: history, draft, and decision button.')}</small>
          </button>
          <button type="button" data-message-tab="inbox">
            <span class="messages-workmap-number">02</span><strong>${tr('Діалоги', 'Conversations')}</strong>
            <small>${tr('Коли треба самостійно знайти й прочитати переписку.', 'Use this when you need to find and read a conversation.')}</small>
          </button>
          <button type="button" data-message-tab="automation">
            <span class="messages-workmap-number">03</span><strong>${tr('Коли готувати', 'When to draft')}</strong>
            <small>${tr('Рідкісне налаштування: які ситуації мають створювати чернетку.', 'Occasional setup: which situations should create drafts.')}</small>
          </button>
          <button type="button" data-message-tab="playbook">
            <span class="messages-workmap-number">04</span><strong>${tr('Як відповідати', 'How to reply')}</strong>
            <small>${tr('Рідкісне налаштування: тон, правила та правильні приклади.', 'Occasional setup: tone, rules, and good examples.')}</small>
          </button>
        </div>
      </section>

      <div class="messages-guide-simple-grid">
        <section class="messages-panel messages-guide-card messages-guide-daily">
          <span class="messages-kicker">${tr('Щоденний маршрут', 'Daily routine')}</span>
          <h3>${tr('Що робити, коли прийшло сповіщення', 'What to do when a notification arrives')}</h3>
          <ol>
            <li>${tr('Відкрийте чернетку за посиланням або у вкладці «На перевірку».', 'Open the draft from the link or the To review tab.')}</li>
            <li>${tr('Прочитайте останні повідомлення й перевірте, що відповідь доречна.', 'Read the latest messages and confirm the reply makes sense.')}</li>
            <li>${tr('Виправте текст, якщо потрібно, і натисніть «Погодити й надіслати».', 'Edit if needed, then choose Approve and send.')}</li>
          </ol>
          <p class="messages-guide-note">${tr('Без вашого натискання жодне повідомлення не надсилається.', 'Nothing is sent until you explicitly approve it.')}</p>
        </section>

        <section class="messages-panel messages-guide-card messages-guide-health">
          <span class="messages-kicker">${tr('Стан системи', 'System status')}</span>
          <h3>${escHtml(runnerLabel)}</h3>
          <dl>
            <div><dt>${tr('Активних сценаріїв', 'Active scenarios')}</dt><dd>${activeRules.length}</dd></div>
            <div><dt>${tr('Остання перевірка', 'Latest check')}</dt><dd>${escHtml(lastEvent)}</dd></div>
            <div><dt>${tr('Надсилання', 'Sending')}</dt><dd>${tr('Лише після рішення людини', 'Only after human approval')}</dd></div>
          </dl>
          <button class="btn" type="button" data-message-tab="automation">${tr('Переглянути стан і правила', 'View status and rules')}</button>
        </section>
      </div>

      <section class="messages-guide-more">
        <span class="messages-kicker">${tr('Коли потрібно більше', 'When you need more')}</span>
        <h3>${tr('Рідкісні налаштування', 'Occasional settings')}</h3>
        <details>
          <summary><strong>${tr('Хочу змінити, коли з’являється чернетка', 'Change when a draft appears')}</strong><span>${tr('Відкрийте «Коли готувати»', 'Open When to draft')}</span></summary>
          <p>${tr('Кожне правило описує одну ситуацію: яка подія сталася, яку відповідь підготувати, через який час і як довго не повторювати її. Спеціальні умови сховані всередині самого правила.', 'Each rule describes one situation: the event, reply type, delay, and repeat protection. Special conditions are tucked inside the rule.')}</p>
          <button class="btn" type="button" data-message-tab="automation">${tr('Відкрити правила', 'Open rules')}</button>
        </details>
        <details>
          <summary><strong>${tr('Хочу змінити тон або саму відповідь', 'Change the tone or reply')}</strong><span>${tr('Відкрийте «Як відповідати»', 'Open How to reply')}</span></summary>
          <p>${tr('Там зберігаються стиль, заборони та приклади. Зміна цих інструкцій впливає лише на майбутні чернетки.', 'This is where tone, guardrails, and examples live. Changes affect future drafts only.')}</p>
          <button class="btn" type="button" data-message-tab="playbook">${tr('Відкрити інструкції агенту', 'Open reply instructions')}</button>
        </details>
        <details>
          <summary><strong>${tr('Бачу «пропущено» або «безпечно зупинено»', 'I see skipped or safely stopped')}</strong><span>${tr('Це не поломка в більшості випадків', 'Usually this is not a failure')}</span></summary>
          <p>${tr('Система не створила чернетку, бо відповідь не потрібна, магазин уже відповів або не вистачило перевірених фактів. Технічну причину можна розкрити в журналі вкладки «Коли готувати».', 'The system did not create a draft because no reply was needed, the shop already replied, or verified facts were missing. The technical reason can be expanded in the When to draft activity log.')}</p>
        </details>
      </section>
    </div>`;
}

function scenarioContextLabel(key) {
  if (ORDER_SCENARIOS.has(key)) return tr('Потрібні перевірені дані замовлення', 'Verified order context required');
  if (key === 'how_to_order') {
    return tr('Діалог і перевірені дані лістинга та опцій', 'Conversation plus verified listing and option facts');
  }
  if (key === 'how_to_send_files') {
    return tr('Точно підтверджене оплачене замовлення та затверджені способи надсилання файлів', 'Exact verified paid order plus shop-approved file delivery facts');
  }
  return tr('Достатньо контексту діалогу', 'Conversation context is enough');
}

function renderPlaybook() {
  const workspace = document.getElementById('messages-workspace');
  if (!workspace) return;
  const current = state.playbookState;
  const playbook = current?.playbook;
  if (!playbook) {
    workspace.innerHTML = `<div class="messages-loading">${tr('Інструкції агенту недоступні.', 'Playbook unavailable.')}</div>`;
    return;
  }
  workspace.innerHTML = `
    <div class="messages-playbook-layout">
      <header class="messages-playbook-intro">
        <div>
          <span class="messages-kicker">${tr('Навчання агента', 'Agent training')} · ${tr('версія', 'revision')} ${Number(current.revision) || 0}</span>
          <h2>${tr('Навчіть агента правилами та прикладами', 'Teach decisions with rules and examples')}</h2>
          <p>${tr('Ці інструкції додаються до кожного запиту на чернетку. У прикладах покажіть повідомлення клієнта, відповідь, яку ви справді погодили б, і коротко поясніть чому.', 'The Playbook is injected into every draft request. Examples should show the customer message, the reply you would actually approve, and why.')}</p>
        </div>
        <button class="btn btn-primary" type="button" data-message-action="save-playbook">${tr('Зберегти нову версію', 'Save new revision')}</button>
      </header>
      <div class="messages-playbook-grid">
        <section class="messages-panel messages-playbook-section">
          <div class="messages-section-number">01</div>
          <div class="messages-section-copy">
            <h3>${tr('Стиль відповіді', 'Voice')}</h3>
            <label class="messages-field"><span>${tr('Тон', 'Tone')} ${helpTip('Опишіть враження від відповіді: наприклад, дружньо, тепло й без зайвої офіційності.', 'Describe how the reply should feel, such as warm, friendly, and not overly formal.')}</span><textarea id="pb-tone" rows="3">${escHtml(playbook.tone.summary)}</textarea></label>
            <label class="messages-field"><span>${tr('Звична довжина', 'Typical length')} ${helpTip('Вкажіть бажану кількість коротких речень, а не символів.', 'Describe the preferred number of short sentences, not a character count.')}</span><textarea id="pb-length" rows="2">${escHtml(playbook.tone.response_length)}</textarea></label>
            <label class="messages-field"><span>${tr('Правило вибору мови', 'Language policy')} ${helpTip('Наприклад: відповідати мовою, якою написав клієнт.', 'For example: reply in the language used by the customer.')}</span><textarea id="pb-language" rows="2">${escHtml(playbook.tone.language_policy)}</textarea></label>
            <label class="messages-field"><span>${tr('Підпис (необов’язково)', 'Signature (optional)')} ${helpTip('Залиште порожнім, якщо підпис не потрібний у кожній відповіді.', 'Leave this empty if every reply should not include a signature.')}</span><input type="text" id="pb-signature" value="${escHtml(playbook.tone.signature)}"></label>
          </div>
        </section>
        <section class="messages-panel messages-playbook-section">
          <div class="messages-section-number">02</div>
          <div class="messages-section-copy">
            <h3>${tr('Обмеження', 'Guardrails')}</h3>
            <label class="messages-field"><span>${tr('Одне обов’язкове правило в кожному рядку', 'One hard rule per line')} ${helpTip('Це незмінні заборони, які діють для всіх сценаріїв.', 'These are non-negotiable rules applied to every scenario.')}</span><textarea id="pb-rules" rows="10">${escHtml(lines(playbook.hard_rules))}</textarea></label>
            <label class="messages-field"><span>${tr('Небажані фрази, по одній у рядку', 'Avoid phrases, one per line')} ${helpTip('Додайте слова або шаблонні фрази, яких агент не повинен використовувати.', 'Add words or canned phrases the agent should not use.')}</span><textarea id="pb-avoid" rows="5">${escHtml(lines(playbook.avoid_phrases))}</textarea></label>
          </div>
        </section>
      </div>
      <section class="messages-panel messages-playbook-scenarios">
        <div class="messages-section-heading">
          <div><span class="messages-kicker">03 · ${tr('Сценарії', 'Scenarios')}</span><h3>${tr('Як агент має міркувати', 'How the agent should reason')}</h3></div>
          <span>${tr('Сценарії, що залежать від замовлення, доступні лише для надійно пов’язаних замовлень.', 'Order-context scenarios require a reliably linked order.')}</span>
        </div>
        <div class="messages-scenario-grid">
          ${Object.entries(playbook.scenarios).map(([key, scenario]) => `
            <details class="messages-scenario-card ${ORDER_SCENARIOS.has(key) ? 'requires-order' : ''}">
              <summary>
                <strong>${escHtml(scenarioLabel(key))}</strong>
                <span>${scenarioContextLabel(key)}</span>
              </summary>
              <div>
                <label class="messages-scenario-toggle">
                  <input type="checkbox" data-pb-scenario-enabled="${escHtml(key)}" ${scenario.enabled ? 'checked' : ''}>
                  <strong>${tr('Використовувати цей сценарій', 'Use this scenario')}</strong>
                  ${helpTip('Це дозволяє агенту готувати такий тип відповіді, але не вмикає автоматичне правило.', 'This lets the agent prepare this reply type, but does not enable an automation rule.')}
                </label>
                <label class="messages-field">
                  <span>${tr('Як відповідати в цій ситуації', 'How to reply in this situation')} ${helpTip('Опишіть потрібні кроки, факти й обмеження простою мовою.', 'Describe the required steps, facts, and limits in plain language.')}</span>
                  <textarea rows="6" data-pb-scenario-instructions="${escHtml(key)}">${escHtml(scenario.instructions)}</textarea>
                </label>
              </div>
            </details>`).join('')}
        </div>
      </section>
      <section class="messages-panel messages-examples-section">
        <div class="messages-section-heading">
          <div><span class="messages-kicker">04 · ${tr('Приклади', 'Examples')}</span><h3>${tr('Зразки правильних відповідей', 'Approved response patterns')}</h3></div>
          <span id="messages-example-count">${tr(`Прикладів: ${playbook.examples.length}`, `${playbook.examples.length} examples`)}</span>
        </div>
        <div id="messages-example-list" class="messages-example-list">${examplesHtml(playbook.examples)}</div>
        <div class="messages-example-editor">
          <label class="messages-field"><span>${tr('Сценарій', 'Scenario')}</span><select id="pb-example-scenario">${Object.entries(playbook.scenarios).map(([key, item]) =>
            `<option value="${escHtml(key)}">${escHtml(scenarioLabel(key))}</option>`,
          ).join('')}</select></label>
          <label class="messages-field"><span>${tr('Повідомлення клієнта', 'Customer message')}</span><textarea id="pb-example-customer" rows="4"></textarea></label>
          <label class="messages-field"><span>${tr('Відповідь, яку ви погодили б', 'The reply you would approve')}</span><textarea id="pb-example-reply" rows="4"></textarea></label>
          <label class="messages-field"><span>${tr('Чому це хороша відповідь', 'Why this is a good reply')}</span><textarea id="pb-example-notes" rows="3"></textarea></label>
          <button class="btn messages-example-add" type="button" data-message-action="add-example">${tr('Додати приклад', 'Add example')}</button>
        </div>
      </section>
      <section class="messages-panel messages-preview-section">
        <div class="messages-preview-heading">
          <span class="messages-kicker">${tr('Безпечна перевірка', 'Safe sandbox')}</span>
          <h3>${tr('Перевірити збережені інструкції', 'Preview the saved Playbook')}</h3>
          <p>${tr('Спершу збережіть зміни. Перевірка звертається до агента, але не створює чернетку в черзі й нічого не надсилає в Etsy.', 'Save pending edits first. Preview calls the agent but never creates an outbox draft and never sends to Etsy.')}</p>
        </div>
        <div class="messages-preview-form">
          <label class="messages-field"><span>${tr('Сценарій', 'Scenario')}</span><select id="pb-preview-scenario">${scenarioOptions()}</select></label>
          <label class="messages-field"><span>${tr('Приклад повідомлення клієнта', 'Example customer message')}</span><textarea id="pb-preview-customer" rows="4"></textarea></label>
          <label class="messages-field"><span>${tr('Перевірені факти або вказівка менеджера', 'Verified facts or owner direction')}</span><textarea id="pb-preview-notes" rows="3"></textarea></label>
          <button class="btn" type="button" data-message-action="preview-playbook">${tr('Згенерувати перевірку', 'Generate preview')}</button>
        </div>
        <div id="pb-preview-result" class="messages-preview-result"></div>
      </section>
    </div>`;
}

function examplesHtml(examples) {
  if (!examples.length) {
    return `<div class="messages-empty">${tr('Прикладів ще немає. Додайте реальну відповідь, яку ви погодили б.', 'No examples yet. Add a real pattern you would approve.')}</div>`;
  }
  return examples.map((example, index) => `
    <article class="messages-example">
      <div><span>${escHtml(example.scenario)}</span><button type="button" data-remove-example="${index}" aria-label="Remove example">×</button></div>
      <p><strong>${tr('Клієнт', 'Buyer')}</strong>${escHtml(example.customer_message)}</p>
      <p><strong>${tr('Правильна відповідь', 'Ideal reply')}</strong>${escHtml(example.ideal_reply)}</p>
      ${example.notes ? `<p><strong>${tr('Чому', 'Why')}</strong>${escHtml(example.notes)}</p>` : ''}
    </article>`).join('');
}

async function loadAll() {
  const inboxFilter = state.inboxFilter;
  const inboxRequestRevision = ++state.inboxRequestRevision;
  const results = await Promise.allSettled([
    messagesApi.status(),
    messagesApi.listConversations({
      needs_attention: inboxFilter,
      limit: CONVERSATION_PAGE_SIZE,
      cursor: 0,
    }),
    messagesApi.listDrafts({ limit: 100 }),
    messagesApi.getPlaybook(),
    messagesApi.getAutomationStatus(),
  ]);
  if (results[0].status === 'fulfilled') state.status = results[0].value;
  if (
    results[1].status === 'fulfilled'
    && inboxRequestRevision === state.inboxRequestRevision
    && inboxFilter === state.inboxFilter
  ) {
    applyFirstConversationPage(results[1].value, { reset: true });
  }
  if (results[2].status === 'fulfilled') state.drafts = listFrom(results[2].value);
  if (results[3].status === 'fulfilled') state.playbookState = results[3].value;
  if (results[4].status === 'fulfilled') state.automationState = results[4].value;
  const failures = results.filter(result => result.status === 'rejected');
  renderStatus();
  renderActiveTab();
  if (failures.length) toastError(failures[0].reason?.message || 'Part of Messages is unavailable');
}

async function selectConversation(id) {
  state.conversation = await messagesApi.getConversation(id);
  state.visibleMessageLimit = INITIAL_VISIBLE_MESSAGE_LIMIT;
  updateMessagesRoute();
  renderInbox({ threadScroll: 'bottom' });
  try {
    await markConversationViewedHere(id);
    // The first bottom-scroll is scheduled for the next animation frame.
    // A fast viewed-status update must not re-render and overwrite it with
    // the initial scrollTop=0 snapshot before that frame has executed.
    renderLocalInboxUpdate(null, snapshotConversationListScroll(), 'bottom');
  } catch (error) {
    toastError(error?.message || 'Could not update the local viewed status');
  }
  try {
    const refreshed = await messagesApi.refreshConversationRecent(id);
    if (
      refreshed?.conversation
      && state.tab === 'inbox'
      && String(id) === conversationIdOf(state.conversation)
    ) {
      state.conversation = refreshed.conversation;
      state.conversations = state.conversations.map(conversation =>
        conversationIdOf(conversation) === String(id)
          ? { ...conversation, ...refreshed.conversation }
          : conversation,
      );
      renderInbox({ threadScroll: 'bottom' });
    }
  } catch (error) {
    toastError(error?.message || 'Could not refresh this Etsy conversation');
  }
}

function renderLocalInboxUpdate(
  previousScroll,
  previousListScroll = snapshotConversationListScroll(),
  threadScroll = 'position',
) {
  if (state.tab !== 'inbox') return;
  const list = document.getElementById('messages-conversation-list');
  const count = document.getElementById('messages-conversation-count');
  const threadPanel = document.querySelector('.messages-thread-panel');
  if (list) list.innerHTML = conversationListHtml();
  if (count) count.textContent = conversationCountLabel();
  if (threadPanel) threadPanel.innerHTML = threadHtml();
  restoreThreadScroll(threadScroll, previousScroll);
  restoreConversationListScroll(previousListScroll);
}

async function loadNextConversationPage() {
  if (
    !state.mounted
    || state.inboxLoadingMore
    || state.conversationNextCursor === null
  ) return;
  const cursor = state.conversationNextCursor;
  const inboxFilter = state.inboxFilter;
  const inboxRequestRevision = state.inboxRequestRevision;
  state.inboxLoadingMore = true;
  renderLocalInboxUpdate(snapshotThreadScroll());
  try {
    const page = await messagesApi.listConversations({
      needs_attention: inboxFilter,
      limit: CONVERSATION_PAGE_SIZE,
      cursor,
    });
    if (
      !state.mounted
      || inboxRequestRevision !== state.inboxRequestRevision
      || inboxFilter !== state.inboxFilter
      || cursor !== state.conversationNextCursor
    ) return;
    state.conversations = mergeConversationPages(
      state.conversations,
      listFrom(page),
      { conversationName },
    );
    state.conversationNextCursor = nextCursorFrom(page, cursor);
  } catch (error) {
    toastError(error?.message || 'Could not load more conversations');
  } finally {
    state.inboxLoadingMore = false;
    if (state.mounted && state.tab === 'inbox') {
      renderLocalInboxUpdate(snapshotThreadScroll());
    }
  }
}

async function refreshLocalCache() {
  if (!state.mounted || state.busy || document.hidden) return;
  const inboxFilter = state.inboxFilter;
  const selectedConversationId = conversationIdOf(state.conversation);
  const inboxRequestRevision = ++state.inboxRequestRevision;
  const requests = [
    messagesApi.status(),
    messagesApi.listConversations({
      needs_attention: inboxFilter,
      limit: CONVERSATION_PAGE_SIZE,
      cursor: 0,
    }),
    messagesApi.getAutomationStatus(),
    messagesApi.listDrafts({ limit: 100 }),
  ];
  const results = await Promise.allSettled(requests);
  if (!state.mounted) return;

  if (results[0]?.status === 'fulfilled') state.status = results[0].value;
  if (results[2]?.status === 'fulfilled') state.automationState = results[2].value;
  if (results[3]?.status === 'fulfilled') state.drafts = listFrom(results[3].value);
  if (
    results[1]?.status === 'fulfilled'
    && inboxRequestRevision === state.inboxRequestRevision
    && inboxFilter === state.inboxFilter
  ) {
    applyFirstConversationPage(results[1].value, {
      reset: inboxFilter !== '',
    });
  }

  const previousScroll = snapshotThreadScroll();
  const selectedSummary = listFrom(
    results[1]?.status === 'fulfilled' ? results[1].value : [],
  ).find(item => conversationIdOf(item) === selectedConversationId);
  if (
    selectedConversationId
    && selectedSummary
    && selectedConversationId === conversationIdOf(state.conversation)
    && conversationContentSignature(selectedSummary)
      !== conversationContentSignature(state.conversation)
  ) {
    try {
      state.conversation = await messagesApi.getConversation(selectedConversationId);
      await markConversationViewedHere(selectedConversationId);
    } catch {
      // The light status/list refresh still succeeded. A later tick can retry
      // the selected local detail without surfacing repetitive toast noise.
    }
  }
  renderStatus();
  renderLocalInboxUpdate(previousScroll);
}

function onMessagesVisibilityChange() {
  if (!document.hidden) {
    refreshLocalCache().catch(() => {});
  }
}

async function selectDraft(id) {
  state.draft = await messagesApi.getDraft(id);
  updateMessagesRoute();
  const conversationId = conversationIdOf(state.draft);
  if (conversationId && conversationId !== conversationIdOf(state.conversation)) {
    state.conversation = await messagesApi.getConversation(conversationId);
    state.visibleMessageLimit = INITIAL_VISIBLE_MESSAGE_LIMIT;
  }
  if (conversationId) {
    try {
      await markConversationViewedHere(conversationId);
    } catch (error) {
      toastError(error?.message || 'Could not update the local viewed status');
    }
  }
  updateMessagesRoute();
  renderQueue({ threadScroll: 'bottom' });
  try {
    const refreshed = await messagesApi.refreshDraftForReview(id);
    if (!refreshed?.draft || !refreshed?.conversation) {
      throw new Error('Etsy freshness check returned incomplete data');
    }
    state.draft = refreshed.draft;
    state.conversation = refreshed.conversation;
    state.visibleMessageLimit = INITIAL_VISIBLE_MESSAGE_LIMIT;
    state.drafts = listFrom(await messagesApi.listDrafts({ limit: 100 }));
    renderStatus();
    renderQueue({ threadScroll: 'bottom' });
    if (refreshed.freshness?.stale) {
      toastError(
        'This draft was removed because the Etsy conversation changed.',
      );
    }
  } catch (error) {
    toastError(error?.message || 'Could not verify this draft against Etsy');
  }
}

function collectPlaybook() {
  const original = state.playbookState.playbook;
  const scenarios = {};
  for (const [key, scenario] of Object.entries(original.scenarios)) {
    scenarios[key] = {
      ...scenario,
      enabled: document.querySelector(`[data-pb-scenario-enabled="${CSS.escape(key)}"]`)?.checked === true,
      instructions: document.querySelector(`[data-pb-scenario-instructions="${CSS.escape(key)}"]`)?.value || '',
    };
  }
  return {
    ...original,
    tone: {
      summary: document.getElementById('pb-tone')?.value || '',
      response_length: document.getElementById('pb-length')?.value || '',
      language_policy: document.getElementById('pb-language')?.value || '',
      signature: document.getElementById('pb-signature')?.value || '',
    },
    hard_rules: (document.getElementById('pb-rules')?.value || '').split('\n'),
    avoid_phrases: (document.getElementById('pb-avoid')?.value || '').split('\n'),
    scenarios,
  };
}

function collectAutomationPolicy() {
  const original = automationPolicyState().policy;
  const rules = [...document.querySelectorAll('[data-automation-rule]')].map((element, index) => {
    const field = name => element.querySelector(`[data-auto-field="${name}"]`);
    return {
      id: field('id')?.value || `rule_${index + 1}`,
      label: field('label')?.value || '',
      enabled: field('enabled')?.checked === true,
      event: field('event')?.value || 'new_message',
      scenario: field('scenario')?.value || 'freeform',
      delay_minutes: durationMinutes(element, 'delay_minutes', 43_200),
      cooldown_minutes: durationMinutes(element, 'cooldown_minutes', 10_080),
      require_order_context: field('require_order_context')?.checked === true,
      conditions: field('conditions')?.value || '',
      owner_notes: field('owner_notes')?.value || '',
    };
  });
  return {
    ...original,
    enabled: document.getElementById('messages-automation-enabled')?.checked === true,
    delivery_mode: 'draft_only',
    human_approval_required: true,
    rules,
  };
}

const ACTION_PROGRESS_LABELS = Object.freeze({
  'preview-conversation-draft': 'Refreshing conversation and preparing preview…',
  'generate-draft': 'Generating draft…',
  'save-manual-draft': 'Adding to approval queue…',
  'approve-draft': 'Refreshing Etsy, approving and sending…',
  'send-draft': 'Sending through Etsy…',
  'sync-history': 'Loading older history…',
  'save-automation-policy': 'Saving automation rules…',
});

function showActionFeedback(message, className = '') {
  const feedback = document.querySelector('.messages-action-feedback');
  if (!feedback) return;
  feedback.className = `messages-action-feedback ${className}`.trim();
  feedback.textContent = message || '';
}

function beginActionProgress(action, button) {
  const workspace = document.getElementById('messages-workspace');
  workspace?.setAttribute('aria-busy', 'true');
  const label = ACTION_PROGRESS_LABELS[action] || 'Working…';
  showActionFeedback(label, 'is-progress');
  if (!button) return null;
  const original = {
    html: button.innerHTML,
    disabled: button.disabled,
  };
  button.disabled = true;
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${escHtml(label)}`;
  return original;
}

function endActionProgress(button, original) {
  document.getElementById('messages-workspace')?.removeAttribute('aria-busy');
  if (!button?.isConnected || !original) return;
  button.innerHTML = original.html;
  button.disabled = original.disabled;
}

async function runAction(action, actionButton = null) {
  if (state.busy) return;
  state.busy = true;
  const progressState = beginActionProgress(action, actionButton);
  try {
    if (action === 'check-inbox') {
      const inboxFilter = state.inboxFilter;
      const inboxRequestRevision = ++state.inboxRequestRevision;
      const result = await messagesApi.syncInbox({
        needs_attention: inboxFilter,
        limit: CONVERSATION_PAGE_SIZE,
      });
      if (
        inboxRequestRevision === state.inboxRequestRevision
        && inboxFilter === state.inboxFilter
      ) {
        applyFirstConversationPage(result.conversations, { reset: true });
      }
      renderInbox();
      toastSuccess(`Conversation index refreshed: ${state.conversations.length} cached threads.`);
    } else if (action === 'reload-conversation') {
      await selectConversation(conversationIdOf(state.conversation));
    } else if (action === 'sync-history') {
      const result = await messagesApi.syncConversationHistory(conversationIdOf(state.conversation));
      const previousScroll = snapshotThreadScroll();
      state.conversation = result.conversation;
      state.conversations = state.conversations.map(conversation =>
        conversationIdOf(conversation) === conversationIdOf(state.conversation)
          ? { ...conversation, ...state.conversation }
          : conversation,
      );
      if (state.tab === 'queue') {
        renderQueue({ threadScroll: 'preserve-history', previousScroll });
      } else {
        renderInbox({ threadScroll: 'preserve-history', previousScroll });
      }
      toastSuccess('Older history loaded on demand and saved locally');
    } else if (action === 'preview-conversation-draft') {
      const resultBox = document.getElementById(
        'messages-conversation-preview-result',
      );
      if (resultBox) resultBox.textContent = 'Preparing a preview…';
      const result = await messagesApi.previewDraft({
        conversation_id: conversationIdOf(state.conversation),
        scenario: document.getElementById('messages-draft-scenario')?.value,
        owner_notes: document.getElementById('messages-owner-notes')?.value || '',
      });
      if (resultBox) {
        const warnings = listFrom(result.warnings);
        resultBox.innerHTML = result.status !== 'ready'
          ? `<strong>${result.status === 'no_action' ? 'No reply needed' : 'No suggestion created'}</strong><p>${escHtml(result.block_reason)}</p>`
          : `
            <strong>Preview only · not queued, approved, sent or notified</strong>
            <p>${escHtml(result.reply_body).replace(/\n/g, '<br>')}</p>
            ${result.rationale ? `<p><b>Why:</b> ${escHtml(result.rationale)}</p>` : ''}
            ${warnings.length ? `<p><b>Warnings:</b> ${warnings.map(item => escHtml(item)).join('; ')}</p>` : ''}`;
      }
    } else if (action === 'generate-draft') {
      const scenario = document.getElementById('messages-draft-scenario')?.value;
      const result = await messagesApi.generateDraft({
        conversation_id: conversationIdOf(state.conversation),
        scenario,
        owner_notes: document.getElementById('messages-owner-notes')?.value || '',
        client_request_id: crypto.randomUUID(),
      });
      toastSuccess('Draft added to approval queue');
      state.draft = result.draft;
      state.tab = 'queue';
      updateMessagesRoute();
      state.drafts = listFrom(await messagesApi.listDrafts({ limit: 100 }));
      renderStatus();
      renderActiveTab();
    } else if (action === 'save-manual-draft') {
      const body = document.getElementById('messages-manual-body')?.value || '';
      if (!body.trim()) throw new Error('Write the reply first');
      const result = await messagesApi.createManualDraft({
        conversation_id: conversationIdOf(state.conversation),
        scenario: document.getElementById('messages-draft-scenario')?.value || 'freeform',
        body,
        client_request_id: crypto.randomUUID(),
      });
      toastSuccess('Manual draft added to approval queue');
      state.draft = result;
      state.tab = 'queue';
      updateMessagesRoute();
      state.drafts = listFrom(await messagesApi.listDrafts({ limit: 100 }));
      renderStatus();
      renderActiveTab();
    } else if (action === 'approve-draft') {
      const body = document.getElementById('messages-review-body')?.value || '';
      if (!body.trim()) throw new Error('Write the exact reply first');
      if (!window.confirm(
        `Approve this exact text and send it now to ${conversationName(state.draft)}?`,
      )) return;
      const result = await messagesApi.approveAndSendDraft(
        draftIdOf(state.draft),
        body,
        crypto.randomUUID(),
      );
      state.draft = result.draft;
      state.drafts = listFrom(await messagesApi.listDrafts({ limit: 100 }));
      renderStatus();
      renderQueue();
      if (result.outcome === 'SENT') {
        toastSuccess(
          result.idempotent_replay
            ? 'This exact message was already sent. No second attempt was made.'
            : 'Bridge confirms that the approved message was sent.',
        );
        showActionFeedback(
          result.idempotent_replay
            ? 'Already sent · no duplicate delivery attempt'
            : 'Message sent successfully',
          'is-success',
        );
      } else {
        const warning = 'Delivery result unknown. Check Etsy before doing anything else; this message will not be retried automatically.';
        showActionFeedback(warning, 'is-error');
        toastError(warning);
      }
    } else if (action === 'send-draft') {
      if (isReserve() && !reserveTestSendAvailable(state.draft)) {
        throw new Error('Sending is blocked while the reserve/test account is connected');
      }
      const prefix = isReserve()
        ? 'Consume the one-shot reserve test and send'
        : 'Send';
      if (!window.confirm(`${prefix} this approved message now to ${conversationName(state.draft)}?`)) return;
      state.draft = await messagesApi.sendApprovedDraft(draftIdOf(state.draft));
      toastSuccess('Bridge reports that the approved message was sent');
      state.drafts = listFrom(await messagesApi.listDrafts({ limit: 100 }));
      renderStatus();
      renderQueue();
    } else if (action === 'skip-draft') {
      const reason = window.prompt('Optional reason for skipping this draft:', '') ?? null;
      if (reason === null) return;
      state.draft = await messagesApi.skipDraft(draftIdOf(state.draft), reason);
      toastSuccess('Draft skipped');
      state.drafts = listFrom(await messagesApi.listDrafts({ limit: 100 }));
      renderStatus();
      renderQueue();
    } else if (action === 'block-draft') {
      const reason = window.prompt('Why should this entire conversation be blocked from future drafts?');
      if (!reason?.trim()) return;
      if (!window.confirm('Block this conversation? New drafts will be rejected until an operator changes the block in Bridge.')) return;
      state.draft = await messagesApi.blockDraft(draftIdOf(state.draft), reason);
      toastSuccess('Conversation blocked');
      state.drafts = listFrom(await messagesApi.listDrafts({ limit: 100 }));
      renderStatus();
      renderQueue();
    } else if (action === 'add-automation-rule') {
      const policyState = automationPolicyState();
      const policy = collectAutomationPolicy();
      policy.rules.push({
        id: `rule_${crypto.randomUUID()}`,
        label: 'New draft suggestion rule',
        enabled: false,
        event: 'new_message',
        scenario: 'freeform',
        delay_minutes: 0,
        cooldown_minutes: 60,
        require_order_context: false,
        conditions: '',
        owner_notes: '',
      });
      state.automationState = {
        ...state.automationState,
        policy: {
          ...policyState,
          policy,
        },
      };
      renderAutomation();
    } else if (action === 'save-automation-policy') {
      const policyState = automationPolicyState();
      const policy = collectAutomationPolicy();
      await messagesApi.saveAutomationPolicy(policy, policyState.revision);
      state.automationState = await messagesApi.getAutomationStatus();
      toastSuccess('Automation rules saved. Future matching events will use this revision.');
      renderStatus();
      renderAutomation();
    } else if (action === 'save-playbook') {
      const playbook = collectPlaybook();
      state.playbookState = await messagesApi.savePlaybook(
        playbook,
        state.playbookState.revision,
      );
      toastSuccess(`Agent Playbook revision ${state.playbookState.revision} saved`);
      renderPlaybook();
    } else if (action === 'add-example') {
      const playbook = collectPlaybook();
      const customer = document.getElementById('pb-example-customer')?.value || '';
      const reply = document.getElementById('pb-example-reply')?.value || '';
      if (!customer.trim() || !reply.trim()) throw new Error('Customer message and ideal reply are required');
      playbook.examples.push({
        id: crypto.randomUUID(),
        scenario: document.getElementById('pb-example-scenario')?.value || 'freeform',
        customer_message: customer,
        ideal_reply: reply,
        notes: document.getElementById('pb-example-notes')?.value || '',
        context: '',
      });
      state.playbookState.playbook = playbook;
      renderPlaybook();
      toastSuccess('Example added locally. Save the Playbook to publish the new revision.');
    } else if (action === 'preview-playbook') {
      const resultBox = document.getElementById('pb-preview-result');
      if (resultBox) resultBox.textContent = 'Drafting preview…';
      const result = await messagesApi.previewDraft({
        scenario: document.getElementById('pb-preview-scenario')?.value,
        customer_message: document.getElementById('pb-preview-customer')?.value || '',
        owner_notes: document.getElementById('pb-preview-notes')?.value || '',
      });
      if (resultBox) {
        resultBox.innerHTML = result.status !== 'ready'
          ? `<strong>${result.status === 'no_action' ? 'No reply needed' : 'Blocked safely'}</strong><p>${escHtml(result.block_reason)}</p>`
          : `<strong>Preview only · not queued or sent</strong><p>${escHtml(result.reply_body).replace(/\n/g, '<br>')}</p>`;
      }
    }
  } catch (error) {
    const message = error?.message || 'Messages action failed';
    showActionFeedback(`Error: ${message}`, 'is-error');
    toastError(message);
  } finally {
    state.busy = false;
    endActionProgress(actionButton, progressState);
  }
}

function onClick(event) {
  const locale = event.target.closest('[data-message-locale]');
  if (locale) {
    const nextLocale = locale.dataset.messageLocale;
    if (['uk', 'en'].includes(nextLocale) && nextLocale !== state.locale) {
      preserveVisibleEditor();
      state.locale = nextLocale;
      saveMessagesLocale(nextLocale);
      renderShell(state.container);
      renderStatus();
      renderActiveTab();
      updateMessagesRoute();
    }
    return;
  }
  const showOlder = event.target.closest('[data-message-show-older]');
  if (showOlder) {
    const previousScroll = snapshotThreadScroll();
    state.visibleMessageLimit += 100;
    if (state.tab === 'queue') {
      renderQueue({ threadScroll: 'preserve-history', previousScroll });
    } else {
      renderInbox({ threadScroll: 'preserve-history', previousScroll });
    }
    return;
  }
  const tab = event.target.closest('[data-message-tab]');
  if (tab) {
    preserveVisibleEditor();
    state.tab = tab.dataset.messageTab;
    updateMessagesRoute();
    renderActiveTab();
    return;
  }
  const conversation = event.target.closest('[data-conversation-id]');
  if (conversation) {
    selectConversation(conversation.dataset.conversationId).catch(error => toastError(error.message));
    return;
  }
  const draft = event.target.closest('[data-draft-id]');
  if (draft) {
    selectDraft(draft.dataset.draftId).catch(error => toastError(error.message));
    return;
  }
  const triggerDraft = event.target.closest('[data-trigger-draft-id]');
  if (triggerDraft) {
    state.tab = 'queue';
    selectDraft(triggerDraft.dataset.triggerDraftId)
      .then(() => renderStatus())
      .catch(error => toastError(error.message));
    return;
  }
  const removeAutomationRule = event.target.closest('[data-remove-automation-rule]');
  if (removeAutomationRule) {
    const policyState = automationPolicyState();
    const policy = collectAutomationPolicy();
    policy.rules.splice(Number(removeAutomationRule.dataset.removeAutomationRule), 1);
    state.automationState = {
      ...state.automationState,
      policy: {
        ...policyState,
        policy,
      },
    };
    renderAutomation();
    toastSuccess('Rule removed locally. Save automation rules to publish the change.');
    return;
  }
  const remove = event.target.closest('[data-remove-example]');
  if (remove) {
    const playbook = collectPlaybook();
    playbook.examples.splice(Number(remove.dataset.removeExample), 1);
    state.playbookState.playbook = playbook;
    renderPlaybook();
    toastSuccess('Example removed locally. Save the Playbook to publish the revision.');
    return;
  }
  const action = event.target.closest('[data-message-action]');
  if (action) runAction(action.dataset.messageAction, action);
}

function onChange(event) {
  if (event.target.id === 'messages-inbox-filter') {
    state.inboxFilter = event.target.value;
    const inboxFilter = state.inboxFilter;
    const inboxRequestRevision = ++state.inboxRequestRevision;
    messagesApi.listConversations({
      needs_attention: inboxFilter,
      limit: CONVERSATION_PAGE_SIZE,
      cursor: 0,
    }).then(result => {
      if (
        inboxRequestRevision !== state.inboxRequestRevision
        || inboxFilter !== state.inboxFilter
      ) return;
      applyFirstConversationPage(result, { reset: true });
      renderInbox();
    }).catch(error => toastError(error.message));
  }
  if (event.target.id === 'messages-draft-filter') {
    state.draftFilter = event.target.value;
    renderQueue();
  }
}

function onScroll(event) {
  if (event.target.id !== 'messages-conversation-list') return;
  const list = event.target;
  if (list.scrollHeight - list.clientHeight - list.scrollTop > 180) return;
  loadNextConversationPage().catch(() => {});
}

function onAttachmentError(event) {
  if (!event.target.matches?.('[data-message-attachment-image]')) return;
  event.target.closest('.messages-attachment-preview')?.classList.add('is-broken');
}

export async function renderMessages(container, params = {}) {
  if (localRefreshTimer !== null) {
    window.clearInterval(localRefreshTimer);
    localRefreshTimer = null;
  }
  state.mounted = true;
  state.container = container;
  state.locale = readMessagesLocale(params);
  saveMessagesLocale(state.locale);
  const requestedTab = String(params?.tab || '').trim();
  const requestedDraftId = String(params?.draft_id || '').trim();
  const requestedConversationId = String(params?.conversation_id || '').trim();
  state.tab = /^\d+$/.test(requestedDraftId)
    ? 'queue'
    : ['inbox', 'queue', 'automation', 'playbook', 'guide'].includes(
    requestedTab,
  ) ? requestedTab : 'inbox';
  state.status = null;
  state.conversations = [];
  state.drafts = [];
  state.playbookState = null;
  state.automationState = null;
  state.conversation = null;
  state.draft = null;
  state.inboxFilter = '';
  state.draftFilter = '';
  state.inboxRequestRevision = 0;
  state.conversationNextCursor = null;
  state.inboxLoadingMore = false;
  state.visibleMessageLimit = INITIAL_VISIBLE_MESSAGE_LIMIT;
  renderShell(container);
  updateMessagesRoute();
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  container.addEventListener('error', onAttachmentError, true);
  container.addEventListener('scroll', onScroll, true);
  document.addEventListener('visibilitychange', onMessagesVisibilityChange);
  window.__pageCleanup = () => {
    state.mounted = false;
    state.container = null;
    if (localRefreshTimer !== null) {
      window.clearInterval(localRefreshTimer);
      localRefreshTimer = null;
    }
    container.removeEventListener('click', onClick);
    container.removeEventListener('change', onChange);
    container.removeEventListener('error', onAttachmentError, true);
    container.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('visibilitychange', onMessagesVisibilityChange);
  };
  await loadAll();
  if (state.mounted && state.tab === 'queue' && /^\d+$/.test(requestedDraftId)) {
    try {
      await selectDraft(requestedDraftId);
    } catch (error) {
      toastError(error?.message || 'Could not open the requested draft');
    }
  } else if (
    state.mounted
    && state.tab === 'inbox'
    && /^\d+$/.test(requestedConversationId)
  ) {
    try {
      await selectConversation(requestedConversationId);
    } catch (error) {
      toastError(error?.message || 'Could not open the requested conversation');
    }
  }
  if (state.mounted) {
    localRefreshTimer = window.setInterval(() => {
      refreshLocalCache().catch(() => {});
    }, LOCAL_CACHE_REFRESH_MS);
  }
}
