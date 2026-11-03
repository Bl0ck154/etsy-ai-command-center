export const ETSY_GUIDANCE_RULE_GROUPS = Object.freeze(['title', 'discovery', 'description', 'photos']);

const FORBIDDEN_RULE_TEXT = /guarantee(?:d|s)?|secret algorithm|ranking formula|top[- ]?1|100%|prompt injection|ignore (?:all|previous)|system message/i;

export function normalizeEtsyGuidanceRule(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 420);
}

export function normalizeEtsyGuidanceRules(input = {}) {
  return Object.fromEntries(ETSY_GUIDANCE_RULE_GROUPS.map(group => [
    group,
    (Array.isArray(input?.[group]) ? input[group] : [])
      .map(normalizeEtsyGuidanceRule)
      .filter(Boolean)
      .slice(0, 8),
  ]));
}

export function validateEtsyGuidanceRules(input = {}) {
  const rules = normalizeEtsyGuidanceRules(input);
  for (const group of ETSY_GUIDANCE_RULE_GROUPS) {
    if (rules[group].length < 2) throw new Error(`Etsy guidance candidate is missing ${group} rules`);
    for (const rule of rules[group]) {
      if (rule.length < 20) throw new Error(`Etsy guidance ${group} rule is too short`);
      if (FORBIDDEN_RULE_TEXT.test(rule)) throw new Error(`Etsy guidance ${group} rule contains an unsafe or unsupported claim`);
      if (/https?:\/\//i.test(rule)) throw new Error(`Etsy guidance ${group} rules cannot introduce URLs`);
    }
  }
  return rules;
}
