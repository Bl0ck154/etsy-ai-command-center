import { test, expect } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import {
  DEFAULT_GPT_FILE_MAX_BYTES,
  DEFAULT_GPT_FILE_TIMEOUT_MS,
  DEFAULT_GPT_VIDEO_MAX_BYTES,
  DEFAULT_GPT_VIDEO_TIMEOUT_MS,
  detectGptFileMimeType,
  downloadGptFile,
  gptDownloadMaxBytesForPurpose,
  gptDownloadTimeoutMsForPurpose,
  prepareGptFiles,
} from '../api/gpt/files.js';

const publicDownloadOptions = {
  allowedHosts: new Set(['files.oaiusercontent.com']),
  lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
};

function requestReturning(buffer, contentType) {
  return (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = error => request.emit('error', error);
    request.end = () => {
      const response = Readable.from([buffer]);
      response.statusCode = 200;
      response.headers = { 'content-type': contentType, 'content-length': String(buffer.length) };
      response.resume = () => {};
      callback(response);
    };
    return request;
  };
}

function reference(mimeType, name = 'asset') {
  return {
    openaiFileIdRefs: [{
      id: 'file-format-test',
      name,
      mime_type: mimeType,
      download_link: 'https://files.oaiusercontent.com/asset',
    }],
  };
}

test('ISO BMFF brands distinguish HEIC/HEIF and AVIF images from MP4 video', () => {
  const box = brands => {
    const payload = Buffer.from(brands.join(''), 'latin1');
    const buffer = Buffer.alloc(8 + payload.length);
    buffer.writeUInt32BE(buffer.length, 0);
    buffer.write('ftyp', 4, 'latin1');
    payload.copy(buffer, 8);
    return buffer;
  };

  expect(detectGptFileMimeType(box(['mif1', '\0\0\0\0', 'mif1', 'heic']))).toBe('image/heic');
  expect(detectGptFileMimeType(box(['mif1', '\0\0\0\0', 'mif1']))).toBe('image/heif');
  expect(detectGptFileMimeType(box(['avif', '\0\0\0\0', 'avif']))).toBe('image/avif');
  expect(detectGptFileMimeType(box(['isom', '\0\0\0\0', 'mp42']))).toBe('video/mp4');
});

test('supported image signatures override mismatched supported ChatGPT image MIME labels', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  const heic = Buffer.alloc(24);
  heic.writeUInt32BE(24, 0);
  heic.write('ftyp', 4, 'latin1');
  heic.write('heic', 8, 'latin1');
  heic.writeUInt32BE(0, 12);
  heic.write('mif1', 16, 'latin1');
  heic.write('heic', 20, 'latin1');

  for (const [buffer, declaredMimeType, responseMimeType, detectedMimeType] of [
    [jpeg, 'image/png', 'image/webp', 'image/jpeg'],
    [png, 'image/webp', 'image/jpeg', 'image/png'],
    [webp, 'image/jpeg', 'image/png', 'image/webp'],
    [heic, 'image/png', 'image/webp', 'image/heic'],
  ]) {
    const downloaded = await downloadGptFile({
      url: 'https://files.oaiusercontent.com/asset',
      sourceField: 'openaiFileIdRefs',
      index: 0,
      declaredMimeType,
    }, {
      ...publicDownloadOptions,
      requestImpl: requestReturning(buffer, responseMimeType),
    });
    expect(downloaded.mimeType).toBe(detectedMimeType);
    expect(downloaded.mimeWarning).toEqual({
      warning_code: 'GPT_FILE_IMAGE_MIME_MISMATCH_ACCEPTED',
      source_field: 'openaiFileIdRefs',
      file_index: 0,
      declared_mime: declaredMimeType,
      response_mime: responseMimeType,
      detected_mime: detectedMimeType,
    });
  }
});

test('signature validation still rejects non-images and unsupported image mismatches', async () => {
  for (const [buffer, responseMimeType] of [
    [Buffer.from('%PDF-1.4\n'), 'image/webp'],
    [Buffer.from('GIF89a-image-payload'), 'image/png'],
    [Buffer.from('not-an-image'), 'image/jpeg'],
  ]) {
    await expect(downloadGptFile({
      url: 'https://files.oaiusercontent.com/asset',
      sourceField: 'openaiFileIdRefs',
      index: 0,
      declaredMimeType: 'image/png',
    }, {
      ...publicDownloadOptions,
      requestImpl: requestReturning(buffer, responseMimeType),
    })).rejects.toMatchObject({ code: 'GPT_FILE_UNSUPPORTED', status: 415 });
  }
});

test('BMP and MP3 signatures are accepted for digital files and mismatches are rejected', async () => {
  const bmp = Buffer.alloc(58);
  bmp.write('BM', 0, 'latin1');
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(1, 18);
  bmp.writeInt32LE(1, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  expect(detectGptFileMimeType(bmp)).toBe('image/bmp');
  const preparedBmp = await prepareGptFiles(reference('image/x-ms-bmp', 'bitmap.bin'), {
    ...publicDownloadOptions,
    purpose: 'digital_file',
    requestImpl: requestReturning(bmp, 'image/bmp'),
  });
  expect(preparedBmp[0]).toMatchObject({ kind: 'image', mimeType: 'image/bmp', name: 'bitmap.bmp' });

  const mp3 = Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04]),
    Buffer.from('test'),
    Buffer.from([0xff, 0xfb, 0x90, 0x64]),
  ]);
  expect(detectGptFileMimeType(mp3)).toBe('audio/mpeg');
  expect(detectGptFileMimeType(Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toBe('audio/mpeg');
  const preparedMp3 = await prepareGptFiles(reference('audio/mp3', 'sound.bin'), {
    ...publicDownloadOptions,
    purpose: 'digital_file',
    requestImpl: requestReturning(mp3, 'audio/mpeg'),
  });
  expect(preparedMp3[0]).toMatchObject({ kind: 'file', mimeType: 'audio/mpeg', name: 'sound.mp3' });

  for (const [mimeType, invalid] of [
    ['image/bmp', Buffer.from('BM-not-a-valid-bitmap')],
    ['audio/mpeg', Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x74, 0x65, 0x73, 0x74])],
    ['audio/mpeg', Buffer.from([0xff, 0xe0, 0x00, 0x00])],
  ]) {
    expect(detectGptFileMimeType(invalid, mimeType)).toBe('');
    await expect(prepareGptFiles(reference(mimeType, 'invalid.bin'), {
      ...publicDownloadOptions,
      purpose: 'digital_file',
      requestImpl: requestReturning(invalid, mimeType),
    })).rejects.toMatchObject({ code: 'GPT_FILE_UNSUPPORTED', status: 415 });
  }
});

test('listing-video downloads use the uploader-aligned 100 MiB bound', () => {
  expect(DEFAULT_GPT_VIDEO_MAX_BYTES).toBe(100 * 1024 * 1024);
  expect(gptDownloadMaxBytesForPurpose('listing_video', {})).toBe(DEFAULT_GPT_VIDEO_MAX_BYTES);
  expect(gptDownloadMaxBytesForPurpose('digital_file', {})).toBe(DEFAULT_GPT_FILE_MAX_BYTES);
  expect(gptDownloadMaxBytesForPurpose('listing_video', { GPT_VIDEO_MAX_BYTES: String(200 * 1024 * 1024) }))
    .toBe(DEFAULT_GPT_VIDEO_MAX_BYTES);
});

test('listing-video downloads have a separate bounded timeout below the temporary-link lifetime', () => {
  expect(gptDownloadTimeoutMsForPurpose('listing_video', {})).toBe(DEFAULT_GPT_VIDEO_TIMEOUT_MS);
  expect(gptDownloadTimeoutMsForPurpose('digital_file', {})).toBe(DEFAULT_GPT_FILE_TIMEOUT_MS);
  expect(gptDownloadTimeoutMsForPurpose('listing_video', { GPT_VIDEO_DOWNLOAD_TIMEOUT_MS: '1000' })).toBe(30_000);
  expect(gptDownloadTimeoutMsForPurpose('listing_video', { GPT_VIDEO_DOWNLOAD_TIMEOUT_MS: '900000' })).toBe(240_000);
});

test('safe SVG is rasterized while active or externally-referenced SVG is rejected', async () => {
  const safeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12" fill="#f00"/></svg>');
  const prepared = await prepareGptFiles(reference('image/svg+xml', 'safe.svg'), {
    ...publicDownloadOptions,
    requestImpl: requestReturning(safeSvg, 'image/svg+xml'),
  });
  expect(prepared).toHaveLength(1);
  expect(prepared[0]).toMatchObject({ kind: 'image', mimeType: 'image/png', name: 'safe.png' });

  const unsafeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://internal.example/secret.png"/></svg>');
  await expect(prepareGptFiles(reference('image/svg+xml', 'unsafe.svg'), {
    ...publicDownloadOptions,
    requestImpl: requestReturning(unsafeSvg, 'image/svg+xml'),
  })).rejects.toMatchObject({ code: 'GPT_FILE_UNSUPPORTED', status: 415 });
});

test('DOCX and PSD signatures are not mislabeled as Etsy ZIP or listing-image uploads', async () => {
  const docx = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('[Content_Types].xml\0word/document.xml', 'latin1'),
  ]);
  expect(detectGptFileMimeType(docx)).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await expect(prepareGptFiles(reference('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document.docx'), {
    ...publicDownloadOptions,
    requestImpl: requestReturning(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  })).rejects.toMatchObject({ code: 'GPT_FILE_UNSUPPORTED', status: 415 });

  const psd = Buffer.concat([Buffer.from('8BPS', 'latin1'), Buffer.alloc(32)]);
  expect(detectGptFileMimeType(psd)).toBe('image/vnd.adobe.photoshop');
  await expect(prepareGptFiles(reference('image/vnd.adobe.photoshop', 'design.psd'), {
    ...publicDownloadOptions,
    requestImpl: requestReturning(psd, 'image/vnd.adobe.photoshop'),
  })).rejects.toMatchObject({ code: 'GPT_FILE_UNSUPPORTED', status: 415 });
});

test('EPUB is distinguished from a generic ZIP and keeps its Etsy-supported extension', async () => {
  const epub = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('mimetypeapplication/epub+zip\0META-INF/container.xml', 'latin1'),
  ]);
  expect(detectGptFileMimeType(epub)).toBe('application/epub+zip');
  const prepared = await prepareGptFiles(reference('application/epub+zip', 'book.epub'), {
    ...publicDownloadOptions,
    requestImpl: requestReturning(epub, 'application/epub+zip'),
  });
  expect(prepared[0]).toMatchObject({ kind: 'file', mimeType: 'application/epub+zip', name: 'book.epub' });
});

test('digital image files preserve their original bytes instead of being normalized as listing images', async () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('digital-download-payload'),
  ]);
  const prepared = await prepareGptFiles(reference('image/png', 'printable.png'), {
    ...publicDownloadOptions,
    purpose: 'digital_file',
    requestImpl: requestReturning(png, 'image/png'),
  });
  expect(prepared[0]).toMatchObject({ mimeType: 'image/png', name: 'printable.png' });
  expect(prepared[0].buffer.equals(png)).toBe(true);
});

test('real HEIC fixture converts through the bounded fallback when explicitly provided', async () => {
  test.skip(!process.env.GPT_HEIC_TEST_FIXTURE, 'Set GPT_HEIC_TEST_FIXTURE to a trusted HEIC fixture path.');
  const heic = await readFile(process.env.GPT_HEIC_TEST_FIXTURE);
  expect(detectGptFileMimeType(heic)).toBe('image/heic');
  const prepared = await prepareGptFiles(reference('image/heic', 'iphone.heic'), {
    ...publicDownloadOptions,
    requestImpl: requestReturning(heic, 'image/heic'),
  });
  expect(prepared[0].kind).toBe('image');
  expect(['image/jpeg', 'image/png']).toContain(prepared[0].mimeType);
  expect(prepared[0].name).toMatch(/\.(?:jpg|png)$/);
});

test('HEIC uses bounded FFmpeg immediately after Sharp lacks source HEIC support', async () => {
  const heic = Buffer.alloc(24);
  heic.writeUInt32BE(24, 0);
  heic.write('ftyp', 4, 'latin1');
  heic.write('heic', 8, 'latin1');
  heic.writeUInt32BE(0, 12);
  heic.write('mif1', 16, 'latin1');
  heic.write('heic', 20, 'latin1');
  const convertedPng = Buffer.from('ffmpeg-converted-png');
  const sharpInputs = [];
  const sharpImpl = input => {
    sharpInputs.push(input);
    const isOriginal = input.equals(heic);
    const pipeline = {
      rotate: () => pipeline,
      metadata: async () => {
        if (isOriginal) throw new Error('unsupported image format');
        return { width: 2, height: 3, hasAlpha: true };
      },
      png: () => pipeline,
      jpeg: () => pipeline,
      toBuffer: async () => convertedPng,
    };
    return pipeline;
  };
  let ffmpegCalls = 0;
  let ffmpegInput;
  const spawnImpl = () => {
    ffmpegCalls += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => {};
    child.stdin.end = input => {
      ffmpegInput = input;
      queueMicrotask(() => {
        child.stdout.emit('data', convertedPng);
        child.emit('close', 0);
      });
    };
    return child;
  };

  const prepared = await prepareGptFiles(reference('image/heic', 'iphone.heic'), {
    ...publicDownloadOptions,
    requestImpl: requestReturning(heic, 'image/heic'),
    sharpImpl,
    spawnImpl,
  });

  expect(ffmpegCalls).toBe(1);
  expect(ffmpegInput.equals(heic)).toBe(true);
  expect(sharpInputs).toHaveLength(2);
  expect(sharpInputs[0].equals(heic)).toBe(true);
  expect(sharpInputs[1].equals(convertedPng)).toBe(true);
  expect(prepared[0]).toMatchObject({ kind: 'image', mimeType: 'image/png', name: 'iphone.png' });
});
