import { CROSS_PLATFORM_SET, downloadResized, resizeImage } from './image-resize.js';

export function crossPlatformResizeModes(mode = 'smart') {
  return {
    etsy: 'contain',
    social: mode,
    stories: 'contain',
  };
}

export function createImageResizeBatchService({
  resize = resizeImage,
  download = downloadResized,
  presets = CROSS_PLATFORM_SET,
  schedule = setTimeout,
} = {}) {
  async function generate(file, mode = 'smart') {
    const modeMap = crossPlatformResizeModes(mode);
    const results = {};
    for (const key of presets) {
      results[key] = await resize(file, key, modeMap[key] === 'smart' ? 'smart' : modeMap[key]);
    }
    return results;
  }

  function downloadOne(results, key) {
    const result = results?.[key];
    if (!result) return false;
    download(result, `${key}.jpg`);
    return true;
  }

  function downloadAll(results) {
    if (!results) return 0;
    const keys = Object.keys(results);
    keys.forEach((key, index) => schedule(() => downloadOne(results, key), index * 350));
    return keys.length;
  }

  return { generate, downloadOne, downloadAll };
}

export const imageResizeBatch = createImageResizeBatchService();
