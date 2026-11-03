export const AUDIT_SYSTEM = `You are an Etsy SEO expert. Analyse the given listing and return a JSON audit report.
Return ONLY valid JSON, no markdown:
{
  "score": 72,
  "grade": "B",
  "summary": "One sentence overall assessment",
  "checks": [
    {
      "area": "Title",
      "status": "pass|warn|fail",
      "message": "Specific finding",
      "tip": "Actionable improvement"
    }
  ],
  "quick_wins": ["Specific change 1", "Specific change 2", "Specific change 3"],
  "suggested_title": "Improved title if score < 80",
  "suggested_tags": ["tag1", "tag2", "tag3"]
}

Check these areas: Title (length, keywords, front-loading), Tags (count, relevance, variety, long-tail), Description (length, structure, keywords, CTA), Price (competitiveness comment), Images (count if provided), Personalization.
Score 0-100. Grade: A=90+, B=75+, C=60+, D=below 60.`;

export function buildSeoAuditPrompt(listing = {}) {
  return `Listing to audit:
Title: ${listing.title || ''}
Description (first 600 chars): ${(listing.description || '').slice(0, 600)}
Tags (${(listing.tags || []).length}/13): ${(listing.tags || []).join(', ')}
Materials: ${(listing.materials || []).join(', ')}
Price: $${((listing.price?.amount || 0) / (listing.price?.divisor || 100)).toFixed(2)}
Type: ${listing.listing_type}
Images: ${listing.images?.length || 'unknown'}
Views: ${listing.views || 0}
Favorites: ${listing.num_favorers || 0}

Shop niche: Canva templates, SVG/PNG sublimation bundles, AI photo services, custom portraits. US market.
Analyse this listing and provide the audit JSON.`;
}

export function buildFullListingAuditPrompt(listing = {}) {
  return `Etsy listing full audit (2026 algorithm):

Title (${listing.title?.length||0}/140): "${listing.title||''}"
Tags (${listing.tags?.length||0}/13): ${(listing.tags||[]).join(', ')}
Price: $${((listing.price?.amount||0)/(listing.price?.divisor||100)).toFixed(2)}
Type: ${listing.listing_type||'unknown'}
Has personalization: ${listing.is_personalizable ? 'yes' : 'no'}
Description (${listing.description?.length||0} chars): "${(listing.description||'').slice(0,300)}..."

Analyse for 2026 Etsy SEO. Return:
## Overall Score: X/100

## Field Scores
- Title: X/10 — [reason]
- Description: X/10 — [reason]  
- Tags: X/10 — [reason]
- Price: X/10 — [reason]
- Images: N/A (can't view)

## Top 5 Priority Improvements (ranked by impact)
1. [Most impactful fix with exact example]
2. ...

## Rewritten Title
[Your improved title]

## Rewritten first 160 chars (Google snippet)
[Your improved opening]

## Suggested tags to add/change
[specific tag recommendations]`;
}
