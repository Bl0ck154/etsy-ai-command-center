export function agentShellMarkup() {
  return `
    <div class="agent-shell">
      <div class="agent-topbar-card">
        <div class="agent-topbar-main">
          <div class="agent-topbar-copy">
            <div class="agent-topbar-title">AI Shop Agent</div>
            <div id="agent-model-caption" class="agent-topbar-caption"></div>
          </div>
        </div>
        <div class="agent-controls-row">
          <label class="agent-model-switcher" title="Choose model provider">
            <span class="agent-model-switcher-label">Model</span>
            <span class="agent-select-wrap">
              <select id="agent-model-select" class="agent-model-select" aria-label="Agent model">
                <option value="auto">Auto</option>
                <option value="external">External AI</option>
                <option value="gemini">Gemini</option>
                <option value="claude">Claude</option>
              </select>
            </span>
          </label>
          <button class="agent-control-btn" id="agent-memory-btn" title="Saved memory" aria-label="Saved memory">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a4 4 0 0 0-4 4v1a4 4 0 0 0-2 7.46V16a4 4 0 0 0 4 4h2m0-18a4 4 0 0 1 4 4v1a4 4 0 0 1 2 7.46V16a4 4 0 0 1-4 4h-2m0-18v20m-4-9h4m4-4h-4"/></svg>
            <span class="agent-control-label">Memory</span><span id="agent-memory-count" class="agent-memory-badge"></span>
          </button>
          <button class="agent-control-btn" id="agent-history-btn" title="Past conversations" aria-label="Past conversations">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-2v6l4 2"/></svg>
            <span class="agent-control-label">History</span>
          </button>
          <button class="agent-control-btn" id="agent-clear-btn" title="Start a new chat" aria-label="Start a new chat">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
            <span class="agent-control-label">New</span>
          </button>
        </div>
      </div>
      <div id="agent-history-panel" class="agent-panel-shell" style="display:none">
        <div class="agent-panel-head">
          <div class="agent-panel-title">Past conversations</div>
        </div>
        <div id="agent-history-list" class="agent-panel-list"></div>
      </div>
      <div id="agent-memory-panel" class="agent-panel-shell" style="display:none">
        <div class="agent-panel-head">
          <div class="agent-panel-title">Saved memory</div>
          <button class="btn btn-sm" id="agent-memory-clear-btn" style="color:var(--red-text);font-size:11px">Clear personal</button>
        </div>
        <div class="agent-memory-sections">
          <section class="agent-memory-section" aria-labelledby="agent-personal-memory-title">
            <div class="agent-memory-section-head">
              <div id="agent-personal-memory-title" class="agent-memory-section-title">Personal</div>
              <div class="agent-memory-section-note">Only for this account</div>
            </div>
            <div id="agent-memory-list" class="agent-panel-list"></div>
          </section>
          <section class="agent-memory-section" aria-labelledby="agent-shop-memory-title">
            <div class="agent-memory-section-head">
              <div id="agent-shop-memory-title" class="agent-memory-section-title">Shop</div>
              <div class="agent-memory-section-note">Shared with everyone managing this shop</div>
            </div>
            <div id="agent-shop-memory-list" class="agent-panel-list"></div>
          </section>
        </div>
      </div>
      <div id="agent-messages" class="agent-message-stream">
        <div id="agent-drag-overlay" class="agent-drag-overlay">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="1.5"><rect x="3" y="3" width="18" height="15" rx="2"/><path d="M3 14l4-4 3 3 4-5 7 7"/><circle cx="8.5" cy="8.5" r="1.5" fill="var(--orange)" stroke="none"/></svg>
          <div style="font-size:13px;font-weight:600;color:var(--orange)">Drop image to analyze</div>
          <div style="font-size:11px;color:var(--text-3)">The image will be analyzed before the agent responds</div>
        </div>
      </div>
      <div id="agent-input-wrap" class="agent-composer-shell">
        <div class="agent-composer">
          <div id="agent-attachment" class="agent-attachment-card" style="display:none">
            <img id="agent-att-thumb" src="" alt="" class="agent-attachment-thumb">
            <div style="flex:1;min-width:0">
              <div id="agent-att-name" class="agent-attachment-name"></div>
              <div class="agent-attachment-hint">Image attached — ready for analysis</div>
            </div>
            <button onclick="window.__agentClearAttachment()" class="agent-attachment-remove" title="Remove">×</button>
          </div>
          <textarea id="agent-input" rows="1" placeholder="Ask me anything, or drop/paste an image here…"
            class="agent-input"
            oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.__agentSend()}"></textarea>
          <button id="agent-img-btn" title="Attach image" onclick="document.getElementById('agent-img-file').click()" class="agent-square-btn agent-square-btn-secondary">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M2 10l3-3 2 2 3-3 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <input type="file" id="agent-img-file" accept="image/*" style="display:none" onchange="window.__agentHandleImgFile(this.files[0]);this.value=''">
          <button id="agent-send-btn" onclick="window.__agentSend()" class="agent-square-btn agent-square-btn-primary">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 12V4M4 8l4-4 4 4" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div id="agent-chips" class="agent-chip-row"></div>
      </div>
    </div>`;
}
