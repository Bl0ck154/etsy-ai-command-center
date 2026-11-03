// api/_utils.js — Shared utilities used by multiple API modules

/**
 * Parse JSON from LLM output that may contain markdown fences or trailing text.
 */
export function parseJsonish(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cleaned = (fenced ? fenced[1] : raw).trim();
  try { return JSON.parse(cleaned); } catch {}
  const obj = cleaned.match(/\{[\s\S]*\}/);
  if (obj) try { return JSON.parse(obj[0]); } catch {}
  return null;
}
