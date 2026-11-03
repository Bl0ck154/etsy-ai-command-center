import { expect, test } from '@playwright/test';

import {
  englishFileUploadQuestions,
  fallbackEnglishDuplicateDescription,
  fallbackEnglishDuplicateTitle,
  hasCyrillic,
  latestUserText,
  listingContentHasCyrillic,
} from '../api/agent/listing-language.js';

test('detects Cyrillic in listing fields', () => {
  expect(hasCyrillic('Portrait')).toBe(false);
  expect(hasCyrillic('Портрет')).toBe(true);
  expect(listingContentHasCyrillic({ title: 'English', tags: ['portrait'] })).toBe(false);
  expect(listingContentHasCyrillic({
    title: 'English',
    personalization_questions: [{ question_text: 'Size', options: [{ label: 'Квадрат' }] }],
  })).toBe(true);
});

test('keeps duplicate fallback outputs', () => {
  expect(fallbackEnglishDuplicateTitle({ source_title: '  Example title  ' })).toBe('Example title');
  expect(fallbackEnglishDuplicateDescription()).toBe('');
});

test('keeps file upload question shape', () => {
  expect(englishFileUploadQuestions()).toEqual([
    { question_type: 'file_upload', question_text: 'Upload your reference photos', required: true, max_allowed_files: 10 },
    { question_type: 'text_input', question_text: 'Describe who or what should be included in the portrait', required: true, max_allowed_characters: 1024 },
  ]);
});

test('returns last user message', () => {
  expect(latestUserText([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'last' },
  ])).toBe('last');
  expect(latestUserText([])).toBe('');
});
