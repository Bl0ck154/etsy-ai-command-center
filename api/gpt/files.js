import { lookup as dnsLookup } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';

import sharp from 'sharp';

export const DEFAULT_GPT_FILE_HOST = '*.oaiusercontent.com';
export const MAX_GPT_FILES = 10;
export const DEFAULT_GPT_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_GPT_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_GPT_FILE_TIMEOUT_MS = 15_000;
export const DEFAULT_GPT_VIDEO_TIMEOUT_MS = 120_000;
export const DEFAULT_GPT_FILE_REDIRECTS = 2;

const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_NORMALIZED_IMAGE_BYTES = 64 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CHATGPT_SIGNATURE_TRUSTED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const MIME_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/x-heic', 'image/heic'],
  ['image/heic-sequence', 'image/heic'],
  ['image/x-heif', 'image/heif'],
  ['image/heif-sequence', 'image/heif'],
  ['image/x-ms-bmp', 'image/bmp'],
  ['audio/mp3', 'audio/mpeg'],
  ['application/x-zip-compressed', 'application/zip'],
  ['application/x-epub+zip', 'application/epub+zip'],
  ['video/quicktime', 'video/quicktime'],
]);
const EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/bmp', '.bmp'],
  ['application/epub+zip', '.epub'],
  ['application/pdf', '.pdf'],
  ['application/zip', '.zip'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['audio/mpeg', '.mp3'],
]);

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), minimum), maximum) : fallback;
}

export function gptFileError(message, status = 400, code = 'GPT_FILE_INVALID') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

const LOCAL_GPT_FILE_ERROR = 'The external Etsy AI Command Center server cannot access ChatGPT sandbox, local file, or browser blob URLs. Attach the file through top-level openaiFileIdRefs with an HTTPS download_link.';

function safeFileLocation(value) {
  const raw = String(value || '').trim();
  if (!raw) return { scheme: 'missing', hostname: '' };
  if (/^\/mnt\/data(?:\/|$)/i.test(raw)) return { scheme: 'local-path', hostname: '' };
  let parsed;
  try { parsed = new URL(raw); } catch {
    return { scheme: 'invalid', hostname: '' };
  }
  return {
    scheme: String(parsed.protocol || '').replace(/:$/, '').toLowerCase() || 'missing',
    hostname: normalizeGptFileHostname(parsed.hostname),
  };
}

function attachFileDiagnostic(error, { sourceField, fileIndex, value } = {}) {
  if (!error || error.fileDiagnostic) return error;
  const location = safeFileLocation(value);
  error.fileDiagnostic = {
    source_field: sourceField || 'unknown',
    scheme: location.scheme,
    hostname: location.hostname,
    file_index: Number.isInteger(fileIndex) ? fileIndex : null,
  };
  return error;
}

function localGptFileError(context = {}) {
  return attachFileDiagnostic(
    gptFileError(LOCAL_GPT_FILE_ERROR, 400, 'GPT_FILE_LOCAL_SANDBOX_UNREACHABLE'),
    context,
  );
}

function isLocalGptFileLocation(value) {
  const { scheme } = safeFileLocation(value);
  return ['sandbox', 'local-path', 'file', 'blob'].includes(scheme);
}

export function configuredGptFileHosts(raw = process.env.GPT_FILE_ALLOWED_HOSTS || DEFAULT_GPT_FILE_HOST) {
  const entries = String(raw || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!entries.length) throw gptFileError('GPT file host allowlist is empty', 503, 'GPT_FILE_NOT_CONFIGURED');

  const hosts = [];
  for (const entry of entries) {
    const lowered = entry.toLowerCase();
    const wildcard = lowered.startsWith('*.');
    const host = normalizeGptFileHostname(wildcard ? lowered.slice(2) : lowered);
    if (!host
      || host.split('*').length !== 1
      || host.split('/').length !== 1
      || host.split(':').length !== 1
      || net.isIP(host)
      || host.length > 253
      || (wildcard && host.split('.').length < 2)
      || host.split('.').some(label => !label || label.length > 63)) {
      throw gptFileError('GPT file host allowlist must contain exact DNS hostnames or leading *.domain suffixes', 503, 'GPT_FILE_NOT_CONFIGURED');
    }
    let parsed;
    try { parsed = new URL(`https://${host}/`); } catch {
      throw gptFileError('GPT file host allowlist contains an invalid hostname', 503, 'GPT_FILE_NOT_CONFIGURED');
    }
    if (normalizeGptFileHostname(parsed.hostname) !== host || parsed.username || parsed.password || parsed.port) {
      throw gptFileError('GPT file host allowlist contains an invalid hostname', 503, 'GPT_FILE_NOT_CONFIGURED');
    }
    hosts.push(wildcard ? `*.${host}` : host);
  }
  return new Set(hosts);
}

export function normalizeGptFileHostname(value) {
  let hostname = String(value || '').trim().toLowerCase();
  while (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  return hostname;
}

export function isAllowedGptFileHostname(hostname, allowedHosts = configuredGptFileHosts()) {
  const normalized = normalizeGptFileHostname(hostname);
  for (const configuredEntry of allowedHosts) {
    const entry = String(configuredEntry || '').trim().toLowerCase();
    const wildcard = entry.startsWith('*.');
    const base = normalizeGptFileHostname(wildcard ? entry.slice(2) : entry);
    if (!base) continue;
    if (wildcard) {
      if (normalized === base || normalized.endsWith(`.${base}`)) return true;
    } else if (normalized === base) {
      return true;
    }
  }
  return false;
}

function authorityFromRawUrl(raw) {
  const match = /^https:\/\/([^/?#]+)/i.exec(String(raw || ''));
  return match?.[1] || '';
}

export function parseAllowedGptFileUrl(value, {
  allowedHosts = configuredGptFileHosts(),
  sourceField = 'unknown',
  fileIndex = null,
} = {}) {
  const raw = String(value || '').trim();
  const diagnostic = { sourceField, fileIndex, value: raw };
  if (isLocalGptFileLocation(raw)) throw localGptFileError(diagnostic);
  let url;
  try { url = new URL(raw); } catch {
    throw attachFileDiagnostic(gptFileError('GPT file URL must be an absolute HTTPS URL'), diagnostic);
  }
  if (url.protocol !== 'https:') {
    if (sourceField === 'openaiFileIdRefs') throw localGptFileError(diagnostic);
    throw attachFileDiagnostic(gptFileError('GPT file URL must use HTTPS'), diagnostic);
  }
  if (url.username || url.password) throw attachFileDiagnostic(gptFileError('GPT file URL must not contain credentials'), diagnostic);
  if (url.hash) throw attachFileDiagnostic(gptFileError('GPT file URL must not contain a fragment'), diagnostic);
  if (ipLiteralFamily(url.hostname)) throw attachFileDiagnostic(gptFileError('GPT file URL must use an allowlisted DNS hostname'), diagnostic);

  // URL normalizes an explicitly supplied :443 away, so inspect the raw
  // authority as well. Signed query parameters remain untouched.
  if (rawUrlHasExplicitPort(raw)) {
    throw attachFileDiagnostic(gptFileError('GPT file URL must not contain an explicit port'), diagnostic);
  }
  const hostname = normalizeGptFileHostname(url.hostname);
  if (!isAllowedGptFileHostname(hostname, allowedHosts)) {
    throw attachFileDiagnostic(gptFileError('GPT file URL host is not allowlisted'), diagnostic);
  }
  url.hostname = hostname;
  return url;
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8')
    || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
    || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped);
    const hex = mapped.split(':');
    if (hex.length === 2) {
      const high = Number.parseInt(hex[0], 16);
      const low = Number.parseInt(hex[1], 16);
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
    }
    return true;
  }
  return false;
}

export function isPublicIpAddress(address) {
  const family = net.isIP(String(address || ''));
  if (family === 4) return !isPrivateIpv4(String(address));
  if (family === 6) return !isPrivateIpv6(String(address));
  return false;
}

export async function resolvePublicGptFileHost(hostname, { lookupImpl = dnsLookup } = {}) {
  let records;
  try {
    records = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw gptFileError('GPT file host could not be resolved', 502, 'GPT_FILE_DNS_FAILED');
  }
  const normalized = (Array.isArray(records) ? records : [records])
    .map(record => ({ address: String(record?.address || ''), family: Number(record?.family || net.isIP(record?.address)) }))
    .filter(record => record.address && (record.family === 4 || record.family === 6));
  if (!normalized.length || normalized.some(record => !isPublicIpAddress(record.address))) {
    throw gptFileError('GPT file host resolved to a non-public address', 400, 'GPT_FILE_SSRF_BLOCKED');
  }
  return normalized;
}

function requestPinnedHttps(url, addresses, {
  requestImpl = https.request,
  timeoutMs,
  accept,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = requestImpl(url, {
      method: 'GET',
      agent: false,
      headers: {
        Accept: accept,
        'User-Agent': 'etsy-manager-pro-gpt-files/1.0',
      },
      lookup(_hostname, options, callback) {
        if (options?.all) return callback(null, addresses);
        const record = addresses[0];
        return callback(null, record.address, record.family);
      },
    }, response => {
      settled = true;
      resolve({ request, response });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(gptFileError('GPT file download timed out', 504, 'GPT_FILE_TIMEOUT'));
    });
    request.on('error', error => {
      if (settled) return;
      if (error?.code?.startsWith?.('GPT_FILE_')) return reject(error);
      reject(gptFileError('GPT file download failed', 502, 'GPT_FILE_DOWNLOAD_FAILED'));
    });
    request.end();
  });
}

async function readResponseWithLimit(response, maxBytes) {
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw gptFileError('GPT file exceeds the maximum allowed size', 413, 'GPT_FILE_TOO_LARGE');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        response.destroy();
        throw gptFileError('GPT file exceeds the maximum allowed size', 413, 'GPT_FILE_TOO_LARGE');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error?.code?.startsWith?.('GPT_FILE_')) throw error;
    throw gptFileError('GPT file download was interrupted', 502, 'GPT_FILE_DOWNLOAD_FAILED');
  }
  if (!size) throw gptFileError('GPT file is empty', 400, 'GPT_FILE_EMPTY');
  return Buffer.concat(chunks, size);
}

function normalizedMimeType(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  return MIME_ALIASES.get(mime) || mime;
}

function rawUrlHasExplicitPort(raw) {
  const authority = authorityFromRawUrl(raw);
  if (!authority) return false;
  if (authority.startsWith('[')) return authority.lastIndexOf(']:') >= 0;
  return authority.split(':').length > 1;
}

function ipLiteralFamily(hostname) {
  const normalized = normalizeGptFileHostname(hostname);
  const candidate = normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
  return net.isIP(candidate);
}

function isoBmffBrands(buffer) {
  if (buffer.length < 12 || buffer.subarray(4, 8).toString('latin1') !== 'ftyp') return [];
  const declaredSize = buffer.readUInt32BE(0);
  const end = Math.min(buffer.length, declaredSize >= 12 ? declaredSize : 32, 256);
  const brands = [];
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    brands.push(buffer.subarray(offset, offset + 4).toString('latin1').toLowerCase());
  }
  return brands;
}

function looksLikeSvg(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 65_536)).toString('utf8').replace(/^\uFEFF/, '');
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(sample);
}

function looksLikeDocx(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  const sample = buffer.toString('latin1');
  return sample.includes('[Content_Types].xml') && sample.includes('word/');
}

function looksLikeEpub(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  return buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1').includes('application/epub+zip');
}

function looksLikeBmp(buffer) {
  if (buffer.length < 26 || buffer[0] !== 0x42 || buffer[1] !== 0x4d) return false;
  const fileSize = buffer.readUInt32LE(2);
  const pixelOffset = buffer.readUInt32LE(10);
  const dibSize = buffer.readUInt32LE(14);
  return fileSize >= pixelOffset
    && fileSize <= buffer.length
    && dibSize >= 12
    && dibSize <= 124
    && pixelOffset >= 14 + dibSize
    && pixelOffset <= fileSize;
}

function looksLikeMpegAudioFrame(buffer, offset = 0) {
  if (buffer.length < offset + 4 || buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) return false;
  const version = (buffer[offset + 1] >> 3) & 0x03;
  const layer = (buffer[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
  return version !== 0x01 && layer !== 0x00
    && bitrateIndex !== 0x00 && bitrateIndex !== 0x0f
    && sampleRateIndex !== 0x03;
}

function looksLikeMp3(buffer) {
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString('latin1') === 'ID3') {
    if (![2, 3, 4].includes(buffer[3]) || buffer[4] === 0xff
      || !buffer.subarray(6, 10).every(byte => byte < 0x80)) return false;
    const tagSize = (buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9];
    const frameOffset = 10 + tagSize + ((buffer[5] & 0x10) ? 10 : 0);
    return looksLikeMpegAudioFrame(buffer, frameOffset);
  }
  return looksLikeMpegAudioFrame(buffer);
}

export function detectGptFileMimeType(buffer, declaredMimeType = '') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return '';
  const ascii = buffer.subarray(0, 16).toString('latin1');
  let detected = '';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) detected = 'image/jpeg';
  else if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) detected = 'image/png';
  else if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) detected = 'image/gif';
  else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') detected = 'image/webp';
  else if (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
    || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) detected = 'image/tiff';
  else if (looksLikeBmp(buffer)) detected = 'image/bmp';
  else if (ascii.startsWith('8BPS')) detected = 'image/vnd.adobe.photoshop';
  else if (looksLikeSvg(buffer)) detected = 'image/svg+xml';
  else if (ascii.startsWith('%PDF-')) detected = 'application/pdf';
  else if (looksLikeMp3(buffer)) detected = 'audio/mpeg';
  else if (buffer[0] === 0x50 && buffer[1] === 0x4b
    && [[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].some(pair => buffer[2] === pair[0] && buffer[3] === pair[1])) {
    if (looksLikeDocx(buffer)) detected = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (looksLikeEpub(buffer)) detected = 'application/epub+zip';
    else detected = 'application/zip';
  } else if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brands = isoBmffBrands(buffer);
    if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx'].includes(brand))) detected = 'image/heic';
    else if (brands.some(brand => ['avif', 'avis'].includes(brand))) detected = 'image/avif';
    else if (brands.some(brand => ['mif1', 'msf1'].includes(brand))) detected = 'image/heif';
    else detected = brands.some(brand => brand.includes('qt')) ? 'video/quicktime' : 'video/mp4';
  }

  const declared = normalizedMimeType(declaredMimeType);
  if (!detected && (declared === 'text/plain' || declared === 'text/csv')) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    if (!sample.includes(0) && !sample.some(byte => byte < 0x09 || (byte > 0x0d && byte < 0x20))) detected = declared;
  }
  return detected;
}

function mimeKindsMatch(declared, detected) {
  if (!declared || declared === 'application/octet-stream') return true;
  if (declared === detected) return true;
  if (['image/heic', 'image/heif'].includes(declared) && ['image/heic', 'image/heif'].includes(detected)) return true;
  if (declared.startsWith('video/') && detected.startsWith('video/')) return true;
  return false;
}

function isUnspecifiedMimeType(value) {
  return !value || value === 'application/octet-stream';
}

function canTrustSupportedImageSignature(declaredMimeType, responseMimeType, detectedMimeType) {
  if (!CHATGPT_SIGNATURE_TRUSTED_IMAGE_MIMES.has(detectedMimeType)) return false;
  return [declaredMimeType, responseMimeType].every(value => (
    isUnspecifiedMimeType(value) || CHATGPT_SIGNATURE_TRUSTED_IMAGE_MIMES.has(value)
  ));
}

function safeFilename(value, fallback = 'chatgpt-file') {
  const base = path.basename(String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, ''));
  const cleaned = base.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

function filenameForMime(filename, mimeType) {
  const extension = EXTENSIONS.get(mimeType) || '';
  return extension ? `${path.parse(filename).name.slice(0, 100) || 'chatgpt-file'}${extension}` : filename;
}

function assertSafeSvg(buffer) {
  const text = buffer.toString('utf8');
  const forbiddenMarkup = /<!DOCTYPE|<!ENTITY|<script(?:\s|>)|<foreignObject(?:\s|>)|<iframe(?:\s|>)|<object(?:\s|>)|<embed(?:\s|>)|<image(?:\s|>)|<use(?:\s|>)|<\?xml-stylesheet/i;
  const externalCss = /@import|url\(\s*(['"]?)(?!#)/i;
  const externalAttribute = /\b(?:href|src)\s*=\s*(['"])(?!#)[\s\S]*?\1/i;
  if (forbiddenMarkup.test(text) || externalCss.test(text) || externalAttribute.test(text)) {
    throw gptFileError('GPT SVG contains external, active, or unsupported content', 415, 'GPT_FILE_UNSUPPORTED');
  }
}

function ffmpegExecutable() {
  return String(process.env.GPT_HEIC_FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
}

async function convertHeifWithFfmpeg(buffer, { spawnImpl = spawn } = {}) {
  const timeoutMs = boundedNumber(process.env.GPT_HEIC_CONVERT_TIMEOUT_MS, 15_000, 1_000, 60_000);
  return new Promise((resolve, reject) => {
      const child = spawnImpl(ffmpegExecutable(), [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
        '-protocol_whitelist', 'cache,pipe', '-i', 'cache:pipe:0', '-map', '0:v:0', '-frames:v', '1',
        '-threads', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
      ], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        },
      });
      const output = [];
      const errors = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(gptFileError('GPT HEIC conversion timed out', 504, 'GPT_FILE_TIMEOUT'));
      }, timeoutMs);
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_NORMALIZED_IMAGE_BYTES) {
          child.kill('SIGKILL');
          finish(gptFileError('GPT HEIC converted image exceeds the safe size limit', 413, 'GPT_FILE_TOO_LARGE'));
          return;
        }
        output.push(Buffer.from(chunk));
      });
      child.stderr.on('data', chunk => {
        if (errors.reduce((size, item) => size + item.length, 0) < 8192) errors.push(Buffer.from(chunk));
      });
      child.on('error', () => finish(gptFileError('HEIC conversion is unavailable on this server', 503, 'GPT_HEIC_CONVERTER_UNAVAILABLE')));
      child.on('close', code => {
        if (settled) return;
        if (code !== 0 || !outputBytes) {
          const detail = Buffer.concat(errors).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 180);
          finish(gptFileError(`GPT HEIC payload cannot be converted${detail ? `: ${detail}` : ''}`, 415, 'GPT_FILE_UNSUPPORTED'));
          return;
        }
        finish(null, Buffer.concat(output, outputBytes));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(buffer);
  });
}

async function encodeNormalizedImage(pipeline) {
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw gptFileError('GPT image dimensions exceed the safe pixel limit', 413, 'GPT_FILE_TOO_LARGE');
  }
  if (metadata.hasAlpha) {
    const output = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    return { buffer: output, mimeType: 'image/png' };
  }
  const output = await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  return { buffer: output, mimeType: 'image/jpeg' };
}

async function normalizeImage(buffer, sourceMimeType, { sharpImpl = sharp, spawnImpl = spawn } = {}) {
  try {
    if (sourceMimeType === 'image/svg+xml') assertSafeSvg(buffer);
    const pipeline = sharpImpl(buffer, { animated: false, failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
    return await encodeNormalizedImage(pipeline);
  } catch (error) {
    if (error?.code?.startsWith?.('GPT_FILE_')) throw error;
    if (sourceMimeType === 'image/heic' || sourceMimeType === 'image/heif') {
      try {
        // A standard Sharp build may not include HEVC. Do not ask it to decode
        // the same unsupported source again: bound FFmpeg first, then enforce
        // dimensions/pixels on the converted PNG through Sharp.
        const converted = await convertHeifWithFfmpeg(buffer, { spawnImpl });
        return await encodeNormalizedImage(sharpImpl(converted, { animated: false, failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).rotate());
      } catch (fallbackError) {
        if (fallbackError?.code?.startsWith?.('GPT_')) throw fallbackError;
      }
    }
    throw gptFileError(`GPT image payload is invalid or cannot be converted from ${sourceMimeType}`, 415, 'GPT_FILE_UNSUPPORTED');
  }
}

export function normalizeGptFileReferences(input = {}) {
  const hasRefs = Object.prototype.hasOwnProperty.call(input || {}, 'openaiFileIdRefs');
  if (hasRefs && !Array.isArray(input.openaiFileIdRefs)) {
    throw attachFileDiagnostic(
      gptFileError('openaiFileIdRefs must be an array', 400, 'GPT_FILE_REFS_MALFORMED'),
      { sourceField: 'openaiFileIdRefs', fileIndex: null, value: '' },
    );
  }
  const refs = hasRefs ? input.openaiFileIdRefs : [];
  if (hasRefs && refs.length === 0) {
    throw attachFileDiagnostic(
      gptFileError('openaiFileIdRefs must contain at least one file', 400, 'GPT_FILE_REFS_EMPTY'),
      { sourceField: 'openaiFileIdRefs', fileIndex: null, value: '' },
    );
  }
  const sourceValues = input.source_urls !== undefined
    ? input.source_urls
    : input.source_url !== undefined ? [input.source_url] : [];
  const sources = Array.isArray(sourceValues) ? sourceValues : [sourceValues];
  if (refs.length && sources.filter(Boolean).length) {
    throw gptFileError('Provide openaiFileIdRefs or source_url fallback, not both');
  }

  const values = refs.length ? refs : sources.filter(Boolean);
  if (!values.length) throw gptFileError('No ChatGPT file input was provided', 400, 'GPT_FILE_INPUT_MISSING');
  if (values.length > MAX_GPT_FILES) throw gptFileError(`At most ${MAX_GPT_FILES} files are allowed`, 400, 'GPT_FILE_COUNT_EXCEEDED');

  const sourceField = refs.length ? 'openaiFileIdRefs' : input.source_urls !== undefined ? 'source_urls' : 'source_url';
  return values.map((value, index) => {
    if (refs.length) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw attachFileDiagnostic(gptFileError('openaiFileIdRefs entries must be ChatGPT runtime file-reference objects', 400, 'GPT_FILE_REFS_MALFORMED'), {
          sourceField, fileIndex: index, value: '',
        });
      }
      if (!value.download_link) {
        throw attachFileDiagnostic(gptFileError('openaiFileIdRefs runtime entry is missing download_link', 400, 'GPT_FILE_REFS_MALFORMED'), {
          sourceField, fileIndex: index, value: '',
        });
      }
      return {
        index,
        sourceField,
        id: String(value.id || ''),
        name: safeFilename(value.name, `chatgpt-file-${index + 1}`),
        declaredMimeType: normalizedMimeType(value.mime_type),
        url: String(value.download_link),
        rank: value.rank,
        altText: value.alt_text ?? value.altText,
      };
    }
    const source = typeof value === 'string' ? { source_url: value } : value;
    if (!source || typeof source !== 'object' || Array.isArray(source) || !source.source_url) {
      throw attachFileDiagnostic(gptFileError('source_url fallback must be a URL string or source object'), {
        sourceField, fileIndex: index, value: source?.source_url,
      });
    }
    return {
      index,
      sourceField,
      id: '',
      name: safeFilename(source.name, `source-file-${index + 1}`),
      declaredMimeType: normalizedMimeType(source.mime_type),
      url: String(source.source_url),
      rank: source.rank,
      altText: source.alt_text ?? source.altText,
    };
  });
}

export async function downloadGptFile(reference, {
  allowedHosts = configuredGptFileHosts(),
  lookupImpl = dnsLookup,
  requestImpl = https.request,
  timeoutMs = boundedNumber(process.env.GPT_FILE_TIMEOUT_MS, DEFAULT_GPT_FILE_TIMEOUT_MS, 1_000, 60_000),
  maxBytes = boundedNumber(process.env.GPT_FILE_MAX_BYTES, DEFAULT_GPT_FILE_MAX_BYTES, 1_024, 50 * 1024 * 1024),
  redirectLimit = boundedNumber(process.env.GPT_FILE_REDIRECT_LIMIT, DEFAULT_GPT_FILE_REDIRECTS, 0, 5),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = parseAllowedGptFileUrl(reference.url, {
    allowedHosts,
    sourceField: reference.sourceField,
    fileIndex: reference.index,
  });

  for (let redirects = 0; ; redirects += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw gptFileError('GPT file download timed out', 504, 'GPT_FILE_TIMEOUT');
    const addresses = await resolvePublicGptFileHost(current.hostname, { lookupImpl });
    const { response } = await requestPinnedHttps(current, addresses, {
      requestImpl,
      timeoutMs: remaining,
      accept: reference.declaredMimeType || '*/*',
    });

    if (REDIRECT_STATUSES.has(response.statusCode)) {
      const location = response.headers.location;
      response.resume();
      if (!location || redirects >= redirectLimit) {
        throw gptFileError('GPT file redirect limit exceeded', 502, 'GPT_FILE_REDIRECT_BLOCKED');
      }
      current = parseAllowedGptFileUrl(new URL(location, current).toString(), {
        allowedHosts,
        sourceField: reference.sourceField,
        fileIndex: reference.index,
      });
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw gptFileError(`GPT file download returned HTTP ${response.statusCode}`, 502, 'GPT_FILE_DOWNLOAD_FAILED');
    }

    const buffer = await readResponseWithLimit(response, maxBytes);
    const responseMime = normalizedMimeType(response.headers['content-type']);
    const declaredMimeType = reference.declaredMimeType || responseMime;
    const detectedMimeType = detectGptFileMimeType(buffer, declaredMimeType);
    const declaredMatches = mimeKindsMatch(declaredMimeType, detectedMimeType);
    const responseMatches = mimeKindsMatch(responseMime, detectedMimeType);
    const hasMimeMismatch = Boolean(detectedMimeType) && (!declaredMatches || !responseMatches);
    const acceptedImageMismatch = hasMimeMismatch
      && canTrustSupportedImageSignature(declaredMimeType, responseMime, detectedMimeType);
    if (!detectedMimeType || (hasMimeMismatch && !acceptedImageMismatch)) {
      throw gptFileError('GPT file MIME type does not match its payload signature', 415, 'GPT_FILE_UNSUPPORTED');
    }
    return {
      buffer,
      mimeType: detectedMimeType,
      ...(acceptedImageMismatch ? {
        mimeWarning: {
          warning_code: 'GPT_FILE_IMAGE_MIME_MISMATCH_ACCEPTED',
          source_field: reference.sourceField || 'unknown',
          file_index: Number.isInteger(reference.index) ? reference.index : null,
          declared_mime: declaredMimeType || '',
          response_mime: responseMime || '',
          detected_mime: detectedMimeType,
        },
      } : {}),
    };
  }
}

export function gptDownloadMaxBytesForPurpose(purpose, env = process.env) {
  if (purpose === 'listing_video') {
    return boundedNumber(env.GPT_VIDEO_MAX_BYTES, DEFAULT_GPT_VIDEO_MAX_BYTES, 1_024, DEFAULT_GPT_VIDEO_MAX_BYTES);
  }
  return boundedNumber(env.GPT_FILE_MAX_BYTES, DEFAULT_GPT_FILE_MAX_BYTES, 1_024, 50 * 1024 * 1024);
}

export function gptDownloadTimeoutMsForPurpose(purpose, env = process.env) {
  if (purpose === 'listing_video') {
    return boundedNumber(env.GPT_VIDEO_DOWNLOAD_TIMEOUT_MS, DEFAULT_GPT_VIDEO_TIMEOUT_MS, 30_000, 240_000);
  }
  return boundedNumber(env.GPT_FILE_TIMEOUT_MS, DEFAULT_GPT_FILE_TIMEOUT_MS, 1_000, 60_000);
}

export async function prepareGptFiles(input, options = {}) {
  const references = normalizeGptFileReferences(input);
  const prepared = [];
  const { purpose = '', purposes = [], sharpImpl = sharp, spawnImpl = spawn, ...downloadOptions } = options;
  const digitalMimeTypes = new Set([
    'image/bmp', 'image/gif', 'image/jpeg', 'image/png',
    'video/quicktime', 'audio/mpeg', 'application/pdf', 'text/plain',
    'application/zip', 'application/epub+zip',
  ]);

  // Sequential preparation bounds memory and preserves the exact user-supplied
  // order. ChatGPT download links remain valid for five minutes.
  for (const [index, reference] of references.entries()) {
    const filePurpose = purposes[index] || purpose;
    const effectiveDownloadOptions = {
      ...downloadOptions,
      ...(downloadOptions.maxBytes === undefined
        ? { maxBytes: gptDownloadMaxBytesForPurpose(filePurpose) }
        : {}),
      ...(downloadOptions.timeoutMs === undefined
        ? { timeoutMs: gptDownloadTimeoutMsForPurpose(filePurpose) }
        : {}),
    };
    try {
      const downloaded = await downloadGptFile(reference, effectiveDownloadOptions);
      let { buffer, mimeType } = downloaded;
      if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || mimeType === 'image/vnd.adobe.photoshop') {
        throw gptFileError(`GPT file format ${mimeType} is not supported by Etsy listings`, 415, 'GPT_FILE_UNSUPPORTED');
      }
      if (filePurpose === 'digital_file' && !digitalMimeTypes.has(mimeType)) {
        throw gptFileError(`GPT file format ${mimeType} is not supported for Etsy digital downloads`, 415, 'GPT_FILE_UNSUPPORTED');
      }
      if (mimeType.startsWith('image/') && filePurpose !== 'digital_file') {
        const normalized = await normalizeImage(buffer, mimeType, { sharpImpl, spawnImpl });
        buffer = normalized.buffer;
        mimeType = normalized.mimeType;
      }
      prepared.push({
        index: reference.index,
        id: reference.id || null,
        name: filenameForMime(reference.name, mimeType),
        mimeType,
        kind: mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : 'file',
        size: buffer.length,
        buffer,
        ...(downloaded.mimeWarning ? { mimeWarning: downloaded.mimeWarning } : {}),
        ...(reference.rank !== undefined ? { rank: reference.rank } : {}),
        ...(reference.altText !== undefined ? { altText: String(reference.altText) } : {}),
      });
    } catch (error) {
      throw attachFileDiagnostic(error, {
        sourceField: reference.sourceField,
        fileIndex: reference.index,
        value: reference.url,
      });
    }
  }
  return prepared;
}
