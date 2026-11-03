export const MAX_REVIEW_IMAGE_BYTES = 8 * 1024 * 1024;
export const REVIEW_IMAGE_TIMEOUT_MS = 15_000;

export function isAllowedReviewImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'i.etsystatic.com';
  } catch {
    return false;
  }
}

export async function proxyEtsyReviewImage(req, res, {
  fetchImpl = fetch,
  timeoutMs = REVIEW_IMAGE_TIMEOUT_MS,
  maxBytes = MAX_REVIEW_IMAGE_BYTES,
} = {}) {
  const rawUrl = req.query?.url || req.query?.image_url || '';
  if (!isAllowedReviewImageUrl(rawUrl)) {
    return res.status(400).json({ error: 'Only Etsy review image URLs are allowed' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetchImpl(String(rawUrl), {
      signal: controller.signal,
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif;q=0.9,*/*;q=0.1' },
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: `Etsy image upstream returned ${upstream.status}` });
    }
    const mimeType = String(upstream.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!/^image\/(?:jpeg|png|webp|gif)$/.test(mimeType)) {
      return res.status(502).json({ error: 'Etsy image upstream returned an unsupported content type' });
    }
    const declaredLength = Number(upstream.headers.get('content-length') || 0);
    if (declaredLength > maxBytes) {
      return res.status(413).json({ error: 'Etsy review image is too large' });
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    if (!body.length || body.length > maxBytes) {
      return res.status(413).json({ error: 'Etsy review image is too large' });
    }
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).end(body);
  } catch (error) {
    if (error?.name === 'AbortError') {
      return res.status(504).json({ error: 'Etsy image request timed out' });
    }
    return res.status(502).json({ error: 'Etsy image request failed' });
  } finally {
    clearTimeout(timeout);
  }
}
