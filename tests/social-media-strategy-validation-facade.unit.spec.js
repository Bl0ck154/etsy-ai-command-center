import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('social facade delegates media strategy validation to the Social domain rules owner', () => {
  const source = readFileSync(new URL('../api/social.js', import.meta.url), 'utf8');

  expect(source).toContain('createSocialMediaStrategyValidationRules,');
  expect(source).toContain('const socialMediaStrategyValidationRules = createSocialMediaStrategyValidationRules({');
  expect(source).toContain('return socialMediaStrategyValidationRules.valid(strategy, platforms);');
  expect(source).toContain('return socialMediaStrategyValidationRules.structuralProblems(strategy, platforms);');
  expect(source).toContain('return socialMediaStrategyValidationRules.visionSelectionProblems(strategy, visualAnalysis);');
  expect(source).toContain('return socialMediaStrategyValidationRules.capabilityProblems(strategy, context);');
  expect(source).toContain('return socialMediaStrategyValidationRules.platformRatioProblems(strategy, platforms);');
  expect(source).toContain('return socialMediaStrategyValidationRules.acceptedAssetDecisionProblems(strategy, context);');
  expect(source).toContain('return socialMediaStrategyValidationRules.buyerEvidenceProblems(strategy, context);');

  expect(source).not.toContain("problems.push('frames must contain 1-7 items')");
  expect(source).not.toContain('selected image model cannot preserve external reference pixels; choose a reference-capable model');
  expect(source).not.toContain('accepted asset ${briefId}: explicit reuse/discard decision missing');
  expect(source).not.toContain('buyer_evidence_frame_ids missing');
  expect(source).not.toContain('AI vision marked listing image rank ${frame.reference_media_rank} do_not_use for this campaign');
});
