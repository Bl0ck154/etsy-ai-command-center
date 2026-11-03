import { createPersonalizationQuestion } from './create-personalization-model.js';

export function readPersonalizationQuestions(cards = [], fallbackQuestions = []) {
  const normalizedCards = [...cards];
  if (!normalizedCards.length) return fallbackQuestions;
  return normalizedCards.map(card => {
    const type = card.querySelector('[data-pq-field="question_type"]')?.value || 'text_input';
    const optionsField = type === 'file_upload' ? 'file_labels' : 'options';
    const optionsRaw = card.querySelector(`[data-pq-field="${optionsField}"]`)?.value || '';
    return createPersonalizationQuestion({
      question_type: type,
      question_text: card.querySelector('[data-pq-field="question_text"]')?.value?.trim() || 'Personalization',
      instructions: card.querySelector('[data-pq-field="instructions"]')?.value?.trim() || '',
      required: card.querySelector('[data-pq-field="required"]')?.classList.contains('on') === true,
      max_allowed_characters: Math.min(1024, Math.max(1, parseInt(card.querySelector('[data-pq-field="max_allowed_characters"]')?.value || '1024', 10))),
      max_allowed_files: Math.min(10, Math.max(1, parseInt(card.querySelector('[data-pq-field="max_allowed_files"]')?.value || '10', 10))),
      labeled_upload: card.querySelector('[data-pq-field="labeled_upload"]')?.classList.contains('on') === true,
      options: optionsRaw.split('\n').map(value => value.trim()).filter(Boolean).map(label => ({ label })),
    });
  });
}
