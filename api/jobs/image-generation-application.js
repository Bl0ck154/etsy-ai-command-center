import { generateMediaImages } from '../media.js';
import {
  createBackgroundJobWithStatus,
  updateBackgroundJob,
} from './job-store.js';

const DEFAULT_IMAGE_JOB_TIMEOUT_MS = 120_000;
const MAX_IMAGE_JOB_TIMEOUT_MS = 120_000;
const IMAGE_JOB_CONCURRENCY = 6;

export function resolveImageJobTimeoutMs(params = {}) {
  const requested = Number(params.timeoutMs);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.max(requested, 10_000), MAX_IMAGE_JOB_TIMEOUT_MS);
  }
  return DEFAULT_IMAGE_JOB_TIMEOUT_MS;
}

export function createImageGenerationApplication({
  generateImages = generateMediaImages,
  createJob = createBackgroundJobWithStatus,
  updateJob = updateBackgroundJob,
  schedule = callback => setTimeout(callback, 0),
  createAbortController = () => new AbortController(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  async function generateJobImages(params, signal) {
    const promptList = Array.isArray(params.prompts)
      ? params.prompts.map(value => String(value || '').trim()).filter(Boolean).slice(0, 10)
      : [];
    const count = promptList.length || Math.min(Math.max(parseInt(params.count, 10) || 1, 1), 10);
    if (count <= 1) {
      return generateImages({
        prompt: params.prompt,
        prompts: promptList,
        model: params.model,
        provider: params.provider,
        count: 1,
        aspectRatio: params.aspectRatio || '1:1',
        referenceImage: params.referenceImage,
        signal,
      });
    }

    const prompts = promptList.length
      ? promptList
      : Array.from(
        { length: count },
        (_, index) => `${params.prompt}\n\nCreate image ${index + 1} of ${count}. Keep the same listing context, but use a distinct composition.`,
      );
    const results = new Array(prompts.length);
    const errors = new Array(prompts.length);
    let nextIndex = 0;

    const worker = async () => {
      while (!signal?.aborted) {
        const index = nextIndex++;
        if (index >= prompts.length) return;
        try {
          results[index] = await generateImages({
            prompt: prompts[index],
            model: params.model,
            provider: params.provider,
            count: 1,
            aspectRatio: params.aspectRatio || '1:1',
            referenceImage: params.referenceImage,
            signal,
          });
        } catch (error) {
          errors[index] = error?.message || String(error || 'Image generation failed');
        }
      }
    };

    await Promise.all(Array.from(
      { length: Math.min(IMAGE_JOB_CONCURRENCY, prompts.length) },
      () => worker(),
    ));

    const firstResult = results.find(Boolean) || null;
    const images = results.flatMap((result, promptIndex) => {
      if (!result) return [];
      const resultProvider = result.provider || params.provider || 'gemini';
      const resultModel = result.model || params.model || 'imagen-3';
      return (result.images || []).map(image => ({
        ...image,
        prompt_index: promptIndex,
        provider: image.provider || resultProvider,
        model: image.model || resultModel,
      }));
    });
    const lastError = errors.filter(Boolean).at(-1) || '';
    if (!images.length) throw new Error(lastError || 'No images returned');
    return {
      success: true,
      ...(firstResult || {}),
      images: images.slice(0, count),
      warning: images.length < count
        ? `Generated ${images.length} of ${count} images.${lastError ? ` Last error: ${lastError}` : ''}`
        : firstResult?.warning,
    };
  }

  async function run(jobId, params) {
    const timeoutMs = resolveImageJobTimeoutMs(params);
    const controller = createAbortController();
    const timer = setTimer(() => controller.abort(), timeoutMs);
    try {
      updateJob(jobId, { status: 'running', progress: 20, message: 'Image generation started' });
      const result = await generateJobImages(params, controller.signal);
      clearTimer(timer);
      updateJob(jobId, {
        status: 'done',
        progress: 100,
        message: 'Image generation complete',
        result,
        error: null,
      });
    } catch (error) {
      clearTimer(timer);
      const timedOut = error?.name === 'AbortError' || /abort|timeout/i.test(String(error?.message || ''));
      console.error('[jobs] image generation failed:', error?.message || error);
      updateJob(jobId, {
        status: 'error',
        progress: 100,
        message: timedOut
          ? `Image generation timed out after ${Math.round(timeoutMs / 1000)}s`
          : 'Image generation failed',
        error: timedOut
          ? `Image generation timed out after ${Math.round(timeoutMs / 1000)}s`
          : (error?.message || 'Unknown error'),
      });
    }
  }

  function start(params = {}, ownerId = '') {
    const { job, created } = createJob('', 'image_generation', params, ownerId);
    if (!job) return null;
    if (created) schedule(() => run(job.id, params));
    return job;
  }

  return { generateJobImages, run, start };
}

export const imageGenerationApplication = createImageGenerationApplication();
