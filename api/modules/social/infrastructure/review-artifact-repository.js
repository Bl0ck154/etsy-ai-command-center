import { kvGet, kvSet, kvSetNx } from '../../../kv.js';
import { SOCIAL_REVIEW_ARTIFACT_TTL_SECONDS } from '../application/review-artifacts.js';

export function createSocialReviewArtifactRepository({
  get = kvGet,
  set = kvSet,
  setNx = kvSetNx,
} = {}) {
  return {
    getArtifact(id) {
      return get(`social_review_artifact:${id}`);
    },

    saveArtifact(id, artifact, ttlSeconds = SOCIAL_REVIEW_ARTIFACT_TTL_SECONDS) {
      return set(`social_review_artifact:${id}`, artifact, ttlSeconds);
    },

    claimArtifact(id, claim, ttlSeconds = SOCIAL_REVIEW_ARTIFACT_TTL_SECONDS) {
      return setNx(`social_review_artifact_consumed:${id}`, claim, ttlSeconds);
    },
  };
}

export const socialReviewArtifactRepository = createSocialReviewArtifactRepository();
