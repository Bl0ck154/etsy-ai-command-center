import { cleanText } from './contracts.js';

export function actionFrom(req) {
  return cleanText(req.body?.action || req.query?.action, 80);
}

export function actor(req) {
  return {
    id: cleanText(req.auth?.user?.id, 120) || 'unknown',
    name: cleanText(req.auth?.user?.name, 200) || 'Unknown operator',
  };
}

export function requireApprover(req) {
  const allowed = String(process.env.MESSAGE_APPROVER_USER_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (!allowed.length || allowed.includes(actor(req).id)) return;
  const error = new Error('This account may review drafts but may not approve or send them');
  error.status = 403;
  error.code = 'MESSAGE_APPROVER_REQUIRED';
  throw error;
}
