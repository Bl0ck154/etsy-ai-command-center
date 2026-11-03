export function agentSuggestionChipsMarkup(chips = []) {
  return (Array.isArray(chips) ? chips : []).map(chip => {
    const text = String(chip || '');
    return `<button class="btn btn-sm" style="font-size:11px;color:var(--text-2)" onclick="window.__agentSend('${text.replace(/'/g, "\\'")}')">${text}</button>`;
  }).join('');
}

export function agentWelcomeMarkup() {
  return `
        <div class="agent-welcome">
          <div class="agent-welcome-icon">✦</div>
          <div style="font-size:15px;font-weight:800;color:var(--text);margin-bottom:4px">AI Shop Agent</div>
          <div style="font-size:12px;max-width:560px;line-height:1.45;color:var(--text-2);margin-bottom:14px">Write what you want to do with your Etsy shop. I’ll show approval cards before Etsy changes.</div>
          <div class="agent-welcome-grid">
            <div class="agent-welcome-card">
              <div class="agent-welcome-card-title">What I can do</div>
              <ul class="agent-welcome-list">
                <li>Find the right listing by title, typo, ID, or context.</li>
                <li>Prepare SEO/title/tag/description changes as previews.</li>
                <li>Change variation prices safely while preserving variations.</li>
                <li>Help with orders, stats, images, and social/schedule tasks.</li>
              </ul>
            </div>
            <div class="agent-welcome-card agent-welcome-card-warning">
              <div class="agent-welcome-card-title">Important rules</div>
              <ul class="agent-welcome-list">
                <li>Nothing is applied to Etsy until you approve a card.</li>
                <li>Variation listings use inventory-safe price updates.</li>
                <li>If a listing match is unclear, I’ll ask before changing it.</li>
              </ul>
            </div>
          </div>
        </div>`;
}

export function agentLoadingMarkup() {
  return `
        <div style="display:flex;align-items:center;gap:8px;min-height:18px">
          <div class="spinner" aria-hidden="true" style="width:14px;height:14px;border-width:2px"></div>
          <div id="agent-tool-status" aria-live="polite" style="min-width:0;font-size:11px;color:var(--text-3);overflow-wrap:anywhere"></div>
        </div>
        <div id="agent-progress-history" style="display:flex;flex-direction:column;gap:2px;padding-left:22px;font-size:10px;color:var(--text-3)"></div>`;
}
