// api/_scheduler.js — shared due scheduled social post publisher

import crypto from 'node:crypto';

import { assertScheduledPostMediaSafety } from './_social-media-safety.js';
import { createSocialPublishHistoryRepository } from './modules/social/infrastructure/publish-history-repository.js';
import {
  normalizeSocialPlatformId,
  normalizeSocialPlatformToken,
  resolveFacebookDirectPublishConfig,
  resolveInstagramDirectPublishConfig,
  resolvePinterestMakePublishConfig,
  resolveSocialPlatformCapabilities,
} from './_social-platform-capabilities.js';

export { resolveFacebookDirectPublishConfig, resolveInstagramDirectPublishConfig } from './_social-platform-capabilities.js';

export const maxDuration = 60;

const SHOP_ID = process.env.ETSY_SHOP_ID || 'default';
const SCHEDULER_TERMINAL_STATUSES = new Set(['published', 'publishing', 'queued', 'queued_external', 'failed']);
const PUBLISH_APPROVED_STATUS = 'approved_scheduled';
const SCHEDULER_CONNECTOR_NAMES = new Set(['buffer', 'metricool', 'zapier', 'make', 'make_com']);
const PUBLISH_LOCK_TTL_SECONDS = 10 * 60;
const SCHEDULE_MUTATION_LOCK_KEY = `${SHOP_ID}:scheduled:mutation-lock`;
const SCHEDULED_QUEUE_SCHEMA_VERSION = 1;
const SCHEDULED_QUEUE_RECORD_TYPE = 'social_scheduled_post';
const RELEASE_PUBLISH_LOCK_SCRIPT = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
const RENEW_LOCK_SCRIPT = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) else return 0 end';
const COMMIT_SCHEDULE_REPLACEMENT_SCRIPT = 'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end if ARGV[2] == "replace" then if redis.call("EXISTS", KEYS[2]) ~= 1 then return -1 end redis.call("RENAME", KEYS[2], KEYS[3]) else redis.call("DEL", KEYS[3]) end redis.call("DEL", KEYS[1]) return 1';
let scheduleMutationTail = Promise.resolve();

function appBaseUrl() {
  const explicit = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const fallback = process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:3010' : '';
  return fallback;
}

function callbackSecret() {
  return process.env.MAKE_CALLBACK_SECRET || '';
}

function getKvCreds() {
  const url = (process.env.KV_REST_API_URL || '').replace(/^["']|["']$/g, '');
  const token = (process.env.KV_REST_API_TOKEN || '').replace(/^["']|["']$/g, '');
  return { url, token };
}

async function kvCall(command, ...args) {
  const { url, token } = getKvCreds();
  if (!url || !token) throw new Error('KV_REST_API_URL or KV_REST_API_TOKEN not configured');
  const res = await fetch(`${url}/${[command, ...args].join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

const socialPublishHistoryRepository = createSocialPublishHistoryRepository({
  callKv: kvCall,
  shopId: SHOP_ID,
});

function scheduledQueueSchemaError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 500;
  error.retryable = false;
  return error;
}

function decodeScheduledQueueRecord(raw) {
  let parsed;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return { record: null, legacy: false };
  }
  if (Object.prototype.hasOwnProperty.call(parsed || {}, 'schema_version')) {
    if (parsed.schema_version !== SCHEDULED_QUEUE_SCHEMA_VERSION) {
      throw scheduledQueueSchemaError(
        `Unsupported scheduled queue schema version: ${parsed.schema_version}`,
        'SOCIAL_QUEUE_SCHEMA_UNSUPPORTED',
      );
    }
    if (
      parsed.record_type !== SCHEDULED_QUEUE_RECORD_TYPE
      || !parsed.record
      || typeof parsed.record !== 'object'
      || Array.isArray(parsed.record)
    ) {
      throw scheduledQueueSchemaError(
        'Invalid scheduled queue schema envelope.',
        'SOCIAL_QUEUE_SCHEMA_INVALID',
      );
    }
    return { record: parsed.record, legacy: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { record: null, legacy: false };
  }
  return { record: parsed, legacy: true };
}

function encodeScheduledQueueRecord(record) {
  return encodeURIComponent(JSON.stringify({
    schema_version: SCHEDULED_QUEUE_SCHEMA_VERSION,
    record_type: SCHEDULED_QUEUE_RECORD_TYPE,
    record,
  }));
}

async function readScheduledQueue() {
  const raw = await kvCall('LRANGE', `${SHOP_ID}:scheduled:posts`, '0', '-1');
  const decoded = (raw || []).map(decodeScheduledQueueRecord);
  return {
    posts: dedupeScheduledPosts(decoded.map(item => item.record).filter(Boolean)),
    needsMigration: decoded.some(item => item.legacy && item.record),
  };
}

export async function getScheduledPosts() {
  const initial = await readScheduledQueue();
  if (!initial.needsMigration) return initial.posts;
  return withScheduleMutationLock(async lease => {
    const current = await readScheduledQueue();
    if (current.needsMigration) {
      await saveScheduledPostsUnlocked(current.posts, lease, { validateRecords: false });
    }
    return current.posts;
  });
}

async function acquirePublishLock(postId) {
  const id = String(postId || '').trim();
  if (!id) return null;
  const lockKey = `${SHOP_ID}:scheduled:publish-lock:${encodeURIComponent(id)}`;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const result = await kvCall('SET', lockKey, token, 'NX', 'EX', String(PUBLISH_LOCK_TTL_SECONDS));
  return result === 'OK' ? { key: lockKey, token } : null;
}

async function releasePublishLock(lock) {
  if (!lock?.key || !lock?.token) return false;
  const released = await kvCall(
    'EVAL',
    encodeURIComponent(RELEASE_PUBLISH_LOCK_SCRIPT),
    '1',
    encodeURIComponent(lock.key),
    encodeURIComponent(lock.token),
  ).catch(() => 0);
  return Number(released) === 1;
}

function boundedScheduleMutationInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(min, Math.min(Number.isFinite(parsed) ? parsed : fallback, max));
}

function scheduleMutationLockSettings() {
  return {
    ttlSeconds: boundedScheduleMutationInteger(process.env.SOCIAL_QUEUE_MUTATION_LOCK_TTL_SECONDS, 60, 10, 600),
    waitMs: boundedScheduleMutationInteger(process.env.SOCIAL_QUEUE_MUTATION_LOCK_WAIT_MS, 2500, 25, 15_000),
    retryMs: boundedScheduleMutationInteger(process.env.SOCIAL_QUEUE_MUTATION_LOCK_RETRY_MS, 50, 5, 1000),
    commandTimeoutMs: boundedScheduleMutationInteger(process.env.SOCIAL_QUEUE_MUTATION_LOCK_COMMAND_TIMEOUT_MS, 1500, 50, 5000),
  };
}

function scheduleMutationLockError(message, code, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.status = 503;
  error.retryable = true;
  return error;
}

function waitForScheduleMutationRetry(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function boundedScheduleMutationKvCall(timeoutMs, ...args) {
  let timer = null;
  try {
    return await Promise.race([
      kvCall(...args),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis mutation-lock command timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function acquireScheduleMutationLease(deadline, settings) {
  while (Date.now() < deadline) {
    const token = `${process.pid}:${crypto.randomUUID()}`;
    let result;
    try {
      result = await boundedScheduleMutationKvCall(
        Math.max(1, Math.min(settings.commandTimeoutMs, deadline - Date.now())),
        'SET',
        SCHEDULE_MUTATION_LOCK_KEY,
        token,
        'NX',
        'EX',
        String(settings.ttlSeconds),
      );
    } catch (cause) {
      throw scheduleMutationLockError(
        `Scheduled queue mutation lock is unavailable: ${cause?.message || cause}`,
        'SOCIAL_QUEUE_MUTATION_LOCK_UNAVAILABLE',
        cause,
      );
    }
    if (result === 'OK') {
      const acquiredAt = Date.now();
      return {
        key: SCHEDULE_MUTATION_LOCK_KEY,
        token,
        ttlSeconds: settings.ttlSeconds,
        acquiredAt,
        expiresAt: acquiredAt + settings.ttlSeconds * 1000,
      };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await waitForScheduleMutationRetry(Math.min(settings.retryMs, remainingMs));
  }
  throw scheduleMutationLockError(
    'Scheduled queue mutation lock remained busy until the bounded wait expired.',
    'SOCIAL_QUEUE_MUTATION_LOCK_TIMEOUT',
  );
}

async function renewScheduleMutationLease(lease) {
  if (!lease?.key || !lease?.token) {
    throw scheduleMutationLockError(
      'Scheduled queue mutation lease is missing.',
      'SOCIAL_QUEUE_MUTATION_LOCK_LOST',
    );
  }
  let renewed;
  try {
    renewed = await boundedScheduleMutationKvCall(
      scheduleMutationLockSettings().commandTimeoutMs,
      'EVAL',
      encodeURIComponent(RENEW_LOCK_SCRIPT),
      '1',
      encodeURIComponent(lease.key),
      encodeURIComponent(lease.token),
      String(lease.ttlSeconds),
    );
  } catch (cause) {
    throw scheduleMutationLockError(
      `Scheduled queue mutation lease could not be renewed: ${cause?.message || cause}`,
      'SOCIAL_QUEUE_MUTATION_LOCK_UNAVAILABLE',
      cause,
    );
  }
  if (Number(renewed) !== 1) {
    throw scheduleMutationLockError(
      'Scheduled queue mutation lease ownership was lost before commit.',
      'SOCIAL_QUEUE_MUTATION_LOCK_LOST',
    );
  }
  lease.expiresAt = Date.now() + lease.ttlSeconds * 1000;
  return lease;
}

async function ensureScheduleMutationLease(lease) {
  const renewalMarginMs = Math.min(5000, Math.max(1000, lease.ttlSeconds * 100));
  if (Date.now() < lease.expiresAt - renewalMarginMs) return lease;
  return renewScheduleMutationLease(lease);
}

async function releaseScheduleMutationLease(lease) {
  if (!lease?.key || !lease?.token || lease.released) return false;
  const released = await boundedScheduleMutationKvCall(
    scheduleMutationLockSettings().commandTimeoutMs,
    'EVAL',
    encodeURIComponent(RELEASE_PUBLISH_LOCK_SCRIPT),
    '1',
    encodeURIComponent(lease.key),
    encodeURIComponent(lease.token),
  ).catch(() => 0);
  return Number(released) === 1;
}

async function commitScheduledQueueReplacement(lease, shadowKey, targetKey, mode) {
  let committed;
  try {
    committed = await boundedScheduleMutationKvCall(
      scheduleMutationLockSettings().commandTimeoutMs,
      'EVAL',
      encodeURIComponent(COMMIT_SCHEDULE_REPLACEMENT_SCRIPT),
      '3',
      encodeURIComponent(lease.key),
      encodeURIComponent(shadowKey),
      encodeURIComponent(targetKey),
      encodeURIComponent(lease.token),
      mode,
    );
  } catch (cause) {
    const error = scheduleMutationLockError(
      `Scheduled queue commit outcome is unknown: ${cause?.message || cause}`,
      'SOCIAL_QUEUE_MUTATION_COMMIT_UNKNOWN',
      cause,
    );
    error.outcome = 'unknown';
    error.retryable = false;
    throw error;
  }
  if (Number(committed) === 0) {
    throw scheduleMutationLockError(
      'Scheduled queue mutation lease ownership was lost before atomic commit.',
      'SOCIAL_QUEUE_MUTATION_LOCK_LOST',
    );
  }
  if (Number(committed) !== 1) {
    const error = new Error('Scheduled queue shadow list was missing at atomic commit.');
    error.code = 'SOCIAL_QUEUE_ATOMIC_REPLACEMENT_MISSING';
    throw error;
  }
  lease.released = true;
}

async function withScheduleMutationLock(callback) {
  const settings = scheduleMutationLockSettings();
  const deadline = Date.now() + settings.waitMs;
  const previous = scheduleMutationTail;
  let release;
  scheduleMutationTail = new Promise(resolve => { release = resolve; });
  let lease = null;
  try {
    const remainingForLocalWait = deadline - Date.now();
    if (remainingForLocalWait <= 0) {
      throw scheduleMutationLockError(
        'Scheduled queue mutation wait expired before local serialization completed.',
        'SOCIAL_QUEUE_MUTATION_LOCK_TIMEOUT',
      );
    }
    await Promise.race([
      previous.catch(() => {}),
      waitForScheduleMutationRetry(remainingForLocalWait).then(() => {
        throw scheduleMutationLockError(
          'Scheduled queue mutation wait expired behind another local mutation.',
          'SOCIAL_QUEUE_MUTATION_LOCK_TIMEOUT',
        );
      }),
    ]);
    lease = await acquireScheduleMutationLease(deadline, settings);
    return await callback(lease);
  } finally {
    await releaseScheduleMutationLease(lease);
    release();
  }
}

export function dedupeScheduledPosts(posts = []) {
  const seen = new Set();
  return (Array.isArray(posts) ? posts : []).filter(post => {
    const id = String(post?.id || '').trim();
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function getSocialConfigs() {
  const raw = await kvCall('GET', `${SHOP_ID}:social_configs`);
  return raw ? JSON.parse(decodeURIComponent(raw)) : {};
}

function normalizeSchedulerPlatformToken(value = '') {
  return normalizeSocialPlatformToken(value);
}

function normalizeSchedulerPlatformId(value = '') {
  return normalizeSocialPlatformId(value);
}

export function resolveSchedulerConfiguredPlatforms(socialConfigs = {}) {
  return resolveSocialPlatformCapabilities(socialConfigs).plan_capable_platforms;
}

export function resolveSchedulerPublishCapablePlatforms(socialConfigs = {}) {
  return resolveSocialPlatformCapabilities(socialConfigs).publish_capable_platforms;
}

async function getMakeWebhookUrl() {
  try {
    const configs = await getSocialConfigs();
    const resolved = resolvePinterestMakePublishConfig(configs);
    if (resolved.url) return { url: resolved.url, source: resolved.source };
  } catch (e) {
    console.warn('[scheduler] Make config lookup failed:', e?.message);
  }
  const envUrl = (process.env.MAKE_WEBHOOK_URL || '').trim();
  return envUrl ? { url: envUrl, source: 'env' } : { url: '', source: null };
}

async function saveScheduledPostsUnlocked(posts, lease, { validateRecords = true } = {}) {
  const uniquePosts = dedupeScheduledPosts(posts);
  if (validateRecords) uniquePosts.forEach(assertScheduledPostMediaSafety);
  const targetKey = `${SHOP_ID}:scheduled:posts`;
  await ensureScheduleMutationLease(lease);
  if (!uniquePosts.length) {
    await commitScheduledQueueReplacement(lease, targetKey, targetKey, 'delete');
    return;
  }

  // Build a complete replacement beside the live queue, then swap it in with
  // one Redis command. A deploy/restart during LPUSH can leave only the shadow
  // key incomplete; the live queue remains untouched until RENAME succeeds.
  const shadowKey = `${targetKey}:replace:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
  try {
    await kvCall('DEL', shadowKey);
    for (const [index, post] of [...uniquePosts].reverse().entries()) {
      if (index > 0 && index % 25 === 0) await ensureScheduleMutationLease(lease);
      await kvCall('LPUSH', shadowKey, encodeScheduledQueueRecord(post));
    }
    await commitScheduledQueueReplacement(lease, shadowKey, targetKey, 'replace');
  } catch (error) {
    await kvCall('DEL', shadowKey).catch(() => {});
    throw error;
  }
}

export async function saveScheduledPosts(posts) {
  return withScheduleMutationLock(lease => saveScheduledPostsUnlocked(posts, lease));
}

async function mutateScheduledPosts(mutator) {
  return withScheduleMutationLock(async lease => {
    const { posts } = await readScheduledQueue();
    const result = await mutator(posts);
    await saveScheduledPostsUnlocked(posts, lease);
    return result;
  });
}

async function mutateScheduledPost(id, mutator, { expectedRecord = null, allowMissing = false } = {}) {
  const requestedId = String(id || '').trim();
  return mutateScheduledPosts(posts => {
    const idx = posts.findIndex(post => String(post.id) === requestedId);
    if (idx < 0) {
      if (allowMissing) return null;
      const error = new Error(`Scheduled post not found: ${requestedId}`);
      error.code = 'NOT_FOUND';
      throw error;
    }
    if (expectedRecord !== null && JSON.stringify(posts[idx]) !== JSON.stringify(expectedRecord)) {
      const error = new Error(`Scheduled record changed before its queue mutation: ${requestedId}`);
      error.code = 'SOCIAL_QUEUE_RECORD_CHANGED';
      throw error;
    }
    return mutator(posts[idx], posts, idx);
  });
}

export async function saveScheduledPost(post) {
  const record = { ...post, id: post.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}` };
  assertScheduledPostMediaSafety(record);
  return mutateScheduledPosts(posts => {
    const idx = posts.findIndex(p => String(p.id) === String(record.id));
    if (idx >= 0) {
      const merged = { ...posts[idx], ...record };
      posts[idx] = clearsApproval(record) ? clearApprovalFields(merged) : merged;
      return posts[idx];
    }
    posts.unshift(record);
    return record;
  });
}

export async function saveScheduledPostBatch(input = []) {
  const records = (Array.isArray(input) ? input : []).map(post => ({
    ...post,
    id: post.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
  }));
  records.forEach(assertScheduledPostMediaSafety);
  return mutateScheduledPosts(posts => records.map(record => {
    const idx = posts.findIndex(post => String(post.id) === String(record.id));
    if (idx >= 0) {
      const merged = { ...posts[idx], ...record };
      posts[idx] = clearsApproval(record) ? clearApprovalFields(merged) : merged;
      return posts[idx];
    }
    posts.unshift(record);
    return record;
  }));
}

const APPROVAL_CLEAR_FIELDS = ['status', 'caption', 'platform', 'listing_id', 'listing_title', 'listing_image_url', 'custom_image_url', 'generated_image_url', 'media_items', 'scheduled_at'];

function clearsApproval(changes = {}) {
  const status = Object.prototype.hasOwnProperty.call(changes, 'status') ? String(changes.status || '').toLowerCase() : '';
  if (status === PUBLISH_APPROVED_STATUS || changes.approved_for_publish === true) return false;
  if (status && status !== PUBLISH_APPROVED_STATUS) return true;
  return APPROVAL_CLEAR_FIELDS.some(field => field !== 'status' && Object.prototype.hasOwnProperty.call(changes, field));
}

function clearApprovalFields(record = {}) {
  return {
    ...record,
    approved_for_publish: false,
    approved_by: null,
    approved_at: null,
    approval_note: null,
    approval_source: null,
  };
}

export async function updateScheduledPost(id, changes = {}, { updatedAt = new Date().toISOString() } = {}) {
  return mutateScheduledPosts(posts => {
    const idx = posts.findIndex(p => String(p.id) === String(id));
    if (idx < 0) throw new Error(`Scheduled post not found: ${id}`);
    const merged = { ...posts[idx], ...changes, id: posts[idx].id, updated_at: updatedAt };
    assertScheduledPostMediaSafety(merged);
    posts[idx] = clearsApproval(changes) ? clearApprovalFields(merged) : merged;
    return posts[idx];
  });
}

function safeDraftSnapshot(snapshot = {}) {
  const record = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const safe = clearApprovalFields({
    ...record,
    scheduled_at: null,
    status: 'draft',
    publish_method: null,
    publish_result: null,
    published_at: null,
    queued_at: null,
    callback_at: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  });
  assertScheduledPostMediaSafety(safe);
  return safe;
}

export async function restoreScheduledPostToDraft(id, snapshot = {}) {
  const requestedId = String(id || '').trim();
  if (!requestedId) throw approvalError('Scheduled post id is required.', 'ID_REQUIRED');
  return mutateScheduledPosts(posts => {
    const idx = posts.findIndex(post => String(post.id) === requestedId);
    if (idx >= 0) {
      const status = String(posts[idx].status || '').toLowerCase();
      if (['published', 'publishing', 'queued', 'queued_external'].includes(status)) {
        throw approvalError('A published or externally queued record cannot be moved in place. Recover a separate draft copy instead.', 'TERMINAL_STATUS');
      }
      posts[idx] = safeDraftSnapshot({ ...posts[idx], id: posts[idx].id });
      return { record: posts[idx], restored_from_snapshot: false };
    }
    const source = safeDraftSnapshot(snapshot);
    if (!source.caption || !source.platform) {
      throw approvalError(`Scheduled post not found and the saved card snapshot is incomplete: ${requestedId}`, 'NOT_FOUND');
    }
    const restoredId = `${requestedId}-restored-${Date.now().toString(36)}`;
    const restored = {
      ...source,
      id: restoredId,
      created_at: new Date().toISOString(),
      metadata: {
        ...(source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata) ? source.metadata : {}),
        restored_from_missing_record_id: requestedId,
      },
    };
    posts.unshift(restored);
    return { record: restored, restored_from_snapshot: true };
  });
}

export async function recoverQueuedExternalPostToDraft(id, { now = new Date() } = {}) {
  const requestedId = String(id || '').trim();
  if (!requestedId) throw approvalError('Scheduled post id is required.', 'ID_REQUIRED');
  return mutateScheduledPosts(posts => {
    const idx = posts.findIndex(post => String(post.id) === requestedId);
    if (idx < 0) throw approvalError(`Scheduled post not found: ${requestedId}`, 'NOT_FOUND');
    const original = posts[idx];
    if (!['queued', 'queued_external'].includes(String(original.status || '').toLowerCase())) {
      throw approvalError('Only a record waiting for external confirmation can be recovered this way.', 'STATUS_NOT_ALLOWED');
    }
    const recoveredAt = (now instanceof Date ? now : new Date(now)).toISOString();
    const copy = safeDraftSnapshot({
      ...original,
      id: `${requestedId}-recovered-${Date.now().toString(36)}`,
      created_at: recoveredAt,
      metadata: {
        ...(original.metadata && typeof original.metadata === 'object' && !Array.isArray(original.metadata) ? original.metadata : {}),
        recovered_from_external_record_id: requestedId,
        recovered_from_unconfirmed_external: true,
        recovered_at: recoveredAt,
      },
    });
    const failedOriginal = clearApprovalFields({
      ...original,
      status: 'failed',
      last_error: 'External publisher did not provide a confirmed published/failed callback; a separate unapproved draft copy was recovered for owner review.',
      external_confirmation_recovered_at: recoveredAt,
      updated_at: recoveredAt,
    });
    posts[idx] = failedOriginal;
    posts.unshift(copy);
    return { record: copy, original: failedOriginal };
  });
}

function hasPublishableMedia(post = {}) {
  return Boolean(post.media_items?.find(m => m?.url || (typeof m === 'string' && m))
    || post.custom_image_url
    || post.generated_image_url
    || post.listing_image_url);
}

function approvalError(message, code = 'APPROVAL_NOT_ALLOWED') {
  const err = new Error(message);
  err.code = code;
  return err;
}

export async function approveScheduledPost(id, { approvedBy = 'admin-ui', note = '', now: nowValue = null, minLeadMinutes = 5, readinessCheck = null } = {}) {
  return mutateScheduledPosts(async posts => {
    const idx = posts.findIndex(p => String(p.id) === String(id));
    if (idx < 0) throw approvalError(`Scheduled post not found: ${id}`, 'NOT_FOUND');

    const post = posts[idx];
    const status = String(post.status || '').toLowerCase();
    if (SCHEDULER_TERMINAL_STATUSES.has(status)) {
      throw approvalError('Published, publishing, or failed posts cannot be approved for future autopublish.', 'TERMINAL_STATUS');
    }
    if (!post.caption || !String(post.caption).trim()) {
      throw approvalError('Caption is required before approving a post for autopublish.', 'CAPTION_REQUIRED');
    }
    if (!post.scheduled_at) {
      throw approvalError('Schedule date/time is required before approving a post for autopublish.', 'SCHEDULE_REQUIRED');
    }
    const scheduleMs = scheduledAtMs(post);
    if (scheduleMs === null) {
      throw approvalError('Scheduled date/time is invalid.', 'SCHEDULE_INVALID');
    }
    const now = nowValue ? new Date(nowValue) : new Date();
    const minLeadMs = Math.max(0, Number(minLeadMinutes) || 0) * 60_000;
    if (scheduleMs <= now.getTime() + minLeadMs) {
      throw approvalError(`Approved autopublish time must be at least ${Math.round(minLeadMs / 60_000)} minutes in the future. Reschedule first, then approve.`, 'SCHEDULE_TOO_SOON');
    }
    const platform = String(post.platform || 'all').toLowerCase();
    if (['all', 'instagram', 'pinterest', 'tiktok'].includes(platform) && !hasPublishableMedia(post)) {
      throw approvalError('Media is required before approving this platform for autopublish.', 'MEDIA_REQUIRED');
    }
    const metadata = post.metadata && typeof post.metadata === 'object' ? post.metadata : {};
    const requiresAiCanaryReadiness = post.source === 'social_hermes' || Boolean(metadata.campaign_id);
    if (requiresAiCanaryReadiness && typeof readinessCheck === 'function') {
      const readiness = await readinessCheck(post, { now, minLeadMinutes });
      const readyForOwnerApproval = readiness?.ready_for_owner_approval === true
        || readiness?.ready_for_canary_approval === true;
      if (!readiness || readiness.verdict === 'blocked' || !readyForOwnerApproval) {
        const blockers = Array.isArray(readiness?.blockers) && readiness.blockers.length
          ? ` ${readiness.blockers.map(blocker => blocker.code || blocker.message).join(', ')}`
          : '';
        throw approvalError(`AI canary readiness is not complete before publish approval.${blockers}`, 'CANARY_READINESS_REQUIRED');
      }
    }

    const approvedAt = now.toISOString();
    posts[idx] = {
      ...post,
      status: PUBLISH_APPROVED_STATUS,
      approved_for_publish: true,
      approved_by: String(approvedBy || 'admin-ui').slice(0, 80),
      approved_at: approvedAt,
      approval_note: String(note || '').slice(0, 500) || null,
      approval_source: 'admin_ui',
      approval_previous_status: post.status || null,
      last_error: null,
      updated_at: approvedAt,
    };
    return posts[idx];
  });
}

export async function unapproveScheduledPost(id, { unapprovedBy = 'admin-ui', reason = '' } = {}) {
  return mutateScheduledPosts(posts => {
    const idx = posts.findIndex(p => String(p.id) === String(id));
    if (idx < 0) throw approvalError(`Scheduled post not found: ${id}`, 'NOT_FOUND');
    const now = new Date().toISOString();
    const post = posts[idx];
    const nextStatus = post.scheduled_at ? 'scheduled' : 'draft';
    posts[idx] = {
      ...post,
      status: nextStatus,
      approved_for_publish: false,
      approved_by: null,
      approved_at: null,
      approval_note: null,
      approval_source: null,
      unapproved_by: String(unapprovedBy || 'admin-ui').slice(0, 80),
      unapproved_at: now,
      unapproval_reason: String(reason || '').slice(0, 500) || null,
      updated_at: now,
    };
    return posts[idx];
  });
}

export async function deleteScheduledPost(id) {
  return mutateScheduledPosts(posts => {
    const before = posts.length;
    const filtered = posts.filter(p => String(p.id) !== String(id));
    posts.splice(0, posts.length, ...filtered);
    return { deleted: before - filtered.length, remaining: filtered.length };
  });
}

export async function applyMakeCallback(callback = {}) {
  const id = callback.scheduled_post_id || callback.post_id || callback.id;
  if (!id) throw new Error('scheduled_post_id required');
  const outcome = await mutateScheduledPosts(posts => {
    const idx = posts.findIndex(p => String(p.id) === String(id));
    if (idx === -1) throw new Error(`scheduled post not found: ${id}`);
    const expectedAttemptId = String(posts[idx]?.publish_result?.callback_attempt_id || posts[idx]?.callback_attempt_id || '').trim();
    const callbackAttemptId = String(callback.callback_attempt_id || callback.callbackAttemptId || callback.attempt_id || callback.attemptId || '').trim();
    if (!expectedAttemptId) throw new Error(`scheduled post has no active Make callback attempt: ${id}`);
    if (!callbackAttemptId || callbackAttemptId !== expectedAttemptId) throw new Error(`Make callback attempt mismatch for scheduled post: ${id}`);
    const callbackStatus = String(callback.status || '').trim().toLowerCase();
    const confirmedPublished = callbackStatus === 'published';
    const confirmedFailed = callbackStatus === 'failed' || callbackStatus === 'error' || callback.success === false || callback.success === 'false';
    const now = new Date().toISOString();
    const result = {
      method: String(callback.service || 'Make.com').slice(0, 80),
      post_url: callback.post_url || callback.url || null,
      status: callbackStatus || (confirmedPublished ? 'published' : confirmedFailed ? 'failed' : 'queued_external'),
      message: String(callback.message || callback.error || '').slice(0, 500),
      callback_attempt_id: expectedAttemptId,
      external_id: callback.external_id || callback.pin_id || callback.post_id_external || null,
    };
    posts[idx] = confirmedPublished
      ? { ...posts[idx], status: 'published', published_at: now, callback_at: now, publish_method: result.method, publish_result: result, post_url: result.post_url, last_error: null }
      : confirmedFailed
        ? { ...posts[idx], status: 'failed', callback_at: now, last_error: callback.error || callback.message || 'Make.com callback reported failure', last_attempt_at: now, publish_result: result }
        : { ...posts[idx], status: 'queued_external', queued_at: posts[idx].queued_at || now, callback_at: now, publish_method: result.method, publish_result: result, last_error: null };
    return { success: true, updated: posts[idx], confirmedPublished, result };
  });
  if (outcome.confirmedPublished) await recordPost(outcome.updated, outcome.result).catch(() => {});
  return { success: true, updated: outcome.updated };
}

async function recordPost(post, result) {
  const record = {
    listing_id: post.listing_id ? Number(post.listing_id) : null,
    listing_title: post.listing_title || '',
    platform: post.platform || 'all',
    service: result.method || 'scheduler',
    status: 'published',
    post_url: result.post_url || null,
    postedAt: Date.now(),
  };
  await socialPublishHistoryRepository.append(record);
}

function scheduledMediaItemType(item) {
  if (!item) return '';
  const rawType = typeof item === 'object'
    ? (item.type || item.media_type || item.mime_type || item.content_type || item.contentType)
    : '';
  const normalizedType = String(rawType || '').trim().toLowerCase();
  if (normalizedType === 'video' || normalizedType.startsWith('video/')) return 'video';
  if (normalizedType === 'image' || normalizedType.startsWith('image/')) return 'image';
  const url = String(typeof item === 'string' ? item : item.url || '').trim();
  return /\.(mp4|mov|webm|m4v)(?:[?#]|$)/i.test(url) ? 'video' : (url ? 'image' : '');
}

function scheduledPostVideoItems(post = {}) {
  return (Array.isArray(post.media_items) ? post.media_items : [])
    .filter(item => scheduledMediaItemType(item) === 'video');
}

function assertImageOnlyPublisherMedia(post = {}) {
  const videoItems = scheduledPostVideoItems(post);
  if (!videoItems.length) return;
  const platform = String(post.platform || 'social').trim().toLowerCase();
  const error = new Error(
    `${platform} scheduled publishing received video media, but this route currently supports images only. Use a dedicated video/Reel publisher after it is configured.`,
  );
  error.code = 'VIDEO_ROUTE_NOT_IMPLEMENTED';
  throw error;
}

function postImageUrl(post) {
  return post.media_items?.find(m => m?.url && scheduledMediaItemType(m) !== 'video')?.url
    || post.custom_image_url
    || post.listing_image_url
    || '';
}

function postImageUrls(post) {
  const urls = [];
  const add = (url) => { if (url && !urls.includes(url)) urls.push(url); };
  add(postImageUrl(post));
  for (const item of (Array.isArray(post.media_items) ? post.media_items : [])) {
    if (scheduledMediaItemType(item) !== 'video') add(item?.url || item);
  }
  return urls;
}

export function assertScheduledPostMediaContract(post = {}, imageCount = postImageUrls(post).length) {
  assertImageOnlyPublisherMedia(post);
  const platform = String(post.platform || '').trim().toLowerCase();
  const explicitFormat = String(post.metadata?.media_format || '').trim().toLowerCase();
  const reviewedFormat = String(post.metadata?.media_strategy?.platform_variants?.[platform]?.format || '').trim().toLowerCase();
  if (explicitFormat && reviewedFormat && explicitFormat !== reviewedFormat) {
    throw new Error(`Scheduled ${platform} media format does not match its AI-reviewed platform variant.`);
  }
  const format = explicitFormat || reviewedFormat;
  if (!format) return { platform, format: '', image_count: imageCount };
  const allowed = platform === 'instagram'
    ? new Set(['single', 'carousel'])
    : platform === 'facebook'
      ? new Set(['single', 'multi_image'])
      : platform === 'pinterest'
        ? new Set(['single'])
        : new Set(['single']);
  if (!allowed.has(format)) {
    throw new Error(`Scheduled ${platform} format ${format} is not supported by its publisher.`);
  }
  if (format === 'single' && imageCount !== 1) {
    throw new Error(`Scheduled ${platform} single format requires exactly one image; received ${imageCount}.`);
  }
  if (['carousel', 'multi_image'].includes(format) && imageCount < 2) {
    throw new Error(`Scheduled ${platform} ${format} format requires at least two images; received ${imageCount}.`);
  }
  return { platform, format, image_count: imageCount };
}

function postLink(post) {
  return post.listing_id ? `https://www.etsy.com/listing/${post.listing_id}` : '';
}

export async function postFacebookDirect(post) {
  const socialConfigs = await getSocialConfigs().catch(() => ({}));
  const { token, pageId } = resolveFacebookDirectPublishConfig(socialConfigs || {});
  if (!token || !pageId) throw new Error('Facebook publishing is not configured in Etsy AI Command Center Settings.');
  const text = post.caption || '';
  const imageUrls = postImageUrls(post).filter(Boolean).slice(0, 10);
  assertScheduledPostMediaContract(post, imageUrls.length);
  const imageUrl = imageUrls[0] || '';
  if (imageUrls.length > 1) {
    const photoIds = [];
    for (const url of imageUrls) {
      const photoParams = new URLSearchParams({ access_token: token, url, published: 'false' });
      const photoResponse = await fetch(`https://graph.facebook.com/v25.0/${pageId}/photos?${photoParams}`, { method: 'POST' });
      const photoData = await photoResponse.json().catch(() => ({}));
      if (!photoResponse.ok || photoData.error || !photoData.id) throw new Error(photoData.error?.message || photoData.message || 'Facebook unpublished photo upload failed');
      photoIds.push(photoData.id);
    }
    const feedParams = new URLSearchParams({ access_token: token });
    if (text) feedParams.set('message', text);
    photoIds.forEach((id, index) => feedParams.set(`attached_media[${index}]`, JSON.stringify({ media_fbid: id })));
    const feedResponse = await fetch(`https://graph.facebook.com/v25.0/${pageId}/feed?${feedParams}`, { method: 'POST' });
    const feedData = await feedResponse.json().catch(() => ({}));
    if (!feedResponse.ok || feedData.error) throw new Error(feedData.error?.message || feedData.message || 'Facebook multi-photo publish failed');
    return {
      success: true,
      method: 'Etsy AI Command Center Facebook publisher',
      published: true,
      post_id: feedData.id || null,
      media_count: imageUrls.length,
      data: feedData,
    };
  }
  const params = new URLSearchParams({ access_token: token });
  if (text) params.set('message', text);
  if (postLink(post) && !imageUrl) params.set('link', postLink(post));
  let endpoint = `https://graph.facebook.com/v25.0/${pageId}/feed`;
  if (imageUrl) {
    endpoint = `https://graph.facebook.com/v25.0/${pageId}/photos`;
    params.set('url', imageUrl);
  }
  const r = await fetch(`${endpoint}?${params}`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.message || 'Facebook API error');
  if (!r.ok) throw new Error(data.message || `Facebook ${r.status}`);
  return { success: true, method: 'Etsy AI Command Center Facebook publisher', published: true, post_id: data.id || null, data };
}

async function waitInstagramContainer(containerId, token) {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await fetch(`https://graph.facebook.com/v25.0/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`);
    const status = await statusRes.json().catch(() => ({}));
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR') throw new Error('Instagram media processing failed');
  }
}

function normalizeInstagramPermalink(value = '') {
  const permalink = String(value || '').trim();
  if (!permalink) return null;
  if (/^https?:\/\//i.test(permalink)) return permalink;
  return `https://www.instagram.com${permalink.startsWith('/') ? '' : '/'}${permalink}`;
}

async function instagramPermalink(mediaId, token) {
  try {
    const linkRes = await fetch(`https://graph.facebook.com/v25.0/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`);
    const data = await linkRes.json().catch(() => ({}));
    return normalizeInstagramPermalink(data.permalink);
  } catch {
    return null;
  }
}

async function postInstagramDirect(post) {
  const socialConfigs = await getSocialConfigs().catch(() => ({}));
  const { token, userId } = resolveInstagramDirectPublishConfig(socialConfigs || {});
  if (!token || !userId) throw new Error('Instagram publishing is not configured in Etsy AI Command Center Settings.');
  const caption = post.caption || '';
  const imageUrls = postImageUrls(post).filter(Boolean).slice(0, 10);
  if (!imageUrls.length) throw new Error('Instagram publishing requires at least one public image URL');
  assertScheduledPostMediaContract(post, imageUrls.length);

  if (imageUrls.length === 1) {
    const params = new URLSearchParams({ image_url: imageUrls[0], caption, access_token: token });
    const createRes = await fetch(`https://graph.facebook.com/v25.0/${userId}/media?${params}`, { method: 'POST' });
    const create = await createRes.json().catch(() => ({}));
    if (!createRes.ok || create.error) throw new Error(create.error?.message || 'Instagram container failed');
    await waitInstagramContainer(create.id, token);
    const pubRes = await fetch(`https://graph.facebook.com/v25.0/${userId}/media_publish?creation_id=${encodeURIComponent(create.id)}&access_token=${encodeURIComponent(token)}`, { method: 'POST' });
    const pub = await pubRes.json().catch(() => ({}));
    if (!pubRes.ok || pub.error) throw new Error(pub.error?.message || 'Instagram publish failed');
    return { success: true, method: 'Etsy AI Command Center Instagram publisher', published: true, media_id: pub.id || null, post_url: await instagramPermalink(pub.id, token) };
  }

  const itemIds = [];
  for (const imageUrl of imageUrls) {
    const params = new URLSearchParams({ image_url: imageUrl, is_carousel_item: 'true', access_token: token });
    const r = await fetch(`https://graph.facebook.com/v25.0/${userId}/media?${params}`, { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error?.message || `Instagram carousel item failed for ${imageUrl}`);
    await waitInstagramContainer(data.id, token);
    itemIds.push(data.id);
  }
  const carouselParams = new URLSearchParams({ media_type: 'CAROUSEL', children: itemIds.join(','), caption, access_token: token });
  const carouselRes = await fetch(`https://graph.facebook.com/v25.0/${userId}/media?${carouselParams}`, { method: 'POST' });
  const carousel = await carouselRes.json().catch(() => ({}));
  if (!carouselRes.ok || carousel.error) throw new Error(carousel.error?.message || 'Instagram carousel container failed');
  await waitInstagramContainer(carousel.id, token);
  const pubRes = await fetch(`https://graph.facebook.com/v25.0/${userId}/media_publish?creation_id=${encodeURIComponent(carousel.id)}&access_token=${encodeURIComponent(token)}`, { method: 'POST' });
  const pub = await pubRes.json().catch(() => ({}));
  if (!pubRes.ok || pub.error) throw new Error(pub.error?.message || 'Instagram carousel publish failed');
  return { success: true, method: 'Etsy AI Command Center Instagram publisher', published: true, media_id: pub.id || null, post_url: await instagramPermalink(pub.id, token), images: itemIds.length };
}

async function postBuffer(post) {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  const profileIds = (process.env.BUFFER_PROFILE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token) throw new Error('BUFFER_ACCESS_TOKEN not set');
  if (!profileIds.length) throw new Error('BUFFER_PROFILE_IDS not set');
  const results = [];
  for (const profileId of profileIds) {
    const payload = {
      profile_ids: [profileId],
      text: post.caption || '',
      ...(postImageUrl(post) ? { media: { photo: postImageUrl(post) } } : {}),
      ...(postLink(post) ? { media: { link: postLink(post) } } : {}),
    };
    const r = await fetch('https://api.bufferapp.com/1/updates/create.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Buffer ${r.status}`);
    results.push({ profileId, data });
  }
  return { success: true, method: 'Buffer', published: false, queued: true, data: results };
}

async function postMake(post) {
  const make = await getMakeWebhookUrl();
  if (!make.url) throw new Error('Make.com webhook URL not configured');
  const secret = callbackSecret();
  if (!secret) throw new Error('MAKE_CALLBACK_SECRET is required for Make.com scheduled publishing callbacks');
  const imageUrls = postImageUrls(post);
  assertScheduledPostMediaContract(post, imageUrls.length);
  if (imageUrls.length !== 1) {
    const error = new Error(`Pinterest publishing through Make requires exactly one AI-selected image; received ${imageUrls.length}.`);
    error.code = 'PINTEREST_SINGLE_PIN_MEDIA_REQUIRED';
    throw error;
  }
  const callbackAttemptId = String(post?.publish_result?.callback_attempt_id || post?.callback_attempt_id || '').trim();
  if (!callbackAttemptId) throw new Error('Make.com publish attempt must be persisted before webhook dispatch');
  const r = await fetch(make.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'scheduledPost',
      platform: post.platform || 'all',
      title: post.listing_title || '',
      text: post.caption || '',
      imageUrl: imageUrls[0],
      imageUrls: [imageUrls[0]],
      media_items: [{ url: imageUrls[0], type: 'image' }],
      link: postLink(post),
      listing_id: post.listing_id || null,
      scheduled_post_id: post.id,
      callbackUrl: appBaseUrl() ? `${appBaseUrl()}/api/social?action=makeCallback` : '',
      callbackSecret: secret,
      callback_attempt_id: callbackAttemptId,
      callbackAttemptId: callbackAttemptId,
      timestamp: new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`Make.com ${r.status}`);
  return { success: true, method: 'Make.com Pinterest bridge', published: false, queued: true, status: r.status, source: make.source, callback_attempt_id: callbackAttemptId };
}

async function postZapier(post) {
  const url = process.env.ZAPIER_WEBHOOK_URL;
  if (!url) throw new Error('ZAPIER_WEBHOOK_URL not set');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: post.platform || 'all',
      title: post.listing_title || '',
      caption: post.caption || '',
      imageUrl: postImageUrl(post),
      link: postLink(post),
      listing_id: post.listing_id || null,
      scheduled_post_id: post.id,
      timestamp: new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`Zapier ${r.status}`);
  return { success: true, method: 'Zapier', published: false, queued: true, status: r.status };
}

async function postMetricool(post) {
  const apiKey = process.env.METRICOOL_API_KEY;
  const brandId = process.env.METRICOOL_BRAND_ID;
  if (!apiKey || !brandId) throw new Error('METRICOOL_API_KEY or METRICOOL_BRAND_ID not set');
  const socialConfigs = await getSocialConfigs().catch(() => ({}));
  const platforms = resolveSchedulerMetricoolPlatforms(post.platform, socialConfigs);
  if (!platforms.length) {
    throw new Error('Metricool all-platform publishing requires at least one UI-configured social platform.');
  }
  const payload = {
    brand_id: brandId,
    platforms,
    content: post.caption || '',
    ...(postImageUrl(post) ? { media: [{ url: postImageUrl(post), type: 'image' }] } : {}),
  };
  const r = await fetch('https://app.metricool.com/api/v2/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Metricool ${r.status}`);
  return { success: true, method: 'Metricool', published: false, queued: true, data };
}

function resolveSchedulerMetricoolPlatforms(platform, socialConfigs = {}) {
  const requested = Array.isArray(platform) ? platform : [platform];
  const explicitPlatforms = requested
    .map(value => ({ raw: normalizeSchedulerPlatformToken(value), id: normalizeSchedulerPlatformId(value) }))
    .filter(({ raw, id }) => id && id !== 'all' && !SCHEDULER_CONNECTOR_NAMES.has(raw) && !SCHEDULER_CONNECTOR_NAMES.has(id))
    .map(({ id }) => id);
  if (explicitPlatforms.length) return [...new Set(explicitPlatforms)];
  return resolveSchedulerConfiguredPlatforms(socialConfigs);
}

export function resolveSchedulerMetricoolPlatformsForTest(platform, socialConfigs = {}) {
  return resolveSchedulerMetricoolPlatforms(platform, socialConfigs);
}

export function publishGovernanceStatus() {
  const autopublishEnvEnabled = process.env.AUTOPUBLISH_ENABLED === 'true';
  const legacyAutopublishEnabled = process.env.AUTOPUBLISH === 'true';
  const realPublishEnabled = autopublishEnvEnabled && legacyAutopublishEnabled;
  return {
    mode: realPublishEnabled ? 'real-publish-enabled' : 'approved-schedule',
    autopublish_enabled: realPublishEnabled,
    autopublish_env_enabled: autopublishEnvEnabled,
    legacy_autopublish_enabled: legacyAutopublishEnabled,
    real_publish_enabled: realPublishEnabled,
    publish_now_available: realPublishEnabled,
    external_publish_blocked: !realPublishEnabled,
    approval_required: !realPublishEnabled,
  };
}

export function isAutopublishEnabled() {
  return publishGovernanceStatus().real_publish_enabled;
}

function isPublishApproved(post = {}) {
  return String(post.status || '').toLowerCase() === PUBLISH_APPROVED_STATUS
    && post.approved_for_publish === true
    && Boolean(post.approved_by)
    && Boolean(post.approved_at);
}

async function publishViaBestService(post) {
  if (!isAutopublishEnabled()) {
    throw new Error('Autopublish is disabled. Set AUTOPUBLISH_ENABLED=true and AUTOPUBLISH=true only after explicit Phase 3 approval.');
  }
  const platform = String(post.platform || 'all').toLowerCase();
  const socialConfigs = await getSocialConfigs().catch(() => ({}));
  const make = await getMakeWebhookUrl();
  const capabilities = resolveSocialPlatformCapabilities(socialConfigs, { makeWebhookUrl: make.url });
  const capability = capabilities.by_platform[normalizeSchedulerPlatformId(platform)];
  if (!capability?.publish_capable) {
    throw new Error(capability?.blocker_reason || 'No complete publish route is configured for this platform.');
  }

  // Platform routing is intentionally explicit:
  // - Instagram/Facebook publish through Etsy AI Command Center using the saved Meta settings.
  // - Pinterest uses Make.com because Pinterest platform access is not viable for this shop.
  // - TikTok remains Buffer/Metricool/manual-only.
  if (capability.publish_route === 'instagram_direct') return postInstagramDirect(post);
  if (capability.publish_route === 'facebook_direct') return postFacebookDirect(post);
  if (platform === 'pinterest') {
    return postMake(post);
  }
  if (platform === 'tiktok') {
    if (capability.publish_route === 'buffer_tiktok') return postBuffer(post);
    if (capability.publish_route === 'metricool_tiktok') return postMetricool(post);
  }
  throw new Error('Autopublish requires a single explicit platform: instagram, facebook, pinterest, or tiktok. Split "all" posts into platform-specific scheduled records.');
}

function scheduledAtMs(post = {}) {
  if (!post.scheduled_at) return null;
  const value = new Date(post.scheduled_at).getTime();
  return Number.isFinite(value) ? value : null;
}

export function classifyScheduledPost(post = {}, nowValue = new Date()) {
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const status = String(post.status || 'draft').toLowerCase();
  const scheduleMs = scheduledAtMs(post);
  const hasSchedule = scheduleMs !== null;
  const isTerminal = SCHEDULER_TERMINAL_STATUSES.has(status);
  const isPaused = status === 'paused';
  const isApproved = isPublishApproved(post);
  const isOverdue = hasSchedule && scheduleMs <= nowMs && !isTerminal && !isPaused;
  const isPublishableDue = isOverdue && isApproved;
  const isFutureScheduled = hasSchedule && scheduleMs > nowMs && !isTerminal && !isPaused;
  const queueState = isTerminal
    ? status
    : isPaused
      ? 'paused'
    : isPublishableDue
      ? 'publishable_due'
      : isOverdue
        ? 'stale_overdue'
        : isFutureScheduled
          ? (isApproved ? 'approved_scheduled' : 'active_scheduled')
          : 'draft';
  return {
    queue_state: queueState,
    is_overdue: isOverdue,
    is_stale: isOverdue && !isApproved,
    is_publish_approved: isApproved,
    is_publishable_due: isPublishableDue,
    is_active_queue: isFutureScheduled,
    overdue_ms: isOverdue ? nowMs - scheduleMs : 0,
    scheduled_at_ms: scheduleMs,
  };
}

function isDue(post, now) {
  if (!post.scheduled_at) return false;
  const status = String(post.status || '').toLowerCase();
  if (SCHEDULER_TERMINAL_STATUSES.has(status) || status === 'paused') return false;
  const scheduleMs = scheduledAtMs(post);
  return scheduleMs !== null && scheduleMs <= now.getTime();
}

function isPublishableDue(post, now) {
  return isDue(post, now) && isPublishApproved(post);
}

export async function getSchedulerStatus() {
  const posts = await getScheduledPosts();
  const now = new Date();
  const classified = posts.map(p => classifyScheduledPost(p, now));
  return {
    success: true,
    ...publishGovernanceStatus(),
    due: posts.filter(p => isPublishableDue(p, now)).length,
    overdue_total: posts.filter(p => isDue(p, now)).length,
    publishable_due: posts.filter(p => isPublishableDue(p, now)).length,
    scheduled: classified.filter(p => p.is_active_queue).length,
    active_queue: classified.filter(p => p.is_active_queue).length,
    stale_overdue: classified.filter(p => p.is_stale).length,
    approved_scheduled: classified.filter(p => p.queue_state === 'approved_scheduled').length,
    drafts: classified.filter(p => p.queue_state === 'draft').length,
    paused: classified.filter(p => p.queue_state === 'paused').length,
    failed: posts.filter(p => p.status === 'failed').length,
    published: posts.filter(p => p.status === 'published').length,
  };
}

export async function publishDueScheduled({ dryRun = false, limit = 10, now: nowValue = null, canaryId = null, readinessCheck = null } = {}) {
  const normalizedLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 25);
  const now = nowValue ? new Date(nowValue) : new Date();
  const posts = await getScheduledPosts();
  const overduePosts = posts.filter(p => isDue(p, now));
  const requestedCanaryId = String(canaryId || '').trim();
  const canaryOnly = process.env.PUBLISH_CANARY_ONLY === 'true';
  if (canaryOnly && !requestedCanaryId) {
    return {
      success: true,
      dryRun: true,
      autopublish_enabled: isAutopublishEnabled(),
      publish_blocked: true,
      canary_id_required: true,
      checked_at: new Date().toISOString(),
      due_count: 0,
      overdue_total: overduePosts.length,
      skipped_unapproved_count: overduePosts.length,
      results: [],
      message: 'Canary-only publish mode requires one explicit canary_id; no posts were published.',
    };
  }
  const scopedOverduePosts = requestedCanaryId
    ? overduePosts.filter(post => String(post.id || '') === requestedCanaryId)
    : overduePosts;
  const duePosts = scopedOverduePosts.filter(p => isPublishableDue(p, now)).slice(0, requestedCanaryId ? 1 : normalizedLimit);
  const skippedUnapproved = Math.max(0, overduePosts.length - duePosts.length);
  const autopublishEnabled = isAutopublishEnabled();
  const effectiveDryRun = dryRun || !autopublishEnabled;
  const dryRunResults = duePosts.map(p => ({
    id: p.id,
    platform: p.platform,
    scheduled_at: p.scheduled_at,
    listing_title: p.listing_title,
    status: p.status || 'draft',
    ...classifyScheduledPost(p, now),
  }));
  const results = [];

  // Phase 2A safety guard: scheduler/cron/manual publish checks may report due posts,
  // but real external publishing is a no-op unless AUTOPUBLISH_ENABLED is explicitly "true".
  if (effectiveDryRun) {
    return {
      success: true,
      dryRun: true,
      autopublish_enabled: autopublishEnabled,
      publish_blocked: !autopublishEnabled,
      checked_at: new Date().toISOString(),
      due_count: duePosts.length,
      overdue_total: overduePosts.length,
      skipped_unapproved_count: skippedUnapproved,
      canary_id: requestedCanaryId || null,
      results: dryRunResults,
      message: autopublishEnabled
        ? 'Dry run only; no posts were published.'
        : 'Autopublish disabled; no posts were published. Set AUTOPUBLISH_ENABLED=true only after explicit Phase 3 approval.',
    };
  }

  for (const post of duePosts) {
    let lock = null;
    try {
      lock = await acquirePublishLock(post.id);
      if (!lock) {
        results.push({
          id: post.id,
          platform: post.platform,
          success: false,
          skipped: true,
          locked: true,
          error: 'Publish already claimed by another scheduler run.',
        });
        continue;
      }
      let latestPosts = await getScheduledPosts();
      let idx = latestPosts.findIndex(p => String(p.id) === String(post.id));
      if (idx < 0 || !isPublishableDue(latestPosts[idx], now)) {
        results.push({
          id: post.id,
          platform: post.platform,
          success: false,
          skipped: true,
          error: 'Scheduled record changed before publish claim completed.',
        });
        continue;
      }
      const currentPost = latestPosts[idx];
      if (typeof readinessCheck !== 'function') {
        throw new Error('Final server-side publish readiness check is required before external publishing.');
      }
      const readiness = await readinessCheck(currentPost, { now });
      if (readiness?.ready_for_publish !== true) {
        const blockerCodes = (Array.isArray(readiness?.blockers) ? readiness.blockers : [])
          .map(item => String(item?.code || '').trim())
          .filter(Boolean);
        const blockedAt = new Date().toISOString();
        const metadata = currentPost.metadata && typeof currentPost.metadata === 'object' && !Array.isArray(currentPost.metadata)
          ? currentPost.metadata
          : {};
        const blockedPost = await mutateScheduledPost(currentPost.id, (record, records, recordIndex) => {
          records[recordIndex] = {
            ...record,
            status: 'paused',
            approved_for_publish: false,
            approval_source: null,
            last_error: `Final publish readiness blocked: ${blockerCodes.join(', ') || 'unknown blocker'}`,
            last_attempt_at: blockedAt,
            metadata: {
              ...metadata,
              auto_publish_after_review_window: false,
              auto_publish_armed: false,
              auto_publish_disarmed_at: blockedAt,
            },
          };
          return records[recordIndex];
        }, { expectedRecord: currentPost });
        results.push({
          id: currentPost.id,
          platform: currentPost.platform,
          success: false,
          blocked: true,
          error: blockedPost.last_error,
          blockers: Array.isArray(readiness?.blockers) ? readiness.blockers : [],
        });
        continue;
      }
      const publishAttemptId = String(currentPost.platform || '').toLowerCase() === 'pinterest'
        ? `${String(currentPost.id || 'post').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80)}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
        : '';
      const publishPost = await mutateScheduledPost(currentPost.id, (record, records, recordIndex) => {
        records[recordIndex] = {
          ...record,
          status: 'publishing',
          last_attempt_at: new Date().toISOString(),
          ...(publishAttemptId ? {
            publish_result: {
              method: 'Make.com Pinterest bridge',
              status: 'dispatching',
              callback_attempt_id: publishAttemptId,
            },
          } : {}),
        };
        return records[recordIndex];
      }, { expectedRecord: currentPost });
      const result = await publishViaBestService(publishPost);
      const queued = result?.queued === true || result?.published === false;
      const finalMutation = await mutateScheduledPost(currentPost.id, (record, records, recordIndex) => {
        const callbackAlreadyApplied = Boolean(
          publishAttemptId
          && record.callback_at
          && String(record?.publish_result?.callback_attempt_id || '') === publishAttemptId,
        );
        if (callbackAlreadyApplied) return { callbackOutcome: record };
        records[recordIndex] = queued
          ? { ...record, status: 'queued_external', queued_at: new Date().toISOString(), publish_method: result.method, publish_result: result, last_error: null }
          : { ...record, status: 'published', published_at: new Date().toISOString(), publish_method: result.method, publish_result: result, last_error: null };
        return { callbackOutcome: null };
      }, { allowMissing: true });
      const callbackOutcome = finalMutation?.callbackOutcome || null;
      if (!queued) await recordPost(currentPost, result).catch(() => {});
      const callbackFailed = String(callbackOutcome?.status || '').toLowerCase() === 'failed';
      const callbackPublished = String(callbackOutcome?.status || '').toLowerCase() === 'published';
      results.push({
        id: currentPost.id,
        platform: currentPost.platform,
        success: !callbackFailed,
        method: callbackOutcome?.publish_method || result.method,
        queued: callbackOutcome ? !callbackPublished && !callbackFailed : queued,
        ...(callbackFailed ? { error: callbackOutcome.last_error || 'Make.com callback reported failure' } : {}),
      });
    } catch (e) {
      const queueCoordinationFailure = String(e?.code || '').startsWith('SOCIAL_QUEUE_');
      if (!queueCoordinationFailure) {
        await mutateScheduledPost(post.id, (record, records, recordIndex) => {
          if (String(record.status || '').toLowerCase() === 'published') return record;
          records[recordIndex] = { ...record, status: 'failed', last_error: e.message, last_attempt_at: new Date().toISOString() };
          return records[recordIndex];
        }, { allowMissing: true }).catch(() => {});
      }
      results.push({ id: post.id, platform: post.platform, success: false, error: e.message });
    } finally {
      await releasePublishLock(lock);
      lock = null;
    }
  }

  return {
    success: true,
    dryRun: false,
    autopublish_enabled: autopublishEnabled,
    publish_blocked: false,
    checked_at: new Date().toISOString(),
    due_count: duePosts.length,
    overdue_total: overduePosts.length,
    skipped_unapproved_count: skippedUnapproved,
    canary_id: requestedCanaryId || null,
    results,
  };
}
