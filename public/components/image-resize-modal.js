// public/components/image-resize-modal.js
// Upload one image → Canvas resizes to 3 platform formats locally.
// ZERO API calls — 100% client-side Canvas processing.

import { PRESETS } from '../utils/image-resize.js';
import { imageResizeBatch } from '../utils/image-resize-batch.js';
import { escHtml } from '../utils/format.js';
import { openModal } from './modal.js';
import { toastSuccess, toastError } from './toast.js';

export function openImageResizeModal(sourceFile = null) {
  openModal({
    title: 'Export image — all platforms',
    size: 'lg',
    body: `
      <div class="alert alert-info mb-12" style="font-size:12px">
        <strong>Zero API calls — 100% local Canvas processing.</strong>
        Upload one NB2-generated image → get Etsy, Instagram+Pinterest, and Stories versions instantly.
      </div>

      <div class="upload-zone" id="rz-zone">
        <input type="file" id="rz-input" accept="image/*" onchange="window.__rm.load(this.files[0])">
        <div id="rz-preview">
          <div style="font-size:13px">Drop image here or click</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:3px">Any size · Any ratio · JPG/PNG</div>
        </div>
      </div>

      <div id="rz-controls" style="display:none;margin-top:14px">
        <div class="row" style="gap:10px;margin-bottom:12px">
          ${[['smart','Smart (auto)'],['contain','Contain (white bg)'],['cover','Cover (fill/crop)']].map(
            ([v,l],i) => `<label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;font-weight:400">
              <input type="radio" name="rz-mode" value="${v}" ${i===0?'checked':''}> ${l}
            </label>`).join('')}
          <button class="btn btn-sm btn-primary" style="margin-left:auto" onclick="window.__rm.run()">Re-generate</button>
        </div>
        <div id="rz-output"></div>
      </div>
    `,
  });

  setTimeout(() => {
    const zone = document.getElementById('rz-zone');
    if (zone) {
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) window.__rm.load(e.dataTransfer.files[0]); });
    }
    if (sourceFile) window.__rm.load(sourceFile);
  }, 50);

  window.__rm = {
    file: null,
    results: null,

    load(f) {
      if (!f?.type?.startsWith('image/')) { toastError('Image file required'); return; }
      this.file = f;
      const url = URL.createObjectURL(f);
      const p = document.getElementById('rz-preview');
      if (p) p.innerHTML = `<img src="${url}" style="max-height:100px;max-width:100%;object-fit:contain;border-radius:var(--radius)"><div style="font-size:11px;color:var(--text-2);margin-top:4px">${escHtml(f.name)}</div>`;
      const c = document.getElementById('rz-controls');
      if (c) c.style.display = 'block';
      this.run();
    },

    async run() {
      if (!this.file) return;
      const mode = document.querySelector('input[name="rz-mode"]:checked')?.value || 'smart';
      const out = document.getElementById('rz-output');
      if (out) out.innerHTML = '<div class="loading-center"><div class="spinner"></div><span style="margin-left:8px">Resizing...</span></div>';
      try {
        const results = await imageResizeBatch.generate(this.file, mode);
        this.results = results;
        if (!out) return;
        out.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
            ${Object.entries(results).map(([k, r]) => {
              const p = PRESETS[k];
              return `<div style="border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;text-align:center">
                <div style="background:var(--bg-hover);display:flex;align-items:center;justify-content:center;height:120px">
                  <img src="${r.dataURL}" style="max-width:100%;max-height:120px;object-fit:contain">
                </div>
                <div style="padding:8px">
                  <div style="font-size:11px;font-weight:600">${p.label}</div>
                  <div style="font-size:10px;color:var(--text-3)">${r.width}×${r.height} · ${p.ratio}</div>
                  <div style="font-size:10px;color:var(--text-3);margin:3px 0 6px">${p.note}</div>
                  <button class="btn btn-sm" style="width:100%;font-size:11px" onclick="window.__rm.dl('${k}')">↓ JPG</button>
                </div>
              </div>`;
            }).join('')}
          </div>
          <div class="row" style="margin-top:10px;gap:8px">
            <button class="btn btn-primary" onclick="window.__rm.dlAll()">↓ Download all 3</button>
            <span class="text-sm text-muted">100% local · zero API · Canvas only</span>
          </div>`;
        toastSuccess('3 formats ready');
      } catch (e) {
        if (out) out.innerHTML = `<div class="alert alert-error">${escHtml(e.message)}</div>`;
      }
    },

    dl(k) { imageResizeBatch.downloadOne(this.results, k); },
    dlAll() { imageResizeBatch.downloadAll(this.results); },
  };
}
