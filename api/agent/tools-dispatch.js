// api/agent/tools-dispatch.js — AI Agent tool dispatch and execution handlers

import { etsyFetch, getListingWithInventory, getShopId } from '../_etsy.js';
import ivm from 'isolated-vm';
import { AGENT_SYSTEM, GENERIC_LISTING_UPDATE_FIELDS, LISTING_IMAGE_VISION_MAX_BYTES, LISTING_IMAGE_VISION_MAX_IMAGES, LISTING_IMAGE_VISION_MIME_TYPES, LISTING_IMAGE_VISION_TIMEOUT_MS, SPECIALIZED_LISTING_FLOW_FIELDS, UPDATE_DISPLAY_FIELDS, analyzeListingImages, auditGenericListingUpdateSafety, auditListing, buildAgentContextBrief, buildClearVariationsPlan, buildDuplicateTitleRewriteUpdate, buildFallbackImagePrompt, buildInventoryPriceUpdatePlan, buildListingDisplayAppendix, buildListingVisionPrompt, buildPersonalizationUpdate, buildPriceMultiplierInventoryPlan, buildRemoveVariationPropertyPlan, callClaudeVision, callExternalVision, callGeminiVision, clampInventoryQuantity, compactProductsByRemainingProperties, contextListingLine, englishFileUploadQuestions, enrichListingImagePlanWithVision, enrichProposedUpdates, extractCandidateTitleFromAssistantText, extractExplicitTitleFromText, extractRequestedImageRanks, fallbackEnglishDuplicateDescription, fallbackEnglishDuplicateTitle, fetchActiveListingsForFallback, fetchListingImageForVision, findBestListingMention, findListingByInventoryProperty, findListingForForcedVariationRemoval, findListingIdInMessages, findListingMentionedInMessages, generateDuplicateTitle, getPersonalizationQuestions, hasCyrillic, hasVariationInventorySnapshot, hasWritableUpdateFields, isDisplayOnlyUpdateField, isTrustedListingImageUrl, kvRequest, latestUserText, listingAgentImageUrl, listingAgentUrl, listingContentHasCyrillic, listingDetailsCacheIsAuthoritative, listingDetailsForAgent, listingDisplayMetadata, listingFromId, loadShopOperatingContext, mapListingForAgent, mergeWithPendingUpdate, messagesWithContextBrief, messagesWithResultContext, moneyNumber, normalizeDropdownOptionLabel, normalizeDuplicateProposal, normalizeGeneratedTitle, normalizeImageRef, normalizeListingImageProposal, normalizeProposedPersonalizationQuestions, normalizeProposedUpdates, normalizeUpdateComparable, normalizeVisionAnalysisPayload, parseGeneratedTitle, parseVisionJson, priceNumber, priceRangeLabel, priceToNumber, priceUpdatedInventoryProducts, productPrice, productQuantity, rankListingsForQuery, referenceImageForListingPlan, removeUnchangedUpdateFields, requestedListingLimit, roundMoney, runWithExternal, sanitizeImagePromptText, sanitizeVisionText, saveShopOperatingContext, selectAgentProvider, selectedImagesFromInput, singleInventoryFallback, singleProductFromFallback, stripEmbeddedImagePayloads, summarizeInventory, summarizeProductsVariationOptions, summarizeVisionForImagePrompt, tokenMatchStrength, tokenizeSearchText, updateValuesEqual, validImageMagic, validateProposedUpdates, wantsCancelledDuplicateRewrite } from './helpers.js';
import { IMAGE_PLAN_UI_COPY_REQUIRED } from './tools-schema.js';
import { isActionableOpenReceipt, isCurrentPaidReceipt, receiptLifecycle } from '../../public/utils/receipt-lifecycle.js';
import { toolFaultResult, validateListingImageTransition } from '../../public/utils/agent-runtime-contract.js';
import { appendUserAgentMemory, deleteUserAgentMemory } from '../kv.js';
import {
  getMessageConversationForAgent,
  listMessageConversationsForAgent,
  loadMessageAutomationPolicy,
  loadMessagePlaybook,
  prepareMessageDraftForAgent,
  updateMessageAutomationPolicyForAgent,
  updateMessagePlaybookForAgent,
} from '../messages/agent-tools.js';
export * from './helpers.js';

const SHOP_ID = getShopId();

export async function fetchShopFulfillmentProfiles(fetcher = etsyFetch, shopId = SHOP_ID) {
  const [shipping, readiness] = await Promise.all([
    fetcher(`/shops/${shopId}/shipping-profiles`),
    fetcher(`/shops/${shopId}/readiness-state-definitions?limit=100`),
  ]);
  return {
    shipping_profiles: (shipping.results || []).map(profile => ({
      id: Number(profile.shipping_profile_id),
      title: profile.title || `Shipping profile ${profile.shipping_profile_id}`,
      origin_country: profile.origin_country_iso || null,
    })),
    readiness_profiles: (readiness.results || []).map(profile => ({
      id: Number(profile.readiness_state_id),
      state: profile.readiness_state || null,
      processing_time: profile.processing_days_display_label
        || `${profile.min_processing_days || '?'}-${profile.max_processing_days || '?'} days`,
    })),
  };
}

export function sellerTaxonomyCandidates(tree = [], query = '', limit = 12) {
  const wanted = tokenizeSearchText(query);
  if (!wanted.length) return [];
  const rows = [];
  const walk = (nodes, parents = []) => {
    for (const node of nodes || []) {
      const name = String(node.name || '').trim();
      const path = [...parents, name].filter(Boolean);
      const haystack = tokenizeSearchText(path.join(' '));
      const matched = wanted.filter(token => haystack.some(candidate => tokenMatchStrength(token, candidate) > 0)).length;
      if (node.id && matched) rows.push({ taxonomy_id: Number(node.id), name, path: path.join(' > '), score: matched / wanted.length });
      walk(node.children || [], path);
    }
  };
  walk(Array.isArray(tree) ? tree : tree.results || []);
  return rows.sort((a, b) => b.score - a.score || b.path.length - a.path.length).slice(0, Math.max(1, Math.min(25, limit)));
}

export async function executeTool(name, input, context = {}) {
  try {
    switch (name) {
      case 'list_message_conversations':
        return listMessageConversationsForAgent(input);

      case 'get_message_conversation':
        return getMessageConversationForAgent(input.conversation_id);

      case 'get_message_playbook':
        return loadMessagePlaybook(SHOP_ID);

      case 'update_message_playbook':
        return updateMessagePlaybookForAgent(
          SHOP_ID,
          input,
          context._owner_id,
        );

      case 'get_message_automation_policy':
        return loadMessageAutomationPolicy(SHOP_ID);

      case 'update_message_automation_policy':
        return updateMessageAutomationPolicyForAgent(
          SHOP_ID,
          input,
          context._owner_id,
        );

      case 'prepare_message_draft':
        return prepareMessageDraftForAgent(
          { ...input, shop_id: SHOP_ID },
          context._owner_id,
          context._request_id,
        );

      case 'list_shop_listings': {
        const inputOffset = input.offset || 0;
        const state = input.state || 'active';
        // Use client-provided cached data if available, but ONLY if no offset is requested.
        // If agent requested offset > 0, bypass cache and paginate natively.
        if (inputOffset === 0 && state === 'active' && context.listings && context.listings.length > 0) {
          const limit = Math.min(input.limit || 200, 200);
          const listings = context.listings.slice(0, limit);
          return { listing_count: listings.length, listings, source: 'cache' };
        }
        const limit = Math.min(input.limit || 200, 200);
        let all = [];
        for (let offset = inputOffset; offset < inputOffset + limit; offset += 100) {
          const batch = Math.min(100, (inputOffset + limit) - offset);
          const data = await etsyFetch(`/shops/${SHOP_ID}/listings?state=${state}&limit=${batch}&offset=${offset}&includes=Images`);
          const results = data.results || [];
          all = all.concat(results.map(mapListingForAgent));
          if (results.length < batch) break;
        }
        return { listing_count: all.length, listings: all };
      }

      case 'search_shop_listings': {
        const limit = Math.min(input.limit || 10, 50);
        // Etsy native search API uses keywords
        const data = await etsyFetch(`/shops/${SHOP_ID}/listings/active?keywords=${encodeURIComponent(input.keywords)}&limit=${limit}&includes=Images`);
        const results = data.results || [];
        return { listing_count: results.length, listings: results.map(mapListingForAgent) };
      }

      case 'get_listing_details': {
        if (listingDetailsCacheIsAuthoritative(context.listing_details?.[input.listing_id])) {
          const cached = context.listing_details[input.listing_id];
          const normalized = listingDetailsForAgent(cached);
          return {
            ...cached,
            ...normalized,
            inventory_summary: cached.inventory_summary || normalized.inventory_summary,
            source: 'cache',
          };
        }
        const d = await getListingWithInventory(
          input.listing_id,
          ['Images', 'Personalization']
        );
        return listingDetailsForAgent(d);
      }

      case 'get_shop_fulfillment_profiles': {
        return fetchShopFulfillmentProfiles();
      }

      case 'search_seller_taxonomy': {
        const data = await etsyFetch('/seller-taxonomy/nodes');
        const candidates = sellerTaxonomyCandidates(data.results || data, input.query, input.limit || 12);
        return { query: input.query, count: candidates.length, candidates };
      }

      case 'analyze_listing_images': {
        return await analyzeListingImages(input, context);
      }

      case 'find_listing': {
        let listings = Array.isArray(context.listings) && context.listings.length ? context.listings : null;
        if (!listings) {
          const fetched = await executeTool('list_shop_listings', { limit: 200, state: 'active' }, context);
          listings = fetched.listings || [];
        }
        const query = input.query || latestUserText(context.messages || []);
        const exactId = String(query || '').match(/\b(\d{9,12})\b/)?.[1] || null;
        if (exactId) {
          const exact = listings.find(l => String(l.listing_id || l.id || '') === exactId);
          const resolved = exact || await executeTool('get_listing_details', { listing_id: Number(exactId) }, { ...context, listing_details: {} });
          if (!resolved?.error) return { status: 'single', listing: mapListingForAgent(resolved), matches: [{ ...mapListingForAgent(resolved), score: 100, coverage: 1 }], source: 'exact_id' };
        }
        const ranked = rankListingsForQuery(query, listings, { limit: Math.max(1, Math.min(10, input.limit || 5)), minScore: 1 });
        let matches = ranked.map(item => ({
          ...mapListingForAgent(item.listing),
          score: Number(item.score.toFixed(2)),
          coverage: Number(item.coverage.toFixed(2)),
        }));
        return {
          status: matches.length ? 'candidates' : 'semantic_search_required',
          message: matches.length
            ? 'Candidate listings only. Use semantic reasoning over the user request and listing facts before choosing one; ask the user if the match is not clear.'
            : 'Lexical search found 0 matches. Review this broader catalogue semantically; ask the user if the intended listing is not clear.',
          matches,
        };
      }

      case 'get_listing_inventory': {
        const inventory = await etsyFetch(`/listings/${input.listing_id}/inventory`);
        context.inventory_by_listing_id[input.listing_id] = inventory;
        return {
          listing_id: input.listing_id,
          inventory,
          summary: summarizeInventory(inventory),
        };
      }

      case 'get_recent_orders': {
        const limit = Math.min(input.limit || 25, 100);
        const data  = await etsyFetch(`/shops/${SHOP_ID}/receipts?limit=${limit}&was_paid=true&includes=transactions`);
        const receipts = data.results || [];
        return {
          order_count: receipts.filter(isCurrentPaidReceipt).length,
          excluded_canceled_or_refunded: receipts.filter(r => !isCurrentPaidReceipt(r)).length,
          orders: receipts.filter(isCurrentPaidReceipt).map(r => ({
            receipt_id: r.receipt_id,
            buyer:      r.name,
            total_usd:  (r.grandtotal || r.grand_total) ? +((r.grandtotal || r.grand_total).amount / (r.grandtotal || r.grand_total).divisor).toFixed(2) : null,
            status:     receiptLifecycle(r).label,
            date:       new Date((r.create_timestamp || 0) * 1000).toLocaleDateString(),
            items:      (r.transactions || []).map(t => t.title).join(', '),
          })),
        };
      }

      case 'get_shop_stats': {
        const days  = input.days || 30;
        const since = Math.floor(Date.now() / 1000) - days * 86400;
        const receipts = [];
        for (let offset = 0; ; offset += 100) {
          const data = await etsyFetch(`/shops/${SHOP_ID}/receipts?limit=100&offset=${offset}&min_created=${since}&was_paid=true`);
          const batch = data.results || [];
          receipts.push(...batch);
          if (batch.length < 100) break;
        }
        const orders = receipts.filter(isCurrentPaidReceipt);
        const revenue = orders.reduce((s, r) => {
          const total = r.grandtotal || r.grand_total;
          return s + (total?.amount || 0) / (total?.divisor || 100);
        }, 0);
        return { period_days: days, orders: orders.length, revenue_usd: revenue.toFixed(2) };
      }

      case 'etsy_api_call': {
        const method = (input.method || 'GET').toUpperCase();
        if (method !== 'GET') return { status: 'error', error: 'etsy_api_call is read-only. Use a dedicated proposal tool for Etsy changes.' };
        const endpoint = input.endpoint.startsWith('/') ? input.endpoint : '/' + input.endpoint;
        // Security: basic path traversal / SSRF protection
        if (endpoint.includes('..') || endpoint.includes('://')) {
          return { status: 'error', error: 'Invalid endpoint path.' };
        }
        let url = endpoint.replace('{shop_id}', SHOP_ID);
        if (input.query && Object.keys(input.query).length > 0) {
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(input.query)) params.append(k, String(v));
          url += (url.includes('?') ? '&' : '?') + params.toString();
        }
        const options = { method };
        // Audit log
        console.warn(`[agent/god-mode] etsy_api_call ${method} ${url}`, input.body ? `body_keys=${Object.keys(input.body).join(',')}` : '');
        try {
          const data = await etsyFetch(url, options);
          // Cap response size to prevent context overflow
          const serialized = JSON.stringify(data);
          if (serialized.length > 102400) {
            // Safe truncation: return summary instead of broken JSON
            return { status: 'success', url, method, data: { _truncated: true, original_size: serialized.length, preview: serialized.slice(0, 2000) + '...' } };
          }
          return { status: 'success', url, method, data };
        } catch (e) {
          return { status: 'error', url, method, error: e.message || String(e) };
        }
      }

      case 'execute_javascript': {
        const code = String(input.code || '');
        // Audit log
        console.warn(`[agent/god-mode] execute_javascript (${code.length} chars)`);
        const isolate = new ivm.Isolate({ memoryLimit: 8 });
        try {
          const ivmContext = await isolate.createContext();
          // Inject read-only context data (serialized copy, no live references)
          const contextCopy = {};
          if (context.listings) contextCopy.listings = context.listings;
          if (context.page_context) contextCopy.page_context = context.page_context;
          if (context.agent_memory) contextCopy.agent_memory = context.agent_memory;
          await ivmContext.global.set('contextData', new ivm.ExternalCopy(contextCopy).copyInto());
          const script = await isolate.compileScript(`
            const context = contextData;
            let result;
            ${code}
            result;
          `);
          const rawResult = await script.run(ivmContext, { timeout: 3000 });
          // Cap result size
          const resultStr = JSON.stringify(rawResult ?? null);
          const result = resultStr && resultStr.length > 51200
            ? { _truncated: true, preview: resultStr.slice(0, 1000) }
            : (rawResult ?? null);
          return { status: 'success', result };
        } catch (e) {
          return { status: 'error', error: e.message || String(e) };
        } finally {
          isolate.dispose();
        }
      }

      case 'get_recent_reviews': {
        const limit = Math.min(input.limit || 10, 25);
        const data  = await etsyFetch(`/shops/${SHOP_ID}/reviews?limit=${limit}`);
        return {
          review_count: (data.results || []).length,
          reviews: (data.results || []).map(r => ({
            listing_id: r.listing_id,
            rating:     r.rating,
            review:     (r.review || '').slice(0, 800),
            reviewer:   r.buyer_user_id ? `Buyer #${r.buyer_user_id}` : 'Anonymous',
            date:       r.create_timestamp ? new Date(r.create_timestamp * 1000).toLocaleDateString() : 'Unknown',
          })),
        };
      }

      case 'audit_listing_compliance': {
        const raw = await getListingWithInventory(input.listing_id, ['Images', 'Personalization']);
        const listing = { ...raw, ...listingDetailsForAgent(raw), inventory: raw.inventory };
        return { listing_id: listing.listing_id, title: listing.title, audit: auditListing(listing) };
      }

      case 'validate_listing_before_publish': {
        let listing;
        let source;
        if (input.listing_id) {
          const raw = await getListingWithInventory(input.listing_id, ['Images', 'Personalization']);
          listing = { ...raw, ...listingDetailsForAgent(raw), inventory: raw.inventory };
          source = 'etsy';
        } else {
          const pc = context.page_context || {};
          const draft = context.active_create_draft || {};
          const useServerDraft = Boolean(draft.title || draft.description || draft.draft_id);
          const current = useServerDraft ? draft : pc;
          listing = {
            title: current.listing_title || current.title,
            description: current.listing_description || current.description,
            tags: current.listing_tags || current.tags || [],
            price: current.price,
            listing_type: current.listing_type || 'download',
            taxonomy_id: current.taxonomy_id,
            shipping_profile_id: current.shipping_profile_id,
            readiness_state_id: current.readiness_state_id,
            images: current.image_count ? Array.from({ length: current.image_count }, () => ({})) : [],
            personalization: { personalization_questions: current.personalization_questions || [] },
            is_personalizable: current.is_personalizable,
          };
          source = useServerDraft ? 'active_create_draft' : 'page_context';
        }
        return { source, audit: auditListing(listing) };
      }

      case 'open_current_create_draft':
        return context.active_create_draft
          ? { status: 'restoring_saved_draft', revision: context.active_create_draft.revision || 0 }
          : { error: 'No saved Create draft exists for the current operator and shop.' };

      case 'find_listings_missing_personalization_migration': {
        const limit = Math.min(input.limit || 100, 200);
        const results = [];
        for (let offset = 0; offset < limit; offset += 100) {
          const batchSize = Math.min(100, limit - offset);
          const data = await etsyFetch(`/shops/${SHOP_ID}/listings/active?limit=${batchSize}&offset=${offset}&includes=Personalization`);
          const batch = data.results || [];
          results.push(...batch);
          if (batch.length < batchSize) break;
        }
        const flagged = results.map(l => {
          const questions = getPersonalizationQuestions(l);
          const personalizedHint = l.is_personalizable || l.personalization_instructions || /personaliz|custom|photo|name|send|upload/i.test(`${l.title || ''} ${l.description || ''}`);
          const issues = [];
          if (personalizedHint && !questions.length) issues.push('personalized listing has no new personalization questions');
          if (questions.some(q => q.legacy)) issues.push('uses legacy personalization fields');
          if (questions.some(q => q.question_type === 'dropdown' && !q.options?.length)) issues.push('dropdown question has no options');
          return issues.length ? { listing_id: l.listing_id, title: l.title, issues, question_count: questions.length } : null;
        }).filter(Boolean);
        return { scanned: results.length, scan_complete: results.length < limit, flagged_count: flagged.length, listings: flagged };
      }

      case 'get_open_orders_with_personalization': {
        const limit = Math.min(input.limit || 25, 100);
        const data = await etsyFetch(`/shops/${SHOP_ID}/receipts?limit=${limit}&was_paid=true&was_shipped=false&includes=transactions`);
        const orders = (data.results || []).filter(isActionableOpenReceipt).map(r => ({
          receipt_id: r.receipt_id,
          buyer: r.name,
          date: r.create_timestamp ? new Date(r.create_timestamp * 1000).toLocaleDateString() : 'Unknown',
          items: (r.transactions || []).map(t => ({
            transaction_id: t.transaction_id,
            listing_id: t.listing_id,
            title: t.title,
            personalization: t.personalization || t.personalization_value || null,
            variations: t.variations || [],
          })),
        }));
        return { order_count: orders.length, orders };
      }

      case 'get_shop_operating_context': {
        return { context: context.shop_operating_context || await loadShopOperatingContext() || null };
      }

      case 'save_shop_operating_context': {
        const existing = await loadShopOperatingContext() || { items: [], updated_at: null };
        const summary = String(input.summary || '').trim().slice(0, 240);
        const category = input.category || 'rule';
        const duplicate = (existing.items || []).find(item =>
          String(item.summary || '').trim().toLowerCase() === summary.toLowerCase()
          && String(item.category || 'rule') === category
        );
        if (duplicate) return { saved: true, duplicate: true, item: duplicate, context: existing };
        const item = {
          id: `ctx_${Date.now()}`,
          category,
          summary,
          details: String(input.details || '').slice(0, 1000),
          created_at: new Date().toISOString(),
          created_by: String(context._owner_id || '').slice(0, 80),
        };
        const next = { ...existing, items: [item, ...(existing.items || [])].slice(0, 50), updated_at: new Date().toISOString() };
        const saved = await saveShopOperatingContext(next);
        return { saved, item, context: next };
      }

      case 'delete_shop_operating_context': {
        const existing = await loadShopOperatingContext() || { items: [], updated_at: null };
        const id = String(input.id || '').trim();
        const nextItems = (existing.items || []).filter(item => String(item.id) !== id);
        const deleted = nextItems.length !== (existing.items || []).length;
        if (!deleted) return { deleted: false, id, context: existing };
        const next = { ...existing, items: nextItems, updated_at: new Date().toISOString() };
        const saved = await saveShopOperatingContext(next);
        return { saved, deleted: true, id, context: next };
      }

      case 'navigate_to_page':
        // Handled specially in the loop
        return { status: 'navigating', page: input.page, params: input.params || {} };

      case 'open_current_draft_image_generator':
        // Handled specially in the loop — client-side draft UI action
        return { status: 'opening_current_draft_image_generator' };

      case 'save_memory':
        return appendUserAgentMemory(context._owner_id, input);
      case 'delete_memory':
        return deleteUserAgentMemory(context._owner_id, input.id);
      case 'fill_ui_fields':
        // Handled specially in the loop — client-side fill
        return { status: 'shown_to_user', awaiting_confirmation: true, count: (input.fields || []).length };

      case 'propose_updates':
        // Handled specially in the loop — just acknowledge
        return { status: 'shown_to_user', awaiting_confirmation: true, count: (input.updates || []).length };

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

async function prepareCurrentListingUpdateContext(rawUpdates, context) {
  context.listing_details = context.listing_details || {};
  const lastDuplicateId = context.last_duplicate_result?.new_listing_id || context.last_duplicate_result?.listing_id;
  for (const update of rawUpdates) {
    const id = update?.listing_id;
    if (!id) continue;
    const enriched = enrichProposedUpdates([update], context)[0] || {};
    const needsFreshDetail = String(lastDuplicateId || '') === String(id)
      || !enriched.image_url
      || !enriched.current_values
      || !Object.keys(enriched.current_values || {}).length
      || (update.personalization_questions !== undefined && enriched.current_values?.personalization_questions === undefined);
    if (!needsFreshDetail) continue;
    try {
      const fetched = await executeTool('get_listing_details', { listing_id: Number(id) }, { ...context, listing_details: {} });
      if (fetched && !fetched.error) context.listing_details[id] = fetched;
    } catch (err) {
      console.warn('[agent] current listing detail fetch failed:', err?.message || err);
    }
  }
}

// ── Shared tool dispatch (used by both Claude and Gemini runners) ──
export async function dispatchTool(name, input, context, state) {
  if (name === 'open_current_create_draft') {
    if (!context.active_create_draft) {
      return { error: 'No saved Create draft exists for the current operator and shop.' };
    }
    state.navigationAction = { page: 'create', params: { restoreDraft: true } };
    return { status: 'restoring_saved_draft', revision: context.active_create_draft.revision || 0 };
  }
  if (name === 'navigate_to_page') {
    if (input.page === 'create') {
      const params = input.params || {};
      const hasPrefill = ['description', 'productType', 'price', 'listingType', 'extra', 'agentDraft', 'generated']
        .some(key => params[key] !== undefined);
      if (hasPrefill) {
        return { error: 'Generic navigation cannot prefill or regenerate Create. Use the listing-generation tool for a new listing.' };
      }
      if (context.active_create_draft) {
        return toolFaultResult({
          code: 'AGENT_ACTIVE_DRAFT_RESTORE_REQUIRED',
          operation: 'navigate_to_page',
          fault_domain: 'workflow',
          retryable: true,
          required_transition: 'open_current_create_draft',
          safe_message: 'A saved listing draft already exists. Restore that exact draft instead of opening an empty Create page.',
        });
      }
    }
    state.navigationAction = { page: input.page, params: input.params || {} };
    return { status: 'navigating', page: input.page };
  }
  if (name === 'open_current_draft_image_generator') {
    const hasDraft = Boolean(context.current_agent_draft || (context.current_page === 'create' && (context.page_context?.listing_title || context.page_context?.listing_description)));
    if (!hasDraft) {
      return { error: 'No current Create-page draft is available. Create or open a draft first.' };
    }
    state.pendingDraftImageAction = {
      action: 'open_image_generator',
      reason: String(input.reason || '').slice(0, 300),
    };
    return { status: 'awaiting_client_action', action: 'open_image_generator' };
  }
  if (name === 'propose_social_post') {
    state.pendingSocialPost = { caption: input.caption, platform: input.platform || 'all', listing_id: input.listing_id || null, listing_title: input.listing_title || null, listing_image_url: input.listing_image_url || null };
    return { status: 'shown_to_user', awaiting_confirmation: true };
  }
  if (name === 'schedule_social_post') {
    state.pendingScheduledPost = { caption: input.caption, platform: input.platform || 'all', listing_id: input.listing_id || null, listing_title: input.listing_title || null, listing_image_url: input.listing_image_url || null, scheduled_at: input.scheduled_at || null };
    return { status: 'shown_to_user', awaiting_confirmation: true };
  }
  if (name === 'propose_updates') {
    const normalizedUpdates = normalizeProposedUpdates(input.updates || [], context.pending_updates || null);
    if (!normalizedUpdates.length) return { error: 'At least one listing update is required.' };
    await prepareCurrentListingUpdateContext(normalizedUpdates, context);
    const enrichedUpdates = enrichProposedUpdates(normalizedUpdates, context);
    const updates = enrichedUpdates.map(removeUnchangedUpdateFields).filter(hasWritableUpdateFields);
    if (!updates.length) {
      return { status: 'no_changes', awaiting_confirmation: false, message: 'The listing already has the proposed values.' };
    }
    const validationErrors = validateProposedUpdates(updates);
    if (validationErrors.length) {
      return { error: validationErrors.join(' ') };
    }
    const unsafe = updates
      .map(update => auditGenericListingUpdateSafety(update, { allowPersonalizationQuestions: true }))
      .filter(item => !item.ok);
    if (unsafe.length) {
      return { error: unsafe.map(item => item.message).join(' ') };
    }
    const priceUpdates = updates.filter(update => update.price !== undefined);
    if (priceUpdates.length) {
      context.inventory_by_listing_id = context.inventory_by_listing_id || {};
      const inventoryPlans = [];
      const passthroughUpdates = [];
      for (const update of updates) {
        if (update.price === undefined) { passthroughUpdates.push(update); continue; }
        const id = update.listing_id;
        let inventory = context.inventory_by_listing_id[id] || context.inventory_by_listing_id[String(id)] || null;
        if (!inventory) {
          try {
            inventory = await etsyFetch(`/listings/${id}/inventory`);
            context.inventory_by_listing_id[id] = inventory;
          } catch (e) { console.warn('[agent] inventory fetch fallback failed:', e.message); }
        }
        if (hasVariationInventorySnapshot(inventory)) {
          inventoryPlans.push(...buildInventoryPriceUpdatePlan([update], context.inventory_by_listing_id, { mode: 'set', value: update.price }));
          const { price, ...nonPriceUpdate } = update;
          if (hasWritableUpdateFields(nonPriceUpdate)) passthroughUpdates.push(nonPriceUpdate);
        } else {
          passthroughUpdates.push(update);
        }
      }
      if (inventoryPlans.length) {
        state.pendingPriceMultiplierInventory = {
          summary: input.summary || 'Update inventory prices while preserving variations',
          mode: 'set',
          value: inventoryPlans.length === 1 ? inventoryPlans[0].value : null,
          multiplier: null,
          listings: inventoryPlans,
        };
        state.debugTrace.push({
          type: 'price_update_reroute',
          reason: 'variation_inventory_requires_inventory_update',
          listing_ids: inventoryPlans.map(item => item.listing_id),
          mode: 'set',
        });
        if (passthroughUpdates.some(hasWritableUpdateFields)) state.pendingUpdates = { summary: input.summary, updates: passthroughUpdates, ...(input.ui_copy ? { ui_copy: input.ui_copy } : {}) };
        return { status: 'shown_to_user', awaiting_confirmation: true, count: inventoryPlans.length, rerouted: 'inventory_price_update' };
      }
    }
    state.pendingUpdates = { summary: input.summary, updates, ...(input.ui_copy ? { ui_copy: input.ui_copy } : {}) };
    return { status: 'shown_to_user', awaiting_confirmation: true, count: updates.length };
  }
  if (name === 'propose_listing_image_set') {
    const listingId = input.listing_id === undefined || input.listing_id === null ? '' : String(input.listing_id).trim();
    if (!listingId || listingId === '0') {
      return { error: 'listing_id is required for listing image proposals. Use "draft" only when intentionally targeting the current draft.' };
    }
    const normalizedInput = { ...input, listing_id: typeof input.listing_id === 'string' ? listingId : input.listing_id };
    const rawCount = Number(normalizedInput.count);
    if (!Number.isInteger(rawCount) || rawCount < 0 || rawCount > 10 || (normalizedInput.mode !== 'delete_selected' && rawCount < 1)) {
      return { error: 'count must be an integer from 1 to 10, or 0 only for delete_selected.' };
    }
    const normalizedPlan = normalizeListingImageProposal(normalizedInput);
    if (!normalizedInput.ui_copy || typeof normalizedInput.ui_copy !== 'object') {
      return { error: 'ui_copy is required for owner-facing listing image proposal cards. Match the user conversation language.' };
    }
    const missingUiCopy = IMAGE_PLAN_UI_COPY_REQUIRED.filter(key => !String(normalizedInput.ui_copy[key] || '').trim());
    if (missingUiCopy.length) {
      return { error: `ui_copy must include localized owner-facing text for: ${missingUiCopy.join(', ')}.` };
    }
    if (!normalizedPlan.listing_id) return { error: 'listing_id is required for listing image proposals.' };
    if (normalizedPlan.mode !== 'delete_selected' && !normalizedPlan.prompt) return { error: 'prompt is required for image generation.' };
    if ((normalizedPlan.mode === 'delete_selected' || normalizedPlan.mode === 'replace_selected') && !normalizedPlan.selected_images.length && !normalizedPlan.selected_image_ranks.length && !normalizedPlan.selected_image_ids.length) {
      return { error: 'selected_images, selected_image_ids, or selected_image_ranks are required for selective image changes.' };
    }
    if (normalizedPlan.mode !== 'delete_selected') {
      const rawSlots = Array.isArray(normalizedInput.slots) ? normalizedInput.slots : [];
      if (rawSlots.length !== normalizedPlan.count) {
        return { error: `slots must include exactly ${normalizedPlan.count} model-authored image plans. Do not rely on local fallback slot templates.` };
      }
      const incompleteSlotIndex = rawSlots.slice(0, normalizedPlan.count).findIndex(slot => !slot?.purpose || !slot?.visual_prompt || !slot?.alt_text);
      if (incompleteSlotIndex >= 0) {
        return { error: `slots[${incompleteSlotIndex}] must include purpose, visual_prompt, and alt_text authored by the model.` };
      }
    }
    let plan = normalizedPlan;
    let draftWorkflow = null;
    if (String(plan.listing_id) === 'draft') {
      const activeWorkflowId = String(
        context.agent_listing_workflow?.workflow_id
        || context.pending_listing_images?.workflow_id
        || context.current_agent_draft?.workflow_id
        || ''
      ).trim();
      const requestedWorkflowId = String(input.workflow_id || '').trim();
      const workflowAction = input.workflow_action === 'start' ? 'start' : (input.workflow_action === 'continue' ? 'continue' : (activeWorkflowId ? 'continue' : 'start'));
      if (workflowAction === 'continue' && !activeWorkflowId) {
        return toolFaultResult({
          code: 'AGENT_LISTING_WORKFLOW_REQUIRED',
          operation: 'propose_listing_image_set',
          fault_domain: 'workflow',
          retryable: true,
          required_transition: 'start_listing_workflow',
          safe_message: 'There is no active listing workflow to continue. Start a new draft workflow for this product.',
        });
      }
      if (workflowAction === 'continue' && requestedWorkflowId && requestedWorkflowId !== activeWorkflowId) {
        return toolFaultResult({
          code: 'AGENT_STALE_LISTING_WORKFLOW',
          operation: 'propose_listing_image_set',
          fault_domain: 'workflow',
          retryable: false,
          workflow_id: activeWorkflowId,
          required_transition: 'use_active_listing_workflow',
          safe_message: 'The requested image plan belongs to a stale listing workflow.',
        });
      }
      draftWorkflow = {
        workflow_id: workflowAction === 'continue'
          ? activeWorkflowId
          : `listing_flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
        workflow_state: 'image_plan_ready',
      };
      plan = { ...plan, ...draftWorkflow };
    }
    if (plan.mode !== 'delete_selected' && !plan.visual_analysis && plan.current_images?.length) {
      plan = await enrichListingImagePlanWithVision(plan, {
        listing_id: plan.listing_id,
        title: plan.listing_title,
        listing_title: plan.listing_title,
        images: plan.current_images,
      }, context.messages || [], context);
    }
    if (plan.mode !== 'delete_selected' && !plan.reference_image) {
      plan = normalizeListingImageProposal({ ...plan, reference_image: referenceImageForListingPlan(plan, 0) });
    }
    if (draftWorkflow) plan = { ...plan, ...draftWorkflow };
    state.pendingListingImages = plan;
    return { status: 'shown_to_user', awaiting_confirmation: true, count: plan.count, mode: plan.mode, selected_count: plan.selected_images.length || plan.selected_image_ranks.length || plan.selected_image_ids.length };
  }
  if (name === 'act_on_listing_image_plan') {
    const plan = context.pending_listing_images || null;
    if (!plan?.listing_id) {
      return { error: 'No active listing image plan is available. Create or show an image plan first.' };
    }
    const action = input.action;
    if (action !== 'generate_previews' && action !== 'apply_to_listing') {
      return { error: 'Unsupported listing image action.' };
    }
    const activeListingId = String(plan.listing_id);
    if (input.listing_id === undefined || input.listing_id === null || String(input.listing_id).trim() === '') {
      return { error: 'listing_id is required and must match the active image plan target.' };
    }
    if (String(input.listing_id) !== activeListingId) {
      return { error: `The active image plan is for listing ${activeListingId}, not ${input.listing_id}.` };
    }
    const generatedCount = Array.isArray(plan.generated_images) ? plan.generated_images.length : 0;
    const count = Number.isFinite(Number(plan.count)) ? Number(plan.count) : 0;
    if (action === 'generate_previews' && plan.mode === 'delete_selected') {
      return toolFaultResult({ code: 'AGENT_IMAGE_GENERATION_NOT_APPLICABLE', operation: action, fault_domain: 'workflow', retryable: false, workflow_id: plan.workflow_id, safe_message: 'This image plan deletes selected images and has no previews to generate.' });
    }
    const transition = validateListingImageTransition({ action, plan, draft: context.current_agent_draft || null });
    if (!transition.ok) return { status: 'error', error: transition.fault.safe_message, fault: transition.fault, workflow: transition.workflow };
    if (action === 'generate_previews' && count > 0 && generatedCount >= count) {
      return toolFaultResult({ code: 'AGENT_IMAGE_PREVIEWS_ALREADY_READY', operation: action, fault_domain: 'workflow', retryable: false, workflow_id: plan.workflow_id, state: transition.workflow.state, safe_message: 'The active image plan already has generated previews. Apply them or revise the plan.' });
    }
    state.pendingListingImageAction = {
      action,
      listing_id: activeListingId,
      reason: String(input.reason || '').slice(0, 300),
    };
    return { status: 'awaiting_client_action', action, listing_id: activeListingId };
  }
  if (name === 'propose_clear_variations') {
    const listings = input.listings || [];
    const plan = buildClearVariationsPlan(listings, context.inventory_by_listing_id || {});
    const unsafe = plan.filter(item => item.fault);
    if (unsafe.length) {
      return toolFaultResult({
        code: unsafe[0].fault.code,
        operation: 'propose_clear_variations',
        fault_domain: 'workflow',
        retryable: true,
        required_transition: 'ask_owner_for_final_inventory_values',
        safe_message: `${unsafe[0].fault.message} Ask the owner for the final single price or processing choice before preparing approval.`,
      });
    }
    const withVariations = plan.filter(item => item.summary.product_count > 0 && item.summary.properties.length > 0);
    if (!withVariations.length) return { error: 'No variation inventory was found for the selected listings. Call get_listing_inventory first or choose listings with variations.' };
    state.pendingClearVariations = { summary: input.summary || 'Remove listing variations', listings: withVariations };
    return { status: 'shown_to_user', awaiting_confirmation: true, count: withVariations.length };
  }
  if (name === 'propose_remove_variation_property') {
    const listings = input.listings || [];
    const plan = buildRemoveVariationPropertyPlan(listings, context.inventory_by_listing_id || {}, input.property_name);
    const unsafe = plan.filter(item => item.fault);
    if (unsafe.length) {
      return toolFaultResult({
        code: unsafe[0].fault.code,
        operation: 'propose_remove_variation_property',
        fault_domain: 'workflow',
        retryable: true,
        required_transition: 'ask_owner_for_resulting_variation_values',
        safe_message: `${unsafe[0].fault.message} Ask the owner how the conflicting values should be resolved before preparing approval.`,
      });
    }
    const withProperty = plan.filter(item => item.removed_property && item.update_to?.products?.length);
    if (!withProperty.length) return { error: `Variation property not found in selected listings: ${input.property_name}` };
    state.pendingRemoveVariationProperty = { summary: input.summary || `Remove ${input.property_name} variation`, property_name: input.property_name, listings: withProperty };
    return { status: 'shown_to_user', awaiting_confirmation: true, count: withProperty.length };
  }
  if (name === 'propose_inventory_price_update') {
    const mode = input.mode === 'set' ? 'set' : 'multiply';
    const value = Number(input.value ?? input.multiplier);
    if (!Number.isFinite(value) || value <= 0) return { error: 'A positive inventory price value is required.' };
    const listings = input.listings || [];
    context.inventory_by_listing_id = context.inventory_by_listing_id || {};
    for (const listing of listings) {
      if (!listing?.listing_id) continue;
      if (!context.inventory_by_listing_id[listing.listing_id] && !context.inventory_by_listing_id[String(listing.listing_id)]) {
        try {
          context.inventory_by_listing_id[listing.listing_id] = await etsyFetch(`/listings/${listing.listing_id}/inventory`);
        } catch (e) { console.warn('[agent] inventory fetch failed:', e.message); }
      }
    }
    const plan = buildInventoryPriceUpdatePlan(listings, context.inventory_by_listing_id || {}, { mode, value });
    const valid = plan.filter(item => item.update_to?.products?.length);
    if (!valid.length) return { error: 'No inventory prices were found for the selected listings. Call get_listing_inventory first or choose a listing with a valid price.' };
    state.pendingPriceMultiplierInventory = {
      summary: input.summary || (mode === 'set' ? `Set inventory prices to ${value}` : `Multiply inventory prices by ${value}`),
      mode,
      value,
      multiplier: mode === 'multiply' ? value : null,
      listings: valid,
    };
    state.debugTrace.push({
      type: 'inventory_price_proposal',
      mode,
      value,
      listing_ids: valid.map(item => item.listing_id),
      price_ranges: valid.map(item => ({ listing_id: item.listing_id, from: item.summary, to: item.new_summary })),
    });
    return { status: 'shown_to_user', awaiting_confirmation: true, count: valid.length };
  }
  if (name === 'save_memory') {
    const result = await executeTool(name, input, context);
    if (result?.error) return result;
    state.pendingMemorySave = { ...result.memory, persisted: true };
    context.agent_memory = result.items;
    return { status: result.duplicate ? 'already_saved' : 'saved', memory: result.memory };
  }
  if (name === 'delete_memory') {
    const result = await executeTool(name, input, context);
    if (result?.error) return result;
    state.pendingMemoryDelete = { id: input.id, persisted: true, deleted: result.deleted };
    context.agent_memory = result.items;
    return { status: result.deleted ? 'deleted' : 'not_found', id: input.id };
  }
  if (name === 'get_shop_operating_context' || name === 'save_shop_operating_context' || name === 'delete_shop_operating_context') {
    const result = await executeTool(name, input, context);
    if (result?.context) context.shop_operating_context = result.context;
    return result;
  }
  if (name === 'find_listing') {
    const result = await executeTool(name, input, context);
    state.debugTrace.push({
      type: 'listing_resolution',
      query: input.query || latestUserText(context.messages || []),
      status: result.status || 'unknown',
      selected_listing_id: result.listing?.listing_id || null,
      selected_title: result.listing?.title || result.listing?.listing_title || null,
      matches: (result.matches || []).slice(0, 3).map(match => ({ listing_id: match.listing_id, title: match.title, score: match.score, coverage: match.coverage })),
    });
    return result;
  }
  if (name === 'fill_ui_fields') {
    state.pendingFieldFills = { summary: input.summary || 'Fill fields', fields: input.fields || [] };
    return { status: 'shown_to_user', awaiting_confirmation: true, count: (input.fields || []).length };
  }
  if (name === 'get_scheduled_posts') {
    const posts = context.scheduled_posts || [];
    return { count: posts.length, posts };
  }
  if (name === 'batch_schedule_posts') {
    const rawPosts = input.posts;
    console.log('[agent] batch_schedule_posts: input keys=', Object.keys(input||{}), 'posts type=', typeof rawPosts, 'isArray=', Array.isArray(rawPosts), 'len=', Array.isArray(rawPosts) ? rawPosts.length : rawPosts, 'raw=', JSON.stringify(input).slice(0, 300));
    state.pendingBatchSchedule = { posts: Array.isArray(rawPosts) ? rawPosts : [] };
    console.log('[agent] batch_schedule_posts: state set, posts=', state.pendingBatchSchedule.posts.length);
    return { status: 'shown_to_user', awaiting_confirmation: true, count: state.pendingBatchSchedule.posts.length };
  }
  if (name === 'delete_scheduled_post') {
    state.pendingDeletePost = { id: input.id, caption_preview: input.caption_preview || '' };
    return { status: 'shown_to_user', awaiting_confirmation: true };
  }
  if (name === 'propose_duplicate_listing') {
    const dup = normalizeDuplicateProposal(input);
    state.pendingDuplicate = {
      source_listing_id: dup.source_listing_id,
      source_title: dup.source_title,
      source_image_url: dup.source_image_url || dup.listing_image_url || dup.image_url || null,
      source_state: dup.source_state || dup.state || dup.listing_state || null,
      title: dup.title,
      description: dup.description,
      tags: dup.tags,
      price: dup.price,
      personalization_questions: dup.personalization_questions,
      changes_summary: dup.changes_summary || 'Duplicate listing',
    };
    return { status: 'shown_to_user', awaiting_confirmation: true };
  }
  if (name === 'generate_listing_content') {
    // Delegate generation to the tracked listing job used by the frontend.
    const targetType = input.target_type;
    if (targetType !== 'create_draft' && targetType !== 'etsy_listing') {
      return { error: 'target_type is required: use create_draft or etsy_listing.' };
    }
    const pc = context.page_context || {};
    let existingTarget = null;
    if (targetType === 'etsy_listing') {
      const listingId = Number(input.listing_id);
      if (!Number.isInteger(listingId) || listingId < 1) {
        return { error: 'listing_id is required when target_type=etsy_listing.' };
      }
      const cached = context.listing_details?.[listingId] || context.listing_details?.[String(listingId)] || null;
      existingTarget = listingDetailsCacheIsAuthoritative(cached)
        ? { ...cached, ...listingDetailsForAgent(cached) }
        : listingDetailsForAgent(await getListingWithInventory(listingId, ['Images', 'Personalization']));
    }
    const shopListings = (context.listings || []).slice(0, 6);
    const shopContext = shopListings.length
      ? `Shop sells: ${shopListings.map(l => l.title).join(' | ')}` : '';
    const existingContent = [
      pc.listing_title     ? `Current title: ${pc.listing_title}` : '',
      pc.listing_tags?.length ? `Current tags: ${pc.listing_tags.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const extraContext = [input.extra || '', existingContent].filter(Boolean).join('\n');

    const activeWorkflowId = String(
      context.agent_listing_workflow?.workflow_id
      || context.pending_listing_images?.workflow_id
      || context.current_agent_draft?.workflow_id
      || ''
    ).trim();
    const requestedWorkflowId = String(input.workflow_id || '').trim();
    const workflowAction = targetType === 'etsy_listing'
      ? 'start'
      : (input.workflow_action === 'start' ? 'start' : (input.workflow_action === 'continue' ? 'continue' : (context.pending_listing_images?.workflow_id ? 'continue' : 'start')));
    if (workflowAction === 'continue' && !activeWorkflowId) {
      return toolFaultResult({
        code: 'AGENT_LISTING_WORKFLOW_REQUIRED',
        operation: 'generate_listing_content',
        fault_domain: 'workflow',
        retryable: true,
        required_transition: 'start_listing_workflow',
        safe_message: 'There is no active listing workflow to continue. Start a new listing draft workflow.',
      });
    }
    if (workflowAction === 'continue' && requestedWorkflowId && requestedWorkflowId !== activeWorkflowId) {
      return toolFaultResult({
        code: 'AGENT_STALE_LISTING_WORKFLOW',
        operation: 'generate_listing_content',
        fault_domain: 'workflow',
        retryable: false,
        workflow_id: activeWorkflowId,
        required_transition: 'use_active_listing_workflow',
        safe_message: 'The listing content request targets a stale listing workflow.',
      });
    }
    const workflowId = targetType === 'etsy_listing'
      ? `listing_update_${existingTarget.listing_id}_${Date.now().toString(36)}`
      : workflowAction === 'continue'
      ? activeWorkflowId
      : `listing_flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

    state.pendingGenerateListing = {
      target_type: targetType,
      ...(existingTarget ? {
        listing_id: Number(existingTarget.listing_id),
        listing_title: existingTarget.title || input.listing_title || `Listing ${input.listing_id}`,
        current_values: {
          title: existingTarget.title || '',
          description: existingTarget.description || '',
          tags: existingTarget.tags || [],
          price: existingTarget.price,
        },
      } : {}),
      description: existingTarget?.description || input.description,
      listing_type: existingTarget?.listing_type || input.listing_type || pc.listing_type || 'download',
      price: existingTarget?.price || input.price || pc.price || '',
      extra:         extraContext,
      product_type:  (existingTarget?.title || input.description || '').slice(0, 80),
      shop_context:  shopContext,
      attached_image_role: input.attached_image_role || null,
      workflow_id: workflowId,
      workflow_state: 'listing_content_generating',
      after_generation: targetType === 'create_draft' && input.after_generation === 'attach_active_image_plan' ? 'attach_active_image_plan' : 'none',
    };
    // Tell the model the generation is handled — it should NOT also call fill_ui_fields
    return { status: 'generating', message: 'Frontend will generate and fill the fields automatically.' };
  }
  if (name === 'set_variations') {
    const targetType = input.target_type === 'etsy_listing' ? 'etsy_listing' : 'create_draft';
    const activeDraft = context.active_create_draft || {};
    let target = activeDraft;

    if (targetType === 'etsy_listing') {
      const listingId = Number(input.listing_id);
      if (!Number.isInteger(listingId) || listingId < 1) {
        return { error: 'listing_id is required when target_type=etsy_listing.' };
      }
      const cached = context.listing_details?.[listingId] || context.listing_details?.[String(listingId)] || null;
      const hasFulfillmentContract = cached
        && Object.prototype.hasOwnProperty.call(cached, 'shipping_profile_id')
        && Object.prototype.hasOwnProperty.call(cached, 'readiness_state_id');
      if (hasFulfillmentContract) {
        const normalized = listingDetailsForAgent(cached);
        target = { ...cached, ...normalized, inventory_summary: cached.inventory_summary || normalized.inventory_summary };
      } else {
        target = listingDetailsForAgent(await getListingWithInventory(listingId, ['Images', 'Personalization']));
      }
    }

    const targetHasVariations = Array.isArray(input.properties) && input.properties.length > 0;
    if (targetHasVariations) {
      const invalidProperties = input.properties.filter(property => {
        const mode = property.pricing_mode;
        if (!['final_price', 'surcharge'].includes(mode) || !Array.isArray(property.options) || !property.options.length) return true;
        return property.options.some(option => {
          const amount = Number(option.amount);
          return !Number.isFinite(amount) || (mode === 'final_price' ? amount < 0.20 : amount < 0);
        });
      });
      const finalPriceProperties = input.properties.filter(property => property.pricing_mode === 'final_price');
      if (invalidProperties.length || finalPriceProperties.length !== 1) {
        return {
          error: 'Variation pricing is ambiguous. Provide exactly one final_price property and optional surcharge property; every option must use one numeric amount.',
        };
      }
    }
    if (Array.isArray(input.personalization_questions) && input.personalization_questions.length === 0) {
      return { error: 'Omit personalization_questions to keep personalization unchanged; provide at least one question only when the owner requested a replacement.' };
    }
    const resolvedListingType = input.listing_type || target.listing_type || (targetHasVariations ? 'physical' : null);
    const resolvedBasePrice = Number(input.base_price ?? target.price ?? 0);
    const currentShippingProfileId = Number(target.shipping_profile_id || 0);
    const currentReadinessStateId = Number(target.readiness_state_id || target.inventory_readiness_state_ids?.[0] || 0);
    const resolvedShippingProfileId = targetType === 'etsy_listing'
      ? Number(currentShippingProfileId || input.shipping_profile_id || 0)
      : Number(input.shipping_profile_id || currentShippingProfileId || 0);
    const resolvedReadinessStateId = targetType === 'etsy_listing'
      ? Number(currentReadinessStateId || input.readiness_state_id || 0)
      : Number(input.readiness_state_id || currentReadinessStateId || 0);
    const resolvedTaxonomyId = Number(target.taxonomy_id || input.taxonomy_id || 0);
    const resolvedTaxonomyCategory = input.taxonomy_category || target.taxonomy_category || null;
    const personalizationQuestions = input.personalization_questions === undefined
      ? undefined
      : normalizeProposedPersonalizationQuestions(input.personalization_questions);
    if (personalizationQuestions !== undefined) {
      const validationErrors = validateProposedUpdates([{ personalization_questions: personalizationQuestions }]);
      if (validationErrors.length) return { error: validationErrors.join(' ') };
    }

    if (targetHasVariations && resolvedListingType !== 'physical') {
      return { error: 'Listings with variations must use listing_type=physical.' };
    }
    if (resolvedListingType === 'physical') {
      const missing = [];
      if (resolvedBasePrice < 0.20) missing.push('base_price');
      if (targetType === 'etsy_listing' && !resolvedTaxonomyId) missing.push('taxonomy_id');
      if (targetType === 'create_draft' && !resolvedTaxonomyId && !resolvedTaxonomyCategory) missing.push('taxonomy_category');
      if (resolvedShippingProfileId < 1) missing.push('shipping_profile_id');
      if (resolvedReadinessStateId < 1) missing.push('readiness_state_id');
      if (missing.length) {
        return toolFaultResult({
          code: targetType === 'etsy_listing'
            ? 'AGENT_EXISTING_LISTING_FULFILLMENT_REQUIRED'
            : 'AGENT_PHYSICAL_DRAFT_FIELDS_REQUIRED',
          operation: 'set_variations',
          fault_domain: 'workflow',
          retryable: true,
          required_transition: targetType === 'etsy_listing'
            ? 'get_shop_fulfillment_profiles'
            : 'set_variations',
          safe_message: targetType === 'etsy_listing'
            ? `The existing Etsy listing truly lacks: ${missing.join(', ')}. Read the shop fulfillment profiles, select valid IDs, and retry this proposal in the same turn.`
            : `A publish-ready physical draft still needs: ${missing.join(', ')}. Use the active draft context and retry this tool.`,
        });
      }
    }
    state.pendingVariations = {
      target_type: targetType,
      ...(targetType === 'etsy_listing' ? {
        listing_id: Number(input.listing_id),
        listing_title: input.listing_title || target.title || `Listing ${input.listing_id}`,
        listing_state: target.state || target.listing_state || null,
        current_listing_type: target.listing_type || null,
        current_inventory_summary: target.inventory_summary || null,
        fulfillment_profile_source: currentShippingProfileId > 0 && currentReadinessStateId > 0
          ? 'current_listing'
          : 'selected_shop_profile',
      } : {
        expected_revision: Number(activeDraft.revision) || 0,
      }),
      listing_type: resolvedListingType,
      base_price: resolvedBasePrice >= 0.20 ? resolvedBasePrice : null,
      taxonomy_id: resolvedTaxonomyId || null,
      taxonomy_category: resolvedTaxonomyCategory,
      shipping_profile_id: resolvedShippingProfileId || null,
      readiness_state_id: resolvedReadinessStateId || null,
      properties: input.properties || [],
      ...(personalizationQuestions !== undefined ? { personalization_questions: personalizationQuestions } : {}),
    };
    return {
      status: 'shown_to_user',
      awaiting_confirmation: true,
      target_type: targetType,
      ...(targetType === 'etsy_listing' ? { listing_id: Number(input.listing_id) } : {}),
    };
  }
  return executeTool(name, input, context);
}

export async function dispatchToolForTest(name, input, context = {}, state = makeState()) {
  const result = await dispatchTool(name, input, context, state);
  return { result, state };
}

export function makeState() { return { pendingUpdates: null, pendingPriceMultiplierInventory: null, pendingSocialPost: null, pendingDuplicate: null, pendingScheduledPost: null, navigationAction: null, pendingFieldFills: null, pendingMemorySave: null, pendingMemoryDelete: null, pendingBatchSchedule: null, pendingDeletePost: null, pendingVariations: null, pendingGenerateListing: null, pendingClearVariations: null, pendingRemoveVariationProperty: null, pendingListingImages: null, pendingListingImageAction: null, pendingDraftImageAction: null, debugTrace: [] }; }
export function makeResp(text, s) { return { message: String(text || '').trim(), pending_updates: s.pendingUpdates, pending_price_multiplier_inventory: s.pendingPriceMultiplierInventory, pending_social_post: s.pendingSocialPost, pending_duplicate: s.pendingDuplicate, pending_scheduled_post: s.pendingScheduledPost, navigation_action: s.navigationAction, pending_field_fills: s.pendingFieldFills, pending_memory_save: s.pendingMemorySave, pending_memory_delete: s.pendingMemoryDelete, pending_batch_schedule: s.pendingBatchSchedule, pending_delete_post: s.pendingDeletePost, pending_variations: s.pendingVariations, pending_generate_listing: s.pendingGenerateListing, pending_clear_variations: s.pendingClearVariations, pending_remove_variation_property: s.pendingRemoveVariationProperty, pending_listing_images: s.pendingListingImages, pending_listing_image_action: s.pendingListingImageAction, pending_draft_image_action: s.pendingDraftImageAction, debug_trace: s.debugTrace?.length ? s.debugTrace : null }; }

export function limitAgentMessagesForModel(messages = []) {
  const clean = Array.isArray(messages) ? messages.filter(m => m?.role && m.content !== undefined) : [];
  if (clean.length <= 40) return clean;
  const firstUser = clean.find(m => m.role === 'user');
  const tail = clean.slice(-36);
  if (!firstUser || tail.includes(firstUser)) return tail;
  return [firstUser, ...tail];
}

// sanitizeFinalResult SIMPLIFIED per Manifesto Principle #2.
// The response is returned exactly as authored by the model.
export function sanitizeFinalResult(result) {
  return result;
}

// isVagueDuplicateContextQuestion NEUTRALIZED per Manifesto Principle #2.
export function isVagueDuplicateContextQuestion() {
  return false;
}

// contextualizeMissingCardFallback NEUTRALIZED per Manifesto Principle #2.
// The model should be context-aware via the system prompt and conversation history.
export function contextualizeMissingCardFallback(result, _messages, _context) {
  return result;
}

export function hasAnyResultAction(result = {}) {
  return !!(
    result.pending_updates?.updates?.length ||
    result.pending_price_multiplier_inventory?.listings?.length ||
    result.pending_duplicate?.source_listing_id ||
    result.pending_social_post?.caption ||
    result.pending_scheduled_post?.caption ||
    result.pending_field_fills?.fields?.length ||
    result.pending_batch_schedule?.posts?.length ||
    result.pending_delete_post?.id ||
    result.pending_variations?.properties?.length ||
    result.pending_generate_listing?.description ||
    result.pending_clear_variations?.listings?.length ||
    result.pending_remove_variation_property?.listings?.length ||
    result.pending_listing_images?.listing_id ||
    result.pending_listing_image_action?.action
    || result.pending_draft_image_action?.action
  );
}

// repairCancelledDuplicateContent NEUTRALIZED per Manifesto Principle #2.
// The model should generate English content via its own reasoning.
export function repairCancelledDuplicateContent(dup = {}) {
  return normalizeDuplicateProposal({ ...dup });
}

export function latestCancelledDuplicateFromMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.role !== 'assistant') continue;
    if (msg.cancelled_duplicate?.source_listing_id) return normalizeDuplicateProposal(msg.cancelled_duplicate);
    if (/Duplication cancelled\.|Дублювання скасовано|дублікат.*скас/i.test(String(msg.content || ''))) {
      for (let j = i - 1; j >= 0; j--) {
        const previous = list[j];
        if (previous?.role === 'assistant' && previous.pending_duplicate?.source_listing_id) {
          return normalizeDuplicateProposal(previous.pending_duplicate);
        }
      }
    }
  }
  return null;
}

// recoverCancelledDuplicateRewrite NEUTRALIZED per Manifesto Principle #2.
// The model should recognize cancelled duplicate context and call propose_duplicate_listing itself.
export function recoverCancelledDuplicateRewrite(result, _messages, _context) {
  return result;
}

// contextualizeCancelledDuplicateMemory NEUTRALIZED per Manifesto Principle #2.
// The model has full context awareness via system prompt and conversation history.
export function contextualizeCancelledDuplicateMemory(result, _messages, _context) {
  return result;
}

// suppressSourceImagePlanDuringDuplicate NEUTRALIZED per Manifesto Principle #2.
// The system prompt instructs the model not to propose images for source during duplication.
export function suppressSourceImagePlanDuringDuplicate(result) {
  return result;
}

// mergeDuplicateScopedUpdates NEUTRALIZED per Manifesto Principle #2.
// The system prompt instructs the model to include all fields in propose_duplicate_listing.
export function mergeDuplicateScopedUpdates(result) {
  return result;
}
