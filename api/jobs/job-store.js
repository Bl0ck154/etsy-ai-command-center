import {
  cleanupBackgroundJobFiles,
  readBackgroundJob,
  writeBackgroundJob,
} from './job-repository.js';
import {
  AGENT_AUDIT_TTL_MS,
  cleanupAgentAuditFilesSafely,
  persistAgentAuditEvent,
  summarizeJobInput,
} from './agent-audit.js';

const JOB_TTL_MS = 30 * 60 * 1000;
const jobs = globalThis.__etsyManagerJobs || new Map();
globalThis.__etsyManagerJobs = jobs;
let lastPersistedCleanupAt = 0;
let lastAgentAuditCleanupAt = 0;

function now() { return Date.now(); }

function persistJob(job) {
  if (!job?.id) return;
  return writeBackgroundJob(job)
    .catch(err => {
      if (err?.code !== 'ENOENT') console.warn('[jobs] persist failed:', err?.message || err);
    });
}

async function readPersistedJob(id) {
  try {
    const job = await readBackgroundJob(id);
    if (!job) return null;
    jobs.set(id, job);
    return job;
  } catch {}
  return null;
}

async function cleanupPersistedJobFiles(cutoff) {
  try {
    await cleanupBackgroundJobFiles(cutoff);
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn('[jobs] persisted cleanup failed:', err?.message || err);
  }
}

function cleanupJobs() {
  const cutoff = now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if ((job.updated_at || job.created_at || 0) < cutoff) jobs.delete(id);
  }
  if (now() - lastPersistedCleanupAt >= 10 * 60 * 1000) {
    lastPersistedCleanupAt = now();
    cleanupPersistedJobFiles(cutoff);
  }
  if (now() - lastAgentAuditCleanupAt >= 60 * 60 * 1000) {
    lastAgentAuditCleanupAt = now();
    cleanupAgentAuditFilesSafely(now() - AGENT_AUDIT_TTL_MS);
  }
}

export function createBackgroundJobWithStatus(id, type, input = {}, ownerId = '') {
  cleanupJobs();
  const suppliedId = String(id || '');
  const normalizedId = /^job_[a-z0-9_]+$/i.test(suppliedId)
    ? suppliedId
    : `job_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  if (jobs.has(normalizedId)) {
    const existing = jobs.get(normalizedId);
    if (ownerId && existing.owner_id && existing.owner_id !== ownerId) {
      return { job: null, created: false };
    }
    return { job: existing, created: false };
  }
  const job = {
    id: normalizedId,
    type,
    status: 'queued',
    progress: 0,
    message: 'Queued',
    input_summary: summarizeJobInput(input),
    result: null,
    error: null,
    owner_id: String(ownerId || '').trim() || null,
    created_at: now(),
    updated_at: now(),
  };
  jobs.set(normalizedId, job);
  persistJob(job);
  persistAgentAuditEvent(job, 'accepted');
  return { job, created: true };
}

export function createBackgroundJob(id, type, input = {}, ownerId = '') {
  return createBackgroundJobWithStatus(id, type, input, ownerId).job;
}

export function updateBackgroundJob(id, patch = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  const wasTerminal = job.status === 'done' || job.status === 'error';
  Object.assign(job, patch, { updated_at: now() });
  persistJob(job);
  if (!wasTerminal && job.status === 'done') persistAgentAuditEvent(job, 'completed');
  if (!wasTerminal && job.status === 'error') persistAgentAuditEvent(job, 'failed');
  return job;
}

export async function getBackgroundJob(id, ownerId = '') {
  cleanupJobs();
  const normalizedId = String(id || '');
  const job = jobs.get(normalizedId) || await readPersistedJob(normalizedId);
  if (ownerId && job && !job.owner_id) {
    job.owner_id = ownerId;
    persistJob(job);
  }
  if (ownerId && job?.owner_id && job.owner_id !== ownerId) return null;
  return job;
}

export function publicBackgroundJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    input_summary: job.input_summary,
    result: job.result,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    last_event: job.last_event || null,
  };
}
