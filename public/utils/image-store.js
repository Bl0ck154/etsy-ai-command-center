// Gallery storage compatibility facade.

export { isValidImageRecord } from './gallery/image-record.js';

export {
  warmGalleryImageSummaries,
  listGalleryImageSummaries,
  saveImage,
  getImage,
  getImagesByIds,
  getLocalImages,
  getAllImages,
  deleteImage,
  clearAllImages,
  countImages,
} from './gallery/image-repository.js';

export {
  saveVideo,
  getAllVideos,
  deleteVideo,
  clearAllVideos,
  countVideos,
} from './gallery/video-repository.js';
