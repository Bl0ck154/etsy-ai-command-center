import { test, expect } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import sharp from 'sharp';

import {
  configuredGptFileHosts,
  downloadGptFile,
  isAllowedGptFileHostname,
  isPublicIpAddress,
  normalizeGptFileReferences,
  parseAllowedGptFileUrl,
  prepareGptFiles,
  resolvePublicGptFileHost,
} from '../api/gpt/files.js';

test('GPT file wildcard allowlist accepts only the base and dot-delimited subdomains', () => {
  const allowedHosts = configuredGptFileHosts('*.OAIUSERCONTENT.COM...,files.example.test');
  expect([...allowedHosts]).toEqual(['*.oaiusercontent.com', 'files.example.test']);
  for (const value of [
    'https://files.oaiusercontent.com/file',
    'https://sdmntprnortheu.oaiusercontent.com/file',
    'https://a.b.oaiusercontent.com/file',
    'https://oaiusercontent.com/file',
    'https://FILES.OAIUSERCONTENT.COM.../file',
  ]) expect(parseAllowedGptFileUrl(value, { allowedHosts }).protocol, value).toBe('https:');

  expect(isAllowedGptFileHostname('files.example.test', allowedHosts)).toBe(true);
  expect(isAllowedGptFileHostname('sub.files.example.test', allowedHosts)).toBe(false);
  for (const value of [
    'https://oaiusercontent.com.evil.org/file',
    'https://fakeoaiusercontent.com/file',
    'https://aexample.com/file',
    'https://oaiusercontent.com@evil.org/file',
    'http://files.oaiusercontent.com/file',
    'https://files.oaiusercontent.com:443/file',
    'https://127.0.0.1/file',
    'https://[::1]/file',
  ]) expect(() => parseAllowedGptFileUrl(value, { allowedHosts }), value).toThrow();

  for (const value of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '::1', 'fc00::1']) expect(isPublicIpAddress(value), value).toBe(false);
  expect(isPublicIpAddress('93.184.216.34')).toBe(true);
});

test('GPT file host configuration rejects malformed wildcard and IP entries', () => {
  for (const value of [
    '*oaiusercontent.com',
    'files.*.oaiusercontent.com',
    '*.*.oaiusercontent.com',
    '*',
    '*.com',
    '*.127.0.0.1',
    '*.example.com:443',
    '*.example.com/path',
  ]) expect(() => configuredGptFileHosts(value), value).toThrow(expect.objectContaining({ code: 'GPT_FILE_NOT_CONFIGURED' }));
});

test('GPT file DNS validation rejects private, reserved, and mixed answers', async () => {
  for (const addresses of [
    [{ address: '10.0.0.2', family: 4 }],
    [{ address: '203.0.113.7', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: 'fd00::1', family: 6 }],
  ]) {
    await expect(resolvePublicGptFileHost('files.oaiusercontent.com', {
      lookupImpl: async () => addresses,
    })).rejects.toMatchObject({ code: 'GPT_FILE_SSRF_BLOCKED' });
  }
});

test('GPT file redirects are revalidated against the wildcard allowlist', async () => {
  let requestCount = 0;
  const requestImpl = (_url, _options, callback) => {
    requestCount += 1;
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = error => request.emit('error', error);
    request.end = () => {
      const response = Readable.from([]);
      response.statusCode = 302;
      response.headers = { location: 'https://outside.example/file' };
      response.resume = () => {};
      callback(response);
    };
    return request;
  };

  await expect(downloadGptFile({
    url: 'https://files.oaiusercontent.com/file',
    sourceField: 'openaiFileIdRefs',
    index: 0,
    declaredMimeType: 'image/png',
  }, {
    allowedHosts: configuredGptFileHosts('*.oaiusercontent.com'),
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl,
  })).rejects.toMatchObject({
    code: 'GPT_FILE_INVALID',
    fileDiagnostic: { hostname: 'outside.example', source_field: 'openaiFileIdRefs', file_index: 0 },
  });
  expect(requestCount).toBe(1);
});

test('ChatGPT local sandbox and browser URLs get an actionable redacted error', () => {
  const allowedHosts = new Set(['files.oaiusercontent.com']);
  for (const [value, scheme] of [
    ['sandbox:/mnt/data/generated.webp', 'sandbox'],
    ['/mnt/data/generated.webp', 'local-path'],
    ['file:///mnt/data/generated.webp', 'file'],
    ['blob:https://chatgpt.com/private-id', 'blob'],
  ]) {
    let error;
    try {
      parseAllowedGptFileUrl(value, { allowedHosts, sourceField: 'source_urls', fileIndex: 2 });
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({
      code: 'GPT_FILE_LOCAL_SANDBOX_UNREACHABLE',
      fileDiagnostic: { source_field: 'source_urls', scheme, hostname: '', file_index: 2 },
    });
    expect(error.message).toMatch(/external Etsy AI Command Center server cannot access ChatGPT sandbox/i);
    expect(JSON.stringify(error.fileDiagnostic)).not.toContain('/mnt/data');
  }
});

test('openaiFileIdRefs require an HTTPS download_link and preserve exact-host allowlisting', () => {
  const allowedHosts = new Set(['files.oaiusercontent.com']);
  expect(parseAllowedGptFileUrl('https://files.oaiusercontent.com/file?signature=secret', {
    allowedHosts,
    sourceField: 'openaiFileIdRefs',
    fileIndex: 0,
  }).hostname).toBe('files.oaiusercontent.com');

  expect(() => normalizeGptFileReferences({ openaiFileIdRefs: [{ id: 'missing-link' }] }))
    .toThrow(expect.objectContaining({ code: 'GPT_FILE_REFS_MALFORMED' }));
  expect(() => parseAllowedGptFileUrl('http://files.oaiusercontent.com/file', {
    allowedHosts,
    sourceField: 'openaiFileIdRefs',
    fileIndex: 0,
  })).toThrow(expect.objectContaining({ code: 'GPT_FILE_LOCAL_SANDBOX_UNREACHABLE' }));

  let blocked;
  try {
    parseAllowedGptFileUrl('https://unknown.example/private/path?signature=secret', {
      allowedHosts,
      sourceField: 'source_url',
      fileIndex: 0,
    });
  } catch (caught) { blocked = caught; }
  expect(blocked).toMatchObject({
    code: 'GPT_FILE_INVALID',
    fileDiagnostic: { source_field: 'source_url', scheme: 'https', hostname: 'unknown.example', file_index: 0 },
  });
  expect(JSON.stringify(blocked.fileDiagnostic)).not.toContain('signature');
});

test('openaiFileIdRefs runtime objects preserve order and enforce the ten-file cap', () => {
  const refs = normalizeGptFileReferences({ openaiFileIdRefs: [
    { id: 'file-b', name: 'second.png', mime_type: 'image/png', download_link: 'https://files.oaiusercontent.com/b' },
    { id: 'file-a', name: 'first.png', mime_type: 'image/png', download_link: 'https://files.oaiusercontent.com/a' },
  ] });
  expect(refs.map(ref => ref.id)).toEqual(['file-b', 'file-a']);
  expect(() => normalizeGptFileReferences({ openaiFileIdRefs: Array.from({ length: 11 }, (_, index) => ({ download_link: `https://files.oaiusercontent.com/${index}` })) })).toThrow(/at most 10/i);
  expect(() => normalizeGptFileReferences({ openaiFileIdRefs: [{ download_link: 'https://files.oaiusercontent.com/a' }], source_url: 'https://files.oaiusercontent.com/b' })).toThrow(/not both/i);
});

test('prepared GPT images are downloaded in order and normalized through sharp', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  const requestImpl = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = error => request.emit('error', error);
    request.end = () => {
      const response = Readable.from([png]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/png', 'content-length': String(png.length) };
      response.resume = () => {};
      callback(response);
    };
    return request;
  };
  const files = await prepareGptFiles({ openaiFileIdRefs: [
    { id: 'file-2', name: 'two.webp', mime_type: 'image/png', download_link: 'https://files.oaiusercontent.com/two' },
    { id: 'file-1', name: 'one.webp', mime_type: 'image/png', download_link: 'https://files.oaiusercontent.com/one' },
  ] }, {
    allowedHosts: new Set(['files.oaiusercontent.com']),
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl,
  });
  expect(files.map(file => file.id)).toEqual(['file-2', 'file-1']);
  expect(files.every(file => file.mimeType === 'image/png' && file.kind === 'image')).toBe(true);
});

test('image/webp runtime reference reaches the download stage and is prepared as an image', async () => {
  const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00ff00' } }).webp().toBuffer();
  let requestCount = 0;
  const requestImpl = (_url, _options, callback) => {
    requestCount += 1;
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = error => request.emit('error', error);
    request.end = () => {
      const response = Readable.from([webp]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/webp', 'content-length': String(webp.length) };
      response.resume = () => {};
      callback(response);
    };
    return request;
  };

  const files = await prepareGptFiles({ openaiFileIdRefs: [{
    id: 'runtime-webp',
    name: 'generated.webp',
    mime_type: 'image/webp',
    download_link: 'https://files.oaiusercontent.com/generated',
  }] }, {
    purpose: 'listing_image',
    allowedHosts: new Set(['files.oaiusercontent.com']),
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl,
  });

  expect(requestCount).toBe(1);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ id: 'runtime-webp', kind: 'image', mimeType: 'image/jpeg' });
});

test('mixed complete-draft files apply same-order per-file purposes', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const pdf = Buffer.from('%PDF-1.4\n% GPT test\n');
  const requestImpl = (url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = error => request.emit('error', error);
    request.end = () => {
      const isPdf = new URL(url).pathname.endsWith('/document');
      const buffer = isPdf ? pdf : png;
      const response = Readable.from([buffer]);
      response.statusCode = 200;
      response.headers = {
        'content-type': isPdf ? 'application/pdf' : 'image/png',
        'content-length': String(buffer.length),
      };
      response.resume = () => {};
      callback(response);
    };
    return request;
  };
  const files = await prepareGptFiles({ openaiFileIdRefs: [
    { id: 'image', name: 'image.png', mime_type: 'image/png', download_link: 'https://files.oaiusercontent.com/image' },
    { id: 'document', name: 'document.pdf', mime_type: 'application/pdf', download_link: 'https://files.oaiusercontent.com/document' },
  ] }, {
    purposes: ['listing_image', 'digital_file'],
    allowedHosts: new Set(['files.oaiusercontent.com']),
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl,
  });

  expect(files.map(file => [file.id, file.kind, file.mimeType])).toEqual([
    ['image', 'image', 'image/jpeg'],
    ['document', 'file', 'application/pdf'],
  ]);
});
