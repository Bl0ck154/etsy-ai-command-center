import { test, expect } from '@playwright/test';
import { isAllowedExternalReferenceImageUrl } from '../api/_external-ai.js';

test.describe('external reference image URL policy', () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  };

  test.afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('allows exact Etsy CDN and server-owned persistent media assets', () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_BASE_URL = 'https://dashboard.example.test';

    expect(isAllowedExternalReferenceImageUrl('https://i.etsystatic.com/123/r/il/example/image.jpg?width=2000')).toBe(true);
    expect(isAllowedExternalReferenceImageUrl('https://dashboard.example.test/api/social?action=mediaAsset&id=shmedia_0123456789abcdef01234567')).toBe(true);
  });

  test('rejects private, spoofed, redirected-path, and unowned URLs', () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_BASE_URL = 'https://dashboard.example.test';

    const rejected = [
      'http://127.0.0.1:3010/healthz',
      'http://169.254.169.254/latest/meta-data/',
      'https://i.etsystatic.com.evil.example/image.jpg',
      'https://i.etsystatic.com:8443/image.jpg',
      'https://user:pass@i.etsystatic.com/image.jpg',
      'https://i.etsystatic.com/a/%2e%2e/private.jpg',
      'https://dashboard.example.test/healthz',
      'https://dashboard.example.test/api/social?action=mediaAsset&id=not-an-asset',
      'https://evil.example/api/social?action=mediaAsset&id=shmedia_0123456789abcdef01234567',
    ];
    for (const url of rejected) expect(isAllowedExternalReferenceImageUrl(url), url).toBe(false);
  });

  test('requires HTTPS for the configured production public origin', () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3010';
    expect(isAllowedExternalReferenceImageUrl('http://127.0.0.1:3010/api/social?action=mediaAsset&id=shmedia_0123456789abcdef01234567')).toBe(false);
  });
});
