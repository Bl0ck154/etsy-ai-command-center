import { refreshEtsyGuidanceV2 } from '../api/etsy-guidance/stateful-service.js';

try {
  const status = await refreshEtsyGuidanceV2();
  console.log(JSON.stringify({
    ok: true,
    checked_at: status.monitor?.lastCheckedAt || null,
    candidate_id: status.candidate?.id || null,
    active_revision: status.active?.id || null,
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: String(error?.message || error),
  }));
  process.exitCode = 1;
}
