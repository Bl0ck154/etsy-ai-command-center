export function createPersonalizationQuestion(overrides = {}) {
  return {
    question_type: 'text_input',
    question_text: 'Personalization',
    instructions: '',
    required: false,
    max_allowed_characters: 1024,
    max_allowed_files: 10,
    labeled_upload: false,
    options: [],
    ...overrides,
  };
}

export function defaultUploadPersonalizationQuestions(generated = {}) {
  return [
    createPersonalizationQuestion({
      question_type: 'file_upload',
      question_text: 'Upload your reference photos',
      instructions: 'Upload the photos/files needed to create your custom order directly here on Etsy. Clear, high-resolution files work best.',
      required: true,
      max_allowed_files: 10,
    }),
    createPersonalizationQuestion({
      question_type: 'text_input',
      question_text: 'Describe your custom request',
      instructions: generated.personalization_instructions || 'Tell us names, placement, style, background, colours, or any other details needed for your order.',
      required: true,
      max_allowed_characters: 1024,
    }),
  ];
}

export function normalizeGeneratedPersonalizationQuestions(generated = {}) {
  if (Array.isArray(generated.personalization_questions) && generated.personalization_questions.length) {
    return generated.personalization_questions.map(question => createPersonalizationQuestion({
      question_type: question.question_type || 'text_input',
      question_text: question.question_text || 'Personalization',
      instructions: question.instructions || '',
      required: question.required === true,
      max_allowed_characters: question.max_allowed_characters || 1024,
      max_allowed_files: question.max_allowed_files || 10,
      labeled_upload: Array.isArray(question.options) && question.options.length > 0,
      options: Array.isArray(question.options)
        ? question.options.map(option => ({ label: option.label || String(option) })).filter(option => option.label)
        : [],
    }));
  }
  if (generated.is_personalizable === true) return defaultUploadPersonalizationQuestions(generated);
  return [];
}

export function normalizePersonalizationQuestions(listing, generated) {
  const generatedQuestions = normalizeGeneratedPersonalizationQuestions(generated);
  if (generatedQuestions.length) return generatedQuestions;
  const existing = listing?.personalization?.personalization_questions;
  if (Array.isArray(existing) && existing.length) {
    return existing.map(question => createPersonalizationQuestion({
      question_type: question.question_type || 'text_input',
      question_text: question.question_text || 'Personalization',
      instructions: question.instructions || '',
      required: question.required === true,
      max_allowed_characters: question.max_allowed_characters || 1024,
      max_allowed_files: question.max_allowed_files || 1,
      options: Array.isArray(question.options)
        ? question.options.map(option => ({ label: option.label || String(option) })).filter(option => option.label)
        : [],
    }));
  }
  const instructions = listing?.personalization_instructions || generated?.personalization_instructions || '';
  if (listing?.is_personalizable || generated?.is_personalizable === true || instructions) {
    return [createPersonalizationQuestion({
      instructions,
      required: listing?.personalization_is_required ?? false,
      max_allowed_characters: listing?.personalization_char_count_max || 1024,
    })];
  }
  return [];
}

export function personalizationPayload(questions = []) {
  return questions.map(question => {
    const payload = {
      question_type: question.question_type,
      question_text: question.question_text || 'Personalization',
      ...(question.instructions ? { instructions: question.instructions } : {}),
      required: question.required === true,
    };
    if (question.question_type === 'text_input') {
      payload.max_allowed_characters = question.max_allowed_characters || 1024;
    }
    if (question.question_type === 'dropdown') {
      payload.options = (question.options || []).map(option => ({ label: option.label })).filter(option => option.label);
    }
    if (question.question_type === 'file_upload') {
      const labels = (question.options || []).map(option => ({ label: option.label })).filter(option => option.label);
      payload.max_allowed_files = question.labeled_upload && labels.length
        ? labels.length
        : (question.max_allowed_files || 10);
      if (question.labeled_upload && labels.length) payload.options = labels;
    }
    return payload;
  }).filter(question => (
    question.question_text
    || question.instructions
    || question.options?.length
    || question.question_type === 'file_upload'
  ));
}
