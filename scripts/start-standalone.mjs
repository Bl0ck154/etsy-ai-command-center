import 'dotenv/config';
import { startEmbeddedKv } from './embedded-kv-server.mjs';

const backend = String(process.env.KV_BACKEND || (process.env.KV_REST_API_URL ? 'redis' : 'local')).trim().toLowerCase();
const remoteUrl = String(process.env.KV_REST_API_URL || '').trim();
const remoteToken = String(process.env.KV_REST_API_TOKEN || '').trim();

if (backend === 'local') {
  if (remoteUrl || remoteToken) {
    console.error('[startup] Local KV conflicts with configured Redis REST credentials. Remove the remote credentials or set KV_BACKEND=redis.');
    process.exit(1);
  }
  try {
    const embedded = await startEmbeddedKv();
    process.env.KV_REST_API_URL = embedded.url;
    process.env.KV_REST_API_TOKEN = embedded.token;
    console.log('[startup] Embedded single-process KV active. File: ' + embedded.file);
  } catch (error) {
    console.error('[startup] Embedded KV failed:', error.message);
    process.exit(1);
  }
} else if (backend === 'redis') {
  if (!remoteUrl || !remoteToken) {
    console.error('[startup] KV_BACKEND=redis requires KV_REST_API_URL and KV_REST_API_TOKEN.');
    process.exit(1);
  }
} else {
  console.error('[startup] Unsupported KV_BACKEND. Use local or redis.');
  process.exit(1);
}

// Import the application only after the KV environment has been resolved.
await import('../server.js');
