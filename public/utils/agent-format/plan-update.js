const PLAN_FIELD_LABELS = {
  title: 'Title',
  description: 'Description',
  tags: 'Tags',
  price: 'Price',
  should_auto_renew: 'Auto-renew',
  personalization_questions: 'Personalization questions',
  personalization: 'Personalization questions',
};

export function normalizePlanUpdate(update) {
  const normalized = { ...(update || {}) };
  const nestedQuestions = normalized.personalization?.personalization_questions;
  if (normalized.personalization_questions === undefined && Array.isArray(nestedQuestions)) {
    normalized.personalization_questions = nestedQuestions;
  }
  delete normalized.personalization;
  return normalized;
}

export function isPlanDisplayMetaField(field) {
  return ['listing_id', 'listing_title', 'image_url', 'listing_image_url', 'source_image_url', 'state', 'listing_state', 'etsy_url', 'url', 'current_values'].includes(field)
    || String(field || '').endsWith('_current');
}

export function listingWriteFields(update) {
  const normalized = normalizePlanUpdate(update);
  const current = normalized.current_values || {};
  return Object.fromEntries(Object.entries(normalized).filter(([field, value]) => (
    !isPlanDisplayMetaField(field) && !valuesEqualForPlan(field, current[field], value)
  )));
}

export function getPlanUpdateFields(update) {
  return getPlanUpdateChangeDetails(update).map(change => change.label);
}

export function shortValue(value, max = 220) {
  const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  return text.length > max ? text.slice(0, max).trim() + '...' : text;
}

function normalizeComparable(value, field) {
  if (value === undefined) return undefined;
  if (field === 'price') {
    if (value && typeof value === 'object' && value.amount !== undefined) {
      return Number(value.amount) / Number(value.divisor || 100);
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (Array.isArray(value)) return value.map(item => normalizeComparable(item, field));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, normalizeComparable(nested, field)]),
    );
  }
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
}

export function valuesEqualForPlan(field, before, after) {
  if (before === undefined) return false;
  return JSON.stringify(normalizeComparable(before, field)) === JSON.stringify(normalizeComparable(after, field));
}

function describeQuestion(question, index) {
  const type = question.question_type === 'file_upload'
    ? 'file upload'
    : (question.question_type || 'text_input').replace(/_/g, ' ');
  const bits = [`${index + 1}. ${question.question_text || 'Personalization'} (${type})`];
  if (question.question_type === 'dropdown' && question.options?.length) {
    bits.push(`options: ${question.options.map(option => option.label || String(option)).join(', ')}`);
  }
  if (question.question_type === 'file_upload') {
    bits.push(`max files: ${question.max_allowed_files || 10}`);
    if (question.options?.length) {
      bits.push(`labels: ${question.options.map(option => option.label || String(option)).join(', ')}`);
    }
  }
  bits.push(question.required ? 'required' : 'optional');
  return bits.join(' | ');
}

export function formatPlanValue(value, field) {
  if (value === undefined || value === null || value === '') return 'Not set';
  if (field === 'price') {
    const n = Number(
      value && typeof value === 'object' && value.amount !== undefined
        ? value.amount / (value.divisor || 100)
        : value,
    );
    return Number.isFinite(n) ? `$${n.toFixed(2).replace(/\.00$/, '')}` : String(value);
  }
  if (field === 'should_auto_renew') return value ? 'On' : 'Off';
  if (field === 'personalization_questions') {
    const questions = Array.isArray(value) ? value : [];
    if (!questions.length) return 'No personalization questions';
    return questions.map((question, index) => describeQuestion(question, index)).join('\n');
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export function getPlanUpdateDetails(update) {
  return getPlanUpdateChangeDetails(update)
    .map(change => `${change.label} -> ${shortValue(formatPlanValue(change.after, change.field), change.field === 'description' ? 260 : 180)}`);
}

export function getPlanUpdateChangeDetails(update) {
  const normalized = normalizePlanUpdate(update);
  const current = normalized.current_values || {};
  return Object.keys(normalized)
    .filter(field => !isPlanDisplayMetaField(field) && normalized[field] !== undefined)
    .map(field => {
      const before = current[field];
      const after = normalized[field];
      return {
        field,
        label: PLAN_FIELD_LABELS[field] || field.replace(/_/g, ' '),
        before,
        after,
        changed: !valuesEqualForPlan(field, before, after),
      };
    })
    .filter(change => change.changed);
}
