import { MODEL } from '../_config.js';
import { kvGet } from '../kv.js';

export const MEDIA_MODELS = Object.freeze({
  'nano-banana-2': MODEL.geminiImage,
  'nano-banana': MODEL.geminiImage,
});
export const DEFAULT_MEDIA_MODEL = 'nano-banana-2';
const MAX_KEY_INDEX = 10;

let roundRobinIndex = 0;

export async function getGeminiMediaApiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  for (let index = 2; index <= MAX_KEY_INDEX; index += 1) {
    const key = process.env[`GEMINI_API_KEY_${index}`];
    if (key) keys.push(key);
  }
  try {
    const extras = await kvGet('gemini_extra_keys');
    if (Array.isArray(extras)) {
      for (const key of extras) {
        if (key && !keys.includes(key)) keys.push(key);
      }
    }
  } catch {}

  if (!keys.length) return keys;
  const rotation = roundRobinIndex % keys.length;
  const rotated = [...keys.slice(rotation), ...keys.slice(0, rotation)];
  roundRobinIndex = (roundRobinIndex + 1) % keys.length;
  return rotated;
}

function assignKeyBatches(keys, numImages) {
  const batches = {};
  for (let index = 0; index < numImages; index += 1) {
    const key = keys[index % keys.length];
    batches[key] = (batches[key] || 0) + 1;
  }
  return batches;
}

async function runParallelGeneration(batches, modelId, prompt, aspectRatio, referenceImage, signal) {
  const results = await Promise.allSettled(
    Object.entries(batches).map(([key, count]) => (
      generateViaContent(key, modelId, prompt, aspectRatio, count, referenceImage, signal)
    )),
  );
  const images = [];
  let lastError = null;
  for (const result of results) {
    if (result.status === 'fulfilled') images.push(...result.value);
    else lastError = result.reason?.message;
  }
  return { images, lastError, keysUsed: Object.keys(batches).length };
}

async function runParallelPromptGeneration(keys, modelId, prompts, aspectRatio, referenceImage, signal) {
  const jobs = prompts.map((prompt, index) => (
    generateViaContent(keys[index % keys.length], modelId, prompt, aspectRatio, 1, referenceImage, signal)
  ));
  const results = await Promise.allSettled(jobs);
  const images = [];
  let lastError = null;
  for (const result of results) {
    if (result.status === 'fulfilled') images.push(...result.value);
    else lastError = result.reason?.message;
  }
  return { images, lastError, keysUsed: Math.min(keys.length, prompts.length) };
}

export async function generateGeminiMediaImages({
  prompt,
  promptList,
  model,
  numImages,
  aspectRatio,
  referenceImage,
  signal,
  warningPrefix = '',
}) {
  const keys = await getGeminiMediaApiKeys();
  if (!keys.length) {
    const error = new Error('GEMINI_API_KEY not configured in runtime environment');
    error.status = 500;
    throw error;
  }

  const modelId = MEDIA_MODELS[model] || MEDIA_MODELS[DEFAULT_MEDIA_MODEL];
  const batches = assignKeyBatches(keys, numImages);
  const { images, lastError, keysUsed } = promptList.length
    ? await runParallelPromptGeneration(keys, modelId, promptList, aspectRatio, referenceImage, signal)
    : await runParallelGeneration(batches, modelId, prompt, aspectRatio, referenceImage, signal);
  if (!images.length) throw new Error(lastError || 'No images returned. Check prompt - avoid restricted content.');

  const shortage = images.length < numImages
    ? `Only ${images.length} of ${numImages} requested images returned.${lastError ? ` Last error: ${lastError}` : ''}`
    : '';
  const warning = [warningPrefix, shortage].filter(Boolean).join(' ');
  const enrichedImages = images.map(image => ({ ...image, provider: 'gemini', model: modelId }));
  return {
    success: true,
    images: enrichedImages,
    model: modelId,
    provider: 'gemini',
    keys_used: keysUsed,
    ...(warning ? { warning } : {}),
  };
}

export async function analyzeGeminiImage({ referenceImage, prompt = '', fetchImpl = fetch } = {}) {
  if (!referenceImage?.base64 || !referenceImage?.mimeType) {
    const error = new Error('referenceImage (base64 + mimeType) required');
    error.status = 400;
    throw error;
  }
  const keys = await getGeminiMediaApiKeys();
  if (!keys.length) {
    const error = new Error('GEMINI_API_KEY not configured');
    error.status = 500;
    throw error;
  }
  const userPrompt = String(prompt || '').trim()
    || 'Describe this image in detail. What product is shown? What style, materials, colors? How could it be used on Etsy?';
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL.gemini}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[0] },
      body: JSON.stringify({
        contents: [{ parts: [
          { inlineData: { mimeType: referenceImage.mimeType, data: referenceImage.base64 } },
          { text: userPrompt },
        ] }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Gemini ${response.status}`);
  const text = data.candidates?.[0]?.content?.parts?.find(part => part.text)?.text;
  if (!text) throw new Error('No analysis returned');
  return text;
}

export async function generateViaContent(apiKey, modelId, prompt, aspectRatio, count, referenceImage, signal, fetchImpl = fetch) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent`;
  const fullPrompt = `${prompt} AR ${aspectRatio}`;
  const parts = [];
  if (referenceImage?.base64 && referenceImage?.mimeType) {
    parts.push({ inlineData: { mimeType: referenceImage.mimeType, data: referenceImage.base64 } });
  }
  parts.push({ text: fullPrompt });

  async function generateOne() {
    const retryDelays = [0, 2000, 15000];
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      if (signal?.aborted) return { ok: false, status: 504, data: { error: { message: 'Timed out' } } };
      if (retryDelays[attempt]) await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 100_000);
      const abortFromJob = () => controller.abort();
      signal?.addEventListener?.('abort', abortFromJob, { once: true });
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              responseModalities: ['IMAGE', 'TEXT'],
              thinkingConfig: { thinkingLevel: 'MINIMAL' },
              imageConfig: { imageSize: '1K' },
            },
          }),
        });
        clearTimeout(timeout);
        const raw = await response.json();
        const data = Array.isArray(raw)
          ? { candidates: raw.flatMap(chunk => chunk.candidates || []), error: raw[0]?.error }
          : raw;
        const message = String(data.error?.message || '').toLowerCase();
        const retryable = !response.ok && (
          response.status === 503
          || response.status === 429
          || message.includes('overloaded')
          || message.includes('high demand')
          || message.includes('quota')
        );
        if (!retryable) return { ok: response.ok, status: response.status, data };
      } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
          return { ok: false, status: 504, data: { error: { message: 'Timed out (>100s)' } } };
        }
        throw error;
      } finally {
        signal?.removeEventListener?.('abort', abortFromJob);
      }
    }
    return {
      ok: false,
      status: 429,
      data: { error: { message: 'Rate limit — too many requests. Try again in a moment.' } },
    };
  }

  const results = await Promise.allSettled(Array.from({ length: count }, generateOne));
  const images = [];
  let lastError = null;
  for (const result of results) {
    if (result.status === 'rejected') {
      lastError = result.reason?.message;
      continue;
    }
    const { ok, status, data } = result.value;
    if (!ok) {
      lastError = status === 429
        ? (data.error?.message || 'Rate limit hit on Gemini API.')
        : (data.error?.message || `HTTP ${status}`);
      continue;
    }
    for (const candidate of data.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          images.push({ base64: part.inlineData.data, mimeType: part.inlineData.mimeType });
        }
      }
    }
  }
  if (!images.length && lastError) throw new Error(lastError);
  return images;
}
