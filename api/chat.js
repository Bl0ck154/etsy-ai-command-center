// api/chat.js — Conversational AI agent with Etsy tool use + SSE streaming

export const maxDuration = 60;

const MAX_CHAT_MESSAGES = 40;

export function limitChatMessages(messages = []) {
  const clean = Array.isArray(messages) ? messages.filter(m => m?.role && m.content !== undefined) : [];
  return clean.slice(-MAX_CHAT_MESSAGES);
}

import { requireAuth } from './_auth.js';
import { etsyFetch, getListingWithInventory, API_KEY_FULL } from './_etsy.js';
import { LISTING_SYSTEM } from './_generate.js';
import { MODEL } from './_config.js';
import { generateWithExternalAi, getExternalAiRuntimeConfig, hasExternalAiConfigAsync, hasExternalImageConfigAsync, buildProviderUrl } from './_external-ai.js';
import { generateMediaImages } from './media.js';
import { isCurrentPaidReceipt, receiptLifecycle } from '../public/utils/receipt-lifecycle.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY    = process.env.GEMINI_API_KEY;
const SHOP_ID       = process.env.ETSY_SHOP_ID;
const GEMINI_MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL.gemini}:generateContent?key=${GEMINI_KEY}`;
const GEMINI_IMAGE_MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL.geminiImage}:generateContent?key=${GEMINI_KEY}`;

async function setListingPersonalization(listing_id, instructions, required = false, max_allowed_characters = 1024) {
  if (!instructions) return { success: true, skipped: true };
  await etsyFetch(`/shops/${SHOP_ID}/listings/${listing_id}/personalization?supports_multiple_personalization_questions=true`, {
    method: 'POST',
    body: JSON.stringify({
      personalization_questions: [{
        question_type: 'text_input',
        question_text: 'Personalization',
        instructions,
        required,
        max_allowed_characters,
      }],
    }),
  });
  return { success: true };
}

// ── Tool implementations ───────────────────────────────────────────────────────
const toolHandlers = {

  async get_shop_info() {
    const shop = await etsyFetch(`/shops/${SHOP_ID}`);
    return {
      name: shop.shop_name,
      title: shop.title,
      listing_count: shop.listing_active_count,
      sales: shop.transaction_sold_count,
      rating: shop.review_average,
      url: shop.url,
    };
  },

  async get_listings({ state = 'active', limit = 10, sort_on = 'created' }) {
    const data = await etsyFetch(
      `/shops/${SHOP_ID}/listings?state=${state}&limit=${limit}&sort_on=${sort_on}&sort_order=desc&includes=images`
    );
    return (data.results || []).map(l => ({
      id: l.listing_id,
      title: l.title,
      price: l.price ? `$${(l.price.amount / l.price.divisor).toFixed(2)}` : 'N/A',
      state: l.state,
      views: l.views,
      favorites: l.num_favorers,
      url: l.url,
    }));
  },

  async get_listing({ listing_id }) {
    const l = await getListingWithInventory(listing_id, ['Images']);
    return {
      id: l.listing_id,
      title: l.title,
      description: l.description?.substring(0, 500) + '...',
      price: l.price ? `$${(l.price.amount / l.price.divisor).toFixed(2)}` : 'N/A',
      state: l.state,
      tags: l.tags,
      views: l.views,
      favorites: l.num_favorers,
      is_personalizable: l.is_personalizable,
      url: l.url,
    };
  },

  async get_shop_config() {
    const [shipping, returns, sections, readiness] = await Promise.all([
      etsyFetch(`/shops/${SHOP_ID}/shipping-profiles`),
      etsyFetch(`/shops/${SHOP_ID}/policies/return`),
      etsyFetch(`/shops/${SHOP_ID}/sections`),
      etsyFetch(`/shops/${SHOP_ID}/readiness-state-definitions`),
    ]);
    return {
      shipping_profiles: (shipping.results || []).map(s => ({ id: s.shipping_profile_id, name: s.title })),
      return_policies:   (returns.results  || []).map(r => ({ id: r.return_policy_id, accepts_returns: r.accepts_returns })),
      shop_sections:     (sections.results || []).map(s => ({ id: s.shop_section_id, title: s.title })),
      readiness_profiles: (readiness.results || []).map(profile => ({
        id: profile.readiness_state_id,
        state: profile.readiness_state,
        min_processing_days: profile.min_processing_days,
        max_processing_days: profile.max_processing_days,
      })),
    };
  },

  async generate_listing_text({ product_type, niche, description, price, extra_context }) {
    const userPrompt = `Generate a complete Etsy listing for the following product. Return ONLY valid JSON, no markdown.

Product type: ${product_type}
Niche/Theme: ${niche || 'general'}
Description: ${description}
Target price: $${price || 'suggest based on market'}
Extra context: ${extra_context || 'none'}

JSON schema:
{
  "title": "natural language, primary keyword first 3-5 words, max 140 chars",
  "description": "GEO-optimised, 350-500 words, emoji section headers",
  "tags": ["...exactly 13 tags, each max 20 chars..."],
  "materials": ["...up to 13, empty array if digital..."],
  "price_suggestion": 0.00,
  "personalization_instructions": "buyer-facing copy-paste text or empty string",
  "seo_notes": "3 specific 2026 tactics"
}`;

    if (await hasExternalAiConfigAsync()) {
      try {
        const raw = await generateWithExternalAi(LISTING_SYSTEM, userPrompt, MODEL.external);
        const match = String(raw || '').match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
      } catch (err) {
        console.warn('[chat] external listing generation failed, using fallback:', err?.message || err);
      }
    }

    if (GEMINI_KEY) {
      const res = await fetch(
        GEMINI_MODEL_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: LISTING_SYSTEM }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          }),
        }
      );
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    }

    if (ANTHROPIC_KEY) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL.claudeChat, max_tokens: 8192, system: LISTING_SYSTEM, messages: [{ role: 'user', content: userPrompt }] }),
      });
      const data = await res.json();
      const text = data.content?.[0]?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    }

    throw new Error('No AI provider configured');
  },

  async create_listing({ title, description, price, tags, materials, listing_type = 'physical',
    who_made = 'i_did', when_made = 'made_to_order', shipping_profile_id,
    readiness_state_id, return_policy_id, shop_section_id, taxonomy_id, quantity = 999,
    is_personalizable = true, personalization_instructions, state = 'draft' }) {

    if (listing_type !== 'download' && (!shipping_profile_id || !readiness_state_id || !taxonomy_id)) {
      throw new Error('Physical listings require taxonomy_id, shipping_profile_id, and readiness_state_id from get_shop_config.');
    }

    const cleanTags = (tags || []).filter(t => t.length <= 20).slice(0, 13);
    const body = {
      title, description,
      price: parseFloat(price),
      quantity, who_made, when_made, listing_type,
      tags: cleanTags,
      materials: (materials || []).slice(0, 13),
      should_auto_renew: true,
      state,
    };
    if (taxonomy_id)         body.taxonomy_id = parseInt(taxonomy_id);
    if (shipping_profile_id) body.shipping_profile_id = parseInt(shipping_profile_id);
    if (return_policy_id)    body.return_policy_id = parseInt(return_policy_id);
    if (shop_section_id)     body.shop_section_id = parseInt(shop_section_id);
    if (readiness_state_id) body.readiness_state_id = parseInt(readiness_state_id);
    const result = await etsyFetch(`/shops/${SHOP_ID}/listings?legacy=false`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (is_personalizable) {
      await setListingPersonalization(result.listing_id, personalization_instructions, false, 1024);
    }

    return {
      success: true,
      listing_id: result.listing_id,
      state: result.state,
      url: result.url,
      title: result.title,
    };
  },

  async update_listing({ listing_id, ...fields }) {
    const body = {};
    if (fields.title)       body.title = fields.title;
    if (fields.description) body.description = fields.description;
    if (fields.price)       body.price = parseFloat(fields.price);
    if (fields.tags)        body.tags = fields.tags.filter(t => t.length <= 20).slice(0, 13);
    if (fields.materials)   body.materials = fields.materials.slice(0, 13);
    if (fields.state)       body.state = fields.state;
    const result = await etsyFetch(`/shops/${SHOP_ID}/listings/${listing_id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    if (fields.is_personalizable !== undefined) {
      if (fields.is_personalizable) {
        await setListingPersonalization(listing_id, fields.personalization_instructions, false, 1024);
      } else {
        await etsyFetch(`/shops/${SHOP_ID}/listings/${listing_id}/personalization`, { method: 'DELETE' });
      }
    }
    return { success: true, listing_id: result.listing_id, title: result.title, state: result.state };
  },

  async set_listing_variations({ listing_id, variations, readiness_state_id }) {
    if (!readiness_state_id) throw new Error('readiness_state_id from get_shop_config is required for physical listing variations.');
    const VALUE_IDS = {
      '1-2': 54414117357, '3-4': 52314411244, '5-6': 52314411350,
      '7-8': 52314411456, '9-10': 52314411562,
    };
    const products = variations.map(v => ({
      property_values: [{
        property_id: 513,
        property_name: 'number of people/items to add/take off',
        value_ids: [VALUE_IDS[v.label] || 54414117357],
        values: [v.label],
      }],
      offerings: [{
        price: parseFloat(v.price),
        quantity: v.quantity || 999,
        is_enabled: true,
        readiness_state_id: parseInt(readiness_state_id),
      }],
    }));
    const result = await etsyFetch(`/listings/${listing_id}/inventory`, {
      method: 'PUT',
      body: JSON.stringify({ products, price_on_property: [513] }),
    });
    return { success: true, variations_set: result.products?.length || 0 };
  },

  async get_shop_config_simple() {
    return toolHandlers.get_shop_config();
  },

  async get_recent_orders({ limit = 5 }) {
    const data = await etsyFetch(
      `/shops/${SHOP_ID}/receipts?limit=${limit}&was_paid=true&sort_on=created&sort_order=desc&includes=transactions`
    );
    return (data.results || []).filter(isCurrentPaidReceipt).map(r => ({
      receipt_id: r.receipt_id,
      buyer: r.name,
      total: `$${((r.grandtotal?.amount || 0) / (r.grandtotal?.divisor || 100)).toFixed(2)}`,
      status: receiptLifecycle(r).key,
      created: new Date((r.create_timestamp || 0) * 1000).toLocaleDateString(),
      items: (r.transactions || []).map(t => t.title).slice(0, 3),
    }));
  },

  async generate_image_prompt({ listing_title, style = 'product' }) {
    const prompts = {
      product: `Etsy cover image for: "${listing_title}". GOAL: A high-converting square cover image that instantly shows the buyer what they are getting and makes them want to click. SUBJECT: Show the actual product result or core deliverable — the finished design, artwork, template preview, or service output. Not a generic concept. COMPOSITION: Clean, uncluttered. Subject dominates the frame. Light neutral or white background. Subject sharp and clearly legible. STYLE: Soft even lighting, no harsh shadows. Vivid but realistic colours. If the product involves text or typography, render it clearly within the image. No watermarks, no UI overlays, no promotional banners. Photorealistic, ultra-sharp, professional commercial quality that stops a buyer mid-scroll.`,
      lifestyle: `Etsy lifestyle image for: "${listing_title}". GOAL: Show the buyer the emotional outcome — how their life or work looks AFTER using this product or service. The scene should feel aspirational yet genuine and relatable, not staged or stock-photo generic. SUBJECT: The product result naturally integrated into a real-world context that fits the product type — a workspace, a celebratory moment, a creative environment, a personal keepsake being held. MOOD: Warm, inviting, emotionally resonant. Tells a story at a glance. COMPOSITION: Product or result clearly visible in the upper portion of the frame (safe from Pinterest/Instagram crop). Soft background depth. Warm natural light feel. STYLE: Editorial quality, authentic, personal. Colours warm and rich but not oversaturated. No text overlays, no logos.`,
      before_after: `Before/after comparison image for: "${listing_title}". FORMAT: Clean 50/50 horizontal split. LEFT: the "before" state — shows the original, unimproved version (faded, old, low quality, unedited — whatever is appropriate for this service). RIGHT: the "after" state — the dramatically improved, polished, professional result after the service is applied. The contrast between the two sides should be immediately obvious and impressive. DIVIDER: Thin clean line at the centre split. Small "Before" label bottom-left, "After" label bottom-right in minimal sans-serif text. BACKGROUND: Neutral light grey surrounding the two panels, giving them equal visual weight. STYLE: Clear, professional, dramatic transformation. The "after" side should look exceptional — it is the selling point. Photorealistic. No extra decorative elements or promotional banners.`,
    };
    return {
      recommended_prompt: prompts[style] || prompts.product,
      all_prompts: prompts,
      note: 'Review prompt before generating. Confirm with user first — each image costs API credits.',
    };
  },

  async generate_image({ prompt }) {
    if (await hasExternalImageConfigAsync()) {
      const result = await generateMediaImages({
        prompt,
        provider: 'external',
        count: 1,
        aspectRatio: '1:1',
      });
      const image = result.images?.[0];
      if (image?.base64) {
        return {
          success: true,
          image_base64: image.base64,
          mime_type: image.mimeType || 'image/png',
          provider: image.provider || result.provider || 'external',
          model: image.model || result.model || MODEL.externalImage,
        };
      }
    }
    if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not configured');
    const res = await fetch(
      GEMINI_IMAGE_MODEL_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Image generation failed');
    const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!part) throw new Error('No image in response');
    return { success: true, image_base64: part.inlineData.data, mime_type: part.inlineData.mimeType || 'image/jpeg' };
  },
};

// ── Tool schemas ───────────────────────────────────────────────────────────────
const TOOL_SCHEMAS = [
  { name: 'get_shop_info', description: 'Get shop info (name, sales, rating)' },
  { name: 'get_listings', description: 'Get listings. Params: state (active/draft), limit (1-25), sort_on (created/views)',
    params: { state: 'string', limit: 'number', sort_on: 'string' } },
  { name: 'get_listing', description: 'Get full details of one listing', params: { listing_id: 'number' }, required: ['listing_id'] },
  { name: 'get_shop_config_simple', description: 'Get the current shop shipping, processing/readiness, return-policy, and section IDs before preparing a physical listing. Never invent or reuse a remembered ID.' },
  { name: 'generate_listing_text', description: 'Generate SEO title, description, tags using AI',
    params: { product_type: 'string', niche: 'string', description: 'string', price: 'number', extra_context: 'string' },
    required: ['product_type', 'description'] },
  { name: 'create_listing', description: 'Create a new Etsy listing. Always use state=draft first.',
    params: {
      title: 'string', description: 'string', price: 'number',
      tags: 'array', materials: 'array', listing_type: 'string',
      shipping_profile_id: 'number', return_policy_id: 'number',
      readiness_state_id: 'number',
      shop_section_id: 'number', taxonomy_id: 'number',
      state: 'string', is_personalizable: 'boolean',
      personalization_instructions: 'string',
    },
    required: ['title', 'description', 'price'] },
  { name: 'update_listing', description: 'Update fields on a listing',
    params: { listing_id: 'number', title: 'string', description: 'string', price: 'number', tags: 'array', state: 'string' },
    required: ['listing_id'] },
  { name: 'set_listing_variations', description: 'Set physical-listing price tiers. Each price is the final total the buyer pays. Use the readiness_state_id selected from current shop config.',
    params: { listing_id: 'number', variations: 'array', readiness_state_id: 'number' }, required: ['listing_id', 'variations', 'readiness_state_id'] },
  { name: 'get_recent_orders', description: 'Get recent orders', params: { limit: 'number' } },
  { name: 'generate_image_prompt', description: 'Get image generation prompt (show to user before generating)',
    params: { listing_title: 'string', style: 'string' }, required: ['listing_title'] },
  { name: 'generate_image', description: 'Generate image with Gemini when the user clearly asks for image generation. Do not ask for confirmation before helper/tool steps; briefly explain the result after the tool returns.',
    params: { prompt: 'string' }, required: ['prompt'] },
];

function toClaudeTools() {
  return TOOL_SCHEMAS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object',
      properties: t.params ? Object.fromEntries(
        Object.entries(t.params).map(([k, v]) => [k, {
          type: v === 'array' ? 'array' : v,
          ...(v === 'array' ? { items: { type: 'string' } } : {}),
        }])
      ) : {},
      required: t.required || [],
    },
  }));
}

function toGeminiTools() {
  return [{
    function_declarations: TOOL_SCHEMAS.map(t => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.params ? Object.fromEntries(
          Object.entries(t.params).map(([k, v]) => [k, {
            type: v === 'array' ? 'array' : v === 'number' ? 'number' : v === 'boolean' ? 'boolean' : 'string',
            ...(v === 'array' ? { items: { type: 'string' } } : {}),
          }])
        ) : {},
        required: t.required || [],
      },
    })),
  }];
}

function toOpenAiTools() {
  return TOOL_SCHEMAS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.params ? Object.fromEntries(
          Object.entries(t.params).map(([k, v]) => [k, {
            type: v === 'array' ? 'array' : v === 'number' ? 'number' : v === 'boolean' ? 'boolean' : 'string',
            ...(v === 'array' ? { items: { type: 'string' } } : {}),
          }])
        ) : {},
        required: t.required || [],
      },
    },
  }));
}

const SYSTEM_PROMPT = `You are an expert Etsy shop assistant for FineTeesDesign (shop ID: ${SHOP_ID}).
The shop sells: AI photo editing services, custom songs, digital templates, sublimation designs, custom portraits.

Your role: Help the owner create and manage Etsy listings conversationally.

## Proactive agent behavior:
- Use available tools immediately when the task is clear. Do not ask permission before reading shop data, finding listings, drafting text, generating helper content, or preparing a preview.
- Ask clarifying questions only when the product, target listing, price/change, or publishing intent is genuinely ambiguous.
- For multi-step tasks, chain the needed tool calls in the same turn. The normal budget is up to 12 iterations.
- Approval is required only before final Etsy write actions such as create_listing or update_listing, not before intermediate tool calls.

## Creating a listing — always in this order:
1. Call get_shop_config_simple to get standard IDs
2. Call get_listings (limit=5, sort_on=views) — study top listings for inspiration (price, title style, structure)
3. Call generate_listing_text — pass the user's price as 'price' param
4. Show a structured preview to the user BEFORE creating — see format below
5. Wait for confirmation only before the final create_listing write (quantity=999 always)
6. Call set_listing_variations if the service has price tiers (quantity=999 per tier)
7. Offer to generate a cover image

## NEVER:
- Create without user confirmation
- quantity < 999
- Dump raw JSON or unformatted text at the user

## Listing preview format (use EXACTLY this structure):

📋 **Listing Draft**

**Title:** [title]

**Price:** $[price]

**Tags:** [tag1] · [tag2] · [tag3] · [all 13 separated by ·]

**Description preview:**
[first 3-5 lines of the description, keep line breaks]

---

Ready to create as draft? Reply **yes** to publish, or tell me what to change.

## Shop configuration:
- Always call get_shop_config_simple and choose IDs from its current result.
- For every physical listing, select a matching taxonomy_id, shipping_profile_id, and readiness_state_id before proposing creation.
- Never invent, remember, or hardcode shop configuration IDs.

## SEO + GEO 2026 rules (Etsy Muse AI — critical):
- TITLES: Natural language, primary keyword in first 3-5 words, max 140 chars. Muse penalises keyword stuffing. Include one buyer-benefit phrase ("perfect gift", "instant download").
- TAGS: All 13 required, max 20 chars each. Mix buyer-intent queries ("gift for grieving mom"), occasion/recipient tags ("mothers day gift"), and specific descriptors. NEVER repeat title words — Muse combines them automatically.
- DESCRIPTION: First 160 chars = AI snippet for Google Shopping AND Etsy Muse. Must have: primary keyword + differentiator + emotional hook. Use emoji anchors (✅🎨💌📥⚖️) as GEO section headers — AI parsers extract structured data from these. Target 350-500 words.
- ATTRIBUTES: Always recommend filling Color, Style, Occasion, Holiday attributes — 30% more impressions from Muse AI categorisation.

## Image generation:
- If the user clearly asks for an image, generate it without asking for a separate helper-step confirmation.
- Keep image replies concise and buyer-facing; do not expose tool names.

## Style:
- Direct and efficient — the owner is busy
- Always create as draft first
- Respond in the SAME language the user writes in — if Ukrainian, reply in Ukrainian; if English, reply in English. Never switch languages.`;

// ── Claude streaming agentic loop ──────────────────────────────────────────────
async function runClaudeStream(messages, maxIterations, write) {
  let conversation = [...messages];

  for (let i = 0; i < maxIterations; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL.claudeChat,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: toClaudeTools(),
        messages: conversation,
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude ${res.status}`);
    }

    // Parse SSE stream from Claude
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let fullText = '';
    let toolUses = [];
    let curTool = null;
    let toolInputBuf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }

        if (evt.type === 'content_block_start') {
          const cb = evt.content_block;
          if (cb?.type === 'tool_use') {
            curTool = { id: cb.id, name: cb.name };
            toolInputBuf = '';
            write({ type: 'tool', name: cb.name });
          }
        }
        if (evt.type === 'content_block_delta') {
          const d = evt.delta;
          if (d?.type === 'text_delta') {
            fullText += d.text;
            write({ type: 'delta', text: d.text });
          }
          if (d?.type === 'input_json_delta' && curTool) {
            toolInputBuf += d.partial_json || '';
          }
        }
        if (evt.type === 'content_block_stop' && curTool) {
          let input = {};
          try { input = JSON.parse(toolInputBuf); } catch {}
          toolUses.push({ ...curTool, input });
          curTool = null;
          toolInputBuf = '';
        }
      }
    }

    // No tool calls — final text was already streamed
    if (toolUses.length === 0) return fullText;

    // Build conversation turn and execute tools
    const contentBlocks = [];
    if (fullText) contentBlocks.push({ type: 'text', text: fullText });
    for (const tu of toolUses) {
      contentBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
    conversation.push({ role: 'assistant', content: contentBlocks });

    const toolResults = [];
    for (const tu of toolUses) {
      let result;
      try { result = await toolHandlers[tu.name]?.(tu.input) ?? { error: `Unknown tool: ${tu.name}` }; }
      catch (err) { result = { error: err.message }; }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    conversation.push({ role: 'user', content: toolResults });

    // Reset for next iteration
    toolUses = []; fullText = '';
  }

  return 'Processing limit reached.';
}

// ── Gemini streaming agentic loop ──────────────────────────────────────────────
function toGeminiMessages(msgs) {
  return msgs.map(m => {
    if (typeof m.content === 'string') {
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
    }
    const parts = [];
    for (const block of m.content) {
      if (block.type === 'text') parts.push({ text: block.text });
      else if (block.type === 'tool_use') {
        parts.push({ functionCall: { name: block.name, args: block.input } });
      } else if (block.type === 'tool_result') {
        let parsed;
        try { parsed = JSON.parse(block.content); } catch { parsed = { result: block.content }; }
        parts.push({ functionResponse: { name: block.tool_use_id, response: parsed } });
      }
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
}

async function runGeminiStream(messages, maxIterations, write) {
  let geminiMessages = toGeminiMessages(messages);

  for (let i = 0; i < maxIterations; i++) {
    let res, data;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(
        GEMINI_MODEL_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            tools: toGeminiTools(),
            contents: geminiMessages,
          }),
        }
      );
      data = await res.json();
      const isHighDemand = !res.ok && (res.status === 503 ||
        (data.error?.message || '').toLowerCase().includes('high demand') ||
        (data.error?.message || '').toLowerCase().includes('temporarily'));
      if (!isHighDemand) break;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }

    if (!res.ok) throw new Error(data.error?.message || `Gemini ${res.status}`);

    const parts = data.candidates?.[0]?.content?.parts || [];
    const funcCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text && !p.thought);

    // No tool calls — stream the text word-by-word
    if (funcCalls.length === 0) {
      const text = textParts.map(p => p.text).join('');
      const tokens = text.split(/(\s+)/);
      for (const token of tokens) {
        if (token) write({ type: 'delta', text: token });
        if (token.trim()) await new Promise(r => setTimeout(r, 18));
      }
      return text;
    }

    // Tool calls — send indicators and execute
    geminiMessages.push({ role: 'model', parts });
    const resultParts = [];
    for (const { functionCall } of funcCalls) {
      write({ type: 'tool', name: functionCall.name });
      let result;
      try { result = await toolHandlers[functionCall.name]?.(functionCall.args) ?? { error: `Unknown tool: ${functionCall.name}` }; }
      catch (err) { result = { error: err.message }; }
      const responseObj = Array.isArray(result) ? { items: result } : (result && typeof result === 'object' ? result : { value: result });
      resultParts.push({ functionResponse: { name: functionCall.name, response: responseObj } });
    }
    geminiMessages.push({ role: 'user', parts: resultParts });
  }

  return 'Processing limit reached.';
}

async function runExternalStream(messages, maxIterations, write) {
  const config = await getExternalAiRuntimeConfig();
  let conversation = messages.map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.content || ''),
  }));

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const res = await fetch(buildProviderUrl(config.baseUrl, config.textPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.textModel || MODEL.external,
        stream: false,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...conversation],
        tools: toOpenAiTools(),
        tool_choice: 'auto',
        max_tokens: 4096,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || data.message || `External AI ${res.status}`);

    const message = data.choices?.[0]?.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      const text = String(message.content || '');
      for (const token of text.split(/(\s+)/)) {
        if (token) write({ type: 'delta', text: token });
      }
      return text;
    }

    conversation.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: calls,
    });
    for (const call of calls) {
      const name = call.function?.name;
      let input = {};
      try { input = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch {}
      write({ type: 'tool', name });
      let result;
      try { result = await toolHandlers[name]?.(input) ?? { error: `Unknown tool: ${name}` }; }
      catch (err) { result = { error: err.message }; }
      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
  return 'Processing limit reached.';
}

// ── Main handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages: rawMessages = [], max_iterations = 12, provider = 'auto' } = req.body;
  const messages = limitChatMessages(rawMessages);
  if (!messages.length) return res.status(400).json({ error: 'messages required' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const write = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const hasExternal = await hasExternalAiConfigAsync();
  const useExternal = (provider === 'external') ? hasExternal : (provider === 'auto' && hasExternal);
  const useGemini = (provider === 'gemini') || (!useExternal && provider === 'auto' && GEMINI_KEY && GEMINI_KEY !== 'your_google_ai_studio_key');
  const useClaude = (provider === 'claude') || (!useExternal && provider === 'auto' && ANTHROPIC_KEY);

  if (!useExternal && !useGemini && !useClaude) {
    write({ type: 'error', error: 'No AI provider configured. Add a supported provider key to the server environment.' });
    return res.end();
  }

  try {
    let message;
    if (useExternal) {
      message = await runExternalStream(messages, max_iterations, write);
    } else if (useGemini) {
      message = await runGeminiStream(messages, max_iterations, write);
    } else {
      message = await runClaudeStream(messages, max_iterations, write);
    }
    write({ type: 'done', message });
    res.end();
  } catch (err) {
    // Auto-fallback
    if (useExternal && provider === 'auto') {
      const fallback = GEMINI_KEY && GEMINI_KEY !== 'your_google_ai_studio_key'
        ? runGeminiStream(messages, max_iterations, write)
        : ANTHROPIC_KEY
          ? runClaudeStream(messages, max_iterations, write)
          : null;
      if (fallback) {
        try {
          const message = await fallback;
          write({ type: 'done', message });
          res.end();
          return;
        } catch {}
      }
    }
    if (useGemini && useClaude && provider === 'auto') {
      try {
        const message = await runClaudeStream(messages, max_iterations, write);
        write({ type: 'done', message });
        res.end();
        return;
      } catch {}
    }
    write({ type: 'error', error: err.message });
    res.end();
  }
}
