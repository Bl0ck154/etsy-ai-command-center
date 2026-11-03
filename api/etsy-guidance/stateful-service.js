import { generateWithExternalAi } from '../_external-ai.js';
import { etsyGuidanceRepository } from '../_etsy-guidance-state.js';
import { invalidateEtsyGuidanceCache } from './active-cache.js';
import { generateEtsyGuidanceCandidateRules } from './candidate-generator.js';
import { ETSY_GUIDANCE_RULE_GROUPS } from './rule-contracts.js';
import {
  baselineSnapshot,
  isoNow,
  reviewedMonth,
  sourceArrayFromMap,
} from './source-contracts.js';
import {
  candidateDigest,
  publicEtsyGuidanceSnapshot,
  validateStoredSnapshot,
} from './snapshot-contracts.js';
import { fetchOfficialEtsyGuidanceSource } from './source-reader.js';

function revisionConflictError(expected, actual) {
  const error = new Error(`Etsy guidance state changed from revision ${expected} to ${actual}; retry the refresh.`);
  error.code = 'ETSY_GUIDANCE_STATE_CHANGED';
  error.status = 409;
  return error;
}

export async function getActiveEtsyGuidanceState() {
  const state = await etsyGuidanceRepository.read();
  return validateStoredSnapshot(state.active, 'active') || baselineSnapshot();
}

export async function getEtsyGuidanceStatusV2() {
  const state = await etsyGuidanceRepository.read();
  const active = validateStoredSnapshot(state.active, 'active') || baselineSnapshot();
  const candidate = validateStoredSnapshot(state.candidate, 'candidate');
  const monitor = state.monitor || {};
  const lastCheckedAt = monitor.lastCheckedAt || null;
  const stale = !lastCheckedAt
    || (Date.now() - Date.parse(lastCheckedAt)) > 60 * 24 * 60 * 60 * 1000;
  return {
    active: publicEtsyGuidanceSnapshot(active),
    candidate: publicEtsyGuidanceSnapshot(candidate),
    monitor: {
      lastCheckedAt,
      lastError: monitor.lastError || null,
      changed: monitor.changed === true,
      stale,
      nextAutomaticCheck: 'Monthly on the first day at 04:20 server time',
    },
    officialSources: sourceArrayFromMap(),
  };
}

export async function refreshEtsyGuidanceV2({
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
    const hashes = Object.fromEntries(
      fetchedSources.map(source => [source.id, source.contentHash]),
    );
    const before = await etsyGuidanceRepository.readSnapshot();
    const previousMonitor = before.state.monitor || {};
    const changed = force || !previousMonitor.sourceHashes
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
      await etsyGuidanceRepository.update(state => ({
        ...state,
        monitor: checkedState,
      }));
      return getEtsyGuidanceStatusV2();
    }

    const active = validateStoredSnapshot(before.state.active, 'active') || baselineSnapshot();
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
    await etsyGuidanceRepository.update((state, metadata) => {
      if (metadata.revision !== before.revision) {
        throw revisionConflictError(before.revision, metadata.revision);
      }
      return {
        ...state,
        candidate,
        monitor: { ...checkedState, candidateId: candidate.id },
      };
    });
    return getEtsyGuidanceStatusV2();
  } catch (error) {
    await etsyGuidanceRepository.update(state => ({
      ...state,
      monitor: {
        ...(state.monitor || {}),
        schemaVersion: 1,
        lastCheckStartedAt: startedAt,
        lastCheckedAt: isoNow(),
        lastError: String(error?.message || error).slice(0, 500),
      },
    })).catch(() => {});
    throw error;
  }
}

export async function approveEtsyGuidanceCandidateV2({
  actorId = '',
  candidateId = '',
  digest = '',
} = {}) {
  await etsyGuidanceRepository.update(state => {
    const candidate = validateStoredSnapshot(state.candidate, 'candidate');
    if (!candidate) throw new Error('No valid Etsy guidance candidate is available');
    if (!candidateId || candidate.id !== candidateId) {
      throw new Error('The Etsy guidance candidate changed; reload before approving');
    }
    if (!digest || candidate.digest !== digest || candidateDigest(candidate) !== digest) {
      throw new Error('The Etsy guidance candidate integrity check failed');
    }
    const active = {
      ...candidate,
      status: 'active',
      activatedAt: isoNow(),
      activatedBy: String(actorId || 'owner').slice(0, 80),
    };
    return {
      ...state,
      active,
      candidate: null,
      history: [active, ...(Array.isArray(state.history) ? state.history : [])].slice(0, 20),
    };
  });
  invalidateEtsyGuidanceCache();
  return getEtsyGuidanceStatusV2();
}

export async function dismissEtsyGuidanceCandidateV2({
  actorId = '',
  candidateId = '',
  digest = '',
} = {}) {
  await etsyGuidanceRepository.update(state => {
    const candidate = validateStoredSnapshot(state.candidate, 'candidate');
    if (!candidate
      || candidate.id !== candidateId
      || candidate.digest !== digest
      || candidateDigest(candidate) !== digest) {
      throw new Error('The Etsy guidance candidate changed; reload before dismissing');
    }
    return {
      ...state,
      candidate: null,
      monitor: {
        ...(state.monitor || {}),
        candidateId: null,
        dismissedCandidateId: candidate.id,
        dismissedAt: isoNow(),
        dismissedBy: String(actorId || 'owner').slice(0, 80),
      },
    };
  });
  return getEtsyGuidanceStatusV2();
}

export async function restoreBundledEtsyGuidanceV2(actorId = '') {
  await etsyGuidanceRepository.update(state => ({
    ...state,
    active: null,
    candidate: null,
    monitor: {
      ...(state.monitor || {}),
      restoredBundledAt: isoNow(),
      restoredBundledBy: String(actorId || 'owner').slice(0, 80),
    },
  }));
  invalidateEtsyGuidanceCache();
  return getEtsyGuidanceStatusV2();
}

export const __etsyGuidanceStatefulForTest = {
  RULE_GROUPS: ETSY_GUIDANCE_RULE_GROUPS,
  baselineSnapshot,
  candidateDigest,
  validateStoredSnapshot,
};
