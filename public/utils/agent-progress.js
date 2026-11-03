export function formatAgentDuration(durationMs = 0) {
  const parsedDuration = Number(durationMs);
  const safeDuration = Number.isFinite(parsedDuration) ? Math.max(0, parsedDuration) : 0;
  if (safeDuration > 0 && safeDuration < 1000) return `${Math.round(safeDuration)}ms`;
  const totalSeconds = Math.floor(safeDuration / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function agentProgressElapsedMs(startedAt, currentTime = Date.now()) {
  const start = Number(startedAt);
  const now = Number(currentTime);
  if (!Number.isFinite(start) || !Number.isFinite(now) || start <= 0 || start > now) return 0;
  return now - start;
}

function agentProviderLabel(provider) {
  const labels = {
    external: 'External AI',
    gemini: 'Gemini',
    claude: 'Claude',
  };
  return labels[String(provider || '').trim().toLowerCase()] || '';
}

export function formatAgentProgress(event, elapsedMs = 0) {
  const elapsed = formatAgentDuration(elapsedMs);
  if (!event) return elapsed;

  if (event.type === 'model') {
    const model = String(event.model || event.provider || '').trim();
    const provider = agentProviderLabel(event.provider);
    const identity = provider && model ? `${provider} · ${model}` : model;
    return identity ? `${identity} · ${elapsed}` : elapsed;
  }

  if (event.type === 'tool') {
    const message = String(event.message || event.name || '').trim();
    return message ? `${message} · ${elapsed}` : elapsed;
  }

  if (event.type === 'tool_result') {
    const message = String(event.message || event.name || '').trim();
    const marker = event.status === 'error' ? '!' : '✓';
    const duration = formatAgentDuration(event.duration_ms);
    return message ? `${marker} ${message} · ${duration}` : `${marker} ${duration}`;
  }

  return elapsed;
}
