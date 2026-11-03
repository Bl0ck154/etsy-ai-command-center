import {
  generateMetaAiVideo as generateMetaAiBrowserVideo,
  getMetaAiCookieHeader,
} from '../_meta-ai.js';
import { analyzeGeminiImage } from './gemini-provider.js';
import { generateMediaImages, listMediaModels } from './image-generation.js';

function mediaError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function createMediaApplication({
  generateImages = generateMediaImages,
  listModels = listMediaModels,
  generateVideo = generateMetaAiBrowserVideo,
  getCookieHeader = getMetaAiCookieHeader,
  analyzeImage = analyzeGeminiImage,
  fetchImpl = fetch,
} = {}) {
  async function listAvailableModels() {
    return { success: true, models: await listModels() };
  }

  async function generateImagesAction(input = {}) {
    return generateImages({
      prompt: input.prompt,
      prompts: input.prompts,
      model: input.model,
      provider: input.provider,
      count: input.count,
      aspectRatio: input.aspectRatio,
      referenceImage: input.referenceImage,
    });
  }

  async function generateVideoAction(input = {}) {
    if (!input.prompt) throw mediaError('prompt required');
    const video = await generateVideo({
      cookieHeader: await getCookieHeader(),
      prompt: input.prompt,
      referenceImage: input.referenceImage,
      imageUrl: input.imageUrl,
    });
    return { success: true, video };
  }

  async function animateImageAction(input = {}) {
    let referenceImage = input.referenceImage;
    if (!referenceImage?.base64 && input.imageUrl) {
      const response = await fetchImpl(input.imageUrl);
      if (!response.ok) throw mediaError(`Failed to fetch image: ${response.status}`);
      const buffer = await response.arrayBuffer();
      referenceImage = {
        base64: Buffer.from(buffer).toString('base64'),
        mimeType: response.headers.get('content-type') || 'image/jpeg',
      };
    }
    if (!referenceImage?.base64 || !referenceImage?.mimeType) {
      throw mediaError('referenceImage or imageUrl required');
    }
    const video = await generateVideo({
      cookieHeader: await getCookieHeader(),
      prompt: input.prompt || 'Animate this image into a short video.',
      referenceImage,
    });
    return { success: true, video };
  }

  async function analyzeImageAction(input = {}) {
    const analysis = await analyzeImage({
      referenceImage: input.referenceImage,
      prompt: input.prompt,
    });
    return { success: true, analysis };
  }

  return {
    listAvailableModels,
    generateImages: generateImagesAction,
    generateVideo: generateVideoAction,
    animateImage: animateImageAction,
    analyzeImage: analyzeImageAction,
  };
}

export const mediaApplication = createMediaApplication();
