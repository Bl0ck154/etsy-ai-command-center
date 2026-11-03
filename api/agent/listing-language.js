// api/agent/listing-language.js — pure listing-language helpers shared by Agent planning and vision

import { clampEtsyTitle } from '../_listing-body.js';

export function hasCyrillic(text = '') {
  return /[А-Яа-яЁёІіЇїЄєҐґ]/.test(String(text || ''));
}

export function listingContentHasCyrillic(plan = {}) {
  return ['title', 'description'].some(field => hasCyrillic(plan[field]))
    || (Array.isArray(plan.tags) && plan.tags.some(tag => hasCyrillic(tag)))
    || (Array.isArray(plan.personalization_questions) && plan.personalization_questions.some(q => hasCyrillic(q.question_text) || hasCyrillic(q.instructions) || (q.options || []).some(o => hasCyrillic(o.label || o))));
}

export function fallbackEnglishDuplicateTitle(dup = {}) {
  return clampEtsyTitle(dup.source_title || dup.title || '');
}

export function fallbackEnglishDuplicateDescription() {
  return '';
}

export function englishFileUploadQuestions() {
  return [
    {
      question_type: 'file_upload',
      question_text: 'Upload your reference photos',
      required: true,
      max_allowed_files: 10,
    },
    {
      question_type: 'text_input',
      question_text: 'Describe who or what should be included in the portrait',
      required: true,
      max_allowed_characters: 1024,
    },
  ];
}

export function latestUserText(messages = []) {
  return String([...messages].reverse().find(m => m.role === 'user')?.content || '');
}
