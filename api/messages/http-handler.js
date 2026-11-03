import { requireAuth } from '../_auth.js';
import { actionFrom } from './http-contract.js';
import { handleGet, handlePost } from './composition.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const action = actionFrom(req);
  if (!action) return res.status(400).json({ error: 'Messages action is required' });
  if (req.method === 'GET') return handleGet(req, res, action);
  if (req.method === 'POST') return handlePost(req, res, action);
  return res.status(405).json({ error: 'Method not allowed' });
}
