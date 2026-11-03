// public/components/taxonomy-select.js
// Searchable, hierarchical Etsy taxonomy picker

import { taxonomyCatalog } from './taxonomy-catalog.js';

export class TaxonomySelect {
  constructor(containerId, { value = null, onChange = null } = {}) {
    this.containerId = containerId;
    this.value = value;
    this.onChange = onChange;
    this.open = false;
    this.query = '';
    this.filtered = [];
    this.loading = true;
    this._clickHandler = null; // stored so we can remove it on re-render
  }

  async render() {
    const el = document.getElementById(this.containerId);
    if (!el) return;

    el.innerHTML = `<div class="tax-wrap" id="${this.containerId}-inner">
      <div class="tax-trigger" id="${this.containerId}-trigger" onclick="window['__tax_${this.containerId}'].toggle()">
        <span id="${this.containerId}-label" style="flex:1;color:var(--text-3)">Loading categories...</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="tax-dropdown hidden" id="${this.containerId}-dropdown">
        <div class="tax-search-wrap">
          <input type="text" class="tax-search" id="${this.containerId}-search"
            placeholder="Search categories..."
            oninput="window['__tax_${this.containerId}'].search(this.value)"
            onclick="event.stopPropagation()">
        </div>
        <div class="tax-list" id="${this.containerId}-list"></div>
      </div>
    </div>`;

    window[`__tax_${this.containerId}`] = this;

    // Remove any previously attached outside-click handler to prevent accumulation
    if (this._clickHandler) document.removeEventListener('click', this._clickHandler);
    this._clickHandler = (e) => {
      if (!document.body.contains(el)) return; // element detached — ignore
      if (!el.contains(e.target)) this.close();
    };
    document.addEventListener('click', this._clickHandler);

    try {
      await taxonomyCatalog.load();
      this.loading = false;
      this.filtered = taxonomyCatalog.initial(200);
      this.updateLabel();
      this.renderList();
      document.getElementById(`${this.containerId}-label`).style.color = '';
    } catch {
      document.getElementById(`${this.containerId}-label`).textContent = 'Could not load categories';
    }
  }

  toggle() {
    this.open ? this.close() : this.openDropdown();
  }

  openDropdown() {
    this.open = true;
    document.getElementById(`${this.containerId}-dropdown`)?.classList.remove('hidden');
    document.getElementById(`${this.containerId}-trigger`)?.classList.add('open');
    setTimeout(() => document.getElementById(`${this.containerId}-search`)?.focus(), 50);
  }

  close() {
    this.open = false;
    document.getElementById(`${this.containerId}-dropdown`)?.classList.add('hidden');
    document.getElementById(`${this.containerId}-trigger`)?.classList.remove('open');
  }

  search(q) {
    this.query = q.toLowerCase();
    this.filtered = taxonomyCatalog.search(this.query, 100);
    this.renderList();
  }

  select(id) {
    this.value = id;
    this.updateLabel();
    this.close();
    if (this.onChange) this.onChange(id);
  }

  updateLabel() {
    const el = document.getElementById(`${this.containerId}-label`);
    if (!el) return;
    const node = taxonomyCatalog.findById(this.value);
    el.textContent = node ? node.label : 'Select a category...';
    el.style.color = node ? 'var(--text)' : 'var(--text-3)';
  }

  renderList() {
    const el = document.getElementById(`${this.containerId}-list`);
    if (!el) return;

    if (!this.filtered.length) {
      el.innerHTML = `<div style="padding:12px;text-align:center;font-size:12px;color:var(--text-3)">No categories found</div>`;
      return;
    }

    el.innerHTML = this.filtered.map(node => `
      <div class="tax-item ${node.id === this.value ? 'selected' : ''} level-${Math.min(node.level, 3)}"
           onclick="window['__tax_${this.containerId}'].select(${node.id})">
        ${node.level > 0 ? `<span style="color:var(--text-3);margin-right:2px">${'· '.repeat(node.level)}</span>` : ''}
        <span class="tax-item-name">${escHtml(node.name)}</span>
        ${node.level > 0 ? `<span class="tax-item-path">${escHtml(node.path.slice(0, -1).join(' › '))}</span>` : ''}
      </div>`).join('');
  }

  getValue() { return this.value; }
  setValue(id) { this.value = id; this.updateLabel(); }

  // Smart word-level match for AI-suggested category strings.
  findBest(hint) {
    return taxonomyCatalog.findBest(hint);
  }
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── CSS ────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
.tax-wrap { position: relative; }
.tax-trigger {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--bg-card);
  cursor: pointer; font-size: 13px; min-height: 36px;
  transition: border-color 0.15s;
}
.tax-trigger:hover { border-color: var(--border-2); }
.tax-trigger.open  { border-color: var(--dark); }
.tax-dropdown {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0;
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius-lg); z-index: 200;
  box-shadow: 0 8px 24px rgba(0,0,0,0.10);
  overflow: hidden;
}
.tax-dropdown.hidden { display: none; }
.tax-search-wrap { padding: 8px; border-bottom: 1px solid var(--border); }
.tax-search { width: 100%; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; background: var(--bg-secondary); }
.tax-list { max-height: 260px; overflow-y: auto; }
.tax-item {
  display: flex; align-items: baseline; gap: 4px;
  padding: 7px 12px; font-size: 13px; cursor: pointer;
  transition: background 0.1s;
}
.tax-item:hover { background: var(--bg-hover); }
.tax-item.selected { background: var(--orange-light); color: var(--orange); font-weight: 500; }
.tax-item.level-1 { padding-left: 20px; }
.tax-item.level-2 { padding-left: 28px; font-size: 12px; }
.tax-item.level-3 { padding-left: 36px; font-size: 12px; color: var(--text-2); }
.tax-item-name { flex-shrink: 0; }
.tax-item-path { font-size: 11px; color: var(--text-3); margin-left: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tax-item.selected .tax-item-path { color: var(--orange); opacity: 0.7; }
`;
document.head.appendChild(style);
