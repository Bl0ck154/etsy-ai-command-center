import { pathToFileURL } from 'node:url';

import { publishSocialHermesDueScheduled } from '../api/modules/social/index.js';

function boundedLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 25, 25));
}

function enabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

export async function runSocialPublisherWorker({
  publishDue = publishSocialHermesDueScheduled,
  env = process.env,
  logger = console,
  now,
} = {}) {
  const result = await publishDue({
    dryRun: enabled(env.SOCIAL_PUBLISHER_DRY_RUN),
    limit: boundedLimit(env.SOCIAL_PUBLISHER_BATCH_LIMIT),
    canaryId: String(env.SOCIAL_PUBLISHER_CANARY_ID || '').trim() || null,
    ...(now ? { now } : {}),
  });
  const outcomes = Array.isArray(result?.results) ? result.results : [];
  const summary = {
    component: 'social-publisher-worker',
    event: 'completed',
    success: result?.success === true,
    dry_run: result?.dryRun === true,
    publish_blocked: result?.publish_blocked === true,
    due_count: Number(result?.due_count) || 0,
    attempted_count: outcomes.length,
    published_count: outcomes.filter(item => item?.success === true && item?.queued !== true).length,
    queued_external_count: outcomes.filter(item => item?.queued === true).length,
    failed_count: outcomes.filter(item => item?.success === false && item?.skipped !== true).length,
    skipped_count: outcomes.filter(item => item?.skipped === true).length,
    at: new Date().toISOString(),
  };
  logger.log(JSON.stringify(summary));
  return { result, summary };
}

const isDirectEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntrypoint) {
  runSocialPublisherWorker().catch(error => {
    console.error(JSON.stringify({
      component: 'social-publisher-worker',
      event: 'failed',
      code: String(error?.code || 'SOCIAL_PUBLISHER_FAILED').slice(0, 120),
      error: String(error?.message || error || 'Publisher failed').slice(0, 500),
      at: new Date().toISOString(),
    }));
    process.exitCode = 1;
  });
}
