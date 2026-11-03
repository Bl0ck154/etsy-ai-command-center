import crypto from 'node:crypto';

import { sourceArrayFromMap, sourceMapFromArray } from './source-contracts.js';
import { validateEtsyGuidanceRules } from './rule-contracts.js';

export function candidateDigest(candidate) {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: candidate.schemaVersion,
    id: candidate.id,
    reviewedAt: candidate.reviewedAt,
    rules: candidate.rules,
    evidence: candidate.evidence,
    sources: candidate.sources?.map(source => ({
      id: source.id,
      url: source.url,
      contentHash: source.contentHash,
    })),
  })).digest('hex');
}

export function validateStoredSnapshot(snapshot, expectedStatus = 'active') {
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.status !== expectedStatus) return null;
  if (
    snapshot.origin === 'official-source-refresh'
    && (!snapshot.digest || snapshot.digest !== candidateDigest(snapshot))
  ) return null;
  try {
    const suppliedSources = new Map(
      (Array.isArray(snapshot.sources) ? snapshot.sources : []).map(source => [source?.id, source]),
    );
    const sources = sourceArrayFromMap(sourceMapFromArray(snapshot.sources)).map(source => {
      const supplied = suppliedSources.get(source.id) || {};
      return {
        ...source,
        ...(typeof supplied.contentHash === 'string' && /^[a-f0-9]{64}$/.test(supplied.contentHash)
          ? { contentHash: supplied.contentHash }
          : {}),
        ...(supplied.fetchedAt ? { fetchedAt: supplied.fetchedAt } : {}),
      };
    });
    return {
      ...snapshot,
      rules: validateEtsyGuidanceRules(snapshot.rules),
      sources,
    };
  } catch {
    return null;
  }
}

export function publicEtsyGuidanceSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    status: snapshot.status,
    origin: snapshot.origin,
    reviewedAt: snapshot.reviewedAt,
    createdAt: snapshot.createdAt || null,
    activatedAt: snapshot.activatedAt || null,
    activatedBy: snapshot.activatedBy || null,
    changeSummary: snapshot.changeSummary || null,
    digest: snapshot.digest || null,
    evidence: snapshot.evidence || [],
    rules: snapshot.rules,
    sources: snapshot.sources,
  };
}
