// api/imagen.js — Image & video generation
// Supports: Gemini/external image generation + Meta AI video generation.

export const maxDuration = 150;

import { requireAuth } from './_auth.js';
import { sendPublicError } from './_errors.js';
import { mediaApplication } from './media/application.js';
import { proxyEtsyReviewImage } from './media/review-image-proxy.js';

export { generateMediaImages } from './media/image-generation.js';

process.on('unhandledRejection', (err) => console.error('[imagen]', err?.message));

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method === 'GET' && req.query?.action === 'proxyEtsyReviewImage') {
    return proxyEtsyReviewImage(req, res);
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const input = req.body || {};
  const action = input.action;

  if (action === 'listModels') {
    return res.json(await mediaApplication.listAvailableModels());
  }

  if (action === 'generate') {
    try {
      return res.json(await mediaApplication.generateImages(input));
    } catch (err) {
      console.error('[imagen generate]', err.message);
      return sendPublicError(res, err);
    }
  }

  if (action === 'generateVideo') {
    try {
      return res.json(await mediaApplication.generateVideo(input));
    } catch (err) {
      if (err.status !== 503 && err.status !== 401) console.error('[imagen generateVideo]', err.message);
      return sendPublicError(res, err);
    }
  }

  if (action === 'animateImage') {
    try {
      return res.json(await mediaApplication.animateImage(input));
    } catch (err) {
      if (err.status !== 503 && err.status !== 401) console.error('[imagen animateImage]', err.message);
      return sendPublicError(res, err);
    }
  }

  if (action === 'analyzeImage') {
    try {
      return res.json(await mediaApplication.analyzeImage(input));
    } catch (err) {
      console.error('[analyzeImage]', err.message);
      if (err?.status === 500 && err?.message === 'GEMINI_API_KEY not configured') {
        return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
      }
      return sendPublicError(res, err);
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
