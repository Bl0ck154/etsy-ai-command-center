import {
  buildEtsyListingStandardsPrompt,
  buildEtsyOwnerGuidanceDisclosurePrompt,
  buildEtsyTitleStandardsPrompt,
} from '../agent/etsy-standards.js';
import { baselineSnapshot, sourceMapFromArray } from './source-contracts.js';
import { validateStoredSnapshot } from './snapshot-contracts.js';

export function guidanceRuntimePrompt(snapshot = baselineSnapshot()) {
  const safe = validateStoredSnapshot(snapshot, snapshot.status) || baselineSnapshot();
  const sources = sourceMapFromArray(safe.sources);
  return {
    standards: buildEtsyListingStandardsPrompt({
      reviewedAt: safe.reviewedAt,
      sources,
      rules: safe.rules,
    }),
    disclosure: buildEtsyOwnerGuidanceDisclosurePrompt({
      reviewedAt: safe.reviewedAt,
      sources,
    }),
    title: buildEtsyTitleStandardsPrompt({
      reviewedAt: safe.reviewedAt,
      sources,
      rules: safe.rules,
    }),
  };
}

export function applyActiveEtsyGuidance(basePrompt, activePrompt, bundledPrompt) {
  if (!activePrompt || activePrompt === bundledPrompt) return basePrompt;
  if (String(basePrompt).includes(bundledPrompt)) {
    return String(basePrompt).replace(bundledPrompt, activePrompt);
  }
  return `${basePrompt}\n\n${activePrompt}`;
}
