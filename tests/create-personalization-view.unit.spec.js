import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  createPersonalizationQuestion,
  normalizeGeneratedPersonalizationQuestions,
  normalizePersonalizationQuestions,
  personalizationPayload,
  personalizationQuestionMarkup,
  personalizationQuestionsMarkup,
  readPersonalizationQuestions,
} from '../public/utils/create-personalization-view.js';

function fakeQuestionCard(values = {}, toggles = []) {
  return {
    querySelector(selector) {
      const field = selector.match(/data-pq-field="([^"]+)"/)?.[1];
      if (!field) return null;
      if (['required', 'labeled_upload'].includes(field)) {
        return { classList: { contains: value => value === 'on' && toggles.includes(field) } };
      }
      return { value: values[field] ?? '' };
    },
  };
}

test('personalization normalization preserves generated, upload-default, and existing-listing contracts', () => {
  expect(createPersonalizationQuestion({ question_text: 'Name' })).toMatchObject({
    question_type: 'text_input',
    question_text: 'Name',
    max_allowed_characters: 1024,
    max_allowed_files: 10,
    required: false,
  });

  expect(normalizeGeneratedPersonalizationQuestions({
    personalization_questions: [{
      question_type: 'dropdown',
      question_text: '<Choose a style>',
      required: true,
      options: ['Classic', { label: 'Modern' }],
    }],
  })).toEqual([expect.objectContaining({
    question_type: 'dropdown',
    question_text: '<Choose a style>',
    required: true,
    labeled_upload: true,
    options: [{ label: 'Classic' }, { label: 'Modern' }],
  })]);

  const uploadDefaults = normalizeGeneratedPersonalizationQuestions({
    is_personalizable: true,
    personalization_instructions: 'Share the names and preferred colours.',
  });
  expect(uploadDefaults).toHaveLength(2);
  expect(uploadDefaults[0]).toMatchObject({ question_type: 'file_upload', max_allowed_files: 10 });
  expect(uploadDefaults[1]).toMatchObject({
    question_type: 'text_input',
    instructions: 'Share the names and preferred colours.',
  });

  expect(normalizePersonalizationQuestions({
    personalization: {
      personalization_questions: [{ question_type: 'file_upload', question_text: 'Upload art' }],
    },
  }, {})).toEqual([expect.objectContaining({
    question_type: 'file_upload',
    question_text: 'Upload art',
    max_allowed_files: 1,
  })]);
});

test('personalization markup preserves type visibility, escaping, labels, and removal limits', () => {
  const question = createPersonalizationQuestion({
    question_type: 'file_upload',
    question_text: '<Reference & name>',
    instructions: 'Upload "front" <photo>',
    required: true,
    labeled_upload: true,
    options: [{ label: 'Front photo' }, { label: 'Side & detail' }],
  });
  const single = personalizationQuestionMarkup(question, 0, 1);

  expect(single).toContain('Question 1');
  expect(single).toContain('value="&lt;Reference &amp; name&gt;"');
  expect(single).toContain('Upload &quot;front&quot; &lt;photo&gt;');
  expect(single).toContain('data-pq-kind="file" style="display:block"');
  expect(single).toContain('data-pq-kind="text" style="display:none"');
  expect(single).toContain('data-pq-kind="file-labels" style="display:block"');
  expect(single).toContain('Front photo\nSide &amp; detail');
  expect(single).toContain('window.removePersonalizationQuestion(0)" disabled');

  const multiple = personalizationQuestionsMarkup([question, createPersonalizationQuestion()]);
  expect(multiple.match(/personal-question-card/g)).toHaveLength(2);
  expect(multiple).toContain('window.removePersonalizationQuestion(0)" >Remove');
  expect(multiple).toContain('Question 2');
});

test('DOM question reads and Etsy personalization payload mapping preserve exact field rules', () => {
  const questions = readPersonalizationQuestions([
    fakeQuestionCard({
      question_type: 'dropdown',
      question_text: '  Choose a finish  ',
      instructions: ' Pick one ',
      options: ' Matte \n\n Glossy ',
      max_allowed_characters: '5000',
      max_allowed_files: '0',
    }, ['required']),
    fakeQuestionCard({
      question_type: 'file_upload',
      question_text: ' Upload references ',
      instructions: '',
      file_labels: ' Front photo \n Side photo ',
      max_allowed_characters: '12',
      max_allowed_files: '7',
    }, ['labeled_upload']),
  ]);

  expect(questions).toEqual([
    expect.objectContaining({
      question_type: 'dropdown',
      question_text: 'Choose a finish',
      instructions: 'Pick one',
      required: true,
      max_allowed_characters: 1024,
      max_allowed_files: 1,
      options: [{ label: 'Matte' }, { label: 'Glossy' }],
    }),
    expect.objectContaining({
      question_type: 'file_upload',
      question_text: 'Upload references',
      labeled_upload: true,
      max_allowed_files: 7,
      options: [{ label: 'Front photo' }, { label: 'Side photo' }],
    }),
  ]);
  expect(personalizationPayload(questions)).toEqual([
    {
      question_type: 'dropdown',
      question_text: 'Choose a finish',
      instructions: 'Pick one',
      required: true,
      options: [{ label: 'Matte' }, { label: 'Glossy' }],
    },
    {
      question_type: 'file_upload',
      question_text: 'Upload references',
      required: false,
      max_allowed_files: 2,
      options: [{ label: 'Front photo' }, { label: 'Side photo' }],
    },
  ]);
});

test('Create remains the composition root while personalization presentation stays UI-only', async () => {
  const pageSource = await fs.readFile(new URL('../public/pages/create.js', import.meta.url), 'utf8');
  const viewSource = await fs.readFile(
    new URL('../public/utils/create-personalization-view.js', import.meta.url),
    'utf8',
  );

  const delegatedImport = pageSource.match(
    /import\s*\{([\s\S]*?)\}\s*from '\.\.\/utils\/create-personalization-view\.js';/,
  );
  expect(delegatedImport).not.toBeNull();
  for (const exportName of [
    'createPersonalizationQuestion',
    'defaultUploadPersonalizationQuestions',
    'normalizeGeneratedPersonalizationQuestions',
    'normalizePersonalizationQuestions',
    'personalizationPayload',
    'personalizationQuestionsMarkup',
    'readPersonalizationQuestions',
  ]) {
    expect(delegatedImport[1]).toMatch(new RegExp(`\\b${exportName}\\b`));
  }
  for (const legacyFunctionName of [
    'makePersonalizationQuestion',
    'defaultUploadPersonalizationQuestions',
    'normalizeGeneratedPersonalizationQuestions',
    'normalizePersonalizationQuestions',
    'renderPersonalizationQuestion',
  ]) {
    expect(pageSource).not.toMatch(new RegExp(`\\bfunction\\s+${legacyFunctionName}\\s*\\(`));
  }
  expect(pageSource).not.toMatch(/\bmakePersonalizationQuestion\b/);
  expect(pageSource).not.toMatch(/\brenderPersonalizationQuestion\b/);
  expect(viewSource).not.toMatch(/fetch\s*\(|etsy\s*\(|api\s*\.|publishListing|generateListing|buildContextPrompt/i);
});
