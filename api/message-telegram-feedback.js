import { createMessageTelegramFeedbackHandler } from './messages/telegram-feedback-handler.js';
import { recordMessageLearningTelegramFeedback } from './messages/learning-runtime.js';

export default createMessageTelegramFeedbackHandler({
  recordFeedback: recordMessageLearningTelegramFeedback,
});
