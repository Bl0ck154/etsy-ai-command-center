import { stripMarkdownForEtsy } from './plain-text.js';

export function sanitizeEtsyTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const clean = [];
  for (const raw of tags) {
    let tag = stripMarkdownForEtsy(raw).replace(/^[#•\-\s]+/, '').replace(/\s+/g, ' ').trim();
    if (!tag) continue;
    if (tag.length > 20) tag = tag.slice(0, 20).trim();
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(tag);
    if (clean.length >= 13) break;
  }
  return clean;
}

export function sanitizeEtsyTitle(value) {
  let title = stripMarkdownForEtsy(value).replace(/\s+/g, ' ').trim();
  const replacements = { '&': ' and ', '+': ' plus ', '%': ' percent ', ':': ' - ' };
  for (const character of Object.keys(replacements)) {
    let seen = false;
    title = [...title].map(part => {
      if (part !== character) return part;
      if (!seen) {
        seen = true;
        return part;
      }
      return replacements[character];
    }).join('');
  }
  return title.replace(/\s+/g, ' ').trim();
}

export function sanitizeEtsyMaterials(materials) {
  if (!Array.isArray(materials)) return [];
  const seen = new Set();
  const clean = [];
  for (const raw of materials) {
    const material = stripMarkdownForEtsy(raw)
      .replace(/[^\p{L}\p{N}\p{Zs}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 45)
      .trim();
    if (!material || seen.has(material.toLowerCase())) continue;
    seen.add(material.toLowerCase());
    clean.push(material);
    if (clean.length >= 13) break;
  }
  return clean;
}
