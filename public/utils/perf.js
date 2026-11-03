import './perf/styles.js';

export { debounce, throttle } from './perf/timing.js';
export { skeleton, skeletonCard, skeletonTable } from './perf/skeletons.js';
export { lazyImg, observeLazyImages } from './perf/lazy-images.js';
export { dedupedFetch } from './perf/request-dedupe.js';
export {
  clearPageCache,
  getCachedPage,
  setCachedPage,
} from './perf/page-cache.js';
