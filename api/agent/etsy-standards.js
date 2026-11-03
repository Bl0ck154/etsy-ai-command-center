export const ETSY_GUIDANCE_REVIEWED_AT = 'July 2026';

export const ETSY_GUIDANCE_SOURCES = Object.freeze({
  titles: Object.freeze({
    label: 'How to Create a Listing',
    url: 'https://help.etsy.com/hc/en-us/articles/115015628707-How-to-Create-a-Listing',
    contentUrl: 'https://help.etsy.com/api/v2/help_center/en-us/articles/115015628707.json',
  }),
  search: Object.freeze({
    label: 'How to Use Tags to Get Found in Search',
    url: 'https://help.etsy.com/hc/en-us/articles/360000336307-How-to-Use-Tags-to-Get-Found-in-Search',
    contentUrl: 'https://help.etsy.com/api/v2/help_center/en-us/articles/360000336307.json',
  }),
  description: Object.freeze({
    label: 'SEO for Shop and Listing Pages',
    url: 'https://help.etsy.com/hc/en-us/articles/115015663987-Search-Engine-Optimization-SEO-for-Shop-and-Listing-Pages',
    contentUrl: 'https://help.etsy.com/api/v2/help_center/en-us/articles/115015663987.json',
  }),
  photos: Object.freeze({
    label: 'Requirements and Best Practices for Images',
    url: 'https://help.etsy.com/hc/en-us/articles/115015663347-Requirements-and-Best-Practices-for-Images-in-Your-Etsy-Shop',
    contentUrl: 'https://help.etsy.com/api/v2/help_center/en-us/articles/115015663347.json',
  }),
});

export const ETSY_LISTING_OPTIMIZATION_RULES = Object.freeze({
  title: Object.freeze([
    'Clearly name the item for sale once, with the item noun and the most important objective traits near the beginning.',
    'Prefer a clear, buyer-friendly title under 15 words when that still identifies the product; never exceed Etsy\'s 140-character limit.',
    'Use only essential traits such as material, color, size, format, or customization. Include an occasion or recipient only when it is essential to what the item is.',
    'Do not repeat words or keyword phrases. Move subjective praise, generic gift phrases, price, shipping, and sale language out of the title.',
  ]),
  discovery: Object.freeze([
    'Treat title, tags, attributes, description, category, first photo, listing quality, and reviews as a connected listing rather than forcing every search phrase into the title.',
    'Use all 13 tag slots when relevant. Keep every tag accurate, varied, natural, and no longer than 20 characters; avoid mechanical repetition and invented demand.',
    'Choose the most specific accurate category and complete every relevant attribute because categories and attributes participate in query matching.',
    'Write accurate buyer-facing language. Never invent product facts, materials, turnaround times, popularity, discounts, or performance claims.',
  ]),
  description: Object.freeze([
    'Open with a concise factual explanation of what the buyer receives and the main differentiator.',
    'Make the description easy to scan and cover inclusions, format or dimensions, ordering or use steps, delivery, personalization inputs, and material limitations that actually apply.',
    'Use relevant buyer language naturally. Do not stuff keyword variants, add filler for a target word count, or claim that an optimization guarantees placement.',
  ]),
  photos: Object.freeze([
    'Make the first photo clear, bright, accurate, and recognizable at thumbnail size, with the actual product or result as the focal point.',
    'Use multiple truthful, high-quality views that answer buyer questions; choose useful combinations of studio, lifestyle, scale, detail, group, packaging, and process images for the product.',
    'Keep colors and proportions realistic, show variations when relevant, and compose images so the subject survives Etsy\'s different crops and aspect ratios.',
  ]),
});

function bulletList(items) {
  return items.map(item => `- ${item}`).join('\n');
}

export function buildEtsyListingStandardsPrompt({
  reviewedAt = ETSY_GUIDANCE_REVIEWED_AT,
  sources = ETSY_GUIDANCE_SOURCES,
  rules = ETSY_LISTING_OPTIMIZATION_RULES,
} = {}) {
  return `## CURRENT ETSY LISTING GUIDANCE
Guidance reviewed: ${reviewedAt}.
Primary official sources:
- ${sources.titles.label}${sources.titles.publishedAt ? ` (${sources.titles.publishedAt})` : ''}: ${sources.titles.url}
- ${sources.search.label}: ${sources.search.url}
- ${sources.description.label}: ${sources.description.url}
- ${sources.photos.label}: ${sources.photos.url}

TITLE
${bulletList(rules.title)}

HOLISTIC SEARCH MATCHING
${bulletList(rules.discovery)}

DESCRIPTION
${bulletList(rules.description)}

PHOTOS
${bulletList(rules.photos)}

These are current Etsy guidance and practical listing standards, not a ranking formula. Never promise a ranking, traffic, conversion, or sales outcome.`;
}

export const ETSY_LISTING_STANDARDS_PROMPT = buildEtsyListingStandardsPrompt();

export function buildEtsyTitleStandardsPrompt({
  reviewedAt = ETSY_GUIDANCE_REVIEWED_AT,
  sources = ETSY_GUIDANCE_SOURCES,
  rules = ETSY_LISTING_OPTIMIZATION_RULES,
} = {}) {
  return `Apply Etsy listing title guidance reviewed in ${reviewedAt}:
${bulletList(rules.title)}
Do not promise search rank or sales. Official source: ${sources.titles.url}`;
}

export const ETSY_TITLE_STANDARDS_PROMPT = buildEtsyTitleStandardsPrompt();

export function buildEtsyOwnerGuidanceDisclosurePrompt({
  reviewedAt = ETSY_GUIDANCE_REVIEWED_AT,
  sources = ETSY_GUIDANCE_SOURCES,
} = {}) {
  return `Only after a listing generation or listing audit has actually completed successfully, include one concise owner-facing sentence in the owner's language stating that Etsy guidance reviewed in ${reviewedAt} was applied. Include these official Markdown links: [title guidance](${sources.titles.url}), [search guidance](${sources.search.url}), [description guidance](${sources.description.url}), and [photo guidance](${sources.photos.url}). Do not show this disclosure for planning, failed operations, unrelated replies, or before the generation/audit result exists. Call it current Etsy guidance or standards; never say "best possible", "guaranteed", or imply guaranteed ranking, traffic, conversion, or sales.`;
}

export const ETSY_OWNER_GUIDANCE_DISCLOSURE_PROMPT = buildEtsyOwnerGuidanceDisclosurePrompt();
