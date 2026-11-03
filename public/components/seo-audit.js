// public/components/seo-audit.js
// AI-powered SEO audit — analyses title, tags, description and gives actionable tips

import { toastError } from './toast.js';
import { openModal, setModalBody } from './modal.js';
import { postJson } from '../utils/json-post-client.js';
import {
  AUDIT_SYSTEM,
  buildFullListingAuditPrompt,
  buildSeoAuditPrompt,
} from './seo-audit-contracts.js';

export async function runSeoAudit(listing, provider = 'gemini') {
  openModal({
    title: `SEO Audit — ${listing.title?.slice(0, 40)}...`,
    body: `<div class="loading-center" style="padding:40px">
      <div class="spinner spinner-lg"></div>
      <span style="margin-left:12px">Analysing with AI...</span>
    </div>`,
    size: 'lg',
  });

  try {
    const data = await postJson('/api/ai', {
      type: 'audit',
      provider,
      _rawPrompt: buildSeoAuditPrompt(listing),
      _rawSystem: AUDIT_SYSTEM,
    });
    if (data.error) throw new Error(data.error);

    renderAuditModal(listing, data.data);
  } catch (e) {
    setModalBody(`<div class="alert alert-error">${e.message}</div>`);
  }
}

function renderAuditModal(listing, audit) {
  const gradeColor = { A: 'var(--green-text)', B: 'var(--orange)', C: '#B45309', D: 'var(--red-text)' }[audit.grade] || 'var(--text)';
  const statusIcon = { pass: '✓', warn: '⚠', fail: '✕' };
  const statusCls  = { pass: 'badge-green', warn: 'badge-orange', fail: 'badge-red' };

  setModalBody(`
    <!-- Score header -->
    <div style="display:flex;align-items:center;gap:20px;margin-bottom:20px">
      <div style="text-align:center">
        <div style="font-size:52px;font-weight:700;line-height:1;color:${gradeColor}">${audit.grade}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">Grade</div>
      </div>
      <div style="flex:1">
        <div style="font-size:13px;margin-bottom:8px">${escHtml(audit.summary)}</div>
        <div style="background:var(--bg-hover);border-radius:6px;height:8px;overflow:hidden">
          <div style="background:${gradeColor};height:100%;width:${audit.score}%;border-radius:6px;transition:width 0.8s ease"></div>
        </div>
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">${audit.score}/100</div>
      </div>
    </div>

    <!-- Checks -->
    <div class="card mb-12">
      <div class="card-title">Detailed analysis</div>
      ${(audit.checks || []).map(c => `
        <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <span class="badge ${statusCls[c.status] || 'badge-gray'}" style="flex-shrink:0;align-self:flex-start;margin-top:1px">${statusIcon[c.status] || '?'}</span>
          <div style="flex:1">
            <div style="font-size:12px;font-weight:600;margin-bottom:2px">${escHtml(c.area)}: <span style="font-weight:400">${escHtml(c.message)}</span></div>
            ${c.tip ? `<div style="font-size:11px;color:var(--orange)">💡 ${escHtml(c.tip)}</div>` : ''}
          </div>
        </div>`).join('')}
    </div>

    <!-- Quick wins -->
    ${audit.quick_wins?.length ? `
    <div class="card mb-12">
      <div class="card-title">Quick wins</div>
      ${audit.quick_wins.map((w, i) => `
        <div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
          <span style="width:18px;height:18px;border-radius:50%;background:var(--orange);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i+1}</span>
          <span style="font-size:12px">${escHtml(w)}</span>
        </div>`).join('')}
    </div>` : ''}

    <!-- Suggested title -->
    ${audit.suggested_title ? `
    <div class="card mb-12">
      <div class="card-title">Suggested title</div>
      <div style="font-size:12px;background:var(--bg-secondary);padding:10px;border-radius:var(--radius);border:1px solid var(--border);margin-bottom:8px">${escHtml(audit.suggested_title)}</div>
      <button class="btn btn-sm" onclick="navigator.clipboard.writeText(${JSON.stringify(audit.suggested_title)}).then(()=>window.closeModal())">Copy & use this title</button>
    </div>` : ''}

    <!-- Suggested tags -->
    ${audit.suggested_tags?.length ? `
    <div class="card mb-12">
      <div class="card-title">Suggested new tags</div>
      <div>${audit.suggested_tags.map(t => `<span class="tag-chip">${escHtml(t)}</span>`).join('')}</div>
    </div>` : ''}

    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:4px">
      <button class="btn" onclick="window.navigate('create',{listing_id:${listing.listing_id}})">Edit this listing</button>
      <button class="btn btn-primary" onclick="closeModal()">Done</button>
    </div>`);
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export async function runFullAuditWithAI(listing, provider = 'gemini') {
  const { openModal, setModalBody } = await import('./modal.js');
  openModal({ title: '✦ AI Full Listing Audit', size: 'lg',
    body: '<div class="loading-center"><div class="spinner"></div><span style="margin-left:8px">Analysing with Gemini…</span></div>' });
  
  try {
    const data = await postJson('/api/ai', {
      type: 'audit', provider,
      _rawPrompt: buildFullListingAuditPrompt(listing),
    });
    const text = String(data.data || data.result || data.error || 'No response');
    
    // Format markdown-ish output
    const html = text
      .replace(/^## (.+)$/gm, '<div style="font-size:14px;font-weight:700;margin:14px 0 6px;color:var(--orange)">$1</div>')
      .replace(/^### (.+)$/gm, '<div style="font-size:13px;font-weight:600;margin:10px 0 4px">$1</div>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^(\d+\. .+)$/gm, '<div style="margin:4px 0;padding-left:12px">$1</div>')
      .replace(/^- (.+)$/gm, '<div style="margin:3px 0;padding-left:12px">• $1</div>')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/&lt;div/g,'<div').replace(/&lt;\/div&gt;/g,'</div>').replace(/&gt;/g,'>');
    
    setModalBody(`<div style="line-height:1.6;font-size:13px">${html}</div>
      <div class="row" style="margin-top:16px;justify-content:flex-end">
        <button class="btn" onclick="closeModal()">Close</button>
      </div>`);
  } catch(e) {
    setModalBody(`<div class="alert alert-error">${e.message}</div>`);
  }
}
window.runFullListingAudit = runFullAuditWithAI;
