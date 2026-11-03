import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import {
  recordSocialOwnerReviewSuccessfulReviewCardRenderSpecs,
  socialOwnerReviewReviewCardRepairProblem,
} from '../api/modules/social/domain/review-card-repair-contract.js';

test('review-card repair allows one explicit fingerprint change and then stops the loop', () => {
  const seen = new Map();
  const initial = {
    id: 'review_frame',
    renderer: 'review_card',
    render_spec_sha256: 'a'.repeat(64),
  };
  const replacement = {
    ...initial,
    render_spec_sha256: 'b'.repeat(64),
  };
  const replacementPlan = {
    media_strategy: {
      accepted_asset_decisions: [{ brief_id: 'review_frame', decision: 'discard' }],
    },
  };

  expect(socialOwnerReviewReviewCardRepairProblem(initial, {}, seen)).toBe('');
  recordSocialOwnerReviewSuccessfulReviewCardRenderSpecs(
    [[initial, { renderer: 'review_card', render_spec_sha256: 'a'.repeat(64) }]],
    [{ brief_id: 'review_frame' }],
    seen,
  );
  expect(socialOwnerReviewReviewCardRepairProblem(replacement, replacementPlan, seen)).toBe('');
  recordSocialOwnerReviewSuccessfulReviewCardRenderSpecs(
    [[replacement, { renderer: 'review_card', render_spec_sha256: 'b'.repeat(64) }]],
    [{ brief_id: 'review_frame' }],
    seen,
  );
  expect(socialOwnerReviewReviewCardRepairProblem({
    ...replacement,
    render_spec_sha256: 'c'.repeat(64),
  }, replacementPlan, seen)).toContain('more than once');
});

test('review-card repair rejects identical deterministic rerender and implicit fingerprint change', () => {
  const seen = new Map();
  const brief = {
    id: 'review_frame',
    renderer: 'review_card',
    render_spec_sha256: 'a'.repeat(64),
  };

  expect(socialOwnerReviewReviewCardRepairProblem(brief, {}, seen)).toBe('');
  recordSocialOwnerReviewSuccessfulReviewCardRenderSpecs(
    [[brief, { renderer: 'review_card', render_spec_sha256: 'a'.repeat(64) }]],
    [{ brief_id: 'review_frame' }],
    seen,
  );
  expect(socialOwnerReviewReviewCardRepairProblem(brief, {}, seen)).toContain('identical');
  expect(socialOwnerReviewReviewCardRepairProblem({
    ...brief,
    render_spec_sha256: 'b'.repeat(64),
  }, {}, seen)).toContain('without explicitly discarding');
});

test('failed review-card render does not consume its fingerprint', () => {
  const seen = new Map();
  const brief = {
    id: 'review_frame',
    renderer: 'review_card',
    render_spec_sha256: 'a'.repeat(64),
  };

  recordSocialOwnerReviewSuccessfulReviewCardRenderSpecs(
    [[brief, { renderer: 'review_card', render_spec_sha256: 'a'.repeat(64) }]],
    [],
    seen,
  );

  expect(seen.size).toBe(0);
  expect(socialOwnerReviewReviewCardRepairProblem(brief, {}, seen)).toBe('');
});

test('review-card repair contract ignores non-review renderers and rejects missing stable identity', () => {
  expect(socialOwnerReviewReviewCardRepairProblem({ renderer: 'external_ai' }, {}, new Map())).toBe('');
  expect(socialOwnerReviewReviewCardRepairProblem({ renderer: 'review_card' }, {}, new Map())).toContain('stable brief id');
  expect(socialOwnerReviewReviewCardRepairProblem({
    id: 'review_frame',
    renderer: 'review_card',
    render_spec_sha256: 'not-a-sha',
  }, {}, new Map())).toContain('render fingerprint');
});

test('review-card repair guard has no renderer, AI, HTTP, queue, worker or publisher dependency', () => {
  const source = readFileSync(new URL('../api/modules/social/domain/review-card-repair-contract.js', import.meta.url), 'utf8');
  expect(source).not.toMatch(/renderSocial|external-ai|generateWith|fetch\s*\(|api\/social|queue\.js|workers\/|publishDue|social-publisher/i);
});
