import { escHtml } from './format.js';

export function personalizationQuestionMarkup(question, index, totalQuestions = 1) {
  const type = question.question_type || 'text_input';
  const optionsText = (question.options || []).map(option => option.label || '').filter(Boolean).join('\n');
  const labeledUploadOn = question.labeled_upload === true
    || (type === 'file_upload' && (question.options || []).length > 0);
  const textOnlyStyle = type === 'text_input' ? 'block' : 'none';
  const fileOnlyStyle = type === 'file_upload' ? 'block' : 'none';
  const fileLabelsStyle = type === 'file_upload' && labeledUploadOn ? 'block' : 'none';
  const dropdownOnlyStyle = type === 'dropdown' ? 'block' : 'none';
  return `
    <div class="personal-question personal-question-card" data-pq-index="${index}">
      <div class="personal-question-header">
        <div class="personal-question-title">Question ${index + 1}</div>
        <div class="personal-question-actions">
          <label class="personal-inline-toggle">
            <span>Required</span>
            <span class="toggle-wrap"><span class="toggle ${question.required ? 'on' : ''}" data-pq-field="required" onclick="this.classList.toggle('on')"></span></span>
          </label>
          <button type="button" class="btn btn-sm btn-danger" onclick="window.removePersonalizationQuestion(${index})" ${totalQuestions <= 1 ? 'disabled' : ''}>Remove</button>
        </div>
      </div>
      <div class="personal-question-main">
        <div class="field">
          <label>Answer type</label>
          <select data-pq-field="question_type" onchange="window.updatePersonalizationQuestionType(${index}, this.value)">
            <option value="text_input" ${type === 'text_input' ? 'selected' : ''}>Text answer</option>
            <option value="dropdown" ${type === 'dropdown' ? 'selected' : ''}>Dropdown options</option>
            <option value="file_upload" ${type === 'file_upload' ? 'selected' : ''}>File upload</option>
          </select>
        </div>
        <div class="field">
          <label>Question shown to buyer</label>
          <input type="text" data-pq-field="question_text" value="${escHtml(question.question_text || '')}" placeholder="e.g. What name should appear on the portrait?">
        </div>
      </div>
      <div class="field personal-question-instructions">
        <label>Instructions for buyer</label>
        <textarea data-pq-field="instructions" rows="2" placeholder="Explain exactly what the buyer should provide">${escHtml(question.instructions || '')}</textarea>
      </div>
      <div class="personal-question-settings" data-pq-kind="text" style="display:${textOnlyStyle}">
        <div class="field">
          <label>Maximum answer length</label>
          <input type="number" data-pq-field="max_allowed_characters" value="${question.max_allowed_characters || 1024}" min="1" max="1024">
          <div class="create-field-note">1-1024 characters</div>
        </div>
      </div>
      <div class="field" data-pq-kind="dropdown" style="display:${dropdownOnlyStyle}">
        <label>Dropdown options</label>
        <textarea data-pq-field="options" rows="3" placeholder="One option per line">${escHtml(optionsText)}</textarea>
      </div>
      <div class="personal-question-settings personal-file-settings" data-pq-kind="file" style="display:${fileOnlyStyle}">
        <div class="field">
          <label>Maximum files</label>
          <input type="number" data-pq-field="max_allowed_files" value="${question.max_allowed_files || 10}" min="1" max="10">
        </div>
        <div class="personal-setting-toggle">
          <div>
            <div class="personal-setting-label">Use a label for each file</div>
            <div class="create-field-note">When enabled, the number of labels sets the file limit.</div>
          </div>
            <span class="toggle-wrap"><span class="toggle ${labeledUploadOn ? 'on' : ''}" data-pq-field="labeled_upload" onclick="this.classList.toggle('on');const labels=this.closest('.personal-question')?.querySelector('[data-pq-kind=&quot;file-labels&quot;]');if(labels)labels.style.display=this.classList.contains('on')?'block':'none'"></span></span>
        </div>
      </div>
      <div class="field" data-pq-kind="file-labels" style="display:${fileLabelsStyle}">
        <label>File labels <span class="label-hint">optional, one per line</span></label>
        <textarea data-pq-field="file_labels" rows="2" placeholder="Front photo\nSide photo\nDetail photo">${escHtml(optionsText)}</textarea>
      </div>
    </div>`;
}

export function personalizationQuestionsMarkup(questions = []) {
  return questions.map((question, index) => (
    personalizationQuestionMarkup(question, index, questions.length)
  )).join('');
}
