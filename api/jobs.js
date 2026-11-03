// api/jobs.js — lightweight background-job HTTP facade.

import { requireAuth } from './_auth.js';
import { recordAgentRuntimeFault } from './jobs/agent-audit.js';
import { imageGenerationApplication, resolveImageJobTimeoutMs } from './jobs/image-generation-application.js';
import {
  createBackgroundJob,
  getBackgroundJob,
  publicBackgroundJob,
  updateBackgroundJob,
} from './jobs/job-store.js';
import { startListingGenerationJob } from './jobs/listing-generation-application.js';

export const maxDuration = 10;

export {
  createBackgroundJob,
  getBackgroundJob,
  publicBackgroundJob,
  recordAgentRuntimeFault,
  resolveImageJobTimeoutMs,
  startListingGenerationJob,
  updateBackgroundJob,
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const { action, job_id, ...params } = req.method === 'GET' ? req.query : req.body || {};
  const ownerId = String(req.auth?.user?.id || '');

  if (action === 'status') {
    const job = await getBackgroundJob(String(job_id || ''), ownerId);
    if (!job) return res.status(404).json({ error: `Job not found: ${job_id}` });
    return res.json({ success: true, data: publicBackgroundJob(job) });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (action === 'startListingGeneration') {
    if (!params.description) return res.status(400).json({ error: 'description required' });
    const job = await startListingGenerationJob(params, job_id, ownerId);
    if (!job) return res.status(409).json({ error: 'Job id is already owned by another user' });
    return res.json({ success: true, data: publicBackgroundJob(job) });
  }

  if (action === 'startImageGeneration') {
    if (!params.prompt && !(Array.isArray(params.prompts) && params.prompts.length)) {
      return res.status(400).json({ error: 'prompt required' });
    }
    const job = imageGenerationApplication.start(params, ownerId);
    return res.json({ success: true, data: publicBackgroundJob(job) });
  }

  if (action === 'recordAgentRuntimeFault') {
    const record = recordAgentRuntimeFault(job_id, params.fault || {});
    return res.json({ success: true, data: { recorded: true, event: record.event, fault: record.fault } });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
