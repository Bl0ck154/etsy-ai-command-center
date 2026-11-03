import { expect, test } from '@playwright/test';

import { createListingGenerationApplication } from '../api/jobs/listing-generation-application.js';

function queuedJob(id = 'job_listing_1') {
  return { id, type: 'listing_generation', status: 'queued', owner_id: 'owner' };
}

test('requested listing job already persisted is returned without scheduling another runner', async () => {
  let createCalls = 0;
  let scheduled = 0;
  const existing = queuedJob();
  const application = createListingGenerationApplication({
    getJob: async () => existing,
    createJob: () => { createCalls += 1; return { job: queuedJob(), created: true }; },
    schedule: () => { scheduled += 1; },
  });

  await expect(application.start({ description: 'product' }, existing.id, 'owner')).resolves.toBe(existing);
  expect(createCalls).toBe(0);
  expect(scheduled).toBe(0);
});

test('listing job created during persisted lookup is not scheduled twice', async () => {
  let scheduled = 0;
  const raced = queuedJob('job_listing_race');
  const application = createListingGenerationApplication({
    getJob: async () => null,
    createJob: () => ({ job: raced, created: false }),
    schedule: () => { scheduled += 1; },
  });

  await expect(application.start({ description: 'product' }, raced.id, 'owner')).resolves.toBe(raced);
  expect(scheduled).toBe(0);
});

test('new listing job schedules once and preserves progress/result transitions', async () => {
  const updates = [];
  let scheduledCallback = null;
  let generation = null;
  const job = queuedJob('job_listing_new');
  const application = createListingGenerationApplication({
    getJob: async () => null,
    createJob: () => ({ job, created: true }),
    updateJob: (id, patch) => { updates.push({ id, patch }); },
    hasExternal: async () => true,
    resolveProvider: (requested, availability) => {
      expect(requested).toBe('external');
      expect(availability.hasExternal).toBe(true);
      return 'external';
    },
    generateListing: async (params, provider) => {
      generation = { params, provider };
      return { title: 'Generated title' };
    },
    schedule: callback => { scheduledCallback = callback; },
  });

  await expect(application.start({ description: 'product', provider: 'external' }, job.id, 'owner')).resolves.toBe(job);
  expect(typeof scheduledCallback).toBe('function');
  await scheduledCallback();
  expect(generation).toEqual({ params: { description: 'product', provider: 'external' }, provider: 'external' });
  expect(updates.map(entry => entry.patch.status).filter(Boolean)).toEqual(['running', 'done']);
  expect(updates.at(-1).patch).toMatchObject({
    status: 'done',
    progress: 100,
    message: 'Listing content ready',
    result: { title: 'Generated title' },
    error: null,
  });
});

test('missing text provider moves listing job to terminal error state', async () => {
  const updates = [];
  const application = createListingGenerationApplication({
    updateJob: (id, patch) => { updates.push({ id, patch }); },
    hasExternal: async () => false,
    resolveProvider: () => 'none',
  });

  await application.run('job_listing_none', { description: 'product' });
  expect(updates.at(-1).patch).toMatchObject({
    status: 'error',
    progress: 100,
    message: 'Listing generation failed',
    error: 'No text AI provider is configured',
  });
});
