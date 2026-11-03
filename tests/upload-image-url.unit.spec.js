import { test, expect } from '@playwright/test';
import {
  downloadEtsyListingImage,
  isAllowedEtsyImageUrl,
  uploadImageAction,
} from '../api/upload.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test('Etsy image URL allowlist accepts only the exact HTTPS Etsy image CDN host', () => {
  expect(isAllowedEtsyImageUrl('https://i.etsystatic.com/123/r/il/example/cover.png?width=2000')).toBe(true);

  for (const value of [
    'http://i.etsystatic.com/cover.png',
    'https://etsystatic.com/cover.png',
    'https://images.i.etsystatic.com/cover.png',
    'https://i.etsystatic.com.evil.example/cover.png',
    'https://i.etsystatic.com:8443/cover.png',
    'https://user:pass@i.etsystatic.com/cover.png',
    'https://i.etsystatic.com/cover.png#fragment',
    'https://i.etsystatic.com/a/%2e%2e/private.png',
    'not-a-url',
  ]) {
    expect(isAllowedEtsyImageUrl(value), value).toBe(false);
  }
});

test('remote Etsy image download disables redirects and validates a matching image payload', async () => {
  let request;
  const result = await downloadEtsyListingImage('https://i.etsystatic.com/123/cover.png', {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(PNG_BYTES, {
        status: 200,
        headers: {
          'Content-Type': 'image/png; charset=binary',
          'Content-Length': String(PNG_BYTES.length),
        },
      });
    },
  });

  expect(request.url).toBe('https://i.etsystatic.com/123/cover.png');
  expect(request.options).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(request.options.signal).toBeInstanceOf(AbortSignal);
  expect(result.mimeType).toBe('image/png');
  expect(result.buffer.equals(PNG_BYTES)).toBe(true);
});

test('remote Etsy image download rejects unsupported types, signature mismatches, and declared oversize files', async () => {
  await expect(downloadEtsyListingImage('https://i.etsystatic.com/file.svg', {
    fetchImpl: async () => new Response('<svg/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }),
  })).rejects.toMatchObject({ status: 415 });

  await expect(downloadEtsyListingImage('https://i.etsystatic.com/not-really.png', {
    fetchImpl: async () => new Response('not an image', { status: 200, headers: { 'Content-Type': 'image/png' } }),
  })).rejects.toMatchObject({ status: 415 });

  await expect(downloadEtsyListingImage('https://i.etsystatic.com/huge.png', {
    maxBytes: 32,
    fetchImpl: async () => new Response(PNG_BYTES, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': '33' },
    }),
  })).rejects.toMatchObject({ status: 413 });
});

test('remote Etsy image download enforces the byte limit while streaming', async () => {
  let cancelled = false;
  const chunks = [new Uint8Array(20), new Uint8Array(20)];
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'image/png' }),
    body: {
      getReader() {
        return {
          async read() {
            return chunks.length ? { done: false, value: chunks.shift() } : { done: true };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
  };

  await expect(downloadEtsyListingImage('https://i.etsystatic.com/stream.png', {
    maxBytes: 32,
    fetchImpl: async () => response,
  })).rejects.toMatchObject({ status: 413 });
  expect(cancelled).toBe(true);
});

test('remote Etsy image download aborts stalled requests', async () => {
  const stalledFetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  await expect(downloadEtsyListingImage('https://i.etsystatic.com/slow.png', {
    fetchImpl: stalledFetch,
    timeoutMs: 10,
  })).rejects.toMatchObject({ status: 504 });
});

test('uploadImageFromUrl downloads from Etsy CDN then reuses the Etsy multipart upload', async () => {
  let uploadRequest;
  const data = await uploadImageAction({
    action: 'uploadImageFromUrl',
    listing_id: '4540996015',
    imageUrl: 'https://i.etsystatic.com/12345678/r/il/example/cover.png',
    rank: 2,
    overwrite: false,
    alt_text: 'Personalized family portrait product preview',
  }, {
    token: 'etsy-access-token',
    shopId: '12345678',
    remoteFetchImpl: async () => new Response(PNG_BYTES, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(PNG_BYTES.length) },
    }),
    uploadFetchImpl: async (url, options) => {
      uploadRequest = { url, options };
      return new Response(JSON.stringify({ listing_image_id: 777 }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  expect(data).toEqual({ listing_image_id: 777 });
  expect(uploadRequest.url).toBe('https://openapi.etsy.com/v3/application/shops/12345678/listings/4540996015/images');
  expect(uploadRequest.options.method).toBe('POST');
  expect(uploadRequest.options.headers.Authorization).toBe('Bearer etsy-access-token');
  expect(uploadRequest.options.headers['Content-Type']).toContain('multipart/form-data; boundary=');
  expect(Number(uploadRequest.options.headers['Content-Length'])).toBe(uploadRequest.options.body.length);

  const multipart = uploadRequest.options.body.toString('latin1');
  expect(multipart).toContain('filename="listing_image_');
  expect(multipart).toContain('Content-Type: image/png');
  expect(multipart).toContain('name="rank"\r\n\r\n2');
  expect(multipart).toContain('name="overwrite"\r\n\r\nfalse');
  expect(multipart).toContain('name="alt_text"\r\n\r\nPersonalized family portrait product preview');
});

test('URL upload action rejects non-Etsy sources before any network request', async () => {
  let requested = false;
  await expect(uploadImageAction({
    action: 'uploadImage',
    listing_id: '4540996015',
    imageUrl: 'https://127.0.0.1/internal.png',
  }, {
    token: 'etsy-access-token',
    shopId: '12345678',
    remoteFetchImpl: async () => { requested = true; },
  })).rejects.toMatchObject({ status: 400 });
  expect(requested).toBe(false);
});
