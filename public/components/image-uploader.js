// public/components/image-uploader.js
// Drag-and-drop image uploader with reorder, preview, upload to Etsy

import { toastError, toastInfo } from './toast.js';

const MAX_IMAGES = 20;
const MAX_SIZE_MB = 20;

export class ImageUploader {
  constructor(containerId, { listingId = null, onImagesChange = null } = {}) {
    this.containerId = containerId;
    this.listingId = listingId;
    this.onImagesChange = onImagesChange;
    this.images = []; // { id, url, preview, base64, file, sourceUrl, etsyListingId, rank, isExisting, uploading, error }
    this.dragSrc = null;
    this.dragOverIndex = null;
  }

  render() {
    const el = document.getElementById(this.containerId);
    if (!el) return;

    el.innerHTML = `
      <div class="img-uploader">
        <div class="img-grid" id="${this.containerId}-grid"></div>
        <label class="upload-zone ${this.images.length ? 'has-images' : ''} ${this.images.length >= MAX_IMAGES ? 'disabled' : ''}" id="${this.containerId}-zone">
          <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple
            ${this.images.length >= MAX_IMAGES ? 'disabled' : ''}
            onchange="window.__uploaders['${this.containerId}'].handleFiles(this.files)">
          <div>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="margin:0 auto 8px;display:block">
              <path d="M12 15V3m0 0L8 7m4-4l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <div class="upload-zone-title" style="font-size:13px;font-weight:500">${this.images.length ? 'Drop images here or click to add more' : 'Drop images here or click to upload'}</div>
            <div class="upload-zone-detail" style="font-size:11px;color:var(--text-3);margin-top:4px">JPG, PNG, GIF, WEBP · Max ${MAX_SIZE_MB}MB · Up to ${MAX_IMAGES} images</div>
            <div class="upload-zone-detail" style="font-size:11px;color:var(--text-3)">First image = thumbnail · Drag to reorder · Upload happens when you Save/Publish</div>
          </div>
        </label>
      </div>`;

    if (!window.__uploaders) window.__uploaders = {};
    window.__uploaders[this.containerId] = this;

    const zone = document.getElementById(`${this.containerId}-zone`);
    if (zone) {
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault(); zone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) this.handleFiles(e.dataTransfer.files);
      });
    }

    this.renderGrid();
  }

  renderGrid() {
    const grid = document.getElementById(`${this.containerId}-grid`);
    if (!grid) return;

    const zone = document.getElementById(`${this.containerId}-zone`);
    zone?.classList.toggle('has-images', this.images.length > 0);
    zone?.classList.toggle('disabled', this.images.length >= MAX_IMAGES);
    const input = zone?.querySelector('input');
    if (input) input.disabled = this.images.length >= MAX_IMAGES;
    const title = zone?.querySelector('.upload-zone-title');
    if (title) title.textContent = this.images.length ? 'Drop images here or click to add more' : 'Drop images here or click to upload';

    if (!this.images.length) { grid.innerHTML = ''; return; }

    grid.innerHTML = this.images.map((img, i) => {
      const src = img.preview || img.url || '';
      const fullSrc = img.url || img.preview || '';
      return `
      <div class="img-thumb ${i === 0 ? 'img-thumb-primary' : ''} ${img.uploading ? 'img-thumb-uploading' : ''} ${img.error ? 'img-thumb-error' : ''}"
           data-full-src="${escAttr(fullSrc)}"
           draggable="true"
           data-index="${i}"
           ondragstart="window.__uploaders['${this.containerId}'].dragStart(event, ${i})"
           ondragover="window.__uploaders['${this.containerId}'].dragOver(event, ${i})"
           ondrop="window.__uploaders['${this.containerId}'].dragDrop(event, ${i})"
           ondragend="window.__uploaders['${this.containerId}'].dragEnd()">
        <img src="${escAttr(src)}" alt="Image ${i + 1}" loading="lazy" decoding="async">
        ${i === 0 ? '<div class="img-thumb-badge">Cover</div>' : ''}
        ${img.uploading ? '<div class="img-thumb-overlay"><div class="spinner"></div></div>' : ''}
        ${img.error ? `<div class="img-thumb-overlay img-thumb-error-overlay" title="${escAttr(img.error)}">!</div>` : ''}
        <button class="img-thumb-remove" onclick="window.__uploaders['${this.containerId}'].removeImage(${i})" title="Remove">×</button>
        <div class="img-thumb-drag-hint">⠿</div>
        <div class="img-thumb-actions">
          <button class="img-thumb-action-btn" onclick="event.stopPropagation();window.viewImageFullscreen&&window.viewImageFullscreen(this.closest('.img-thumb').dataset.fullSrc)" title="View fullscreen">⤢</button>
          <a class="img-thumb-action-btn" href="${escAttr(fullSrc)}" download="listing-image-${i + 1}.jpg" onclick="event.stopPropagation()" title="Download">↓</a>
        </div>
      </div>`;
    }).join('');
  }

  async handleFiles(fileList) {
    const files = Array.from(fileList);
    const remaining = MAX_IMAGES - this.images.length;
    if (remaining <= 0) { toastError(`Max ${MAX_IMAGES} images`); return; }

    const toAdd = files.slice(0, remaining);
    if (files.length > remaining) toastInfo(`Only ${remaining} more image(s) allowed — skipping extras`);

    for (const file of toAdd) {
      if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        toastError(`${file.name} is too large (max ${MAX_SIZE_MB}MB)`);
        continue;
      }
      if (!file.type.startsWith('image/')) {
        toastError(`${file.name} is not an image`);
        continue;
      }

      // Blob previews are instant and cheap. Base64 is created lazily only when
      // uploading to Etsy, avoiding large memory spikes on edit pages.
      const preview = URL.createObjectURL(file);
      this.images.push({
        id: `local-${Date.now()}-${Math.random()}`,
        url: null,
        preview,
        base64: null,
        file,
        sourceUrl: null,
        etsyListingId: null,
        mimeType: file.type,
        filename: file.name,
        rank: this.images.length + 1,
        isExisting: false,
        uploading: false,
        error: null,
      });
    }

    this.renderGrid();
    this.onImagesChange?.(this.images);
    // No auto-upload on edit: slow Etsy uploads now run only during Save/Publish.
  }

  async uploadPending({ onProgress = null } = {}) {
    const pending = this.images.filter(img => !img.isExisting && !img.uploading && (img.base64 || img.file || img.sourceUrl));
    let done = 0;
    for (const img of pending) {
      onProgress?.({ done, total: pending.length, image: img, phase: 'start' });
      await this.uploadImage(img);
      done += 1;
      onProgress?.({ done, total: pending.length, image: img, phase: 'complete' });
    }
    return { attempted: pending.length, uploaded: done };
  }

  async uploadImage(imgObj) {
    imgObj.uploading = true;
    imgObj.error = null;
    this.renderGrid();

    try {
      const rank = this.images.indexOf(imgObj) + 1;
      const imageBase64 = imgObj.base64 || (imgObj.file ? await readAsDataURL(imgObj.file) : null);
      if (!imageBase64 && !imgObj.sourceUrl) throw new Error('No image data available for upload');

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: imgObj.sourceUrl ? 'uploadImageFromUrl' : 'uploadImage',
          listing_id: this.listingId,
          imageBase64,
          imageUrl: imgObj.sourceUrl || undefined,
          contentType: imgObj.mimeType || imgObj.file?.type || 'image/jpeg',
          rank,
          overwrite: false,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');

      imgObj.url = data.data?.url_fullxfull || data.data?.url_570xN || imgObj.preview;
      if (imgObj.preview?.startsWith('blob:')) URL.revokeObjectURL(imgObj.preview);
      imgObj.preview = data.data?.url_170x135 || data.data?.url_570xN || imgObj.url;
      imgObj.id = data.data?.listing_image_id || imgObj.id;
      imgObj.isExisting = true;
      imgObj.etsyListingId = normalizeListingId(this.listingId);
      imgObj.uploading = false;
      imgObj.base64 = null;
      imgObj.file = null;
      imgObj.sourceUrl = null;
    } catch (e) {
      imgObj.uploading = false;
      imgObj.error = e.message;
      this.renderGrid();
      this.onImagesChange?.(this.images);
      throw e;
    }

    this.renderGrid();
    this.onImagesChange?.(this.images);
  }

  async removeImage(index) {
    const img = this.images[index];
    if (!img) return;

    if (img.isExisting && this.listingId && img.id && !String(img.id).startsWith('local-')) {
      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'deleteImage', listing_id: this.listingId, listing_image_id: img.id }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error);
      } catch (e) {
        toastError('Failed to delete image: ' + e.message);
        return;
      }
    }

    if (img.preview?.startsWith('blob:')) URL.revokeObjectURL(img.preview);
    this.images.splice(index, 1);
    this.images.forEach((image, i) => image.rank = i + 1);
    this.renderGrid();
    this.onImagesChange?.(this.images);
  }

  // ── Drag & drop reorder ──────────────────────────────────
  dragStart(e, index) {
    this.dragSrc = index;
    this.dragOverIndex = null;
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.style.opacity = '0.4';
  }

  dragOver(e, index) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (this.dragOverIndex === index) return;
    const grid = document.getElementById(`${this.containerId}-grid`);
    if (grid && this.dragOverIndex !== null) grid.children[this.dragOverIndex]?.classList.remove('img-thumb-drag-target');
    if (grid && index !== this.dragSrc) grid.children[index]?.classList.add('img-thumb-drag-target');
    this.dragOverIndex = index;
  }

  dragDrop(e, index) {
    e.preventDefault();
    if (this.dragSrc === null || this.dragSrc === index) return;
    const moved = this.images.splice(this.dragSrc, 1)[0];
    this.images.splice(index, 0, moved);
    this.images.forEach((img, i) => img.rank = i + 1);
    this.renderGrid();
    this.onImagesChange?.(this.images);
  }

  dragEnd() {
    this.dragSrc = null;
    this.dragOverIndex = null;
    document.querySelectorAll(`#${this.containerId}-grid .img-thumb`).forEach(el => {
      el.style.opacity = '';
      el.classList.remove('img-thumb-drag-target');
    });
  }

  // ── Public API ────────────────────────────────────────────
  loadExisting(images, { listingId = this.listingId } = {}) {
    const ownerListingId = normalizeListingId(listingId);
    this.images = (images || [])
      .slice()
      .sort((a, b) => (parseInt(a.rank, 10) || 999) - (parseInt(b.rank, 10) || 999))
      .map((img, i) => ({
        id: img.listing_image_id,
        url: img.url_fullxfull || img.url_570xN || img.url_170x135,
        preview: img.url_170x135 || img.url_570xN || img.url_fullxfull,
        base64: null,
        file: null,
        sourceUrl: null,
        etsyListingId: normalizeListingId(img.etsyListingId || img.listing_id) || ownerListingId,
        rank: img.rank || i + 1,
        isExisting: true,
        uploading: false,
        error: null,
      }));
    this.renderGrid();
  }

  addRemoteImages(images) {
    const remaining = MAX_IMAGES - this.images.length;
    const toAdd = (images || []).filter(img => /^https:\/\//i.test(String(img?.sourceUrl || img?.url || ''))).slice(0, remaining);
    for (const [index, img] of toAdd.entries()) {
      const sourceUrl = String(img.sourceUrl || img.url);
      this.images.push({
        id: img.id || `remote-${Date.now()}-${index}`,
        url: null,
        preview: img.preview || sourceUrl,
        base64: null,
        file: null,
        sourceUrl,
        etsyListingId: null,
        mimeType: img.mimeType || '',
        filename: img.filename || '',
        rank: Number(img.rank) || this.images.length + 1,
        isExisting: false,
        uploading: false,
        error: null,
      });
    }
    this.renderGrid();
    this.onImagesChange?.(this.images);
    return toAdd.length;
  }

  async addDataImages(images) {
    const remaining = MAX_IMAGES - this.images.length;
    if (remaining <= 0) {
      toastError(`Max ${MAX_IMAGES} images`);
      return 0;
    }

    const candidates = (images || []).filter(img => img?.base64 || /^data:image\//i.test(String(img?.preview || '')));
    const toAdd = candidates.slice(0, remaining);
    if (candidates.length > remaining) toastInfo(`Only ${remaining} more image(s) allowed - skipping extras`);

    let added = 0;
    for (const [index, img] of toAdd.entries()) {
      const preview = /^data:image\//i.test(String(img.preview || '')) ? String(img.preview) : '';
      const suppliedBase64 = String(img.base64 || '').trim();
      const encodedDataUrl = /^data:image\//i.test(suppliedBase64) ? suppliedBase64 : '';
      const mimeType = img.mimeType || img.originalMimeType || preview.match(/^data:([^;]+)/i)?.[1] || encodedDataUrl.match(/^data:([^;]+)/i)?.[1] || 'image/jpeg';
      const base64 = String(encodedDataUrl
        ? encodedDataUrl.slice(encodedDataUrl.indexOf(',') + 1)
        : suppliedBase64 || (preview.includes(',') ? preview.slice(preview.indexOf(',') + 1) : '')).trim();
      if (!base64 || !/^image\//i.test(mimeType)) continue;
      const dataUrl = preview || encodedDataUrl || `data:${mimeType};base64,${base64}`;
      const ext = mimeType.split('/')[1]?.split('+')[0] || 'jpg';
      this.images.push({
        id: `local-${Date.now()}-${index}-${Math.random()}`,
        galleryId: img.galleryId || img.id || null,
        url: null,
        preview: dataUrl,
        base64,
        file: null,
        sourceUrl: null,
        etsyListingId: null,
        mimeType,
        filename: img.filename || `listing-image-${Date.now()}-${index + 1}.${ext}`,
        prompt: img.prompt || '',
        slotLabel: img.slotLabel || '',
        listingTitle: img.listingTitle || '',
        provider: img.provider || '',
        model: img.model || '',
        source: img.source || (img.id ? 'gallery' : 'generated'),
        rank: this.images.length + 1,
        isExisting: false,
        uploading: false,
        error: null,
      });
      added += 1;
    }

    this.renderGrid();
    this.onImagesChange?.(this.images);
    return added;
  }

  setListingId(id) {
    this.listingId = id;
  }

  getImages() {
    return this.images;
  }

  hasPendingUploads() {
    return this.images.some(img => !img.isExisting && !img.uploading && (img.base64 || img.file || img.sourceUrl));
  }

  getUnattachedImages(listingId = this.listingId) {
    const target = normalizeListingId(listingId);
    return this.images.filter(img => !img.isExisting || normalizeListingId(img.etsyListingId) !== target);
  }

  async uploadAllPending(listingId, options = {}) {
    if (listingId) this.listingId = listingId;
    if (!this.listingId) return;
    return this.uploadPending(options);
  }
}

function normalizeListingId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function escHtml(s) {
  return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return escHtml(s).replace(/'/g, '&#39;');
}

// ── CSS for image uploader ─────────────────────────────────
const style = document.createElement('style');
style.textContent = `
.img-uploader { }
.img-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.img-thumb {
  position: relative; width: 88px; height: 88px; border-radius: var(--radius);
  border: 1px solid var(--border); overflow: hidden; cursor: grab;
  background: var(--bg-hover); user-select: none;
  transition: border-color 0.15s, transform 0.15s;
}
.img-thumb:hover { border-color: var(--border-2); }
.img-thumb:hover .img-thumb-remove { opacity: 1; }
.img-thumb:hover .img-thumb-drag-hint { opacity: 1; }
.img-thumb-primary { border: 2px solid var(--orange); }
.img-thumb-uploading { opacity: 0.7; }
.img-thumb-drag-target { border: 2px dashed var(--orange); transform: scale(1.04); }
.img-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
.img-thumb-badge {
  position: absolute; bottom: 0; left: 0; right: 0;
  background: rgba(245, 100, 0, 0.85); color: #fff;
  font-size: 10px; font-weight: 600; text-align: center; padding: 2px 0;
}
.img-thumb-overlay {
  position: absolute; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; color: #fff;
}
.img-thumb-error-overlay { background: rgba(220,38,38,0.7); font-size: 18px; font-weight: 700; cursor: help; }
.img-thumb-remove {
  position: absolute; top: 3px; right: 3px;
  width: 18px; height: 18px; border-radius: 50%;
  background: rgba(0,0,0,0.6); color: #fff; border: none;
  font-size: 13px; line-height: 1; cursor: pointer; opacity: 0;
  display: flex; align-items: center; justify-content: center;
  transition: opacity 0.15s;
}
.img-thumb-remove:hover { background: var(--red); }
.img-thumb-drag-hint {
  position: absolute; top: 3px; left: 4px;
  font-size: 14px; color: rgba(255,255,255,0.8);
  opacity: 0; transition: opacity 0.15s; pointer-events: none;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
}
.img-thumb-actions {
  position: absolute; bottom: 0; left: 0; right: 0;
  display: flex; gap: 1px;
  opacity: 0; transition: opacity 0.15s;
}
.img-thumb:hover .img-thumb-actions { opacity: 1; }
.img-thumb-action-btn {
  flex: 1; background: rgba(0,0,0,0.65); color: #fff; border: none;
  font-size: 13px; padding: 3px 0; cursor: pointer; text-align: center;
  text-decoration: none; display: flex; align-items: center; justify-content: center;
  transition: background 0.12s;
}
.img-thumb-action-btn:hover { background: rgba(0,0,0,0.9); }
.img-thumb:hover .img-thumb-badge { display: none; }
.upload-zone.disabled { opacity: 0.5; pointer-events: none; }
.upload-zone.has-images {
  display: flex; align-items: center; justify-content: center;
  width: 100%; min-height: 52px; padding: 10px 14px; border-style: dashed;
  border-radius: 6px; text-align: center;
}
.upload-zone.has-images > div { display: flex; align-items: center; gap: 7px; }
.upload-zone.has-images svg { width: 16px; height: 16px; margin: 0 !important; }
.upload-zone.has-images .upload-zone-detail { display: none; }
`;
document.head.appendChild(style);
