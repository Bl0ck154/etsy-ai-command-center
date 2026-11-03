import { test, expect } from '@playwright/test';

import { createUploadApplication } from '../api/upload/application.js';

test('delete image preserves exact Etsy URL, auth headers and success shape', async () => {
  const calls = [];
  const app = createUploadApplication({
    etsyBase: 'https://etsy.example/v3/application',
    apiKey: 'key',
    shopId: 'shop-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 204, json: async () => ({}) };
    },
  });
  const result = await app.execute({
    action: 'deleteImage', listing_id: '10', listing_image_id: '20',
  }, { token: 'token' });
  expect(result).toEqual({ kind: 'delete', data: { success: true } });
  expect(calls).toEqual([{
    url: 'https://etsy.example/v3/application/shops/shop-1/listings/10/images/20',
    options: {
      method: 'DELETE',
      headers: { 'x-api-key': 'key', 'Authorization': 'Bearer token' },
    },
  }]);
});

test('get images preserves listing endpoint and listing_id validation', async () => {
  const calls = [];
  const app = createUploadApplication({
    etsyBase: 'https://etsy.example/v3/application',
    apiKey: 'key',
    shopId: 'shop-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ results: [{ id: 1 }] }) };
    },
  });
  await expect(app.execute({ action: 'getImages' }, { token: 'token' })).rejects.toMatchObject({
    message: 'listing_id required', status: 400,
  });
  const result = await app.execute({ action: 'getImages', listing_id: '10' }, { token: 'token' });
  expect(result).toEqual({ kind: 'get', data: { results: [{ id: 1 }] } });
  expect(calls[0]).toEqual({
    url: 'https://etsy.example/v3/application/listings/10/images',
    options: { headers: { 'x-api-key': 'key', 'Authorization': 'Bearer token' } },
  });
});

test('upload actions delegate payload and scoped token/shop to image-transfer owner', async () => {
  const calls = [];
  const app = createUploadApplication({
    etsyBase: 'https://etsy.example',
    apiKey: 'key',
    shopId: 'shop-1',
    uploadImageActionImpl: async (input, context) => {
      calls.push({ input, context });
      return { listing_image_id: 88 };
    },
  });
  const input = { action: 'uploadImageFromUrl', listing_id: '10', imageUrl: 'https://i.etsystatic.com/1/a.jpg' };
  expect(await app.execute(input, { token: 'token' })).toEqual({
    kind: 'upload', data: { listing_image_id: 88 },
  });
  expect(calls).toEqual([{ input, context: { token: 'token', shopId: 'shop-1' } }]);
});

test('unknown action remains a public 400 application error', async () => {
  const app = createUploadApplication({
    etsyBase: 'https://etsy.example', apiKey: 'key', shopId: 'shop-1',
  });
  await expect(app.execute({ action: 'wat' }, { token: 'token' })).rejects.toMatchObject({
    message: 'Unknown action: wat', status: 400,
  });
});
