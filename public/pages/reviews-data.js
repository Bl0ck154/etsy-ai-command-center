const SELLER_REPLY_FIELDS = ['seller_response', 'seller_reply', 'shop_response', 'shop_reply'];

function cleanHttpUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

export function reviewMediaUrls(review = {}) {
  const nested = [...(Array.isArray(review.images) ? review.images : []), ...(Array.isArray(review.attachments) ? review.attachments : [])];
  const candidates = [
    review.image_url_fullxfull,
    review.review_image_url,
    review.image_url,
    ...nested.flatMap(item => typeof item === 'string'
      ? [item]
      : [item?.image_url_fullxfull, item?.url_fullxfull, item?.image_url, item?.url, item?.src]),
  ];
  return [...new Set(candidates.map(cleanHttpUrl).filter(Boolean))];
}

function sellerReplyField(review = {}) {
  return SELLER_REPLY_FIELDS.find(field => Object.prototype.hasOwnProperty.call(review, field)) || '';
}

export function reviewSellerReply(review = {}) {
  const field = sellerReplyField(review);
  if (!field) return '';
  const value = review[field];
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return String(value.text || value.reply || value.message || value.content || '').trim();
}

export function reviewResponseStatus(review = {}, manuallyResponded = new Set()) {
  const authoritativeField = sellerReplyField(review);
  if (authoritativeField) {
    const text = reviewSellerReply(review);
    const raw = review[authoritativeField];
    const responded = Boolean(text || raw?.responded === true || raw?.has_response === true);
    return { known: true, responded, source: 'etsy', text };
  }
  const responded = manuallyResponded.has(Number(review.transaction_id));
  return { known: responded, responded, source: responded ? 'manual' : 'unknown', text: '' };
}

export function reviewResponseSummary(reviews = [], manuallyResponded = new Set()) {
  const statuses = reviews.map(review => reviewResponseStatus(review, manuallyResponded));
  const authoritative = statuses.filter(status => status.source === 'etsy').length;
  const authoritativeResponded = statuses.filter(status => status.source === 'etsy' && status.responded).length;
  const manualResponded = statuses.filter(status => status.source === 'manual' && status.responded).length;
  const responded = authoritativeResponded + manualResponded;
  const known = statuses.filter(status => status.known).length;
  return { total: reviews.length, authoritative, authoritativeResponded, manualResponded, responded, known, unknown: Math.max(0, reviews.length - known) };
}
