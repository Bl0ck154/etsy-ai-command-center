import { chromium } from 'playwright';
import { existsSync } from 'fs';
import crypto from 'crypto';

function cleanText(value, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeSocialReviewCardEvidence(review = {}) {
  const exactQuote = cleanText(review.exact_quote || review.review_quote || review.text || review.review, 900);
  const rating = Math.max(1, Math.min(5, Math.round(Number(review.rating) || 0)));
  const reviewId = cleanText(review.review_id || review.id, 120);
  if (!reviewId || !exactQuote || !rating) return null;
  return {
    review_id: reviewId,
    listing_id: cleanText(review.listing_id, 100) || null,
    exact_quote: exactQuote,
    rating,
    listing_title: cleanText(review.listing_title, 180) || null,
  };
}

const REVIEW_CARD_GEOMETRY = Object.freeze({
  '1:1': { width: 1080, height: 1080, layout: 'square' },
  '4:5': { width: 1080, height: 1350, layout: 'portrait' },
  '2:3': { width: 1000, height: 1500, layout: 'tall' },
  '3:4': { width: 1080, height: 1440, layout: 'tall' },
  '9:16': { width: 1080, height: 1920, layout: 'story' },
  '16:9': { width: 1920, height: 1080, layout: 'wide' },
});

export function socialReviewCardGeometry(aspectRatio) {
  const ratio = cleanText(aspectRatio, 20);
  const geometry = REVIEW_CARD_GEOMETRY[ratio];
  if (!geometry) throw new Error(`Unsupported review card aspect ratio: ${ratio || 'missing'}.`);
  return { aspect_ratio: ratio, ...geometry };
}

const REVIEW_CARD_STYLES = new Set(['bold_editorial', 'modern_poster', 'scrapbook_note']);
const DEFAULT_REVIEW_CARD_DESIGN = Object.freeze({
  style: 'bold_editorial',
  heading: 'What an Etsy buyer said',
  highlight_phrase: '',
  background_color: '#EAF2EE',
  surface_color: '#FFFDF8',
  text_color: '#17251F',
  accent_color: '#E85D3F',
});

function normalizedHexColor(value) {
  const color = cleanText(value, 20).toUpperCase();
  return /^#[0-9A-F]{6}$/.test(color) ? color : '';
}

export function normalizeSocialReviewCardDesign(design = {}, { allowDefault = false } = {}) {
  const source = design && typeof design === 'object' && !Array.isArray(design) ? design : {};
  const normalized = {
    style: cleanText(source.style, 40).toLowerCase(),
    heading: cleanText(source.heading, 80),
    highlight_phrase: cleanText(source.highlight_phrase, 100),
    background_color: normalizedHexColor(source.background_color),
    surface_color: normalizedHexColor(source.surface_color),
    text_color: normalizedHexColor(source.text_color),
    accent_color: normalizedHexColor(source.accent_color),
  };
  if (allowDefault && !Object.values(normalized).some(Boolean)) return { ...DEFAULT_REVIEW_CARD_DESIGN };
  if (!REVIEW_CARD_STYLES.has(normalized.style)
    || !normalized.heading
    || !normalized.background_color
    || !normalized.surface_color
    || !normalized.text_color
    || !normalized.accent_color) return null;
  return normalized;
}

function resolvedSocialReviewCardDesign(design, heading) {
  const resolved = normalizeSocialReviewCardDesign(design, { allowDefault: true });
  if (!design || typeof design !== 'object' || !cleanText(design.heading, 80)) {
    resolved.heading = cleanText(heading, 80) || DEFAULT_REVIEW_CARD_DESIGN.heading;
  }
  return resolved;
}

export function socialReviewCardRenderSpecSha256({
  review,
  shopName = '',
  heading = DEFAULT_REVIEW_CARD_DESIGN.heading,
  contextNote = '',
  aspectRatio,
  design,
} = {}) {
  const evidence = normalizeSocialReviewCardEvidence(review);
  if (!evidence) throw new Error('A review card requires review_id, exact_quote, and rating.');
  const geometry = socialReviewCardGeometry(aspectRatio);
  const spec = {
    review_id: evidence.review_id,
    listing_id: evidence.listing_id,
    exact_quote: evidence.exact_quote,
    rating: evidence.rating,
    listing_title: evidence.listing_title,
    shop_name: cleanText(shopName, 80) || null,
    heading: cleanText(heading, 80) || DEFAULT_REVIEW_CARD_DESIGN.heading,
    context_note: cleanText(contextNote, 180),
    aspect_ratio: geometry.aspect_ratio,
    design: resolvedSocialReviewCardDesign(design, heading),
  };
  return crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

export function buildSocialReviewCardHtml({
  review,
  shopName = '',
  heading = DEFAULT_REVIEW_CARD_DESIGN.heading,
  contextNote = '',
  aspectRatio,
  design,
} = {}) {
  const evidence = normalizeSocialReviewCardEvidence(review);
  if (!evidence) throw new Error('A review card requires review_id, exact_quote, and rating.');
  const geometry = socialReviewCardGeometry(aspectRatio);
  const safeShopName = escapeHtml(cleanText(shopName, 80));
  const cardDesign = resolvedSocialReviewCardDesign(design, heading);
  const chosenHeading = cardDesign.heading;
  const safeHeading = escapeHtml(chosenHeading);
  const safeContextNote = escapeHtml(cleanText(contextNote, 180));
  const highlightPhrase = cardDesign.highlight_phrase;
  const quoteSize = evidence.exact_quote.length <= 90 ? 'short' : (evidence.exact_quote.length <= 180 ? 'medium' : 'long');
  const highlightIndex = highlightPhrase
    ? evidence.exact_quote.toLocaleLowerCase().indexOf(highlightPhrase.toLocaleLowerCase())
    : -1;
  const safeQuote = highlightIndex >= 0
    ? `${escapeHtml(evidence.exact_quote.slice(0, highlightIndex))}<mark>${escapeHtml(evidence.exact_quote.slice(highlightIndex, highlightIndex + highlightPhrase.length))}</mark>${escapeHtml(evidence.exact_quote.slice(highlightIndex + highlightPhrase.length))}`
    : escapeHtml(evidence.exact_quote);
  const stars = '&#9733;'.repeat(evidence.rating) + '&#9734;'.repeat(5 - evidence.rating);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${geometry.width}px; height: ${geometry.height}px; overflow: hidden; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      color: var(--text);
      background: var(--background);
    }
    main {
      --background: ${cardDesign.background_color};
      --surface: ${cardDesign.surface_color};
      --text: ${cardDesign.text_color};
      --accent: ${cardDesign.accent_color};
      width: 100%;
      height: 100%;
      position: relative;
      padding: 76px;
      display: grid;
      place-items: stretch;
      background: var(--background);
      isolation: isolate;
    }
    main::before, main::after {
      content: "";
      position: absolute;
      z-index: -1;
      background: var(--accent);
    }
    main::before {
      width: 330px;
      height: 330px;
      border-radius: 50%;
      right: -120px;
      top: -120px;
    }
    main::after {
      width: 210px;
      height: 24px;
      left: 0;
      bottom: 78px;
    }
    .review-card {
      min-height: 100%;
      position: relative;
      padding: 68px 66px 56px;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 38px;
      background: var(--surface);
      border: 3px solid color-mix(in srgb, var(--text) 18%, transparent);
      box-shadow: 18px 20px 0 color-mix(in srgb, var(--accent) 48%, transparent);
      overflow: hidden;
    }
    body[data-layout="square"] main { padding: 58px; }
    body[data-layout="square"] .review-card { padding: 54px 56px 48px; gap: 26px; }
    body[data-layout="square"] blockquote { font-size: 48px; line-height: 1.16; }
    body[data-layout="story"] main { padding: 100px 78px; }
    body[data-layout="story"] blockquote { font-size: 64px; }
    body[data-layout="wide"] main { padding: 54px 90px; }
    body[data-layout="wide"] .review-card { padding: 46px 70px 42px; gap: 24px; }
    body[data-layout="wide"] blockquote { max-width: 1640px; font-size: 46px; line-height: 1.12; }
    .source {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      color: var(--text);
      font-size: 24px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .source-label {
      padding: 12px 18px;
      background: var(--accent);
      color: var(--surface);
      border-radius: 999px;
    }
    .rating-chip {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 22px;
    }
    .review-body {
      min-height: 0;
      display: grid;
      align-content: center;
      position: relative;
    }
    .review-body::before {
      content: "“";
      position: absolute;
      right: -10px;
      top: 50%;
      transform: translateY(-58%);
      color: color-mix(in srgb, var(--accent) 12%, transparent);
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 310px;
      line-height: 1;
      pointer-events: none;
    }
    .stars {
      margin: 0;
      color: var(--accent);
      font-size: 42px;
      letter-spacing: 4px;
    }
    blockquote {
      margin: 26px 0 0;
      max-width: 900px;
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 58px;
      line-height: 1.15;
      font-weight: 700;
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }
    .review-body[data-quote-size="short"] blockquote { max-width: 860px; font-size: 78px; line-height: 1.08; }
    .review-body[data-quote-size="medium"] blockquote { font-size: 64px; }
    mark {
      color: var(--text);
      background: linear-gradient(transparent 58%, color-mix(in srgb, var(--accent) 52%, transparent) 58%);
      padding: 0 3px;
    }
    .review-footer {
      padding-top: 28px;
      border-top: 3px solid color-mix(in srgb, var(--text) 22%, transparent);
    }
    .context {
      color: var(--text);
      font-size: 27px;
      line-height: 1.34;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .privacy {
      margin-top: 14px;
      color: color-mix(in srgb, var(--text) 66%, transparent);
      font-size: 19px;
    }
    .shop {
      margin-top: 8px;
      color: color-mix(in srgb, var(--text) 66%, transparent);
      font-size: 18px;
    }
    main[data-style="modern_poster"] .review-card {
      border-radius: 26px;
      box-shadow: none;
      border-width: 6px;
    }
    main[data-style="modern_poster"] blockquote {
      font-family: Arial, Helvetica, sans-serif;
      font-weight: 900;
      line-height: 1.03;
    }
    main[data-style="modern_poster"] .source-label { border-radius: 6px; }
    main[data-style="scrapbook_note"] .review-card {
      transform: rotate(-0.7deg);
      border: 0;
      box-shadow: 14px 16px 0 color-mix(in srgb, var(--text) 16%, transparent);
    }
    main[data-style="scrapbook_note"] .review-card::before {
      content: "";
      position: absolute;
      width: 190px;
      height: 44px;
      top: 54px;
      left: 50%;
      transform: translateX(-50%) rotate(2deg);
      background: color-mix(in srgb, var(--accent) 54%, white);
      opacity: .78;
      z-index: 0;
    }
    main[data-style="scrapbook_note"] .review-card > * { position: relative; z-index: 1; }
  </style>
</head>
<body data-layout="${geometry.layout}">
  <main data-style="${cardDesign.style}">
    <div class="review-card">
      <div class="source">
        <span class="source-label">${safeHeading}</span>
        <span class="rating-chip">${evidence.rating}.0 / 5</span>
      </div>
      <div class="review-body" data-quote-size="${quoteSize}">
        <div class="stars" aria-label="${evidence.rating} out of 5 stars">${stars}</div>
        <blockquote>&ldquo;${safeQuote}&rdquo;</blockquote>
      </div>
      <div class="review-footer">
        ${safeContextNote ? `<div class="context">${safeContextNote}</div>` : ''}
        <div class="privacy">Customer review from an Etsy order. Buyer identity is not displayed.</div>
        ${safeShopName ? `<div class="shop">Review received by ${safeShopName} on Etsy.</div>` : ''}
      </div>
    </div>
  </main>
</body>
</html>`;
}

export async function renderSocialReviewCardPng(options = {}) {
  const geometry = socialReviewCardGeometry(options.aspectRatio);
  const html = buildSocialReviewCardHtml(options);
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const executablePath = candidates.find(candidate => existsSync(candidate));
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(typeof process.getuid === 'function' && process.getuid() === 0 ? { args: ['--no-sandbox'] } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: geometry.width, height: geometry.height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    return await page.screenshot({ type: 'png', fullPage: false });
  } finally {
    await browser.close();
  }
}
