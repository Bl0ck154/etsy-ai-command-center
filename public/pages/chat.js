// public/pages/chat.js — Conversational Etsy shop agent
// Uses the configured project AI provider with external priority in Auto mode.

const MAX_CHAT_MESSAGES = 40;

function boundedChatMessages(messages = []) {
  return Array.isArray(messages) ? messages.slice(-MAX_CHAT_MESSAGES) : [];
}

export function renderChat(container) {
  container.innerHTML = `
    <div class="chat-page">
      <div class="chat-header">
        <div class="chat-header-info">
          <div class="chat-avatar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
              <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
              <line x1="9" y1="9" x2="9.01" y2="9"/>
              <line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </div>
          <div>
            <div class="chat-name">AI — Etsy Assistant</div>
            <div class="chat-status" id="chat-status">Ready</div>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" id="clear-chat-btn" title="Clear conversation">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>

      <div class="chat-messages" id="chat-messages">
        <div class="chat-welcome">
          <div class="chat-welcome-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M9 9h6M9 12h6M9 15h4"/>
            </svg>
          </div>
          <h3>Etsy Assistant</h3>
          <p>Create listings, check orders, generate content — just tell me what you need.</p>
          <div class="chat-suggestions">
            <button class="suggestion-chip" data-msg="Create a listing for a graduation photo with deceased loved one, similar to our bestseller">🎓 Graduation memorial listing</button>
            <button class="suggestion-chip" data-msg="Show me my top 5 listings by views">📊 Top listings</button>
            <button class="suggestion-chip" data-msg="What are my recent orders?">📦 Recent orders</button>
            <button class="suggestion-chip" data-msg="Create a listing for a custom animated photo (living portrait) for Mother's Day">🎬 Mother's Day animation listing</button>
            <button class="suggestion-chip" data-msg="Show shop info and stats">🏪 Shop info</button>
            <button class="suggestion-chip" data-msg="I want to create a new niche listing. Let's brainstorm.">💡 Brainstorm new listing</button>
          </div>
        </div>
      </div>

      <div class="chat-input-area">
        <div class="chat-input-wrap">
          <textarea
            id="chat-input"
            placeholder="Tell me what you need — create a listing, check orders, generate content..."
            rows="1"
          ></textarea>
          <button class="chat-send-btn" id="chat-send-btn" disabled>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
        <div class="chat-footer-hint">The configured AI provider can create Etsy listings, set prices and variations, check orders, and prepare images.</div>
      </div>
    </div>

    <style>
    .chat-page {
      display: flex; flex-direction: column;
      height: calc(100vh - 60px);
      max-width: 820px; margin: 0 auto;
      background: var(--bg-page);
    }
    .chat-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 24px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .chat-header-info { display: flex; align-items: center; gap: 12px; }
    .chat-avatar {
      width: 38px; height: 38px; border-radius: 50%;
      background: linear-gradient(135deg, var(--orange) 0%, #FF8C42 100%);
      color: white; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 8px rgba(200,90,46,0.28);
    }
    .chat-name { font-weight: 600; font-size: 14px; line-height: 1.2; }
    .chat-status { font-size: 11px; color: var(--text-3); margin-top: 1px; }
    .chat-status.thinking { color: var(--orange); }

    .chat-messages {
      flex: 1; overflow-y: auto;
      padding: 24px 20px;
      display: flex; flex-direction: column; gap: 4px;
      scroll-behavior: smooth;
    }
    .chat-messages::-webkit-scrollbar { width: 4px; }
    .chat-messages::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 4px; }

    .chat-welcome {
      display: flex; flex-direction: column; align-items: center;
      text-align: center; padding: 48px 24px; gap: 0;
    }
    .chat-welcome-icon {
      width: 64px; height: 64px; border-radius: 50%;
      background: linear-gradient(135deg, var(--orange-light) 0%, rgba(200,90,46,0.08) 100%);
      border: 2px solid rgba(200,90,46,0.15);
      color: var(--orange); display: flex; align-items: center; justify-content: center;
      margin-bottom: 18px;
    }
    .chat-welcome h3 { font-size: 19px; font-weight: 700; color: var(--text); margin: 0 0 8px; }
    .chat-welcome p { margin: 0 0 28px; font-size: 13.5px; color: var(--text-3); line-height: 1.6; max-width: 400px; }
    .chat-suggestions {
      display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 560px;
    }
    .suggestion-chip {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 20px; padding: 8px 16px;
      font-size: 13px; cursor: pointer; transition: all 0.15s;
      color: var(--text-2); font-family: inherit;
    }
    .suggestion-chip:hover { background: var(--orange-light); border-color: var(--orange); color: var(--orange); }

    /* Message groups */
    .chat-msg { display: flex; gap: 8px; max-width: 100%; padding: 2px 0; }
    .chat-msg.user { flex-direction: row-reverse; }
    .chat-msg-avatar {
      width: 30px; height: 30px; border-radius: 50%;
      background: var(--bg-secondary);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; font-size: 13px; margin-top: 2px;
      align-self: flex-end;
    }
    .chat-msg.user .chat-msg-avatar { background: var(--orange); color: white; }
    .chat-msg-content { max-width: 82%; display: flex; flex-direction: column; gap: 2px; }
    .chat-msg.user .chat-msg-content { align-items: flex-end; }

    /* Bubbles */
    .chat-bubble {
      padding: 10px 15px;
      border-radius: 18px;
      font-size: 13.5px; line-height: 1.6;
      word-break: break-word; white-space: pre-wrap;
    }
    .chat-msg.user .chat-bubble {
      background: var(--orange); color: #fff;
      border-radius: 18px 18px 5px 18px;
      white-space: pre-wrap;
    }
    .chat-msg.assistant .chat-bubble {
      background: var(--bg-card); color: var(--text);
      border-radius: 5px 18px 18px 18px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
      white-space: normal;
    }
    /* Markdown inside AI bubble */
    .chat-bubble p { margin: 0 0 8px; }
    .chat-bubble p:last-child { margin: 0; }
    .chat-bubble h3 { font-size: 14px; font-weight: 700; margin: 10px 0 4px; color: var(--text); }
    .chat-bubble h4 { font-size: 13.5px; font-weight: 600; margin: 8px 0 3px; }
    .chat-bubble strong { font-weight: 600; }
    .chat-bubble em { font-style: italic; }
    .chat-bubble ul { padding-left: 18px; margin: 6px 0; }
    .chat-bubble ol { padding-left: 18px; margin: 6px 0; }
    .chat-bubble li { margin: 3px 0; line-height: 1.5; }
    .chat-bubble a { color: var(--orange); text-decoration: underline; }
    .chat-bubble code {
      font-family: 'Menlo', monospace; font-size: 12px;
      background: rgba(0,0,0,0.07); padding: 1px 5px;
      border-radius: 4px;
    }
    .chat-bubble pre {
      background: rgba(0,0,0,0.06); border-radius: 8px;
      padding: 10px 12px; overflow-x: auto; margin: 8px 0; font-size: 12px;
    }
    .chat-bubble pre code { background: none; padding: 0; }
    .chat-bubble hr { border: none; border-top: 1px solid var(--border); margin: 8px 0; }

    /* Tool indicator pill */
    .tool-indicator {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 5px 12px;
      background: var(--bg-secondary); border: 1px solid var(--border);
      border-radius: 20px; font-size: 12px; color: var(--text-3);
    }
    .tool-indicator .spin {
      width: 11px; height: 11px;
      border: 2px solid var(--border); border-top-color: var(--orange);
      border-radius: 50%; animation: spin 0.6s linear infinite; flex-shrink: 0;
    }

    /* Thinking dots */
    .thinking-bubble { display: flex; gap: 5px; align-items: center; padding: 13px 16px; }
    .thinking-dot {
      width: 7px; height: 7px; border-radius: 50%; background: var(--text-3);
      animation: tdot 1.2s ease-in-out infinite;
    }
    .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes tdot { 0%,60%,100% { transform:translateY(0);opacity:.5; } 30% { transform:translateY(-5px);opacity:1; } }

    /* Listing card */
    .listing-card {
      background: var(--bg-page); border: 1px solid var(--border);
      border-radius: 10px; padding: 11px 13px; margin-top: 8px; font-size: 12.5px;
    }
    .listing-card-title { font-weight: 600; margin-bottom: 4px; font-size: 13px; }
    .listing-card-meta { color: var(--text-3); display: flex; gap: 10px; font-size: 12px; }
    .listing-card-actions { display: flex; gap: 6px; margin-top: 10px; }
    .listing-card-actions a, .listing-card-actions button {
      font-size: 12px; padding: 4px 10px; border-radius: 6px;
      border: 1px solid var(--border); background: var(--bg-card);
      color: var(--text); cursor: pointer; text-decoration: none; font-family: inherit;
      transition: background 0.1s;
    }
    .listing-card-actions a:hover, .listing-card-actions button:hover { background: var(--bg-hover); }

    /* Input */
    .chat-input-area {
      border-top: 1px solid var(--border); padding: 12px 20px 16px;
      background: var(--bg-card); flex-shrink: 0;
    }
    .chat-input-wrap {
      display: flex; gap: 8px; align-items: flex-end;
      background: var(--bg-page); border: 1.5px solid var(--border);
      border-radius: 26px; padding: 8px 8px 8px 18px;
      transition: border-color 0.15s;
    }
    .chat-input-wrap:focus-within { border-color: var(--orange); }
    #chat-input {
      flex: 1; border: none; background: transparent; resize: none;
      font-size: 14px; line-height: 1.5; max-height: 120px; overflow-y: auto;
      color: var(--text); outline: none; font-family: inherit;
    }
    .chat-send-btn {
      width: 34px; height: 34px; border-radius: 50%;
      background: var(--orange); color: white; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      transition: background 0.15s, transform 0.1s;
    }
    .chat-send-btn:hover { background: var(--orange-hover); }
    .chat-send-btn:active { transform: scale(0.92); }
    .chat-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .chat-footer-hint { font-size: 11px; color: var(--text-3); margin-top: 6px; text-align: center; }
    </style>
  `;

  // State
  let messages = [];
  let isThinking = false;

  const messagesEl  = container.querySelector('#chat-messages');
  const inputEl     = container.querySelector('#chat-input');
  const sendBtn     = container.querySelector('#chat-send-btn');
  const statusEl    = container.querySelector('#chat-status');
  const clearBtn    = container.querySelector('#clear-chat-btn');

  // ── Markdown renderer ─────────────────────────────────────────────────────────
  function renderMarkdown(raw) {
    // 1. Extract & protect code blocks
    const codeBlocks = [];
    let s = raw.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code);
      return `\x02CODE${codeBlocks.length - 1}\x02`;
    });

    // 2. Escape HTML in the remaining text
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 3. Inline transforms (safe to apply before block-level)
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // 4. Block-level: split into lines and process
    const lines = s.split('\n');
    const out = [];
    let ulBuf = [], olBuf = [];

    const flushUl = () => { if (ulBuf.length) { out.push(`<ul>${ulBuf.join('')}</ul>`); ulBuf = []; } };
    const flushOl = () => { if (olBuf.length) { out.push(`<ol>${olBuf.join('')}</ol>`); olBuf = []; } };

    for (const line of lines) {
      const ulM = line.match(/^[\s]*[•\-\*] (.+)$/);
      const olM = line.match(/^[\s]*\d+\. (.+)$/);
      const h3M = line.match(/^### (.+)$/);
      const h2M = line.match(/^## (.+)$/);
      const hrM = line.match(/^---+$/);

      if (ulM) { flushOl(); ulBuf.push(`<li>${ulM[1]}</li>`); continue; }
      if (olM) { flushUl(); olBuf.push(`<li>${olM[1]}</li>`); continue; }
      flushUl(); flushOl();

      if (h3M) { out.push(`<h4>${h3M[1]}</h4>`); }
      else if (h2M) { out.push(`<h3>${h2M[1]}</h3>`); }
      else if (hrM) { out.push('<hr>'); }
      else if (line.trim() === '') { out.push(''); } // blank line = paragraph break
      else { out.push(line); }
    }
    flushUl(); flushOl();

    // 5. Join lines — consecutive non-empty lines merge into <p>
    const html = out.join('\n')
      .split(/\n{2,}/)
      .map(block => {
        block = block.trim();
        if (!block) return '';
        if (/^<(ul|ol|h[2-4]|hr)/.test(block)) return block;
        return `<p>${block.replace(/\n/g, '<br>')}</p>`;
      })
      .join('');

    // 6. Restore code blocks (escape their content)
    return html.replace(/\x02CODE(\d+)\x02/g, (_, i) => {
      const escaped = codeBlocks[parseInt(i)]
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre><code>${escaped}</code></pre>`;
    });
  }

  // ── Append message to UI ─────────────────────────────────────────────────────
  function appendMessage(role, text, extra = {}) {
    // Remove welcome screen on first message
    const welcome = messagesEl.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;

    const avatarHTML = role === 'user'
      ? '<div class="chat-msg-avatar">👤</div>'
      : '<div class="chat-msg-avatar">🤖</div>';

    const bubbleContent = renderMarkdown(text);

    // If this is a listing creation result, add a card
    let listingCardHTML = '';
    if (extra.listing_id && extra.listing_url) {
      listingCardHTML = `
        <div class="listing-card">
          <div class="listing-card-title">${extra.listing_title || 'New Listing'}</div>
          <div class="listing-card-meta">
            <span>State: <strong>${extra.listing_state || 'draft'}</strong></span>
            <span>ID: ${extra.listing_id}</span>
          </div>
          <div class="listing-card-actions">
            <a href="${extra.listing_url}" target="_blank">View on Etsy ↗</a>
            <button onclick="navigator.clipboard.writeText('${extra.listing_id}')">Copy ID</button>
          </div>
        </div>`;
    }

    div.innerHTML = `
      ${role === 'assistant' ? avatarHTML : ''}
      <div class="chat-msg-content">
        <div class="chat-bubble">${bubbleContent}${listingCardHTML}</div>
      </div>
      ${role === 'user' ? avatarHTML : ''}
    `;

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // ── Thinking indicator ───────────────────────────────────────────────────────
  function showThinking(toolName = null) {
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.id = 'thinking-indicator';

    const content = toolName
      ? `<div class="tool-indicator"><div class="spin"></div> ${toolLabel(toolName)}</div>`
      : `<div class="chat-bubble"><div class="thinking-bubble"><div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div></div></div>`;

    div.innerHTML = `<div class="chat-msg-avatar">🤖</div><div class="chat-msg-content">${content}</div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideThinking() {
    const el = document.getElementById('thinking-indicator');
    if (el) el.remove();
  }

  function toolLabel(name) {
    const labels = {
      get_shop_info:           'Checking shop info…',
      get_listings:            'Loading listings…',
      get_listing:             'Loading listing details…',
      get_shop_config:         'Loading shipping profiles & sections…',
      generate_listing_text:   'Generating SEO content with AI…',
      create_listing:          'Creating listing on Etsy…',
      update_listing:          'Updating listing…',
      set_listing_variations:  'Setting price variations…',
      get_recent_orders:       'Loading recent orders…',
      generate_image_prompt:   'Preparing image prompt…',
      generate_image:          'Generating image with Gemini AI…',
      upload_image_to_listing: 'Uploading image to listing…',
    };
    return labels[name] || `Using tool: ${name}…`;
  }

  // ── SSE stream reader ─────────────────────────────────────────────────────────
  async function readStream(response, onTool, onDelta, onDone, onError) {
    const reader = response.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;
        let evt;
        try { evt = JSON.parse(part.slice(6)); } catch { continue; }
        if (evt.type === 'tool')  onTool(evt.name);
        if (evt.type === 'delta') onDelta(evt.text);
        if (evt.type === 'done')  onDone(evt.message);
        if (evt.type === 'error') onError(evt.error);
      }
    }
  }

  // ── Send message ─────────────────────────────────────────────────────────────
  async function sendMessage(text) {
    if (!text.trim() || isThinking) return;
    isThinking = true;
    sendBtn.disabled = true;
    statusEl.textContent = 'Thinking…';
    statusEl.className = 'chat-status thinking';

    appendMessage('user', text);
    messages.push({ role: 'user', content: text });
    inputEl.value = '';
    inputEl.style.height = 'auto';

    showThinking();

    // Live streaming bubble
    let streamDiv = null;
    let streamBubble = null;
    let streamText = '';

    function getStreamBubble() {
      if (streamBubble) return streamBubble;
      hideThinking();
      streamDiv = document.createElement('div');
      streamDiv.className = 'chat-msg assistant';
      streamDiv.innerHTML = `<div class="chat-msg-avatar">🤖</div><div class="chat-msg-content"><div class="chat-bubble" id="live-bubble"></div></div>`;
      messagesEl.appendChild(streamDiv);
      streamBubble = streamDiv.querySelector('#live-bubble');
      return streamBubble;
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: boundedChatMessages(messages), max_iterations: 12 }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        hideThinking();
        appendMessage('assistant', `❌ Error: ${data.error || res.statusText}`);
        return;
      }

      let fullMessage = '';

      await readStream(res,
        (toolName) => { showThinking(toolName); },
        (delta) => {
          streamText += delta;
          const bubble = getStreamBubble();
          bubble.textContent = streamText; // plain text while streaming
          messagesEl.scrollTop = messagesEl.scrollHeight;
        },
        (msg) => {
          fullMessage = msg || streamText;
          messages.push({ role: 'assistant', content: fullMessage });
          // Re-render with markdown on done
          if (streamBubble) streamBubble.innerHTML = renderMarkdown(fullMessage);
          else appendMessage('assistant', fullMessage);
        },
        (err) => {
          hideThinking();
          if (streamDiv) streamDiv.remove();
          appendMessage('assistant', `❌ ${err}`);
        }
      );

    } catch (err) {
      hideThinking();
      if (streamDiv) streamDiv.remove();
      appendMessage('assistant', `❌ Connection error: ${err.message}`);
    } finally {
      hideThinking();
      isThinking = false;
      sendBtn.disabled = false;
      statusEl.textContent = 'Ready';
      statusEl.className = 'chat-status';
    }
  }

  // ── Event listeners ──────────────────────────────────────────────────────────
  inputEl.addEventListener('input', () => {
    sendBtn.disabled = !inputEl.value.trim() || isThinking;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  sendBtn.addEventListener('click', () => sendMessage(inputEl.value));

  // Suggestion chips
  container.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      inputEl.value = chip.dataset.msg;
      sendMessage(chip.dataset.msg);
    });
  });

  // Clear chat
  clearBtn.addEventListener('click', () => {
    messages = [];
    messagesEl.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M9 9h6M9 12h6M9 15h4"/>
          </svg>
        </div>
        <h3>Etsy Assistant</h3>
        <p>Create listings, check orders, generate content — just tell me what you need.</p>
        <div class="chat-suggestions">
          <button class="suggestion-chip" data-msg="Create a listing for a graduation photo with deceased loved one, similar to our bestseller">🎓 Graduation memorial listing</button>
          <button class="suggestion-chip" data-msg="Show me my top 5 listings by views">📊 Top listings</button>
          <button class="suggestion-chip" data-msg="What are my recent orders?">📦 Recent orders</button>
          <button class="suggestion-chip" data-msg="Create a listing for a custom animated photo (living portrait) for Mother's Day">🎬 Mother's Day animation listing</button>
          <button class="suggestion-chip" data-msg="Show shop info and stats">🏪 Shop info</button>
          <button class="suggestion-chip" data-msg="I want to create a new niche listing. Let's brainstorm.">💡 Brainstorm new listing</button>
        </div>
      </div>`;
    // Re-attach chip listeners
    container.querySelectorAll('.suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        inputEl.value = chip.dataset.msg;
        sendMessage(chip.dataset.msg);
      });
    });
  });

  // Focus input
  inputEl.focus();
}

// ── Floating persistent chat panel ───────────────────────────────────────────
export function renderFloatingChat(container) {
  const CHIPS = [
    { label: '🎓 Graduation memorial listing', msg: 'Create a listing for a graduation photo with deceased loved one, similar to our bestseller' },
    { label: '📊 Top listings by views', msg: 'Show me my top 5 listings by views' },
    { label: '📦 Recent orders', msg: 'What are my recent orders?' },
    { label: '💡 Brainstorm new listing', msg: 'I want to create a new niche listing. Let\'s brainstorm.' },
  ];

  container.innerHTML = `
    <div class="fchat-header">
      <div class="fchat-avatar">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
        </svg>
      </div>
      <div style="flex:1;min-width:0">
        <div class="fchat-title">AI Assistant</div>
        <div class="fchat-status" id="fchat-status">Ready</div>
      </div>
      <button class="fchat-btn" id="fchat-clear-btn" title="Clear conversation">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
      </button>
      <button class="fchat-btn" id="fchat-close-btn" title="Close">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="fchat-messages" id="fchat-messages">
      ${buildWelcome()}
    </div>

    <div class="fchat-input-area">
      <textarea
        id="fchat-input"
        class="fchat-input"
        placeholder="Ask me anything…"
        rows="1"
      ></textarea>
      <button class="fchat-send" id="fchat-send" disabled>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>`;

  function buildWelcome() {
    return `<div class="fchat-welcome" id="fchat-welcome">
      <div class="fchat-welcome-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
        </svg>
      </div>
      <h4>Etsy Assistant</h4>
      <p>Create listings, check orders,<br>generate content — just ask.</p>
      <div class="fchat-chips">
        ${CHIPS.map(c => `<button class="fchat-chip" data-msg="${c.msg.replace(/"/g, '&quot;')}">${c.label}</button>`).join('')}
      </div>
    </div>`;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let messages = [];
  let isThinking = false;

  const msgsEl   = container.querySelector('#fchat-messages');
  const inputEl  = container.querySelector('#fchat-input');
  const sendBtn  = container.querySelector('#fchat-send');
  const statusEl = container.querySelector('#fchat-status');

  // ── Markdown renderer (shared logic) ──────────────────────────────────────
  function md(raw) {
    const codeBlocks = [];
    let s = raw.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code);
      return `\x02CODE${codeBlocks.length - 1}\x02`;
    });
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    const lines = s.split('\n');
    const out = [];
    let ulBuf = [], olBuf = [];
    const flushUl = () => { if (ulBuf.length) { out.push(`<ul style="padding-left:16px;margin:5px 0">${ulBuf.join('')}</ul>`); ulBuf = []; } };
    const flushOl = () => { if (olBuf.length) { out.push(`<ol style="padding-left:16px;margin:5px 0">${olBuf.join('')}</ol>`); olBuf = []; } };

    for (const line of lines) {
      const ulM = line.match(/^[\s]*[•\-\*] (.+)$/);
      const olM = line.match(/^[\s]*\d+\. (.+)$/);
      if (ulM) { flushOl(); ulBuf.push(`<li style="margin:3px 0">${ulM[1]}</li>`); continue; }
      if (olM) { flushUl(); olBuf.push(`<li style="margin:3px 0">${olM[1]}</li>`); continue; }
      flushUl(); flushOl();
      if (/^#{1,3} /.test(line)) {
        out.push(`<strong style="display:block;margin:8px 0 3px;font-size:13px">${line.replace(/^#{1,3} /, '')}</strong>`);
      } else if (line.trim() === '') {
        out.push('');
      } else {
        out.push(line);
      }
    }
    flushUl(); flushOl();

    const html = out.join('\n').split(/\n{2,}/).map(block => {
      block = block.trim();
      if (!block) return '';
      if (/^<(ul|ol|h[2-4]|hr)/.test(block)) return block;
      return `<p style="margin:0 0 7px">${block.replace(/\n/g, '<br>')}</p>`;
    }).join('');

    return html.replace(/\x02CODE(\d+)\x02/g, (_, i) => {
      const escaped = codeBlocks[parseInt(i)].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre style="background:rgba(0,0,0,0.07);padding:8px 10px;border-radius:8px;font-size:11.5px;overflow-x:auto;margin:6px 0"><code>${escaped}</code></pre>`;
    });
  }

  // ── Tool label ─────────────────────────────────────────────────────────────
  function toolLabel(name) {
    const labels = {
      get_shop_info:           'Checking shop info…',
      get_listings:            'Loading listings…',
      get_listing:             'Loading listing…',
      get_shop_config:         'Loading shop config…',
      generate_listing_text:   'Generating SEO content…',
      create_listing:          'Creating listing on Etsy…',
      update_listing:          'Updating listing…',
      set_listing_variations:  'Setting variations…',
      get_recent_orders:       'Loading orders…',
      generate_image_prompt:   'Preparing image prompt…',
      generate_image:          'Generating image…',
      upload_image_to_listing: 'Uploading image…',
    };
    return labels[name] || `Using tool: ${name}…`;
  }

  // ── Append bubble ──────────────────────────────────────────────────────────
  function appendBubble(role, html) {
    const welcome = msgsEl.querySelector('#fchat-welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `fchat-bubble ${role === 'user' ? 'user' : 'ai'}`;
    div.innerHTML = html;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  function showTyping(toolName) {
    hideTyping();
    const div = document.createElement('div');
    div.id = 'fchat-typing';
    if (toolName) {
      div.className = 'fchat-tool-badge';
      div.innerHTML = `<div class="spinner" style="width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--orange);border-radius:50%;animation:spin 0.6s linear infinite;flex-shrink:0"></div> ${toolLabel(toolName)}`;
    } else {
      div.className = 'fchat-typing';
      div.innerHTML = '<div class="fchat-dot"></div><div class="fchat-dot"></div><div class="fchat-dot"></div>';
    }
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById('fchat-typing');
    if (el) el.remove();
  }

  // ── SSE stream reader ──────────────────────────────────────────────────────
  async function readStream(response, onTool, onDelta, onDone, onError) {
    const reader = response.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;
        let evt;
        try { evt = JSON.parse(part.slice(6)); } catch { continue; }
        if (evt.type === 'tool')  onTool(evt.name);
        if (evt.type === 'delta') onDelta(evt.text);
        if (evt.type === 'done')  onDone(evt.message);
        if (evt.type === 'error') onError(evt.error);
      }
    }
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  async function send(text) {
    text = text.trim();
    if (!text || isThinking) return;
    isThinking = true;
    sendBtn.disabled = true;
    statusEl.textContent = 'Thinking…';

    appendBubble('user', text); // user bubble: plain text
    messages.push({ role: 'user', content: text });
    inputEl.value = '';
    inputEl.style.height = 'auto';
    showTyping();

    let liveBubble = null;
    let liveText = '';

    function getLiveBubble() {
      if (liveBubble) return liveBubble;
      hideTyping();
      liveBubble = document.createElement('div');
      liveBubble.className = 'fchat-bubble ai';
      msgsEl.appendChild(liveBubble);
      return liveBubble;
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: boundedChatMessages(messages), max_iterations: 12 }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        hideTyping();
        appendBubble('ai', `❌ ${data.error || res.statusText}`);
        return;
      }

      let fullMessage = '';

      await readStream(res,
        (toolName) => { showTyping(toolName); },
        (delta) => {
          liveText += delta;
          const b = getLiveBubble();
          b.textContent = liveText; // plain text while streaming
          msgsEl.scrollTop = msgsEl.scrollHeight;
        },
        (msg) => {
          fullMessage = msg || liveText;
          messages.push({ role: 'assistant', content: fullMessage });
          // Re-render with markdown when complete
          if (liveBubble) liveBubble.innerHTML = md(fullMessage);
          else appendBubble('ai', md(fullMessage));
          msgsEl.scrollTop = msgsEl.scrollHeight;
        },
        (err) => {
          hideTyping();
          if (liveBubble) liveBubble.remove();
          appendBubble('ai', `❌ ${err}`);
        }
      );

    } catch (err) {
      hideTyping();
      if (liveBubble) liveBubble.remove();
      appendBubble('ai', `❌ Connection error: ${err.message}`);
    } finally {
      hideTyping();
      isThinking = false;
      sendBtn.disabled = !inputEl.value.trim();
      statusEl.textContent = 'Ready';
    }
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  inputEl.addEventListener('input', () => {
    sendBtn.disabled = !inputEl.value.trim() || isThinking;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 90) + 'px';
  });

  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(inputEl.value);
    }
  });

  sendBtn.addEventListener('click', () => send(inputEl.value));

  // Suggestion chips (delegated — welcome may be re-rendered)
  msgsEl.addEventListener('click', e => {
    const chip = e.target.closest('.fchat-chip');
    if (chip) send(chip.dataset.msg);
  });

  // Clear
  container.querySelector('#fchat-clear-btn').addEventListener('click', () => {
    messages = [];
    msgsEl.innerHTML = buildWelcome();
  });

  // Close
  container.querySelector('#fchat-close-btn').addEventListener('click', () => {
    window.closeChatPanel?.();
  });

  // Focus input
  setTimeout(() => inputEl.focus(), 50);
}
