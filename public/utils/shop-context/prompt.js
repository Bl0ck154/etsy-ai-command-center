export function buildContextPrompt(context) {
  if (!context || !context.listings?.length) return '';

  const lines = ['=== YOUR SHOP CONTEXT (use this for consistency) ==='];

  if (context.personalizationPatterns.length) {
    lines.push('\nPersonalization field patterns used in your shop:');
    context.personalizationPatterns.slice(0, 3).forEach(pattern => {
      lines.push(`  • "${pattern.text.slice(0, 120)}"`);
    });
  }

  if (context.descriptionSections.length) {
    lines.push('\nCommon description sections in your shop:');
    context.descriptionSections.slice(0, 5).forEach(section => lines.push(`  • ${section}`));
  }

  if (context.topTags.length) {
    lines.push(`\nFrequently used tags in your shop: ${context.topTags.slice(0, 15).join(', ')}`);
  }

  lines.push(`\nYour price range: $${context.priceRange.min.toFixed(2)}–$${context.priceRange.max.toFixed(2)}, avg $${context.priceRange.avg.toFixed(2)}`);

  if (context.sectionNames.length) {
    lines.push(`Your shop sections: ${context.sectionNames.join(', ')}`);
  }

  lines.push('\n=== END SHOP CONTEXT ===\n');
  lines.push('Generate the new listing in a style CONSISTENT with the above patterns.');
  return lines.join('\n');
}
