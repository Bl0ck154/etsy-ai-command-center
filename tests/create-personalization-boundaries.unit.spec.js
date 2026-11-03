import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  createPersonalizationQuestion,
  defaultUploadPersonalizationQuestions,
  normalizeGeneratedPersonalizationQuestions,
  normalizePersonalizationQuestions,
  personalizationPayload,
} from '../public/utils/create-personalization-model.js';
import { personalizationQuestionMarkup } from '../public/utils/create-personalization-markup.js';
import { readPersonalizationQuestions } from '../public/utils/create-personalization-dom-reader.js';

function fakeCard(fields = {}, toggles = {}) {
  return {
    querySelector(selector) {
      const match = selector.match(/data-pq-field="([^"]+)"/);
      const key = match?.[1];
      if (!key) return null;
      if (key in toggles) return { classList: { contains: name => name === 'on' && toggles[key] === true } };
      return key in fields ? { value: fields[key] } : null;
    },
  };
}

test('question defaults and generated fallback remain stable', () => {
  expect(createPersonalizationQuestion()).toMatchObject({
    question_type: 'text_input', question_text: 'Personalization', required: false,
    max_allowed_characters: 1024, max_allowed_files: 10, labeled_upload: false, options: [],
  });
  const defaults = defaultUploadPersonalizationQuestions({ personalization_instructions: 'Custom details' });
  expect(defaults).toHaveLength(2);
  expect(defaults[0]).toMatchObject({ question_type: 'file_upload', required: true, max_allowed_files: 10 });
  expect(defaults[1].instructions).toBe('Custom details');
});

test('generated questions normalize options and labeled-upload signal', () => {
  const questions = normalizeGeneratedPersonalizationQuestions({
    personalization_questions: [{ question_type: 'file_upload', question_text: 'Photos', options: ['Front', { label: 'Side' }] }],
  });
  expect(questions[0].labeled_upload).toBe(true);
  expect(questions[0].options).toEqual([{ label: 'Front' }, { label: 'Side' }]);
});

test('listing personalization is used only when generated questions are absent', () => {
  const listing = { personalization: { personalization_questions: [{ question_type: 'text_input', question_text: 'Name', max_allowed_files: 1 }] } };
  expect(normalizePersonalizationQuestions(listing, {})).toHaveLength(1);
  expect(normalizePersonalizationQuestions(listing, { personalization_questions: [{ question_text: 'Generated' }] })[0].question_text).toBe('Generated');
});

test('payload preserves dropdown labels and labeled file-upload file count', () => {
  const payload = personalizationPayload([
    createPersonalizationQuestion({ question_type: 'dropdown', question_text: 'Size', options: [{ label: 'A4' }] }),
    createPersonalizationQuestion({ question_type: 'file_upload', question_text: 'Photos', labeled_upload: true, max_allowed_files: 10, options: [{ label: 'Front' }, { label: 'Side' }] }),
  ]);
  expect(payload[0].options).toEqual([{ label: 'A4' }]);
  expect(payload[1].max_allowed_files).toBe(2);
  expect(payload[1].options).toEqual([{ label: 'Front' }, { label: 'Side' }]);
});

test('DOM reader preserves clamps, toggles and file labels', () => {
  const [question] = readPersonalizationQuestions([fakeCard({
    question_type: 'file_upload',
    question_text: '  Photos  ',
    instructions: '  Clear files  ',
    max_allowed_characters: '9000',
    max_allowed_files: '99',
    file_labels: 'Front\n\n Side ',
  }, { required: true, labeled_upload: true })]);
  expect(question).toMatchObject({
    question_type: 'file_upload', question_text: 'Photos', instructions: 'Clear files', required: true,
    max_allowed_characters: 1024, max_allowed_files: 10, labeled_upload: true,
    options: [{ label: 'Front' }, { label: 'Side' }],
  });
});

test('markup keeps type-specific controls and escapes buyer-visible values', () => {
  const markup = personalizationQuestionMarkup(createPersonalizationQuestion({ question_type: 'dropdown', question_text: '<Name>', options: [{ label: '<A>' }] }), 0, 2);
  expect(markup).toContain('&lt;Name&gt;');
  expect(markup).toContain('&lt;A&gt;');
  expect(markup).toContain('data-pq-kind="dropdown" style="display:block"');
  expect(markup).not.toContain('disabled>Remove');
});

test('legacy create-personalization-view is facade-only', () => {
  const source = fs.readFileSync(new URL('../public/utils/create-personalization-view.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(18);
  expect(source).not.toContain('personal-question-card');
  expect(source).not.toContain('querySelector');
  expect(source).toContain("from './create-personalization-model.js'");
});
