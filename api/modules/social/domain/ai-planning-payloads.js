export function createSocialAiPlanningPayloadBuilder({
  normalizeText,
  normalizeStringList,
} = {}) {
  if (typeof normalizeText !== 'function') throw new TypeError('normalizeText is required');
  if (typeof normalizeStringList !== 'function') throw new TypeError('normalizeStringList is required');

  const text = (value, max = 1000) => normalizeText(value, max);
  const stringList = (value, maxItems = 8, maxChars = 120) => normalizeStringList(value, maxItems, maxChars);

  function compactCampaignContext(context = {}) {
    const sourceOpportunity = context.source_opportunity && typeof context.source_opportunity === 'object'
      ? context.source_opportunity
      : {};
    return {
      current_date: text(context.current_date || context.currentDate, 40),
      current_year: Number(context.current_year || context.currentYear) || null,
      current_iso: text(context.current_iso || context.currentIso || context.now, 80),
      occasion: text(context.occasion || context.moment || context.campaign_moment || sourceOpportunity.moment || sourceOpportunity.label, 220),
      reason: text(context.reason || sourceOpportunity.reason, 500),
      campaign_context: text(context.campaign_context || context.marketing_context, 700),
      local_signal: {
        type: text(sourceOpportunity.type, 80),
        source: text(sourceOpportunity.source, 120),
        label: text(sourceOpportunity.label, 220),
        moment: text(sourceOpportunity.moment, 220),
      },
    };
  }

  function compactListingForUnderstanding(listing = {}, visualAnalysis = null) {
    const mediaItems = Array.isArray(listing.media_items)
      ? listing.media_items
      : (Array.isArray(listing.images) ? listing.images : []).concat((listing.image_urls || []).map(url => ({ url })));
    return {
      listing_id: text(listing.listing_id || listing.id, 80),
      title: text(listing.title || listing.listing_title, 240),
      description: text(listing.description || listing.description_plain || listing.body, 2200),
      tags: stringList(listing.tags, 13, 40),
      taxonomy: text(listing.taxonomy_path || listing.category || listing.taxonomy || listing.section, 240),
      listing_type: text(listing.listing_type || listing.type, 80),
      materials: stringList(listing.materials, 16, 60),
      price: text(listing.price || listing.amount, 40),
      url: text(listing.url || listing.listing_url, 1000),
      current_availability: listing.current_availability && typeof listing.current_availability === 'object'
        ? listing.current_availability
        : null,
      media: mediaItems.slice(0, 10).map((item, index) => ({
        rank: item.rank || index + 1,
        alt: text(item.alt || item.alt_text || item.title || item.caption || item.description, 220),
        width: item.width || item.full_width || null,
        height: item.height || item.full_height || null,
        source: text(item.source || item.role || item.kind, 80),
        url: text(item.url || item.url_fullxfull || item.url_570xN, 1000),
      })),
      visual_analysis: visualAnalysis && typeof visualAnalysis === 'object'
        ? {
          provider: text(visualAnalysis.provider, 120),
          images: (Array.isArray(visualAnalysis.images) ? visualAnalysis.images : []).slice(0, 10).map(item => ({
            rank: Number(item.rank) || null,
            url: text(item.url, 160),
            social_use_decision: text(item.social_use_decision, 40),
            visible_summary: text(item.visible_summary, 500),
            rationale: text(item.rationale, 260),
            concerns: stringList(item.concerns, 8, 180),
            quality_score: item.quality_score ?? null,
            concept_relevance_score: item.concept_relevance_score ?? null,
          })),
        }
        : null,
    };
  }

  return Object.freeze({
    compactCampaignContext,
    compactListingForUnderstanding,
  });
}
