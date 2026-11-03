// Social queue persistence compatibility seam.
//
// The scheduler remains the current storage implementation while Social is
// extracted incrementally. Callers outside that implementation must use this
// repository boundary instead of reading or rewriting the Redis list directly.
export {
  deleteScheduledPost,
  getScheduledPosts,
  saveScheduledPost,
  saveScheduledPostBatch,
  updateScheduledPost,
} from '../../../_scheduler.js';
