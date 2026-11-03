import {
  enqueueMessageTriggerEvent,
  getMessageTriggerStatus,
  hydrateNewMessageTriggerEvent,
  hydrateOrderLinkedTriggerEvent,
  runDueMessageTriggerCandidates,
} from './messages/trigger-runner.js';
import {
  scheduleImmediateMessageTriggerRun,
  supersedePendingNewMessageCandidates,
} from './messages/trigger-dispatcher.js';
import { getPersistedMessageTriggerWorkerStatus } from './messages/trigger-worker.js';
import { requireMessageEventToken } from './message-events/auth.js';
import { createMessageEventsApplication } from './message-events/application.js';

const messageEventsApplication = createMessageEventsApplication({
  enqueueMessageTriggerEvent,
  getMessageTriggerStatus,
  hydrateNewMessageTriggerEvent,
  hydrateOrderLinkedTriggerEvent,
  runDueMessageTriggerCandidates,
  scheduleImmediateMessageTriggerRun,
  supersedePendingNewMessageCandidates,
  getPersistedMessageTriggerWorkerStatus,
});

export default async function handler(req, res, dependencies = {}) {
  if (!requireMessageEventToken(req, res)) return;

  if (req.method === 'GET') {
    const data = await messageEventsApplication.status(req.query || {});
    return res.json({ success: true, data });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const action = String(req.body?.action || 'ingest').trim().slice(0, 80);
  if (action === 'runDue') {
    const data = await messageEventsApplication.runDue(req.body || {});
    return res.json({ success: true, data });
  }
  if (!['ingest', 'ingestNotification'].includes(action)) {
    return res.status(400).json({ error: `Unknown message event action: ${action}` });
  }

  const result = await messageEventsApplication.ingest(req.body || {}, dependencies);
  if (result.error) {
    return res.status(result.status).json({
      error: result.error,
      code: result.code,
      data: result.data,
    });
  }
  return res.status(result.status).json({ success: true, data: result.data });
}
