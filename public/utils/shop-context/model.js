export function extractPersonalizationPatterns(listings = []) {
  return listings
    .filter(listing => listing.is_personalizable && listing.personalization_instructions)
    .map(listing => ({ text: listing.personalization_instructions, listing_id: listing.listing_id }))
    .filter((value, index, values) => values.findIndex(item => item.text?.slice(0, 50) === value.text?.slice(0, 50)) === index)
    .slice(0, 5);
}

export function extractDescriptionSections(listings = []) {
  const sectionPatterns = [
    /DIGITAL PRODUCT[^.]*\./i,
    /HOW TO DOWNLOAD[^]*?(?=\n\n|\n[A-Z]{2,}|$)/,
    /HOW TO ORDER[^]*?(?=\n\n|\n[A-Z]{2,}|$)/,
    /LICENSE[^]*?(?=\n\n|\n[A-Z]{2,}|$)/,
    /WHAT YOU GET[^]*?(?=\n\n|\n[A-Z]{2,}|$)/,
    /Downloaded products are non-refundable[^.]*/i,
  ];
  const found = new Set();
  for (const listing of listings.slice(0, 20)) {
    const description = listing.description || '';
    for (const pattern of sectionPatterns) {
      const match = description.match(pattern);
      if (match) {
        const key = match[0].slice(0, 40);
        if (!found.has(key)) found.add(key);
      }
    }
  }
  return [...found].slice(0, 8);
}

export function extractBoilerplateBlocks(listings = []) {
  const blocks = [];
  const candidates = {
    'Download instructions': /HOW TO DOWNLOAD[^]*?(?=\n\n[A-Z]|={3,}|$)/i,
    'License': /LICENSE[^]*?You CAN NOT[^]*?(?=\n\n[A-Z]|={3,}|$)/i,
    'Personalization': /Please send[^.]+email[^.]+\./i,
    'No physical product': /DIGITAL PRODUCT\. No physical product[^.]+\./i,
    'Non-refundable': /Downloaded products are non-refundable[^.]*/i,
  };
  for (const [label, pattern] of Object.entries(candidates)) {
    const matches = listings
      .map(listing => { const match = (listing.description || '').match(pattern); return match ? match[0] : null; })
      .filter(Boolean);
    if (matches.length >= 2) {
      const frequency = {};
      matches.forEach(match => { const key = match.slice(0, 60); frequency[key] = (frequency[key] || 0) + 1; });
      const best = Object.entries(frequency).sort((a, b) => b[1] - a[1])[0];
      const text = matches.find(match => match.slice(0, 60) === best[0]) || matches[0];
      if (text) blocks.push({ label, text: text.trim(), count: best[1] });
    }
  }
  return blocks.slice(0, 4);
}

export function extractTopTags(listings = []) {
  const frequency = {};
  listings.forEach(listing => (listing.tags || []).forEach(tag => { frequency[tag] = (frequency[tag] || 0) + 1; }));
  return Object.entries(frequency).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([tag]) => tag);
}

export function extractPriceRange(listings = []) {
  const prices = listings.map(listing => listing.price ? listing.price.amount / listing.price.divisor : 0).filter(price => price > 0);
  if (!prices.length) return { min: 0, max: 0, avg: 0 };
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
    avg: prices.reduce((sum, price) => sum + price, 0) / prices.length,
  };
}

export function buildShopContext({ listings = [], sections = [], timestamp = Date.now() } = {}) {
  return {
    timestamp,
    listings: listings.map(listing => ({
      id: listing.listing_id,
      title: listing.title,
      listing_type: listing.listing_type,
      price: listing.price ? listing.price.amount / listing.price.divisor : 0,
      tags: listing.tags || [],
      is_personalizable: listing.is_personalizable,
      personalization_instructions: listing.personalization_instructions,
      shop_section_id: listing.shop_section_id,
    })),
    personalizationPatterns: extractPersonalizationPatterns(listings),
    descriptionSections: extractDescriptionSections(listings),
    boilerplateBlocks: extractBoilerplateBlocks(listings),
    topTags: extractTopTags(listings),
    priceRange: extractPriceRange(listings),
    sectionNames: sections.map(section => section.title).filter(Boolean),
    digitalCount: listings.filter(listing => listing.listing_type === 'download').length,
    physicalCount: listings.filter(listing => listing.listing_type !== 'download').length,
  };
}
