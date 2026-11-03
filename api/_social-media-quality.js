import { buildProviderUrl, getExternalAiRuntimeConfig } from './_external-ai.js';
import { SOCIAL_CREATIVE_SHARED_STANDARDS } from './_social-creative-standards.js';

const MAX_CONTEXT_CHARS = 12_000;
const MAX_CAMPAIGN_CONTEXT_CHARS = 24_000;
const MAX_GALLERY_ADJUDICATION_CHARS = 24_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const LISTING_VISION_BATCH_SIZE = 4;
const LISTING_IMAGE_FETCH_TIMEOUT_MS = 20_000;

function cleanText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanStringList(value, maxItems = 8, maxChars = 240) {
  return (Array.isArray(value) ? value : [])
    .map(item => cleanText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function logSocialVisionUsage(task, data = {}, details = {}) {
  const usage = data?.usage && typeof data.usage === 'object' ? data.usage : {};
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = Number(usage.total_tokens);
  console.info('[social-ai-usage]', JSON.stringify({
    task,
    ...details,
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : null,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : null,
    total_tokens: Number.isFinite(totalTokens)
      ? totalTokens
      : (Number.isFinite(promptTokens) && Number.isFinite(completionTokens) ? promptTokens + completionTokens : null),
  }));
}

function parseJsonObject(value) {
  const text = String(value || '').replace(/```(?:json)?|```/gi, '').trim();
  if (!text) throw new Error('Vision quality model returned an empty response.');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  throw new Error('Vision quality model did not return the required JSON object.');
}

function extractText(data = {}) {
  const content = data.choices?.[0]?.message?.content ?? data.output_text ?? data.text ?? '';
  if (Array.isArray(content)) return content.map(part => part?.text || part?.content || '').join('');
  return String(content || '');
}

function extractStructuredToolPayload(data = {}, toolName = '') {
  const calls = data.choices?.[0]?.message?.tool_calls;
  const call = Array.isArray(calls)
    ? calls.find(item => item?.function?.name === toolName)
    : null;
  const args = call?.function?.arguments;
  return parseJsonObject(typeof args === 'string' ? args : extractText(data));
}

function campaignQualityTool(expectedPlatforms = [], expectedMediaKeys = []) {
  const checkSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'rationale'],
    properties: {
      status: { type: 'string', enum: ['pass', 'fail'] },
      rationale: { type: 'string', minLength: 1 },
    },
  };
  const frameReviewSchema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'media_key', 'dominant_visual', 'persuasive_evidence_visible',
      'persuasive_evidence_strength', 'text_or_instruction_dominance',
      'mobile_feed_hook_strength', 'marginal_buyer_value',
      'sequence_position_fit', 'recommended_use', 'rationale',
    ],
    properties: {
      media_key: { type: 'string', enum: expectedMediaKeys },
      dominant_visual: {
        type: 'string',
        minLength: 1,
        description: 'Describe the largest first-second visual idea in the actual pixels, not the planner intent.',
      },
      persuasive_evidence_visible: {
        type: 'boolean',
        description: 'True only when the actual sold product, finished output, transformation, coherent source/result demonstration, or concrete buyer use case is visibly present. Explanatory text, icons, arrows, diagrams, devices, props, and atmosphere alone are false. For a time-based deliverable, one altered or enhanced still is not motion proof.',
      },
      persuasive_evidence_strength: {
        type: 'string',
        enum: ['strong', 'partial', 'absent'],
        description: 'Strength of concrete buyer-facing evidence in the pixels, excluding explanation labels and process atmosphere.',
      },
      text_or_instruction_dominance: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'How much the frame depends on text, labels, diagrams, instructions, or disclosures instead of visual proof.',
      },
      mobile_feed_hook_strength: { type: 'string', enum: ['strong', 'adequate', 'weak'] },
      marginal_buyer_value: { type: 'string', enum: ['strong', 'meaningful', 'low', 'none'] },
      sequence_position_fit: { type: 'string', enum: ['strong', 'acceptable', 'poor'] },
      recommended_use: { type: 'string', enum: ['lead', 'support', 'remove'] },
      rationale: { type: 'string', minLength: 1 },
    },
  };
  const reviewSchema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'platform', 'decision', 'lead_media_key', 'visible_offer_understanding',
      'persuasive_evidence_media_keys', 'package_strength',
      'listing_gallery_repackaging', 'rationale', 'issues',
    ],
    properties: {
      platform: { type: 'string', enum: expectedPlatforms },
      decision: { type: 'string', enum: ['approve', 'replan', 'reject'] },
      lead_media_key: { type: 'string', enum: expectedMediaKeys },
      visible_offer_understanding: { type: 'string', enum: ['clear', 'partial', 'unclear'] },
      persuasive_evidence_media_keys: {
        type: 'array',
        items: { type: 'string', enum: expectedMediaKeys },
        maxItems: expectedMediaKeys.length,
      },
      package_strength: { type: 'string', enum: ['strong', 'adequate', 'weak'] },
      listing_gallery_repackaging: { type: 'boolean' },
      rationale: { type: 'string', minLength: 1 },
      issues: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 8,
        description: 'Unresolved platform-specific defects that prevent publish approval. Put optional observations in rationale instead.',
      },
    },
  };
  return {
    type: 'function',
    function: {
      name: 'submit_campaign_quality_review',
      description: 'Submit the complete visual quality decision for every supplied social platform variant.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [
          'decision', 'confidence', 'campaign_goal_met', 'hook_clarity',
          'offer_demonstration', 'sequence_coherence', 'listing_gallery_dependence',
          'visible_buyer_evidence', 'explanation_card_dependence', 'emotional_tone',
          'text_quality', 'frame_reviews', 'approval_checks', 'platform_reviews',
          'issues', 'required_changes', 'rationale',
        ],
        properties: {
          decision: { type: 'string', enum: ['approve', 'replan', 'reject'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          campaign_goal_met: { type: 'boolean' },
          hook_clarity: { type: 'string' },
          offer_demonstration: { type: 'string' },
          sequence_coherence: { type: 'string' },
          listing_gallery_dependence: { type: 'string' },
          visible_buyer_evidence: {
            type: 'object',
            additionalProperties: false,
            required: ['required_evidence', 'satisfied', 'strength', 'dominant_media_keys', 'rationale'],
            properties: {
              required_evidence: {
                type: 'string',
                minLength: 1,
                description: 'State the concrete product, finished output, transformation, source/result demonstration, or use case the pixels must show.',
              },
              satisfied: {
                type: 'boolean',
                description: 'True only when one or more supplied frames visibly show that concrete evidence. Text or icon explanations alone do not satisfy it. A time-based deliverable needs visibly distinct temporal states or another unambiguous pixel-level representation of change over time.',
              },
              strength: { type: 'string', enum: ['strong', 'adequate', 'weak', 'absent'] },
              dominant_media_keys: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              rationale: { type: 'string', minLength: 1 },
            },
          },
          explanation_card_dependence: {
            type: 'object',
            additionalProperties: false,
            required: ['level', 'rationale'],
            properties: {
              level: { type: 'string', enum: ['none', 'supporting', 'dominant'] },
              rationale: { type: 'string', minLength: 1 },
            },
          },
          frame_reviews: {
            type: 'array',
            minItems: expectedMediaKeys.length,
            maxItems: expectedMediaKeys.length,
            items: frameReviewSchema,
          },
          approval_checks: {
            type: 'object',
            additionalProperties: false,
            required: ['compelling_lead', 'visible_evidence', 'distinct_progression', 'not_gallery_repackaging'],
            properties: {
              compelling_lead: checkSchema,
              visible_evidence: checkSchema,
              distinct_progression: checkSchema,
              not_gallery_repackaging: checkSchema,
            },
          },
          emotional_tone: { type: 'string' },
          text_quality: { type: 'string' },
          platform_reviews: {
            type: 'array',
            minItems: expectedPlatforms.length,
            maxItems: expectedPlatforms.length,
            items: reviewSchema,
          },
          issues: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 12,
            description: 'Unresolved campaign defects that prevent publish approval. An approve decision requires this array to be empty.',
          },
          required_changes: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 12,
            description: 'Changes required before publish approval. An approve decision requires this array to be empty.',
          },
          rationale: { type: 'string', minLength: 1 },
        },
      },
    },
  };
}

function isTrustedEtsyImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (host === 'etsy.com' || host.endsWith('.etsy.com') || host === 'etsystatic.com' || host.endsWith('.etsystatic.com'));
  } catch {
    return false;
  }
}

function listingImageUrl(item = {}) {
  return cleanText(item.url || item.url_fullxfull || item.url_570xN || item.image_url, 1200);
}

async function fetchEtsyImage(item = {}, index = 0) {
  const url = listingImageUrl(item);
  const rank = Number(item.rank) || index + 1;
  if (!isTrustedEtsyImageUrl(url)) throw new Error(`Listing image rank ${rank} is not a trusted Etsy HTTPS image URL.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LISTING_IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`Could not read listing image rank ${rank}: HTTP ${response.status}.`);
    if (!isTrustedEtsyImageUrl(response.url || url)) throw new Error(`Listing image rank ${rank} redirected outside Etsy image hosts.`);
    const mimeType = cleanText(response.headers.get('content-type'), 80).split(';')[0].toLowerCase().replace('image/jpg', 'image/jpeg');
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) throw new Error(`Listing image rank ${rank} has unsupported content type ${mimeType || 'missing'}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`Listing image rank ${rank} is empty or exceeds the 8MB vision limit.`);
    return { rank, url, mimeType, base64: bytes.toString('base64') };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Listing image rank ${rank} timed out during AI vision preparation.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeListingVisualAnalysis(payload = {}, downloaded = [], model = '') {
  const byRank = new Map(downloaded.map(item => [item.rank, item]));
  if (byRank.size !== downloaded.length) throw new Error('Listing gallery contains duplicate image ranks; complete AI vision analysis is not possible.');
  const images = (Array.isArray(payload.images) ? payload.images : []).map(item => {
    const rank = Number(item?.rank);
    const source = byRank.get(rank);
    if (!source) return null;
    const quality = Number(item.quality_score);
    const relevance = Number(item.concept_relevance_score);
    const decision = cleanText(item.social_use_decision, 40).toLowerCase();
    if (!['hero', 'support', 'do_not_use'].includes(decision) || !Number.isFinite(quality) || !Number.isFinite(relevance)) return null;
    return {
      rank,
      url: source.url,
      social_use_decision: decision,
      quality_score: Number.isFinite(quality) ? Math.max(0, Math.min(100, quality)) : null,
      concept_relevance_score: Number.isFinite(relevance) ? Math.max(0, Math.min(100, relevance)) : null,
      visible_summary: cleanText(item.visible_summary, 700),
      rationale: cleanText(item.rationale, 700),
      concerns: cleanStringList(item.concerns, 8, 260),
    };
  }).filter(Boolean);
  const returnedRanks = new Set(images.map(item => item.rank));
  if (images.length !== downloaded.length || returnedRanks.size !== downloaded.length) {
    throw new Error('Vision model did not return one unique valid decision for every supplied listing image.');
  }
  return {
    available: true,
    provider: model,
    overall_summary: cleanText(payload.overall_summary, 1000),
    images,
  };
}

function listingVisionPrompt({ listing = {}, campaignContext = {}, batchRanks = [], batchNumber = 1, batchCount = 1 } = {}) {
  return [
    'You are the visual strategist for an AI-first Etsy social campaign. Inspect every supplied listing image by its actual pixels.',
    `This is bounded gallery batch ${batchNumber} of ${batchCount}. Return exactly one decision for each supplied Etsy image rank: ${JSON.stringify(batchRanks)}. Preserve these exact gallery ranks; do not renumber them within the batch.`,
    'For each image, decide whether it can lead the social post, only support it, or should not be used for this campaign. Do not assume rank 1 is best and do not use filename, URL wording, or a fixed product taxonomy as the decision.',
    'Judge visible product/offer clarity, campaign relevance, attention value, composition, readable text, trust, and whether the image could misrepresent what is sold.',
    'Classify each image by its actual communication role. Media dominated by instructions, requirements, process explanation, disclaimers, category labels, or other operational information is support at most; it is not a hero merely because it is clean, high-resolution, or readable.',
    'A hero must make the actual offer, transformation, result, product, or buyer value clear in the first second. When several images are plausible, prefer the one with the strongest visible proof or emotional/product relevance, and record any reason the best gallery image would still be a weak social hook compared with purpose-built creative.',
    'Be concise enough to finish the complete JSON for every supplied image: visible_summary at most 45 words, rationale at most 35 words, and at most four short concerns. quality_score and concept_relevance_score are integer scores from 0 to 100. Do not emit prose outside the JSON object.',
    'Return ONLY valid JSON with this exact contract:',
    '{"overall_summary":"...","images":[{"rank":1,"social_use_decision":"hero|support|do_not_use","quality_score":0,"concept_relevance_score":0,"visible_summary":"...","rationale":"...","concerns":["..."]}]}',
    `Listing facts: ${JSON.stringify({
      listing_id: cleanText(listing.listing_id || listing.id, 100),
      title: cleanText(listing.title || listing.listing_title, 400),
      description: cleanText(listing.description || listing.description_plain, 2200),
      tags: cleanStringList(listing.tags, 13, 60),
    })}`,
    `Campaign context: ${JSON.stringify(campaignContext).slice(0, 5000)}`,
  ].join('\n');
}

async function analyzeListingVisionBatch({ listing = {}, campaignContext = {}, candidates = [], config = {}, model = '', batchNumber = 1, batchCount = 1 } = {}) {
  const downloaded = await Promise.all(candidates.map(fetchEtsyImage));
  const content = [{
    type: 'text',
    text: listingVisionPrompt({
      listing,
      campaignContext,
      batchRanks: downloaded.map(item => item.rank),
      batchNumber,
      batchCount,
    }),
  }];
  for (const image of downloaded) {
    content.push({ type: 'text', text: `Listing image rank ${image.rank}:` });
    content.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } });
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(5_000, Math.min(Number(config.textTimeoutMs) || 120_000, 180_000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildProviderUrl(config.baseUrl, config.textPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({ model, stream: false, max_tokens: 4000, messages: [{ role: 'user', content }] }),
    });
    const data = await response.json().catch(() => ({}));
    logSocialVisionUsage('listing_gallery_vision', data, {
      model,
      max_tokens: 4000,
      image_count: downloaded.length,
      prompt_chars: String(content[0]?.text || '').length,
    });
    if (!response.ok) throw new Error(data.error?.message || data.message || `External listing vision failed with HTTP ${response.status}.`);
    return normalizeListingVisualAnalysis(parseJsonObject(extractText(data)), downloaded, model);
  } catch (err) {
    const detail = err?.name === 'AbortError'
      ? `External listing vision timed out after ${Math.round(timeoutMs / 1000)}s.`
      : (err?.message || String(err));
    throw new Error(`Listing vision batch ${batchNumber} of ${batchCount} failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

function listingVisionAdjudicationPrompt({ listing = {}, campaignContext = {}, batchAnalyses = [] } = {}) {
  const batchEvidence = batchAnalyses.map((batch, batchIndex) => ({
    batch: batchIndex + 1,
    overall_summary: cleanText(batch.overall_summary, 500),
    images: batch.images.map(item => ({
      rank: item.rank,
      batch_decision: item.social_use_decision,
      batch_quality_score: item.quality_score,
      batch_concept_relevance_score: item.concept_relevance_score,
      visible_summary: cleanText(item.visible_summary, 360),
      rationale: cleanText(item.rationale, 280),
      concerns: cleanStringList(item.concerns, 4, 180),
    })),
  }));
  const facts = {
    listing: {
      listing_id: cleanText(listing.listing_id || listing.id, 100),
      title: cleanText(listing.title || listing.listing_title, 400),
      description: cleanText(listing.description || listing.description_plain, 1800),
      tags: cleanStringList(listing.tags, 13, 60),
    },
    campaign_context: {
      campaign_goal: cleanText(campaignContext.campaign_goal || campaignContext.campaign_context, 1600),
      hook: cleanText(campaignContext.hook || campaignContext.post_hook, 700),
      campaign_offer_focus: cleanText(campaignContext.media_strategy?.campaign_offer_focus, 700),
      required_visible_evidence: cleanText(campaignContext.media_strategy?.required_visible_evidence, 1000),
      platforms: cleanStringList(campaignContext.platforms, 5, 40),
    },
    batch_pixel_analysis: batchEvidence,
  };
  const serialized = JSON.stringify(facts);
  if (serialized.length > MAX_GALLERY_ADJUDICATION_CHARS) {
    throw new Error(`Listing gallery adjudication contract exceeds ${MAX_GALLERY_ADJUDICATION_CHARS} characters.`);
  }
  return [
    'You are the final gallery-wide visual editor for an AI-first Etsy social campaign.',
    'The supplied batch_pixel_analysis was produced by vision inspection of every actual listing image. Compare all ranks across batches so hero/support/do_not_use decisions and 0-100 scores are calibrated gallery-wide rather than relative to a weak or strong batch.',
    'Do not use rank order, filenames, fixed taxonomies, or local keyword matching. Preserve the factual visible summaries and concerns; do not invent pixel details that were not observed.',
    'A hero must be one of the strongest campaign-relevant buyer-facing images across the complete gallery, not merely the strongest item in its original batch. Instruction, requirements, option, disclaimer, or process cards are support at most. Mark do_not_use when an image is misleading, irrelevant, visually weak, or harmful for this campaign.',
    'Return exactly one result for every supplied rank using the same contract and no prose outside JSON:',
    '{"overall_summary":"...","images":[{"rank":1,"social_use_decision":"hero|support|do_not_use","quality_score":0,"concept_relevance_score":0,"visible_summary":"...","rationale":"...","concerns":["..."]}]}',
    `Complete gallery evidence: ${serialized}`,
  ].join('\n');
}

async function adjudicateListingVisionAcrossBatches({
  listing = {},
  campaignContext = {},
  candidates = [],
  batchAnalyses = [],
  config = {},
  model = '',
} = {}) {
  const prompt = listingVisionAdjudicationPrompt({ listing, campaignContext, batchAnalyses });
  const controller = new AbortController();
  const timeoutMs = Math.max(5_000, Math.min(Number(config.textTimeoutMs) || 120_000, 180_000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildProviderUrl(config.baseUrl, config.textPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    logSocialVisionUsage('listing_gallery_adjudication', data, {
      model,
      max_tokens: 4000,
      image_count: candidates.length,
      prompt_chars: prompt.length,
    });
    if (!response.ok) {
      throw new Error(data.error?.message || data.message || `External gallery adjudication failed with HTTP ${response.status}.`);
    }
    return normalizeListingVisualAnalysis(
      parseJsonObject(extractText(data)),
      candidates.map(item => ({ rank: item.rank, url: item.url })),
      model,
    );
  } catch (err) {
    const detail = err?.name === 'AbortError'
      ? `External gallery adjudication timed out after ${Math.round(timeoutMs / 1000)}s.`
      : (err?.message || String(err));
    throw new Error(`Complete listing gallery AI adjudication failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzeSocialListingImages({ listing = {}, campaignContext = {}, images = [] } = {}) {
  const rawCandidates = (images.length ? images : listing.media_items || listing.images || [])
    .filter(item => listingImageUrl(item));
  if (!rawCandidates.length) return { available: false, error: 'No Etsy listing images are available for social vision analysis.', images: [] };

  const candidates = rawCandidates.map((item, index) => ({
    ...(item && typeof item === 'object' ? item : {}),
    rank: Number(item?.rank) || index + 1,
    url: listingImageUrl(item),
  }));
  const candidateRanks = candidates.map(item => item.rank);
  if (new Set(candidateRanks).size !== candidateRanks.length) {
    throw new Error('Listing gallery contains duplicate image ranks; complete AI vision analysis is not possible.');
  }

  const config = await getExternalAiRuntimeConfig();
  const model = cleanText(config.visionModel || config.textModel, 240);
  if (!model) throw new Error('No external vision-capable model is configured. Set EXTERNAL_VISION_MODEL or EXTERNAL_AI_MODEL.');

  const batchCount = Math.ceil(candidates.length / LISTING_VISION_BATCH_SIZE);
  const batchAnalyses = [];
  for (let offset = 0; offset < candidates.length; offset += LISTING_VISION_BATCH_SIZE) {
    const batchNumber = Math.floor(offset / LISTING_VISION_BATCH_SIZE) + 1;
    batchAnalyses.push(await analyzeListingVisionBatch({
      listing,
      campaignContext,
      candidates: candidates.slice(offset, offset + LISTING_VISION_BATCH_SIZE),
      config,
      model,
      batchNumber,
      batchCount,
    }));
  }

  const finalAnalysis = batchCount > 1
    ? await adjudicateListingVisionAcrossBatches({
      listing,
      campaignContext,
      candidates,
      batchAnalyses,
      config,
      model,
    })
    : batchAnalyses[0];
  const analyzedImages = finalAnalysis.images;
  const analyzedRanks = new Set(analyzedImages.map(item => item.rank));
  if (analyzedImages.length !== candidates.length || analyzedRanks.size !== candidates.length
    || candidateRanks.some(rank => !analyzedRanks.has(rank))) {
    throw new Error('Listing gallery vision analysis is incomplete; no complete result will be returned.');
  }

  return {
    available: true,
    complete: true,
    provider: model,
    overall_summary: cleanText(finalAnalysis.overall_summary, 1000),
    images: analyzedImages,
    analyzed_count: analyzedImages.length,
    expected_count: candidates.length,
    batch_count: batchCount,
    gallery_wide_adjudication: batchCount > 1,
  };
}

function normalizeDecision(value) {
  const decision = cleanText(value, 40).toLowerCase();
  if (['approve', 'regenerate', 'reject'].includes(decision)) return decision;
  throw new Error('Vision quality model returned an invalid decision.');
}

function normalizeQualityReview(payload = {}, model = '') {
  const decision = normalizeDecision(payload.decision);
  const confidenceValue = Number(payload.confidence);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : null;
  const rationale = cleanText(payload.rationale, 900);
  if (!rationale) throw new Error('Vision quality model returned no rationale.');
  const communicationGoalMet = payload.communication_goal_met === true;
  const persuasiveEvidenceVisible = payload.persuasive_evidence_visible === true;
  const persuasiveEvidenceStrength = cleanText(payload.persuasive_evidence_strength, 40).toLowerCase();
  const hasBlockingIssueContract = Array.isArray(payload.blocking_issues);
  const blockingIssues = cleanStringList(payload.blocking_issues, 10, 300);
  const approved = decision === 'approve'
    && communicationGoalMet
    && persuasiveEvidenceVisible
    && ['strong', 'partial'].includes(persuasiveEvidenceStrength)
    && hasBlockingIssueContract
    && blockingIssues.length === 0;
  return {
    quality_contract_version: 2,
    decision: decision === 'approve' && !approved ? 'regenerate' : decision,
    approved,
    confidence,
    communication_goal_met: communicationGoalMet,
    persuasive_evidence_visible: persuasiveEvidenceVisible,
    persuasive_evidence_strength: persuasiveEvidenceStrength,
    offer_fidelity: cleanText(payload.offer_fidelity, 420),
    attention_quality: cleanText(payload.attention_quality, 420),
    reference_fidelity: cleanText(payload.reference_fidelity, 420),
    text_assessment: cleanText(payload.text_assessment, 420),
    issues: cleanStringList(payload.issues, 10, 300),
    blocking_issues: blockingIssues,
    rationale,
    specific_revision: cleanText(payload.specific_revision, 900),
    owner_summary_uk: cleanText(payload.owner_summary_uk, 320),
    model,
    reviewed_at: new Date().toISOString(),
  };
}

function normalizeCampaignDecision(value) {
  const decision = cleanText(value, 40).toLowerCase();
  if (['approve', 'replan', 'reject'].includes(decision)) return decision;
  throw new Error('Campaign vision model returned an invalid decision.');
}

function normalizeCampaignQualityReview(payload = {}, model = '', expectedPlatforms = [], expectedMediaKeys = [], expectedMediaKeysByPlatform = {}) {
  const decision = normalizeCampaignDecision(payload.decision);
  const confidenceValue = Number(payload.confidence);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : null;
  const rationale = cleanText(payload.rationale, 1200);
  if (!rationale) throw new Error('Campaign vision model returned no rationale.');
  const platformReviews = (Array.isArray(payload.platform_reviews) ? payload.platform_reviews : [])
    .map(item => ({
      platform: cleanText(item?.platform, 40).toLowerCase(),
      decision: cleanText(item?.decision, 40).toLowerCase(),
      lead_media_key: cleanText(item?.lead_media_key, 120),
      visible_offer_understanding: cleanText(item?.visible_offer_understanding, 40).toLowerCase(),
      persuasive_evidence_media_keys: cleanStringList(item?.persuasive_evidence_media_keys, 12, 120),
      package_strength: cleanText(item?.package_strength, 40).toLowerCase(),
      listing_gallery_repackaging: item?.listing_gallery_repackaging === true,
      rationale: cleanText(item?.rationale, 700),
      issues: cleanStringList(item?.issues, 8, 300),
    }))
    .filter(item => expectedPlatforms.includes(item.platform)
      && ['approve', 'replan', 'reject'].includes(item.decision)
      && item.rationale);
  if (new Set(platformReviews.map(item => item.platform)).size !== new Set(expectedPlatforms).size) {
    throw new Error('Campaign vision model did not review every supplied platform variant.');
  }
  const visibleBuyerEvidence = {
    required_evidence: cleanText(payload.visible_buyer_evidence?.required_evidence, 500),
    satisfied: payload.visible_buyer_evidence?.satisfied === true,
    strength: cleanText(payload.visible_buyer_evidence?.strength, 40).toLowerCase(),
    dominant_media_keys: cleanStringList(payload.visible_buyer_evidence?.dominant_media_keys, 12, 120),
    rationale: cleanText(payload.visible_buyer_evidence?.rationale, 700),
  };
  const explanationCardDependence = {
    level: cleanText(payload.explanation_card_dependence?.level, 40).toLowerCase(),
    rationale: cleanText(payload.explanation_card_dependence?.rationale, 700),
  };
  const frameReviews = (Array.isArray(payload.frame_reviews) ? payload.frame_reviews : []).map(item => ({
    media_key: cleanText(item?.media_key, 120),
    dominant_visual: cleanText(item?.dominant_visual, 700),
    persuasive_evidence_visible: item?.persuasive_evidence_visible === true,
    persuasive_evidence_strength: cleanText(item?.persuasive_evidence_strength, 40).toLowerCase(),
    text_or_instruction_dominance: cleanText(item?.text_or_instruction_dominance, 40).toLowerCase(),
    mobile_feed_hook_strength: cleanText(item?.mobile_feed_hook_strength, 40).toLowerCase(),
    marginal_buyer_value: cleanText(item?.marginal_buyer_value, 40).toLowerCase(),
    sequence_position_fit: cleanText(item?.sequence_position_fit, 40).toLowerCase(),
    recommended_use: cleanText(item?.recommended_use, 40).toLowerCase(),
    rationale: cleanText(item?.rationale, 700),
  }));
  if (expectedMediaKeys.length
    && (frameReviews.length !== expectedMediaKeys.length
      || new Set(frameReviews.map(item => item.media_key)).size !== expectedMediaKeys.length
      || frameReviews.some(item => !expectedMediaKeys.includes(item.media_key)))) {
    throw new Error('Campaign vision model did not review every supplied media frame exactly once.');
  }
  const approvalChecks = Object.fromEntries(
    ['compelling_lead', 'visible_evidence', 'distinct_progression', 'not_gallery_repackaging'].map(key => [key, {
      status: cleanText(payload.approval_checks?.[key]?.status, 20).toLowerCase(),
      rationale: cleanText(payload.approval_checks?.[key]?.rationale, 700),
    }]),
  );
  const packageContractIssues = [];
  for (const review of platformReviews) {
    const platformMediaKeys = Array.isArray(expectedMediaKeysByPlatform?.[review.platform])
      ? expectedMediaKeysByPlatform[review.platform]
      : [];
    if (!platformMediaKeys.length) continue;
    if (review.lead_media_key !== platformMediaKeys[0]) {
      packageContractIssues.push(`${review.platform}: lead_media_key must equal the first supplied media key`);
    }
    if (review.persuasive_evidence_media_keys.some(key => !platformMediaKeys.includes(key))) {
      packageContractIssues.push(`${review.platform}: persuasive evidence references media outside that platform variant`);
    }
    if (!review.persuasive_evidence_media_keys.length) {
      packageContractIssues.push(`${review.platform}: no persuasive evidence frame was identified`);
    }
    if (!review.persuasive_evidence_media_keys.includes(review.lead_media_key)) {
      packageContractIssues.push(`${review.platform}: lead frame was not identified as persuasive evidence`);
    }
    const reviewedEvidenceFrames = review.persuasive_evidence_media_keys
      .map(key => frameReviews.find(frame => frame.media_key === key))
      .filter(Boolean);
    if (reviewedEvidenceFrames.length !== review.persuasive_evidence_media_keys.length
      || reviewedEvidenceFrames.some(frame => frame.persuasive_evidence_visible !== true
        || !['strong', 'partial'].includes(frame.persuasive_evidence_strength))) {
      packageContractIssues.push(`${review.platform}: declared persuasive evidence contradicts frame-level pixel review`);
    }
    const leadFrame = frameReviews.find(frame => frame.media_key === review.lead_media_key);
    if (!leadFrame
      || leadFrame.persuasive_evidence_visible !== true
      || leadFrame.persuasive_evidence_strength !== 'strong'
      || leadFrame.mobile_feed_hook_strength !== 'strong'
      || leadFrame.recommended_use !== 'lead') {
      packageContractIssues.push(`${review.platform}: lead lacks strong visible buyer evidence or hook strength`);
    }
    if (platformMediaKeys.length === 1) {
      if (review.visible_offer_understanding !== 'clear') {
        packageContractIssues.push(`${review.platform}: standalone image does not make the offer unambiguously clear`);
      }
      if (review.package_strength !== 'strong') {
        packageContractIssues.push(`${review.platform}: standalone image is not strong enough to carry the post by itself`);
      }
      if (review.issues.length) {
        packageContractIssues.push(`${review.platform}: standalone image still has unresolved campaign issues`);
      }
    }
  }
  if (visibleBuyerEvidence.dominant_media_keys.some(key => !expectedMediaKeys.includes(key))) {
    packageContractIssues.push('campaign visible buyer evidence references an unknown media key');
  }
  const dominantEvidenceFrames = visibleBuyerEvidence.dominant_media_keys
    .map(key => frameReviews.find(frame => frame.media_key === key))
    .filter(Boolean);
  if (!visibleBuyerEvidence.dominant_media_keys.length
    || dominantEvidenceFrames.length !== visibleBuyerEvidence.dominant_media_keys.length
    || dominantEvidenceFrames.every(frame => frame.persuasive_evidence_visible !== true
      || frame.persuasive_evidence_strength !== 'strong')) {
    packageContractIssues.push('campaign has no frame with strong visible buyer evidence');
  }
  for (const frame of frameReviews) {
    if (!['strong', 'meaningful'].includes(frame.marginal_buyer_value)) {
      packageContractIssues.push(`${frame.media_key}: marginal buyer value is too low for the selected package`);
    }
    if (frame.sequence_position_fit === 'poor') {
      packageContractIssues.push(`${frame.media_key}: sequence position is poor`);
    }
    if (frame.recommended_use === 'remove') {
      packageContractIssues.push(`${frame.media_key}: final editor recommended removal`);
    }
  }
  const requiredChanges = cleanStringList(payload.required_changes, 12, 500);
  const issues = cleanStringList(payload.issues, 12, 360);
  const platformIssues = platformReviews.flatMap(review => (
    review.issues.map(issue => `${review.platform}: ${issue}`)
  ));
  const campaignGoalMet = payload.campaign_goal_met === true;
  const contractApproved = decision === 'approve'
    && campaignGoalMet
    && platformReviews.every(item => item.decision === 'approve')
    && Object.values(approvalChecks).every(check => check.status === 'pass')
    && visibleBuyerEvidence.satisfied === true
    && ['strong', 'adequate'].includes(visibleBuyerEvidence.strength)
    && ['none', 'supporting'].includes(explanationCardDependence.level)
    && requiredChanges.length === 0
    && issues.length === 0
    && platformIssues.length === 0
    && packageContractIssues.length === 0;
  const failedApprovalChecks = Object.entries(approvalChecks)
    .filter(([, check]) => check.status === 'fail')
    .map(([key, check]) => `${key}: ${check.rationale || 'failed campaign approval check'}`);
  const blockingReasons = [...new Set([
    ...(!campaignGoalMet ? ['campaign_goal_met: final AI review did not confirm the campaign goal'] : []),
    ...packageContractIssues,
    ...requiredChanges,
    ...issues,
    ...failedApprovalChecks,
    ...platformIssues,
  ].filter(Boolean))].slice(0, 24);
  return {
    quality_contract_version: 2,
    decision: decision === 'approve' && !contractApproved ? 'replan' : decision,
    approved: contractApproved,
    confidence,
    campaign_goal_met: campaignGoalMet,
    hook_clarity: cleanText(payload.hook_clarity, 500),
    offer_demonstration: cleanText(payload.offer_demonstration, 500),
    sequence_coherence: cleanText(payload.sequence_coherence, 500),
    listing_gallery_dependence: cleanText(payload.listing_gallery_dependence, 500),
    visible_buyer_evidence: visibleBuyerEvidence,
    explanation_card_dependence: explanationCardDependence,
    frame_reviews: frameReviews,
    approval_checks: approvalChecks,
    emotional_tone: cleanText(payload.emotional_tone, 500),
    text_quality: cleanText(payload.text_quality, 500),
    platform_reviews: platformReviews,
    issues,
    required_changes: requiredChanges,
    package_contract_issues: packageContractIssues,
    blocking_reasons: blockingReasons,
    rationale,
    model,
    reviewed_at: new Date().toISOString(),
  };
}

async function prepareCampaignMediaImage(item = {}, index = 0) {
  const suppliedBase64 = String(item.base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (suppliedBase64) {
    const mimeType = cleanText(item.mimeType || item.mime_type, 40).toLowerCase().replace('image/jpg', 'image/jpeg');
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) throw new Error(`Unsupported campaign image type: ${mimeType || 'missing'}.`);
    const bytes = Buffer.from(suppliedBase64, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Campaign image is empty or exceeds the 8MB vision limit.');
    return { mimeType, base64: suppliedBase64 };
  }
  return fetchEtsyImage({ ...item, rank: index + 1 }, index);
}

function campaignQualitySystemPrompt() {
  return [
    'You are the final campaign-level visual editor for an AI-first Etsy social system. Inspect actual supplied pixels as one advertising package. Do not trust frame prompts, planner rationales, source labels, or prior per-frame approvals as evidence of what the pixels communicate.',
    ...SOCIAL_CREATIVE_SHARED_STANDARDS,
    'Audit in three passes. First review every media key independently at mobile feed-view scale and identify its dominant visible idea, persuasive evidence, text or instruction dominance, hook strength, and whether it should lead, support, or be removed. Second compare every pair of unique media keys across the whole campaign for semantic duplication. Third review each platform\'s ordered package.',
    'For the campaign-wide pairwise pass, treat two separately generated assets as near-duplicates when they show the same subject, the same source/result or proof sequence, and the same hook or buyer takeaway, even if one is 4:5 and the other 2:3 or their frames, props, typography, and spacing differ. Aspect-ratio adaptation alone is not creative diversity. Mark approval_checks.distinct_progression as fail and require a replan when a separate platform asset is only a reformatted near-copy. Exact reuse of one compatible shared asset is acceptable because it avoids pretending a derivative is a new idea.',
    'For every platform variant, follow its media_keys in order and judge the first-second hook, whether a shopper can understand the actual offer or transformation, narrative progression, visual repetition, emotional meaning, text quality, and platform fit.',
    'Ground every purchasability, fulfillment, material, format, shipping, and turnaround claim independently in listing.current_availability. Active variation values are purchasable now; inactive-only values are unavailable now even if old description text or the planner claims otherwise. Do not trust the planner or generated copy as evidence.',
    'First infer, in natural language, what visible buyer evidence this campaign needs in order to persuade: for example the sold product itself, a finished custom outcome, a transformation, a use case, or genuinely useful visual information. Then identify which supplied media keys make that evidence visually dominant. Labels, arrows, headings, process steps, option menus, generic image/video tiles, diagrams, or descriptive copy can explain an offer but are not themselves proof of the advertised result.',
    'When a listing is an umbrella custom-order or multi-service offer, require this campaign to make one concrete supported service, outcome, or coherent use case unmistakable. A generic keepsake promise, sentimental slogan, glowing screen, scattered photographs, or broad category label does not show what the buyer receives. Replan unless the pixels demonstrate the chosen output, transformation, or buyer use case clearly enough to describe without reading the caption.',
    'An editing timeline, waveform, laptop, scattered source photographs, hands arranging them, or an abstract source-to-output icon diagram can show process context or explain the service, but does not by itself show a finished custom output or transformation. Do not count those elements as strong buyer evidence unless the same pixels make the chosen concrete result visually dominant and unambiguous.',
    'A campaign-native fictional or synthetic demonstration is allowed when the listing supports the capability and public copy clearly treats it as an illustrative example rather than actual customer work. Judge whether the pixels show a coherent concrete source and finished result. Do not reject truthful illustrative proof merely because it is not customer media, and do not approve an icon diagram as a substitute.',
    'Infer whether the advertised deliverable is static or time-based. For animation, video, or another time-based output, a source still beside one altered, enhanced, restored, or colorized still does not visibly demonstrate motion. Treat it as support at most. Strong primary proof requires a coherent sequence of distinct temporal states or another truthful pixel-level representation that makes change over time unmistakable. The caption cannot rescue a static image.',
    'Judge the pixels at feed-view scale. A tiny example buried inside a busy listing infographic does not become a strong demonstration merely because the surrounding labels explain it. The lead must make the buyer value visually understandable before the caption is read; supporting frames must add persuasive evidence or meaningful progression rather than restating the listing.',
    'Assess art direction as part of persuasion, not as optional polish. A technically clean but generic template, timid typography, excessive dead space, evenly spaced icon grid, default-looking review UI, or flat arrangement with no visual hierarchy should not pass as a compelling lead. Require a campaign-specific focal idea, confident hierarchy, intentional color/contrast, and enough visual energy to stop a buyer in the feed while staying truthful to the offer.',
    'Review each platform as its own advertising package. A strong asset created for another platform does not provide progression, evidence, or hook strength to this platform. Do not praise cross-platform tailoring as a substitute for evaluating the exact ordered media each audience will actually receive.',
    'A single-image platform variant has no later frame to rescue ambiguity. Approve a single only when that exact image has strong first-second hook strength, strong visible buyer evidence, and makes the offered product, result, transformation, or use case unambiguous from the pixels alone. An attractive lifestyle arrangement, phone mockup, scattered props, atmospheric scene, or generic editorial flat lay is not sufficient when the advertised output is only inferred. The caption must not rescue an unclear image. If another distinct frame would materially improve demonstration, trust, or narrative progression, replan the platform package instead of accepting an adequate single.',
    'A polished image that matches its individual brief may still damage the campaign. Replan when an emotion is confusing or negative without visual context, when the sequence merely repeats weak listing-gallery material, when instructional or option slides carry the persuasion instead of supporting visible proof, or when the images fail to demonstrate why the offer matters. These are semantic judgments from the full campaign, not fixed bans or keyword rules.',
    'Treat fulfillment notices, format disclosures, requirements, and ordering instructions as caption or listing information unless the pixels also add persuasive buyer value that the rest of the campaign genuinely lacks. A slide whose main contribution is merely saying that an item is digital, downloadable, custom, or not physical is not buyer evidence and should normally be removed from a social sequence rather than approved as filler.',
    'Treat a review card as supporting social proof, not automatic buyer evidence. It cannot replace a failed or missing product, result, transformation, or use-case demonstration and cannot make review-only pixels satisfy required_visible_evidence. Keep it only when another selected frame independently supplies that concrete evidence and the exact quote then adds meaningful trust. Judge whether its exact quote is specific enough to strengthen the chosen offer and whether the card adds persuasion beyond a generic star rating. Its factual context note must add distinct buyer information; a note that quotes, paraphrases, repeats, summarizes, or merely labels the review is redundant. A vague quote, redundant note, unexplained quote, ambiguous shop/reviewer attribution, full SEO listing title, or large empty card should be removed or redesigned rather than counted as campaign progression.',
    'For each frame, compare the ordered platform package with that frame removed. Report marginal_buyer_value as strong or meaningful only when the exact frame materially improves persuasion, buyer understanding, trust, or narrative progression beyond what the remaining media and caption already provide. Truthful information alone is not enough. Mark low/none and recommend remove when omission creates a stronger social post. Judge sequence_position_fit separately: an informational support frame placed before stronger visual proof is poor even if the card is readable.',
    'Approve only when every platform independently passes all four approval checks and the campaign-wide pairwise audit finds no redundant separately generated near-copy: a compelling lead, visible buyer evidence, distinct progression or an exceptional sufficient standalone image, and no gallery repackaging. The overall decision must not be approve when any approval check fails or any platform decision is replan/reject. A factual, legible, coherent package can still require replanning when it behaves like an Etsy instruction gallery rather than a compelling social post.',
    'Do not require generated media, listing media, text overlays, a carousel, or a fixed number of frames. Approve whatever evidence mix best communicates this specific offer. Reject fabricated results or misleading product identity. Use replan when a different AI media strategy can plausibly fix the package; use reject only when the concept itself should not proceed.',
    'Return only the required structured tool call and review every supplied media key and platform exactly once.',
  ].join('\n');
}

function campaignQualityPrompt({ listing = {}, context = {}, variants = [], media = [] } = {}) {
  const understanding = listing.listing_understanding && typeof listing.listing_understanding === 'object'
    ? listing.listing_understanding
    : {};
  const availability = listing.current_availability && typeof listing.current_availability === 'object'
    ? listing.current_availability
    : {};
  const strategy = context.media_strategy && typeof context.media_strategy === 'object'
    ? context.media_strategy
    : {};
  const campaignFacts = {
    platform_variants: variants,
    media: media.map(item => ({ key: item.key, source: item.source, brief_id: item.brief_id })),
    listing: {
      listing_id: cleanText(listing.listing_id || listing.id, 100),
      title: cleanText(listing.title || listing.listing_title, 400),
      description: cleanText(listing.description || listing.description_plain, 2200),
      current_availability: {
        source: cleanText(availability.source, 80),
        active_offering_count: Number.isFinite(Number(availability.active_offering_count))
          ? Number(availability.active_offering_count)
          : null,
        inactive_offering_count: Number.isFinite(Number(availability.inactive_offering_count))
          ? Number(availability.inactive_offering_count)
          : null,
        variation_availability: (Array.isArray(availability.variation_availability)
          ? availability.variation_availability
          : []).slice(0, 12).map(item => ({
          property: cleanText(item?.property, 120),
          active_values: cleanStringList(item?.active_values, 20, 160),
          inactive_only_values: cleanStringList(item?.inactive_only_values, 20, 160),
        })),
        shipping_profile_present: availability.shipping_profile_present === true,
        processing_min_days: Number.isFinite(Number(availability.processing_min_days))
          ? Number(availability.processing_min_days)
          : null,
        processing_max_days: Number.isFinite(Number(availability.processing_max_days))
          ? Number(availability.processing_max_days)
          : null,
      },
      listing_understanding: {
        what_is_sold: cleanText(understanding.what_is_sold, 700),
        fulfillment: cleanText(understanding.fulfillment, 500),
        buyer_use_case: cleanText(understanding.buyer_use_case, 700),
        target_buyer: cleanText(understanding.target_buyer, 500),
        marketing_angle: cleanText(understanding.marketing_angle, 700),
        offer_fact_review: understanding.offer_fact_review && typeof understanding.offer_fact_review === 'object'
          ? understanding.offer_fact_review
          : null,
      },
    },
    campaign: {
      goal: cleanText(context.campaign_goal || context.campaign_context, 1600),
      hook: cleanText(context.hook || context.post_hook, 700),
      offer_focus: cleanText(strategy.campaign_offer_focus, 700),
      lead_proof_plan: cleanText(strategy.lead_proof_plan, 900),
      required_visible_evidence: cleanText(strategy.required_visible_evidence, 1200),
      frame_count_rationale: cleanText(strategy.frame_count_rationale, 700),
    },
  };
  const serialized = JSON.stringify(campaignFacts);
  if (serialized.length > MAX_CAMPAIGN_CONTEXT_CHARS) {
    throw new Error(`Campaign quality contract exceeds ${MAX_CAMPAIGN_CONTEXT_CHARS} characters after safe compaction.`);
  }
  return `Campaign package to inspect:\n${serialized}`;
}

export async function reviewSocialCampaignMedia({ variants = [], listing = {}, context = {}, signal } = {}) {
  const normalizedVariants = (Array.isArray(variants) ? variants : [])
    .filter(variant => variant?.platform && Array.isArray(variant.media_items) && variant.media_items.length)
    .map(variant => ({
      platform: cleanText(variant.platform, 40).toLowerCase(),
      format: cleanText(variant.format || variant.media_format || (variant.carousel ? 'carousel' : 'single'), 80),
      caption: cleanText(variant.caption, 1800),
      media_items: variant.media_items.slice(0, 10),
    }));
  if (!normalizedVariants.length) throw new Error('Campaign vision review requires at least one media-ready platform variant.');

  const mediaByIdentity = new Map();
  for (const variant of normalizedVariants) {
    for (const item of variant.media_items) {
      const identity = cleanText(item.url || item.id || item.base64, 1600);
      if (!identity) throw new Error(`Campaign variant ${variant.platform} contains media without an identity.`);
      if (!mediaByIdentity.has(identity)) {
        mediaByIdentity.set(identity, {
          ...item,
          key: `media_${mediaByIdentity.size + 1}`,
          source: cleanText(item.source, 80),
          brief_id: cleanText(item.brief_id, 120),
        });
      }
    }
  }
  const media = [...mediaByIdentity.values()];
  if (media.length > 12) throw new Error('Campaign vision review supports at most 12 unique images per package.');
  const prepared = await Promise.all(media.map(prepareCampaignMediaImage));
  const variantsForPrompt = normalizedVariants.map(variant => ({
    platform: variant.platform,
    format: variant.format,
    caption: variant.caption,
    media_keys: variant.media_items.map(item => mediaByIdentity.get(cleanText(item.url || item.id || item.base64, 1600))?.key).filter(Boolean),
  }));
  const expectedPlatforms = [...new Set(variantsForPrompt.map(item => item.platform))];
  const content = [{ type: 'text', text: campaignQualityPrompt({ listing, context, variants: variantsForPrompt, media }) }];
  prepared.forEach((image, index) => {
    content.push({ type: 'text', text: `${media[index].key} (${media[index].source || 'unknown source'}):` });
    content.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } });
  });

  const config = await getExternalAiRuntimeConfig();
  const model = cleanText(config.visionModel || config.textModel, 240);
  if (!model) throw new Error('No external vision-capable model is configured. Set EXTERNAL_VISION_MODEL or EXTERNAL_AI_MODEL.');
  const controller = signal ? null : new AbortController();
  const timeoutMs = Math.max(5_000, Math.min(Number(config.textTimeoutMs) || 120_000, 300_000));
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const expectedMediaKeys = media.map(item => item.key);
    const tool = campaignQualityTool(expectedPlatforms, expectedMediaKeys);
    const response = await fetch(buildProviderUrl(config.baseUrl, config.textPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      signal: signal || controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: campaignQualitySystemPrompt() },
          { role: 'user', content },
        ],
        tools: [tool],
        tool_choice: { type: 'function', function: { name: tool.function.name } },
      }),
    });
    const data = await response.json().catch(() => ({}));
    logSocialVisionUsage('campaign_media_vision', data, {
      model,
      max_tokens: 4000,
      image_count: prepared.length,
      prompt_chars: String(content[0]?.text || '').length,
    });
    if (!response.ok) throw new Error(data.error?.message || data.message || `External campaign vision review failed with HTTP ${response.status}.`);
    return normalizeCampaignQualityReview(
      extractStructuredToolPayload(data, tool.function.name),
      model,
      expectedPlatforms,
      expectedMediaKeys,
      Object.fromEntries(variantsForPrompt.map(variant => [variant.platform, variant.media_keys])),
    );
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`External campaign vision review timed out after ${Math.round(timeoutMs / 1000)}s.`);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function qualityPrompt(context = {}) {
  const factualContext = {
    campaign_goal: cleanText(context.campaign_goal || context.campaign_context, 1400),
    post_hook: cleanText(context.post_hook || context.hook, 500),
    frame_role: cleanText(context.frame_role || context.role, 240),
    frame_brief: cleanText(context.frame_brief || context.prompt, 1800),
    frame_rationale: cleanText(context.frame_rationale || context.rationale, 700),
    frame_communication_goal: cleanText(context.frame_communication_goal, 500),
    frame_visible_buyer_evidence: cleanText(context.frame_visible_buyer_evidence, 700),
    frame_evidence_strength: cleanText(context.frame_evidence_strength, 40),
    required_visible_evidence: cleanText(context.required_visible_evidence, 900),
    listing_title: cleanText(context.listing_title, 400),
    listing_understanding: context.listing_understanding && typeof context.listing_understanding === 'object'
      ? context.listing_understanding
      : null,
    current_availability: context.current_listing_availability && typeof context.current_listing_availability === 'object'
      ? context.current_listing_availability
      : null,
    platforms: cleanStringList(context.platforms, 5, 40),
    format: cleanText(context.format, 80),
    reference_required: context.reference_required === true,
    reference_policy: cleanText(context.reference_policy, 600),
    owner_revision: cleanText(context.owner_revision, 1800),
    required_revision_outcomes: cleanStringList(context.required_revision_outcomes, 12, 500),
    rejected_creative_functions: cleanStringList(context.rejected_creative_functions, 12, 500),
  };
  const serializedContext = JSON.stringify(factualContext).slice(0, MAX_CONTEXT_CHARS);
  return [
    'You are the final visual editor for an AI-first Etsy social campaign. Inspect the actual pixels of the generated candidate image, not merely its prompt.',
    ...SOCIAL_CREATIVE_SHARED_STANDARDS,
    'Decide semantically whether this exact image deserves to be shown to the shop owner and could support the intended post after owner approval.',
    'A technically valid image is not enough. It must make the intended offer or story understandable, attract attention, fit the planned frame role, remain faithful to supplied listing facts, and add useful information rather than irrelevant decorative filler.',
    'Independently ground purchasability and fulfillment claims in current_availability when supplied. Never approve an inactive-only format or option as currently available merely because the frame brief, listing description, or prior planner says it is.',
    'Use frame_visible_buyer_evidence and required_visible_evidence as the planner\'s explicit semantic claim, then verify that claim from the pixels. If a frame declared primary or supporting evidence but only shows headings, process steps, option labels, abstract outlines, image/video icons, arrows, diagrams, or instructions without the claimed product/result/transformation/use case, regenerate it. Do not approve it merely because it follows the brief.',
    'For an umbrella custom-order or multi-service listing, the frame must make one concrete supported service, result, transformation, or coherent use case visible. A sentimental slogan, generic category phrase, glowing device, scattered photographs, tasteful props, or atmospheric flat lay is not evidence of what the buyer receives and must not pass merely because it looks polished.',
    'A laptop editing timeline, waveform, scattered source photos, hands arranging props, or an abstract source-to-output icon diagram is process context or explanation, not a finished result. If those elements dominate while the chosen output or source-to-result transformation is absent, regenerate the frame even when its own brief mistakenly calls the composition the hero.',
    'A campaign-native fictional or synthetic demonstration may be approved when listing facts support the capability, the pixels show a coherent concrete source/result relationship, and public framing does not imply it is real customer work. This is different from fabricated evidence. Prefer that truthful illustrative proof over a decorative diagram when a custom service needs visual demonstration.',
    'Infer whether the intended deliverable is static or time-based. For animation, video, or another time-based output, do not approve a source still beside one altered, enhanced, restored, or colorized still as motion evidence. Regenerate unless the pixels include coherent distinct temporal states or another truthful representation that makes change over time unmistakable. A caption or frame brief cannot rescue static ambiguity.',
    'The candidate itself must be suitable for a buyer-facing social post. Regenerate or reject internal production requests, missing-asset notices, diagnostic cards, non-publishable placeholders, and seller instructions even when they perfectly match a misguided frame brief. Those artifacts describe missing creative; they are not social creative.',
    'Judge creative impact in addition to factual correctness. If the result reads like a default slide template, plain centered sentence, dry interface card, evenly spaced icon grid, legalistic disclosure layout, or low-energy stock composition, regenerate it with a stronger campaign-specific focal idea, visual hierarchy, color rhythm, depth, emotional pull, and a coherent social-native attention device. Directional flow, expressive crops, concise hook copy, annotated transformation, surprising scale, or another campaign-specific device may work; do not demand ornament for its own sake or mechanically require every device. The visual energy must help explain or sell the exact offer.',
    'A truthful illustrative-example disclosure must remain legible, subordinate, visually integrated, and phrased as natural consumer-facing social copy. Do not approve formal classification language that merely labels the asset as an illustrative example, or a frame whose main impression is a dry disclaimer/footer rather than the promised result. Regenerate when the disclosure wording or treatment drains the hook of social-feed energy; the caption can carry the full disclosure when on-image wording adds no persuasive value.',
    'When the frame depends on a proof-bearing device, product, comparison, source/result relationship, or other concrete object, verify that the complete object and its essential relationship are visibly inside the final canvas. A cropped or partially hidden proof element does not satisfy the communication goal merely because the surrounding design is polished.',
    'When owner_revision or required_revision_outcomes are present, treat them as authoritative visual acceptance criteria. Check the actual pixels for every concrete requested relationship, quantity, identity distinction, spatial arrangement, direction, connector, and exclusion. Reject or regenerate a polished decorative substitute that changes or omits the owner\'s concrete composition.',
    'When a reference is required, compare the generated candidate against the separately supplied ORIGINAL REFERENCE IMAGE by actual pixels. Approve only if the sold design/product identity, distinctive artwork, text, layout, colors, and other identity-bearing details are faithfully preserved; a thematically similar redraw is not faithful. When no reference is required, do not invent a requirement to show a listing image.',
    'Text inside the image is optional. If present, assess whether it is accurate, legible, useful, and visually integrated. Do not reject an image merely because it has no text.',
    'Do not classify decorative strokes, pseudo-handwriting, signatures, paper texture, or text-like marks as readable copy merely because they resemble writing. Reject for unexpected readable text only when you can transcribe the exact visible words with reasonable confidence and explain their location and concrete marketing, factual, safety, or legibility harm. Harmless incidental writing is a composition issue only when it materially distracts from the offer; it is not an automatic failure.',
    'Set persuasive_evidence_visible from the actual pixels and persuasive_evidence_strength to strong, partial, or absent. An approve decision requires communication_goal_met=true, visible persuasive evidence with strong/partial strength, and an empty blocking_issues array. issues may contain optional observations that do not prevent use; blocking_issues contains every unresolved defect that prevents owner-review use.',
    'When decision is regenerate or reject, owner_summary_uk must be one concise natural Ukrainian sentence explaining what is visibly wrong and why the frame will not enter the post. Do not include internal ids, model names, scores, or technical pipeline language. When decision is approve, return owner_summary_uk as an empty string.',
    'Use regenerate when a revised visual brief could plausibly fix the frame. Use reject when the concept is fundamentally incompatible or misleading. Use approve only when the actual pixels communicate the campaign well enough for owner review.',
    'Return ONLY valid JSON with this exact contract:',
    '{"decision":"approve|regenerate|reject","confidence":0.0,"communication_goal_met":true,"persuasive_evidence_visible":true,"persuasive_evidence_strength":"strong|partial|absent","offer_fidelity":"...","attention_quality":"...","reference_fidelity":"...","text_assessment":"...","issues":["..."],"blocking_issues":[],"rationale":"...","specific_revision":"...","owner_summary_uk":"..."}',
    `Campaign and frame context: ${serializedContext}`,
  ].join('\n');
}

async function prepareQualityReferenceImage(referenceImage) {
  if (!referenceImage) return null;
  if (typeof referenceImage === 'string' || referenceImage.url || referenceImage.image_url) {
    const url = typeof referenceImage === 'string' ? referenceImage : referenceImage.url || referenceImage.image_url;
    return fetchEtsyImage({ url, rank: 1 });
  }
  const mimeType = cleanText(referenceImage.mimeType || referenceImage.mime_type, 40).toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) throw new Error(`Unsupported social quality-review reference image type: ${mimeType || 'missing'}.`);
  const base64 = String(referenceImage.base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Social quality-review reference image is empty or exceeds the 8MB limit.');
  return { rank: 1, mimeType, base64 };
}

export async function reviewGeneratedSocialImage({ base64, mimeType = 'image/png', referenceImage = null, context = {}, signal } = {}) {
  const normalizedMime = cleanText(mimeType, 40).toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!SUPPORTED_MIME_TYPES.has(normalizedMime)) throw new Error(`Unsupported social quality-review image type: ${normalizedMime || 'missing'}.`);
  const normalizedBase64 = String(base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const bytes = Buffer.from(normalizedBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Social quality-review image is empty or exceeds the 8MB limit.');
  const preparedReference = await prepareQualityReferenceImage(referenceImage);
  if (context.reference_required === true && !preparedReference) {
    throw new Error('Reference-required social quality review needs the actual original reference image pixels.');
  }

  const config = await getExternalAiRuntimeConfig();
  const model = cleanText(config.visionModel || config.textModel, 240);
  if (!model) throw new Error('No external vision-capable model is configured. Set EXTERNAL_VISION_MODEL or EXTERNAL_AI_MODEL.');
  const endpoint = buildProviderUrl(config.baseUrl, config.textPath);
  const controller = signal ? null : new AbortController();
  const timeoutMs = Math.max(5_000, Math.min(Number(config.textTimeoutMs) || 120_000, 300_000));
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      signal: signal || controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 2400,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: qualityPrompt(context) },
            { type: 'text', text: 'GENERATED CANDIDATE IMAGE:' },
            { type: 'image_url', image_url: { url: `data:${normalizedMime};base64,${normalizedBase64}` } },
            ...(preparedReference ? [
              { type: 'text', text: 'ORIGINAL REFERENCE IMAGE TO COMPARE AGAINST:' },
              { type: 'image_url', image_url: { url: `data:${preparedReference.mimeType};base64,${preparedReference.base64}` } },
            ] : []),
          ],
        }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    logSocialVisionUsage('generated_media_vision', data, {
      model,
      max_tokens: 2400,
      image_count: preparedReference ? 2 : 1,
      prompt_chars: qualityPrompt(context).length,
    });
    if (!response.ok) throw new Error(data.error?.message || data.message || `External vision quality review failed with HTTP ${response.status}.`);
    return normalizeQualityReview(parseJsonObject(extractText(data)), model);
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`External vision quality review timed out after ${Math.round(timeoutMs / 1000)}s.`);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const socialMediaQualityInternals = {
  normalizeListingVisualAnalysis,
  normalizeQualityReview,
  normalizeCampaignQualityReview,
  listingVisionAdjudicationPrompt,
  qualityPrompt,
  campaignQualitySystemPrompt,
  campaignQualityPrompt,
  prepareQualityReferenceImage,
};
