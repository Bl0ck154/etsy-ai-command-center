import { MODEL } from '../_config.js';
import {
  generateImagesWithExternalAi,
  getExternalAiConfigAsync,
  hasExternalAiConfigAsync,
  hasExternalImageConfigAsync,
} from '../_external-ai.js';
import {
  DEFAULT_MEDIA_MODEL,
  MEDIA_MODELS,
  generateGeminiMediaImages,
} from './gemini-provider.js';

export async function listMediaModels() {
  const models = Object.entries(MEDIA_MODELS).map(([key, id]) => ({ key, id, provider: 'gemini' }));
  if (await hasExternalImageConfigAsync()) {
    models.push({ key: 'external', id: MODEL.externalImage, provider: 'external' });
  }
  return models;
}

export async function generateMediaImages({
  prompt,
  prompts,
  model = DEFAULT_MEDIA_MODEL,
  provider: requestedProvider,
  count = 1,
  aspectRatio = '1:1',
  referenceImage,
  signal,
} = {}) {
  const hasExternal = await hasExternalAiConfigAsync();
  const hasExternalImage = await hasExternalImageConfigAsync();
  const provider = requestedProvider || (hasExternalImage ? 'external' : 'gemini');
  const promptList = Array.isArray(prompts)
    ? prompts.map(value => String(value || '').trim()).filter(Boolean).slice(0, 10)
    : [];
  if (!prompt && !promptList.length) {
    const error = new Error('prompt required');
    error.status = 400;
    throw error;
  }
  const numImages = promptList.length || Math.min(Math.max(parseInt(count) || 1, 1), 10);

  if (provider === 'external' || model === 'external') {
    if (!hasExternalImage) {
      const error = new Error(hasExternal
        ? 'External image provider is not configured. Set EXTERNAL_IMAGE_MODEL or use Gemini image generation.'
        : 'External image provider is not configured. Set EXTERNAL_AI_BASE_URL, EXTERNAL_AI_API_KEY, and EXTERNAL_IMAGE_MODEL or use Gemini image generation.');
      error.status = 503;
      throw error;
    }
    const externalConfig = await getExternalAiConfigAsync();
    const externalModel = model === 'external' || MEDIA_MODELS[model]
      ? (externalConfig.imageModel || MODEL.externalImage)
      : model;
    const images = await generateImagesWithExternalAi({
      prompt,
      prompts: promptList,
      aspectRatio,
      count: numImages,
      model: externalModel,
      referenceImage,
      signal,
    });
    if (images.length < numImages) {
      const error = new Error(
        `External image provider returned ${images.length} of ${numImages} requested images; no cross-provider fallback is allowed.`,
      );
      error.status = 502;
      error.code = 'EXTERNAL_IMAGE_BATCH_INCOMPLETE';
      error.failedIndexes = Array.isArray(images.failedIndexes) ? images.failedIndexes : [];
      throw error;
    }
    return {
      success: true,
      images: images.map(image => ({ ...image, provider: 'external', model: image.model || externalModel })),
      model: externalModel,
      provider: 'external',
      keys_used: 1,
    };
  }

  return generateGeminiMediaImages({
    prompt,
    promptList,
    model,
    numImages,
    aspectRatio,
    referenceImage,
    signal,
  });
}
