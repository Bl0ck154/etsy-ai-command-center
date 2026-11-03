// public/utils/post-store.js — Server-side post history via configured KV storage
// All data stored on the server, accessible from any device/browser

import { kvPost } from './kv-client.js';

// Returns Map<listing_id, { platforms: Set<platform>, urls: Map<platform, url> }>
export async function getPostsByListing() {
  const records = await kvPost('getPosts') || [];
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.listing_id)) map.set(r.listing_id, { platforms: new Set(), urls: new Map() });
    const entry = map.get(r.listing_id);
    entry.platforms.add(r.platform);
    if (r.post_url) entry.urls.set(r.platform, r.post_url);
  }
  return map;
}

// Returns all records newest first (for history view)
export async function getAllPostRecords() {
  return kvPost('getPosts') || [];
}
