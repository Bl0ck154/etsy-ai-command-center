import { generateWithExternalAi } from './_external-ai.js';
import { kvGet, kvSet } from './kv.js';
import {
  getActiveEtsyGuidance,
  invalidateEtsyGuidanceCache,
} from './etsy-guidance/active-cache.js';
import {
  buildEtsyGuidanceEvidenceIndex,
  generateEtsyGuidanceCandidateRules,
  validateGeneratedEtsyGuidanceCandidate,
} from './etsy-guidance/candidate-generator.js';
import {
  normalizeEtsyGuidanceRules,
  validateEtsyGuidanceRules,
} from './etsy-guidance/rule-contracts.js';
import {
  applyActiveEtsyGuidance,
  guidanceRuntimePrompt,
} from './etsy-guidance/runtime-prompt.js';
import {
  baselineSnapshot,
  isoNow,
  reviewedMonth,
  sourceArrayFromMap,
} from './etsy-guidance/source-contracts.js';
import {
  candidateDigest,
  publicEtsyGuidanceSnapshot,
  validateStoredSnapshot,
} from './etsy-guidance/snapshot-contracts.js';
import {
  extractEtsyGuidanceText,
  fetchOfficialEtsyGuidanceSource,
  hashEtsyGuidanceText,
} from './etsy-guidance/source-reader.js';

const ACTIVE_KEY = 'etsy_guidance:active';
const CANDIDATE_KEY = 'etsy_guidance:candidate';
const MONITOR_KEY = 'etsy_guidance:monitor';
const HISTORY_KEY = 'etsy_guidance:history';

export {
  applyActiveEtsyGuidance,
  buildEtsyGuidanceEvidenceIndex,
  extractEtsyGuidanceText,
  fetchOfficialEtsyGuidanceSource,
  getActiveEtsyGuidance,
  guidanceRuntimePrompt,
  hashEtsyGuidanceText,
  invalidateEtsyGuidanceCache,
  normalizeEtsyGuidanceRules,
  validateEtsyGuidanceRules,
  validateGeneratedEtsyGuidanceCandidate,
};

export async function refreshEtsyGuidance({
  force = false,
  fetchImpl = fetch,
  generateImpl = generateWithExternalAi,
} = {}) {
  const startedAt = isoNow();
  const sourceDefinitions = sourceArrayFromMap();
  try {
    const fetchedSources = await Promise.all(
      sourceDefinitions.map(source => fetchOfficialEtsyGuidanceSource(source, fetchImpl)),
    );
    const hashes = Object.fromEntries(fetchedSources.map(source => [source.id, source.contentHash]));
    const previousMonitor = await kvGet(MONITOR_KEY).catch(() => null);
    const changed = force || !previousMonitor?.sourceHashes
      || sourceDefinitions.some(source => previousMonitor.sourceHashes[source.id] !== hashes[source.id]);
    const checkedState = {
      schemaVersion: 1,
      lastCheckedAt: isoNow(),
      lastCheckStartedAt: startedAt,
      lastError: null,
      sourceHashes: hashes,
      changed,
    };
    if (!changed) {
      await kvSet(MONITOR_KEY, checkedState);
      return getEtsyGuidanceStatus({ fresh: true });
    }

    const active = await getActiveEtsyGuidance({ fresh: true });
    const generated = await generateEtsyGuidanceCandidateRules(
      fetchedSources,
      active.rules,
      generateImpl,
    );
    const candidate = {
      schemaVersion: 1,
      id: `etsy-guidance-${Date.now().toString(36)}`,
      status: 'candidate',
      origin: 'official-source-refresh',
      reviewedAt: reviewedMonth(),
      createdAt: isoNow(),
      changeSummary: generated.changeSummary,
      rules: generated.rules,
      evidence: generated.evidence,
      sources: fetchedSources.map(({ text, ...source }) => source),
    };
    candidate.digest = candidateDigest(candidate);
    await kvSet(CANDIDATE_KEY, candidate);
    await kvSet(MONITOR_KEY, { ...checkedState, candidateId: candidate.id });
    return getEtsyGuidanceStatus({ fresh: true });
  } catch (error) {
    const previousMonitor = await kvGet(MONITOR_KEY).catch(() => null);
    await kvSet(MONITOR_KEY, {
      ...(previousMonitor || {}),
      schemaVersion: 1,
      lastCheckStartedAt: startedAt,
      lastCheckedAt: isoNow(),
      lastError: String(error?.message || error).slice(0, 500),
    }).catch(() => {});
    throw error;
  }
}

export async function approveEtsyGuidanceCandidate({ actorId = '', candidateId = '', digest = '' } = {}) {
  const candidate = validateStoredSnapshot(await kvGet(CANDIDATE_KEY), 'candidate');
  if (!candidate) throw new Error('No valid Etsy guidance candidate is available');
  if (!candidateId || candidate.id !== candidateId) throw new Error('The Etsy guidance candidate changed; reload before approving');
  if (!digest || candidate.digest !== digest || candidateDigest(candidate) !== digest) {
    throw new Error('The Etsy guidance candidate integrity check failed');
  }
  const active = {
    ...candidate,
    status: 'active',
    activatedAt: isoNow(),
    activatedBy: String(actorId || 'owner').slice(0, 80),
  };
  const history = await kvGet(HISTORY_KEY).catch(() => []);
  await kvSet(HISTORY_KEY, [active, ...(Array.isArray(history) ? history : [])].slice(0, 20));
  await kvSet(ACTIVE_KEY, active);
  await kvSet(CANDIDATE_KEY, null);
  invalidateEtsyGuidanceCache();
  return getEtsyGuidanceStatus({ fresh: true });
}

export async function dismissEtsyGuidanceCandidate({ actorId = '', candidateId = '', digest = '' } = {}) {
  const candidate = await kvGet(CANDIDATE_KEY).catch(() => null);
  if (!candidate || candidate.id !== candidateId || candidate.digest !== digest || candidateDigest(candidate) !== digest) {
    throw new Error('The Etsy guidance candidate changed; reload before dismissing');
  }
  await kvSet(CANDIDATE_KEY, null);
  const monitor = await kvGet(MONITOR_KEY).catch(() => null);
  await kvSet(MONITOR_KEY, {
    ...(monitor || {}),
    candidateId: null,
    dismissedCandidateId: candidate?.id || null,
    dismissedAt: isoNow(),
    dismissedBy: String(actorId || 'owner').slice(0, 80),
  });
  return getEtsyGuidanceStatus({ fresh: true });
}

export async function restoreBundledEtsyGuidance(actorId = '') {
  await kvSet(ACTIVE_KEY, null);
  await kvSet(CANDIDATE_KEY, null);
  const monitor = await kvGet(MONITOR_KEY).catch(() => null);
  await kvSet(MONITOR_KEY, {
    ...(monitor || {}),
    restoredBundledAt: isoNow(),
    restoredBundledBy: String(actorId || 'owner').slice(0, 80),
  });
  invalidateEtsyGuidanceCache();
  return getEtsyGuidanceStatus({ fresh: true });
}

export async function getEtsyGuidanceStatus({ fresh = false } = {}) {
  const [active, candidateRaw, monitor] = await Promise.all([
    getActiveEtsyGuidance({ fresh }),
    kvGet(CANDIDATE_KEY).catch(() => null),
    kvGet(MONITOR_KEY).catch(() => null),
  ]);
  const candidate = validateStoredSnapshot(candidateRaw, 'candidate');
  const lastCheckedAt = monitor?.lastCheckedAt || null;
  const stale = !lastCheckedAt || (Date.now() - Date.parse(lastCheckedAt)) > 60 * 24 * 60 * 60 * 1000;
  return {
    active: publicEtsyGuidanceSnapshot(active),
    candidate: publicEtsyGuidanceSnapshot(candidate),
    monitor: {
      lastCheckedAt,
      lastError: monitor?.lastError || null,
      changed: monitor?.changed === true,
      stale,
      nextAutomaticCheck: 'Monthly on the first day at 04:20 server time',
    },
    officialSources: sourceArrayFromMap(),
  };
}

export const __etsyGuidanceLegacyForTest = {
  baselineSnapshot,
  candidateDigest,
  validateStoredSnapshot,
};
