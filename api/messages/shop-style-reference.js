import { bridgeQuery } from './bridge-client.js';

const CACHE = new Map();
const PAGE_LIMIT = 2_000;

function cleanText(value, maxLength = 2_000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalize(value) {
  return cleanText(value, 2_000).toLowerCase().replace(/\s+/g, ' ').trim();
}

function configuredTtlMs() {
  const seconds = Number.parseInt(process.env.MESSAGE_STYLE_PROFILE_TTL_SECONDS, 10);
  return Math.max(300, Math.min(Number.isFinite(seconds) ? seconds : 900, 86_400)) * 1_000;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function rate(messages, predicate) {
  if (!messages.length) return 0;
  return Number((messages.filter(predicate).length / messages.length).toFixed(3));
}

function extractEmojis(value) {
  return String(value || '').match(/\p{Extended_Pictographic}/gu) || [];
}

function opening(value) {
  const text = cleanText(value, 300).replace(/\s+/g, ' ');
  if (!text) return '';
  const firstClause = text.split(/[.!?\n]/, 1)[0].trim();
  return firstClause.split(/\s+/).slice(0, 5).join(' ').slice(0, 80);
}

function closing(value) {
  const text = cleanText(value, 500).replace(/\s+/g, ' ');
  if (!text) return '';
  const parts = text.split(/[.!?]+/).map(part => part.trim()).filter(Boolean);
  const last = parts.at(-1) || text;
  return last.split(/\s+/).slice(-7).join(' ').slice(0, 100);
}

function topValues(values, maxItems = 12) {
  const counts = new Map();
  for (const raw of values) {
    const value = cleanText(raw, 120);
    if (!value) continue;
    const key = value.toLowerCase();
    const current = counts.get(key) || { value, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, maxItems);
}

function evenlySample(items, count) {
  if (items.length <= count) return [...items];
  const sampled = [];
  for (let index = 0; index < count; index += 1) {
    const position = Math.round(index * (items.length - 1) / Math.max(1, count - 1));
    sampled.push(items[position]);
  }
  return sampled;
}

function representativeExamples(messages) {
  const unique = [];
  const seen = new Set();
  for (const message of messages) {
    const key = normalize(message.body);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(message);
  }

  const recent = unique.slice(-32);
  const acrossHistory = evenlySample(unique, 48);
  const selected = [];
  const selectedKeys = new Set();
  for (const message of [...acrossHistory, ...recent]) {
    const key = normalize(message.body);
    if (!key || selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    selected.push({
      sent_at: cleanText(message.sent_at, 80) || null,
      conversation_id: cleanText(message.conversation_source_id, 120) || null,
      body: cleanText(message.body, 700),
    });
  }
  return selected.slice(-80);
}

function recurringReplies(messages) {
  const byBody = new Map();
  for (const message of messages) {
    const key = normalize(message.body);
    if (!key) continue;
    const current = byBody.get(key) || { body: cleanText(message.body, 500), count: 0 };
    current.count += 1;
    byBody.set(key, current);
  }
  return [...byBody.values()]
    .filter(item => item.count >= 2)
    .sort((a, b) => b.count - a.count || a.body.localeCompare(b.body))
    .slice(0, 20);
}

export function buildShopSellerStyleReference(rawMessages = []) {
  const messages = (Array.isArray(rawMessages) ? rawMessages : [])
    .map(message => ({
      source_id: cleanText(message?.source_id, 160),
      conversation_source_id: cleanText(message?.conversation_source_id, 160),
      sent_at: cleanText(message?.sent_at, 80) || null,
      body: cleanText(message?.body, 2_000),
    }))
    .filter(message => message.body);

  if (!messages.length) {
    return {
      available: false,
      scope: 'shop_wide_cached_outgoing',
      corpus_message_count: 0,
      unique_message_count: 0,
      conversation_count: 0,
      priority: 'none',
      profile: {},
      recurring_replies: [],
      examples: [],
    };
  }

  const normalizedUnique = new Set(messages.map(message => normalize(message.body)));
  const lengths = messages.map(message => message.body.length).sort((a, b) => a - b);
  const emojiCounts = new Map();
  for (const message of messages) {
    for (const emoji of extractEmojis(message.body)) {
      emojiCounts.set(emoji, (emojiCounts.get(emoji) || 0) + 1);
    }
  }
  const topEmojis = [...emojiCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([emoji, count]) => ({ emoji, count }));

  const firstTimestamp = messages.map(message => Date.parse(message.sent_at || '')).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const lastTimestamp = messages.map(message => Date.parse(message.sent_at || '')).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const avgChars = Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length);

  return {
    available: true,
    scope: 'shop_wide_cached_outgoing',
    corpus_message_count: messages.length,
    unique_message_count: normalizedUnique.size,
    conversation_count: new Set(messages.map(message => message.conversation_source_id).filter(Boolean)).size,
    priority: messages.length >= 20 ? 'strong' : messages.length >= 3 ? 'medium' : 'light',
    corpus_first_at: Number.isFinite(firstTimestamp) ? new Date(firstTimestamp).toISOString() : null,
    corpus_last_at: Number.isFinite(lastTimestamp) ? new Date(lastTimestamp).toISOString() : null,
    profile: {
      average_chars: avgChars,
      median_chars: percentile(lengths, 0.5),
      p90_chars: percentile(lengths, 0.9),
      emoji_message_rate: rate(messages, message => extractEmojis(message.body).length > 0),
      exclamation_message_rate: rate(messages, message => message.body.includes('!')),
      question_message_rate: rate(messages, message => message.body.includes('?')),
      multiline_message_rate: rate(messages, message => /\n/.test(message.body)),
      contraction_message_rate: rate(messages, message => /\b(?:i['’]m|i['’]ll|i['’]ve|we['’]re|we['’]ll|we['’]ve|can['’]t|don['’]t|won['’]t|it['’]s|that['’]s)\b/i.test(message.body)),
      first_person_i_rate: rate(messages, message => /\bI\b/.test(message.body)),
      first_person_we_rate: rate(messages, message => /\bwe\b/i.test(message.body)),
      greeting_message_rate: rate(messages, message => /^(?:hi|hello|hey|good morning|good afternoon|good evening)\b/i.test(message.body.trim())),
      thanks_message_rate: rate(messages, message => /\b(?:thank you|thanks|thank u)\b/i.test(message.body)),
      top_emojis: topEmojis,
      common_openings: topValues(messages.map(message => opening(message.body))),
      common_closings: topValues(messages.map(message => closing(message.body))),
    },
    recurring_replies: recurringReplies(messages),
    examples: representativeExamples(messages),
  };
}

async function fetchAllShopOutgoingMessages(fetchPage = bridgeQuery) {
  const messages = [];
  let cursor = 0;
  const seenCursors = new Set();
  while (!seenCursors.has(cursor)) {
    seenCursors.add(cursor);
    const page = await fetchPage('/v1/style/outgoing-messages', {
      limit: PAGE_LIMIT,
      cursor,
    });
    const items = Array.isArray(page?.items) ? page.items : [];
    messages.push(...items);
    if (page?.next_cursor === null || page?.next_cursor === undefined || !items.length) break;
    const nextCursor = Number(page.next_cursor);
    if (!Number.isFinite(nextCursor) || nextCursor <= cursor) break;
    cursor = nextCursor;
  }
  return messages;
}

export async function loadShopSellerStyleReference(shopId, options = {}) {
  const key = cleanText(shopId, 120) || 'default';
  const nowMs = Number(options.nowMs ?? Date.now());
  const existing = CACHE.get(key);
  if (!options.forceRefresh && existing?.value && existing.expires_at > nowMs) {
    return existing.value;
  }
  if (existing?.promise) return existing.promise;

  const fetchPage = options.fetchPage || bridgeQuery;
  const promise = (async () => {
    try {
      const messages = await fetchAllShopOutgoingMessages(fetchPage);
      const value = buildShopSellerStyleReference(messages);
      CACHE.set(key, {
        value,
        expires_at: nowMs + configuredTtlMs(),
        promise: null,
      });
      return value;
    } catch (error) {
      const value = existing?.value || {
        available: false,
        scope: 'shop_wide_cached_outgoing',
        corpus_message_count: 0,
        unique_message_count: 0,
        conversation_count: 0,
        priority: 'none',
        profile: {},
        recurring_replies: [],
        examples: [],
        unavailable_reason: cleanText(error?.code || error?.message || 'style corpus unavailable', 200),
      };
      CACHE.set(key, {
        value,
        expires_at: nowMs + 300_000,
        promise: null,
      });
      return value;
    }
  })();
  CACHE.set(key, {
    value: existing?.value || null,
    expires_at: existing?.expires_at || 0,
    promise,
  });
  return promise;
}

export function clearShopSellerStyleReferenceCache() {
  CACHE.clear();
}
