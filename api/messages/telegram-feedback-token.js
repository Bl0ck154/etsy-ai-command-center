import crypto from 'node:crypto';

const CALLBACK_PREFIX = 'ml1';
const MIN_SECRET_BYTES = 32;
const MAX_SHOP_ID_LENGTH = 20;
const MAX_DRAFT_ID_LENGTH = 40;
const SIGNATURE_BYTES = 12;

const ACTION_CODES = Object.freeze({
  helpful: 'h',
  unhelpful: 'n',
});

const ACTION_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(ACTION_CODES).map(([name, code]) => [code, name])),
);

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function signingSecret() {
  const secret = cleanText(process.env.MESSAGE_TELEGRAM_FEEDBACK_SIGNING_SECRET, 1_000);
  return Buffer.byteLength(secret, 'utf8') >= MIN_SECRET_BYTES ? secret : '';
}

function safeEqual(left, right) {
  const actual = Buffer.from(String(left || ''), 'utf8');
  const expected = Buffer.from(String(right || ''), 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString('base64url');
}

export function messageTelegramFeedbackEnabled() {
  return /^(1|true|yes|on)$/i.test(
    cleanText(process.env.MESSAGE_TELEGRAM_FEEDBACK_ENABLED, 20),
  ) && /^(1|true|yes|on)$/i.test(
    cleanText(process.env.MESSAGE_LEARNING_CAPTURE_ENABLED, 20),
  );
}

export function createMessageTelegramFeedbackToken({ shopId, draftId, feedback } = {}) {
  if (!messageTelegramFeedbackEnabled()) return '';
  const normalizedShopId = cleanText(shopId, MAX_SHOP_ID_LENGTH + 1);
  const id = cleanText(draftId, MAX_DRAFT_ID_LENGTH + 1);
  const code = ACTION_CODES[feedback];
  const secret = signingSecret();
  if (
    !secret
    || !code
    || !/^\d{1,20}$/.test(normalizedShopId)
    || !/^\d{1,40}$/.test(id)
  ) return '';

  const unsigned = `${CALLBACK_PREFIX}.${code}.${normalizedShopId}.${id}`;
  const token = `${unsigned}.${signature(unsigned, secret)}`;
  return Buffer.byteLength(token, 'utf8') <= 64 ? token : '';
}

export function verifyMessageTelegramFeedbackToken(token) {
  if (!messageTelegramFeedbackEnabled()) return null;
  const secret = signingSecret();
  if (!secret) return null;

  const value = cleanText(token, 65);
  const match = /^ml1\.([hn])\.(\d{1,20})\.(\d{1,40})\.([A-Za-z0-9_-]{16})$/.exec(value);
  if (!match) return null;

  const [, code, shopId, draftId, actualSignature] = match;
  const unsigned = `${CALLBACK_PREFIX}.${code}.${shopId}.${draftId}`;
  const expectedSignature = signature(unsigned, secret);
  if (!safeEqual(actualSignature, expectedSignature)) return null;

  return {
    shop_id: shopId,
    draft_id: draftId,
    feedback: ACTION_NAMES[code],
  };
}
