// api/_generate.js — shared listing/social generation utility
// Internal helper module, not an HTTP route.
// Imported by api/ai.js and api/agent.js.

import { MODEL } from './_config.js';
import { generateWithExternalAi, isRetryableExternalAiFailure } from './_external-ai.js';
import { sanitizeListingAiResult } from './_etsy-text.js';
import { parseJsonish } from './_utils.js';
import { ETSY_LISTING_STANDARDS_PROMPT } from './agent/etsy-standards.js';
import { applyActiveEtsyGuidance, getActiveEtsyGuidance, guidanceRuntimePrompt } from './_etsy-guidance.js';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export const LISTING_SYSTEM = `You are an Etsy listing specialist. Create accurate, clear, buyer-friendly listing content from the supplied product facts.

## NON-NEGOTIABLE OUTPUT LANGUAGE
The product brief may be written in any language. Treat it as source facts, not as the requested output language.
- Write ALL buyer-facing Etsy listing content in natural English (US), regardless of the language used in the owner's product brief, conversation, shop notes, or current draft.
- This applies to title, description, tags, materials, taxonomy/category suggestions, section suggestions, personalization questions/instructions, price rationale, and every other textual JSON field.
- When source facts are provided in Ukrainian, Russian, or another language, translate their meaning into fluent commercial English. Do not mirror the source language.
- Keep only proper nouns, trademarks, filenames, and buyer-supplied wording that genuinely must remain unchanged.
- Before returning JSON, verify that no unintended non-English or Cyrillic listing copy remains.

${ETSY_LISTING_STANDARDS_PROMPT}

## PRICE AND TAXONOMY
- Suggest a price only from facts or comparable-market data supplied in the request. If evidence is missing, make the uncertainty explicit in price_rationale and do not invent competitor statistics.
- Choose the most specific accurate Etsy taxonomy category and section suggestion supported by the product facts.

## PERSONALIZATION
Enable personalization only when the supplied product or service can actually be customized.
Use Etsy's structured personalization questions instead of telling buyers to email photos or send photos later in messages.
For photo/custom services, include a required file upload question for reference photos/files and a separate text question for names, placement, style, background, and other details.
Never write instructions like "send your photo to email" or "message us the photos after purchase" unless the user explicitly asks for a fallback channel.

## PRE-OUTPUT CHECKLIST
- Title clearly names the item and leads with the essential objective traits; it is easy to scan, avoids repeated phrases, is preferably under 15 words, and never exceeds 140 characters.
- Exactly 13 accurate and varied tags are present when the product supports them, and every tag is no longer than 20 characters.
- Description accurately explains what the buyer receives, relevant specifications, ordering/use, delivery, and personalization without filler or keyword stuffing.
- Category, materials, price rationale, and personalization fields use only supported product facts.

## HONESTY RULES — never include these in descriptions or bullets
- NO "Unlimited Revisions" — every revision costs real time and money; use "1 free revision" or omit entirely
- NO "100% satisfaction guaranteed" — vague and unenforceable
- NO delivery time promises you can't guarantee (e.g. "delivered in 1 hour") unless factually true for instant downloads
- Keep claims specific and realistic. Overpromising destroys reviews and repeat business.

## OUTPUT
Return ONLY valid JSON, no markdown fences:
{
  "title": "Clear item noun and essential objective traits near the beginning; preferably under 15 words; max 140 characters",
  "description": "Accurate, buyer-friendly, scannable listing description with relevant product, ordering, delivery, and personalization details.",
  "tags": ["relevant phrase 01", "relevant phrase 02", "relevant phrase 03", "relevant phrase 04", "relevant phrase 05", "relevant phrase 06", "relevant phrase 07", "relevant phrase 08", "relevant phrase 09", "relevant phrase 10", "relevant phrase 11", "relevant phrase 12", "relevant phrase 13"],
  "materials": ["list 2-5 relevant digital tools or media, e.g. 'Canva', 'Adobe Photoshop', 'Digital File', 'Artificial Intelligence', 'PNG', 'SVG'"],
  "price_suggestion": 9.99,
  "price_rationale": "1 sentence: evidence-based market position and any uncertainty behind the suggestion",
  "section_suggestion": "Best matching shop section name",
  "taxonomy_category": "Exact or best-match Etsy seller taxonomy category name, e.g. 'Digital Prints', 'Templates', 'Clip Art', 'Watercolor'. Use the most specific leaf-level category name that describes this product.",
  "is_personalizable": true,
  "personalization_instructions": "Fallback text instructions only. Do not tell buyers to email or message photos; refer to the upload fields below.",
  "personalization_questions": [
    { "question_type": "file_upload", "question_text": "Upload your reference photos", "instructions": "Upload the photos/files needed for your custom order directly here on Etsy.", "required": true, "max_allowed_files": 10 },
    { "question_type": "text_input", "question_text": "Describe your custom request", "instructions": "Names, placement, style, background, colours, or other details.", "required": true, "max_allowed_characters": 1024 }
  ]
}`;

export const SOCIAL_SYSTEM = `You are a social media content strategist for an Etsy creative shop in 2026.

LANGUAGE RULE: Write all captions in the SAME language as the listing title and product description provided. If the listing is in English, write English captions. Never default to a specific language regardless of the platform.

PLATFORM ALGORITHMS 2026:
- Pinterest: No hashtags (irrelevant). 2-3 SEO keyword sentences. Mention price. Always include the Etsy listing URL at the end — Pinterest is link-forward and drives clicks to external sites.
- Instagram: New 4:5 portrait grid standard. First line MUST hook (algorithm shows only first line). Then value prop, then soft CTA. Hashtags on new paragraph, 8-10 focused tags. Add "link in bio" CTA since Instagram links don't work in posts.
- Facebook: Conversational, question-based hooks drive comments. Keep short, mention "Shop now →" with the full listing URL.
- TikTok: First 3 words must hook. POV/relatable format. 3-5 trending-adjacent hashtags. Under 150 chars.

Return ONLY valid JSON:
{
  "pinterest": "2-3 SEO keyword-rich sentences. No hashtags. Include price. End with the full Etsy listing URL. 300-400 chars total.",
  "instagram": "Hook line that stops scroll.\\n\\n2-3 sentence value description.\\n\\nShop link in bio! 🔗\\n\\n#tag1 #tag2 (8-10 relevant hashtags)",
  "facebook": "Engaging question or relatable hook. Product value. Shop now → [full Etsy listing URL]. 1-2 hashtags. ~150 chars.",
  "tiktok": "3-word hook → product value → CTA. #tag1 #tag2 #tag3. Under 150 chars total."
}`;

export const AUTOPILOT_SYSTEM = `You are an autonomous content strategist for an Etsy shop.

Goal: create a practical social content calendar that can be saved without manual editing.

Use only facts provided in the input. Do not invent sales counts, review quotes, discounts, awards, or bestseller claims. If a sale/milestone/review is not explicitly provided, use safe wording such as "shop favorite", "featured design", or "this week's pick".

Platform rules:
- Pinterest: SEO-forward, no hashtags, include the full Etsy listing URL when available.
- Instagram: strong first line, soft CTA, 6-10 focused hashtags, say "link in bio" instead of pasting the URL.
- Facebook: conversational, short, can include the Etsy URL.
- TikTok: draft/manual only for now. Keep captions under 150 chars. Do not require video.

AI decision contract:
- Reason semantically over the complete supplied listing inventory, descriptions, media URLs, performance facts, reviews, and prior usage.
- Decide the useful post angle, selected platforms, listing, caption, and media count for each post. Do not use title-keyword matching or a fixed product taxonomy.
- Use an exact listing image only when it is genuinely useful evidence for the post. Do not automatically attach the first image or every listing image.
- When existing listing media cannot carry the idea, return purpose-built generation_briefs. A brief may use one exact reference_image_url when preserving a sold design/product is necessary; otherwise explain why no reference is appropriate.
- Every media item and generation brief must include a unique positive order and non-empty role. Every generation brief also requires a unique id, supported aspect_ratio, explicit reference_required boolean, and reference_policy. When reference_required is false, reference_image_url must be empty. Malformed entries block the post; they are not silently repaired.
- Never invent reviews, performance, discounts, events, products, services, or visual proof.

Return ONLY valid JSON with this shape:
{
  "summary": "Short strategy summary",
  "posts": [
    {
      "scheduled_at": "YYYY-MM-DDTHH:mm:ss",
      "scheduled_timezone": "IANA timezone used to reason about the buyer audience",
      "timing_reason": "Short evidence-based reason for this local audience window",
      "platform": "instagram|pinterest|facebook|tiktok",
      "strategy_reason": "Why this opportunity and listing are useful now, grounded in supplied evidence",
      "listing_id": 123,
      "listing_title": "Listing title",
      "listing_image_url": "https://...",
      "caption": "Ready-to-post caption",
      "creative_brief": "Specific optional image/card idea for this platform",
      "media_items": [{"order":1, "url":"one of the supplied listing image URLs", "source":"listing_image", "role":"why AI selected it"}],
      "generation_briefs": [{"id":"unique-frame-id", "order":2, "role":"model-authored frame purpose", "prompt":"clean visual prompt", "aspect_ratio":"1:1|4:5|2:3|3:4|9:16|16:9", "reference_required":true, "reference_image_url":"one supplied listing image URL when required, otherwise empty", "reference_policy":"why the reference is or is not required"}],
      "risk_level": "low|needs_review"
    }
  ],
  "notes": ["Any important limitation or recommendation"]
}`;



export async function generateWithClaude(systemPrompt, userPrompt, model = MODEL.claude) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    if (res.status === 429) throw new Error('Claude rate limit — try again in 1 minute');
    if (res.status === 529) throw new Error('Claude is overloaded — try again shortly or switch to Gemini');
    if (res.status === 503) throw new Error('Claude is temporarily unavailable — try Gemini');
    const errMsg = data.error?.message || `Claude error ${res.status}`;
    if (errMsg.toLowerCase().includes('credit balance') || errMsg.toLowerCase().includes('insufficient')) {
      throw new Error('FALLBACK: ' + errMsg);
    }
    throw new Error(errMsg);
  }

  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Claude: empty response');

  return parseJsonish(text);
}

function isOverloaded(res, data) {
  const msg = (data?.error?.message || '').toLowerCase();
  return !res.ok && (res.status === 503 || msg.includes('high demand') || msg.includes('temporarily') || msg.includes('overload'));
}

export async function generateWithGemini(systemPrompt, userPrompt, model = MODEL.gemini, thinkingLevel = 'HIGH') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const maxOutputTokens = (thinkingLevel && thinkingLevel !== 'NONE') ? 32768 : 4096;
  const genConfig = { maxOutputTokens, temperature: 1.0, candidateCount: 1 };
  if (thinkingLevel && thinkingLevel !== 'NONE') genConfig.thinkingConfig = { thinkingLevel };
  const bodyObj = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: genConfig,
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60000);
  let res, data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
      signal: ac.signal,
    });
    data = await res.json();
  } catch (e) {
    clearTimeout(t);
    throw new Error(`Gemini fetch error (${model}): ${e.message}`);
  }

  if (!res.ok) {
    const msg = data.error?.message || `Gemini ${res.status}`;
    if (res.status === 429) throw new Error('Gemini rate limit — try again in 1 minute');
    if (res.status === 403) throw new Error('Gemini API key invalid or quota exceeded');
    throw new Error(msg);
  }

  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('Gemini: no candidates in response');

  const parts = candidate.content?.parts || [];
  const text = (parts.find(p => p.text && !p.thought) || parts.find(p => p.text))?.text;
  if (!text) throw new Error('Gemini: empty response');

  return parseJsonish(text);
}

export function buildAutopilotPrompt(params) {
  const days = Math.min(Math.max(parseInt(params.days) || 7, 1), 30);
  const postsPerWeek = Math.min(Math.max(parseInt(params.postsPerWeek) || 5, 1), 21);
  const targetCount = Math.max(1, Math.min(parseInt(params.targetCount) || Math.ceil(postsPerWeek * days / 7), 30));
  const platforms = Array.isArray(params.platforms) ? params.platforms.filter(Boolean) : [];
  if (!platforms.length) throw new Error('Autopilot requires explicit configured platforms; no platform fallback is allowed.');
  const platformCounts = params.platformCounts && typeof params.platformCounts === 'object' ? params.platformCounts : null;
  const campaign = params.campaign && typeof params.campaign === 'object' ? params.campaign : {};
  const audienceRegion = String(campaign.audienceRegion || params.audienceRegion || 'United States').trim() || 'United States';
  const audienceTimezones = Array.isArray(campaign.audienceTimezones) && campaign.audienceTimezones.length
    ? campaign.audienceTimezones.map(value => String(value).trim()).filter(Boolean).slice(0, 8)
    : ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
  const compact = (item) => ({
    id: item.listing_id || item.id,
    title: String(item.title || item.listing_title || '').slice(0, 180),
    description: String(item.description || '').slice(0, 800),
    price: item.price,
    url: item.url,
    image_url: item.image_url || item.listing_image_url,
    image_urls: Array.isArray(item.image_urls) ? item.image_urls.slice(0, 10) : [],
    views: item.views || 0,
    favorites: item.num_favorers || 0,
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 13) : [],
  });
  const listings = Array.isArray(params.listings) ? params.listings.map(compact) : [];
  const scheduledPosts = Array.isArray(params.scheduledPosts) ? params.scheduledPosts : [];
  const postHistory = Array.isArray(params.postHistory) ? params.postHistory : [];
  const reviews = Array.isArray(params.reviews) ? params.reviews : [];

  return `Create a ${days}-day social content plan.

Plan constraints:
- Start date: ${params.startDate || new Date().toISOString().slice(0, 10)}
- Target posts: ${targetCount}
- Posts per week preference: ${postsPerWeek}
- Platforms: ${platforms.join(', ')}
- Exact platform counts: ${platformCounts ? JSON.stringify(platformCounts) : 'Distribute evenly across selected platforms'}
- Campaign theme: ${campaign.theme || 'No explicit campaign theme'}
- Primary buyer audience: ${audienceRegion}
- Buyer audience time zones: ${audienceTimezones.join(', ')}
- Posting time window: ${campaign.timeWindow?.start || '09:00'}-${campaign.timeWindow?.end || '19:30'} in the selected buyer-audience timezone
- Return scheduled_at as an ISO UTC timestamp with Z. Also return scheduled_timezone and a short timing_reason explaining the selected audience window.
- Max posts per day: ${campaign.maxPostsPerDay || 2}
- Include weekends: ${campaign.includeWeekends === false ? 'No' : 'Yes'}
- Do not repeat the same listing within ${campaign.repeatListingAfterDays || 7} days unless there are not enough listings.
- Repeat policy: ${campaign.repeatScope === 'global' ? 'global across all platforms' : 'per-platform'}.
- Cross-platform reuse: ${campaign.allowCrossPlatformRepeat === false ? 'do not reuse a listing across different platforms inside the repeat window' : 'allowed when the platform angle/caption is different'}.
- Creative image preference: ${campaign.creativeMode || 'AI decides from supplied evidence'}.
- Tone: ${params.tone || 'warm, practical, shop-owner friendly'}
- Approval mode: ${params.approvalMode || 'save_drafts'}
- TikTok status: manual/draft only unless explicitly configured
- Avoid duplicate same listing/platform combinations already scheduled.
- Prefer listings that are not in recent post history.
- If reusing a listing on different platforms, make each caption/creative_brief platform-specific instead of copying the same angle.
- Decide media count, source, and final order independently for every platform. Set order on every media_items and generation_briefs entry. Return only listing media that materially supports the post; otherwise return generation_briefs.
- Use varied posting times across the supplied buyer-audience time zones and requested posting window. Daily cadence does not need a single universal best hour; avoid repeating the exact same local time when the plan spans multiple days.
- Do not schedule more than the requested max posts per day.
- If weekends are excluded, do not schedule posts on Saturdays or Sundays.
- Choose a varied calendar semantically; never create review/sale/current-event posts without supplied evidence.

Shop context:
${params.shopContext || 'No extra shop context provided.'}

Verified shop facts JSON:
${JSON.stringify(params.shopFacts || {})}

Verified factual changes JSON:
${JSON.stringify(params.factualChanges || {})}

Sale context:
${params.saleContext || 'No active sale context. Do not claim discounts.'}

Milestone context:
${params.milestoneContext || 'No verified milestone context. Avoid exact sales/review counts.'}

Upcoming seasonal context:
${params.seasonalContext || 'Use only general current-month/season angles if relevant.'}

Candidate listings JSON:
${JSON.stringify(listings)}

Already scheduled JSON:
${JSON.stringify(scheduledPosts)}

Recent post history JSON:
${JSON.stringify(postHistory)}

Review context JSON:
${JSON.stringify(reviews)}

Current research evidence JSON:
${JSON.stringify(params.currentResearch || { status: 'unavailable', external_research_used: false })}

Do not use a current event, news item, or trend unless current research evidence explicitly verifies it with supporting sources. When research is unavailable, use only truthful evergreen or shop-fact opportunities.

Keep each caption concise: Pinterest 180-300 chars, Instagram under 700 chars, Facebook under 220 chars, TikTok under 150 chars.
Return exactly ${targetCount} posts when enough listings exist. If exact platform counts are provided, match them exactly. Return ONLY JSON.`;
}

export async function generate(type, params, provider = 'claude', retryWithOther = true) {
  let systemPrompt, userPrompt;

  if (params._rawPrompt) {
    systemPrompt = params._rawSystem || 'You are a helpful Etsy expert. Be concise and specific.';
    userPrompt = params._rawPrompt;
  } else {
    if (type === 'listing') {
      const activeGuidance = guidanceRuntimePrompt(await getActiveEtsyGuidance());
      systemPrompt = applyActiveEtsyGuidance(
        LISTING_SYSTEM,
        activeGuidance.standards,
        ETSY_LISTING_STANDARDS_PROMPT,
      );
    } else {
      systemPrompt = type === 'autopilot' ? AUTOPILOT_SYSTEM : SOCIAL_SYSTEM;
    }

    if (type === 'listing') {
      userPrompt = `Product type: ${params.productType}
Listing type: ${params.listingType}
My product description: ${params.description}
My target price: $${params.price || 'suggest based on market'}
Extra notes: ${params.extra || 'none'}

${params.competitorData ? `## COMPETITOR MARKET ANALYSIS
Top competing listings found on Etsy for this product:
${params.competitorData}

Use this evidence to understand the price range and factual buyer expectations. Do not copy titles, assume that ranking proves quality, or force a percentile target. Explain any uncertainty behind the price suggestion.` : ''}

${params.shopContext ? params.shopContext : ''}

Generate a complete, accurate, buyer-friendly Etsy listing using the current Etsy guidance in the system instructions. Do not promise ranking, traffic, conversion, or sales results.
The product brief may be written in any language. Return the complete listing in English (US) only.
Run the PRE-OUTPUT CHECKLIST mentally before writing JSON. Fix any failing fields before outputting.`;
    } else if (type === 'autopilot') {
      userPrompt = buildAutopilotPrompt(params);
    } else {
      userPrompt = `Etsy listing title: ${params.title}
Price: $${params.price}
Listing URL: ${params.url || 'link in bio'}
Product type: ${params.productType || 'digital product'}
Tone: ${params.tone || 'engaging'}
Generate platform-specific social media posts to promote this product.`;
    }
  }

  const thinkingLevel = params._thinkingLevel ?? (type === 'social' ? 'NONE' : 'HIGH');

  const normalizeResult = (result) => (type === 'listing' ? sanitizeListingAiResult(result) : result);

  try {
    if (provider === 'claude') {
      return normalizeResult(await generateWithClaude(systemPrompt, userPrompt, params.model));
    } else if (provider === 'external') {
      return normalizeResult(await generateWithExternalAi(systemPrompt, userPrompt, params.model));
    } else {
      return normalizeResult(await generateWithGemini(systemPrompt, userPrompt, params.model, thinkingLevel));
    }
  } catch (err) {
    const isCreditError = err.message.startsWith('FALLBACK:');
    // Do not conceal invalid requests, policy rejections, or credentials by
    // silently changing models. Provider routing only advances on an
    // operationally retryable failure.
    if (!isCreditError && !isRetryableExternalAiFailure(err)) throw err;
    if (!retryWithOther && !isCreditError) throw err;

    const canFallbackToGemini = !!process.env.GEMINI_API_KEY;
    const canFallbackToClaude = !!process.env.ANTHROPIC_API_KEY;
    const canFallback = provider === 'claude' ? canFallbackToGemini : canFallbackToClaude;

    if (!canFallback) throw err;

    console.warn(`[_generate] ${provider} failed (${err.message}), falling back to ${provider === 'claude' ? 'gemini' : 'claude'}...`);
    try {
      if (provider === 'claude') {
        return normalizeResult(await generateWithGemini(systemPrompt, userPrompt, undefined, thinkingLevel));
      } else {
        return normalizeResult(await generateWithClaude(systemPrompt, userPrompt));
      }
    } catch (fallbackErr) {
      throw new Error(`${provider} failed: ${err.message}. Fallback also failed: ${fallbackErr.message}`);
    }
  }
}
