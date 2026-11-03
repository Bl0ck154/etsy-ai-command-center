import { generate } from '../_generate.js';
import { hasExternalAiConfigAsync } from '../_external-ai.js';
import { resolveTextProvider } from '../_provider-routing.js';
import {
  createBackgroundJobWithStatus,
  getBackgroundJob,
  updateBackgroundJob,
} from './job-store.js';

export function createListingGenerationApplication({
  generateListing = (params, provider) => generate('listing', params, provider),
  hasExternal = hasExternalAiConfigAsync,
  resolveProvider = resolveTextProvider,
  createJob = createBackgroundJobWithStatus,
  getJob = getBackgroundJob,
  updateJob = updateBackgroundJob,
  schedule = callback => setTimeout(callback, 0),
} = {}) {
  async function run(jobId, params) {
    try {
      updateJob(jobId, { status: 'running', progress: 15, message: 'AI worker started' });
      const externalAvailable = await hasExternal();
      const provider = resolveProvider(params.provider, {
        hasExternal: externalAvailable,
        hasClaude: Boolean(process.env.ANTHROPIC_API_KEY),
        hasGemini: Boolean(process.env.GEMINI_API_KEY),
      });
      if (provider === 'none') throw new Error('No text AI provider is configured');
      updateJob(jobId, { progress: 35, message: 'Generating listing content with AI' });
      const result = await generateListing(params, provider);
      updateJob(jobId, {
        status: 'done',
        progress: 100,
        message: 'Listing content ready',
        result,
        error: null,
      });
    } catch (error) {
      console.error('[jobs] listing generation failed:', error?.message || error);
      updateJob(jobId, {
        status: 'error',
        progress: 100,
        message: 'Listing generation failed',
        error: error?.message || 'Unknown error',
      });
    }
  }

  async function start(params = {}, requestedId = '', ownerId = '') {
    const suppliedId = /^job_[a-z0-9_]+$/i.test(String(requestedId || ''))
      ? String(requestedId)
      : '';
    if (suppliedId) {
      const existing = await getJob(suppliedId, ownerId);
      if (existing) return existing;
    }
    const { job, created } = createJob(suppliedId, 'listing_generation', params, ownerId);
    if (!job) return null;
    if (created) schedule(() => run(job.id, params));
    return job;
  }

  return { run, start };
}

export const listingGenerationApplication = createListingGenerationApplication();

export async function startListingGenerationJob(params = {}, requestedId = '', ownerId = '') {
  return listingGenerationApplication.start(params, requestedId, ownerId);
}
