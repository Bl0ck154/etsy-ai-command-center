import { stripMarkdownForEtsy } from './plain-text.js';
import {
  sanitizeEtsyMaterials,
  sanitizeEtsyTags,
  sanitizeEtsyTitle,
} from './field-sanitizers.js';

export function sanitizeListingAiResult(result) {
  if (!result || typeof result !== 'object') return result;
  const clean = { ...result };
  if (clean.title !== undefined) clean.title = sanitizeEtsyTitle(clean.title);
  if (clean.description !== undefined) clean.description = stripMarkdownForEtsy(clean.description);
  if (Array.isArray(clean.tags)) clean.tags = sanitizeEtsyTags(clean.tags);
  if (Array.isArray(clean.materials)) clean.materials = sanitizeEtsyMaterials(clean.materials);
  if (clean.personalization_instructions !== undefined) clean.personalization_instructions = stripMarkdownForEtsy(clean.personalization_instructions);
  if (Array.isArray(clean.personalization_questions)) {
    clean.personalization_questions = clean.personalization_questions.map(q => ({
      ...q,
      ...(q.question_text !== undefined ? { question_text: stripMarkdownForEtsy(q.question_text).replace(/\s+/g, ' ').trim() } : {}),
      ...(q.instructions !== undefined ? { instructions: stripMarkdownForEtsy(q.instructions) } : {}),
      ...(Array.isArray(q.options) ? { options: q.options.map(o => typeof o === 'string' ? stripMarkdownForEtsy(o).replace(/\s+/g, ' ').trim() : o) } : {}),
    }));
  }
  return clean;
}
