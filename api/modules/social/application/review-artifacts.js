import crypto from 'crypto';
import { normalizeSocialPlatformId } from '../../../_social-platform-capabilities.js';

export const SOCIAL_REVIEW_CONTRACT_VERSION = 2;
export const SOCIAL_REVIEW_ARTIFACT_TTL_SECONDS = 6 * 60 * 60;

const SOCIAL_REVIEW_ARTIFACT_ID_RE = /^sra_[a-f0-9]{32}$/;

export function socialHermesReviewContentDigest(record = {}) {
  const mediaItems = (Array.isArray(record.media_items) ? record.media_items : []).map(item => {
    const media = item && typeof item === 'object' && !Array.isArray(item) ? item : { url: item };
    return {
      url: String(media.url || '').trim(),
      checksum_sha256: String(media.checksum_sha256 || '').trim().toLowerCase(),
      source: String(media.source || '').trim().toLowerCase(),
      type: String(media.type || '').trim().toLowerCase(),
    };
  });
  const canonical = {
    platform: normalizeSocialPlatformId(record.platform || ''),
    caption: String(record.caption || ''),
    media_items: mediaItems,
    custom_image_url: String(record.custom_image_url || '').trim(),
    generated_image_url: String(record.generated_image_url || '').trim(),
    listing_image_url: String(record.listing_image_url || '').trim(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function socialHermesArtifactHash(value) {
  const canonical = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value;
  return crypto.createHash('sha256').update(JSON.stringify(canonical ?? null)).digest('hex');
}

function socialHermesArtifactContentDigest(record = {}) {
  return socialHermesReviewContentDigest({
    platform: record.platform,
    caption: record.caption,
    media_items: record.media_items,
  });
}

function defaultReviewArtifactSecret() {
  const secret = String(process.env.SOCIAL_REVIEW_ARTIFACT_SECRET || process.env.SESSION_SECRET || '');
  return secret.length >= 32 ? secret : '';
}

export function withoutCallerSuppliedSocialReviewTrust(metadata = {}) {
  const clean = { ...metadata };
  for (const key of [
    'ai_caption_quality_review_required',
    'ai_caption_quality_review',
    'ai_campaign_visual_quality_review_required',
    'ai_campaign_visual_quality_review',
    'ai_review_artifact',
    'ai_review_artifact_id',
    'ai_review_contract_version',
    'ai_review_artifact_verified_at',
    'media_strategy',
  ]) delete clean[key];
  return clean;
}

export function createSocialReviewArtifactService({
  repository,
  secret = defaultReviewArtifactSecret,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const signArtifactId = id => {
    const signingSecret = String(typeof secret === 'function' ? secret() : secret || '');
    if (signingSecret.length < 32) {
      throw new Error('A server-only SOCIAL_REVIEW_ARTIFACT_SECRET or SESSION_SECRET is required.');
    }
    return crypto.createHmac('sha256', signingSecret).update(id).digest('base64url');
  };

  const issue = async (plan, variant) => {
    const captionReview = variant?.caption_quality_review;
    const campaignReview = plan?.campaign_quality_review;
    const mediaStrategy = plan?.media_strategy;
    if (plan?.status !== 'ready_for_review'
      || variant?.readiness !== 'media_ready'
      || captionReview?.approved !== true
      || String(captionReview?.decision || '').toLowerCase() !== 'approve'
      || campaignReview?.approved !== true
      || String(campaignReview?.decision || '').toLowerCase() !== 'approve'
      || Number(campaignReview?.quality_contract_version) !== SOCIAL_REVIEW_CONTRACT_VERSION
      || campaignReview?.campaign_goal_met !== true
      || !Array.isArray(campaignReview?.blocking_reasons)
      || campaignReview.blocking_reasons.length > 0
      || !mediaStrategy || typeof mediaStrategy !== 'object' || Array.isArray(mediaStrategy)) return null;

    const id = `sra_${randomBytes(16).toString('hex')}`;
    const issuedAt = Number(now());
    const artifact = {
      version: SOCIAL_REVIEW_CONTRACT_VERSION,
      id,
      issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(issuedAt + SOCIAL_REVIEW_ARTIFACT_TTL_SECONDS * 1000).toISOString(),
      content_digest: socialHermesArtifactContentDigest(variant),
      caption_review: captionReview,
      caption_review_digest: socialHermesArtifactHash(captionReview),
      campaign_review: campaignReview,
      campaign_review_digest: socialHermesArtifactHash(campaignReview),
      media_strategy: mediaStrategy,
      media_strategy_digest: socialHermesArtifactHash(mediaStrategy),
    };
    await repository.saveArtifact(id, artifact, SOCIAL_REVIEW_ARTIFACT_TTL_SECONDS);
    return `${id}.${signArtifactId(id)}`;
  };

  const consume = async (record = {}, metadata = {}) => {
    const token = String(metadata.ai_review_artifact || '').trim();
    if (!token) return { metadata: withoutCallerSuppliedSocialReviewTrust(metadata), verified: false };
    const [id, signature, ...extra] = token.split('.');
    if (extra.length || !SOCIAL_REVIEW_ARTIFACT_ID_RE.test(id || '') || !signature) {
      const error = new Error('The AI review artifact is malformed.');
      error.code = 'AI_REVIEW_ARTIFACT_INVALID';
      throw error;
    }
    const expected = signArtifactId(id);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
      const error = new Error('The AI review artifact signature is invalid.');
      error.code = 'AI_REVIEW_ARTIFACT_INVALID';
      throw error;
    }
    const artifact = await repository.getArtifact(id);
    const expiresAt = new Date(artifact?.expires_at || '').getTime();
    if (!artifact || !Number.isFinite(expiresAt) || expiresAt <= Number(now())) {
      const error = new Error('The AI review artifact is missing or expired.');
      error.code = 'AI_REVIEW_ARTIFACT_EXPIRED';
      throw error;
    }
    if (Number(artifact.version) !== SOCIAL_REVIEW_CONTRACT_VERSION
      || Number(artifact.campaign_review?.quality_contract_version) !== SOCIAL_REVIEW_CONTRACT_VERSION) {
      const error = new Error('The AI review artifact uses an obsolete quality contract and must be regenerated.');
      error.code = 'AI_REVIEW_ARTIFACT_OBSOLETE';
      throw error;
    }
    if (artifact.content_digest !== socialHermesArtifactContentDigest(record)
      || artifact.caption_review_digest !== socialHermesArtifactHash(artifact.caption_review)
      || artifact.campaign_review_digest !== socialHermesArtifactHash(artifact.campaign_review)
      || artifact.media_strategy_digest !== socialHermesArtifactHash(artifact.media_strategy)) {
      const error = new Error('The AI review artifact does not match the exact caption, media, and server review.');
      error.code = 'AI_REVIEW_ARTIFACT_CONTENT_CHANGED';
      throw error;
    }
    const consumedAt = new Date(Number(now())).toISOString();
    const consumed = await repository.claimArtifact(id, {
      record_id: String(record.id || ''),
      consumed_at: consumedAt,
    }, SOCIAL_REVIEW_ARTIFACT_TTL_SECONDS);
    if (!consumed) {
      const error = new Error('The AI review artifact has already been consumed.');
      error.code = 'AI_REVIEW_ARTIFACT_REPLAYED';
      throw error;
    }
    return {
      verified: true,
      metadata: {
        ...withoutCallerSuppliedSocialReviewTrust(metadata),
        ai_caption_quality_review_required: true,
        ai_caption_quality_review: artifact.caption_review,
        ai_campaign_visual_quality_review_required: true,
        ai_campaign_visual_quality_review: artifact.campaign_review,
        media_strategy: artifact.media_strategy,
        ai_review_artifact_id: id,
        ai_review_contract_version: SOCIAL_REVIEW_CONTRACT_VERSION,
        ai_review_artifact_verified_at: new Date(Number(now())).toISOString(),
      },
    };
  };

  return { issue, consume };
}
